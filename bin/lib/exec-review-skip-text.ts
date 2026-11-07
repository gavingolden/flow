/**
 * Plain-language wording for the epic executive's skip and defer pauses, so
 * the owner never reads a raw reason id.
 */

import type { PreconditionId } from "./exec-review-preconditions";

export const PRECONDITION_SKIP_TEXT: Record<PreconditionId, string> = {
  "cross-model-unavailable": "the outside-model review never ran for this plan",
  "cross-model-not-engaged":
    "the outside-model review did not engage enough of the plan to count",
  "cross-model-stale":
    "the outside-model review is older than the current plan",
  "anchor-unresolved": "the plan cites a file or line that is not in the repo",
  "plan-lint": "the plan has structural gaps its own checker flagged",
  "needs-user-input": "the plan still has an open question only you can settle",
  "stakes-confidence":
    "the plan is not highly confident on a question that affects you",
  "plan-deviates-from-request":
    "the plan departs from what you originally asked for",
  "one-way-action":
    "the plan has a step that cannot be undone (production, a shared database, or spend)",
};

// Headless reasons mirror what flow-claude-headless forwards
// (bin/flow-deliberate.ts SKIP_REASONS).
const SKIP_REASON_TEXT: Record<string, string> = {
  "no-grant": "you have not granted this epic executive autonomy",
  "not-epic": "this feature is not part of an epic",
  "other-epic": "this feature belongs to a different epic",
  "unknown-feature": "the epic manifest does not list this feature",
  "state-missing": "this pipeline's state file is missing",
  "plan-unreadable": "the plan or the epic manifest could not be read",
  "charter-missing":
    "your product brief has no Deciding on my behalf section yet",
  "charter-too-long":
    "your Deciding on my behalf section is too long to review against",
  "prompt-unavailable": "the executive's review prompt could not be loaded",
  "envelope-invalid": "the executive's answer was not in the expected shape",
  "headless-error": "the executive's review did not return an answer",
  "bad-args": "the executive's review was launched with invalid arguments",
  "headless-depth-exceeded":
    "the executive's review was blocked by the nested-session limit",
  "claude-timeout": "the executive's review timed out",
  "claude-not-logged-in": "Claude is not logged in for the executive's review",
  "claude-not-found": "the claude CLI was not found for the executive's review",
  "claude-error": "the executive's review failed to run",
  "incomplete-result": "the executive's review ended without a complete answer",
};

export function skipTextFor(
  skipReason: string,
  failedPrecondition?: PreconditionId,
): string {
  if (failedPrecondition) return PRECONDITION_SKIP_TEXT[failedPrecondition];
  return (
    SKIP_REASON_TEXT[skipReason] ??
    `the executive's review could not run (${skipReason})`
  );
}

export const UNANCHORED_APPROVE_DEFER_TEXT =
  "the executive approved, but none of its evidence points at a real file and line in the repo, so it is asking you instead";
