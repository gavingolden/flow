import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CandidateMeta,
  decideCandidateIssues,
  extractTicked,
  FOLLOWUP_REFERENCE_RES,
  lintFollowUpReferences,
  parseArgs,
  parseRankingTable,
  renderDetails,
  run,
  splitCandidate,
  tickCandidates,
} from "./flow-candidate-issues";

const HEADING = "# Candidate follow-up issues";

const NO_META: CandidateMeta = {
  value: null,
  complexity: null,
  rationale: null,
  relation: null,
  pull: null,
};

function withMeta(
  c: { title: string; body: string },
  meta: Partial<CandidateMeta> = {},
) {
  return { ...c, ...NO_META, ...meta };
}

// --- decideCandidateIssues -------------------------------------------------

describe(decideCandidateIssues, () => {
  it("returns no-op when the heading is absent", () => {
    const r = decideCandidateIssues("# PRD\n\nsome text\n");
    expect(r).toEqual({
      action: "no-op",
      candidates: [],
      untickedCount: 0,
      tickedCount: 0,
      rankedOrder: [],
    });
  });

  it("returns no-op when the heading is present but has zero item lines", () => {
    const r = decideCandidateIssues(
      `## Why\n\nbecause.\n\n${HEADING}\n\nprose only, no checkboxes.\n`,
    );
    expect(r.action).toBe("no-op");
    expect(r.untickedCount).toBe(0);
    expect(r.tickedCount).toBe(0);
    expect(r.candidates).toEqual([]);
  });

  it("returns prompt with one candidate, splitting on the first ` — `", () => {
    const r = decideCandidateIssues(
      `${HEADING}\n\n- [ ] OAuth refresh path leaks tokens — separate concern; needs a session.\n`,
    );
    expect(r.action).toBe("prompt");
    expect(r.untickedCount).toBe(1);
    expect(r.tickedCount).toBe(0);
    expect(r.candidates).toEqual([
      withMeta({
        title: "OAuth refresh path leaks tokens",
        body: "separate concern; needs a session.",
      }),
    ]);
  });

  it("splits only on the FIRST ` — ` (body may contain another em-dash)", () => {
    const r = decideCandidateIssues(
      `${HEADING}\n\n- [ ] Title here — body part one — body part two\n`,
    );
    expect(r.candidates).toEqual([
      withMeta({ title: "Title here", body: "body part one — body part two" }),
    ]);
  });

  it("returns prompt for 4 unticked items", () => {
    const r = decideCandidateIssues(
      `${HEADING}\n\n- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d\n`,
    );
    expect(r.action).toBe("prompt");
    expect(r.untickedCount).toBe(4);
    expect(r.candidates).toHaveLength(4);
  });

  it("returns skip-already-ticked when 1 ticked + 2 unticked", () => {
    const r = decideCandidateIssues(
      `${HEADING}\n\n- [x] already filed — done\n- [ ] a\n- [ ] b\n`,
    );
    expect(r.action).toBe("skip-already-ticked");
    expect(r.untickedCount).toBe(2);
    expect(r.tickedCount).toBe(1);
  });

  it("returns skip-already-ticked when every item is already ticked", () => {
    const r = decideCandidateIssues(`${HEADING}\n\n- [x] one\n- [X] two\n`);
    expect(r.action).toBe("skip-already-ticked");
    expect(r.untickedCount).toBe(0);
    expect(r.tickedCount).toBe(2);
  });

  it("returns overflow for 5 unticked items", () => {
    const body =
      `${HEADING}\n\n` +
      ["a", "b", "c", "d", "e"].map((t) => `- [ ] ${t}`).join("\n") +
      "\n";
    const r = decideCandidateIssues(body);
    expect(r.action).toBe("overflow");
    expect(r.untickedCount).toBe(5);
  });

  it("returns overflow for 6 unticked items", () => {
    const body =
      `${HEADING}\n\n` +
      ["a", "b", "c", "d", "e", "f"].map((t) => `- [ ] ${t}`).join("\n") +
      "\n";
    const r = decideCandidateIssues(body);
    expect(r.action).toBe("overflow");
    expect(r.untickedCount).toBe(6);
  });

  it("yields body === '' when a candidate line has no ` — `", () => {
    const r = decideCandidateIssues(`${HEADING}\n\n- [ ] Just a title\n`);
    expect(r.candidates).toEqual([
      withMeta({ title: "Just a title", body: "" }),
    ]);
  });

  it("stops parsing at the next top-level `# ` heading", () => {
    // An item-looking line under a following `# Task breakdown` heading is
    // NOT counted — the section is bounded by the next H1.
    const body = `${HEADING}\n\n- [ ] real candidate\n\n# Task breakdown\n\n- [ ] not a candidate\n- [ ] also not\n`;
    const r = decideCandidateIssues(body);
    expect(r.action).toBe("prompt");
    expect(r.untickedCount).toBe(1);
    expect(r.candidates).toEqual([
      withMeta({ title: "real candidate", body: "" }),
    ]);
  });

  it("joins ranking-table metadata by exact-trim title match", () => {
    const body = `${HEADING}\n\n| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n| --- | --- | --- | --- | --- | --- |\n| alpha | High | Trivial | matters a lot | tightly coupled | Yes |\n\n- [ ] alpha — body\n`;
    const r = decideCandidateIssues(body);
    expect(r.candidates).toEqual([
      {
        title: "alpha",
        body: "body",
        value: "High",
        complexity: "Trivial",
        rationale: "matters a lot",
        relation: "tightly coupled",
        pull: "Yes",
      },
    ]);
  });

  it("computes rankedOrder High > Medium > Low > unknown with document-order tie-break", () => {
    const body =
      `${HEADING}\n\n` +
      `| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n` +
      `| --- | --- | --- | --- | --- | --- |\n` +
      `| low-one | Low | Small | x | y | No |\n` +
      `| high-one | High | Small | x | y | No |\n` +
      `| medium-one | Medium | Small | x | y | No |\n` +
      `| unknown-one |  |  |  |  |  |\n` +
      `| high-two | High | Small | x | y | No |\n\n` +
      `- [ ] low-one\n- [ ] high-one\n- [ ] medium-one\n- [ ] unknown-one\n- [ ] high-two\n`;
    const r = decideCandidateIssues(body);
    // document order: [low-one, high-one, medium-one, unknown-one, high-two]
    // ranked: high-one(2), high-two(5), medium-one(3), low-one(1), unknown-one(4)
    expect(r.rankedOrder).toEqual([2, 5, 3, 1, 4]);
  });

  it("leaves metadata null when the ranking table is absent", () => {
    const r = decideCandidateIssues(`${HEADING}\n\n- [ ] a\n`);
    expect(r.candidates).toEqual([withMeta({ title: "a", body: "" })]);
    expect(r.rankedOrder).toEqual([1]);
  });

  it("leaves metadata null on a malformed row (too few columns)", () => {
    const body = `${HEADING}\n\n| Candidate | Value |\n| --- | --- |\n| a | High |\n\n- [ ] a\n`;
    const r = decideCandidateIssues(body);
    expect(r.candidates).toEqual([withMeta({ title: "a", body: "" })]);
  });

  it("leaves metadata null on a title mismatch", () => {
    const body = `${HEADING}\n\n| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n| --- | --- | --- | --- | --- | --- |\n| something else | High | Small | x | y | No |\n\n- [ ] a\n`;
    const r = decideCandidateIssues(body);
    expect(r.candidates).toEqual([withMeta({ title: "a", body: "" })]);
  });

  it("ranks a lowercase 'high' value the same as canonical 'High'", () => {
    const body =
      `${HEADING}\n\n` +
      `| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n` +
      `| --- | --- | --- | --- | --- | --- |\n` +
      `| low-one | Low | Small | x | y | No |\n` +
      `| high-one | high | Small | x | y | No |\n\n` +
      `- [ ] low-one\n- [ ] high-one\n`;
    const r = decideCandidateIssues(body);
    // document order: [low-one, high-one]; high-one must rank first.
    expect(r.rankedOrder).toEqual([2, 1]);
  });
});

