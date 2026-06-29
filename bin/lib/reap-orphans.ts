/**
 * Lazy orphan reaper for never-started pipelines.
 *
 * Replaces the old destructive launch-time consumption gate (#347/#355/#364)
 * as the cleanup mechanism: instead of killing/respawning a live-but-slow
 * launch, the launcher leaves it running and `flow ls` lazily reaps the state
 * files that genuinely never started — phase still `starting`, no live tmux
 * window owns the slug, and `updatedAt` older than a grace window.
 *
 * Conservative by construction: a state PAST `starting` (a legitimately
 * resumable crash) keeps its `(no window)` resume hint, and an alive window
 * is never reaped regardless of phase (it may be a just-launched, still
 * cold-starting supervisor).
 */

import { deleteState, type PipelineState } from "./state";
import { findWindowBySlug, type TmuxWindow } from "./tmux";

/**
 * Pure: the slugs of never-started orphans safe to reap. A slug is reapable
 * iff phase === "starting" AND no live tmux window owns it AND its `updatedAt`
 * is older than `graceMs`. An unparseable `updatedAt` is never reaped (treated
 * as fresh) — better to leave a phantom than destroy a recoverable pipeline.
 */
export function reapableStartingOrphans(
  states: PipelineState[],
  windows: TmuxWindow[],
  nowMs: number,
  graceMs: number,
): string[] {
  const reapable: string[] = [];
  for (const state of states) {
    if (state.phase !== "starting") continue;
    if (findWindowBySlug(windows, state.slug) !== undefined) continue;
    const updated = Date.parse(state.updatedAt);
    if (!Number.isFinite(updated)) continue;
    if (nowMs - updated <= graceMs) continue;
    reapable.push(state.slug);
  }
  return reapable;
}

/**
 * Side-effect wrapper: deletes the state file of each reapable orphan and
 * returns the reaped slugs. The `stateDir` arg threads through to `deleteState`
 * (defaults to the global state dir) for testability.
 */
export function reapStartingOrphans(
  states: PipelineState[],
  windows: TmuxWindow[],
  nowMs: number,
  graceMs: number,
  stateDir?: string,
): string[] {
  const slugs = reapableStartingOrphans(states, windows, nowMs, graceMs);
  for (const slug of slugs) deleteState(slug, stateDir);
  return slugs;
}
