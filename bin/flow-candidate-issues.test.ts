import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CandidateMeta,
  enumerateCandidates,
  extractPathAnchors,
  extractTicked,
  extractVerdict,
  FOLLOWUP_REFERENCE_RES,
  lintFollowUpReferences,
  parseArgs,
  parseRankingTable,
  renderDetails,
  run,
  splitCandidate,
  tickCandidates,
  untickCandidates,
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
  c: { title: string; body: string; details?: string },
  meta: Partial<CandidateMeta> = {},
) {
  return { details: "", ...c, ...NO_META, ...meta };
}

function withCandidate(
  c: { title: string; body: string; details?: string },
  ticked: boolean,
  meta: Partial<CandidateMeta> = {},
) {
  return { details: "", ...c, ticked, ...NO_META, ...meta };
}

// --- enumerateCandidates ----------------------------------------------------

describe(enumerateCandidates, () => {
  it("returns an empty enumeration when the heading is absent", () => {
    const r = enumerateCandidates("# PRD\n\nsome text\n");
    expect(r).toEqual({
      candidates: [],
      untickedCount: 0,
      tickedCount: 0,
      rankedOrder: [],
    });
  });

  it("returns an empty enumeration when the heading is present but has zero item lines", () => {
    const r = enumerateCandidates(
      `## Why\n\nbecause.\n\n${HEADING}\n\nprose only, no checkboxes.\n`,
    );
    expect(r.untickedCount).toBe(0);
    expect(r.tickedCount).toBe(0);
    expect(r.candidates).toEqual([]);
  });

  it("returns one unticked candidate, splitting on the first ` — `", () => {
    const r = enumerateCandidates(
      `${HEADING}\n\n- [ ] OAuth refresh path leaks tokens — separate concern; needs a session.\n`,
    );
    expect(r.untickedCount).toBe(1);
    expect(r.tickedCount).toBe(0);
    expect(r.candidates).toEqual([
      withCandidate(
        {
          title: "OAuth refresh path leaks tokens",
          body: "separate concern; needs a session.",
        },
        false,
      ),
    ]);
  });

  it("splits only on the FIRST ` — ` (body may contain another em-dash)", () => {
    const r = enumerateCandidates(
      `${HEADING}\n\n- [ ] Title here — body part one — body part two\n`,
    );
    expect(r.candidates).toEqual([
      withCandidate(
        { title: "Title here", body: "body part one — body part two" },
        false,
      ),
    ]);
  });

  it("enumerates ALL section items, ticked and unticked, in document order", () => {
    const body = `${HEADING}\n\n- [x] first — done\n- [ ] second — open\n- [X] third — also done\n- [ ] fourth — open too\n`;
    const r = enumerateCandidates(body);
    expect(r.candidates).toEqual([
      withCandidate({ title: "first", body: "done" }, true),
      withCandidate({ title: "second", body: "open" }, false),
      withCandidate({ title: "third", body: "also done" }, true),
      withCandidate({ title: "fourth", body: "open too" }, false),
    ]);
    expect(r.tickedCount).toBe(2);
    expect(r.untickedCount).toBe(2);
  });

  it("yields body === '' when a candidate line has no ` — `", () => {
    const r = enumerateCandidates(`${HEADING}\n\n- [ ] Just a title\n`);
    expect(r.candidates).toEqual([
      withCandidate({ title: "Just a title", body: "" }, false),
    ]);
  });

  it("stops parsing at the next top-level `# ` heading", () => {
    // An item-looking line under a following `# Task breakdown` heading is
    // NOT counted — the section is bounded by the next H1.
    const body = `${HEADING}\n\n- [ ] real candidate\n\n# Task breakdown\n\n- [ ] not a candidate\n- [ ] also not\n`;
    const r = enumerateCandidates(body);
    expect(r.untickedCount).toBe(1);
    expect(r.candidates).toEqual([
      withCandidate({ title: "real candidate", body: "" }, false),
    ]);
  });

  it("joins ranking-table metadata by exact-trim title match, on both ticked and unticked items", () => {
    const body = `${HEADING}\n\n| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n| --- | --- | --- | --- | --- | --- |\n| alpha | High | Trivial | matters a lot | tightly coupled | Yes |\n| beta | Low | Large | matters less | loosely coupled | No |\n\n- [ ] alpha — body\n- [x] beta — other body\n`;
    const r = enumerateCandidates(body);
    expect(r.candidates).toEqual([
      {
        title: "alpha",
        body: "body",
        details: "",
        ticked: false,
        value: "High",
        complexity: "Trivial",
        rationale: "matters a lot",
        relation: "tightly coupled",
        pull: "Yes",
      },
      {
        title: "beta",
        body: "other body",
        details: "",
        ticked: true,
        value: "Low",
        complexity: "Large",
        rationale: "matters less",
        relation: "loosely coupled",
        pull: "No",
      },
    ]);
  });

  it("computes rankedOrder High > Medium > Low > unknown with document-order tie-break, across BOTH ticked states", () => {
    const body =
      `${HEADING}\n\n` +
      `| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n` +
      `| --- | --- | --- | --- | --- | --- |\n` +
      `| low-one | Low | Small | x | y | No |\n` +
      `| high-one | High | Small | x | y | No |\n` +
      `| medium-one | Medium | Small | x | y | No |\n` +
      `| unknown-one |  |  |  |  |  |\n` +
      `| high-two | High | Small | x | y | No |\n\n` +
      `- [ ] low-one\n- [x] high-one\n- [ ] medium-one\n- [ ] unknown-one\n- [ ] high-two\n`;
    const r = enumerateCandidates(body);
    // document order: [low-one, high-one(ticked), medium-one, unknown-one, high-two]
    // ranked: high-one(2), high-two(5), medium-one(3), low-one(1), unknown-one(4)
    // — high-one's ticked state does not exclude it from the ranked order;
    // grouping by state is `renderDetails`'s job, not `rankCandidates`'s.
    expect(r.rankedOrder).toEqual([2, 5, 3, 1, 4]);
  });

  it("leaves metadata null when the ranking table is absent", () => {
    const r = enumerateCandidates(`${HEADING}\n\n- [ ] a\n`);
    expect(r.candidates).toEqual([
      withCandidate({ title: "a", body: "" }, false),
    ]);
    expect(r.rankedOrder).toEqual([1]);
  });

  it("leaves metadata null on a malformed row (too few columns)", () => {
    const body = `${HEADING}\n\n| Candidate | Value |\n| --- | --- |\n| a | High |\n\n- [ ] a\n`;
    const r = enumerateCandidates(body);
    expect(r.candidates).toEqual([
      withCandidate({ title: "a", body: "" }, false),
    ]);
  });

  it("leaves metadata null on a title mismatch", () => {
    const body = `${HEADING}\n\n| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n| --- | --- | --- | --- | --- | --- |\n| something else | High | Small | x | y | No |\n\n- [ ] a\n`;
    const r = enumerateCandidates(body);
    expect(r.candidates).toEqual([
      withCandidate({ title: "a", body: "" }, false),
    ]);
  });

  it("ranks a lowercase 'high' value the same as canonical 'High'", () => {
    const body =
      `${HEADING}\n\n` +
      `| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n` +
      `| --- | --- | --- | --- | --- | --- |\n` +
      `| low-one | Low | Small | x | y | No |\n` +
      `| high-one | high | Small | x | y | No |\n\n` +
      `- [ ] low-one\n- [ ] high-one\n`;
    const r = enumerateCandidates(body);
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
  it("is a quiet no-op with zero total candidates", () => {
    const decision = enumerateCandidates(
      `${HEADING}\n\nprose only, no checkboxes.\n`,
    );
    expect(renderDetails(decision)).toBe("");
  });

  it("renders unticked entries with the [ ] marker, a recommended marker, and the verbatim offer line", () => {
    const body = `${HEADING}\n\n| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n| --- | --- | --- | --- | --- | --- |\n| alpha | High | Trivial | matters | close | Yes |\n| beta | Low | Large | later | far | No |\n\n- [ ] alpha — a body\n- [ ] beta — b body\n`;
    const decision = enumerateCandidates(body);
    const rendered = renderDetails(decision);
    expect(rendered).toContain("#1 [ ] alpha — High/Trivial");
    expect(rendered).toContain("recommended: pull into this plan");
    expect(rendered).toContain("#2 [ ] beta — Low/Large");
    expect(rendered).toContain(
      "To fold a candidate into the current work instead of filing it, reply `pull #N into the plan`.",
    );
    expect(rendered).toContain(
      "To drop a candidate instead of filing it as an issue, reply `drop candidate #N`.",
    );
    expect(rendered).toContain(
      "Ticked items file as issues post-merge unless dropped; unticked items are listed here and file only on request (see below).",
    );
    // alpha ranks before beta (High before Low).
    expect(rendered.indexOf("#1 [ ] alpha")).toBeLessThan(
      rendered.indexOf("#2 [ ] beta"),
    );
  });

  it("recognizes a lowercase 'yes' pull cell case-insensitively", () => {
    const body = `${HEADING}\n\n| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n| --- | --- | --- | --- | --- | --- |\n| alpha | Medium | Large | matters | close | YES |\n\n- [ ] alpha — a body\n`;
    const decision = enumerateCandidates(body);
    expect(renderDetails(decision)).toContain(
      "recommended: pull into this plan",
    );
  });

  it("recommends on High + Small value/complexity alone, without pull=Yes", () => {
    const body = `${HEADING}\n\n| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n| --- | --- | --- | --- | --- | --- |\n| alpha | High | Small | matters | close | No |\n| beta | Medium | Trivial | later | far | No |\n\n- [ ] alpha — a body\n- [ ] beta — b body\n`;
    const decision = enumerateCandidates(body);
    const rendered = renderDetails(decision);
    expect(rendered).toContain("recommended: pull into this plan");
    // beta is Medium/Trivial/No — neither clause fires, so no marker for it.
    const betaLine = rendered
      .split("\n")
      .find((l) => l.includes("#2 [ ] beta"));
    expect(betaLine).not.toContain("recommended");
  });

  it("groups ticked candidates ahead of unticked ones, under distinct state labels, with the [x] marker and no recommended marker", () => {
    const body = `${HEADING}\n\n| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n| --- | --- | --- | --- | --- | --- |\n| alpha | High | Trivial | matters | close | Yes |\n| beta | Low | Large | later | far | No |\n\n- [x] alpha — a body\n- [ ] beta — b body\n`;
    const decision = enumerateCandidates(body);
    const rendered = renderDetails(decision);
    expect(rendered).toContain("Already ticked");
    expect(rendered).toContain("Open candidates");
    expect(rendered).toContain("#1 [x] alpha — High/Trivial");
    expect(rendered).toContain("#2 [ ] beta — Low/Large");
    // The already-decided (ticked) group renders before the open group.
    expect(rendered.indexOf("#1 [x] alpha")).toBeLessThan(
      rendered.indexOf("#2 [ ] beta"),
    );
    // A ticked, already-decided item never carries the "recommended" nudge —
    // that marker is only meaningful for still-open candidates.
    const alphaLine = rendered
      .split("\n")
      .find((l) => l.includes("#1 [x] alpha"));
    expect(alphaLine).not.toContain("recommended");
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

  it("flips only the selected 1-based indices, leaving others byte-identical", () => {
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

  it("re-enumerating after a flip reflects the new ticked state", () => {
    const { text } = tickCandidates(SECTION, [1]);
    const r = enumerateCandidates(text);
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

  it("indexes into the FULL enumeration on an interleaved section, NOT an unticked-only sub-enumeration", () => {
    // Index 1 is `- [x] done` — the FIRST item in document order, ticked or
    // not. tickCandidates(1) must therefore throw (already ticked); it must
    // NOT silently rebase to the first *unticked* item, which is the
    // corrected single-index-space contract this rewrite establishes.
    const interleaved = `${HEADING}\n\n- [x] done\n- [ ] a\n- [ ] b\n`;
    expect(() => tickCandidates(interleaved, [1])).toThrow(/already ticked/);

    // Index 2 (the full-enumeration position of `a`) is the correct way to
    // address it — not index 1.
    const { text, result } = tickCandidates(interleaved, [2]);
    const lines = text.split("\n");
    expect(lines).toContain("- [x] done");
    expect(lines).toContain("- [x] a");
    expect(lines).toContain("- [ ] b");
    expect(result.tickedIndices).toEqual([2]);
    expect(result.tickedCount).toBe(1);
  });

  it("throws when the index is already ticked (no double-write)", () => {
    const interleaved = `${HEADING}\n\n- [x] done\n- [ ] a\n`;
    expect(() => tickCandidates(interleaved, [1])).toThrow(/already ticked/);
  });
});

// --- untickCandidates (pure) ------------------------------------------------

describe(untickCandidates, () => {
  const SECTION = `${HEADING}\n\n- [x] first\n- [x] second\n- [ ] third\n`;

  it("flips only the selected 1-based ticked indices back to unticked, leaving others byte-identical", () => {
    const { text, result } = untickCandidates(SECTION, [1]);
    expect(text).toContain("- [ ] first");
    expect(text).toContain("- [x] second");
    expect(text).toContain("- [ ] third");
    expect(result.untickedIndices).toEqual([1]);
    expect(result.untickedCount).toBe(1);
    expect(text.split("\n")[0]).toBe(HEADING);
  });

  it("uppercases [X] fold to [ ] too", () => {
    const upper = `${HEADING}\n\n- [X] first\n`;
    const { text } = untickCandidates(upper, [1]);
    expect(text).toContain("- [ ] first");
  });

  it("throws on an out-of-range index", () => {
    expect(() => untickCandidates(SECTION, [4])).toThrow(/out of range/);
    expect(() => untickCandidates(SECTION, [0])).toThrow(/out of range/);
  });

  it("throws when the index is already unticked (no double-write)", () => {
    expect(() => untickCandidates(SECTION, [3])).toThrow(/already unticked/);
  });

  it("dedups a repeated index: --untick 1,1 flips item 1 once", () => {
    const { text, result } = untickCandidates(SECTION, [1, 1]);
    expect(result.untickedIndices).toEqual([1]);
    expect(result.untickedCount).toBe(1);
    expect(text).toBe(untickCandidates(SECTION, [1]).text);
  });

  it("indexes into the FULL enumeration, matching tickCandidates' index space exactly", () => {
    const interleaved = `${HEADING}\n\n- [ ] a\n- [x] done\n`;
    // Index 1 is `a` (unticked) — untickCandidates(1) must throw.
    expect(() => untickCandidates(interleaved, [1])).toThrow(
      /already unticked/,
    );
    // Index 2 is `done` (ticked) — this is the correct address.
    const { text, result } = untickCandidates(interleaved, [2]);
    const lines = text.split("\n");
    expect(lines).toContain("- [ ] a");
    expect(lines).toContain("- [ ] done");
    expect(result.untickedIndices).toEqual([2]);
  });

  it("re-enumerating after an untick reflects the reverted state", () => {
    const { text } = untickCandidates(SECTION, [1]);
    const r = enumerateCandidates(text);
    expect(r.tickedCount).toBe(1);
    expect(r.untickedCount).toBe(2);
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
        details: "",
        value: "High",
        complexity: "Trivial",
        rationale: "matters",
        relation: "close",
        pull: "Yes",
      },
    ]);
  });

  it("captures the indented value-prop block as details", () => {
    const body =
      `${HEADING}\n\n` +
      `- [x] Filed one — body one\n` +
      `  - **UX:** none\n` +
      `  - **Verdict:** clears bar — because\n` +
      `- [ ] not ticked\n`;
    expect(extractTicked(body)).toEqual([
      withMeta({
        title: "Filed one",
        body: "body one",
        details: "- **UX:** none\n- **Verdict:** clears bar — because",
      }),
    ]);
  });
});

// --- extractItemDetails (via enumerateCandidates) details capture ----------

describe("extractItemDetails (via enumerateCandidates) details capture", () => {
  it("yields an empty string when a checkbox item has no indented continuation", () => {
    const r = enumerateCandidates(`${HEADING}\n\n- [ ] a — b\n`);
    expect(r.candidates[0].details).toBe("");
  });

  it("captures a 2-space-indented block, stripped of its common indent", () => {
    const body = `${HEADING}\n\n- [x] a — b\n  - **UX:** none\n  - **Verdict:** clears bar — x\n`;
    const r = enumerateCandidates(body);
    expect(r.candidates[0].details).toBe(
      "- **UX:** none\n- **Verdict:** clears bar — x",
    );
  });

  it("tolerates a 4-space indent", () => {
    const body = `${HEADING}\n\n- [x] a — b\n    - **UX:** none\n    - **Verdict:** clears bar — x\n`;
    const r = enumerateCandidates(body);
    expect(r.candidates[0].details).toBe(
      "- **UX:** none\n- **Verdict:** clears bar — x",
    );
  });

  it("treats a leading tab as indentation and strips it", () => {
    const body = `${HEADING}\n\n- [x] a — b\n\t- **UX:** none\n\t- **Verdict:** clears bar — x\n`;
    expect(enumerateCandidates(body).candidates[0].details).toBe(
      "- **UX:** none\n- **Verdict:** clears bar — x",
    );
  });

  it("keeps an indented checkbox inside the block as details, not as a new candidate", () => {
    const body = `${HEADING}\n\n- [x] a — b\n  - [ ] acceptance sub-item\n  - **Verdict:** clears bar — x\n- [ ] c — d\n`;
    const r = enumerateCandidates(body);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0].details).toBe(
      "- [ ] acceptance sub-item\n- **Verdict:** clears bar — x",
    );
    expect(tickCandidates(body, [2]).text.split("\n")).toContain("- [x] c — d");
  });

  it("skips an interior blank line without stopping the capture", () => {
    const body = `${HEADING}\n\n- [x] a — b\n  - **UX:** none\n\n  - **Verdict:** clears bar — x\n`;
    const r = enumerateCandidates(body);
    expect(r.candidates[0].details).toBe(
      "- **UX:** none\n- **Verdict:** clears bar — x",
    );
  });

  it("stops at the next checkbox line", () => {
    const body = `${HEADING}\n\n- [x] a — b\n  - **Verdict:** clears bar — x\n- [ ] c — d\n`;
    const r = enumerateCandidates(body);
    expect(r.candidates[0].details).toBe("- **Verdict:** clears bar — x");
    expect(r.candidates[1].details).toBe("");
  });

  it("stops at the next heading", () => {
    const body = `${HEADING}\n\n- [x] a — b\n  - **Verdict:** clears bar — x\n# Task breakdown\n`;
    const r = enumerateCandidates(body);
    expect(r.candidates[0].details).toBe("- **Verdict:** clears bar — x");
  });

  it("stops at the next table row", () => {
    const body = `${HEADING}\n\n- [x] a — b\n  - **Verdict:** clears bar — x\n| more | table |\n`;
    const r = enumerateCandidates(body);
    expect(r.candidates[0].details).toBe("- **Verdict:** clears bar — x");
  });

  it("stops at the first non-blank column-0 line that is not a checkbox", () => {
    const body = `${HEADING}\n\n- [x] a — b\n  - **Verdict:** clears bar — x\nsome trailing prose\n`;
    const r = enumerateCandidates(body);
    expect(r.candidates[0].details).toBe("- **Verdict:** clears bar — x");
  });
});

// --- extractVerdict / extractPathAnchors (pure) -----------------------------

describe(extractVerdict, () => {
  it("returns null when there is no Verdict line", () => {
    expect(extractVerdict("- **UX:** none")).toBeNull();
  });

  it("returns the trimmed value after **Verdict:**", () => {
    expect(extractVerdict("- **Verdict:** clears bar — because reasons")).toBe(
      "clears bar — because reasons",
    );
  });

  it("returns null on an empty Verdict value", () => {
    expect(extractVerdict("- **Verdict:**   ")).toBeNull();
  });

  it("strips a leading backtick before testing the Verdict value", () => {
    expect(
      extractVerdict("- **Verdict:** `clears bar` — because reasons"),
    ).toBe("clears bar` — because reasons");
  });
});

describe(extractPathAnchors, () => {
  it("returns an empty array when there is no anchor", () => {
    expect(extractPathAnchors("- **UX:** none")).toEqual([]);
  });

  it("extracts a bare file anchor with a line number", () => {
    expect(
      extractPathAnchors(
        "- **Problem:** x [anchor: bin/flow-candidate-issues.ts:161]",
      ),
    ).toEqual(["bin/flow-candidate-issues.ts"]);
  });

  it("strips a backticked anchor's surrounding backticks", () => {
    expect(
      extractPathAnchors(
        "- **Problem:** x [anchor: `bin/flow-candidate-issues.ts:161`]",
      ),
    ).toEqual(["bin/flow-candidate-issues.ts"]);
  });

  it("does not path-check a non-file anchor (PR / issue / quote)", () => {
    expect(extractPathAnchors("[anchor: PR #519]")).toEqual([]);
    expect(extractPathAnchors('[anchor: "the user said so"]')).toEqual([]);
  });

  it("extracts multiple anchors across a multi-line details block", () => {
    const details =
      "- **UX:** x [anchor: bin/a.ts:1]\n- **Problem:** y [anchor: bin/b.ts:2]";
    expect(extractPathAnchors(details)).toEqual(["bin/a.ts", "bin/b.ts"]);
  });

  it("does not treat a measured-number or version anchor as a file path", () => {
    expect(extractPathAnchors("[anchor: 1.8s → 0.4s p95]")).toEqual([]);
    expect(extractPathAnchors("[anchor: 0.7% flake rate]")).toEqual([]);
    expect(extractPathAnchors("[anchor: v2.1.234 changelog]")).toEqual([]);
  });

  it("does not treat a `~/`-prefixed anchor as a repo-relative file path", () => {
    expect(extractPathAnchors("[anchor: ~/.flow/config.json]")).toEqual([]);
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
    // Cross-check the enumeration path agrees on the same count.
    expect(enumerateCandidates(withTable).untickedCount).toBe(1);
  });

  it("reports no-verdict for a ticked item with no value-prop block", () => {
    const body = `${HEADING}\n\n- [x] a — b\n`;
    const r = lintFollowUpReferences(body);
    expect(r.barMisses).toEqual([
      { index: 1, title: "a", reason: "no-verdict" },
    ]);
  });

  it("does not flag an unticked item lacking a value-prop block", () => {
    const body = `${HEADING}\n\n- [ ] a — b\n`;
    const r = lintFollowUpReferences(body);
    expect(r.barMisses).toEqual([]);
  });

  it("reports no barMisses for a ticked item whose Verdict clears the bar and cites no anchor", () => {
    const body = `${HEADING}\n\n- [x] a — b\n  - **Verdict:** clears bar — because\n`;
    const r = lintFollowUpReferences(body);
    expect(r.barMisses).toEqual([]);
  });

  it("reports anchor-missing for a ticked item citing a nonexistent repo-relative anchor", () => {
    const body =
      `${HEADING}\n\n- [x] a — b\n` +
      `  - **Problem:** x [anchor: does/not/exist.ts:3]\n` +
      `  - **Verdict:** clears bar — because\n`;
    const r = lintFollowUpReferences(body);
    expect(r.barMisses).toEqual([
      {
        index: 1,
        title: "a",
        reason: "anchor-missing",
        anchor: "does/not/exist.ts",
      },
    ]);
  });

  it("stays silent for a ticked item citing an existing repo-relative anchor", () => {
    const body =
      `${HEADING}\n\n- [x] a — b\n` +
      `  - **Problem:** x [anchor: bin/flow-candidate-issues.ts:1]\n` +
      `  - **Verdict:** clears bar — because\n`;
    const r = lintFollowUpReferences(body);
    expect(r.barMisses).toEqual([]);
  });

  it("stays silent for an existing backticked anchor", () => {
    const body =
      `${HEADING}\n\n- [x] a — b\n` +
      "  - **Problem:** x [anchor: `bin/flow-candidate-issues.ts:1`]\n" +
      `  - **Verdict:** clears bar — because\n`;
    const r = lintFollowUpReferences(body);
    expect(r.barMisses).toEqual([]);
  });

  it("stays silent for a non-path anchor (never existence-checked)", () => {
    const body =
      `${HEADING}\n\n- [x] a — b\n` +
      `  - **Problem:** x [anchor: PR #519]\n` +
      `  - **Verdict:** clears bar — because\n`;
    const r = lintFollowUpReferences(body);
    expect(r.barMisses).toEqual([]);
  });

  it("reports no-verdict for a ticked item whose Verdict is below bar", () => {
    const body = `${HEADING}\n\n- [x] a — b\n  - **Verdict:** below bar — not worth it\n`;
    expect(lintFollowUpReferences(body).barMisses).toEqual([
      { index: 1, title: "a", reason: "no-verdict" },
    ]);
  });

  it("accepts a capitalised Clears bar verdict", () => {
    const body = `${HEADING}\n\n- [x] a — b\n  - **Verdict:** Clears bar — because\n`;
    expect(lintFollowUpReferences(body).barMisses).toEqual([]);
  });

  it("flags an absolute-path anchor as anchor-missing even when the file exists on disk", () => {
    const body =
      `${HEADING}\n\n- [x] a — b\n` +
      `  - **Problem:** x [anchor: /Users/me/.ssh/id_rsa.pub]\n` +
      `  - **Verdict:** clears bar — because\n`;
    const r = lintFollowUpReferences(body);
    expect(r.barMisses).toEqual([
      {
        index: 1,
        title: "a",
        reason: "anchor-missing",
        anchor: "/Users/me/.ssh/id_rsa.pub",
      },
    ]);
  });

  it("flags a `..`-escaping anchor as anchor-missing even when it resolves outside the repo to a real file", () => {
    const body =
      `${HEADING}\n\n- [x] a — b\n` +
      `  - **Problem:** x [anchor: ../../.aws/credentials.json]\n` +
      `  - **Verdict:** clears bar — because\n`;
    const r = lintFollowUpReferences(body);
    expect(r.barMisses).toEqual([
      {
        index: 1,
        title: "a",
        reason: "anchor-missing",
        anchor: "../../.aws/credentials.json",
      },
    ]);
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
      untickIndices: undefined,
    });
  });

  it("parses --lint into lint mode", () => {
    expect(parseArgs(["--plan-md-file", "p.md", "--lint"])).toEqual({
      planMdFile: "p.md",
      mode: "lint",
      tickIndices: undefined,
      untickIndices: undefined,
    });
  });

  it("parses --tick into integer indices", () => {
    expect(parseArgs(["--plan-md-file", "p.md", "--tick", "1,3"])).toEqual({
      planMdFile: "p.md",
      mode: "tick",
      tickIndices: [1, 3],
      untickIndices: undefined,
    });
  });

  it("rejects a non-integer --tick index", () => {
    expect(parseArgs(["--plan-md-file", "p.md", "--tick", "1,x"])).toEqual({
      error: "--tick index must be an integer, got 'x'",
    });
  });

  it("parses --untick into integer indices", () => {
    expect(parseArgs(["--plan-md-file", "p.md", "--untick", "2,4"])).toEqual({
      planMdFile: "p.md",
      mode: "untick",
      tickIndices: undefined,
      untickIndices: [2, 4],
    });
  });

  it("rejects a non-integer --untick index", () => {
    expect(parseArgs(["--plan-md-file", "p.md", "--untick", "2,y"])).toEqual({
      error: "--untick index must be an integer, got 'y'",
    });
  });

  it("errors when --untick is given no value", () => {
    expect(parseArgs(["--plan-md-file", "p.md", "--untick"])).toEqual({
      error: "--untick requires comma-separated 1-based indices",
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

  it("emits the enumeration shape { candidates, untickedCount, tickedCount, rankedOrder } with no action key", () => {
    writePlan(`${HEADING}\n\n- [ ] alpha — first\n- [x] beta\n`);
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--json"]),
    );
    expect(exit).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed).not.toHaveProperty("action");
    expect(parsed).toEqual({
      candidates: [
        withCandidate({ title: "alpha", body: "first" }, false),
        withCandidate({ title: "beta", body: "" }, true),
      ],
      untickedCount: 1,
      tickedCount: 1,
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

  it("--tick rejects an already-ticked index with exit 2 and no file mutation", () => {
    writePlan(`${HEADING}\n\n- [x] one\n`);
    const before = fs.readFileSync(planFile, "utf8");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["--plan-md-file", planFile, "--tick", "1"]);
    errSpy.mockRestore();
    expect(exit).toBe(2);
    expect(fs.readFileSync(planFile, "utf8")).toBe(before);
  });

  it("--untick flips the selected items in the file and leaves others unchanged", () => {
    writePlan(`${HEADING}\n\n- [x] one\n- [x] two\n- [ ] three\n`);
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--untick", "1"]),
    );
    expect(exit).toBe(0);
    expect(JSON.parse(out)).toEqual({
      untickedIndices: [1],
      untickedCount: 1,
    });
    const after = fs.readFileSync(planFile, "utf8");
    expect(after).toContain("- [ ] one");
    expect(after).toContain("- [x] two");
    expect(after).toContain("- [ ] three");
  });

  it("--untick rejects an out-of-range index with exit 2 and no file mutation", () => {
    writePlan(`${HEADING}\n\n- [x] one\n`);
    const before = fs.readFileSync(planFile, "utf8");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["--plan-md-file", planFile, "--untick", "5"]);
    errSpy.mockRestore();
    expect(exit).toBe(2);
    expect(fs.readFileSync(planFile, "utf8")).toBe(before);
  });

  it("--untick rejects an already-unticked index with exit 2 and no file mutation", () => {
    writePlan(`${HEADING}\n\n- [ ] one\n`);
    const before = fs.readFileSync(planFile, "utf8");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["--plan-md-file", planFile, "--untick", "1"]);
    errSpy.mockRestore();
    expect(exit).toBe(2);
    expect(fs.readFileSync(planFile, "utf8")).toBe(before);
  });

  it("--untick 1,2 flips both selected items", () => {
    writePlan(`${HEADING}\n\n- [x] one\n- [x] two\n- [ ] three\n`);
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--untick", "1,2"]),
    );
    expect(exit).toBe(0);
    expect(JSON.parse(out)).toEqual({
      untickedIndices: [1, 2],
      untickedCount: 2,
    });
    const after = fs.readFileSync(planFile, "utf8");
    expect(after).toContain("- [ ] one");
    expect(after).toContain("- [ ] two");
    expect(after).toContain("- [ ] three");
  });

  it("--untick validates the whole batch before writing (no partial mutation)", () => {
    writePlan(`${HEADING}\n\n- [x] one\n- [x] two\n- [ ] three\n`);
    const before = fs.readFileSync(planFile, "utf8");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // index 1 is valid, index 9 is out of range: whole batch must be rejected,
    // so item 1 must NOT have been flipped before the invalid index was hit.
    expect(run(["--plan-md-file", planFile, "--untick", "1,9"])).toBe(2);
    // index 1 is valid, index 3 is already unticked (same-state flip): also
    // rejected wholesale, not partially applied.
    expect(run(["--plan-md-file", planFile, "--untick", "1,3"])).toBe(2);
    errSpy.mockRestore();
    expect(fs.readFileSync(planFile, "utf8")).toBe(before);
  });

  it("--ticked emits the now-ticked pairs after a --tick, unchanged by the rewrite (guards the step-10 contract)", () => {
    writePlan(`${HEADING}\n\n- [ ] alpha — first\n- [ ] beta — second\n`);
    captureStdout(() => run(["--plan-md-file", planFile, "--tick", "2"]));
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--ticked"]),
    );
    expect(exit).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({
      ticked: [withMeta({ title: "beta", body: "second" })],
    });
    // The `--ticked` items must NOT gain the new `ticked` boolean field that
    // `Candidate` gained — that field belongs to the enumeration surface,
    // not the step-10 post-merge issue-filing shape `--ticked` guards.
    expect(parsed.ticked[0]).not.toHaveProperty("ticked");
  });

  it("--ticked returns an empty array on an all-unticked section", () => {
    writePlan(`${HEADING}\n\n- [ ] a\n- [ ] b\n`);
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--ticked"]),
    );
    expect(exit).toBe(0);
    expect(JSON.parse(out)).toEqual({ ticked: [] });
  });

  it("--ticked includes the item's value-prop block as details", () => {
    writePlan(
      `${HEADING}\n\n- [x] alpha — first\n  - **Verdict:** clears bar — because\n`,
    );
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--ticked"]),
    );
    expect(exit).toBe(0);
    expect(JSON.parse(out)).toEqual({
      ticked: [
        withMeta({
          title: "alpha",
          body: "first",
          details: "- **Verdict:** clears bar — because",
        }),
      ],
    });
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

  it("--lint exits 1 on a barMisses no-verdict entry, even with zero reference drift", () => {
    writePlan(`${HEADING}\n\n- [x] alpha — first\n`);
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--lint"]),
    );
    expect(exit).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.drift).toBe(false);
    expect(parsed.barMisses).toEqual([
      { index: 1, title: "alpha", reason: "no-verdict" },
    ]);
  });

  it("--lint exits 0 with barMisses: [] when every ticked item clears the bar", () => {
    writePlan(
      `${HEADING}\n\n- [x] alpha — first\n  - **Verdict:** clears bar — because\n`,
    );
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--lint"]),
    );
    expect(exit).toBe(0);
    expect(JSON.parse(out).barMisses).toEqual([]);
  });

  it("--lint checks [anchor:] paths against the plan file's own repo root, not cwd", () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(path.join(dir, "bin", "x.ts"), "");
    writePlan(
      `${HEADING}\n\n- [x] a — b\n` +
        `  - **UX:** x [anchor: bin/x.ts:1]\n` +
        // exists relative to vitest's own cwd (this flow checkout), NOT
        // relative to the plan file's own repo (`dir`) — the load-bearing
        // case: it fails only if resolution is repo-root-based, not cwd.
        `  - **Problem:** y [anchor: bin/flow-candidate-issues.ts:1]\n` +
        `  - **Verdict:** clears bar — because\n`,
    );
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--lint"]),
    );
    expect(exit).toBe(1);
    expect(JSON.parse(out).barMisses).toEqual([
      {
        index: 1,
        title: "a",
        reason: "anchor-missing",
        anchor: "bin/flow-candidate-issues.ts",
      },
    ]);
  });

  it("--details renders the ranked block for open candidates", () => {
    writePlan(`${HEADING}\n\n- [ ] alpha — first\n`);
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--details"]),
    );
    expect(exit).toBe(0);
    expect(out).toContain("#1 [ ] alpha");
    expect(out).toContain("pull #N into the plan");
    expect(out).toContain("drop candidate #N");
  });

  it("--details shows a pre-ticked item in the ticked group with the [x] marker", () => {
    writePlan(`${HEADING}\n\n- [x] already done\n`);
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--details"]),
    );
    expect(exit).toBe(0);
    expect(out).toContain("#1 [x] already done");
    expect(out).toContain("Already ticked");
    expect(out).toContain(
      "Ticked items file as issues post-merge unless dropped; unticked items are listed here and file only on request (see below).",
    );
  });

  it("--details shows the verdict line and all three reply offers", () => {
    writePlan(
      `${HEADING}\n\n- [x] a — b\n  - **Verdict:** clears bar — because\n- [ ] c — d\n`,
    );
    const { exit, out } = captureStdout(() =>
      run(["--plan-md-file", planFile, "--details"]),
    );
    expect(exit).toBe(0);
    expect(out).toContain("verdict: clears bar — because");
    expect(out).toContain("verdict: (no value-prop block)");
    expect(out).toContain("pull #N into the plan");
    expect(out).toContain("drop candidate #N");
    expect(out).toContain("file candidate #N");
  });

  it("--details is a quiet no-op with zero total candidates", () => {
    writePlan(`${HEADING}\n\nprose only, no checkboxes.\n`);
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

// --- index-space regression: --details labels vs --tick/--untick args ------
//
// THE LOAD-BEARING REGRESSION TEST. Today's `#N` label a user reads via
// `--details` must be the exact `N` they pass to `--tick`/`--untick` —
// that single-index-space property is what the contract adjustment in this
// rewrite exists to preserve (tickCandidates/untickCandidates now index into
// the FULL `candidates` enumeration, matching what `renderDetails` labels).
describe("details label ↔ tick/untick argument index space", () => {
  const MIXED =
    `${HEADING}\n\n` +
    `| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n` +
    `| --- | --- | --- | --- | --- | --- |\n` +
    `| alpha | Low | Small | x | y | No |\n` +
    `| beta | High | Trivial | x | y | Yes |\n\n` +
    `- [x] alpha — done already\n` +
    `- [ ] beta — open one\n`;

  it("pins the #N label renderDetails prints for a candidate to the same N tickCandidates/untickCandidates accept for it", () => {
    const decision = enumerateCandidates(MIXED);
    const rendered = renderDetails(decision);

    // alpha is candidates[0] (ticked, Low) -> labelled #1.
    // beta is candidates[1] (unticked, High) -> labelled #2.
    expect(rendered).toContain("#1 [x] alpha");
    expect(rendered).toContain("#2 [ ] beta");

    // #1 (alpha) is already ticked: untickCandidates(1) succeeds and
    // addresses alpha; tickCandidates(1) throws (same-state flip rejected).
    expect(() => tickCandidates(MIXED, [1])).toThrow(/already ticked/);
    const untickOut = untickCandidates(MIXED, [1]);
    expect(untickOut.text.split("\n")).toContain("- [ ] alpha — done already");

    // #2 (beta) is unticked: tickCandidates(2) succeeds and addresses beta;
    // untickCandidates(2) throws.
    expect(() => untickCandidates(MIXED, [2])).toThrow(/already unticked/);
    const tickOut = tickCandidates(MIXED, [2]);
    expect(tickOut.text.split("\n")).toContain("- [x] beta — open one");
  });

  // Every fixture above has print order == enumeration order (<=2
  // candidates), so it can't distinguish labelling by enumeration index
  // (correct) from labelling by print position (a regression). This
  // fixture's ranking + ticked/unticked grouping reorders the print
  // sequence relative to doc/enumeration order, closing that hole.
  const MIXED3 =
    `${HEADING}\n\n` +
    `| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |\n` +
    `| --- | --- | --- | --- | --- | --- |\n` +
    `| a | Low | Small | x | y | No |\n` +
    `| b | Low | Small | x | y | No |\n` +
    `| c | High | Small | x | y | No |\n\n` +
    `- [ ] a — open\n- [x] b — done\n- [ ] c — open too\n`;

  it("labels by enumeration index, not print position, when ranking + grouping reorders the block", () => {
    const rendered = renderDetails(enumerateCandidates(MIXED3));
    const labels = rendered.split("\n").filter((l) => l.startsWith("#"));
    // rankedOrder is [3, 1, 2] (c is High-ranked first, a/b tie at Low in
    // doc order); ticked group (b, #2) prints before the unticked group
    // (c, #3 then a, #1) — a non-monotonic print sequence.
    expect(labels[0]).toContain("#2 [x] b");
    expect(labels[1]).toContain("#3 [ ] c");
    expect(labels[2]).toContain("#1 [ ] a");
    // And each printed label is the exact argument tick/untick accept for
    // that item — the correspondence this describe block exists to protect.
    expect(untickCandidates(MIXED3, [2]).text.split("\n")).toContain(
      "- [ ] b — done",
    );
    expect(tickCandidates(MIXED3, [3]).text.split("\n")).toContain(
      "- [x] c — open too",
    );
  });
});
