/**
 * Tests for flow-annotate-pr.ts — pure synthetic-diff inputs. No real git
 * invocation. Covers acceptance criteria from plan Task 1.
 */

import { describe, expect, it } from "vitest";
import {
  buildEnvelope,
  countHunkLoc,
  dedupPerFile,
  FILE_LOC_THRESHOLD,
  HUNK_LOC_THRESHOLD,
  MAX_ANNOTATIONS_PER_PR,
  overflowPointer,
  parseDiff,
  rankAndCap,
  RESTRUCTURE_MINUS_MIN,
  RESTRUCTURE_PLUS_MIN,
  RULE_C_MIN_HUNK_LOC,
} from "./flow-annotate-pr";
import type { Finding } from "./flow-post-findings";

// --- Diff builders ---

/** Builds a single-file diff with N pure-addition lines starting at `newStart`. */
function pureAddition(file: string, newStart: number, count: number): string {
  const additions = Array.from({ length: count }, (_, i) => `+added line ${i + 1}`).join("\n");
  return [
    `diff --git a/${file} b/${file}`,
    "--- a/" + file,
    "+++ b/" + file,
    `@@ -${newStart},0 +${newStart},${count} @@`,
    additions,
  ].join("\n");
}

/** Builds a single mixed-add-delete hunk with `pluses` + and `minuses` - lines. */
function mixedHunk(
  file: string,
  oldStart: number,
  newStart: number,
  minuses: number,
  pluses: number,
): string {
  const minusLines = Array.from({ length: minuses }, (_, i) => `-removed ${i + 1}`).join("\n");
  const plusLines = Array.from({ length: pluses }, (_, i) => `+added ${i + 1}`).join("\n");
  return [
    `diff --git a/${file} b/${file}`,
    "--- a/" + file,
    "+++ b/" + file,
    `@@ -${oldStart},${minuses} +${newStart},${pluses} @@`,
    minusLines,
    plusLines,
  ].join("\n");
}

/** Builds a single pure-deletion hunk. */
function pureDeletion(file: string, oldStart: number, count: number): string {
  const lines = Array.from({ length: count }, (_, i) => `-removed ${i + 1}`).join("\n");
  return [
    `diff --git a/${file} b/${file}`,
    "--- a/" + file,
    "+++ b/" + file,
    `@@ -${oldStart},${count} +${oldStart},0 @@`,
    lines,
  ].join("\n");
}

