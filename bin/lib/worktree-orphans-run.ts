/**
 * Sweep engine for leftover processes in a pipeline's worktree: reads the
 * process table, selects with `worktree-orphans.ts`, then SIGTERM -> grace ->
 * start-time re-check -> SIGKILL, bounded by a deadline. Shaped like
 * `sweepAgyStrays` (`agy-strays.ts`). Signals go to positive pids only, never
 * a group: the group belongs to the dead tool shell.
 */

import { pidStartEpoch } from "./liveness";
import { readRows } from "./proc-registry";
import { listRegistrySlugs } from "./proc-sweep";
import { GRACE_MS, KILL_WAIT_MS } from "./reap";
import { sleepSync } from "./sleep";
import { listStates, readState, writeState } from "./state";
import {
  canonicalizeWorktree,
  listOrphanProcs,
  readCwds,
} from "./worktree-orphans-ps";
import {
  commandZero,
  groupStats,
  prefilterCandidates,
  selectWorktreeOrphans,
  type OrphanProc,
  type OwnedOrphan,
} from "./worktree-orphans";

const POLL_STEP_MS = 250;
export const ORPHAN_SWEEP_DEADLINE_MS = 15_000;

export type OrphanSweepDeps = {
  listProcs: () => OrphanProc[] | undefined;
  cwdOf: (pids: number[]) => Map<number, string>;
  registered: () => { pids: Set<number>; pgids: Set<number> };
  worktrees: () => string[];
  startEpochOf: (pid: number) => number | null;
  kill: (pid: number, sig: NodeJS.Signals) => void;
  alive: (pid: number) => boolean;
  sleepMs: (ms: number) => void;
  nowMs: () => number;
  selfUid: number;
};

export type WorktreeOrphanSweepResult = {
  ran: boolean;
  skipReason?: "no-worktree" | "ps-unavailable";
  act: boolean;
  busyOnly: boolean;
  found: OwnedOrphan[];
  signalled: number[];
  killed: number[];
  stillAlive: number[];
  skippedRecycled: number[];
};

function emptyResult(
  opts: { act: boolean; busyOnly: boolean },
  ran: boolean,
  skipReason?: "no-worktree" | "ps-unavailable",
): WorktreeOrphanSweepResult {
  return {
    ran,
    ...(skipReason ? { skipReason } : {}),
    act: opts.act,
    busyOnly: opts.busyOnly,
    found: [],
    signalled: [],
    killed: [],
    stillAlive: [],
    skippedRecycled: [],
  };
}

export function stoppedCount(r: WorktreeOrphanSweepResult): number {
  return r.signalled.filter((p) => !r.stillAlive.includes(p)).length;
}

/** Candidates (cwd unread) whose group is busy, or all when not busy-only. */
function candidatesToRead(
  procs: OrphanProc[],
  deps: OrphanSweepDeps,
  busyOnly: boolean,
): { cands: OrphanProc[]; toRead: OrphanProc[] } {
  const reg = deps.registered();
  const cands = prefilterCandidates(procs, {
    selfUid: deps.selfUid,
    registeredPids: reg.pids,
    registeredPgids: reg.pgids,
    busyOnly,
  });
  if (!busyOnly) return { cands, toRead: cands };
  const stats = groupStats(cands, procs);
  return {
    cands,
    toRead: cands.filter((c) => stats.get(c.pgid)?.busy === true),
  };
}

function withCwds(
  cands: OrphanProc[],
  toRead: OrphanProc[],
  deps: OrphanSweepDeps,
): OrphanProc[] {
  if (toRead.length === 0) return cands;
  const cwds = deps.cwdOf(toRead.map((p) => p.pid));
  return cands.map((c) => ({ ...c, cwd: cwds.get(c.pid) ?? null }));
}

