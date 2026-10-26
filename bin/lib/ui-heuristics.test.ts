import { describe, expect, it } from "vitest";

import {
  heuristicsProbeScript,
  judgeHeuristics,
  sectionsRestoreScript,
  sectionsScript,
  type HeuristicsCapture,
} from "./ui-heuristics";

function capture(over: Partial<HeuristicsCapture> = {}): HeuristicsCapture {
  return {
    innerWidth: 390,
    innerHeight: 844,
    scrollHeight: 6000,
    mainTextLength: 4000,
    hasDarkScheme: false,
    darkSchemeClass: null,
    bodyLuminance: 1,
    clippedText: [],
    leakedText: [],
    tallBlocks: [],
    anchorLandings: [],
    pastViewport: [],
    lowContrast: [],
    duplicateControls: [],
    repeatedText: [],
    crampedRows: [],
    headingScale: [],
    ...over,
  };
}

const phone = { name: "phone", width: 390 };

describe("probe scripts", () => {
  it.each([
    ["probe", heuristicsProbeScript],
    ["sections", sectionsScript],
    ["restore", sectionsRestoreScript],
  ])("%s parses as a self-contained arrow function", (_n, fn) => {
    const src = fn();
    expect(src.startsWith("() =>")).toBe(true);
    expect(() => new Function(`return (${src})`)).not.toThrow();
  });

  it("probe restores scroll in a finally and wraps cssRules access", () => {
    const src = heuristicsProbeScript();
    expect(src).toMatch(/finally\s*\{\s*window\.scrollTo/);
    expect(src).toMatch(/try \{ walk\(sh\.cssRules\)/);
  });
});

describe("judgeHeuristics", () => {
  it("classifies leaks, anchors and past-viewport as defects with class tags", () => {
    const v = judgeHeuristics(
      capture({
        leakedText: [{ sample: "undefined items", path: "p", kind: "token" }],
        anchorLandings: [{ href: "#a", targetTop: 10, chromeBottom: 56 }],
        pastViewport: [{ path: "div.wide", right: 500 }],
      }),
      phone,
      [],
    );
    expect(v.defects).toHaveLength(3);
    expect(v.defects[0]).toMatch(/^\[phone\] leak: token/);
    expect(v.defects[1]).toMatch(/^\[phone\] anchor: #a/);
    expect(v.defects[2]).toMatch(/^\[phone\] past-viewport: div\.wide/);
    expect(v.smells).toEqual([]);
  });

  it("allows an anchor within tolerance of the chrome", () => {
    const v = judgeHeuristics(
      capture({
        anchorLandings: [{ href: "#a", targetTop: 55, chromeBottom: 56 }],
      }),
      phone,
      [],
    );
    expect(v.defects).toEqual([]);
  });

  it("splits contrast into defect (<3) and smell (3 to AA)", () => {
    const v = judgeHeuristics(
      capture({
        lowContrast: [
          { path: "a", ratio: 2.1, large: false },
          { path: "b", ratio: 3.8, large: false },
          { path: "c", ratio: 3.2, large: true },
        ],
      }),
      phone,
      [],
    );
    expect(v.defects).toHaveLength(1);
    expect(v.smells).toHaveLength(1);
    expect(v.smells[0]).toContain("ratio 3.8");
  });

  it("skips contrast on a dark viewport whose body is still light", () => {
    const lowContrast = [{ path: "a", ratio: 1.5, large: false }];
    const skipped = judgeHeuristics(
      capture({ lowContrast, bodyLuminance: 0.9 }),
      { name: "phone-dark", width: 390, colorScheme: "dark" },
      [],
    );
    expect(skipped.defects).toEqual([]);
    expect(skipped.envSkips).toEqual(["[phone-dark] dark-scheme-not-applied"]);
    const applied = judgeHeuristics(
      capture({ lowContrast, bodyLuminance: 0.05 }),
      { name: "phone-dark", width: 390, colorScheme: "dark" },
      [],
    );
    expect(applied.defects).toHaveLength(1);
    expect(applied.envSkips).toEqual([]);
  });

  it("flags a wall only when both the height and page-share floors are met", () => {
    const wall = (height: number, scrollHeight: number) =>
      judgeHeuristics(
        capture({ scrollHeight, tallBlocks: [{ path: "section", height }] }),
        phone,
        [],
      ).smells;
    expect(wall(3000, 6000)).toHaveLength(1);
    expect(wall(2000, 3000)).toEqual([]);
    expect(wall(3000, 20000)).toEqual([]);
  });

  it("gates cramped rows on a phone-width viewport and on child count", () => {
    const row = {
      path: "nav",
      children: 4,
      minChildWidth: 60,
      truncated: false,
    };
    expect(
      judgeHeuristics(capture({ crampedRows: [row] }), phone, []).smells,
    ).toHaveLength(1);
    expect(
      judgeHeuristics(
        capture({ crampedRows: [row] }),
        { name: "desktop", width: 1280 },
        [],
      ).smells,
    ).toEqual([]);
    expect(
      judgeHeuristics(
        capture({
          crampedRows: [{ ...row, minChildWidth: 140, truncated: true }],
        }),
        phone,
        [],
      ).smells,
    ).toHaveLength(1);
    expect(
      judgeHeuristics(
        capture({ crampedRows: [{ ...row, minChildWidth: 140 }] }),
        phone,
        [],
      ).smells,
    ).toEqual([]);
  });

  it("flags flat hierarchy only at equal weight", () => {
    const s = (sameWeight: boolean) =>
      judgeHeuristics(
        capture({ headingScale: [{ pair: "h1>h2", ratio: 1.05, sameWeight }] }),
        phone,
        [],
      ).smells;
    expect(s(true)[0]).toMatch(/flat-hierarchy: h1>h2/);
    expect(s(false)).toEqual([]);
  });

  it("records duplicates, repeated and clipped text as smells", () => {
    const v = judgeHeuristics(
      capture({
        duplicateControls: [{ name: "save", role: "button", count: 3 }],
        repeatedText: [{ sample: "same words", count: 2 }],
        clippedText: [{ path: "h2", overflowPx: 12 }],
      }),
      phone,
      [],
    );
    expect(v.smells.map((m) => m.split(": ")[0])).toEqual([
      "[phone] duplicate",
      "[phone] repeated",
      "[phone] clipped",
    ]);
  });

  it("reports a viewport mismatch without dropping findings", () => {
    const v = judgeHeuristics(
      capture({
        innerWidth: 500,
        clippedText: [{ path: "h2", overflowPx: 12 }],
      }),
      phone,
      [],
    );
    expect(v.envSkips).toEqual([
      "[phone] viewport-mismatch: innerWidth 500 vs requested 390",
    ]);
    expect(v.smells).toHaveLength(1);
  });

  it("ignore patterns drop soft findings but never leak or past-viewport", () => {
    const v = judgeHeuristics(
      capture({
        clippedText: [{ path: "h2.title", overflowPx: 12 }],
        leakedText: [{ sample: "NaN total", path: "h2.title", kind: "token" }],
        pastViewport: [{ path: "h2.title", right: 500 }],
      }),
      phone,
      ["h2.title"],
    );
    expect(v.smells).toEqual([]);
    expect(v.defects).toHaveLength(2);
    expect(v.refusedIgnores).toEqual(["h2.title"]);
  });
});
