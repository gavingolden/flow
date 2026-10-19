/**
 * Orphaned-agy selector and stop sweep behind `flow reap`'s "agy runs"
 * stray class. A stray is an `agy` process whose parent is pid 1 (its
 * caller is gone) and whose full command line carries flow's own delegate
 * prompt preamble, so a user's interactive agy is never matched.
 *
 * Unlike the browser/MCP stray sweep (SIGTERM only, no identity re-check),
 * agy hangs on a polite stop, so this sweep escalates to SIGKILL — but only
 * after re-reading the pid's start time before EACH signal, and only for
 * runs already past their own time limit. A run that leads its own process
 * group (the guard always starts agy detached) is signalled as that whole
 * group so its forked helpers stop too. No command text is ever placed
 * in a result: the command line carries the full prompt.
 *
 * `startEpochMs` is MILLISECONDS (the field name carries the unit);
 * `pidStartEpoch` returns SECONDS and is scaled once in the default deps.
 */

import { DEADLINE_GRACE_MS } from "./agy-guard";
import { godurToSec, isGoDuration } from "./delegate-timeouts";
import { pidStartEpoch } from "./liveness";
import { GRACE_MS, KILL_WAIT_MS } from "./reap";
import { sleepSync } from "./sleep";

// Must stay inside AGY_SAFETY_PREAMBLE (bin/flow-delegate.ts); a test pins it.
export const FLOW_DELEGATE_PROMPT_MARKER =
  "You are a delegated, non-interactive agent";

// -ww: no width limit, so the preamble deep in the prompt is never cut off.
export const AGY_PS_ARGS = ["-ww", "-Ao", "pid,ppid,pgid,command"] as const;

const FALLBACK_TIME_LIMIT_SEC = 3600;
const POLL_STEP_MS = 250;

export type AgyProcRow = {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
};

export type AgyStray = {
  pid: number;
  pgid: number;
  startEpochMs: number;
  ageMs: number;
  timeLimitSec: number;
  overdue: boolean;
};

export type AgyStraySweepResult = {
  ran: boolean;
  skipReason?: "ps-unavailable";
  found: AgyStray[];
  signalled: number[];
  killed: number[];
  stillAlive: number[];
};

function parsePs(text: string): AgyProcRow[] {
  const out: AgyProcRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) {
      out.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        pgid: Number(m[3]),
        command: m[4],
      });
    } else if (out.length > 0 && line.trim() !== "") {
      // A prompt with a literal newline spills onto following lines.
      out[out.length - 1].command += `\n${line}`;
    }
  }
  return out;
}

function defaultSpawnPs(args: readonly string[]): string | null {
  const r = Bun.spawnSync(["ps", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LC_ALL: "C" },
  });
  return r.exitCode === 0 ? r.stdout.toString() : null;
}

/** Undefined when `ps` is unavailable — including `Bun` being undefined under vitest/Node. */
export function listAgyProcs(
  spawnPs: (args: readonly string[]) => string | null = defaultSpawnPs,
): AgyProcRow[] | undefined {
  try {
    const text = spawnPs(AGY_PS_ARGS);
    return text === null ? undefined : parsePs(text);
  } catch {
    return undefined;
  }
}

function isAgyCommand(command: string): boolean {
  const first = command.trimStart().split(/\s+/, 1)[0] ?? "";
  const base = first.slice(first.lastIndexOf("/") + 1);
  return base === "agy" && command.includes(FLOW_DELEGATE_PROMPT_MARKER);
}

function timeLimitSecOf(command: string): number {
  const m = /--print-timeout\s+(\S+)/.exec(command);
  const dur = m?.[1];
  return dur !== undefined && isGoDuration(dur)
    ? godurToSec(dur)
    : FALLBACK_TIME_LIMIT_SEC;
}