export function sweepWorktreeOrphans(
  deps: OrphanSweepDeps,
  opts: {
    worktree: string;
    act: boolean;
    busyOnly: boolean;
    deadlineMs?: number;
  },
): WorktreeOrphanSweepResult {
  if (!opts.worktree) return emptyResult(opts, false, "no-worktree");
  const procs = deps.listProcs();
  if (procs === undefined) return emptyResult(opts, false, "ps-unavailable");
  const result = emptyResult(opts, true);
  const worktree = canonicalizeWorktree(opts.worktree);
  const all = [...new Set([...deps.worktrees(), worktree])];

  const { cands, toRead } = candidatesToRead(procs, deps, opts.busyOnly);
  if (toRead.length === 0) return result;
  const owned = selectWorktreeOrphans(withCwds(cands, toRead, deps), procs, {
    worktree,
    allWorktrees: all,
  });
  result.found = opts.busyOnly ? owned.filter((o) => o.busy) : owned;
  if (!opts.act || result.found.length === 0) return result;

  const deadlineAt =
    deps.nowMs() + (opts.deadlineMs ?? ORPHAN_SWEEP_DEADLINE_MS);
  const targets = [
    ...new Set(result.found.flatMap((o) => [o.pid, ...o.descendants])),
  ];
  const started = new Map<number, number | null>(
    targets.map((p) => [p, deps.startEpochOf(p)]),
  );
  // A pid whose start time could not be read at selection cannot be verified.
  const unchanged = (pid: number): boolean => {
    const was = started.get(pid);
    return was !== null && was !== undefined && deps.startEpochOf(pid) === was;
  };
  const send = (pid: number, sig: NodeJS.Signals): boolean => {
    if (!unchanged(pid)) {
      result.skippedRecycled.push(pid);
      return false;
    }
    try {
      deps.kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  };
  const waitUntilGone = (pids: number[], budgetMs: number): void => {
    for (
      let waited = 0;
      waited < budgetMs && deps.nowMs() < deadlineAt && pids.some(deps.alive);
      waited += POLL_STEP_MS
    ) {
      deps.sleepMs(POLL_STEP_MS);
    }
  };

  const termed = targets.filter((p) => deps.alive(p) && send(p, "SIGTERM"));
  result.signalled = termed;
  waitUntilGone(termed, GRACE_MS);

  const survivors = termed.filter(deps.alive);
  if (deps.nowMs() >= deadlineAt) {
    result.stillAlive = survivors;
    return result;
  }
  result.killed = survivors.filter((p) => send(p, "SIGKILL"));
  waitUntilGone(result.killed, KILL_WAIT_MS);
  result.stillAlive = survivors.filter(deps.alive);
  return result;
}

export type OutsideOrphan = {
  pid: number;
  command0: string;
  ageSec: number;
  groupCpuRatio: number;
};

/** Busy leaderless groups outside every pipeline worktree. Report-only. */
export function findBusyOutsideWorktrees(
  deps: OrphanSweepDeps,
): OutsideOrphan[] {
  const procs = deps.listProcs();
  if (procs === undefined) return [];
  const { cands, toRead } = candidatesToRead(procs, deps, true);
  if (toRead.length === 0) return [];
  const wts = deps.worktrees();
  const stats = groupStats(cands, procs);
  return withCwds(cands, toRead, deps)
    .filter(
      (c) =>
        c.cwd !== null &&
        stats.get(c.pgid)?.busy === true &&
        !wts.some((w) => c.cwd === w || c.cwd?.startsWith(`${w}/`)),
    )
    .map((c) => ({
      pid: c.pid,
      command0: commandZero(c.command),
      ageSec: c.ageSec,
      groupCpuRatio: stats.get(c.pgid)?.ratio ?? 0,
    }));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function defaultOrphanSweepDeps(opts?: {
  stateDir?: string;
  baseDir?: string;
}): OrphanSweepDeps {
  const dir = opts?.stateDir ?? opts?.baseDir;
  return {
    listProcs: listOrphanProcs,
    cwdOf: readCwds,
    registered: () => {
      const pids = new Set<number>();
      const pgids = new Set<number>();
      for (const slug of listRegistrySlugs(dir)) {
        for (const row of readRows(slug, dir).rows) {
          pids.add(row.pid);
          pgids.add(row.pgid);
        }
      }
      return { pids, pgids };
    },
    worktrees: () =>
      listStates(dir).flatMap((s) =>
        s.worktree ? [canonicalizeWorktree(s.worktree)] : [],
      ),
    startEpochOf: (pid) => pidStartEpoch(pid),
    kill: (pid, sig) => process.kill(pid, sig),
    alive: isAlive,
    sleepMs: sleepSync,
    nowMs: () => Date.now(),
    selfUid: process.getuid?.() ?? -1,
  };
}

export function renderOrphanSweepLine(r: WorktreeOrphanSweepResult): string {
  if (!r.ran) return `leftover processes: sweep did not run (${r.skipReason})`;
  const busy = r.found.filter((o) => o.busy).length;
  if (!r.act) {
    return `leftover processes: ${r.found.length} found (${busy} busy), would stop`;
  }
  const survivors = r.stillAlive.length
    ? `, ${r.stillAlive.length} still alive`
    : "";
  return `leftover processes: ${r.found.length} found (${busy} busy), ${stoppedCount(r)} stopped${survivors}`;
}

/** Adds to the slug's OWN running count; never touches another state file. */
export function recordOrphanStops(
  slug: string,
  stopped: number,
  deps: { stateDir?: string; nowMs?: () => number } = {},
): void {
  if (stopped <= 0) return;
  const state = readState(slug, deps.stateDir);
  if (!state) return;
  writeState(
    {
      ...state,
      orphanStops: {
        count: (state.orphanStops?.count ?? 0) + stopped,
        lastAt: new Date((deps.nowMs ?? Date.now)()).toISOString(),
      },
    },
    deps.stateDir,
  );
}
