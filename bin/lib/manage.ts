/**
 * `flow manage`: the front door to the global manager. One tmux window named
 * `manager` runs a long-lived Claude session (`FLOW_MANAGER=1`, launched from
 * `~/.flow/manager`) that is woken only by `flow-manager-wait`. tmux only: the
 * window, the launch-line seed and the `@flow-kind` pane option all need it.
 *
 *   flow manage ["<what to cover>"] [--scope <scope>]… [--notices|--no-notices]
 *               [--model <alias>] [--effort <level>] [--heartbeat <dur>]
 *               [--stop-when-idle]
 *   flow manage --stop
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveManagerModelEffort } from "./epic-manager-model";
import { dimStderr } from "./color";
import { launchSettingsPermissions } from "./feature";
import { argsContainHelp, printVerbHelp } from "./help";
import { resolveLauncherBackend } from "./launcher-config";
import { readManagerConfig, validHeartbeatSec } from "./manager-config";
import { resolveGrant } from "./manager-grants";
import { managerFile, managerHome, writeTextAtomic } from "./manager-home";
import { wakePath } from "./manager-waiter";
import {
  managerRecordPath,
  readManagerRecord,
  writeManagerRecord,
  type ManagerRecord,
} from "./manager-record";
import {
  ALLOWED_SCOPE_KINDS,
  formatScope,
  identityForState,
  originsFor,
  parseScope,
  readScope,
  scopeOrigin,
  stateInScope,
  updateScope,
} from "./manager-scope";
import { flowClaudeHome, installedHelperPath } from "./paths";
import {
  pluginBinPath,
  pluginDirArgs,
  scanPluginRoots,
  withPluginPath,
} from "./plugin-root";
import { sleepSync } from "./sleep";
import {
  EFFORT_LEVELS,
  FINISHED_PHASE_SET,
  listStates,
  MODEL_ALIASES,
  type EffortLevel,
  type ModelAlias,
} from "./state";
import {
  capturePaneBySlug,
  createWindowVerified,
  isPaneAlive,
  killWindow,
  setPaneKind,
  windowExists,
  type VerifiedLaunchResult,
} from "./tmux";

export const MANAGER_WINDOW = "manager";
const SEED = "/flow-manage";
const LAUNCH_ATTEMPTS = 3;
export const MANAGER_CHECKIN_TIMEOUT_MS = 90_000;
const CHECKIN_POLL_MS = 1000;
const CHECKIN_PROGRESS_MS = 15_000;

export type ManagerCheckIn = "checked-in" | "trust-prompt" | "dead" | "timeout";

/** True only for Claude Code's folder-trust menu: both option lines must be on screen, so a pane that merely echoes the start command never matches. */
export function paneShowsTrustMenu(captured: string): boolean {
  const text = captured.replace(/\s+/g, " ").toLowerCase();
  return text.includes("yes, i trust this folder") && text.includes("no, exit");
}

/** Waits for the manager's first check-in; pane text only picks the message, never the outcome of a check-in. */
export function awaitManagerCheckIn(opts: {
  consumed: () => boolean;
  isAlive: () => boolean;
  readPane: () => string;
  sleep: (ms: number) => void;
  timeoutMs: number;
  onProgress?: (elapsedMs: number) => void;
}): ManagerCheckIn {
  for (let elapsed = 0; ; elapsed += CHECKIN_POLL_MS) {
    if (opts.consumed()) return "checked-in";
    if (!opts.isAlive()) return "dead";
    if (paneShowsTrustMenu(opts.readPane())) return "trust-prompt";
    if (elapsed >= opts.timeoutMs) return "timeout";
    opts.onProgress?.(elapsed);
    opts.sleep(CHECKIN_POLL_MS);
  }
}

function makeCheckInProgress(): (elapsedMs: number) => void {
  const tty = process.stderr.isTTY === true;
  let lastBucket = -1;
  return (elapsedMs) => {
    const secs = Math.round(elapsedMs / 1000);
    const line = `flow manage: waiting for the manager to check in (${secs}s)…`;
    if (tty) {
      process.stderr.write(`\r\x1b[2K${dimStderr(line)}`);
      return;
    }
    const bucket = Math.floor(elapsedMs / CHECKIN_PROGRESS_MS);
    if (bucket <= lastBucket || bucket === 0) return;
    lastBucket = bucket;
    process.stderr.write(`${dimStderr(line)}\n`);
  };
}

export function parseHeartbeat(s: string): number | null {
  const m = /^(\d+)(s|m|h)?$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1);
  return validHeartbeatSec(n) ? n : null;
}

function hookScript(helper: string): string {
  const installed = installedHelperPath(helper);
  if (fs.existsSync(installed)) return installed;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", `${helper}.ts`);
}

