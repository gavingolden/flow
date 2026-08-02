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
 *   flow-spawn --list <slug> [--json]
 *
 * Fail-open discipline: a registry-write failure (unwritable ~/.flow, `ps`
 * unavailable) warns on stderr and the command STILL RUNS — same
 * never-break-a-caller rule `bin/flow-browser-teardown.ts`'s header
 * documents. The one deviation: flow-spawn's own exit code IS the child's,
 * so unlike that helper it cannot pin itself to 0 on the launch path.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import {
  appendRow,
  procsDir,
  readRows,
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
};

export function parseCliArgs(argv: string[]): SpawnCliArgs {
  const out: SpawnCliArgs = {
    json: false,
    procClass: "default",
    stdin: "ignore",
    command: [],
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
    } else if (a === "--slug") {
      const v = argv[++i];
      if (v === undefined) {
        out.usageError = "--slug requires a value";
        return out;
      }
      out.slug = v;
    } else if (a === "--class") {
      const v = argv[++i];
      if (v !== "default" && v !== "mcp-server") {
        out.usageError = '--class must be "default" or "mcp-server"';
        return out;
      }
      out.procClass = v;
    } else if (a === "--stdin") {
      const v = argv[++i];
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
  args: { pid: number; slug: string; procClass: ProcClass; argv: string[] },
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
    sessionStartEpoch: getStartEpoch(selfPid),
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
 * critical window), the row is appended IMMEDIATELY after spawn (before
 * awaiting the child), and signal forwarders are installed only after that.
 */
export async function runLaunch(
  args: SpawnCliArgs,
  deps: SpawnDeps = {},
): Promise<number> {
  const spawn = deps.spawn ?? defaultSpawn;
  const doAppendRow = deps.appendRow ?? appendRow;

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

  try {
    fs.mkdirSync(procsDir(deps.baseDir), { recursive: true });
  } catch {
    // best-effort — appendRow below still fails open and reports its own error.
  }

  const child = spawn(args.command, { stdin: args.stdin });

  const row = buildRow(
    { pid: child.pid, slug, procClass: args.procClass, argv: args.command },
    deps,
  );
  const written = doAppendRow(row, deps.baseDir);
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
    "       flow-spawn --list <slug> [--json]",
    "",
    "Launches <cmd> in its own process group, records one row to",
    "~/.flow/state/procs/<slug>.jsonl, and passes through its stdio and exit code.",
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
