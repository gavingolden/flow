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
import { FLOW_STATE_DIR } from "./paths";
import { isValidSlug } from "./slug";

/** The `/flow-checkpoint` arm sites. Single source of truth — `CheckpointSiteValue`
 *  in `bin/lib/state.ts` is derived from this const via `(typeof CHECKPOINT_SITES)[number]`,
 *  and `isCheckpointRecord` there reads this array directly rather than
 *  restating the literal set. */
export const CHECKPOINT_SITES = [
  "manual",
  "plan-review",
  "plan-approval",
  "gate",
  "terminal",
] as const;
export type CheckpointSite = (typeof CHECKPOINT_SITES)[number];

/**
 * Directory holding a pipeline's checkpoint files, keyed by slug alone —
 * worktree-independent so a body written here survives `flow-remove-worktree`
 * and every terminal phase. Pure `path.join`, no mkdir and no existence
 * probe (mkdir stays at the write sites, mirroring
 * `bin/lib/stop-turn-tracking.ts:41,73`'s `turns/` subdirectory precedent).
 */
export function checkpointDir(slug: string, dir = FLOW_STATE_DIR): string {
  // The slug becomes a filesystem path component here, so validate rather than
  // trust the caller — same reasoning (and same throw) as the sibling
  // `registryPath` in `bin/lib/proc-registry.ts`. Without it a slug carrying
  // `../` would build a traversal-prone path that the hook then reads and
  // injects into a fresh session.
  if (!isValidSlug(slug)) {
    throw new Error(`checkpoint-freshness: invalid slug "${slug}"`);
  }
  return path.join(dir, "checkpoints", slug);
}

/**
 * Deletes a pipeline's checkpoint directory. Completes the per-slug teardown
 * that `deleteState` + `deleteTurnTracking` already perform — without it a
 * reused slug inherits the previous run's notes AND its armed
 * `checkpoint.pending` marker, so the next plain `/clear` would re-inject a
 * dead pipeline's context. That inheritance was structurally impossible while
 * the body lived in the worktree (`flow-remove-worktree` took it), so this is
 * the move's own cleanup obligation, not a general GC pass. Best-effort:
 * never throws, returns true only when a directory was actually removed.
 */
export function deleteCheckpointDir(
  slug: string,
  dir = FLOW_STATE_DIR,
): boolean {
  try {
    fs.rmSync(checkpointDir(slug, dir), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of the checkpoint body the /flow-checkpoint skill writes. */
export function checkpointBodyPath(slug: string, dir = FLOW_STATE_DIR): string {
  return path.join(checkpointDir(slug, dir), "checkpoint.md");
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
 * checkpoint.md) yields `write`; the no-state precondition is checked by the
 * caller before this runs (there is no worktree precondition — the body is
 * slug-keyed). `site` is the PROBING site (who is
 * asking), threaded into the auto-refresh reason for observability — the
 * armed site is `state.checkpoint.site`.
 */
export function probeFreshness(
  state: {
    slug: string;
    checkpoint?: { site: CheckpointSite; phase: string; armedAt: string };
    phaseLog?: Array<{ at: string }>;
  },
  site: CheckpointSite,
  dir = FLOW_STATE_DIR,
): { verdict: "write" | "preserve"; reason: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(checkpointBodyPath(state.slug, dir));
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

/**
 * Usability predicate for Resume mode's re-injection gate — a DIFFERENT
 * question from `probeFreshness`'s non-clobbering verdict. `probeFreshness`
 * rule 5 answers "may THIS site overwrite the body?" with an unconditional
 * `write` for any auto-site record, regardless of whether that record's body
 * has itself been superseded by a later phase transition — it says nothing
 * about whether the UNCONSUMED body sitting on disk right now is still worth
 * reading. Resume mode asks that second question. Reusing `probeFreshness`'s
 * verdict (or naively re-deriving its `reason` string, which inherits the
 * same rule-5 blind spot for auto sites) for the usability check silently
 * archives an unread auto-armed body via `--consume` — the regression this
 * predicate closes; see `bin/flow-resume-decide.ts`'s `gatherInputs`.
 *
 * Evaluated directly against the body + record, in order:
 *   1. absent/empty body                                -> false
 *   2. no recorded arm (legacy/unrecorded body)          -> same
 *      mtime-vs-newest-phaseLog fallback `probeFreshness` uses for this case
 *   3. any recorded arm (manual OR auto site), no phase
 *      advance since `armedAt`                           -> true
 *   4. any recorded arm, phase advanced since `armedAt`   -> false
 * Unlike `probeFreshness`, staleness here is evaluated identically for
 * manual and auto records — the arm-time overwrite question (rule 5) does
 * not apply to a resume-time read.
 */
export function isCheckpointUsable(
  state: {
    slug: string;
    checkpoint?: { site: CheckpointSite; phase: string; armedAt: string };
    phaseLog?: Array<{ at: string }>;
  },
  dir = FLOW_STATE_DIR,
): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(checkpointBodyPath(state.slug, dir));
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size === 0) return false;

  const record = state.checkpoint;
  if (!record) {
    const log = state.phaseLog;
    const newest =
      log && log.length > 0
        ? log.reduce((a, e) => (e.at > a ? e.at : a), log[0].at)
        : undefined;
    if (newest === undefined) return true;
    return stat.mtime.toISOString() > newest;
  }

  return !hasPhaseAdvancedSince(state, record.armedAt);
}