/** A pipeline session carries a deny on the whole `flow-manager-ctl` helper (rulings, proposals, scope); the manager is the one session allowed to call it. */
const RULING_WRITER_DENY = /flow-manager-ctl/;

/**
 * Writes the manager's own `claude --settings` file (never the shared pipeline
 * launch settings): the pipeline permissions with the secret-file and grant
 * denies kept, the ruling-writer deny dropped, the owner-words ledger denied to
 * every tool, and three hooks — the SendMessage scope guard, the typed-prompt
 * ledger and the "re-arm the waiter" Stop guard. Returns the path.
 */
export function ensureManagerSettings(
  settingsPath: string = managerFile("launch-settings.json"),
): string {
  const perms = launchSettingsPermissions();
  const hook = (helper: string) => ({
    type: "command",
    command: hookScript(helper),
  });
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: [hook("flow-manager-owner-words")] }],
      PreToolUse: [
        {
          matcher: "SendMessage",
          hooks: [hook("flow-manager-send-guard")],
        },
      ],
      Stop: [{ hooks: [hook("flow-manager-stop-guard")] }],
    },
    permissions: {
      deny: [
        ...perms.deny.filter((r) => !RULING_WRITER_DENY.test(r)),
        // The verifier consumes a ruling; only the pipeline it names may run it.
        "Bash(*flow-exec-review ruling*)",
      ],
      allow: [
        ...perms.allow.filter((r) => !/flow-exec-review ruling/.test(r)),
        "Bash(flow-manager-wait)",
        "Bash(flow-manager-wait *)",
        "Bash(flow-manager-ctl *)",
      ],
    },
  };
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  try {
    if (fs.readFileSync(settingsPath, "utf8") === text) return settingsPath;
  } catch {
    // absent: write it
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeTextAtomic(settingsPath, text);
  return settingsPath;
}

type Parsed = {
  words?: string;
  scopes: string[];
  notices?: boolean;
  model?: ModelAlias;
  effort?: EffortLevel;
  heartbeatSec?: number;
  stopWhenIdle: boolean;
  stop: boolean;
};

function parse(args: string[]): Parsed | { error: string } {
  const out: Parsed = { scopes: [], stopWhenIdle: false, stop: false };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--stop") out.stop = true;
    else if (a === "--stop-when-idle") out.stopWhenIdle = true;
    else if (a === "--notices") out.notices = true;
    else if (a === "--no-notices") out.notices = false;
    else if (a === "--scope") {
      const v = args[++i];
      const s = v === undefined ? null : parseScope(v);
      if (!s) return { error: `--scope needs ${ALLOWED_SCOPE_KINDS}` };
      out.scopes.push(formatScope(s));
    } else if (a === "--model") {
      const v = args[++i];
      if (!(MODEL_ALIASES as readonly string[]).includes(v ?? "")) {
        return { error: `--model must be one of ${MODEL_ALIASES.join("|")}` };
      }
      out.model = v as ModelAlias;
    } else if (a === "--effort") {
      const v = args[++i];
      if (!(EFFORT_LEVELS as readonly string[]).includes(v ?? "")) {
        return { error: `--effort must be one of ${EFFORT_LEVELS.join("|")}` };
      }
      out.effort = v as EffortLevel;
    } else if (a === "--heartbeat") {
      const n = parseHeartbeat(args[++i] ?? "");
      if (n === null) {
        return {
          error:
            "--heartbeat needs a duration of at least 60 seconds, like 900, 15m or 1h",
        };
      }
      out.heartbeatSec = n;
    } else if (a.startsWith("--")) return { error: `unknown flag: ${a}` };
    else positional.push(a);
  }
  if (positional.length > 1) {
    return { error: "quote what to cover as one argument" };
  }
  if (positional[0]?.trim()) out.words = positional[0].trim();
  return out;
}

export type ManageOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  stateDir?: string;
  settingsPath?: string;
  now?: () => Date;
  tmuxOnPath?: () => boolean;
  windowExists?: (name: string) => boolean;
  killWindow?: (name: string) => boolean;
  setPaneKind?: (name: string, kind: "manager") => unknown;
  launch?: (command: string[], cwd: string) => VerifiedLaunchResult;
  retrySleepMs?: number;
  command?: string[];
  isAlive?: (name: string) => boolean;
  readPane?: (name: string) => string;
  sleep?: (ms: number) => void;
  checkInTimeoutMs?: number;
};

/** The manager has no state file, so the skill's first `flow-manager-ctl scope show` stamping `lastSeenAt` is the proof the seed was read. */
export function managerLaunchConsumed(
  home: string,
  startedAt: string,
): boolean {
  const seen = readManagerRecord(home)?.lastSeenAt;
  return !!seen && Date.parse(seen) > Date.parse(startedAt);
}

