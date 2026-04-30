#!/usr/bin/env bun
/**
 * Bounded chat-friendly tail of a flow task's active phase.
 *
 * Wraps `flow log <id> --follow` (PR 6) and stops after a wall-clock or event
 * budget — whichever fires first — so pasting the output into a Claude Code
 * chat doesn't burn the session token window. The bound lives here, never in
 * `flow log` itself.
 *
 * Usage:
 *   ./scripts/flow-watch.ts [id] [--phase <name>] [--seconds <n>] [--events <n>]
 *
 * Defaults: --seconds 30, --events 50.
 *
 * When `id` is omitted: a single non-terminal task is auto-resolved; multiple
 * → list and exit non-zero; none → fall back to the most-recently-updated
 * task and tail its last events without `--follow`.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// --- Types ---

export type TerminalStatus = "merged" | "aborted" | "needs-human";

export type TaskInfo = {
  id: string;
  status: string;
  updatedMs: number;
};

export type Resolution =
  | { kind: "explicit-active"; id: string }
  | { kind: "explicit-terminal"; id: string; status: TerminalStatus }
  | { kind: "follow"; id: string }
  | { kind: "ambiguous"; candidates: TaskInfo[] }
  | { kind: "terminal-fallback"; id: string; status: string }
  | { kind: "unknown"; id: string; available: string[] };

export type ParsedArgs = {
  id?: string;
  phase?: string;
  seconds: number;
  events: number;
};

export type SpawnedProc = {
  stdout: ReadableStream<Uint8Array>;
  // Optional: when present, the wrapper folds stderr lines into the same
  // event budget as stdout, so warnings/errors from `flow log` can't bypass
  // the chat-token bound. Implementations that inherit stderr (legacy) can
  // omit this — the wrapper handles `undefined` gracefully.
  stderr?: ReadableStream<Uint8Array>;
  kill: (signal?: number | string) => void;
  exited: Promise<number>;
};

export type SpawnFn = (argv: string[]) => SpawnedProc;

export type WriteSink = { write(chunk: string): void };

export type RunBoundArgs = {
  flowLogArgs: string[];
  secondsCap: number;
  eventsCap: number;
  mode: "follow" | "tail";
  // Used in the bound footer's "invoke /flow-watch <id> again" hint.
  idForFooter: string;
  spawn?: SpawnFn;
  stdout?: WriteSink;
  stderr?: WriteSink;
};

// --- Constants ---

// Source of truth: `src/state/phases.ts:14-29`. Duplicated here because the
// installed script must work in target repos that don't ship the CLI's
// TypeScript sources on disk.
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "merged",
  "aborted",
  "needs-human",
]);

// --- Pure helpers ---

export function isTerminalStatus(s: string): s is TerminalStatus {
  return TERMINAL_STATUSES.has(s);
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;

/**
 * Extracts `status` and `updated` from a markdown file's YAML frontmatter.
 * Intentionally minimal — the schema (`docs/task-schema.md`) is stable, the
 * fields are top-level scalars, and pulling in a YAML dependency for two
 * lines would bloat the install.
 */
export function parseFrontmatterStatus(raw: string): {
  status?: string;
  updated?: string;
} {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return {};
  const block = match[1];
  const out: { status?: string; updated?: string } = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^(status|updated):\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1] as "status" | "updated"] = stripQuotes(m[2]);
  }
  return out;
}

function stripQuotes(v: string): string {
  if (v.length < 2) return v;
  const first = v[0];
  const last = v[v.length - 1];
  if ((first === "'" || first === '"') && first === last) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Scans both `<tasksRoot>/*.md` and `<tasksRoot>/archive/*.md` for task files.
 * Terminal tasks are moved under `archive/` per `docs/task-schema.md`, and
 * `flow log` itself resolves them via `findTaskFile` (`src/util/git.ts`); the
 * wrapper has to mirror that or `/flow-watch <merged-id>` rejects ids that
 * `flow log <id>` would happily tail.
 */
export async function loadTasks(tasksRoot: string): Promise<TaskInfo[]> {
  const out: TaskInfo[] = [];
  await collectFrom(tasksRoot, out);
  await collectFrom(join(tasksRoot, "archive"), out);
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

async function collectFrom(dir: string, out: TaskInfo[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const id = name.slice(0, -3);
    const text = await readFile(join(dir, name), "utf8").catch(() => null);
    if (text === null) continue;
    const { status, updated } = parseFrontmatterStatus(text);
    if (!status) continue;
    const parsed = updated ? Date.parse(updated) : 0;
    out.push({
      id,
      status,
      updatedMs: Number.isNaN(parsed) ? 0 : parsed,
    });
  }
}

/**
 * Resolves the git toplevel for `cwd`, mirroring `flow log`'s behavior so
 * subdirectory invocations still find `.orchestrator/`. Falls back to `cwd`
 * unchanged when `git rev-parse` fails — `loadTasks` then surfaces the
 * "no tasks found" path naturally.
 */
export function findRepoRoot(cwd: string): string {
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch {
    // git not on PATH — fall through.
  }
  return cwd;
}

export function resolveTaskId(args: {
  explicitId?: string;
  tasks: TaskInfo[];
}): Resolution {
  const { explicitId, tasks } = args;
  if (explicitId) {
    const t = tasks.find((x) => x.id === explicitId);
    if (!t) {
      return {
        kind: "unknown",
        id: explicitId,
        available: tasks.map((x) => x.id),
      };
    }
    if (isTerminalStatus(t.status)) {
      return { kind: "explicit-terminal", id: t.id, status: t.status };
    }
    return { kind: "explicit-active", id: t.id };
  }
  const nonTerminal = tasks.filter((t) => !isTerminalStatus(t.status));
  if (nonTerminal.length === 1) {
    return { kind: "follow", id: nonTerminal[0].id };
  }
  if (nonTerminal.length > 1) {
    return { kind: "ambiguous", candidates: nonTerminal };
  }
  if (tasks.length === 0) {
    return { kind: "unknown", id: "", available: [] };
  }
  const sorted = [...tasks].sort((a, b) => b.updatedMs - a.updatedMs);
  return {
    kind: "terminal-fallback",
    id: sorted[0].id,
    status: sorted[0].status,
  };
}

export function parseArgs(argv: string[]): ParsedArgs {
  let id: string | undefined;
  let phase: string | undefined;
  let seconds = 30;
  let events = 50;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--phase") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--phase requires a value");
      phase = v;
    } else if (a === "--seconds") {
      seconds = parsePositiveInt(argv[++i], "--seconds");
    } else if (a === "--events") {
      events = parsePositiveInt(argv[++i], "--events");
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (id === undefined) {
      id = a;
    } else {
      throw new Error(`unexpected positional argument: ${a}`);
    }
  }
  return { id, phase, seconds, events };
}

