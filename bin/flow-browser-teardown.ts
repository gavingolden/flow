#!/usr/bin/env bun
/**
 * Session-scoped chrome-devtools-mcp browser teardown.
 *
 * chrome-devtools-mcp exposes no browser-close tool: `closeBrowser()` runs
 * only inside the MCP server's own `shutdown()` handler. `close_page` (the
 * page-level MCP tool) never reaches it. So the only safe way to reap a
 * pipeline's Chrome subprocess is to signal the SERVER — never Chrome
 * itself directly — and let its own shutdown path run.
 *
 * Default mode: resolve THIS flow-pipeline session's own `claude` pid by a
 * PPID walk, select that session's chrome-devtools-mcp SERVER descendants
 * (never a sibling session's, never the npm wrapper or telemetry
 * watchdog), signal them, and poll for exit. SIGTERM only — there is no
 * escalation to a harsher signal even on a poll timeout, because a harsher
 * signal skips the server's own shutdown path and orphans Chrome to PPID 1
 * (the exact failure mode this helper exists to prevent).
 *
 * `--orphans` mode (opt-in, report-only unless `--yes`): sweeps sessionless
 * automation-Chrome processes and sessionless chrome-devtools-mcp servers
 * left behind by a crashed/killed session. This is NOT the same sweep as
 * `flow done --orphans` (which sweeps stale pipeline STATE FILES, see
 * `bin/lib/done.ts` / `bin/lib/help.ts`) — the two commands share a flag
 * name but sweep unrelated things.
 *
 * Always exits 0. This helper must never break a caller.
 */

import * as os from "node:os";
import { pidStartEpoch } from "./lib/liveness";

// --- Core types --------------------------------------------------------

export type ProcRow = { pid: number; ppid: number; command: string };

export type TeardownResult = {
  ran: boolean;
  skipReason?:
    | "not-a-pipeline-session"
    | "no-session-pid"
    | "no-mcp-server"
    | "ps-unavailable";
  sessionPid?: number;
  dryRun: boolean;
  signalled: Array<{ pid: number; command: string }>;
  stillAlive: number[];
};

const CLAUDE_COMMAND_RE = /(^|\/)claude(\s|$)/;

/**
 * Walks the PPID chain UP from `startPid` and returns the NEAREST ancestor
 * whose command matches a `claude` binary. There is deliberately NO
 * widening fallback: verified live on the target host, a session's
 * `claude` parent can be a SHARED TMUX SERVER with dozens of sibling
 * `claude` children, each owning its own chrome-devtools-mcp server —
 * widening past the nearest `claude` match would reach that shared root
 * and every sibling pipeline's server would be in scope. Bounded to 64
 * hops and cycle-safe so a malformed process table cannot spin.
 */
export function resolveSessionPid(
  procs: ProcRow[],
  startPid: number,
): number | undefined {
  const byPid = new Map(procs.map((p) => [p.pid, p] as const));
  const visited = new Set<number>();
  let pid = startPid;
  for (let hop = 0; hop < 64; hop++) {
    if (visited.has(pid)) return undefined; // PPID cycle
    visited.add(pid);
    const proc = byPid.get(pid);
    if (!proc) return undefined; // chain runs off the known table
    if (CLAUDE_COMMAND_RE.test(proc.command)) return proc.pid;
    pid = proc.ppid;
  }
  return undefined; // exceeded the hop bound — bail safely
}