function launchCommand(
  record: ManagerRecord,
  settingsPath: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const roots = scanPluginRoots();
  const nextPath = withPluginPath(pluginBinPath(roots), env.PATH ?? "");
  return [
    "env",
    "-u",
    "FLOW_SLUG",
    "-u",
    "FLOW_PIPELINE",
    "FLOW_MANAGER=1",
    ...(env.FLOW_NOTIFY !== undefined
      ? [`FLOW_NOTIFY=${env.FLOW_NOTIFY}`]
      : []),
    ...(nextPath !== undefined ? [`PATH=${nextPath}`] : []),
    "claude",
    "--name",
    MANAGER_WINDOW,
    "--add-dir",
    flowClaudeHome(),
    ...pluginDirArgs(roots),
    "--model",
    record.model,
    "--effort",
    record.effort,
    "--settings",
    settingsPath,
  ];
}

function printScopeAndGrants(
  home: string,
  stateDir: string | undefined,
  now: Date,
  showGrants: boolean,
): void {
  const file = readScope(home);
  if (!file || file.scopes.length === 0) console.log("scope: nothing yet");
  else {
    console.log("scope:");
    for (const sc of file.scopes) {
      console.log(
        `  ${sc} — from ${scopeOrigin(file, sc) === "flag" ? "a flag" : "your words"}`,
      );
    }
  }
  for (const f of file?.focus ?? []) console.log(`focus [${f.id}]: ${f.text}`);
  if (!showGrants) return;
  let anyUngranted = false;
  for (const s of listStates(stateDir)) {
    if (!stateInScope(s, file) || FINISHED_PHASE_SET.has(s.phase)) continue;
    const granted = resolveGrant(identityForState(s), now, home) !== null;
    if (!granted) anyUngranted = true;
    console.log(`${s.slug}: ${granted ? "granted" : "not granted"}`);
  }
  if (anyUngranted) {
    const cap = readManagerConfig().dailyBudgetUsd;
    console.log(
      "To answer from the manager window (free): flow grant <scope> --relay. " +
        `To let paid executive reviews approve plans for you (capped at $${cap}/day): flow grant <scope> --autonomy high.`,
    );
  }
}

