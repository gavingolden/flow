import { describe, expect, it } from "vitest";
import type { PreconditionId } from "./exec-review-preconditions";
import { SKIP_REASONS } from "../flow-deliberate";
import { skipTextFor } from "./exec-review-skip-text";

const ALL: PreconditionId[] = [
  "cross-model-unavailable",
  "cross-model-not-engaged",
  "cross-model-stale",
  "anchor-unresolved",
  "plan-lint",
  "needs-user-input",
  "stakes-confidence",
  "plan-deviates-from-request",
  "one-way-action",
];

describe("skipTextFor", () => {
  it("gives every precondition its own plain-language sentence", () => {
    const texts = ALL.map((id) => skipTextFor("precondition-failed", id));
    expect(new Set(texts).size).toBe(ALL.length);
    for (const t of texts) {
      expect(t).not.toMatch(/precondition-failed|[a-z]+-[a-z]+-[a-z]+/);
      expect(t.length).toBeGreaterThan(20);
    }
    expect(skipTextFor("precondition-failed", "cross-model-stale")).toBe(
      "the outside-model review is older than the current plan",
    );
  });

  it("covers every reason flow-claude-headless forwards", () => {
    const forwarded = [
      "bad-args",
      "claude-not-found",
      "claude-not-logged-in",
      "claude-error",
      "claude-timeout",
      "incomplete-result",
      "headless-depth-exceeded",
    ];
    for (const r of forwarded) {
      expect(SKIP_REASONS).toContain(r);
      expect(skipTextFor(r)).not.toContain(r);
    }
  });

  it("falls back to a readable sentence for an unmapped skip reason", () => {
    expect(skipTextFor("some-new-reason")).toContain("some-new-reason");
    expect(skipTextFor("charter-missing")).not.toBe("charter-missing");
  });
});
