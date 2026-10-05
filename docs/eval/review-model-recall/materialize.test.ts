import { describe, expect, it } from "vitest";
import {
  capDiff,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_TOTAL,
} from "../../../bin/flow-pr-diff";
import {
  actedIndices,
  isFixApplierSubject,
  isReviewFinding,
} from "./materialize";

describe("reference set", () => {
  it("keeps labelled review findings, including praise and decorated labels", () => {
    expect(isReviewFinding("**issue:** off by one")).toBe(true);
    expect(isReviewFinding("**praise:** clean")).toBe(true);
    expect(isReviewFinding("**suggestion (non-blocking):** rename")).toBe(true);
  });

  it("drops author-intent annotations and unlabelled bot or human remarks", () => {
    expect(isReviewFinding("**why:** mirrors the helper")).toBe(false);
    expect(isReviewFinding("This retry contradicts the stale check")).toBe(
      false,
    );
  });
});

describe("production diff cap", () => {
  it("the production capDiff that materialize uses caps per file and in total", () => {
    const block = (n: string) =>
      `diff --git a/${n} b/${n}\n${Array.from({ length: 400 }, (_, i) => `+l${i}`).join("\n")}\n`;
    const diff = Array.from({ length: 30 }, (_, i) => block(`f${i}`)).join("");
    const out = capDiff(diff, DEFAULT_MAX_LINES, DEFAULT_MAX_TOTAL, 12);
    expect(out).toContain("full diff: gh pr diff 12");
    expect(out).toMatch(/additional file\(s\) omitted/);
  });
});

describe("acted proxy", () => {
  it("marks a reference acted when its path was touched by a fix commit", () => {
    const refs = [
      { path: "a.ts", line: 1, body: "x" },
      { path: "b.ts", line: 2, body: "y" },
    ];
    expect(actedIndices(refs, new Set(["b.ts"]))).toEqual([2]);
  });

  it("recognises only this PR's fix-applier commit subjects", () => {
    expect(
      isFixApplierSubject("fix: close findings (pr-review #12)", "12"),
    ).toBe(true);
    expect(
      isFixApplierSubject("fix: close findings (pr-review #13)", "12"),
    ).toBe(false);
    expect(isFixApplierSubject("fix: plain", "12")).toBe(false);
  });
});
