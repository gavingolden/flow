/**
 * Pure prose engagement classifier for `bin/flow-plan-review.ts`'s
 * cross-model (AGY) reviewers. Scores a reviewer's raw prose output against
 * the six battery lenses `bin/lib/plan-review-prompt.ts` prescribes so a
 * truncated/empty reviewer can be demoted to `ran:false` instead of
 * silently counting as a genuine "reviewer engaged" survivor for the
 * deep-tier convergence rule.
 *
 * HONEST SCOPE: this is a truncation/silence detector, NOT a quality
 * detector. It does not, and cannot, catch a genuine rubber-stamp review —
 * the battery prompt mandates the six exact lens headings, and each heading
 * contains its own matcher keyword (e.g. `**Goal-anchored verdicts.**`
 * matches the goal-anchor lens), so a reviewer that emits all six headings
 * followed only by "Nothing to add." scores a full 6/6 here. This
 * heading-satisfiability is a known limitation, not a bug to fix by
 * redesigning the classifier — catching content-free-but-well-formatted
 * prose would need actual judgment (e.g. another model pass), which this
 * pure, fast, deterministic gate deliberately does not attempt.
 *
 * Deliberately a PURE PROSE classifier with NO markdown-structure
 * assumptions — it does not scan for headings or sections the way
 * `flow-plan-review.ts`'s own `extractDecisionAnalysisBody` does. A
 * reviewer may write flowing prose, bullet points, or its own headings;
 * this module only asks whether the SUBSTANCE of the six lenses shows up
 * anywhere in the text.
 */

// Below this length, prose is treated as empty/near-empty regardless of
// lens content — too short to have meaningfully engaged even one lens.
export const SUBSTANCE_FLOOR_CHARS = 40;

// A reviewer must engage at least this many of the six lenses to count as
// genuinely engaged (vs. a rubber-stamp / truncated run that mentions one
// lens in passing).
export const MIN_LENSES_ENGAGED = 2;

// Discriminated union: `engaged: false` GUARANTEES a present `reason`, so
// call sites never need a `eng.reason!` non-null assertion — the type
// system enforces the invariant that only an engaged:false result carries a
// demotion reason.
export type EngagementResult =
  | { engaged: true; lensesEngaged: number }
  | {
      engaged: false;
      lensesEngaged: number;
      reason: "reviewer-empty" | "reviewer-not-engaged";
    };

// One matcher per battery lens, in the prescribed lens order. Each is
// case-insensitive and matches at most once per lens regardless of how many
// times the pattern recurs in the prose.
const LENS_MATCHERS: RegExp[] = [
  // `goal-anchored` is already subsumed by `goal[- ]anchor` (matches both
  // "goal-anchor" and "goal anchor" as a prefix) — the third alternative was
  // dead.
  /goal[- ]anchor|against the (stated )?goal/i,
  /preference/i,
  /walkthrough|user[- ]flow/i,
  /alternative/i,
  /failure[- ]mode/i,
  /cut[- ]list/i,
];

/**
 * Counts how many of the six battery lenses the prose engages (0-6).
 * Case-insensitive; each lens counts at most once no matter how many times
 * its pattern recurs. Pure — never throws.
 */
export function countLensesEngaged(prose: string): number {
  let count = 0;
  for (const matcher of LENS_MATCHERS) {
    if (matcher.test(prose)) count++;
  }
  return count;
}

/**
 * Classifies a reviewer's raw prose: `reviewer-empty` when it does not
 * clear the substance floor, `reviewer-not-engaged` when it clears the
 * floor but engages fewer than `MIN_LENSES_ENGAGED` lenses, otherwise
 * `engaged: true`. Pure — never throws.
 */
export function classifyEngagement(prose: string): EngagementResult {
  if (prose.trim().length < SUBSTANCE_FLOOR_CHARS) {
    return { engaged: false, lensesEngaged: 0, reason: "reviewer-empty" };
  }
  const lensesEngaged = countLensesEngaged(prose);
  if (lensesEngaged < MIN_LENSES_ENGAGED) {
    return { engaged: false, lensesEngaged, reason: "reviewer-not-engaged" };
  }
  return { engaged: true, lensesEngaged };
}
