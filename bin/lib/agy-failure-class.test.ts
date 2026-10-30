import { describe, expect, it } from "vitest";
import {
  classifyAgyFailure,
  AGY_FAILURE_CLASSES,
  isContentFilterText,
} from "./agy-failure-class";

describe("AGY_FAILURE_CLASSES", () => {
  it("is exactly the ten named classes, in order", () => {
    expect(AGY_FAILURE_CLASSES).toEqual([
      "quota-exhausted",
      "rate-limited",
      "auth",
      "timeout",
      "canceled",
      "empty-artifact",
      "spawn-failed",
      "unknown",
      "model-unavailable",
      "content-filtered",
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

  it("classifies a quota notice printed to stdout (the artifact, non-zero exit) as quota-exhausted, not agy-error/unknown", () => {
    // NOTE: a quota notice printed to stdout means the artifact has
    // content, so this reaches `classifyAgyOutcome`'s `agy-error` branch
    // (non-zero exit), never `agy-empty-artifact` — a 0-byte artifact and
    // "quota text was printed to stdout" are mutually exclusive.
    // `bin/flow-delegate.ts`'s outcome!==ran branch reads the artifact and
    // threads its tail as `stdoutTail` regardless of which `skipReason`
    // classifyAgyOutcome produced, which is what makes this reachable.
    const result = classifyAgyFailure({
      skipReason: "agy-error",
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

  it("maps agy-model-unavailable to model-unavailable", () => {
    expect(classifyAgyFailure({ skipReason: "agy-model-unavailable" })).toBe(
      "model-unavailable",
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

describe("content-filtered refusals", () => {
  const exit0 =
    "Your previous response was blocked by content safety filters\nPlease provide a response that complies with content policies, or briefly explain to the user why you cannot help with this request\nRetries remaining: 3";
  const exit3 =
    "agent executor error: generating and executing: Your previous response was blocked by content safety filters\nOutput retries exhausted after 4 attempts";

  it("classifies the exit-0 refusal shape in agyError", () => {
    expect(
      classifyAgyFailure({ skipReason: "agy-error", agyError: exit0 }),
    ).toBe("content-filtered");
  });

  it("classifies the exit-3 refusal shape in agyError", () => {
    expect(
      classifyAgyFailure({ skipReason: "agy-error", agyError: exit3 }),
    ).toBe("content-filtered");
  });

  it("classifies a refusal that appears only in stderr", () => {
    expect(
      classifyAgyFailure({ skipReason: "agy-error", stderrTail: exit3 }),
    ).toBe("content-filtered");
  });

  it("lets quota text win when it appears next to a refusal", () => {
    expect(
      classifyAgyFailure({
        skipReason: "agy-error",
        stderrTail: "Individual quota reached.",
        agyError: exit0,
      }),
    ).toBe("quota-exhausted");
  });

  it("recognises refusal text and rejects unrelated text", () => {
    expect(isContentFilterText(exit0)).toBe(true);
    expect(isContentFilterText(exit3)).toBe(true);
    expect(isContentFilterText("The diff looks fine, no findings.")).toBe(
      false,
    );
    expect(isContentFilterText("")).toBe(false);
  });
});