export function selectAgyStrays(
  procs: AgyProcRow[],
  opts: {
    nowMs: number;
    startEpochMsOf: (pid: number) => number | undefined;
  },
): AgyStray[] {
  const out: AgyStray[] = [];
  for (const p of procs) {
    if (p.ppid !== 1 || !isAgyCommand(p.command)) continue;
    const startEpochMs = opts.startEpochMsOf(p.pid);
    if (startEpochMs === undefined) continue;
    const timeLimitSec = timeLimitSecOf(p.command);
    const ageMs = opts.nowMs - startEpochMs;
    out.push({
      pid: p.pid,
      pgid: p.pgid,
      startEpochMs,
      ageMs,
      timeLimitSec,
      overdue: ageMs > timeLimitSec * 1000 + DEADLINE_GRACE_MS,
    });
  }
  return out;
}

export type AgySweepDeps = {
  listProcs: () => AgyProcRow[] | undefined;
  kill: (pid: number, sig: NodeJS.Signals) => void;
  alive: (pid: number) => boolean;
  sleepMs: (ms: number) => void;
  nowMs: () => number;
  startEpochMsOf: (pid: number) => number | undefined;
};

export function sweepAgyStrays(
  deps: AgySweepDeps,
  opts: { yes: boolean },
): AgyStraySweepResult {
  const procs = deps.listProcs();
  if (procs === undefined) {
    return {
      ran: false,
      skipReason: "ps-unavailable",
      found: [],
      signalled: [],
      killed: [],
      stillAlive: [],
    };
  }
  const found = selectAgyStrays(procs, {
    nowMs: deps.nowMs(),
    startEpochMsOf: deps.startEpochMsOf,
  });
  const result: AgyStraySweepResult = {
    ran: true,
    found,
    signalled: [],
    killed: [],
    stillAlive: [],
  };
  if (!opts.yes) return result;

  const send = (pid: number, sig: NodeJS.Signals): boolean => {
    try {
      deps.kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  };
  // The guard starts agy detached, so its pgid is its pid; signalling the
  // group also stops the helpers agy forked. A non-leader gets the bare pid.
  const isGroupLeader = (s: AgyStray): boolean => s.pgid === s.pid && s.pid > 1;
  const targetOf = (s: AgyStray): number => (isGroupLeader(s) ? -s.pid : s.pid);
  const targetAlive = (s: AgyStray): boolean => deps.alive(targetOf(s));
  // A pid cannot be recycled while its process group still has members, so a
  // vanished leader with a live group is still the same run.
  const unchanged = (s: AgyStray): boolean => {
    const now = deps.startEpochMsOf(s.pid);
    if (now === s.startEpochMs) return true;
    return now === undefined && isGroupLeader(s) && targetAlive(s);
  };
  const waitUntilGone = (strays: AgyStray[], budgetMs: number): void => {
    for (
      let waited = 0;
      waited < budgetMs && strays.some(targetAlive);
      waited += POLL_STEP_MS
    ) {
      deps.sleepMs(POLL_STEP_MS);
    }
  };

  const overdue = found.filter((s) => s.overdue);
  const termed = overdue.filter(
    (s) => unchanged(s) && send(targetOf(s), "SIGTERM"),
  );
  result.signalled = termed.map((s) => s.pid);
  waitUntilGone(termed, GRACE_MS);

  const survivors = termed.filter(targetAlive);
  const killed = survivors.filter(
    (s) => unchanged(s) && send(targetOf(s), "SIGKILL"),
  );
  result.killed = killed.map((s) => s.pid);
  waitUntilGone(killed, KILL_WAIT_MS);
  result.stillAlive = killed.filter(targetAlive).map((s) => s.pid);
  return result;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function defaultAgySweepDeps(): AgySweepDeps {
  return {
    listProcs: () => listAgyProcs(),
    kill: (pid, sig) => process.kill(pid, sig),
    alive: isAlive,
    sleepMs: sleepSync,
    nowMs: () => Date.now(),
    startEpochMsOf: (pid) => {
      const epoch = pidStartEpoch(pid);
      return epoch === null ? undefined : epoch * 1000;
    },
  };
}

export function renderAgyStrayLine(result: AgyStraySweepResult): string {
  if (!result.ran) return "  (ps unavailable — agy sweep did not run)";
  const overdue = result.found.filter((s) => s.overdue).length;
  const stopped = result.signalled.filter(
    (p) => !result.stillAlive.includes(p),
  ).length;
  return `  agy runs: ${result.found.length} found (${overdue} past their own time limit), ${stopped} stopped`;
}
