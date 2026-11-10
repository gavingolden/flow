import { describe, expect, it } from "vitest";
import {
  FALLBACK_PROMPT_DIRECTIVE,
  buildFallbackArgv,
  buildFallbackPrompt,
  decideFallback,
  fallbackModelLabel,
  isClaudeFallbackEnabled,
  mapFallbackSkipReason,
} from "./plan-review-fallback";

describe("isClaudeFallbackEnabled", () => {
  it.each([
    ["empty", "", true],
    ["unparseable", "{nope", true],
    ["absent key", JSON.stringify({ review: { gemini: true } }), true],
    ["no review", JSON.stringify({}), true],
    ["non-object", "42", true],
    [
      "true",
      JSON.stringify({ review: { planReviewClaudeFallback: true } }),
      true,
    ],
    [
      "false",
      JSON.stringify({ review: { planReviewClaudeFallback: false } }),
      false,
    ],
    [
      "non-boolean",
      JSON.stringify({ review: { planReviewClaudeFallback: "no" } }),
      true,
    ],
  ])("should handle %s", (_n, raw, want) => {
    expect(isClaudeFallbackEnabled(raw)).toBe(want);
  });
});

const base = {
  enabled: true,
  reviewer1Engaged: true,
  agyEntry: { ran: false, skipReason: "agy-error", durationMs: 4386 },
  agyElapsedSecFallback: 0,
  slotSec: 900,
  capRemainingSec: 1980,
};

describe("decideFallback", () => {
  it("should let disabled win over reviewer-1-down", () => {
    expect(
      decideFallback({ ...base, enabled: false, reviewer1Engaged: false }),
    ).toEqual({ run: false, reason: "fallback-disabled" });
  });

  it.each([
    "agy-not-found",
    "agy-not-authenticated",
    "agy-model-unavailable",
    "agy-error",
    "agy-empty-artifact",
    "spawn-failed",
    "agy-timeout",
  ])("should run for eligible %s", (skipReason) => {
    expect(
      decideFallback({
        ...base,
        agyEntry: { ran: false, skipReason, durationMs: 4386 },
      }).run,
    ).toBe(true);
  });

  it("should skip when reviewer 1 is down", () => {
    expect(decideFallback({ ...base, reviewer1Engaged: false })).toEqual({
      run: false,
      reason: "fallback-reviewer-1-down",
    });
  });

  it.each([
    ["missing entry", undefined],
    ["ran entry", { ran: true }],
    ["agy-canceled", { ran: false, skipReason: "agy-canceled" }],
    ["agy-cooldown", { ran: false, skipReason: "agy-cooldown" }],
  ])("should be ineligible for %s", (_n, agyEntry) => {
    expect(decideFallback({ ...base, agyEntry })).toEqual({
      run: false,
      reason: "fallback-ineligible",
    });
  });

  it("should run with the slot remainder after a quick quota failure", () => {
    expect(decideFallback(base)).toEqual({ run: true, timeoutSec: 895 });
  });

  it("should subtract an agy timeout from the slot", () => {
    expect(
      decideFallback({
        ...base,
        agyEntry: { ran: false, skipReason: "agy-timeout", durationMs: 155000 },
      }),
    ).toEqual({ run: true, timeoutSec: 745 });
  });

  it("should report no-budget when agy used most of the slot", () => {
    expect(
      decideFallback({
        ...base,
        agyEntry: { ran: false, skipReason: "agy-error", durationMs: 700000 },
      }),
    ).toEqual({ run: false, reason: "fallback-no-budget" });
  });

  it("should use the elapsed fallback when durationMs is absent", () => {
    expect(
      decideFallback({
        ...base,
        agyEntry: { ran: false, skipReason: "agy-error" },
        agyElapsedSecFallback: 700,
      }),
    ).toEqual({ run: false, reason: "fallback-no-budget" });
  });

  it("should reserve the cap margin", () => {
    expect(decideFallback({ ...base, capRemainingSec: 300 })).toEqual({
      run: false,
      reason: "fallback-no-budget",
    });
  });

  it("should let the remaining cap bind the timeout", () => {
    expect(decideFallback({ ...base, capRemainingSec: 500 })).toEqual({
      run: true,
      timeoutSec: 440,
    });
  });
});

describe("buildFallbackArgv", () => {
  it("should build the exact pinned argv", () => {
    expect(
      buildFallbackArgv({
        promptPath: "/p",
        out: "/o",
        task: "t",
        timeoutSec: 800,
      }),
    ).toEqual([
      "--prompt-file",
      "/p",
      "--model",
      "opus",
      "--effort",
      "high",
      "--tools",
      "Read,Grep,Glob",
      "--allowed-tools",
      "Read,Grep,Glob",
      "--max-budget-usd",
      "3",
      "--max-turns",
      "25",
      "--timeout-sec",
      "800",
      "--task",
      "t",
      "--out",
      "/o",
    ]);
  });
});

describe("mapFallbackSkipReason", () => {
  it("should map the three cases", () => {
    expect(mapFallbackSkipReason("claude-timeout")).toBe("reviewer-timeout");
    expect(mapFallbackSkipReason(undefined)).toBe("claude-error");
    expect(mapFallbackSkipReason("headless-depth-exceeded")).toBe(
      "headless-depth-exceeded",
    );
  });
});

describe("fallbackModelLabel", () => {
  it("should always name Claude", () => {
    expect(fallbackModelLabel("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(fallbackModelLabel("opus")).toBe("claude-opus");
    expect(fallbackModelLabel(undefined)).toBe("claude-opus");
    expect(fallbackModelLabel("")).toBe("claude-opus");
  });
});

describe("buildFallbackPrompt", () => {
  it("should prepend the directive and keep the prompt verbatim", () => {
    const out = buildFallbackPrompt("REVIEWER TWO PROMPT\nline");
    expect(out.startsWith(FALLBACK_PROMPT_DIRECTIVE)).toBe(true);
    expect(out.endsWith("REVIEWER TWO PROMPT\nline")).toBe(true);
    expect(FALLBACK_PROMPT_DIRECTIVE).toContain(
      "emit each lens as it is finished",
    );
    expect(FALLBACK_PROMPT_DIRECTIVE).toContain("overrides");
  });
});
