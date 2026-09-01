#!/usr/bin/env bun
/**
 * Launch wrapper: runs a command in its own process group and records one
 * row to the process-lifecycle registry (`bin/lib/proc-registry.ts`), then
 * passes through the child's stdio and exit code. Purely additive — this
 * file owns no kill path and no reap engine. The only signals it ever
 * sends are its OWN forwarding of a SIGINT/SIGTERM it received to the
 * child it spawned (a launch-lifetime concern, not a reap).
 *
 * Usage:
 *   flow-spawn [--slug <s>] [--class default|mcp-server] [--stdin inherit|ignore] -- <cmd> [args...]
 *   flow-spawn --detach --stdout <path> --stderr <path> [--slug <s>] [--class default|mcp-server] -- <cmd> [args...]
 *   flow-spawn --list <slug> [--json]
 *
 * Fail-open discipline: a registry-write failure (unwritable ~/.flow, `ps`
 * unavailable) warns on stderr and the command STILL RUNS — same
 * never-break-a-caller rule `bin/flow-browser-teardown.ts`'s header
 * documents. The one deviation: flow-spawn's own exit code IS the child's,
 * so unlike that helper it cannot pin itself to 0 on the launch path.
 * `--detach` is the exception to that exception: there is no child exit to
 * report (the wrapper never awaits it), so it always exits 0 once the
 * registry row is recorded, and the child's stdio is redirected to the
 * caller-named `--stdout`/`--stderr` files precisely so the launching tool
 * call is never held open by an inherited pipe.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import {
  appendRow,
  procsDir,
  readRows,
  registryPath,
  type ProcClass,
  type ProcRegistryRow,
} from "./lib/proc-registry";
import { pidStartEpoch } from "./lib/liveness";
import { resolveSlugFromEnv } from "./lib/session-identity";
import { isValidSlug } from "./lib/slug";

export type SpawnCliArgs = {
  list?: string;
  json: boolean;
  slug?: string;
  procClass: ProcClass;
  stdin: "inherit" | "ignore";
  command: string[];
  usageError?: string;
  detach: boolean;
  stdoutPath?: string;
  stderrPath?: string;
};

export function parseCliArgs(argv: string[]): SpawnCliArgs {
  const out: SpawnCliArgs = {
    json: false,
    procClass: "default",
    stdin: "ignore",
    command: [],
    detach: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.command = argv.slice(i + 1);
      break;
    } else if (a === "--list") {
      const v = argv[++i];
      if (v === undefined) {
        out.usageError = "--list requires a slug value";
        return out;
      }
      out.list = v;
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "--detach") {
      out.detach = true;
    } else if (a === "--stdout") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) {
        out.usageError = "--stdout requires a value";
        return out;
      }
      out.stdoutPath = v;
    } else if (a === "--stderr") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) {
        out.usageError = "--stderr requires a value";
        return out;
      }
      out.stderrPath = v;
    } else if (a === "--slug") {
      const v = argv[++i];
      if (v === undefined) {
        out.usageError = "--slug requires a value";
        return out;
      }
      out.slug = v;
    } else if (a === "--class") {
      const v = argv[++i];
      if (v === undefined) {
        out.usageError = "--class requires a value";
        return out;
      }
      if (v !== "default" && v !== "mcp-server") {
        out.usageError = '--class must be "default" or "mcp-server"';
        return out;
      }
      out.procClass = v;
    } else if (a === "--stdin") {
      const v = argv[++i];
      if (v === undefined) {
        out.usageError = "--stdin requires a value";
        return out;
      }
      if (v !== "inherit" && v !== "ignore") {
        out.usageError = '--stdin must be "inherit" or "ignore"';
        return out;
      }
      out.stdin = v;
    } else {
      out.usageError = `unknown flag: ${a}`;
      return out;
    }
  }
  if (out.list === undefined && out.command.length === 0) {
    out.usageError =
      "no command given — pass `-- <cmd> [args...]` or `--list <slug>`";
    return out;
  }
  // An inherited pipe would keep the launching Bash tool call open until
  // the detached child exits, defeating the whole point of --detach — see
  // the header docstring's "Detached stdio must go to files" rationale.
  if (
    out.detach &&
    (out.stdoutPath === undefined || out.stderrPath === undefined)
  ) {
    out.usageError =
      "--detach requires both --stdout <path> and --stderr <path>";
  }
  return out;
}

export type SpawnDeps = {
  spawn?: (
    argv: string[],
    opts: { stdin: "inherit" | "ignore" },
  ) => {
    pid: number;
    exited: Promise<number>;
    signalCode?: NodeJS.Signals | null;
  };
  // The --detach launch primitive: NO exited promise (never awaited) and NO
  // signalCode — a detached child is deliberately not tied to this
  // process's lifetime. `unref()` lets the Bun event loop exit without
  // waiting on the child.
  spawnDetached?: (
    argv: string[],
    opts: { stdoutFd: number; stderrFd: number },
  ) => { pid: number; unref: () => void };
  // Opens a file for the detached child's stdout/stderr redirect, append
  // mode, 0o600. Injectable so tests never touch the real filesystem.
  openAppendFd?: (path: string) => number;
  closeFd?: (fd: number) => void;
  pidStartEpoch?: (pid: number) => number | null;
  appendRow?: typeof appendRow;
  readRows?: typeof readRows;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  env?: NodeJS.ProcessEnv;
  selfPid?: number;
  nowMs?: () => number;
  baseDir?: string;
};

function defaultSpawn(
  argv: string[],
  opts: { stdin: "inherit" | "ignore" },
): {
  pid: number;
  exited: Promise<number>;
  signalCode?: NodeJS.Signals | null;
} {
  const child = Bun.spawn(argv, {
    detached: true,
    stdin: opts.stdin,
    stdout: "inherit",
    stderr: "inherit",
  });
  return {
    pid: child.pid,
    exited: child.exited,
    get signalCode(): NodeJS.Signals | null {
      return child.signalCode;
    },
  };
}

// Detached, file-redirected launch: stdin ignored, stdout/stderr point at
// caller-named files (never inherited — an inherited pipe keeps the
// launching Bash tool call open until the child exits, the exact footgun
// --detach exists to avoid). `unref()` lets this process exit without
// waiting on the child.
function defaultSpawnDetached(
  argv: string[],
  opts: { stdoutFd: number; stderrFd: number },
): { pid: number; unref: () => void } {
  const child = Bun.spawn(argv, {
    detached: true,
    stdin: "ignore",
    stdout: opts.stdoutFd,
    stderr: opts.stderrFd,
  });
  child.unref();
  return {
    pid: child.pid,
    unref: () => child.unref(),
  };
}

/**
 * Resolution order: an explicit `--slug` that passes `isValidSlug` wins,
 * then the ambient `FLOW_SLUG` env var, then a synthetic
 * `untracked-<selfPid>-<nowMs>` slug (itself shaped to satisfy
 * `isValidSlug`). NEVER refuses to launch and NEVER skips the write — "no
 * slug resolves" is the DEFAULT state until an epic feature adopts this
 * wrapper at real spawn sites, so skipping would guarantee a population of
 * unrecorded launches with a wrapper in the chain supplying false coverage.
 */
