import { describe, expect, it } from "vitest";
import {
  collectForeclosedEntries,
  formatMarkdown,
  formatPlainText,
  isEmpty,
  FORECLOSED_HEADING,
} from "./foreclosed-paths-format";
import { upsertPrBodySection } from "./pr-body-upsert";

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

// Valid commits/deferred/rejected_alternatives, but one anti_patterns_found
// entry is missing `introduced_by_this_pr` (the econ-data #346 regression). The
// valid prose must still render; the bad entry contributes a residual marker.
const fixApplierOneBadEntry = JSON.stringify({
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
      // introduced_by_this_pr intentionally absent — off-shape entry.
    },
  ],
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

  it("renders the identical valid entry set + residual marker through both modes for the one-bad-entry fixture", () => {
    const inputs = {
      fixApplierRaw: fixApplierOneBadEntry,
      consolidatorRaw: consolidator,
    };
    const md = formatMarkdown(inputs);
    const pt = formatPlainText(inputs);
    // The valid rejected-alternative + the consolidator prose survive in both.
    for (const surface of [md, pt]) {
      const joined = surface.join("\n");
      expect(joined).toContain("memoize the parser");
      expect(joined).toContain(
        "added cache-invalidation complexity for no measured win",
      );
      expect(joined).toContain("duplicated validation across three call sites");
      // The off-shape anti-pattern is surfaced as a residual marker, not a
      // whole-source (unreadable) degradation.
      expect(joined).toContain("(1 unreadable)");
      expect(joined).not.toContain("fix-applier: (unreadable)");
    }
    // Cross-surface drift guard: both modes derive from the same collected
    // entry set, so the ordered (source, category) sequence is identical.
    const entries = collectForeclosedEntries(inputs);
    expect(entries.map((e) => [e.source, e.category, e.skipped ?? 0])).toEqual([
      ["fix-applier", "rejected-alternative", 0],
      ["fix-applier", "anti-pattern", 1],
      ["consolidator", "rejected-alternative", 0],
      ["consolidator", "anti-pattern", 0],
    ]);
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
  // The only bare '^## ' line a rendered section may contain is the section
  // heading itself; any other one breaks upsertPrBodySection's next-'^## '
  // splice on the idempotent re-parse. Join + re-split so an array element that
  // itself contains an embedded '\n## ' is caught as a true physical line.
  const bareHeadingLines = (md: string[]) =>
    md
      .join("\n")
      .split("\n")
      .filter((l) => /^## /.test(l));

  it("a consolidator string with a leading '## ' does not emit a bare heading line", () => {
    const injected = JSON.stringify({
      consolidated_findings: [],
      dropped_by_validation: [],
      rejected_alternatives: ["## not actually a heading"],
      anti_patterns_found: [],
      summary: "s",
    });
    const md = formatMarkdown({ fixApplierRaw: "", consolidatorRaw: injected });
    expect(bareHeadingLines(md)).toEqual([FORECLOSED_HEADING]);
    // The injected content survives (escaped), just not as a heading.
    expect(md.join("\n")).toContain("not actually a heading");
  });

  it("a consolidator string with an EMBEDDED '\\n## ' does not emit a bare heading line", () => {
    const injected = JSON.stringify({
      consolidated_findings: [],
      dropped_by_validation: [],
      rejected_alternatives: ["intro line\n## sneaky embedded heading"],
      anti_patterns_found: [],
      summary: "s",
    });
    const md = formatMarkdown({ fixApplierRaw: "", consolidatorRaw: injected });
    expect(bareHeadingLines(md)).toEqual([FORECLOSED_HEADING]);
    expect(md.join("\n")).toContain("sneaky embedded heading");
  });

  it("a fix-applier prose field containing '## ' does not emit a bare heading line", () => {
    const injected = JSON.stringify({
      commits: [],
      deferred: [],
      rejected_alternatives: [
        {
          finding_id: "F9",
          considered_approach: "leading\n## heading in considered_approach",
          why_rejected: "embedded ## marker in why_rejected",
        },
      ],
      anti_patterns_found: [
        {
          location: "bin/lib/z.ts:1",
          pattern: "trailing\n## heading in pattern",
          recommendation: "## heading in recommendation",
          introduced_by_this_pr: true,
        },
      ],
      summary: "s",
    });
    const md = formatMarkdown({ fixApplierRaw: injected, consolidatorRaw: "" });
    expect(bareHeadingLines(md)).toEqual([FORECLOSED_HEADING]);
    // The prose survives (escaped), just not as headings.
    const joined = md.join("\n");
    expect(joined).toContain("heading in considered_approach");
    expect(joined).toContain("marker in why_rejected");
    expect(joined).toContain("heading in pattern");
    expect(joined).toContain("heading in recommendation");
  });

  it("round-trips idempotently through upsertPrBodySection for embedded-heading payloads", () => {
    const injected = JSON.stringify({
      consolidated_findings: [],
      dropped_by_validation: [],
      rejected_alternatives: ["intro line\n## sneaky embedded heading"],
      anti_patterns_found: ["another\n## embedded heading"],
      summary: "s",
    });
    const section = formatMarkdown({
      fixApplierRaw: "",
      consolidatorRaw: injected,
    }).join("\n");
    const once = upsertPrBodySection("", FORECLOSED_HEADING, section);
    // A second upsert with the same section must be a no-op: if a prose '## '
    // had leaked as a bare heading line, the splice would mis-terminate the
    // section and corrupt/duplicate it on re-run.
    const twice = upsertPrBodySection(once, FORECLOSED_HEADING, section);
    expect(twice).toBe(once);
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

  it("a fix-applier artifact missing a required top-level key degrades to (unreadable)", () => {
    const missingKey = JSON.stringify({
      commits: [],
      deferred: [],
      rejected_alternatives: [],
      // anti_patterns_found absent → genuinely broken.
      summary: "s",
    });
    const md = formatMarkdown({
      fixApplierRaw: missingKey,
      consolidatorRaw: consolidator,
    }).join("\n");
    expect(md).toContain("fix-applier: (unreadable)");
    expect(md).toContain("duplicated validation across three call sites");
  });

  it("a one-bad-entry fix-applier artifact renders valid prose + a residual marker, not whole-source (unreadable)", () => {
    const md = formatMarkdown({
      fixApplierRaw: fixApplierOneBadEntry,
      consolidatorRaw: "",
    }).join("\n");
    expect(md).toContain("memoize the parser");
    expect(md).toContain("(1 unreadable)");
    expect(md).not.toContain("fix-applier: (unreadable)");
  });
});
