import { describe, expect, it } from "vitest";
import { actedIndices, isFixApplierSubject, truncateDiff } from "./materialize";

describe("truncateDiff", () => {
  it("keeps head 200 + marker + tail 100 for a file block over 300 lines", () => {
    const body = Array.from({ length: 400 }, (_, i) => `+l${i}`).join("\n");
    const out = truncateDiff(`diff --git a/x b/x\n${body}\n`);
    expect(out).toContain("... [truncated");
    expect(out).toContain("+l0");
    expect(out).toContain("+l399");
    expect(out).not.toContain("+l250\n");
  });

  it("leaves a short block untouched", () => {
    const d = "diff --git a/x b/x\n+a\n";
    expect(truncateDiff(d)).toBe(d);
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