export function resolveSlug(
  args: SpawnCliArgs,
  deps: SpawnDeps = {},
): { slug: string; synthetic: boolean; rejectedSlug?: string } {
  if (args.slug !== undefined) {
    if (isValidSlug(args.slug)) return { slug: args.slug, synthetic: false };
    // Fall through rather than refusing to launch, but name the rejected
    // value: without this the caller sees only "no slug resolved", which
    // reads as "you passed nothing" when they in fact passed something
    // invalid. Rejecting (not sanitizing) is deliberate — the slug becomes
    // a filesystem path component, so coercing it is the weaker posture.
    const fallback = resolveSlug({ ...args, slug: undefined }, deps);
    return { ...fallback, rejectedSlug: args.slug };
  }
  const env = deps.env ?? process.env;
  const fromEnv = resolveSlugFromEnv(env);
  if (fromEnv !== null) return { slug: fromEnv, synthetic: false };

  const selfPid = deps.selfPid ?? process.pid;
  const nowMs = deps.nowMs ?? (() => Date.now());
  return { slug: `untracked-${selfPid}-${nowMs()}`, synthetic: true };
}

export function buildRow(
  args: {
    pid: number;
    slug: string;
    procClass: ProcClass;
    argv: string[];
    // Pre-resolved self start-epoch, so callers that already probed it
    // (see `runLaunch`, which hoists this above the spawn to avoid a
    // second `ps` fork sitting inside the unrecorded-process window) don't
    // pay for a second `pidStartEpoch` call here.
    selfStartEpoch?: number | null;
  },
  deps: SpawnDeps = {},
): ProcRegistryRow {
  const getStartEpoch = deps.pidStartEpoch ?? pidStartEpoch;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const selfPid = deps.selfPid ?? process.pid;
  return {
    // A detached child is its own process-group leader (verified live,
    // bun 1.3.11: child pid 67856 / pgid 67856 against parent pgid 67852).
    pgid: args.pid,
    pid: args.pid,
    startEpoch: getStartEpoch(args.pid),
    slug: args.slug,
    class: args.procClass,
    argv: args.argv,
    recordedAt: nowMs(),
    sessionPid: selfPid,
    sessionStartEpoch:
      args.selfStartEpoch !== undefined
        ? args.selfStartEpoch
        : getStartEpoch(selfPid),
  };
}

