/**
 * The bounded generic waiter behind `flow-wait`: argument parsing, the
 * ordered per-tick checks, and the owning-`claude` lookup. All I/O arrives via
 * `GenericWaitDeps`, so the loop is unit-testable with a fake clock.
 */

import * as path from "node:path";
import { TERMINAL_PHASES } from "./state";
import type { OrphanProc } from "./worktree-orphans";

export const WAIT_MAX_SEC_CAP = 28800;
const DEFAULT_EVERY_SEC = 15;
/** A state file that has never been seen gets this long to appear. */
export const STATE_CREATION_GRACE_MS = 30_000;

export type GenericWaitArgs = {
  maxSec: number;
  everySec: number;
  slug?: string;
  phases?: string[];
  window?: string;
  condition?: string[];
};

export type WaitOutcome =
  | "met"
  | "timeout"
  | "state-gone"
  | "window-gone"
  | "phase-terminal"
  | "parent-gone";

export const EXIT_CODES: Record<WaitOutcome, number> = {
  met: 0,
  timeout: 3,
  "state-gone": 4,
  "window-gone": 5,
  "phase-terminal": 6,
  "parent-gone": 7,
};

export type WaitResult = {
  outcome: WaitOutcome;
  elapsedSec: number;
  phase?: string;
};

export type GenericWaitDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** `exists: false` means the state file is absent; `phase` may be unreadable. */
  readState: (slug: string) => { exists: boolean; phase?: string };
  /** True only when the window is known to be gone (never when tmux is absent). */
  windowGone: (id: string) => boolean;
  /** Runs the condition; true when it exited 0 within its per-check timeout. */
  runCondition: (condition: string[]) => Promise<boolean>;
  /** True when the recorded owner (or the PID-1 fallback) says we are orphaned. */
  parentGone: () => boolean;
};

export const WAIT_USAGE =
  "usage: flow-wait --max-sec <1-28800> [--every <s=15>] [--state <slug> [--phase <p>[,<p>…]]] [--window @<id>] [-- <condition command…>]";

function positiveInt(name: string, value: string | undefined): number | string {
  if (value === undefined) return `${name} requires a value`;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== value) {
    return `${name} must be a positive integer, got '${value}'`;
  }
  return n;
}

export function parseWaitArgs(
  argv: string[],
): GenericWaitArgs | { error: string } {
  if (argv.includes("--help") || argv.includes("-h")) return { error: "help" };
  const sep = argv.indexOf("--");
  const flags = sep === -1 ? argv : argv.slice(0, sep);
  const condition = sep === -1 ? [] : argv.slice(sep + 1);
  const out: GenericWaitArgs = { maxSec: 0, everySec: DEFAULT_EVERY_SEC };
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i];
    const value = flags[i + 1];
    if (flag === "--max-sec" || flag === "--every") {
      const n = positiveInt(flag, value);
      if (typeof n === "string") return { error: n };
      if (flag === "--max-sec") out.maxSec = n;
      else out.everySec = n;
    } else if (flag === "--state") {
      if (!value) return { error: "--state requires a slug" };
      out.slug = value;
    } else if (flag === "--phase") {
      if (!value) return { error: "--phase requires a value" };
      out.phases = value.split(",").filter(Boolean);
    } else if (flag === "--window") {
      if (!value || !/^@\d+$/.test(value)) {
        return {
          error: `--window must be a tmux window id like @7, got '${value ?? ""}'`,
        };
      }
      out.window = value;
    } else {
      return { error: `unknown flag: ${flag}` };
    }
  }
  if (out.maxSec === 0) return { error: "--max-sec is required" };
  if (out.maxSec > WAIT_MAX_SEC_CAP) {
    return { error: `--max-sec must be at most ${WAIT_MAX_SEC_CAP}` };
  }
  if (out.phases && !out.slug)
    return { error: "--phase requires --state <slug>" };
  if (out.phases?.length === 0) return { error: "--phase requires a value" };
  if (sep !== -1 && condition.length === 0) {
    return { error: "-- must be followed by a condition command" };
  }
  if (condition.length > 0) out.condition = condition;
  if (!out.phases && !out.condition) {
    return {
      error: "give --phase (with --state) or a condition command after --",
    };
  }
  return out;
}

/**
 * The nearest `claude` ancestor of `selfPid` and its start time. The Claude
 * Code `zsh` wrapper stays alive as the waiter's parent when `claude` is
 * SIGKILLed, so `ppid === 1` alone never fires; the recorded `claude` does.
 * Null when no ancestor's argv[0] is `claude` (the PID-1 rule applies then).
 */
export function owningClaude(
  selfPid: number,
  procs: OrphanProc[],
  startEpochOf: (pid: number) => number | null = () => null,
): { pid: number; startEpoch: number | null } | null {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const seen = new Set<number>();
  for (
    let p = byPid.get(selfPid);
    p && !seen.has(p.pid);
    p = byPid.get(p.ppid)
  ) {
    seen.add(p.pid);
    if (p.pid === selfPid) continue;
    const argv0 = p.command.trimStart().split(/\s+/, 1)[0] ?? "";
    if (path.basename(argv0) === "claude") {
      return { pid: p.pid, startEpoch: startEpochOf(p.pid) };
    }
  }
  return null;
}

/**
 * True when the process that owns a wait is gone: the recorded `claude` died
 * or was replaced by a recycled pid, or (with no `claude` ancestor) the
 * waiter was re-parented to PID 1. An unreadable start time is unknown, not
 * changed, so a single failed `ps` never ends a wait.
 */
export function ownerGone(
  owner: { pid: number; startEpoch: number | null } | null,
  deps: {
    alive: (pid: number) => boolean;
    startEpochOf: (pid: number) => number | null;
    parentPid: () => number | null;
  },
): boolean {
  if (owner === null) return deps.parentPid() === 1;
  if (!deps.alive(owner.pid)) return true;
  if (owner.startEpoch === null) return false;
  const now = deps.startEpochOf(owner.pid);
  return now !== null && now !== owner.startEpoch;
}

export async function runWait(
  args: GenericWaitArgs,
  deps: GenericWaitDeps,
): Promise<WaitResult> {
  const start = deps.now();
  const deadline = start + args.maxSec * 1000;
  const elapsed = (): number => Math.round((deps.now() - start) / 1000);
  let seenState = false;
  const done = (outcome: WaitOutcome, phase?: string): WaitResult => ({
    outcome,
    elapsedSec: elapsed(),
    ...(phase !== undefined ? { phase } : {}),
  });

  for (;;) {
    if (deps.parentGone()) return done("parent-gone");

    let phase: string | undefined;
    if (args.slug) {
      const st = deps.readState(args.slug);
      if (st.exists) {
        seenState = true;
        phase = st.phase;
      } else if (seenState || deps.now() - start >= STATE_CREATION_GRACE_MS) {
        return done("state-gone");
      }
    }
    if (args.window && deps.windowGone(args.window)) return done("window-gone");

    if (phase !== undefined && args.phases?.includes(phase)) {
      return done("met", phase);
    }
    if (args.condition && (await deps.runCondition(args.condition))) {
      return done("met", phase);
    }
    if (
      phase !== undefined &&
      (TERMINAL_PHASES as readonly string[]).includes(phase)
    ) {
      return done("phase-terminal", phase);
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) return done("timeout", phase);
    await deps.sleep(Math.min(args.everySec * 1000, remaining));
  }
}