function parsePositiveInt(v: string | undefined, flag: string): number {
  if (v === undefined) throw new Error(`${flag} requires a value`);
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `${flag} must be a positive integer (got ${JSON.stringify(v)})`,
    );
  }
  return n;
}

// --- Bound enforcement ---

function defaultSpawn(argv: string[]): SpawnedProc {
  // Pipe stderr (not inherit) so the wrapper can fold its lines into the
  // same event budget as stdout. Inheriting would let `flow log` warnings
  // bypass the chat-token bound — the exact failure mode the wrapper exists
  // to prevent.
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  return {
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    kill: (sig) => proc.kill(sig as never),
    exited: proc.exited,
  };
}

function isEnoent(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  if (e.code === "ENOENT") return true;
  return (
    typeof e.message === "string" && /ENOENT|not found|No such/i.test(e.message)
  );
}

export async function runWithBound(args: RunBoundArgs): Promise<number> {
  const stdout = args.stdout ?? { write: (s) => process.stdout.write(s) };
  const stderr = args.stderr ?? { write: (s) => process.stderr.write(s) };
  const spawnFn = args.spawn ?? defaultSpawn;

  let proc: SpawnedProc;
  try {
    proc = spawnFn(["flow", ...args.flowLogArgs]);
  } catch (err) {
    if (isEnoent(err)) {
      stderr.write(
        "error: flow CLI not found on PATH; is flow installed in this repo?\n",
      );
      return 1;
    }
    throw err;
  }

  // Shared budget across stdout and stderr — both contribute lines to the
  // chat window, so both must count against the same cap.
  let eventCount = 0;
  let stoppedReason: "events" | "time" | "eof" = "eof";

  // Idempotent stop: only the first reason wins. Subsequent fires (e.g. EOF
  // after kill) shouldn't overwrite the real cause.
  const stop = (reason: "events" | "time"): void => {
    if (stoppedReason !== "eof") return;
    stoppedReason = reason;
    try {
      proc.kill("SIGTERM");
    } catch {
      // Already exited — ignore.
    }
  };

  // Only arm the wall-clock bound in follow mode. Tail mode (`flow log` with
  // no --follow) emits a finite stream that exits on its own; a stray timer
  // just makes the test surface more annoying.
  const timer =
    args.mode === "follow"
      ? setTimeout(() => stop("time"), args.secondsCap * 1000)
      : null;

  // Track the largest event count observed when we triggered the events cap,
  // so we don't overshoot if stdout and stderr both push at once.
  const drainStream = async (
    stream: ReadableStream<Uint8Array>,
    sink: WriteSink,
  ): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      outer: while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl + 1);
          buf = buf.slice(nl + 1);
          if (eventCount >= args.eventsCap) break outer;
          sink.write(line);
          eventCount++;
          if (eventCount >= args.eventsCap) {
            stop("events");
            break outer;
          }
        }
      }
      if (buf.length > 0 && eventCount < args.eventsCap) {
        sink.write(buf);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Already closed.
      }
    }
  };

  const drains: Promise<void>[] = [drainStream(proc.stdout, stdout)];
  if (proc.stderr) {
    drains.push(drainStream(proc.stderr, stderr));
  }
  await Promise.all(drains);

  if (timer) clearTimeout(timer);
  const childExit = await proc.exited;

  stdout.write(footerFor(args, stoppedReason));
  // When the wrapper itself stopped the child (events/time cap), `proc.exited`
  // is whatever signal-induced code the runtime chose — typically 143 for
  // SIGTERM. That's not a child-side failure, so we always return 0 in that
  // case. Only when the child finished on its own (`eof`) does its exit code
  // reflect a real success/failure of `flow log`, and we forward it.
  if (stoppedReason === "eof") {
    return childExit;
  }
  return 0;
}

