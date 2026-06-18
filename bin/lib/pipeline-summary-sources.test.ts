import { describe, expect, it } from "vitest";
import { renderPhases } from "./pipeline-summary-sources";

const iso = (s: number) =>
  new Date(Date.UTC(2026, 5, 17, 12, 0, s)).toISOString();

describe(renderPhases, () => {
  it("appends each phase's duration as the gap to the next entry", () => {
    const out = renderPhases([
      { phase: "planning", at: iso(0) },
      { phase: "reviewing", outcome: "clean", at: iso(192) },
      { phase: "merged", at: iso(237) },
    ]);
    // planning lasted 192s (3m12s); reviewing lasted 45s.
    expect(out[0]).toBe("planning (3m12s)");
    expect(out[1]).toBe("reviewing -> clean (45s)");
  });

  it("preserves the `phase -> outcome` text alongside the duration", () => {
    const out = renderPhases([
      { phase: "reviewing", outcome: "clean", at: iso(0) },
      { phase: "merged", at: iso(45) },
    ]);
    expect(out[0]).toBe("reviewing -> clean (45s)");
  });

  it("gives the final entry no duration suffix (no successor)", () => {
    const out = renderPhases([
      { phase: "planning", at: iso(0) },
      { phase: "merged", at: iso(60) },
    ]);
    expect(out[1]).toBe("merged");
  });

  it("renders a single-entry log with no suffix and no crash", () => {
    expect(renderPhases([{ phase: "planning", at: iso(0) }])).toEqual([
      "planning",
    ]);
  });

  it("omits the suffix when an adjacent `at` is unparseable", () => {
    const out = renderPhases([
      { phase: "planning", at: "not-a-date" },
      { phase: "reviewing", outcome: "clean", at: iso(60) },
      { phase: "merged", at: "also-bad" },
    ]);
    // planning: own `at` unparseable → no suffix.
    expect(out[0]).toBe("planning");
    // reviewing: next `at` unparseable → no suffix, text preserved.
    expect(out[1]).toBe("reviewing -> clean");
    // merged: final entry → no suffix.
    expect(out[2]).toBe("merged");
  });

  it("omits the suffix for an out-of-order (negative) delta", () => {
    const out = renderPhases([
      { phase: "planning", at: iso(192) },
      { phase: "reviewing", outcome: "clean", at: iso(0) },
    ]);
    expect(out[0]).toBe("planning");
  });

  it("omits the suffix for a zero-length delta", () => {
    const out = renderPhases([
      { phase: "planning", at: iso(0) },
      { phase: "reviewing", outcome: "clean", at: iso(0) },
    ]);
    expect(out[0]).toBe("planning");
  });

  it("returns `none` for an empty array", () => {
    expect(renderPhases([])).toEqual(["none"]);
  });

  it("returns `none` for a null phaseLog", () => {
    expect(renderPhases(null)).toEqual(["none"]);
  });
});
