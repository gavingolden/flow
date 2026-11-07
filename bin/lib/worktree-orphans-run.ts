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
  ownerOf,
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

  const { cands, toRead } = candidatesToRead(procs, deps, opts.busyOnly);
  if (toRead.length === 0) return result;
  const all = [...new Set([...deps.worktrees(), worktree])];
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
  // Each read forks `ps`; past the deadline the rest are left unread, which
  // makes them unverifiable and so never signalled.
  const started = new Map<number, number | null>();
  for (const p of targets) {
    if (deps.nowMs() >= deadlineAt) break;
    started.set(p, deps.startEpochOf(p));
  }
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

  const termed = targets.filter(
    (p) => deps.nowMs() < deadlineAt && deps.alive(p) && send(p, "SIGTERM"),
  );
  result.signalled = termed;
  waitUntilGone(termed, GRACE_MS);

  const survivors = termed.filter(deps.alive);
  if (deps.nowMs() >= deadlineAt) {
    result.stillAlive = survivors;
    return result;
  }
  result.killed = survivors.filter((p) => send(p, "SIGKILL"));
  waitUntilGone(result.killed, KILL_WAIT_MS);
  // A recycled pid is a different process, not a survivor of ours.
  result.stillAlive = survivors.filter(
    (p) => deps.alive(p) && !result.skippedRecycled.includes(p),
  );
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
        ownerOf(c.cwd, wts) === null,
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

/**
 * `baseDir` roots the process registries, `stateDir` the pipeline states;
 * both default to the same production directory.
 */
export function defaultOrphanSweepDeps(opts?: {
  stateDir?: string;
  baseDir?: string;
}): OrphanSweepDeps {
  return {
    listProcs: listOrphanProcs,
    cwdOf: readCwds,
    registered: () => {
      const pids = new Set<number>();
      const pgids = new Set<number>();
      for (const slug of listRegistrySlugs(opts?.baseDir)) {
        for (const row of readRows(slug, opts?.baseDir).rows) {
          pids.add(row.pid);
          pgids.add(row.pgid);
        }
      }
      return { pids, pgids };
    },
    worktrees: () =>
      listStates(opts?.stateDir).flatMap((s) =>
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

/**
 * Reads the process table, registries and pipeline states, and each pid's cwd,
 * at most once across every sweep that shares the result. Signalling still
 * re-checks liveness and start time live, so a stale table cannot widen what
 * is signalled.
 */
export function snapshotOrphanDeps(deps: OrphanSweepDeps): OrphanSweepDeps {
  let procs: { v: OrphanProc[] | undefined } | undefined;
  let reg: ReturnType<OrphanSweepDeps["registered"]> | undefined;
  let wts: string[] | undefined;
  const cwds = new Map<number, string>();
  const asked = new Set<number>();
  return {
    ...deps,
    listProcs: () => (procs ??= { v: deps.listProcs() }).v,
    registered: () => (reg ??= deps.registered()),
    worktrees: () => (wts ??= deps.worktrees()),
    cwdOf: (pids) => {
      const missing = pids.filter((p) => !asked.has(p));
      if (missing.length > 0) {
        for (const p of missing) asked.add(p);
        for (const [pid, cwd] of deps.cwdOf(missing)) cwds.set(pid, cwd);
      }
      return new Map(
        pids.flatMap((p) => (cwds.has(p) ? [[p, cwds.get(p) as string]] : [])),
      );
    },
  };
}

/** The mid-run sweep both the Stop and PostToolUse hooks run: act, busy only. */
export function sweepBusyLeftovers(
  worktree: string,
  deps: OrphanSweepDeps = defaultOrphanSweepDeps(),
): WorktreeOrphanSweepResult {
  return sweepWorktreeOrphans(deps, { worktree, act: true, busyOnly: true });
}

export function renderOrphanSweepLine(
  r: WorktreeOrphanSweepResult,
  opts: { held?: boolean } = {},
): string {
  if (!r.ran) return `leftover processes: sweep did not run (${r.skipReason})`;
  const busy = r.found.filter((o) => o.busy).length;
  if (!r.act) {
    return `leftover processes: ${r.found.length} found (${busy} busy)${opts.held ? "" : ", would stop"}`;
  }
  const survivors = r.stillAlive.length
    ? `, ${r.stillAlive.length} still alive`
    : "";
  return `leftover processes: ${r.found.length} found (${busy} busy), ${stoppedCount(r)} stopped${survivors}`;
}

export const ORPHAN_GUIDANCE =
  "A background job you poll should use the Bash tool's run_in_background (a server: flow-spawn --detach) so it is not left orphaned.";

/**
 * The one-line notice both in-run sweeps hand the agent, or null when nothing
 * was stopped. Names the first commands so the agent knows what to restart.
 */
export function orphanNotice(
  r: WorktreeOrphanSweepResult | null,
  opts: { guidance?: string } = {},
): string | null {
  if (!r) return null;
  const n = stoppedCount(r);
  if (n === 0) return null;
  const oldest = Math.max(1, ...r.found.map((o) => o.ageSec));
  const names = [
    ...new Set(
      r.found.filter((o) => r.signalled.includes(o.pid)).map((o) => o.command0),
    ),
  ];
  const shown = names.slice(0, 3).join(", ");
  const named = shown
    ? ` (${shown}${names.length > 3 ? ", …" : ""}; busy, oldest ${Math.round(oldest / 60) || 1} min)`
    : ` (busy, oldest ${Math.round(oldest / 60) || 1} min)`;
  const stuck = r.stillAlive.length
    ? ` ${r.stillAlive.length} did not exit.`
    : "";
  const guidance = opts.guidance ? ` ${opts.guidance}` : "";
  return `flow stopped ${n} leftover process${n === 1 ? "" : "es"} from this pipeline's worktree${named} — they had outlived the command that started them.${stuck}${guidance}`;
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
