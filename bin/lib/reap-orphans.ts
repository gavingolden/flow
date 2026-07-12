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

import { livenessOf } from "./liveness";
import { deleteState, type PipelineState } from "./state";
import { findWindowBySlug, type TmuxWindow } from "./tmux";

/**
 * Pure: the slugs of never-started orphans safe to reap. A slug is reapable
 * iff phase === "starting" AND its `updatedAt` is older than `graceMs` AND
 * either:
 *   - the file-signal liveness check (`livenessOf`) positively reports the
 *     recorded process dead/stale (a window can still be present — a live
 *     window doesn't prove a live supervisor), or
 *   - the liveness verdict is unknown (old-format state, no pid/procStartedAt)
 *     AND no live tmux window owns the slug — the legacy window-existence
 *     check, preserved as the fallback for state predating this signal.
 * An `alive` verdict is NEVER reapable, regardless of window presence — a
 * positive liveness read overrides an otherwise-missing-window signal. An
 * unparseable `updatedAt` is never reaped (treated as fresh) — better to
 * leave a phantom than destroy a recoverable pipeline.
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
    const verdict = livenessOf(state);
    if (verdict === "alive") continue;
    if (
      verdict === "unknown" &&
      findWindowBySlug(windows, state.slug) !== undefined
    ) {
      continue;
    }
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