/** Transitive descendants of `rootPid`. Never includes the root. Cycle-safe. */
export function descendantsOf(procs: ProcRow[], rootPid: number): ProcRow[] {
  const childrenOf = new Map<number, ProcRow[]>();
  for (const p of procs) {
    const siblings = childrenOf.get(p.ppid) ?? [];
    siblings.push(p);
    childrenOf.set(p.ppid, siblings);
  }
  const out: ProcRow[] = [];
  const visited = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of childrenOf.get(pid) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/**
 * The session's own chrome-devtools-mcp SERVER descendants — excluding the
 * `npm exec` wrapper and the telemetry watchdog, which both contain the
 * substring `chrome-devtools-mcp` but never run the server's own
 * `shutdown()` handler, so signalling either reproduces the orphan failure
 * mode this helper exists to prevent.
 */
export function selectMcpServers(
  procs: ProcRow[],
  sessionPid: number,
): ProcRow[] {
  return descendantsOf(procs, sessionPid).filter(
    (p) =>
      p.command.includes("chrome-devtools-mcp") &&
      !p.command.includes("npm exec ") &&
      !p.command.includes("telemetry/watchdog/main.js"),
  );
}

export type Deps = {
  listProcs: () => ProcRow[] | undefined;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  alive: (pid: number) => boolean;
  sleepMs: (ms: number) => void;
  env: NodeJS.ProcessEnv;
  selfPid: number;
  homeDir: string;
  tmpDir: string;
  startEpochOf?: (pid: number) => number | undefined;
  nowMs: () => number;
};

function pollForExit(deps: Deps, pids: number[], timeoutMs: number): number[] {
  const deadline = deps.nowMs() + timeoutMs;
  let alive = pids.filter((pid) => deps.alive(pid));
  while (alive.length > 0 && deps.nowMs() < deadline) {
    deps.sleepMs(200);
    alive = alive.filter((pid) => deps.alive(pid));
  }
  return alive;
}

export function runTeardown(
  deps: Deps,
  opts: { dryRun: boolean; sessionPid?: number; timeoutMs: number },
): TeardownResult {
  const explicitSessionPid = opts.sessionPid !== undefined;
  if (!explicitSessionPid && deps.env.FLOW_PIPELINE !== "1") {
    return {
      ran: false,
      skipReason: "not-a-pipeline-session",
      dryRun: opts.dryRun,
      signalled: [],
      stillAlive: [],
    };
  }

  const procs = deps.listProcs();
  if (!procs) {
    return {
      ran: false,
      skipReason: "ps-unavailable",
      dryRun: opts.dryRun,
      signalled: [],
      stillAlive: [],
    };
  }

  let sessionPid = opts.sessionPid ?? resolveSessionPid(procs, deps.selfPid);
  if (explicitSessionPid) {
    // An explicit `--session-pid` bypasses the FLOW_PIPELINE gate AND
    // resolveSessionPid, so it must be independently verified: it has to
    // resolve to a real, currently-alive `claude` process in the table.
    // Without this, a caller-supplied 0/1/negative pid (or anything not in
    // `procs`) would fall through to `descendantsOf` and enumerate — or
    // even SIGTERM — an unrelated slice of the process table.
    const byPid = new Map(procs.map((p) => [p.pid, p] as const));
    const proc = sessionPid === undefined ? undefined : byPid.get(sessionPid);
    if (!proc || !CLAUDE_COMMAND_RE.test(proc.command)) {
      sessionPid = undefined;
    }
  }
  if (sessionPid === undefined) {
    return {
      ran: false,
      skipReason: "no-session-pid",
      dryRun: opts.dryRun,
      signalled: [],
      stillAlive: [],
    };
  }

  const servers = selectMcpServers(procs, sessionPid);
  if (servers.length === 0) {
    return {
      ran: false,
      skipReason: "no-mcp-server",
      sessionPid,
      dryRun: opts.dryRun,
      signalled: [],
      stillAlive: [],
    };
  }

  const signalled: Array<{ pid: number; command: string }> = [];
  if (!opts.dryRun) {
    for (const p of servers) {
      try {
        deps.kill(p.pid, "SIGTERM");
        signalled.push({ pid: p.pid, command: p.command });
      } catch {
        // A race where the process exited between selection and signalling
        // is not a failure — the poll below will simply not find it alive.
      }
    }
  }

  const stillAlive = opts.dryRun
    ? []
    : pollForExit(
        deps,
        servers.map((p) => p.pid),
        opts.timeoutMs,
      );

  return { ran: true, sessionPid, dryRun: opts.dryRun, signalled, stillAlive };
}

// --- Orphan sweep (--orphans) -------------------------------------------

export type ProfileShape =
  | "chrome-devtools-mcp-cache"
  | "chrome-devtools-mcp-isolated"
  | "go-rod-temp"
  | "unmatched";

export type OrphanRow = {
  pid: number;
  command: string;
  userDataDir: string;
  ageMs: number;
  profileShape: ProfileShape;
  matched: boolean;
};

function trimTrailingSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function underPrefix(path: string, prefix: string): boolean {
  const normPath = trimTrailingSlash(path);
  const normPrefix = trimTrailingSlash(prefix);
  return normPath === normPrefix || normPath.startsWith(`${normPrefix}/`);
}

function pathSegments(p: string): string[] {
  return p.split("/").filter((s) => s.length > 0);
}

/**
 * A POSITIVE ALLOWLIST, one named entry per recognized shape — never a
 * negative exclusion. Anchored on recognized temp roots + path SEGMENTS
 * (never a raw substring), so a real project dir (e.g. `~/code/rod/user-data`)
 * never false-matches the go-rod shape.
 */
export function classifyProfileShape(
  userDataDir: string,
  opts: { homeDir: string; tmpDir: string },
): ProfileShape {
  const cachePrefix = `${trimTrailingSlash(opts.homeDir)}/.cache/chrome-devtools-mcp`;
  if (underPrefix(userDataDir, cachePrefix)) return "chrome-devtools-mcp-cache";

  const tempRoots = [opts.tmpDir, "/tmp", "/var/folders/"];
  const underTemp = tempRoots.some((root) => underPrefix(userDataDir, root));
  if (!underTemp) return "unmatched";

  const segments = pathSegments(userDataDir);
  const last = segments[segments.length - 1] ?? "";

  // Puppeteer's isolated temp-profile directory shape. UNCONFIRMED BY
  // OBSERVATION: 27 chrome-devtools-mcp servers were live on the host when
  // this was written, but none currently had a Chrome child to inspect.
  // Ship the documented shape rather than inventing a different guess — an
  // unmatched row stays report-only (never signalled even with --yes), so a
  // wrong guess here degrades to report-only instead of an unsafe kill.
  if (/^puppeteer_dev_chrome_profile-/.test(last)) {
    return "chrome-devtools-mcp-isolated";
  }

  // go-rod's os.TempDir()-based profile shape: rod/user-data/<lowercase-hex>,
  // verified live at `/var/folders/8z/.../T/rod/user-data/99b0c95236a886aa`.
  const n = segments.length;
  if (
    n >= 3 &&
    segments[n - 3] === "rod" &&
    segments[n - 2] === "user-data" &&
    /^[0-9a-f]+$/.test(last)
  ) {
    return "go-rod-temp";
  }

  return "unmatched";
}

function extractFlagValue(command: string, flag: string): string | undefined {
  const m = new RegExp(`${flag}=(\\S+)`).exec(command);
  return m?.[1];
}

/**
 * Sessionless automation-Chrome browser ROOTS: ppid 1, the automation flag
 * signature, and a recognized profile shape. A negative "not the user's
 * real Chrome profile" exclusion is deliberately NOT used — it would
 * misclassify a developer's own long-lived custom-profile automation
 * Chrome as an orphan. `--type=` children are excluded as defence in depth
 * (already excluded by the ppid check in practice, since a helper's ppid
 * is the browser root's pid, not 1) — signalling only the root, never a
 * helper, avoids leaving a half-dead browser behind.
 */
export function selectOrphanBrowsers(
  procs: ProcRow[],
  opts: { homeDir: string; tmpDir: string },
): OrphanRow[] {
  const out: OrphanRow[] = [];
  for (const p of procs) {
    if (p.ppid !== 1) continue;
    if (p.command.includes("--type=")) continue;
    const hasAutomationSignature =
      (p.command.includes("--enable-automation") ||
        p.command.includes("--remote-debugging-port")) &&
      p.command.includes("--disable-background-networking");
    if (!hasAutomationSignature) continue;
    const userDataDir = extractFlagValue(p.command, "--user-data-dir");
    if (!userDataDir) continue;
    const profileShape = classifyProfileShape(userDataDir, opts);
    out.push({
      pid: p.pid,
      command: p.command,
      userDataDir,
      // Filled in by runOrphanSweep via deps.startEpochOf — see the ageMs
      // seam note there. 0 here is a placeholder, not a claim of freshness.
      ageMs: 0,
      profileShape,
      matched: profileShape !== "unmatched",
    });
  }
  return out;
}

/**
 * Sessionless chrome-devtools-mcp SERVER rows — ppid 1, or ppid absent from
 * the table (parent gone) — excluding the npm wrapper and telemetry
 * watchdog, same as `selectMcpServers`. A stale server is exactly what
 * keeps a leaked Chrome alive, and SIGTERM is the only signal that runs its
 * `shutdown()` handler, so reaping it is the same mechanism as
 * `runTeardown`, not a new one.
 */
const MCP_SERVER_ENTRYPOINT_RE =
  /node_modules\/\.bin\/chrome-devtools-mcp|chrome-devtools-mcp\/build\/.*\.js/;

export function selectOrphanMcpServers(procs: ProcRow[]): ProcRow[] {
  const knownPids = new Set(procs.map((p) => p.pid));
  return procs.filter(
    (p) =>
      p.command.includes("chrome-devtools-mcp") &&
      MCP_SERVER_ENTRYPOINT_RE.test(p.command) &&
      !p.command.includes("npm exec ") &&
      !p.command.includes("telemetry/watchdog/main.js") &&
      (p.ppid === 1 || !knownPids.has(p.ppid)),
  );
}

function ageMsFor(deps: Deps, pid: number): number {
  const startEpochOf = deps.startEpochOf;
  if (!startEpochOf) return 0;
  const startMs = startEpochOf(pid);
  if (startMs === undefined) return 0;
  return Math.max(0, deps.nowMs() - startMs);
}

export type OrphanSweepResult = {
  ran: boolean;
  skipReason?: "ps-unavailable";
  found: OrphanRow[];
  foundServers: Array<{ pid: number; command: string }>;
  signalled: number[];
};

export function runOrphanSweep(
  deps: Deps,
  opts: { yes: boolean; dryRun?: boolean; homeDir: string; tmpDir: string },
): OrphanSweepResult {
  const procs = deps.listProcs();
  if (!procs) {
    return {
      ran: false,
      skipReason: "ps-unavailable",
      found: [],
      foundServers: [],
      signalled: [],
    };
  }

  const found = selectOrphanBrowsers(procs, opts).map((row) => ({
    ...row,
    ageMs: ageMsFor(deps, row.pid),
  }));
  const foundServers = selectOrphanMcpServers(procs).map((p) => ({
    pid: p.pid,
    command: p.command,
  }));

  const signalled: number[] = [];
  if (opts.yes && !opts.dryRun) {
    for (const row of found) {
      if (!row.matched) continue;
      try {
        deps.kill(row.pid, "SIGTERM");
        signalled.push(row.pid);
      } catch {
        // best-effort — a process that exited between selection and
        // signalling is not a failure.
      }
    }
    for (const server of foundServers) {
      try {
        deps.kill(server.pid, "SIGTERM");
        signalled.push(server.pid);
      } catch {
        // best-effort, same as above.
      }
    }
  }

  return { ran: true, found, foundServers, signalled };
}

// --- Default Deps (real process table / real signals) -------------------

function parsePsOutput(text: string): ProcRow[] {
  const out: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue; // header line or malformed row — skip, not fatal
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return out;
}

function defaultListProcs(): ProcRow[] | undefined {
  try {
    const r = Bun.spawnSync(["ps", "-Ao", "pid,ppid,command"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LC_ALL: "C" },
    });
    if (r.exitCode !== 0) return undefined;
    return parsePsOutput(r.stdout.toString());
  } catch {
    return undefined;
  }
}

