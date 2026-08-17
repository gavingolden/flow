import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_SKIP_REASONS,
  classifyDelegateSkip,
} from "./delegate-skip-class";

describe("classifyDelegateSkip", () => {
  it("classifies agy-not-found as environment (S3)", () => {
    expect(classifyDelegateSkip("agy-not-found")).toBe("environment");
  });

  it("classifies gemini-output-unparseable as ran-unusable (S3)", () => {
    expect(classifyDelegateSkip("gemini-output-unparseable")).toBe(
      "ran-unusable",
    );
  });

  it.each(Array.from(ENVIRONMENT_SKIP_REASONS))(
    "classifies every ENVIRONMENT_SKIP_REASONS member as environment: %s",
    (reason) => {
      expect(classifyDelegateSkip(reason)).toBe("environment");
    },
  );

  // The it.each above is self-referential — it iterates the very set
  // classifyDelegateSkip looks up, so it cannot catch a member being
  // silently dropped from ENVIRONMENT_SKIP_REASONS (every remaining
  // assertion would still pass). Pin the independent members the two
  // shipped helpers actually emit plus the pre-covered flow-plan-review
  // vocabulary, by literal value, so a drop is caught here even though
  // most of these members have no other caller today.
  it("pins the exact ENVIRONMENT_SKIP_REASONS membership (catches an accidental drop the it.each above can't)", () => {
    expect(Array.from(ENVIRONMENT_SKIP_REASONS).sort()).toEqual(
      [
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
        "worktree-not-provided",
        "worktree-not-found",
      ].sort(),
    );
  });

  it("classifies agy-error as ran-unusable (deliberately excluded from ENVIRONMENT_SKIP_REASONS — it may cover a genuinely-dispatched call)", () => {
    // NOTE: agy-error is deliberately excluded from ENVIRONMENT_SKIP_REASONS
    // (the safe direction): bin/flow-delegate.ts emits it both when the
    // runAgy spawn throws (agy never ran) AND on a non-zero exit without an
    // auth signature (agy genuinely ran) — since it can't be assumed
    // quota-free, it classifies as ran-unusable. This pins that exclusion.
    expect(classifyDelegateSkip("agy-error")).toBe("ran-unusable");
  });

  it("defaults an unknown/never-seen reason string to ran-unusable", () => {
    expect(classifyDelegateSkip("some-reason-nobody-has-seen-yet")).toBe(
      "ran-unusable",
    );
    expect(classifyDelegateSkip("")).toBe("ran-unusable");
  });
});