// --- parseRankingTable -------------------------------------------------

describe(parseRankingTable, () => {
  it("returns an empty map when no table is present", () => {
    expect(parseRankingTable(`${HEADING}\n\n- [ ] a\n`).size).toBe(0);
  });

  it("skips the header and separator rows", () => {
    const body = `${HEADING}\n\n| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n| --- | --- | --- | --- | --- | --- |\n| a | High | Small | x | y | No |\n`;
    const map = parseRankingTable(body);
    expect(map.size).toBe(1);
    expect(map.get("a")).toEqual({
      value: "High",
      complexity: "Small",
      rationale: "x",
      relation: "y",
      pull: "No",
    });
  });

  it("ignores a same-shaped six-column table OUTSIDE the candidate section", () => {
    const body =
      `# PRD\n\n` +
      `| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n` +
      `| --- | --- | --- | --- | --- | --- |\n` +
      `| a | High | Small | unrelated table | y | No |\n\n` +
      `${HEADING}\n\n- [ ] a\n`;
    // No table inside the section itself — the out-of-section table must
    // not leak into the map even though its first cell matches "a".
    expect(parseRankingTable(body).size).toBe(0);
  });

  it("still joins a table placed AFTER the checkbox list, within the section bounds", () => {
    const body =
      `${HEADING}\n\n` +
      `- [ ] a\n\n` +
      `| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n` +
      `| --- | --- | --- | --- | --- | --- |\n` +
      `| a | High | Small | x | y | No |\n`;
    const map = parseRankingTable(body);
    expect(map.get("a")).toEqual({
      value: "High",
      complexity: "Small",
      rationale: "x",
      relation: "y",
      pull: "No",
    });
  });
});