/**
 * Local 3-way ESRCH/EPERM-aware liveness probe (treats EPERM as alive).
 * Deliberately NOT `bin/lib/tmux.ts`'s private `pidIsAlive`, which
 * collapses ESRCH and EPERM into a single `false` and would under-report
 * `stillAlive` for a permission-denied-but-alive process. A local copy is
 * this repo's accepted convention here — `lock.ts`, `liveness.ts`, and
 * `tmux.ts` each keep their own.
 */
function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM, or anything unexpected: assume still alive rather than
    // falsely reporting a clean exit — this only affects a report field,
    // never triggers a harder signal.
    return true;
  }
}

function buildDefaultDeps(): Deps {
  return {
    listProcs: defaultListProcs,
    kill: (pid, signal) => process.kill(pid, signal),
    alive: defaultAlive,
    sleepMs: (ms) => Bun.sleepSync(ms),
    env: process.env,
    selfPid: process.pid,
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
    startEpochOf: (pid) => {
      const epoch = pidStartEpoch(pid);
      return epoch === null ? undefined : epoch * 1000;
    },
    nowMs: () => Date.now(),
  };
}

// --- CLI -------------------------------------------------------------

type ParsedCli = {
  json: boolean;
  dryRun: boolean;
  sessionPid?: number;
  timeoutMs: number;
  orphans: boolean;
  yes: boolean;
  usageError?: string;
};

