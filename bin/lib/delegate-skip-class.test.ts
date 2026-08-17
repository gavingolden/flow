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

  it("classifies agy-error as ran-unusable (the spawn itself never ran, but the rule stays pre-dispatch-based per the module header)", () => {
    // NOTE: agy-error is deliberately excluded from ENVIRONMENT_SKIP_REASONS
    // per the Task 2 contract adjustment (safe direction), even though
    // bin/flow-delegate.ts emits it when the runAgy spawn throws (i.e. agy
    // never actually ran) — this pins that exclusion.
    expect(classifyDelegateSkip("agy-error")).toBe("ran-unusable");
  });

  it("defaults an unknown/never-seen reason string to ran-unusable", () => {
    expect(classifyDelegateSkip("some-reason-nobody-has-seen-yet")).toBe(
      "ran-unusable",
    );
    expect(classifyDelegateSkip("")).toBe("ran-unusable");
  });
});
