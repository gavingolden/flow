/**
 * Classifies a cross-model (`flow-delegate` / agy) `skipReason` string into
 * one of two buckets a caller needs to report distinctly:
 *
 *  - `environment` — the agy call was never dispatched (a pre-dispatch gate
 *    or precondition failed). No quota was spent; this is a genuine no-op.
 *  - `ran-unusable` — the call WAS dispatched (past every pre-check) and
 *    produced nothing usable. Quota may have been spent for nothing.
 *
 * The rule is "could this have spent quota?", not "did agy exit non-zero?".
 * `bin/flow-delegate.ts`'s `agy-error` reason is deliberately EXCLUDED from
 * `ENVIRONMENT_SKIP_REASONS` (it classifies as `ran-unusable`): it covers
 * two emission sites — the spawn-throw path (agy never ran) AND the
 * non-zero-exit-without-auth-signature path (agy genuinely ran) — so it
 * cannot be assumed quota-free and is reported the safer way. Conversely,
 * `agy-not-authenticated` sits IN `ENVIRONMENT_SKIP_REASONS` even though
 * it is only emitted after agy ran: the auth failure is what makes the
 * call unusable before any billable work happens, so no quota is spent
 * despite the call having been dispatched.
 *
 * This is an internal lib, not a PATH-shipped helper: it is deliberately NOT
 * registered in `bin/lib/sources.ts`'s `VALIDATOR_MODULES` allowlist —
 * adding one would symlink internal library code onto a user's PATH for no
 * caller that needs a standalone CLI entry.
 *
 * The vocabulary below already covers `bin/flow-plan-review.ts`'s skip
 * reasons (see its own "Skip vocabulary" header comment) so that a later
 * adoption there is a one-line `classifyDelegateSkip` call, not a second
 * table — but this module does not import from or alter
 * `bin/flow-plan-review.ts` / `bin/lib/plan-review-engagement.ts` itself.
 */

export type SkipClass = "environment" | "ran-unusable";

// Pre-dispatch skips: a gate, config read, or local IO precondition failed
// before the agy call was ever attempted, so no quota was spent.
export const ENVIRONMENT_SKIP_REASONS: ReadonlySet<string> = new Set([
  "agy-not-found",
  "agy-not-authenticated",
  "gemini-lens-disabled",
  "gemini-intent-guess-disabled",
  "plan-review-disabled",
  "gemini-diff-unreadable",
  "gemini-intent-guess-diff-unreadable",
  "gemini-prep-failed",
  "gemini-intent-guess-prep-failed",
  "plan-prep-failed",
  "plan-unreadable",
  "no-decision-analysis",
  "decision-analysis-unchanged",
  // `bin/flow-plan-review.ts`'s own header comment calls this a wiring bug
  // ("`--worktree` omitted on the review path"), distinct from an
  // environment condition — but the objective rule here is pre-dispatch,
  // and omitting `--worktree` fails before the agy call is ever attempted,
  // so it classifies as `environment`. Left here deliberately: don't "fix"
  // this back to `ran-unusable` on the strength of that wiring-bug framing.
  "worktree-not-provided",
  "worktree-not-found",
]);

// Returns `environment` for a known pre-dispatch reason, `ran-unusable` for
// everything else — including an unrecognised reason string, which is more
// safely reported as possibly-spent-quota than as a confirmed no-op.
export function classifyDelegateSkip(skipReason: string): SkipClass {
  return ENVIRONMENT_SKIP_REASONS.has(skipReason)
    ? "environment"
    : "ran-unusable";
}