export function runManageCli(
  args: string[],
  options: ManageOptions = {},
): number {
  if (argsContainHelp(args)) return printVerbHelp("manage");
  const env = options.env ?? process.env;
  const home = options.home ?? managerHome();
  const now = (options.now ?? (() => new Date()))();
  const fail = (msg: string): number => {
    console.error(`flow manage: ${msg}`);
    return 2;
  };
  const p = parse(args);
  if ("error" in p) return fail(p.error);

  const exists = options.windowExists ?? ((n) => windowExists(n));
  if (p.stop) {
    fs.rmSync(managerRecordPath(home), { force: true });
    (options.killWindow ?? ((n) => killWindow(n)))(MANAGER_WINDOW);
    console.log("manager stopped");
    return 0;
  }

  const backend = resolveLauncherBackend({
    flag: "tmux",
    tmuxOnPath: options.tmuxOnPath,
  });
  if (backend.id !== "tmux") {
    return fail(
      "the manager needs tmux — tmux is not installed or not on PATH",
    );
  }

  if (exists(MANAGER_WINDOW)) {
    const open = readManagerRecord(home);
    if (!open || !managerLaunchConsumed(home, open.startedAt)) {
      return fail(
        "the manager window is open but has not started yet — attach (flow attach manager) and answer what is on screen, or close it with flow manage --stop",
      );
    }
    if (p.words) {
      return fail("say it in the manager window: flow attach manager");
    }
    const rec = readManagerRecord(home);
    let did = false;
    if (p.scopes.length > 0) {
      updateScope(
        (cur) => ({
          ...(cur ?? {}),
          version: 1,
          scopes: p.scopes,
          updatedAt: now.toISOString(),
          source: "cli",
          origins: originsFor(cur, p.scopes, p.scopes, "flag"),
        }),
        home,
      );
      console.log("scope updated");
      did = true;
    }
    if (p.notices !== undefined && rec) {
      writeManagerRecord({ ...rec, notices: p.notices }, home);
      console.log(`notices ${p.notices ? "on" : "off"}`);
      did = true;
    }
    if (did) return 0;
    return fail(
      "a manager is already running — attach with: flow attach manager",
    );
  }

  const fresh = p.words !== undefined || p.scopes.length > 0;
  if (!fresh && readScope(home) === null) {
    return fail(
      'nothing saved to cover — say what to cover: flow manage "<words>" or flow manage --scope repo:<name>',
    );
  }
  if (fresh) {
    updateScope(
      () => ({
        version: 1,
        scopes: p.scopes,
        updatedAt: now.toISOString(),
        source: "cli",
        ...(p.scopes.length > 0
          ? { origins: originsFor(null, p.scopes, p.scopes, "flag") }
          : {}),
        ...(p.words
          ? {
              focus: [
                {
                  id: "launch-1",
                  text: p.words,
                  at: now.toISOString(),
                  from: "launch" as const,
                },
              ],
              pendingResolve: true,
            }
          : {}),
      }),
      home,
    );
  }

  const me = resolveManagerModelEffort({
    flagModel: p.model,
    flagEffort: p.effort,
  });
  const record: ManagerRecord = {
    version: 1,
    window: MANAGER_WINDOW,
    startedAt: now.toISOString(),
    model: me.model,
    effort: me.effort,
    heartbeatSec: p.heartbeatSec ?? readManagerConfig().heartbeatSec,
    stopWhenIdle: p.stopWhenIdle,
    notices: p.notices ?? false,
  };
  fs.mkdirSync(home, { recursive: true });
  // A new session must not replay the last one's baseline or unacked wake.
  fs.rmSync(managerFile("waiter-seen.json", home), { force: true });
  fs.rmSync(wakePath(home), { force: true });
  writeManagerRecord(record, home);

  printScopeAndGrants(
    home,
    options.stateDir,
    now,
    !readScope(home)?.pendingResolve,
  );
  if (env.FLOW_NOTIFY !== "1") {
    console.log(
      "daily reminders are off — set FLOW_NOTIFY=1 in your shell to turn them on",
    );
  }

  const command =
    options.command ??
    launchCommand(record, ensureManagerSettings(options.settingsPath), env);
  const launch =
    options.launch ??
    ((cmd: string[], cwd: string) =>
      createWindowVerified(MANAGER_WINDOW, cwd, cmd, SEED, {
        consumed: () => managerLaunchConsumed(home, record.startedAt),
        consumeAttempts: 1,
      }));
  let result: VerifiedLaunchResult = { status: "failed", stderr: "" };
  for (let attempt = 0; attempt < LAUNCH_ATTEMPTS; attempt++) {
    if (attempt > 0 && options.retrySleepMs !== 0) {
      sleepSync(options.retrySleepMs ?? 1000 * 2 ** (attempt - 1));
    }
    result = launch(command, home);
    if (result.status !== "failed") break;
  }
  if (result.status === "failed") {
    fs.rmSync(managerRecordPath(home), { force: true });
    console.error(
      "flow manage: claude exited immediately after launch — the tmux window did not stay up.",
    );
    if (result.stderr) console.error(`  ${result.stderr}`);
    return 2;
  }
  (options.setPaneKind ?? ((n, k) => setPaneKind(n, k)))(
    MANAGER_WINDOW,
    "manager",
  );
  const checkInMs = options.checkInTimeoutMs ?? MANAGER_CHECKIN_TIMEOUT_MS;
  const checkIn = awaitManagerCheckIn({
    consumed: () => managerLaunchConsumed(home, record.startedAt),
    isAlive: () => (options.isAlive ?? ((n) => isPaneAlive(n)))(MANAGER_WINDOW),
    readPane: () =>
      (options.readPane ?? ((n) => capturePaneBySlug(n)))(MANAGER_WINDOW),
    sleep: options.sleep ?? sleepSync,
    timeoutMs: checkInMs,
    onProgress: makeCheckInProgress(),
  });
  if (process.stderr.isTTY === true) process.stderr.write("\r\x1b[2K");
  if (checkIn === "checked-in") {
    console.log("manager started — attach with: flow attach manager");
    return 0;
  }
  if (checkIn === "trust-prompt") {
    console.error(
      "flow manage: the manager has not started — Claude Code is asking whether you trust ~/.flow/manager",
    );
    console.error("  1. flow attach manager");
    console.error(
      '  2. choose "Yes, I trust this folder" — the manager then starts by itself (if /flow-manage sits in the input box, press Enter)',
    );
    return 2;
  }
  if (checkIn === "timeout") {
    console.error(
      `flow manage: the manager window opened but has not checked in after ${Math.round(checkInMs / 1000)}s — it may still be starting`,
    );
    console.error("  1. run flow manage again to check");
    console.error(
      "  2. if /flow-manage sits in the input box: flow attach manager, then press Enter",
    );
    console.error("  3. to give up: flow manage --stop");
    return 2;
  }
  fs.rmSync(managerRecordPath(home), { force: true });
  (options.killWindow ?? ((n) => killWindow(n)))(MANAGER_WINDOW);
  return fail(
    "claude exited before the manager checked in — nothing is lost, your scope is saved; run flow manage again to retry",
  );
}