// --- renderDetails -----------------------------------------------------

describe(renderDetails, () => {
  it("is a quiet no-op with zero unticked candidates", () => {
    const decision = decideCandidateIssues(
      `${HEADING}\n\n- [x] already done\n`,
    );
    expect(renderDetails(decision)).toBe("");
  });

  it("renders ranked entries, a recommended marker, and the verbatim offer line", () => {
    const body = `${HEADING}\n\n| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n| --- | --- | --- | --- | --- | --- |\n| alpha | High | Trivial | matters | close | Yes |\n| beta | Low | Large | later | far | No |\n\n- [ ] alpha — a body\n- [ ] beta — b body\n`;
    const decision = decideCandidateIssues(body);
    const rendered = renderDetails(decision);
    expect(rendered).toContain("#1 alpha — High/Trivial");
    expect(rendered).toContain("recommended: pull into this plan");
    expect(rendered).toContain("#2 beta — Low/Large");
    expect(rendered).toContain(
      "To fold a candidate into the current work instead of filing it, reply `pull #N into the plan`.",
    );
    // alpha ranks before beta (High before Low).
    expect(rendered.indexOf("#1 alpha")).toBeLessThan(
      rendered.indexOf("#2 beta"),
    );
  });

  it("recognizes a lowercase 'yes' pull cell case-insensitively", () => {
    const body = `${HEADING}\n\n| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n| --- | --- | --- | --- | --- | --- |\n| alpha | Medium | Large | matters | close | YES |\n\n- [ ] alpha — a body\n`;
    const decision = decideCandidateIssues(body);
    expect(renderDetails(decision)).toContain(
      "recommended: pull into this plan",
    );
  });

  it("recommends on High + Small value/complexity alone, without pull=Yes", () => {
    const body = `${HEADING}\n\n| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n| --- | --- | --- | --- | --- | --- |\n| alpha | High | Small | matters | close | No |\n| beta | Medium | Trivial | later | far | No |\n\n- [ ] alpha — a body\n- [ ] beta — b body\n`;
    const decision = decideCandidateIssues(body);
    const rendered = renderDetails(decision);
    expect(rendered).toContain("recommended: pull into this plan");
    // beta is Medium/Trivial/No — neither clause fires, so no marker for it.
    const betaLine = rendered.split("\n").find((l) => l.includes("#2 beta"));
    expect(betaLine).not.toContain("recommended");
  });
});

// --- splitCandidate --------------------------------------------------------

describe(splitCandidate, () => {
  it("returns empty body when there is no delimiter", () => {
    expect(splitCandidate("only a title")).toEqual({
      title: "only a title",
      body: "",
    });
  });
});

// --- tickCandidates (pure) -------------------------------------------------

