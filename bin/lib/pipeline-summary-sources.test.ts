import { describe, expect, it } from "vitest";
import {
  renderForeclosedPaths,
  renderPhases,
} from "./pipeline-summary-sources";

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

const fixApplier = JSON.stringify({
  commits: [],
  deferred: [],
  rejected_alternatives: [
    {
      finding_id: "F1",
      considered_approach: "memoize the parser",
      why_rejected: "cache-invalidation complexity",
    },
  ],
  anti_patterns_found: [
    {
      location: "bin/lib/x.ts:42",
      pattern: "swallowed error",
      recommendation: "log and rethrow",
      introduced_by_this_pr: true,
    },
  ],
  summary: "s",
});

const consolidator = JSON.stringify({
  consolidated_findings: [],
  dropped_by_validation: [],
  rejected_alternatives: ["kept the two lenses separate"],
  anti_patterns_found: [],
  summary: "s",
});

describe("renderForeclosedPaths", () => {
  it("returns prose lines for present artifacts (both shapes)", () => {
    const lines = renderForeclosedPaths({
      fixApplierRaw: fixApplier,
      consolidatorRaw: consolidator,
    });
    const joined = lines.join("\n");
    expect(joined).toContain("memoize the parser");
    expect(joined).toContain("cache-invalidation complexity");
    expect(joined).toContain("swallowed error");
    expect(joined).toContain("(new)");
    expect(joined).toContain("kept the two lenses separate");
    // Plain-text mode: no markdown heading line.
    expect(lines).not.toContain("## Foreclosed Paths");
  });

  it("returns ['none'] for empty inputs", () => {
    expect(
      renderForeclosedPaths({ fixApplierRaw: "", consolidatorRaw: "" }),
    ).toEqual(["none"]);
  });

  it("returns ['none'] for artifacts with empty arrays", () => {
    const empty = JSON.stringify({
      commits: [],
      deferred: [],
      rejected_alternatives: [],
      anti_patterns_found: [],
      summary: "s",
    });
    expect(
      renderForeclosedPaths({ fixApplierRaw: empty, consolidatorRaw: "" }),
    ).toEqual(["none"]);
  });

  it("degrades a malformed artifact to (unreadable) while the other source renders", () => {
    const lines = renderForeclosedPaths({
      fixApplierRaw: "{not json",
      consolidatorRaw: consolidator,
    });
    const joined = lines.join("\n");
    expect(joined).toContain("fix-applier: (unreadable)");
    expect(joined).toContain("kept the two lenses separate");
  });
});
