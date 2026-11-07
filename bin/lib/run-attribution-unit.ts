/**
 * Per-session / per-spawn aggregation for the run-attribution row: ordered
 * model+effort runs, tokens, and list-price cost priced turn by turn at each
 * turn's own model, plus the rollup totals recomputable from units alone.
 */

import { lookupModelPricing, priceUsage } from "./cost-pricing";
import type {
  DelegatedCall,
  RunTotals,
  UnitAttribution,
} from "./run-attribution-types";
import { modelEffortRunsOf, type TranscriptTurn } from "./transcript-turns";

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function turnCost(t: TranscriptTurn): number | null {
  const p = t.model ? lookupModelPricing(t.model) : null;
  return p ? priceUsage(t.usage, p) : null;
}

export function attributeTurns(
  sessionId: string,
  turns: readonly TranscriptTurn[],
): UnitAttribution {
  const runs = modelEffortRunsOf(turns);
  const runCosts: (number | null)[] = [];
  const tokens = {
    input: 0,
    cache_creation: 0,
    cache_read: 0,
    output: 0,
    total: 0,
  };
  let at = 0;
  for (const [, , n] of runs) {
    let cost: number | null = null;
    for (const t of turns.slice(at, at + n)) {
      const c = turnCost(t);
      if (c !== null) cost = (cost ?? 0) + c;
    }
    runCosts.push(cost);
    at += n;
  }
  for (const t of turns) {
    const input = num(t.usage.input_tokens);
    const cacheCreation = num(t.usage.cache_creation_input_tokens);
    const cacheRead = num(t.usage.cache_read_input_tokens);
    const output = num(t.usage.output_tokens);
    tokens.input += input;
    tokens.cache_creation += cacheCreation;
    tokens.cache_read += cacheRead;
    tokens.output += output;
    tokens.total += input + cacheCreation + cacheRead + output;
  }
  return {
    session_id: sessionId,
    model: majorityModel(turns),
    runs,
    run_costs: runCosts,
    turns: turns.length,
    tokens,
    cost_usd: sumCosts(runCosts),
  };
}

function sumCosts(costs: readonly (number | null)[]): number | null {
  let total: number | null = null;
  for (const c of costs) if (c !== null) total = (total ?? 0) + c;
  return total;
}

function majorityModel(turns: readonly TranscriptTurn[]): string | null {
  const counts = new Map<string, number>();
  for (const t of turns) {
    if (t.model) counts.set(t.model, (counts.get(t.model) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [model, n] of counts) {
    if (n > bestN) {
      best = model;
      bestN = n;
    }
  }
  return best;
}

export function computeTotals(
  units: readonly UnitAttribution[],
  delegated: readonly DelegatedCall[],
  skippedFiles: number,
): RunTotals {
  const buckets = new Map<
    string,
    { model: string; effort: string; turns: number; cost: number | null }
  >();
  const unpriced = new Set<string>();
  let cost = 0;
  let unknownEffort = 0;
  for (const u of units) {
    u.runs.forEach(([model, effort, turns], i) => {
      const runCost = u.run_costs[i] ?? null;
      const key = `${model}\0${effort}`;
      const b = buckets.get(key) ?? {
        model: model ?? "unknown",
        effort,
        turns: 0,
        cost: null,
      };
      b.turns += turns;
      if (runCost !== null) {
        b.cost = (b.cost ?? 0) + runCost;
        cost += runCost;
      } else if (model) {
        unpriced.add(model);
      }
      buckets.set(key, b);
      if (effort === "unknown") unknownEffort += turns;
    });
  }
  for (const d of delegated) if (d.cost_usd !== null) cost += d.cost_usd;
  return {
    cost_usd: cost,
    unpriced_models: [...unpriced].sort(),
    skipped_files: skippedFiles,
    unattributed_effort_turns: unknownEffort,
    by_model_effort: [...buckets.values()]
      .sort((a, b) => b.turns - a.turns)
      .map((b) => ({
        model: b.model,
        effort: b.effort,
        turns: b.turns,
        cost_usd: b.cost,
      })),
  };
}
