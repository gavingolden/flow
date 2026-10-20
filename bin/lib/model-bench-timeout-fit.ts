/**
 * Production time-limit fit: for each (step, model), how many attempts hit the
 * step's production limit, and how many answered over it. A case dispatched at
 * its `productionTimeout` records a timeout as the production outcome, so this
 * section says which steps fit their lifted limits on fixtures. It is
 * single-shot fixture time — production-realistic answer times come from the
 * Stage 0 probe (docs/eval/argon-latency-probe).
 */

import { godurToSec } from "./delegate-timeouts";
import type { BenchCase, BenchResult } from "./model-bench-schema";

export type TimeoutFitRow = {
  surface: string;
  model: string;
  limit: string;
  overLimit: number;
  timedOut: number;
  attempts: number;
};

// Quota / rate-limit refusals are not attempts at the limit.
const NOT_AN_ATTEMPT = new Set(["quota-exhausted", "rate-limited"]);

export function timeoutFit(
  results: BenchResult[],
  cases: BenchCase[],
): TimeoutFitRow[] {
  const byCase = new Map(
    cases.filter((c) => c.productionTimeout).map((c) => [c.id, c]),
  );
  const rows = new Map<string, TimeoutFitRow>();
  for (const r of results) {
    const c = byCase.get(r.caseId);
    if (!c || r.warmup) continue;
    if (r.failureClass && NOT_AN_ATTEMPT.has(r.failureClass)) continue;
    const limit = c.productionTimeout!;
    const key = `${c.surface}::${r.model}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        surface: c.surface,
        model: r.model,
        limit,
        overLimit: 0,
        timedOut: 0,
        attempts: 0,
      };
      rows.set(key, row);
    }
    // Cases on one step share its limit; keep the largest if they ever differ.
    if (godurToSec(limit) > godurToSec(row.limit)) row.limit = limit;
    row.attempts++;
    if (r.skipReason === "agy-timeout") row.timedOut++;
    if (
      typeof r.durationSeconds === "number" &&
      r.durationSeconds > godurToSec(limit)
    ) {
      row.overLimit++;
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.surface.localeCompare(b.surface) || a.model.localeCompare(b.model),
  );
}

export function renderTimeoutFit(rows: TimeoutFitRow[]): string {
  return [
    "## Production timeout fit",
    "",
    "_single-shot fixture time — production-realistic answer times are in the Stage 0 probe_",
    "",
    ...rows.map(
      (r) =>
        `- **${r.surface}** / ${r.model}: ${r.timedOut}/${r.attempts} timed out at the ${r.limit} production limit; ${r.overLimit}/${r.attempts} answered over it`,
    ),
  ].join("\n");
}