/** Composes a multi-hunk diff for a single file. */
function multiHunk(
  file: string,
  hunks: Array<{ oldStart: number; newStart: number; minuses: number; pluses: number }>,
): string {
  const out: string[] = [
    `diff --git a/${file} b/${file}`,
    "--- a/" + file,
    "+++ b/" + file,
  ];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.minuses} +${h.newStart},${h.pluses} @@`);
    for (let i = 0; i < h.minuses; i++) out.push(`-removed ${i + 1}`);
    for (let i = 0; i < h.pluses; i++) out.push(`+added ${i + 1}`);
  }
  return out.join("\n");
}

// --- parseDiff ---

describe(parseDiff, () => {
  it("parses `@@ -OLD,N +NEW,N @@` headers", () => {
    const diff = pureAddition("a.ts", 10, 5);
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].file).toBe("a.ts");
    expect(files[0].hunks).toHaveLength(1);
    expect(files[0].hunks[0].newStart).toBe(10);
    expect(files[0].hunks[0].newCount).toBe(5);
  });

  it("parses `@@ -OLD +NEW @@` (single-line) headers", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -3 +3 @@",
      "-old",
      "+new",
    ].join("\n");
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].hunks[0].oldStart).toBe(3);
    expect(files[0].hunks[0].oldCount).toBe(1);
    expect(files[0].hunks[0].newStart).toBe(3);
    expect(files[0].hunks[0].newCount).toBe(1);
  });

  it("captures + and - lines but excludes file-path markers", () => {
    const diff = mixedHunk("a.ts", 1, 1, 2, 3);
    const files = parseDiff(diff);
    const lines = files[0].hunks[0].lines;
    expect(lines.filter((l) => l.kind === "+")).toHaveLength(3);
    expect(lines.filter((l) => l.kind === "-")).toHaveLength(2);
    // No "+++"/"---" file-path markers should leak through as + or - lines.
    expect(lines.some((l) => l.text.startsWith("+ a/"))).toBe(false);
  });

  it("returns empty array on empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });
});

// --- countHunkLoc ---

describe(countHunkLoc, () => {
  it("counts + and - but ignores context", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,4 @@",
      " context",
      "-old",
      "+new1",
      "+new2",
    ].join("\n");
    const files = parseDiff(diff);
    expect(countHunkLoc(files[0].hunks[0])).toBe(3);
  });
});

// --- evaluateTrigger (rule (a) and (b) via dedupPerFile) ---

describe("rule (a): hunk LOC >= 10", () => {
  it("fires on a single 12-LOC pure-addition hunk → 1 candidate", () => {
    const diff = pureAddition("a.ts", 1, 12);
    const files = parseDiff(diff);
    const candidates = dedupPerFile(files);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].file).toBe("a.ts");
    expect(candidates[0].side).toBe("RIGHT");
  });

  it("does NOT fire on a hunk just below threshold", () => {
    const diff = pureAddition("a.ts", 1, HUNK_LOC_THRESHOLD - 1);
    const files = parseDiff(diff);
    const candidates = dedupPerFile(files);
    expect(candidates).toHaveLength(0);
  });
});

describe("rule (b): mixed restructure", () => {
  it("fires on a 4+/4- mixed hunk → 1 candidate", () => {
    const diff = mixedHunk("a.ts", 1, 1, RESTRUCTURE_MINUS_MIN, RESTRUCTURE_PLUS_MIN);
    const files = parseDiff(diff);
    const candidates = dedupPerFile(files);
    expect(candidates).toHaveLength(1);
    // Anchor side is RIGHT because there are + lines present.
    expect(candidates[0].side).toBe("RIGHT");
  });

  it("does NOT fire on a 3+/3- mixed hunk (below restructure threshold AND below LOC threshold)", () => {
    const diff = mixedHunk("a.ts", 1, 1, 3, 3);
    const files = parseDiff(diff);
    const candidates = dedupPerFile(files);
    expect(candidates).toHaveLength(0);
  });
});

describe("rule (c): file LOC >= 30 with per-file dedup", () => {
  it("collapses a 60-LOC file with 8 small (<10-LOC, no restructure) hunks to 1 candidate on the first non-trivial hunk", () => {
    // 8 small hunks, each with 7 changed LOC (no restructure) = 56 LOC. None
    // match rule (a) (<10) or rule (b) (<4+ or <4-). The first one of LOC ≥
    // RULE_C_MIN_HUNK_LOC=5 fires rule (c); subsequent ones do not.
    const hunks = Array.from({ length: 8 }, (_, i) => ({
      oldStart: i * 20 + 1,
      newStart: i * 20 + 1,
      minuses: 3,
      pluses: 4, // 7 LOC, no restructure (3 < 4)
    }));
    const diff = multiHunk("a.ts", hunks);
    const files = parseDiff(diff);
    // Verify the file is over the threshold so rule (c) is eligible.
    let fileLoc = 0;
    for (const h of files[0].hunks) fileLoc += countHunkLoc(h);
    expect(fileLoc).toBeGreaterThanOrEqual(FILE_LOC_THRESHOLD);
    const candidates = dedupPerFile(files);
    expect(candidates).toHaveLength(1);
    // Anchored on the first hunk.
    expect(candidates[0].line).toBe(1);
  });

  it("does NOT fire rule (c) on a file below FILE_LOC_THRESHOLD", () => {
    // 5 hunks × 5 LOC = 25, below 30.
    const hunks = Array.from({ length: 5 }, (_, i) => ({
      oldStart: i * 20 + 1,
      newStart: i * 20 + 1,
      minuses: 2,
      pluses: 3,
    }));
    const diff = multiHunk("a.ts", hunks);
    const files = parseDiff(diff);
    const candidates = dedupPerFile(files);
    expect(candidates).toHaveLength(0);
  });

  it("rule (c) skips trivially-small first hunks (LOC < RULE_C_MIN_HUNK_LOC)", () => {
    // First hunk is too small for rule (c); the second one (still small but
    // ≥ RULE_C_MIN_HUNK_LOC) becomes the rule-c candidate.
    const hunks = [
      { oldStart: 1, newStart: 1, minuses: 1, pluses: 1 }, // 2 LOC, too small
      { oldStart: 20, newStart: 20, minuses: 3, pluses: 4 }, // 7 LOC, qualifies
      { oldStart: 50, newStart: 50, minuses: 3, pluses: 4 }, // 7 LOC, won't fire (dedup)
      { oldStart: 80, newStart: 80, minuses: 3, pluses: 4 }, // 7 LOC, won't fire (dedup)
      { oldStart: 110, newStart: 110, minuses: 3, pluses: 4 }, // 7 LOC, won't fire (dedup)
    ];
    const diff = multiHunk("a.ts", hunks);
    const files = parseDiff(diff);
    const candidates = dedupPerFile(files);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].line).toBe(20);
  });

  it("rules (a)/(b) still fire on all matching hunks in a ≥30-LOC file (rule c dedup only applies to rule c)", () => {
    // One hunk matches rule (a) (12 LOC pure addition), three other small
    // hunks bring file total above 30. Rule (a) fires on the big one; rule
    // (c) fires on the first small hunk that is ≥ 5 LOC and didn't already
    // match (a)/(b).
    const hunks = [
      { oldStart: 1, newStart: 1, minuses: 0, pluses: 12 }, // 12 LOC — rule (a)
      { oldStart: 50, newStart: 70, minuses: 3, pluses: 4 }, // 7 LOC — rule (c) eligible
      { oldStart: 100, newStart: 120, minuses: 3, pluses: 4 }, // skipped (rule c dedup)
      { oldStart: 150, newStart: 170, minuses: 3, pluses: 4 }, // skipped
    ];
    const diff = multiHunk("a.ts", hunks);
    const files = parseDiff(diff);
    const candidates = dedupPerFile(files);
    // 1 from rule (a), 1 from rule (c) = 2 candidates
    expect(candidates).toHaveLength(2);
  });
});

describe("no-match case", () => {
  it("5 small hunks across 3 small files → empty candidates array", () => {
    // Files below FILE_LOC_THRESHOLD with small hunks below all rule thresholds.
    const a = multiHunk("a.ts", [{ oldStart: 1, newStart: 1, minuses: 1, pluses: 2 }]);
    const b = multiHunk("b.ts", [
      { oldStart: 1, newStart: 1, minuses: 1, pluses: 2 },
      { oldStart: 10, newStart: 10, minuses: 1, pluses: 2 },
    ]);
    const c = multiHunk("c.ts", [
      { oldStart: 1, newStart: 1, minuses: 1, pluses: 2 },
      { oldStart: 10, newStart: 10, minuses: 1, pluses: 2 },
    ]);
    const diff = [a, b, c].join("\n");
    const files = parseDiff(diff);
    const envelope = buildEnvelope(files);
    expect(envelope.candidates).toEqual([]);
    expect(envelope.overflowBullet).toBeUndefined();
  });
});

// --- Cap & overflow ---

describe(rankAndCap, () => {
  it("cap-overflow: 12 matched hunks → exactly 8 returned, overflowBullet present", () => {
    // 12 separate files, each with a single 12-LOC pure-addition hunk
    // matching rule (a). All have identical _hunkLoc=12 and
    // _restructure=0, so path-alphabetical and line tie-break.
    const parts: string[] = [];
    for (let i = 0; i < 12; i++) {
      // File names a00.ts ... a11.ts so the alphabetical tie-break is
      // deterministic.
      const name = `a${String(i).padStart(2, "0")}.ts`;
      parts.push(pureAddition(name, 1, 12));
    }
    const diff = parts.join("\n");
    const files = parseDiff(diff);
    const envelope = buildEnvelope(files);
    expect(envelope.candidates).toHaveLength(MAX_ANNOTATIONS_PER_PR);
    expect(envelope.overflowBullet).toBe(overflowPointer(12 - MAX_ANNOTATIONS_PER_PR));
  });

  it("priority tie-break: two hunks both 15-LOC, the higher min(+,-) wins", () => {
    // hunk-α: 15-LOC pure addition (0/15 → restructure=0)
    // hunk-β: 7+/8- (15 LOC, restructure=7)
    // Both match rule (a). Beta should rank first.
    const alpha = pureAddition("a-alpha.ts", 1, 15);
    const beta = mixedHunk("b-beta.ts", 1, 1, 8, 7);
    const diff = [alpha, beta].join("\n");
    const files = parseDiff(diff);
    const { kept } = rankAndCap(dedupPerFile(files));
    expect(kept[0].file).toBe("b-beta.ts");
    expect(kept[1].file).toBe("a-alpha.ts");
  });
});

// --- Anchor rule ---

describe("anchor rule", () => {
  it("mixed-add-delete hunk → first + line with side: RIGHT", () => {
    // Use 4+/4- so rule (b) matches without depending on rule (a).
    const diff = mixedHunk("a.ts", 1, 100, 4, 4);
    const files = parseDiff(diff);
    const candidates = dedupPerFile(files);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].side).toBe("RIGHT");
    // newStart=100; the first + line in post-image coords is at line 100.
    expect(candidates[0].line).toBe(100);
  });

  it("pure-deletion hunk → first - line with side: LEFT", () => {
    // Pure-deletion needs ≥ HUNK_LOC_THRESHOLD to fire rule (a) at all.
    const diff = pureDeletion("a.ts", 50, 12);
    const files = parseDiff(diff);
    const candidates = dedupPerFile(files);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].side).toBe("LEFT");
    expect(candidates[0].line).toBe(50);
    expect(candidates[0].end_line).toBe(50 + 12 - 1); // multi-line
  });
});

// --- Envelope shape ---

describe(buildEnvelope, () => {
  it("candidates carry NO body field (agent fills)", () => {
    const diff = pureAddition("a.ts", 1, 12);
    const envelope = buildEnvelope(parseDiff(diff));
    expect(envelope.candidates).toHaveLength(1);
    expect((envelope.candidates[0] as Record<string, unknown>).body).toBeUndefined();
  });

  it("candidate + body string is Finding-compatible", () => {
    const diff = pureAddition("a.ts", 1, 12);
    const envelope = buildEnvelope(parseDiff(diff));
    const c = envelope.candidates[0];
    const finding: Finding = {
      file: c.file,
      line: c.line,
      ...(c.end_line !== undefined ? { end_line: c.end_line } : {}),
      side: c.side,
      body: "**why:** something\n\n<!-- flow-intent-v1 -->",
    };
    // Compile-time check; runtime sanity:
    expect(finding.file).toBe("a.ts");
    expect(finding.body.startsWith("**why:** ")).toBe(true);
  });
});

// --- overflowPointer text ---

describe(overflowPointer, () => {
  it("renders the documented surplus message", () => {
    expect(overflowPointer(3)).toBe(
      "- 3 additional hunks exceeded the inline cap — see commit messages for details.",
    );
  });
});