function footerFor(
  args: RunBoundArgs,
  reason: "events" | "time" | "eof",
): string {
  const hint = `invoke \`/flow-watch ${args.idForFooter}\` again to keep tailing`;
  switch (reason) {
    case "events":
      return `(stopped after ${args.eventsCap} events — ${hint})\n`;
    case "time":
      return `(stopped after ${args.secondsCap}s — ${hint})\n`;
    case "eof":
      return args.mode === "follow"
        ? "(log stream ended)\n"
        : "(end of log)\n";
  }
}

// --- main ---

function printHelp(out: WriteSink): void {
  out.write(`Usage: ./scripts/flow-watch.ts [id] [--phase <name>] [--seconds <n>] [--events <n>]

Bounded tail of a flow task's active phase. Defaults: --seconds 30, --events 50.

When [id] is omitted, the unique non-terminal task is auto-resolved. With
multiple non-terminal tasks the wrapper lists them and exits non-zero; with
none it falls back to the most-recently-updated task without --follow.
`);
}

export type MainDeps = {
  cwd?: string;
  spawn?: SpawnFn;
  stdout?: WriteSink;
  stderr?: WriteSink;
};

export async function main(
  argv: string[],
  deps: MainDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? { write: (s) => process.stdout.write(s) };
  const stderr = deps.stderr ?? { write: (s) => process.stderr.write(s) };
  const cwd = deps.cwd ?? process.cwd();

  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp(stdout);
    return 0;
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  // Resolve the repo root the same way `flow log` does, so subdirectory
  // invocations still discover `.orchestrator/`.
  const repoRoot = findRepoRoot(cwd);
  const tasksDir = join(repoRoot, ".orchestrator", "tasks");
  const tasks = await loadTasks(tasksDir);
  const resolution = resolveTaskId({ explicitId: parsed.id, tasks });

  switch (resolution.kind) {
    case "unknown": {
      if (resolution.id) {
        stderr.write(
          `error: task '${resolution.id}' not found in .orchestrator/tasks/\n`,
        );
      } else {
        stderr.write("error: no tasks found in .orchestrator/tasks/\n");
      }
      if (resolution.available.length > 0) {
        stderr.write("available task ids:\n");
        for (const id of resolution.available) {
          stderr.write(`  ${id}\n`);
        }
      }
      return 1;
    }
    case "ambiguous": {
      stderr.write(
        "error: multiple non-terminal tasks — specify one with `/flow-watch <id>`:\n",
      );
      for (const t of resolution.candidates) {
        const updated = t.updatedMs
          ? new Date(t.updatedMs).toISOString()
          : "(no timestamp)";
        stderr.write(
          `  ${t.id}  status=${t.status}  updated=${updated}\n`,
        );
      }
      return 1;
    }
    case "follow": {
      stdout.write(`(resolved id: ${resolution.id})\n`);
      return runFollow(resolution.id, parsed, deps);
    }
    case "explicit-active": {
      return runFollow(resolution.id, parsed, deps);
    }
    case "explicit-terminal": {
      stdout.write(
        `(task ${resolution.id} is ${resolution.status} — showing last events)\n`,
      );
      return runTail(resolution.id, parsed, deps);
    }
    case "terminal-fallback": {
      stdout.write(
        `(no active task — showing last events of ${resolution.id}, status=${resolution.status})\n`,
      );
      return runTail(resolution.id, parsed, deps);
    }
  }
}

async function runFollow(
  id: string,
  parsed: ParsedArgs,
  deps: MainDeps,
): Promise<number> {
  const stdout = deps.stdout ?? { write: (s) => process.stdout.write(s) };
  const phaseLabel = parsed.phase ?? "active phase";
  stdout.write(
    `Tailing ${phaseLabel} for ${id} (bound: ${parsed.seconds}s / ${parsed.events} events)\n`,
  );
  const flowLogArgs = ["log", id, "--follow"];
  if (parsed.phase) flowLogArgs.push("--phase", parsed.phase);
  return runWithBound({
    flowLogArgs,
    secondsCap: parsed.seconds,
    eventsCap: parsed.events,
    mode: "follow",
    idForFooter: id,
    spawn: deps.spawn,
    stdout: deps.stdout,
    stderr: deps.stderr,
  });
}

async function runTail(
  id: string,
  parsed: ParsedArgs,
  deps: MainDeps,
): Promise<number> {
  const flowLogArgs = ["log", id];
  if (parsed.phase) flowLogArgs.push("--phase", parsed.phase);
  return runWithBound({
    flowLogArgs,
    secondsCap: parsed.seconds,
    eventsCap: parsed.events,
    mode: "tail",
    idForFooter: id,
    spawn: deps.spawn,
    stdout: deps.stdout,
    stderr: deps.stderr,
  });
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
