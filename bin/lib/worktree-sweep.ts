/**
 * One run of the worktree sweep: lock, (auto) throttle, discover repos,
 * gather facts, decide, and (with `act`) remove finished folders and leftover
 * folders one at a time, logging each removal BEFORE it runs. Only an acted
 * run is recorded for `flow doctor`: a preview, or a disabled/throttled/locked
 * run, leaves the last real result in place. Touches pipeline records only
 * through flow-remove-worktree's guarded finished-record cleanup.
 */

import * as fs from "node:fs";
import { LockTimeoutError, withFileLockSync } from "./lock";
import { actOn } from "./worktree-sweep-act";
import { discoverFlowRepos, gatherWorktreeFacts } from "./worktree-sweep-facts";
import { gatherHuskFacts } from "./worktree-sweep-husks";
import { decideHusk, decideWorktree } from "./worktree-sweep-rules";
import {
  isAutoSweepEnabled,
  lockPath,
  stampAgeMs,
  writeLastSweep,
  writeStamp,
  WORKTREE_SWEEP_DEADLINE_MS,
  WORKTREE_SWEEP_GH_BACKOFF_MS,
  WORKTREE_SWEEP_THROTTLE_MS,
  type SweepDeps,
  type SweepItem,
  type SweepResult,
} from "./worktree-sweep-state";
import {
  buildUsageIndex,
  danglingContainerMounts,
} from "./worktree-sweep-usage";

function emptyResult(deps: SweepDeps, act: boolean): SweepResult {
  return {
    mode: "worktrees",
    at: new Date(deps.nowMs()).toISOString(),
    acted: act,
    items: [],
    danglingMounts: [],
    deadlineHit: false,
    totals: { removed: 0, held: 0, failed: 0, bytesFreed: 0 },
  };
}

function sweepLocked(
  mode: { act: boolean; auto: boolean },
  deps: SweepDeps,
): SweepResult {
  const result = emptyResult(deps, mode.act);
  if (mode.auto) {
    const age = stampAgeMs(deps.nowMs(), deps.stateDir);
    if (age !== null && age < WORKTREE_SWEEP_THROTTLE_MS)
      return { ...result, skipped: "throttled" };
  }
  if (mode.act) writeStamp(deps.nowMs(), deps.stateDir);
  const deadlineAt = deps.nowMs() + WORKTREE_SWEEP_DEADLINE_MS;
  const repos = discoverFlowRepos(deps);
  const usage = buildUsageIndex(deps);
  const exists = deps.exists ?? fs.existsSync;
  const pending: Array<{ item: SweepItem; deleteBranch?: boolean }> = [];

  for (const repo of repos) {
    for (const f of gatherWorktreeFacts(repo, deps, usage, deadlineAt)) {
      const v = decideWorktree(f);
      if (f.prs === "unreachable") result.ghUnreachable = true;
      const base = {
        kind: "worktree" as const,
        path: f.path,
        repo,
        branch: f.branch,
      };
      pending.push(
        v.action === "remove"
          ? {
              item: {
                ...base,
                pr: v.pr,
                headOid: v.headOid,
                outcome: "would-remove",
                reason: v.reason,
              },
              deleteBranch: v.deleteBranch,
            }
          : {
              item: {
                ...base,
                outcome: "held",
                reason: v.reason,
                detail: v.detail,
              },
            },
      );
    }
  }
  const husks = gatherHuskFacts(repos, deps, usage);
  for (const h of husks) {
    const v = decideHusk(h);
    const base = { kind: "husk" as const, path: h.path, repo: h.repo };
    pending.push(
      v.action === "remove"
        ? {
            item: {
              ...base,
              outcome: "would-remove",
              reason: v.reason,
              cause: v.cause,
            },
          }
        : {
            item: {
              ...base,
              outcome: "held",
              reason: v.reason,
              cause: v.cause,
              detail: v.detail ?? v.topLevel?.join(", "),
            },
          },
    );
  }

  const pruneRepos = new Set<string>();
  for (const p of pending) {
    let item = p.item;
    if (item.outcome === "would-remove") {
      if (mode.act && deps.nowMs() >= deadlineAt) {
        result.deadlineHit = true;
        item = { ...item, outcome: "held", reason: "deadline-reached" };
      } else {
        item = { ...item, bytes: deps.sizeBytes(item.path) };
      }
      if (mode.act && item.outcome === "would-remove") {
        item =
          item.kind === "worktree"
            ? actOn(deps, item, () =>
                deps.removeWorktree(
                  item.path,
                  item.repo,
                  p.deleteBranch === true,
                ),
              )
            : actOn(deps, item, () => {
                deps.removeDir(item.path);
                return { ok: true, message: "removed" };
              });
        if (item.outcome === "removed") pruneRepos.add(item.repo);
      }
    }
    result.items.push(item);
  }
  for (const repo of pruneRepos)
    deps.run("git", ["worktree", "prune"], { cwd: repo, timeoutMs: 10_000 });

  result.danglingMounts = danglingContainerMounts(
    usage,
    repos,
    exists,
    husks.map((h) => h.path),
  );
  if (usage.dockerSkipped) result.dockerSkipped = usage.dockerSkipped;
  if (usage.processesSkipped) result.processesSkipped = usage.processesSkipped;
  for (const i of result.items) {
    if (i.outcome === "removed") {
      result.totals.removed++;
      result.totals.bytesFreed += i.bytes ?? 0;
    } else if (i.outcome === "held") result.totals.held++;
    else if (i.outcome === "failed") result.totals.failed++;
  }
  if (mode.act && result.ghUnreachable)
    writeStamp(deps.nowMs(), deps.stateDir, WORKTREE_SWEEP_GH_BACKOFF_MS);
  if (mode.act) writeLastSweep(result, deps.stateDir);
  return result;
}

export function runWorktreeSweep(
  mode: { act: boolean; auto: boolean },
  deps: SweepDeps,
): SweepResult {
  if (mode.auto && !isAutoSweepEnabled(deps.readConfig)) {
    return { ...emptyResult(deps, mode.act), skipped: "disabled" };
  }
  try {
    return withFileLockSync(
      lockPath(deps.stateDir),
      () => sweepLocked(mode, deps),
      { timeoutMs: 0 },
    );
  } catch (e) {
    if (e instanceof LockTimeoutError)
      return { ...emptyResult(deps, mode.act), skipped: "locked" };
    throw e;
  }
}
