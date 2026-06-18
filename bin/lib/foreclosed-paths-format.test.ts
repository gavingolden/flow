import { describe, expect, it } from "vitest";
import {
  collectForeclosedEntries,
  formatMarkdown,
  formatPlainText,
  isEmpty,
  FORECLOSED_HEADING,
} from "./foreclosed-paths-format";

const fixApplier = JSON.stringify({
  commits: [],
  deferred: [],
  rejected_alternatives: [
    {
      finding_id: "F1",
      considered_approach: "memoize the parser",
      why_rejected: "added cache-invalidation complexity for no measured win",
    },
  ],
  anti_patterns_found: [
    {
      location: "bin/lib/x.ts:42",
      pattern: "swallowed error in catch",
      recommendation: "log and rethrow",
      introduced_by_this_pr: false,
    },
    {
      location: "bin/lib/y.ts:10",
      pattern: "magic number",
      recommendation: "extract a named constant",
      introduced_by_this_pr: true,
    },
  ],
  summary: "s",
});

const consolidator = JSON.stringify({
  consolidated_findings: [],
  dropped_by_validation: [],
  rejected_alternatives: [
    "considered collapsing two lenses; kept them separate",
  ],
  anti_patterns_found: ["duplicated validation across three call sites"],
  summary: "s",
});

describe("collectForeclosedEntries — shared core", () => {
  it("flattens all four arrays in a stable order", () => {
    const entries = collectForeclosedEntries({
      fixApplierRaw: fixApplier,
      consolidatorRaw: consolidator,
    });
    expect(entries.map((e) => [e.source, e.category])).toEqual([
      ["fix-applier", "rejected-alternative"],
      ["fix-applier", "anti-pattern"],
      ["fix-applier", "anti-pattern"],
      ["consolidator", "rejected-alternative"],
      ["consolidator", "anti-pattern"],
    ]);
  });

  it("yields an empty entry set for absent/empty inputs", () => {
    expect(
      isEmpty(
        collectForeclosedEntries({ fixApplierRaw: "", consolidatorRaw: "" }),
      ),
    ).toBe(true);
    const bothEmptyArrays = JSON.stringify({
      commits: [],
      deferred: [],
      rejected_alternatives: [],
      anti_patterns_found: [],
      summary: "s",
    });
    expect(
      isEmpty(
        collectForeclosedEntries({
          fixApplierRaw: bothEmptyArrays,
          consolidatorRaw: "",
        }),
      ),
    ).toBe(true);
  });
});

describe("both modes share one core", () => {
  it("markdown and plaintext cover the identical entry set + order", () => {
    const inputs = { fixApplierRaw: fixApplier, consolidatorRaw: consolidator };
    const entries = collectForeclosedEntries(inputs);
    const md = formatMarkdown(inputs);
    const pt = formatPlainText(inputs);
    // Both surfaces render the same prose tokens in the same order.
    const considered = "memoize the parser";
    const lastConsolidator = "duplicated validation across three call sites";
    expect(md.join("\n")).toContain(considered);
    expect(pt.join("\n")).toContain(considered);
    expect(md.indexOf(md.find((l) => l.includes(considered))!)).toBeLessThan(
      md.indexOf(md.find((l) => l.includes(lastConsolidator))!),
    );
    expect(pt.indexOf(pt.find((l) => l.includes(considered))!)).toBeLessThan(
      pt.indexOf(pt.find((l) => l.includes(lastConsolidator))!),
    );
    // The plain-text mode emits no markdown heading; markdown leads with one.
    expect(md[0]).toBe(FORECLOSED_HEADING);
    expect(pt.some((l) => l === FORECLOSED_HEADING)).toBe(false);
    expect(entries.length).toBeGreaterThan(0);
  });
});

describe("full prose present", () => {
  it("renders fix-applier rejected alternatives with considered_approach + why_rejected", () => {
    const md = formatMarkdown({
      fixApplierRaw: fixApplier,
      consolidatorRaw: "",
    }).join("\n");
    expect(md).toContain("memoize the parser");
    expect(md).toContain(
      "added cache-invalidation complexity for no measured win",
    );
    expect(md).toContain("`F1`");
  });

  it("renders anti-patterns with location/pattern/recommendation + introduced annotation", () => {
    const md = formatMarkdown({
      fixApplierRaw: fixApplier,
      consolidatorRaw: "",
    }).join("\n");
    expect(md).toContain("bin/lib/x.ts:42");
    expect(md).toContain("swallowed error in catch");
    expect(md).toContain("log and rethrow");
    expect(md).toContain("(pre-existing)");
    expect(md).toContain("(new)");
  });

  it("renders consolidator string[] entries verbatim", () => {
    const md = formatMarkdown({
      fixApplierRaw: "",
      consolidatorRaw: consolidator,
    }).join("\n");
    expect(md).toContain(
      "considered collapsing two lenses; kept them separate",
    );
    expect(md).toContain("duplicated validation across three call sites");
  });
});

describe("markdown safety", () => {
  it("a consolidator string with a leading '## ' does not emit a bare heading line", () => {
    const injected = JSON.stringify({
      consolidated_findings: [],
      dropped_by_validation: [],
      rejected_alternatives: ["## not actually a heading"],
      anti_patterns_found: [],
      summary: "s",
    });
    const md = formatMarkdown({ fixApplierRaw: "", consolidatorRaw: injected });
    // The only bare '^## ' line allowed is the section heading itself.
    const headingLines = md.filter((l) => /^## /.test(l));
    expect(headingLines).toEqual([FORECLOSED_HEADING]);
    // The injected content survives (escaped), just not as a heading.
    expect(md.join("\n")).toContain("not actually a heading");
  });
});

describe("degraded artifacts", () => {
  it("a malformed fix-applier artifact degrades to (unreadable) while consolidator still renders", () => {
    const md = formatMarkdown({
      fixApplierRaw: "{not json",
      consolidatorRaw: consolidator,
    }).join("\n");
    expect(md).toContain("fix-applier: (unreadable)");
    expect(md).toContain("duplicated validation across three call sites");
  });
});
