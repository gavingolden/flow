/**
 * Shared phase-write funnel: the one place in the tree where a state write
 * and the tmux mirror publish are the same statement. `writePhaseState`
 * writes state FIRST (state.json is the source of truth), then invokes the
 * publisher inside a swallow-everything try/catch — a publish failure can
 * never surface as a `writePhaseState` throw or block the caller.
 *
 * Pure pass-through: this module never stamps `updatedAt` or `phaseLog` —
 * both callers (`bin/lib/phase-advance.ts`'s `advancePhase` / `finalizePhase`,
 * and `bin/flow-state-update.ts`'s `runUpdate`) already build the full next-
 * state object before calling in.
 *
 * The tmux mirror this publishes is additive and best-effort — see
 * `bin/lib/tmux.ts`'s `setWindowPhase` docblock and AGENTS.md's "Don't make
 * tmux pane/window state a load-bearing input" rule. A missing/unreachable
 * window degrades silently; it never blocks or fails a state write.
 */

import { writeState, type PipelineState } from "./state";
import { setWindowPhase } from "./tmux";

export type PhasePublisher = (slug: string, phase: string) => void;

export function writePhaseState(
  state: PipelineState,
  dir?: string,
  publish: PhasePublisher = (s, p) => void setWindowPhase(s, p),
): void {
  writeState(state, dir);
  try {
    publish(state.slug, state.phase);
  } catch {
    // Best-effort mirror — a publisher failure must never surface here.
  }
}
