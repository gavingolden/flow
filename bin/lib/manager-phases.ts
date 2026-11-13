/**
 * Which pipeline phases wake the global manager and which are silent. Derived
 * from the sequencer's owner-needed set so the two never drift: a phase the
 * owner must act on wakes the manager, as do the end states it reports
 * (`merged`, `cancelled`, `epic-approved`); every other phase is silent,
 * including the CI and plan-review waits.
 */

import { OWNER_NEEDED_PHASES } from "./epic-manage-board";
import { PIPELINE_PHASES } from "./state";

export const MANAGER_WAKE_PHASES: ReadonlySet<string> = new Set([
  ...OWNER_NEEDED_PHASES,
  "merged",
  "cancelled",
  "epic-approved",
]);

export function isWakePhase(phase: string): boolean {
  return MANAGER_WAKE_PHASES.has(phase);
}

export const MANAGER_SILENT_PHASES: ReadonlySet<string> = new Set(
  PIPELINE_PHASES.filter((p) => !MANAGER_WAKE_PHASES.has(p)),
);
