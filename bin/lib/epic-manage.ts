/**
 * `flow epic manage <slug>` — the user-facing verb for the zero-token epic
 * sequencer. The launcher path opens tmux window `manage-<slug>` running this
 * same verb with `--foreground`; the foreground path claims the singleton
 * record, logs `started`, and runs `runManagerLoop` until Ctrl-C (or Enter once
 * the epic is done). It never touches window `<slug>` or
 * `~/.flow/state/<slug>.json` — those belong to the epic-design / epic-run
 * sessions.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { appendManagerLog } from "./epic-manager-log";
import { resolveManagerModelEffort } from "./epic-manager-model";
import {
  abortableSleep,
  DEFAULT_GITHUB_POLL_MS,
  DEFAULT_STATE_POLL_MS,
  installStopHandlers,
  runManagerLoop,
  type LoopDeps,
} from "./epic-manage-loop";
import { defaultExec } from "./epic-manage-observe";
import {
  claimManager,
  managerHealth,
  managerWindowName,
  readManager,
  type ManagerState,
} from "./epic-manage-state";
import {
  EPIC_MANIFEST_FILENAME,
  epicDirRelative,
} from "./epic-manifest-schema";
import {
  loadCommittedManifest,
  parseEnumValueFlag,
  type EpicOptions,
} from "./epic";
import { argsContainHelp } from "./help";
import { resolveLauncherBackend } from "./launcher-config";
import { pidStartEpoch, type LivenessDeps } from "./liveness";
import { resolveGitCommonDir, resolveRepoRoot } from "./repo-root";
import { isValidSlug } from "./slug";
import {
  EFFORT_LEVELS,
  MODEL_ALIASES,
  nowIso,
  type EffortLevel,
  type ModelAlias,
} from "./state";
import { createWindow, windowExists } from "./tmux";

export const MANAGE_USAGE =
  "flow epic manage <slug> [--model <alias>] [--effort <level>] [--autonomy observe]";

const HELP = `flow epic manage — run the zero-token sequencer for an approved epic

Usage:
  ${MANAGE_USAGE}

Opens tmux window manage-<slug> that launches each ready feature of the epic as
soon as it is safe — one at a time, through flow epic launch — and shows a live
board of what needs you. It makes no model calls, never merges, and never
repairs drift: on any ambiguity it holds the feature and points at
/flow-epic-run reconcile-drift. tmux only. Ctrl-C (or closing the window) stops
it without touching the pipelines it launched; a second start refuses and
prints flow attach manage-<slug>.

Options:
  --model <opus|haiku|sonnet|fable>
                        model for features whose plan names none (also reserved
                        for the sequencer's future model calls; it makes none
                        today). Precedence: flag > config.models.manager > opus
  --effort <low|medium|high|xhigh|max>
                        effort for features whose plan names none (also reserved
                        for the sequencer's future model calls; it makes none
                        today). Precedence: flag > config.efforts.manager > high
  --autonomy observe    the only supported value today
  --foreground          run the loop in this terminal instead of a tmux window`;

export type ManageArgs = {
  slug: string;
  model?: ModelAlias;
  effort?: EffortLevel;
  autonomy: "observe";
  foreground: boolean;
  help?: boolean;
};

/**
 * Parse `<slug> [--model] [--effort] [--autonomy observe] [--foreground]`.
 * `--model` / `--effort` go through the same enum parser as `flow epic launch`,
 * which prints its own message; the returned `error` is then empty.
 */
export function parseManageArgs(
  rest: string[],
): ManageArgs | { error: string } {
  if (argsContainHelp(rest)) {
    return { slug: "", autonomy: "observe", foreground: false, help: true };
  }
  const model = parseEnumValueFlag(
    rest,
    "--model",
    MODEL_ALIASES,
    "manage",
    "opus, haiku, sonnet, fable",
  );
  if (model.error) return { error: "" };
  const effort = parseEnumValueFlag(
    rest,
    "--effort",
    EFFORT_LEVELS,
    "manage",
    "low, medium, high, xhigh, max",
  );
  if (effort.error) return { error: "" };
  const consumed = new Set<number>();
  for (const f of [model, effort]) {
    if (f.flagIndex !== undefined)
      consumed.add(f.flagIndex).add(f.flagIndex + 1);
  }
  const autonomyAt = rest.indexOf("--autonomy");
  if (autonomyAt >= 0) {
    const v = rest[autonomyAt + 1];
    if (v === undefined || v.startsWith("--"))
      return { error: "--autonomy requires a value (observe)" };
    if (v !== "observe") {
      return {
        error: `--autonomy ${v} is not supported — observe is the only supported value`,
      };
    }
    consumed.add(autonomyAt).add(autonomyAt + 1);
  }
  const unknown = rest.find(
    (a, i) => !consumed.has(i) && a.startsWith("-") && a !== "--foreground",
  );
  if (unknown) return { error: `unknown option '${unknown}'` };
  const positionals = rest.filter(
    (a, i) => !consumed.has(i) && !a.startsWith("-"),
  );
  if (positionals.length !== 1)
    return { error: "exactly one <slug> is required" };
  return {
    slug: positionals[0]!,
    ...(model.value ? { model: model.value } : {}),
    ...(effort.value ? { effort: effort.value } : {}),
    autonomy: "observe",
    foreground: rest.includes("--foreground"),
  };
}