/**
 * Forwards `sig` to the child's whole process group first; if that group no
 * longer exists (ESRCH — the child hasn't yet been reparented into its own
 * group, a narrow startup race), retries against the bare pid so the child
 * still receives the signal. Swallows any other error; never throws.
 */
export function forwardSignal(
  pgid: number,
  pid: number,
  sig: NodeJS.Signals,
  deps: SpawnDeps = {},
): void {
  const kill =
    deps.kill ?? ((p: number, s: NodeJS.Signals) => process.kill(p, s));
  try {
    kill(-pgid, sig);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") {
      try {
        kill(pid, sig);
      } catch {
        // best-effort — never throws
      }
    }
  }
}

/**
 * ORDER IS LOAD-BEARING: the procs dir is created BEFORE spawning (so the
 * post-spawn append is a bare write(2) with no path resolution in the
 * critical window — `precomputedTarget` below is what makes that claim
 * actually true; `appendRow` skips its own path-resolution + mkdir when it
 * is given one), the row is appended IMMEDIATELY after spawn (before
 * awaiting the child), and signal forwarders are installed only after
 * that. The self-pid start-epoch probe has no dependency on the child, so
 * it is hoisted above the spawn too — that keeps the unrecorded-process
 * window (spawn → append) to the single `ps` fork the plan budgeted,
 * rather than two.
 */
export async function runLaunch(
  args: SpawnCliArgs,
  deps: SpawnDeps = {},
): Promise<number> {
  if (args.detach) {
    return runDetachedLaunch(args, deps);
  }
  const spawn = deps.spawn ?? defaultSpawn;
  const doAppendRow = deps.appendRow ?? appendRow;
  const getStartEpoch = deps.pidStartEpoch ?? pidStartEpoch;
  const selfPid = deps.selfPid ?? process.pid;

  const { slug, synthetic, rejectedSlug } = resolveSlug(args, deps);
  if (rejectedSlug !== undefined) {
    process.stderr.write(
      `flow-spawn: --slug "${rejectedSlug}" is not a valid slug (lowercase alphanumeric and hyphens, max 60 chars) — ignoring it\n`,
    );
  }
  if (synthetic) {
    process.stderr.write(
      `flow-spawn: no slug resolved — recording this launch under the synthetic slug "${slug}"\n`,
    );
  }

  const selfStartEpoch = getStartEpoch(selfPid);

  let precomputedTarget: string | undefined;
  try {
    fs.mkdirSync(procsDir(deps.baseDir), { recursive: true, mode: 0o700 });
    precomputedTarget = registryPath(slug, deps.baseDir);
  } catch {
    // best-effort — appendRow below still fails open and reports its own
    // error, and recomputes the target itself when precomputedTarget is
    // unset.
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(args.command, { stdin: args.stdin });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `flow-spawn: failed to launch ${JSON.stringify(args.command)}: ${msg}\n`,
    );
    return 127;
  }

  const row = buildRow(
    {
      pid: child.pid,
      slug,
      procClass: args.procClass,
      argv: args.command,
      selfStartEpoch,
    },
    deps,
  );
  const written = doAppendRow(row, deps.baseDir, precomputedTarget);
  if (!written.written) {
    process.stderr.write(
      `flow-spawn: registry write skipped: ${written.error}\n`,
    );
  }

  const forwarders: Array<{ sig: NodeJS.Signals; handler: () => void }> = [];
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => forwardSignal(row.pgid, child.pid, sig, deps);
    process.on(sig, handler);
    forwarders.push({ sig, handler });
  }

  try {
    const exitCode = await child.exited;
    const signalCode = child.signalCode;
    if (signalCode) {
      const signum = os.constants.signals[signalCode as NodeJS.Signals] as
        | number
        | undefined;
      return signum !== undefined ? 128 + signum : 1;
    }
    return exitCode;
  } finally {
    for (const { sig, handler } of forwarders) process.off(sig, handler);
  }
}

/**
 * The `--detach` launch mode. Preserves the same load-bearing ordering as
 * `runLaunch` above (mkdir procs dir → spawn → appendRow immediately →
 * …), but deliberately omits everything that ties this process's lifetime
 * to the child's: no `await child.exited`, no `SIGINT`/`SIGTERM`
 * forwarders. The child's stdio is redirected to caller-named files (never
 * inherited), and the child is `unref()`'d so this process can exit the
 * moment the registry row is written.
 */
