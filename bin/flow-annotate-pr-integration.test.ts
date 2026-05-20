/**
 * Integration tests exercising the full annotator flow end-to-end with
 * synthetic diff inputs. Tests the composition of parseDiff → buildEnvelope
 * → (consumable-by-flow-post-findings Finding[]).
 *
 * No real git/gh invocation — all inputs are synthetic diff strings.
 */

import { describe, expect, it } from "vitest";
import {
  buildEnvelope,
  HUNK_LOC_THRESHOLD,
  MAX_ANNOTATIONS_PER_PR,
  parseDiff,
  rankAndCap,
  dedupPerFile,
} from "./flow-annotate-pr";
import { parseFindings, type Finding } from "./flow-post-findings";

// --- Synthetic diff builders ---

function multiHunkDiff(
  file: string,
  hunks: Array<{
    oldStart: number;
    newStart: number;
    minuses: number;
    pluses: number;
  }>,
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

// --- Tests ---

describe("integration: full annotator flow", () => {
  it("path 1 — cap-fires: 12-hunk diff yields exactly 8 candidates with overflowBullet", () => {
    // 12 files each with a single 12-LOC pure-addition hunk → rule (a) on each.
    const parts: string[] = [];
    for (let i = 0; i < 12; i++) {
      const name = `f${String(i).padStart(2, "0")}.ts`;
      parts.push(
        multiHunkDiff(name, [{ oldStart: 1, newStart: 1, minuses: 0, pluses: 12 }]),
      );
    }
    const files = parseDiff(parts.join("\n"));
    const envelope = buildEnvelope(files);
    expect(envelope.candidates).toHaveLength(MAX_ANNOTATIONS_PER_PR);
    expect(envelope.overflowBullet).toBeDefined();
    expect(envelope.overflowBullet).toContain("4 additional hunks");
  });

  it("path 2 — no-match-empty: small-hunks diff yields empty candidates, no overflowBullet", () => {
    const diff = multiHunkDiff("small.ts", [
      { oldStart: 1, newStart: 1, minuses: 1, pluses: 2 },
      { oldStart: 10, newStart: 10, minuses: 1, pluses: 2 },
    ]);
    const envelope = buildEnvelope(parseDiff(diff));
    expect(envelope.candidates).toEqual([]);
    expect(envelope.overflowBullet).toBeUndefined();
  });

  it("path 3 — multi-line range: hunk spanning 40 lines yields candidate with end_line set", () => {
    // 40 pure additions starting at line 100. Rule (a) matches (40 ≥ 10).
    // The anchor walker emits line=100, end_line=139 (RIGHT side).
    const diff = multiHunkDiff("big.ts", [
      { oldStart: 100, newStart: 100, minuses: 0, pluses: 40 },
    ]);
    const envelope = buildEnvelope(parseDiff(diff));
    expect(envelope.candidates).toHaveLength(1);
    const c = envelope.candidates[0];
    expect(c.line).toBe(100);
    expect(c.end_line).toBe(139); // 100 + 40 - 1
    expect(c.side).toBe("RIGHT");
  });

  it("path 4 — deletion-side: pure-deletion hunk yields candidate with side: 'LEFT'", () => {
    const diff = multiHunkDiff("removed.ts", [
      { oldStart: 50, newStart: 50, minuses: 12, pluses: 0 },
    ]);
    const envelope = buildEnvelope(parseDiff(diff));
    expect(envelope.candidates).toHaveLength(1);
    expect(envelope.candidates[0].side).toBe("LEFT");
    expect(envelope.candidates[0].line).toBe(50);
  });

  it("path 5 — priority-ranking cap selection: top-8 of 10 candidates selected per priority rule", () => {
    // 10 single-file hunks: sizes 25, 22, 20, 18, 15, 12, 11, 11, 11, 11.
    // Top 8 should be the four 11s + 12 + 15 + 18 + 20 + 22 + 25 minus the
    // two smallest 11s — actually top 8 by hunkLoc desc is:
    //   25, 22, 20, 18, 15, 12, 11, 11 (any two of the four 11s, tiebreaks
    //   by file alphabetical then line)
    const hunkSpecs = [
      { file: "a.ts", loc: 25 },
      { file: "b.ts", loc: 22 },
      { file: "c.ts", loc: 20 },
      { file: "d.ts", loc: 18 },
      { file: "e.ts", loc: 15 },
      { file: "f.ts", loc: 12 },
      { file: "g.ts", loc: 11 },
      { file: "h.ts", loc: 11 },
      { file: "i.ts", loc: 11 },
      { file: "j.ts", loc: 11 },
    ];
    // Each hunk is a pure addition with the named LOC (matches rule (a) for
    // loc ≥ 10, which all of these do).
    const parts = hunkSpecs.map((s) =>
      multiHunkDiff(s.file, [{ oldStart: 1, newStart: 1, minuses: 0, pluses: s.loc }]),
    );
    const files = parseDiff(parts.join("\n"));
    expect(hunkSpecs.every((s) => s.loc >= HUNK_LOC_THRESHOLD)).toBe(true);
    const candidates = dedupPerFile(files);
    expect(candidates).toHaveLength(10);
    const { kept, surplus } = rankAndCap(candidates);
    expect(kept).toHaveLength(MAX_ANNOTATIONS_PER_PR);
    expect(surplus).toBe(2);
    // The first six (largest) must be present in the kept set.
    const keptFiles = new Set(kept.map((c) => c.file));
    for (const must of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]) {
      expect(keptFiles.has(must)).toBe(true);
    }
    // Of the four 11-LOC hunks (g/h/i/j), only two survive — and they're
    // the alphabetically-earliest two (g.ts, h.ts) per the tiebreaker.
    expect(keptFiles.has("g.ts")).toBe(true);
    expect(keptFiles.has("h.ts")).toBe(true);
    expect(keptFiles.has("i.ts")).toBe(false);
    expect(keptFiles.has("j.ts")).toBe(false);
  });

  it("path 6 — round-trip with flow-post-findings: candidates JSON envelope can be consumed by parseFindings after adding a body", () => {
    const diff = multiHunkDiff("hello.ts", [
      { oldStart: 1, newStart: 1, minuses: 0, pluses: 12 },
    ]);
    const envelope = buildEnvelope(parseDiff(diff));
    expect(envelope.candidates).toHaveLength(1);
    // Caller adds a body field and pipes to flow-post-findings.
    const findingsJson = JSON.stringify(
      envelope.candidates.map((c) => ({
        file: c.file,
        line: c.line,
        ...(c.end_line !== undefined ? { end_line: c.end_line } : {}),
        side: c.side,
        body: "**why:** test rationale\n\n<!-- flow-intent-v1 -->",
      })),
    );
    const findings = parseFindings(findingsJson);
    expect(findings).toHaveLength(1);
    const f: Finding = findings[0];
    expect(f.file).toBe("hello.ts");
    expect(f.line).toBe(1);
    expect(f.side).toBe("RIGHT");
    expect(f.body).toContain("**why:** ");
    expect(f.body).toContain("<!-- flow-intent-v1 -->");
  });
});