describe(tickCandidates, () => {
  const SECTION = `${HEADING}\n\n- [ ] first\n- [ ] second\n- [ ] third\n`;

  it("flips only the selected 1-based unticked indices, leaving others byte-identical", () => {
    const { text, result } = tickCandidates(SECTION, [1, 3]);
    expect(text).toContain("- [x] first");
    expect(text).toContain("- [ ] second");
    expect(text).toContain("- [x] third");
    expect(result.tickedIndices).toEqual([1, 3]);
    expect(result.tickedCount).toBe(2);
    // The heading line and the untouched item are unchanged verbatim.
    expect(text.split("\n")[0]).toBe(HEADING);
  });

  it("throws on an out-of-range index", () => {
    expect(() => tickCandidates(SECTION, [4])).toThrow(/out of range/);
    expect(() => tickCandidates(SECTION, [0])).toThrow(/out of range/);
  });

  it("is idempotent: re-deciding after a flip reflects the new ticked state", () => {
    const { text } = tickCandidates(SECTION, [1]);
    const r = decideCandidateIssues(text);
    expect(r.action).toBe("skip-already-ticked");
    expect(r.tickedCount).toBe(1);
    expect(r.untickedCount).toBe(2);
  });

  it("dedups a repeated index: --tick 1,1 flips item 1 once", () => {
    const { text, result } = tickCandidates(SECTION, [1, 1]);
    // The Set-dedup collapses the duplicate so tickedCount reflects one flip,
    // not the raw arg count, and the flipped text matches a single [1] flip.
    expect(result.tickedIndices).toEqual([1]);
    expect(result.tickedCount).toBe(1);
    expect(text).toBe(tickCandidates(SECTION, [1]).text);
  });

  it("rebases the 1-based index into the UNTICKED enumeration on an interleaved section", () => {
    // `- [x] done` is skipped: --tick 1 targets the first *unticked* item (a),
    // leaving the pre-ticked line and the unselected unticked line byte-identical.
    const interleaved = `${HEADING}\n\n- [x] done\n- [ ] a\n- [ ] b\n`;
    const { text, result } = tickCandidates(interleaved, [1]);
    const lines = text.split("\n");
    expect(lines).toContain("- [x] done");
    expect(lines).toContain("- [x] a");
    expect(lines).toContain("- [ ] b");
    expect(result.tickedIndices).toEqual([1]);
    expect(result.tickedCount).toBe(1);
  });
});

// --- extractTicked ---------------------------------------------------------

describe(extractTicked, () => {
  it("returns an empty array when the section is absent", () => {
    expect(extractTicked("# PRD\n\ntext\n")).toEqual([]);
  });

  it("returns an empty array when the section has zero ticked items", () => {
    expect(extractTicked(`${HEADING}\n\n- [ ] a\n- [ ] b\n`)).toEqual([]);
  });

  it("returns only the ticked items as { title, body } pairs", () => {
    const body = `${HEADING}\n\n- [x] Filed one — body one\n- [ ] not ticked\n- [X] Filed two — body two\n`;
    expect(extractTicked(body)).toEqual([
      withMeta({ title: "Filed one", body: "body one" }),
      withMeta({ title: "Filed two", body: "body two" }),
    ]);
  });

  it("joins ranking-table metadata onto ticked items via the same title match", () => {
    const body = `${HEADING}\n\n| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n| --- | --- | --- | --- | --- | --- |\n| Filed one | High | Trivial | matters | close | Yes |\n\n- [x] Filed one — body one\n- [ ] not ticked\n`;
    expect(extractTicked(body)).toEqual([
      {
        title: "Filed one",
        body: "body one",
        value: "High",
        complexity: "Trivial",
        rationale: "matters",
        relation: "close",
        pull: "Yes",
      },
    ]);
  });
});

// --- lintFollowUpReferences (pure) -----------------------------------------

