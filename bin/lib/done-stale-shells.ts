/**
 * `flow done`'s stale-shell step: stop Claude Code background shells that only
 * watch the pipelines this invocation closes. Kept out of `done.ts` so the
 * close paths carry only a seam call and a renderer call.
 */

import { dim } from "./color";
import type { PipelineState } from "./state";
import {
  defaultStaleShellDeps,
  renderStaleShellLines,
  STALE_SHELL_MIN_AGE_SEC,
  sweepStaleShells,
  type StaleShellSweepResult,
} from "./stale-shells-run";
import type { StaleTarget } from "./stale-shells";

export type StaleShellSweepSeam = (
  targets: StaleTarget[],
  act: boolean,
) => StaleShellSweepResult;

export const defaultStaleShellSweep: StaleShellSweepSeam = (targets, act) =>
  sweepStaleShells(defaultStaleShellDeps(), {
    act,
    targets,
    minAgeSec: STALE_SHELL_MIN_AGE_SEC,
  });

export function targetsOf(
  states: Pick<PipelineState, "slug" | "worktree">[],
): StaleTarget[] {
  return states.map((s) => ({
    slug: s.slug,
    ...(s.worktree ? { worktree: s.worktree } : {}),
  }));
}

/** Report-only count of shells a close would stop; 0 on any sweep error. */
export function countStaleShells(
  seam: StaleShellSweepSeam | undefined,
  targets: StaleTarget[],
): number {
  if (targets.length === 0) return 0;
  try {
    return (seam ?? defaultStaleShellSweep)(targets, false).found.length;
  } catch {
    return 0;
  }
}

/** Confirm-text tail, e.g. ` and stop 1 background wait in another session`. */
export function confirmSuffix(count: number): string {
  if (count === 0) return "";
  return count === 1
    ? " and stop 1 background wait in another session"
    : ` and stop ${count} background waits in other sessions`;
}

/** Stops the shells and prints one dim line each; never fails the close. */
export function stopStaleShells(
  seam: StaleShellSweepSeam | undefined,
  targets: StaleTarget[],
): void {
  if (targets.length === 0) return;
  try {
    const result = (seam ?? defaultStaleShellSweep)(targets, true);
    for (const line of renderStaleShellLines(result)) {
      console.log(dim(`  ${line}`));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(dim(`  (background-shell sweep skipped: ${msg})`));
  }
}