function parseCliArgs(argv: string[]): ParsedCli {
  const out: ParsedCli = {
    json: false,
    dryRun: false,
    timeoutMs: 12000,
    orphans: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      out.json = true;
    } else if (a === "--dry-run") {
      out.dryRun = true;
    } else if (a === "--orphans") {
      out.orphans = true;
    } else if (a === "--yes") {
      out.yes = true;
    } else if (a === "--session-pid") {
      const v = argv[++i];
      const n = v === undefined || v === "" ? Number.NaN : Number(v);
      if (v === undefined || v === "" || !Number.isInteger(n) || n <= 1) {
        out.usageError = "--session-pid requires an integer value > 1";
      } else {
        out.sessionPid = n;
      }
    } else if (a === "--timeout-ms") {
      const v = argv[++i];
      const n = v === undefined || v === "" ? Number.NaN : Number(v);
      if (v === undefined || v === "" || !Number.isFinite(n) || n < 0) {
        out.usageError = "--timeout-ms requires a non-negative numeric value";
      } else {
        out.timeoutMs = n;
      }
    } else {
      out.usageError = `unknown flag: ${a}`;
    }
  }
  return out;
}

function usage(): string {
  return [
    "usage: flow-browser-teardown [--json] [--dry-run] [--session-pid <pid>] [--timeout-ms <n>]",
    "       flow-browser-teardown --orphans [--yes] [--dry-run] [--json]",
    "",
    "Default mode: session-scoped teardown — SIGTERMs THIS flow-pipeline",
    "session's own chrome-devtools-mcp SERVER (found by process ancestry) so",
    "its shutdown() handler reaps its Chrome subprocess. Gated on",
    "FLOW_PIPELINE=1 unless --session-pid is passed explicitly.",
    "",
    "--orphans mode sweeps sessionless browser PROCESSES (and sessionless",
    "chrome-devtools-mcp servers) left behind by a crashed/killed session.",
    "This is NOT the same sweep as `flow done --orphans`, which sweeps stale",
    "pipeline STATE FILES, not browser processes — the two commands share a",
    "flag name but sweep unrelated things.",
  ].join("\n");
}

export function main(argv: string[]): number {
  const parsed = parseCliArgs(argv);
  if (parsed.usageError) {
    process.stderr.write(
      `flow-browser-teardown: ${parsed.usageError}\n${usage()}\n`,
    );
    return 0; // never break a caller
  }

  const deps = buildDefaultDeps();

  if (parsed.orphans) {
    const result = runOrphanSweep(deps, {
      yes: parsed.yes,
      dryRun: parsed.dryRun,
      homeDir: deps.homeDir,
      tmpDir: deps.tmpDir,
    });
    if (parsed.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(
        `flow-browser-teardown --orphans: found=${result.found.length} servers=${result.foundServers.length} signalled=${result.signalled.length}`,
      );
    }
    return 0;
  }

  const result = runTeardown(deps, {
    dryRun: parsed.dryRun,
    sessionPid: parsed.sessionPid,
    timeoutMs: parsed.timeoutMs,
  });
  if (parsed.json) {
    console.log(JSON.stringify(result));
  } else {
    const reason = result.skipReason ? ` skipReason=${result.skipReason}` : "";
    console.log(
      `flow-browser-teardown: ran=${result.ran}${reason} signalled=${result.signalled.length} stillAlive=${result.stillAlive.length}`,
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
