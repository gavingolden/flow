/**
 * Freshness predicates for the `/flow-checkpoint` non-clobbering guard,
 * split out of `bin/flow-checkpoint.ts` to keep that CLI file inside the
 * AGENTS.md ~200-line/file target. `bin/flow-checkpoint.ts` re-exports
 * everything here — it stays the single public import surface (tests and
 * the two external consumers, `flow-resume-decide.ts` and
 * `flow-session-start-hook.ts`, import from `./flow-checkpoint`, never from
 * this file directly).
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** The `/flow-checkpoint` arm sites. Kept in sync (by literal set, not
 *  import) with `CheckpointSiteValue` in `bin/lib/state.ts` — see that
 *  file's comment for why the two are declared independently rather than
 *  one importing the other. */
export const CHECKPOINT_SITES = [
  "manual",
  "plan-review",
  "plan-approval",
  "gate",
] as const;
export type CheckpointSite = (typeof CHECKPOINT_SITES)[number];

/** Absolute path of the checkpoint body the /flow-checkpoint skill writes. */
export function checkpointPath(worktreePath: string): string {
  return path.join(worktreePath, ".flow-tmp", "checkpoint.md");
}

/**
 * True iff `state.phaseLog` carries any entry strictly newer than `isoTs`.
 * Absent/empty `phaseLog` => false — no evidence of an advance is treated as
 * "still fresh" rather than "unknown", which also keeps pipelines that
 * predate phase logging from reading as falsely stale.
 */
export function hasPhaseAdvancedSince(
  state: { phaseLog?: Array<{ at: string }> },
  isoTs: string,
): boolean {
  const log = state.phaseLog;
  if (!log || log.length === 0) return false;
  return log.some((e) => e.at > isoTs);
}

/**
 * Read-only freshness verdict for the checkpoint body, evaluated in order:
 *   1. absent/empty body                              -> write   (absent)
 *   2. no recorded arm (legacy/unrecorded body)        -> mtime-vs-newest-phaseLog fallback
 *   3. manual arm, no phase advance since arm          -> preserve (fresh-manual)
 *   4. manual arm, phase advanced since arm            -> write   (stale-manual:<phase>)
 *   5. auto-site arm (any non-manual site)             -> write   (auto-refresh:<site>) — always
 * Fails open: any unresolvable precondition inside this function (unreadable
 * checkpoint.md) yields `write`; the no-state/no-worktree preconditions are
 * checked by the caller before this runs. `site` is the PROBING site (who is
 * asking), threaded into the auto-refresh reason for observability — the
 * armed site is `state.checkpoint.site`.
 */
export function probeFreshness(
  state: {
    checkpoint?: { site: CheckpointSite; phase: string; armedAt: string };
    phaseLog?: Array<{ at: string }>;
  },
  worktreePath: string,
  site: CheckpointSite,
): { verdict: "write" | "preserve"; reason: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(checkpointPath(worktreePath));
  } catch {
    return { verdict: "write", reason: "absent" };
  }
  if (!stat.isFile() || stat.size === 0) {
    return { verdict: "write", reason: "absent" };
  }

  const record = state.checkpoint;
  if (!record) {
    const log = state.phaseLog;
    const newest =
      log && log.length > 0
        ? log.reduce((a, e) => (e.at > a ? e.at : a), log[0].at)
        : undefined;
    if (newest === undefined) {
      return { verdict: "preserve", reason: "fresh-unrecorded" };
    }
    return stat.mtime.toISOString() > newest
      ? { verdict: "preserve", reason: "fresh-unrecorded" }
      : { verdict: "write", reason: "stale-unrecorded" };
  }

  if (record.site === "manual") {
    return hasPhaseAdvancedSince(state, record.armedAt)
      ? { verdict: "write", reason: `stale-manual:${record.phase}` }
      : { verdict: "preserve", reason: "fresh-manual" };
  }

  return {
    verdict: "write",
    reason: `auto-refresh:${record.site} (probed by ${site})`,
  };
}
