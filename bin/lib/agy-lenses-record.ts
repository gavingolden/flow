/**
 * The `.flow-tmp/agy-lenses-result.json` record `flow-agy-lenses` writes and
 * `flow-review-telemetry collect` reads. Pure merge logic lives here so a
 * widen re-fan (a second wave of the SAME review) adds to the first wave's
 * engine data instead of overwriting it.
 */

import type { DelegatableLens } from "./delegate-models";
import type { LensRoute } from "./delegated-lens-plan";

export type DelegatedLensResult = {
  lens: DelegatableLens;
  findingCount: number;
  decodedVia: string;
  durationSec: number;
};

export type FallbackLensResult = {
  lens: DelegatableLens;
  reason: string;
  skipClass?: string;
};

export type AgyLensesEnvelope = {
  model: string | null;
  routes: LensRoute[];
  delegated: DelegatedLensResult[];
  fallback: FallbackLensResult[];
  cooldownArmed: boolean;
};

// `review_started_at` (review-scope.json's `started_at`, which a widen re-pass
// keeps) identifies the review a record belongs to.
export type AgyLensesRecord = AgyLensesEnvelope & {
  review_started_at: string | null;
};

export function parseAgyLensesRecord(
  text: string | null,
): AgyLensesRecord | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as Partial<AgyLensesRecord>;
    if (
      typeof v !== "object" ||
      v === null ||
      !Array.isArray(v.routes) ||
      !Array.isArray(v.delegated) ||
      !Array.isArray(v.fallback)
    ) {
      return null;
    }
    return {
      review_started_at: v.review_started_at ?? null,
      model: v.model ?? null,
      routes: v.routes,
      delegated: v.delegated,
      fallback: v.fallback,
      cooldownArmed: v.cooldownArmed === true,
    };
  } catch {
    return null;
  }
}

export function mergeAgyLensesRecord(
  prev: AgyLensesRecord | null,
  next: AgyLensesRecord,
): AgyLensesRecord {
  if (
    prev === null ||
    next.review_started_at === null ||
    prev.review_started_at !== next.review_started_at
  ) {
    return next;
  }
  const waveLenses = new Set(next.routes.map((r) => r.lens));
  const keep = <T extends { lens: DelegatableLens }>(xs: T[]): T[] =>
    xs.filter((x) => !waveLenses.has(x.lens));
  return {
    review_started_at: next.review_started_at,
    model: next.model ?? prev.model,
    routes: [...keep(prev.routes), ...next.routes],
    delegated: [...keep(prev.delegated), ...next.delegated],
    fallback: [...keep(prev.fallback), ...next.fallback],
    cooldownArmed: prev.cooldownArmed || next.cooldownArmed,
  };
}