export type ManageOptions = EpicOptions & {
  createWindow?: typeof createWindow;
  windowExists?: (name: string) => boolean;
  liveness?: LivenessDeps;
  loopDeps?: Partial<LoopDeps>;
  /** How long the launcher waits for the new window's sequencer to report in (default 5000). */
  waitMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Stop seam (test only): aborting it stops the foreground loop like Ctrl-C. */
  controller?: AbortController;
};

function refuseRunning(slug: string): number {
  const win = managerWindowName(slug);
  console.error(
    `flow epic manage: a sequencer is already running for '${slug}' (window ${win}).`,
  );
  console.error(
    `  attach with \`flow attach ${win}\` — Ctrl-C there stops it.`,
  );
  return 2;
}

export function runEpicManage(
  rest: string[],
  options: ManageOptions,
): number | Promise<number> {
  const parsed = parseManageArgs(rest);
  if ("error" in parsed) {
    if (parsed.error) console.error(`flow epic manage: ${parsed.error}`);
    console.error(`usage: ${MANAGE_USAGE}`);
    return 2;
  }
  if (parsed.help) {
    console.log(HELP);
    return 0;
  }
  const { slug } = parsed;
  if (!isValidSlug(slug)) {
    console.error(`flow epic manage: invalid epic slug '${slug}'.`);
    return 2;
  }
  if (!parsed.foreground) {
    const backend = resolveLauncherBackend({
      flag: "tmux",
      tmuxOnPath: options.tmuxOnPath,
    });
    if (backend.id !== "tmux") {
      console.error(
        "flow epic: epic orchestration requires the tmux launcher — tmux is not installed or not on PATH",
      );
      return 2;
    }
  }
  const cwd = options.cwd ?? process.cwd();
  const repo = resolveRepoRoot(cwd);
  if (!repo) {
    console.error(`flow epic manage: ${cwd} is not inside a git repository.`);
    return 2;
  }
  if (resolveGitCommonDir(repo) === null) {
    console.error(
      `flow epic manage: cannot resolve the repository identity of ${repo} — refusing to start rather than guess which pipelines are yours.`,
    );
    return 2;
  }
  const manifestPath = path.join(
    repo,
    epicDirRelative(slug),
    EPIC_MANIFEST_FILENAME,
  );
  const loaded = loadCommittedManifest(manifestPath);
  if (!loaded.ok) {
    console.error(
      loaded.reason === "not-found"
        ? `flow epic manage: manifest not found at ${manifestPath} — merge the design PR first.`
        : `flow epic manage: ${loaded.reason}`,
    );
    return 2;
  }
  return parsed.foreground
    ? runForeground(parsed, repo, manifestPath, options)
    : runLauncher(parsed, repo, options);
}

function runLauncher(
  parsed: ManageArgs,
  repo: string,
  options: ManageOptions,
): number | Promise<number> {
  const { slug } = parsed;
  const win = managerWindowName(slug);
  const exists = options.windowExists ?? ((n) => windowExists(n));
  const prior = readManager(slug, options.stateDir);
  const live = prior
    ? managerHealth(prior, Date.now(), options.liveness).kind !== "stopped"
    : false;
  if (live || exists(win)) return refuseRunning(slug);

  const env = options.env ?? process.env;
  const notify =
    env.FLOW_NOTIFY !== undefined ? [`FLOW_NOTIFY=${env.FLOW_NOTIFY}`] : [];
  const command = [
    "env",
    "-u",
    "FLOW_SLUG",
    "-u",
    "FLOW_PIPELINE",
    "-u",
    "TMUX_PANE",
    ...notify,
    "flow",
    "epic",
    "manage",
    slug,
    "--foreground",
    ...(parsed.model ? ["--model", parsed.model] : []),
    ...(parsed.effort ? ["--effort", parsed.effort] : []),
    "--autonomy",
    parsed.autonomy,
  ];
  const created = (options.createWindow ?? createWindow)(win, repo, command);
  if (!created.ok) {
    console.error(
      `flow epic manage: could not open window ${win}: ${created.stderr}`,
    );
    return 2;
  }
  return awaitSequencer(slug, win, options);
}