async function runDetachedLaunch(
  args: SpawnCliArgs,
  deps: SpawnDeps = {},
): Promise<number> {
  const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached;
  const doAppendRow = deps.appendRow ?? appendRow;
  const getStartEpoch = deps.pidStartEpoch ?? pidStartEpoch;
  const selfPid = deps.selfPid ?? process.pid;
  const openAppendFd =
    deps.openAppendFd ?? ((p: string) => fs.openSync(p, "a", 0o600));
  const closeFd = deps.closeFd ?? ((fd: number) => fs.closeSync(fd));

  const { slug, synthetic, rejectedSlug } = resolveSlug(args, deps);
  if (rejectedSlug !== undefined) {
    process.stderr.write(
      `flow-spawn: --slug "${rejectedSlug}" is not a valid slug (lowercase alphanumeric and hyphens, max 60 chars) — ignoring it\n`,
    );
  }
  if (synthetic) {
    process.stderr.write(
      `flow-spawn: no slug resolved — recording this launch under the synthetic slug "${slug}"\n`,
    );
  }

  const selfStartEpoch = getStartEpoch(selfPid);

  let precomputedTarget: string | undefined;
  try {
    fs.mkdirSync(procsDir(deps.baseDir), { recursive: true, mode: 0o700 });
    precomputedTarget = registryPath(slug, deps.baseDir);
  } catch {
    // best-effort — appendRow below still fails open and reports its own
    // error, and recomputes the target itself when precomputedTarget is
    // unset.
  }

  let stdoutFd: number;
  let stderrFd: number;
  try {
    stdoutFd = openAppendFd(args.stdoutPath as string);
    stderrFd = openAppendFd(args.stderrPath as string);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `flow-spawn: failed to open --stdout/--stderr file: ${msg}\n`,
    );
    return 127;
  }

  let child: ReturnType<typeof spawnDetached>;
  try {
    child = spawnDetached(args.command, { stdoutFd, stderrFd });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `flow-spawn: failed to launch ${JSON.stringify(args.command)}: ${msg}\n`,
    );
    return 127;
  } finally {
    // Bun.spawn dups the fds into the child; the parent's copies are no
    // longer needed once spawn() has returned (or thrown).
    try {
      closeFd(stdoutFd);
    } catch {
      // best-effort
    }
    try {
      closeFd(stderrFd);
    } catch {
      // best-effort
    }
  }

  const row = buildRow(
    {
      pid: child.pid,
      slug,
      procClass: args.procClass,
      argv: args.command,
      selfStartEpoch,
    },
    deps,
  );
  const written = doAppendRow(row, deps.baseDir, precomputedTarget);
  if (!written.written) {
    process.stderr.write(
      `flow-spawn: registry write skipped: ${written.error}\n`,
    );
  }

  child.unref();
  console.log(String(child.pid));
  return 0;
}

export function runList(
  slug: string,
  json: boolean,
  deps: SpawnDeps = {},
): number {
  const doReadRows = deps.readRows ?? readRows;
  const { rows, malformed } = doReadRows(slug, deps.baseDir);
  if (json) {
    console.log(JSON.stringify({ slug, rows, malformed }));
  } else {
    console.log(
      `flow-spawn --list ${slug}: rows=${rows.length} malformed=${malformed}`,
    );
    for (const row of rows) {
      console.log(
        `  pid=${row.pid} pgid=${row.pgid} class=${row.class} argv=${row.argv.join(" ")}`,
      );
    }
  }
  return 0;
}

export function usage(): string {
  return [
    "usage: flow-spawn [--slug <s>] [--class default|mcp-server] [--stdin inherit|ignore] -- <cmd> [args...]",
    "       flow-spawn --detach --stdout <path> --stderr <path> [--slug <s>] [--class default|mcp-server] -- <cmd> [args...]",
    "       flow-spawn --list <slug> [--json]",
    "",
    "Launches <cmd> in its own process group, records one row to",
    "~/.flow/state/procs/<slug>.jsonl, and passes through its stdio and exit code.",
    "--detach launches without awaiting the child: stdio is redirected to",
    "--stdout/--stderr files (never inherited), the pid is printed, and the",
    "wrapper exits 0 immediately once the registry row is recorded.",
    "--list prints the rows recorded for <slug> (an unknown slug reports zero",
    "rows at exit 0, never an error).",
  ].join("\n");
}

export async function main(argv: string[]): Promise<number> {
  const args = parseCliArgs(argv);
  if (args.usageError) {
    process.stderr.write(`flow-spawn: ${args.usageError}\n${usage()}\n`);
    return 2;
  }
  if (args.list !== undefined) {
    return runList(args.list, args.json);
  }
  return runLaunch(args);
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
