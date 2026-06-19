/**
 * Tolerant collector for the Fix-Applier Subagent's artifact. It COMPLEMENTS —
 * never replaces — the strict `validateFixApplierResult` (which stays the
 * canonical whole-artifact gate for callers that act on `{ ok: true }`).
 *
 * The strict validator is all-or-nothing: a single off-shape entry in any one
 * array (most commonly an `anti_patterns_found` entry missing the
 * `introduced_by_this_pr` boolean made required in PR #301) returns
 * `{ ok: false }`, and every render consumer then degrades the WHOLE artifact
 * to `(unreadable)` — even though `commits[]`/`deferred[]`/
 * `rejected_alternatives[]` are valid. The cosmetic snapshot / PR-body render
 * surfaces want the valid subset; this collector gives it to them.
 *
 * Contract:
 * - Returns `null` only when the artifact is GENUINELY broken: a non-object/
 *   null/array input, or any of the five required top-level keys (`commits`,
 *   `deferred`, `rejected_alternatives`, `anti_patterns_found`, `summary`)
 *   absent or of the wrong container type. This mirrors the genuinely-broken
 *   bar `validateFixApplierResult` enforces for its top-level checks, so a
 *   genuinely-broken artifact still degrades to `(unreadable)` wholesale.
 * - Otherwise returns the per-entry-VALID subset of each array plus a `skipped`
 *   count of entries dropped across ALL arrays. It NEVER fabricates or defaults
 *   a missing field — an off-shape entry is dropped, not coerced (so a missing
 *   `introduced_by_this_pr` is never invented). This mirrors the per-entry-skip
 *   precedent in `agent-finding-schema.ts`'s `normalizeParsedFindings`, but
 *   drops rather than normalizes because there is no safe default to invent.
 */

import {
  validateCommitEntry,
  validateDeferredEntry,
  validateRejectedAlternativeEntry,
  validateAntiPatternEntry,
  type FixApplierCommit,
  type FixApplierDeferred,
  type FixApplierRejectedAlternative,
  type FixApplierAntiPattern,
} from "./fix-applier-schema";

export type TolerantFixApplierResult = {
  commits: FixApplierCommit[];
  deferred: FixApplierDeferred[];
  rejected_alternatives: FixApplierRejectedAlternative[];
  anti_patterns_found: FixApplierAntiPattern[];
  summary: string;
  /** Count of per-entry-INVALID entries dropped across all four arrays. */
  skipped: number;
};

/**
 * Filter one array to its per-entry-valid subset using the supplied per-entry
 * validator, accumulating the count of dropped entries into `dropped`.
 */
function collectValid<T>(
  arr: unknown[],
  validate: (entry: unknown, path: string) => { ok: false } | null,
  label: string,
  dropped: { count: number },
): T[] {
  const out: T[] = [];
  for (let i = 0; i < arr.length; i++) {
    if (validate(arr[i], `${label}[${i}]`) === null) {
      out.push(arr[i] as T);
    } else {
      dropped.count++;
    }
  }
  return out;
}

export function collectFixApplierTolerant(
  input: unknown,
): TolerantFixApplierResult | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const o = input as Record<string, unknown>;

  for (const key of [
    "commits",
    "deferred",
    "rejected_alternatives",
    "anti_patterns_found",
  ]) {
    if (!(key in o) || !Array.isArray(o[key])) return null;
  }
  if (!("summary" in o) || typeof o.summary !== "string" || o.summary === "") {
    return null;
  }

  const dropped = { count: 0 };
  const commits = collectValid<FixApplierCommit>(
    o.commits as unknown[],
    validateCommitEntry,
    "commits",
    dropped,
  );
  const deferred = collectValid<FixApplierDeferred>(
    o.deferred as unknown[],
    validateDeferredEntry,
    "deferred",
    dropped,
  );
  const rejected_alternatives = collectValid<FixApplierRejectedAlternative>(
    o.rejected_alternatives as unknown[],
    validateRejectedAlternativeEntry,
    "rejected_alternatives",
    dropped,
  );
  const anti_patterns_found = collectValid<FixApplierAntiPattern>(
    o.anti_patterns_found as unknown[],
    validateAntiPatternEntry,
    "anti_patterns_found",
    dropped,
  );

  return {
    commits,
    deferred,
    rejected_alternatives,
    anti_patterns_found,
    summary: o.summary,
    skipped: dropped.count,
  };
}
