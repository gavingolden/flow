/**
 * Records a pipeline's phase/PR on the epic launch record(s) that bind it, so a
 * merge outlives the pipeline's state file: `flow done` deletes
 * `~/.flow/state/<slug>.json`, after which run.json is the only per-machine
 * evidence the feature merged. Both writers (the merge-time finalize and
 * `flow done`) call this. Never filters by `state.epic` (a binding made by
 * `flow epic bind` has no tag) and never creates a launch record.
 */

import * as fs from "node:fs";
import {
  bindingPredatesPipeline,
  isLatchedMerge,
  listEpicRunStates,
  mutateEpicRunRecord,
  type EpicRunState,
  type FeatureRunRecord,
} from "./epic-run-state";
import { LockTimeoutError } from "./lock";
import { FLOW_EPICS_DIR } from "./paths";
import { makeSameRepository } from "./repo-root";
import { nowIso, type PipelineState } from "./state";

export type EpicLatchResult = {
  epicSlug: string;
  featureId: string;
  lastStatus: string;
  pr?: number;
  wrote: boolean;
  skipped?: "predates-pipeline" | "other-repo";
};

type SkipReason = NonNullable<EpicLatchResult["skipped"]>;

function skipChecker(
  run: EpicRunState,
  state: PipelineState,
): (rec: FeatureRunRecord) => SkipReason | null {
  let sameRepo: ((repoPath: string) => boolean) | undefined;
  const reposDiffer = (): boolean => {
    if (!run.repo || !state.repo || run.repo === state.repo) return false;
    if (!fs.existsSync(state.repo)) return false;
    sameRepo ??= makeSameRepository(run.repo);
    return !sameRepo(state.repo);
  };
  return (rec) => {
    if (bindingPredatesPipeline(rec, state)) return "predates-pipeline";
    return reposDiffer() ? "other-repo" : null;
  };
}

export function latchEpicBinding(
  state: PipelineState,
  opts: { epicsDir?: string; now?: () => string } = {},
): EpicLatchResult[] {
  const dir = opts.epicsDir ?? FLOW_EPICS_DIR;
  const now = opts.now ?? nowIso;
  const results: EpicLatchResult[] = [];
  for (const run of listEpicRunStates(dir)) {
    const skipReason = skipChecker(run, state);
    for (const [featureId, rec] of Object.entries(run.features)) {
      if (rec.external || rec.slug !== state.slug) continue;
      const initial = skipReason(rec);
      if (initial) {
        results.push(skippedResult(run.epicSlug, featureId, rec, initial));
        continue;
      }
      let outcome: FeatureRunRecord | undefined;
      let skipped: { rec: FeatureRunRecord; reason: SkipReason } | undefined;
      const wrote = mutateEpicRunRecord(
        run.epicSlug,
        featureId,
        (prev) => {
          if (!prev || prev.external || prev.slug !== state.slug) return null;
          const reason = skipReason(prev);
          if (reason) {
            skipped = { rec: prev, reason };
            return null;
          }
          const keepMerged =
            state.phase !== "merged" && isLatchedMerge(prev, null);
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
      if (skipped) {
        results.push(
          skippedResult(run.epicSlug, featureId, skipped.rec, skipped.reason),
        );
        continue;
      }
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

function skippedResult(
  epicSlug: string,
  featureId: string,
  rec: FeatureRunRecord,
  skipped: SkipReason,
): EpicLatchResult {
  return {
    epicSlug,
    featureId,
    lastStatus: rec.lastStatus ?? "",
    ...(rec.pr !== undefined ? { pr: rec.pr } : {}),
    wrote: false,
    skipped,
  };
}

export function formatLatchNote(
  r: EpicLatchResult,
  slug: string,
): string | null {
  if (r.skipped === "predates-pipeline") {
    return `left ${r.epicSlug}/${r.featureId} unlatched: its launch record predates this pipeline`;
  }
  if (r.skipped === "other-repo") {
    return `left ${r.epicSlug}/${r.featureId} unlatched: its epic belongs to a different repo`;
  }
  if (r.lastStatus !== "merged") return null;
  return `kept ${slug} merged on epic ${r.epicSlug}${r.pr !== undefined ? ` (PR #${r.pr})` : ""}`;
}

export function describeLatchFailure(err: unknown): string {
  if (err instanceof LockTimeoutError) {
    return "another flow command is still updating the epic board — wait a few seconds";
  }
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return "flow cannot write the epic board file — check its permissions";
  }
  if (code === "ENOSPC") return "the disk is full";
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && message.startsWith("invalid launch record")) {
    return "the epic board entry would have been malformed";
  }
  return message;
}
