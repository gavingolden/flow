/**
 * Per-pipeline $ spend, a `flow ls --cost` projection of the run-attribution
 * collector, plus the reusable per-transcript usage summer. Session
 * discovery (which JSONLs belong to a pipeline) lives in `session-discovery`.
 */

import { collectRunAttribution } from "./run-attribution";
import { mergeWithPrior } from "./run-attribution-record";
import type { RunAttribution } from "./run-attribution-types";
import { defaultProjectsRoot } from "./session-discovery";
import type { PipelineState } from "./state";
import {
  type EffortRun,
  effortRunsOf,
  readTranscriptTurns,
} from "./transcript-turns";

export type CostBreakdown = {
  total: number;
  byModel: Record<string, number>;
  /** Headless delegated spend; part of `total` but not of `byModel`. */
  delegatedUsd: number;
  unknownModels: string[];
  hasData: boolean;
};

export const EMPTY_COST: CostBreakdown = {
  total: 0,
  byModel: {},
  delegatedUsd: 0,
  unknownModels: [],
  hasData: false,
};

/**
 * `flow ls --cost` projection of the run-attribution collector merged with
 * the pipeline's latest durable row, so the cost column and `RAN ON:` always
 * show the same figure and sessions Claude Code has since pruned keep their
 * spend. `hasData` needs at least one session or spawn: an empty row stays
 * `—`, never `$0.00`.
 */
export async function computeCost(
  state: PipelineState,
  projectsRoot = defaultProjectsRoot(),
  latest: RunAttribution | null = null,
): Promise<CostBreakdown> {
  const merged = mergeWithPrior(
    collectRunAttribution(state, { projectsRoot }),
    latest,
  );
  if (merged.sessions.length + merged.spawns.length === 0) return EMPTY_COST;
  const byModel: Record<string, number> = {};
  for (const r of merged.totals.by_model_effort) {
    if (r.cost_usd) byModel[r.model] = (byModel[r.model] ?? 0) + r.cost_usd;
  }
  let delegatedUsd = 0;
  for (const d of merged.delegated) delegatedUsd += d.cost_usd ?? 0;
  return {
    total: merged.totals.cost_usd,
    byModel,
    delegatedUsd,
    unknownModels: merged.totals.unpriced_models,
    hasData: true,
  };
}

export type TranscriptUsage = {
  input: number;
  cache_creation: number;
  cache_read: number;
  output: number;
  total: number;
  model: string | null;
  effortRuns: EffortRun[];
};

/**
 * Reusable transcript-usage summer for a single JSONL: sums every
 * assistant turn's `message.usage` fields, tracks the last-seen
 * `message.model` and the ordered effort runs. Never throws — malformed
 * lines are skipped, a missing/oversized file yields all-zero counts with
 * `model: null`. Dedupe (last line per `message.id` wins) lives in
 * `readTranscriptTurns`. Stays async because review telemetry awaits it.
 */
export async function sumTranscriptUsage(
  jsonlPath: string,
): Promise<TranscriptUsage> {
  const out: TranscriptUsage = {
    input: 0,
    cache_creation: 0,
    cache_read: 0,
    output: 0,
    total: 0,
    model: null,
    effortRuns: [],
  };
  const turns = readTranscriptTurns(jsonlPath);
  if (!turns) return out;
  for (const t of turns) {
    const input = num(t.usage.input_tokens);
    const cacheCreation = num(t.usage.cache_creation_input_tokens);
    const cacheRead = num(t.usage.cache_read_input_tokens);
    const output = num(t.usage.output_tokens);
    out.input += input;
    out.cache_creation += cacheCreation;
    out.cache_read += cacheRead;
    out.output += output;
    out.total += input + cacheCreation + cacheRead + output;
    if (t.model) out.model = t.model;
  }
  out.effortRuns = effortRunsOf(turns);
  return out;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