/** Wait (bounded) for the new window's sequencer to write a live manager.json. */
async function awaitSequencer(
  slug: string,
  win: string,
  options: ManageOptions,
): Promise<number> {
  const deadline = Date.now() + (options.waitMs ?? 5_000);
  for (;;) {
    const m = readManager(slug, options.stateDir);
    if (m && managerHealth(m, Date.now(), options.liveness).kind === "live")
      break;
    if (Date.now() >= deadline) {
      console.error(
        `flow epic manage: window ${win} opened but the sequencer did not report in — \`flow attach ${win}\` to see why.`,
      );
      return 1;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`flow:${win}`);
  console.log(
    `flow epic manage: sequencer started — \`flow attach ${win}\` to watch it; Ctrl-C there stops it.`,
  );
  return 0;
}

function defaultSpawnLaunch(repo: string): LoopDeps["spawnLaunch"] {
  return (args, outPath) =>
    new Promise((resolve) => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const fd = fs.openSync(outPath, "w");
      const env = { ...process.env };
      for (const k of ["FLOW_SLUG", "FLOW_PIPELINE", "TMUX_PANE"])
        delete env[k];
      // Own process group + file-backed stdio: a Ctrl-C or window close never
      // reaches a half-finished `flow feature create`, and this process exiting
      // never breaks the child's output.
      const child = spawn("flow", args, {
        cwd: repo,
        env,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      let closed = false;
      const closeFd = (): void => {
        if (closed) return;
        closed = true;
        try {
          fs.closeSync(fd);
        } catch {
          // already closed
        }
      };
      child.on("error", (e) => {
        if (!closed) {
          try {
            fs.writeSync(fd, `${e.message}\n`);
          } catch {
            // best effort: the reason is also the resolved exit
          }
        }
        closeFd();
        resolve({ exitCode: -1 });
      });
      child.on("close", (code) => {
        closeFd();
        resolve({ exitCode: code ?? -1 });
      });
      child.unref();
    });
}

function defaultNotify(args: string[]): void {
  const child = spawn("flow-notify", args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function waitForEnter(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.stdin.off("data", done);
      process.stdin.pause();
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done);
    process.stdin.once("data", done);
    process.stdin.resume();
  });
}

async function runForeground(
  parsed: ManageArgs,
  repo: string,
  manifestPath: string,
  options: ManageOptions,
): Promise<number> {
  const { slug } = parsed;
  const resolved = resolveManagerModelEffort({
    flagModel: parsed.model,
    flagEffort: parsed.effort,
    read: options.readConfig,
  });
  let procStartedAt: number | null = null;
  try {
    procStartedAt = pidStartEpoch(process.pid);
  } catch {
    // `ps` unreadable: degrade to a bare pid-alive liveness check
  }
  const now = nowIso();
  const state: ManagerState = {
    version: 1,
    epicSlug: slug,
    repo,
    window: managerWindowName(slug),
    pid: process.pid,
    procStartedAt,
    startedAt: now,
    heartbeatAt: now,
    pollMs: DEFAULT_STATE_POLL_MS,
    autonomy: parsed.autonomy,
    model: resolved.model,
    effort: resolved.effort,
    featureFallback: resolved.featureFallback,
    status: "running",
    // A crashed predecessor may have died mid-launch: carry its marker so that node holds.
    launching: readManager(slug, options.stateDir)?.launching ?? null,
  };
  const claim = claimManager(
    state,
    Date.now(),
    options.liveness,
    options.stateDir,
  );
  if (!claim.ok) return refuseRunning(slug);
  appendManagerLog(
    slug,
    { ts: now, kind: "started", window: state.window },
    options.stateDir,
  );

  const isTty = Boolean(process.stdout.isTTY);
  const deps: LoopDeps = {
    exec: defaultExec,
    spawnLaunch: defaultSpawnLaunch(repo),
    notify: defaultNotify,
    now: Date.now,
    sleep: abortableSleep,
    write: (t) => void process.stdout.write(t),
    isTty,
    stateDir: options.stateDir,
    epicsDir: options.epicsDir,
    readMaxParallel: options.readMaxParallel,
    waitForEnter: isTty ? waitForEnter : undefined,
    ...options.loopDeps,
  };
  const controller = options.controller ?? new AbortController();
  const dispose = installStopHandlers(controller, () => {});
  try {
    return await runManagerLoop(
      {
        manager: state,
        manifestPath,
        statePollMs: state.pollMs,
        githubPollMs: DEFAULT_GITHUB_POLL_MS,
      },
      deps,
      controller.signal,
    );
  } finally {
    dispose();
  }
}