describe(lintFollowUpReferences, () => {
  it("flags drift when a follow-up reference exists but no candidate section does", () => {
    const r = lintFollowUpReferences(
      "## Decision D\n\nThis is tracked as a follow-up.\n",
    );
    expect(r.drift).toBe(true);
    expect(r.candidateCount).toBe(0);
    expect(r.references).toHaveLength(1);
    expect(r.references[0].line).toBe(3);
    expect(r.references[0].text).toContain("tracked as a follow-up");
  });

  it("flags drift when the candidate section is present but empty", () => {
    const r = lintFollowUpReferences(
      `Decision references it, listed as a follow-up.\n\n${HEADING}\n\nprose only, no checkboxes.\n`,
    );
    expect(r.drift).toBe(true);
    expect(r.candidateCount).toBe(0);
  });

  it("reports no drift when references AND a populated candidate section coexist", () => {
    const r = lintFollowUpReferences(
      `Decision D — deferred to a follow-up.\n\n${HEADING}\n\n- [ ] the follow-up — its body\n`,
    );
    expect(r.drift).toBe(false);
    expect(r.candidateCount).toBe(1);
    expect(r.references.length).toBeGreaterThan(0);
  });

  it("reports no drift when there are no follow-up references at all", () => {
    const r = lintFollowUpReferences("# PRD\n\njust some ordinary prose.\n");
    expect(r.drift).toBe(false);
    expect(r.references).toEqual([]);
  });

  it("records at most one reference per matching line (overlapping phrases)", () => {
    // "listed as a follow-up" matches both the specific and the generic
    // `as a follow-up` regex — the line is still one reference.
    const r = lintFollowUpReferences("It is listed as a follow-up here.\n");
    expect(r.references).toHaveLength(1);
  });

  it("never throws on malformed / empty input", () => {
    expect(() => lintFollowUpReferences("")).not.toThrow();
    expect(() => lintFollowUpReferences(" \n|||\n- [ ")).not.toThrow();
    expect(lintFollowUpReferences("").drift).toBe(false);
  });

  it("does NOT count a ranking-table row (plain Yes/No cells) as a candidate", () => {
    // The additive value/complexity table sits above the `- [ ]` list; its
    // rows must never be mis-parsed as checkbox candidates (AGY pre-mortem C).
    const withTable = `${HEADING}\n\n| Candidate | Value | Complexity | Rationale | Pull into this pipeline? |\n| --- | --- | --- | --- | --- |\n| Some idea | High | Trivial | worth it | Yes |\n| Other idea | Low | Medium | later | No |\n\n- [ ] Some idea — the one real candidate\n`;
    const r = lintFollowUpReferences(withTable);
    // Exactly one candidate (the single `- [ ]` line), NOT three (table rows
    // excluded). A phrase-in-a-Rationale-cell reference does not trip drift
    // because the checkbox item keeps candidateCount > 0.
    expect(r.candidateCount).toBe(1);
    expect(r.drift).toBe(false);
    // Cross-check the decision path agrees on the same count.
    expect(decideCandidateIssues(withTable).untickedCount).toBe(1);
  });
});

// Per-phrase guard: every seed phrase in FOLLOWUP_REFERENCE_RES must be
// matched by lintFollowUpReferences, so broadening the set never silently
// regresses a phrase (the plan's named dominant ship-and-fail).
describe("FOLLOWUP_REFERENCE_RES seed coverage", () => {
  const PHRASES: string[] = [
    "listed as a follow-up",
    "tracked as a follow-up",
    "as a candidate follow-up",
    "as a follow-up",
    "deferred to a follow-up",
    "deferred to a future release",
    "will be addressed in a future PR",
    "added to the backlog",
    "candidate for a future iteration",
    "candidate for future iteration",
  ];

  it("covers at least eight distinct seed phrasings", () => {
    expect(FOLLOWUP_REFERENCE_RES.length).toBeGreaterThanOrEqual(8);
  });

  it.each(PHRASES)("matches the phrasing %j as a reference", (phrase) => {
    const r = lintFollowUpReferences(`Decision X — ${phrase}.\n`);
    expect(r.references).toHaveLength(1);
  });
});

// --- parseArgs -------------------------------------------------------------

describe(parseArgs, () => {
  it("requires --plan-md-file", () => {
    expect(parseArgs(["--json"])).toEqual({
      error: "--plan-md-file is required",
    });
  });

  it("defaults to json mode", () => {
    expect(parseArgs(["--plan-md-file", "p.md"])).toEqual({
      planMdFile: "p.md",
      mode: "json",
      tickIndices: undefined,
    });
  });

  it("parses --lint into lint mode", () => {
    expect(parseArgs(["--plan-md-file", "p.md", "--lint"])).toEqual({
      planMdFile: "p.md",
      mode: "lint",
      tickIndices: undefined,
    });
  });

  it("parses --tick into integer indices", () => {
    expect(parseArgs(["--plan-md-file", "p.md", "--tick", "1,3"])).toEqual({
      planMdFile: "p.md",
      mode: "tick",
      tickIndices: [1, 3],
    });
  });

  it("rejects a non-integer --tick index", () => {
    expect(parseArgs(["--plan-md-file", "p.md", "--tick", "1,x"])).toEqual({
      error: "--tick index must be an integer, got 'x'",
    });
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["--plan-md-file", "p.md", "--bogus"])).toEqual({
      error: "unknown flag: --bogus",
    });
  });

  it("errors when --plan-md-file is given no value", () => {
    expect(parseArgs(["--plan-md-file"])).toEqual({
      error: "--plan-md-file requires a value",
    });
  });

  it("errors when --plan-md-file's value is swallowed by a following flag", () => {
    expect(parseArgs(["--plan-md-file", "--tick"])).toEqual({
      error: "--plan-md-file requires a value",
    });
  });

  it("errors when --tick is given no value", () => {
    expect(parseArgs(["--plan-md-file", "p.md", "--tick"])).toEqual({
      error: "--tick requires comma-separated 1-based indices",
    });
  });
});

