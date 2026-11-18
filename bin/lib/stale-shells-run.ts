/**
 * Sweep engine for Claude Code tool shells that only watch closed pipelines:
 * one process-table read, selection via `stale-shells.ts`, then SIGTERM ->
 * grace -> start-time re-check -> SIGKILL, bounded by a deadline.
 *
 * Unlike `sweepWorktreeOrphans` (positive pids only: its groups lost their
 * leader), this engine signals `-pgid`: each Claude tool shell is its own live
 * session and group leader, so its `sleep`/`curl` children share the group and
 * only a group signal stops them. The leader's start time is re-checked before
 * every signal so a recycled pid is never hit. Do not unify the two policies.
 */

import * as os from "node:os";
import { pidStartEpoch } from "./liveness";
import { readRows } from "./proc-registry";
import { listRegistrySlugs } from "./proc-sweep";
import { GRACE_MS, KILL_WAIT_MS } from "./reap";
import { sleepSync } from "./sleep";
import {
  ancestryOf,
  forPipelines,
  selectStaleShells,
  type StaleShell,
  type StaleTarget,
} from "./stale-shells";
import { flowStateDir } from "./paths";
import { paneWindowsByPid } from "./tmux";
import { isAlive } from "./worktree-orphans-run";
import { listOrphanProcs } from "./worktree-orphans-ps";
import type { OrphanProc } from "./worktree-orphans";

const POLL_STEP_MS = 250;
export const STALE_SHELL_DEADLINE_MS = 15_000;
export const STALE_SHELL_MIN_AGE_SEC = 60;

export type PaneWindow = { id: string; name: string };

export type StaleShellDeps = {
  listProcs: () => OrphanProc[] | undefined;
  registeredPids: () => Set<number>;
  startEpochOf: (pid: number) => number | null;
  killGroup: (pgid: number, sig: NodeJS.Signals) => void;
  alive: (pid: number) => boolean;
  sleepMs: (ms: number) => void;
  nowMs: () => number;
  paneWindows: () => Map<number, PaneWindow>;
  selfPid: number;
  selfUid: number;
  home: string;
  stateDir: string;
};

export type StaleShellSweepResult = {
  ran: boolean;
  skipReason?: "ps-unavailable";
  act: boolean;
  found: StaleShell[];
  /** The tmux window hosting each found shell's live owner session, by shell pid. */
  windows: Record<number, PaneWindow>;
  signalled: number[];
  killed: number[];
  stillAlive: number[];
  skippedRecycled: number[];
};

function emptyResult(
  act: boolean,
  ran: boolean,
  skipReason?: "ps-unavailable",
): StaleShellSweepResult {
  return {
    ran,
    ...(skipReason ? { skipReason } : {}),
    act,
    found: [],
    windows: {},
    signalled: [],
    killed: [],
    stillAlive: [],
    skippedRecycled: [],
  };
}

function resolveWindows(
  found: StaleShell[],
  procs: OrphanProc[],
  deps: StaleShellDeps,
): Record<number, PaneWindow> {
  const live = found.filter((s) => s.ownerAlive);
  if (live.length === 0) return {};
  const panes = deps.paneWindows();
  if (panes.size === 0) return {};
  const out: Record<number, PaneWindow> = {};
  for (const s of live) {
    for (const pid of ancestryOf(s.ownerPid, procs)) {
      const w = panes.get(pid);
      if (w) {
        out[s.pid] = w;
        break;
      }
    }
  }
  return out;
}

export function sweepStaleShells(
  deps: StaleShellDeps,
  opts: {
    act: boolean;
    targets: StaleTarget[];
    minAgeSec?: number;
    deadlineMs?: number;
  },
): StaleShellSweepResult {
  const procs = deps.listProcs();
  if (procs === undefined)
    return emptyResult(opts.act, false, "ps-unavailable");
  const result = emptyResult(opts.act, true);
  if (opts.targets.length === 0) return result;
  const exclude = new Set([
    ...ancestryOf(deps.selfPid, procs),
    ...deps.registeredPids(),
  ]);
  result.found = selectStaleShells(procs, {
    selfUid: deps.selfUid,
    exclude,
    minAgeSec: opts.minAgeSec ?? STALE_SHELL_MIN_AGE_SEC,
    home: deps.home,
    stateDir: deps.stateDir,
    matches: forPipelines(opts.targets, deps.stateDir),
  });
  if (result.found.length === 0) return result;
  result.windows = resolveWindows(result.found, procs, deps);
  if (!opts.act) return result;

  const deadlineAt =
    deps.nowMs() + (opts.deadlineMs ?? STALE_SHELL_DEADLINE_MS);
  // A leader whose start time cannot be read cannot be verified, so it is
  // never signalled.
  const started = new Map<number, number | null>();
  for (const s of result.found) {
    if (deps.nowMs() >= deadlineAt) break;
    started.set(s.pgid, deps.startEpochOf(s.pgid));
  }
  const unchanged = (pgid: number): boolean => {
    const was = started.get(pgid);
    return was !== null && was !== undefined && deps.startEpochOf(pgid) === was;
  };
  const send = (pgid: number, sig: NodeJS.Signals): boolean => {
    if (!unchanged(pgid)) {
      result.skippedRecycled.push(pgid);
      return false;
    }
    try {
      deps.killGroup(pgid, sig);
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

  const termed = result.found
    .map((s) => s.pgid)
    .filter(
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
  result.stillAlive = survivors.filter(
    (p) => deps.alive(p) && !result.skippedRecycled.includes(p),
  );
  return result;
}

export function staleShellsStopped(r: StaleShellSweepResult): number {
  return r.signalled.filter((p) => !r.stillAlive.includes(p)).length;
}

function formatAge(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400)
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** One listing line per shell found; empty when nothing was found. */
export function renderStaleShellLines(r: StaleShellSweepResult): string[] {
  return r.found.map((s) => {
    const w = r.windows[s.pid];
    const owner = s.ownerAlive
      ? `live session ${s.ownerPid}${w ? ` in tmux window ${w.name} (${w.id})` : ""}`
      : "owner gone";
    const verb = !r.act
      ? "would stop"
      : r.stillAlive.includes(s.pgid)
        ? "could not stop"
        : r.skippedRecycled.includes(s.pgid) || !r.signalled.includes(s.pgid)
          ? "skipped"
          : "stopped";
    const watched = s.refs.map((ref) => ref.path).join(", ");
    return `${verb} background shell ${s.pid} (${owner}, ${formatAge(s.ageSec)}) — watched ${watched} (pipeline closed): ${s.preview}`;
  });
}

export function defaultStaleShellDeps(
  opts: { stateDir?: string; home?: string } = {},
): StaleShellDeps {
  const stateDir = opts.stateDir ?? flowStateDir();
  return {
    listProcs: listOrphanProcs,
    registeredPids: () => {
      const pids = new Set<number>();
      for (const slug of listRegistrySlugs()) {
        for (const row of readRows(slug).rows) pids.add(row.pid);
      }
      return pids;
    },
    startEpochOf: (pid) => pidStartEpoch(pid),
    killGroup: (pgid, sig) => process.kill(-pgid, sig),
    alive: isAlive,
    sleepMs: sleepSync,
    nowMs: () => Date.now(),
    paneWindows: paneWindowsByPid,
    selfPid: process.pid,
    selfUid: process.getuid?.() ?? -1,
    home: opts.home ?? os.homedir(),
    stateDir,
  };
}
