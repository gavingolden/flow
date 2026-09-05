import { describe, expect, it } from "vitest";
import { classifyAgyFailure, AGY_FAILURE_CLASSES } from "./agy-failure-class";

describe("AGY_FAILURE_CLASSES", () => {
  it("is exactly the eight named classes, in order", () => {
    expect(AGY_FAILURE_CLASSES).toEqual([
      "quota-exhausted",
      "rate-limited",
      "auth",
      "timeout",
      "canceled",
      "empty-artifact",
      "spawn-failed",
      "unknown",
    ]);
  });
});

describe("classifyAgyFailure", () => {
  it("classifies the exact real-world quota stderr as quota-exhausted, not unknown", () => {
    const result = classifyAgyFailure({
      skipReason: "agy-error",
      stderrTail:
        "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h59m28s.",
    });
    expect(result).toBe("quota-exhausted");
  });

  it("classifies a quota notice printed to stdout with a 0-byte artifact as quota-exhausted, not empty-artifact", () => {
    const result = classifyAgyFailure({
      skipReason: "agy-empty-artifact",
      stdoutTail:
        "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h59m28s.",
    });
    expect(result).toBe("quota-exhausted");
  });

  it("classifies a rate-limit stderr as rate-limited", () => {
    const result = classifyAgyFailure({
      skipReason: "agy-error",
      stderrTail: "Error 429: Too Many Requests, please retry later.",
    });
    expect(result).toBe("rate-limited");
  });

  it("checks quota before rate-limit when both patterns are present", () => {
    const result = classifyAgyFailure({
      skipReason: "agy-error",
      stderrTail: "429 Too Many Requests — quota exceeded for this project",
    });
    expect(result).toBe("quota-exhausted");
  });

  it("maps agy-not-authenticated to auth", () => {
    expect(classifyAgyFailure({ skipReason: "agy-not-authenticated" })).toBe(
      "auth",
    );
  });

  it("maps agy-timeout to timeout", () => {
    expect(classifyAgyFailure({ skipReason: "agy-timeout" })).toBe("timeout");
  });

  it("maps agy-canceled to canceled", () => {
    expect(classifyAgyFailure({ skipReason: "agy-canceled" })).toBe("canceled");
  });

  it("maps agy-empty-artifact to empty-artifact absent any quota/rate-limit signal", () => {
    expect(
      classifyAgyFailure({
        skipReason: "agy-empty-artifact",
        stderrTail: "",
      }),
    ).toBe("empty-artifact");
  });

  it("maps agy-not-found to unknown", () => {
    expect(classifyAgyFailure({ skipReason: "agy-not-found" })).toBe("unknown");
  });

  it("falls back to unknown for an unrecognised skipReason with no quota/rate-limit signal", () => {
    expect(classifyAgyFailure({ skipReason: "something-else" })).toBe(
      "unknown",
    );
  });

  it("quota/rate-limit patterns are checked before the generic skipReason mapping", () => {
    const result = classifyAgyFailure({
      skipReason: "agy-not-found",
      stderrTail: "quota exceeded",
    });
    expect(result).toBe("quota-exhausted");
  });
});