// --- run() / CLI (file-touching modes) -------------------------------------

describe("run() integration", () => {
  let dir!: string;
  let planFile!: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-candidate-issues-"));
    planFile = path.join(dir, "plan.md");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writePlan(body: string): void {
    fs.writeFileSync(planFile, body);
  }

  function captureStdout(fn: () => number): { exit: number; out: string } {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(s.toString());
      return true;
    });
    const exit = fn();
    spy.mockRestore();
    return { exit, out: writes.join("") };
  }

  it("emits the decision shape { action, candidates, untickedCount, tickedCount }", () => {
    writePlan(`${HEADING}\n\n- [ ] alpha — first\n- [ ] beta\n`);
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--json"]),
    );
    expect(exit).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({
      action: "prompt",
      candidates: [
        withMeta({ title: "alpha", body: "first" }),
        withMeta({ title: "beta", body: "" }),
      ],
      untickedCount: 2,
      tickedCount: 0,
      rankedOrder: [1, 2],
    });
  });

  it("--tick flips the selected items in the file and leaves others unchanged", () => {
    writePlan(`${HEADING}\n\n- [ ] one\n- [ ] two\n- [ ] three\n`);
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--tick", "1,3"]),
    );
    expect(exit).toBe(0);
    expect(JSON.parse(out)).toEqual({ tickedIndices: [1, 3], tickedCount: 2 });
    const after = fs.readFileSync(planFile, "utf8");
    expect(after).toContain("- [x] one");
    expect(after).toContain("- [ ] two");
    expect(after).toContain("- [x] three");
  });

  it("--tick rejects an out-of-range index with exit 2 and no file mutation", () => {
    writePlan(`${HEADING}\n\n- [ ] one\n`);
    const before = fs.readFileSync(planFile, "utf8");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["--plan-md-file", planFile, "--tick", "5"]);
    errSpy.mockRestore();
    expect(exit).toBe(2);
    expect(fs.readFileSync(planFile, "utf8")).toBe(before);
  });

  it("--ticked emits the now-ticked pairs after a --tick", () => {
    writePlan(`${HEADING}\n\n- [ ] alpha — first\n- [ ] beta — second\n`);
    captureStdout(() => run(["--plan-md-file", planFile, "--tick", "2"]));
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--ticked"]),
    );
    expect(exit).toBe(0);
    expect(JSON.parse(out)).toEqual({
      ticked: [withMeta({ title: "beta", body: "second" })],
    });
  });

  it("--ticked returns an empty array on an all-unticked section", () => {
    writePlan(`${HEADING}\n\n- [ ] a\n- [ ] b\n`);
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--ticked"]),
    );
    expect(exit).toBe(0);
    expect(JSON.parse(out)).toEqual({ ticked: [] });
  });

  it("--lint exits 1 and names the unresolved reference on drift", () => {
    writePlan("## Decision D\n\nThis is tracked as a follow-up.\n");
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--lint"]),
    );
    expect(exit).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.drift).toBe(true);
    expect(parsed.references[0].text).toContain("tracked as a follow-up");
  });

  it("--lint exits 0 when references resolve to a populated section", () => {
    writePlan(
      `Decision D — deferred to a follow-up.\n\n${HEADING}\n\n- [ ] the follow-up — body\n`,
    );
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--lint"]),
    );
    expect(exit).toBe(0);
    expect(JSON.parse(out).drift).toBe(false);
  });

  it("--lint exits 0 when there are no follow-up references", () => {
    writePlan("# PRD\n\nordinary prose, no references.\n");
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--lint"]),
    );
    expect(exit).toBe(0);
    expect(JSON.parse(out).references).toEqual([]);
  });

  it("--details renders the ranked block for unticked candidates", () => {
    writePlan(`${HEADING}\n\n- [ ] alpha — first\n`);
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--details"]),
    );
    expect(exit).toBe(0);
    expect(out).toContain("#1 alpha");
    expect(out).toContain("pull #N into the plan");
  });

  it("--details is a quiet no-op with zero unticked candidates", () => {
    writePlan(`${HEADING}\n\n- [x] already done\n`);
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--details"]),
    );
    expect(exit).toBe(0);
    expect(out).toBe("");
  });

  it("returns 2 when --plan-md-file points at a missing file", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["--plan-md-file", path.join(dir, "nope.md"), "--json"]);
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });

  it("returns 2 on bad args", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["--json"]);
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });
});
