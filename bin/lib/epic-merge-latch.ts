/**
 * Records a pipeline's phase/PR on the epic launch record(s) that bind it, so a
 * merge outlives the pipeline's state file: `flow done` deletes
 * `~/.flow/state/<slug>.json`, after which run.json is the only per-machine
 * evidence the feature merged. Both writers (the merge-time finalize and
 * `flow done`) call this. Never filters by `state.epic` (a binding made by
 * `flow epic bind` has no tag) and never creates a launch record.
 */

import {
  listEpicRunStates,
  mutateEpicRunRecord,
  type FeatureRunRecord,
} from "./epic-run-state";
import { FLOW_EPICS_DIR } from "./paths";
import { nowIso, type PipelineState } from "./state";

export type EpicLatchResult = {
  epicSlug: string;
  featureId: string;
  lastStatus: string;
  pr?: number;
  wrote: boolean;
};

export function latchEpicBinding(
  state: PipelineState,
  opts: { epicsDir?: string; now?: () => string } = {},
): EpicLatchResult[] {
  const dir = opts.epicsDir ?? FLOW_EPICS_DIR;
  const now = opts.now ?? nowIso;
  const results: EpicLatchResult[] = [];
  for (const run of listEpicRunStates(dir)) {
    for (const [featureId, rec] of Object.entries(run.features)) {
      if (rec.external || rec.slug !== state.slug) continue;
      let outcome: FeatureRunRecord | undefined;
      const wrote = mutateEpicRunRecord(
        run.epicSlug,
        featureId,
        (prev) => {
          if (!prev || prev.external || prev.slug !== state.slug) return null;
          const keepMerged =
            prev.lastStatus === "merged" && state.phase !== "merged";
          const lastStatus = keepMerged ? "merged" : state.phase;
          const pr = keepMerged ? (prev.pr ?? state.pr) : (state.pr ?? prev.pr);
          const next: FeatureRunRecord = {
            ...prev,
            lastStatus,
            ...(pr !== undefined ? { pr } : {}),
          };
          outcome = next;
          return lastStatus === prev.lastStatus && pr === prev.pr ? null : next;
        },
        { dir, now },
      );
      if (!outcome) continue;
      results.push({
        epicSlug: run.epicSlug,
        featureId,
        lastStatus: outcome.lastStatus ?? state.phase,
        ...(outcome.pr !== undefined ? { pr: outcome.pr } : {}),
        wrote,
      });
    }
  }
  return results;
}

export function formatLatchNote(
  r: EpicLatchResult,
  slug: string,
): string | null {
  if (r.lastStatus !== "merged") return null;
  return `kept ${slug} merged on epic ${r.epicSlug}${r.pr !== undefined ? ` (PR #${r.pr})` : ""}`;
}
