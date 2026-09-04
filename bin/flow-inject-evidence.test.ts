import { describe, expect, it } from "vitest";
import {
  buildEvidenceBlock,
  neutralizeHeadings,
  parseArgs,
  rewriteBody,
  trimOutput,
} from "./flow-inject-evidence";

const TS = "2026-05-02T12:34:56Z";

describe("parseArgs", () => {
  it("requires every flag except --timestamp", () => {
    expect(parseArgs([])).toEqual({ error: "--body-file is required" });
    expect(parseArgs(["--body-file", "b.md"])).toEqual({
      error: "--item is required",
    });
    expect(parseArgs(["--body-file", "b.md", "--item", "x"])).toEqual({
      error: "--output-file is required",
    });
    expect(
      parseArgs([
        "--body-file",
        "b.md",
        "--item",
        "x",
        "--output-file",
        "o.txt",
      ]),
    ).toEqual({ error: "--exit-code must be an integer" });
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["--bogus", "x"])).toEqual({
      error: "unknown flag: --bogus",
    });
  });

  it("accepts a complete arg set", () => {
    expect(
      parseArgs([
        "--body-file",
        "b.md",
        "--item",
        "npm run verify",
        "--output-file",
        "o.txt",
        "--exit-code",
        "0",
        "--timestamp",
        TS,
      ]),
    ).toEqual({
      bodyFile: "b.md",
      item: "npm run verify",
      outputFile: "o.txt",
      exitCode: 0,
      timestamp: TS,
    });
  });
});

describe("trimOutput", () => {
  it("returns short output unchanged", () => {
    expect(trimOutput("a\nb\nc")).toBe("a\nb\nc");
  });

  it("head/tail-trims long output with a count marker", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const trimmed = trimOutput(lines);
    expect(trimmed).toContain("line 1");
    expect(trimmed).toContain("line 100");
    expect(trimmed).toContain("line 151");
    expect(trimmed).toContain("line 200");
    expect(trimmed).not.toContain("line 125");
    expect(trimmed).toMatch(/\.\.\. \[truncated; 50 more lines/);
  });
});

describe("buildEvidenceBlock", () => {
  it("emits a passing details block when exit code is 0", () => {
    const block = buildEvidenceBlock("ok\n", 0, TS);
    expect(block).toContain("<!-- flow:evidence -->");
    expect(block).toContain(`Output (auto-captured ${TS}; pass)`);
    expect(block).toContain("```text");
    expect(block).toContain("ok\n");
    expect(block).toContain("</details>");
  });

  it("marks failure with exit code in the summary", () => {
    const block = buildEvidenceBlock("boom", 1, TS);
    expect(block).toContain(`Output (auto-captured ${TS}; FAILED exit 1)`);
  });

  it("uses a longer fence when the output contains backticks", () => {
    // Captured output that itself contains a triple-backtick fence — e.g.
    // `npm test` printing a markdown failure summary.
    const inner = "preamble\n```\nfake fence\n```\nepilogue";
    const block = buildEvidenceBlock(inner, 0, TS);
    expect(block).toContain("````text");
    expect(block).toContain("preamble");
    expect(block).toContain("epilogue");
    // The inner triple-backtick must not close the outer fence: the
    // closing four-backtick line should appear only once, and it must
    // come after the entire inner payload.
    const closeIdx = block.lastIndexOf("\n````\n");
    const innerEnd = block.indexOf("epilogue");
    expect(closeIdx).toBeGreaterThan(innerEnd);
  });

  it("uses a triple-backtick fence when the output has no backtick runs", () => {
    const block = buildEvidenceBlock("plain output\n", 0, TS);
    expect(block).toMatch(/\n```text\n/);
    // The block ends with </details>\n — a trailing newline, joined
    // by lines.splice() into a blank line so the next bullet starts
    // in markdown mode (GFM HTML blocks only end at a blank line).
    expect(block).toMatch(/\n```\n\n<\/details>\n$/);
  });
});

describe("rewriteBody", () => {
  const body = [
    "## Test Steps",
    "",
    "- [ ] `npm run verify` — pass",
    "- [ ] manual smoke",
  ].join("\n");

  it("ticks the matched item and inserts an evidence block on success", () => {
    const result = rewriteBody(
      body,
      {
        bodyFile: "",
        outputFile: "",
        item: "npm run verify",
        exitCode: 0,
        timestamp: TS,
      },
      "all green",
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.ticked).toBe(true);
    expect(result.replaced).toBe(false);
    expect(result.body).toContain("- [x] `npm run verify`");
    expect(result.body).toContain("- [ ] manual smoke");
    expect(result.body).toContain("<!-- flow:evidence -->");
    expect(result.body).toContain("all green");
  });

  it("leaves the box unchecked when exit code is non-zero", () => {
    const result = rewriteBody(
      body,
      {
        bodyFile: "",
        outputFile: "",
        item: "npm run verify",
        exitCode: 1,
        timestamp: TS,
      },
      "boom",
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.ticked).toBe(false);
    expect(result.body).toContain("- [ ] `npm run verify`");
    expect(result.body).toContain("FAILED exit 1");
  });

  it("replaces a prior evidence block in place rather than stacking", () => {
    const stamped = rewriteBody(
      body,
      {
        bodyFile: "",
        outputFile: "",
        item: "npm run verify",
        exitCode: 0,
        timestamp: "2026-05-02T00:00:00Z",
      },
      "first run",
    );
    if (!stamped.ok) throw new Error(stamped.error);

    const second = rewriteBody(
      stamped.body,
      {
        bodyFile: "",
        outputFile: "",
        item: "npm run verify",
        exitCode: 0,
        timestamp: "2026-05-02T01:00:00Z",
      },
      "second run",
    );
    if (!second.ok) throw new Error(second.error);
    expect(second.replaced).toBe(true);
    expect(second.body).toContain("second run");
    expect(second.body).not.toContain("first run");
    expect((second.body.match(/<!-- flow:evidence -->/g) ?? []).length).toBe(1);
  });

  it("normalizes captured output containing unbalanced/nested <details> markup", () => {
    // The captured stdout/stderr can itself contain HTML from a nested
    // tool's own output (e.g. a test runner echoing markdown). Without
    // the InjectResult.body normalization pass, an unbalanced </details>
    // inside the fenced payload would still be safely inside our own
    // fence — but a stray, unfenced <details> line elsewhere in the
    // body (e.g. injected by a prior run's malformed edit) must still
    // come back normalized.
    const malformed = [
      "## Test Steps",
      "",
      "- [ ] `npm run verify` — pass",
      "<details><summary>stray</summary>",
      "orphaned content",
      "</details>",
      "- [ ] manual smoke",
    ].join("\n");
    const result = rewriteBody(
      malformed,
      {
        bodyFile: "",
        outputFile: "",
        item: "npm run verify",
        exitCode: 0,
        timestamp: TS,
      },
      "all green",
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.body).toContain("<summary>stray</summary>\n\norphaned");
    expect(result.body).toContain("</details>\n\n- [ ] manual smoke");
  });

  it("returns an error when no line matches the item regex", () => {
    const result = rewriteBody(
      body,
      {
        bodyFile: "",
        outputFile: "",
        item: "totally absent",
        exitCode: 0,
        timestamp: TS,
      },
      "out",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("no line matched");
  });

  it("trims long output before injection", () => {
    const long = Array.from({ length: 200 }, (_, i) => `L${i}`).join("\n");
    const result = rewriteBody(
      body,
      {
        bodyFile: "",
        outputFile: "",
        item: "npm run verify",
        exitCode: 0,
        timestamp: TS,
      },
      long,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.body).toMatch(/truncated; 50 more lines/);
  });

  it("preserves indentation when ticking nested items", () => {
    const nested = ["## Test Steps", "", "  - [ ] indented item"].join("\n");
    const result = rewriteBody(
      nested,
      {
        bodyFile: "",
        outputFile: "",
        item: "indented item",
        exitCode: 0,
        timestamp: TS,
      },
      "ok",
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.body).toContain("  - [x] indented item");
  });

  it("inserts evidence after the last continuation line of a multi-line bullet", () => {
    // Regression: the helper used to splice evidence on the line
    // immediately after `matchIdx`, splitting a multi-line bullet so
    // the continuation lines were orphaned past `</details>`. Result:
    // the bullet's prose visibly broke at the seam on the rendered
    // PR. Evidence must always land *after* the bullet, never inside.
    const multiLine = [
      "## Test Steps",
      "",
      '- [ ] `grep -rn "Manual"` returns',
      "      only matches inside this PR's diff context — no surviving live",
      "      references.",
      "- [ ] another bullet",
    ].join("\n");
    const result = rewriteBody(
      multiLine,
      {
        bodyFile: "",
        outputFile: "",
        item: "grep -rn",
        exitCode: 0,
        timestamp: TS,
      },
      "8 lines remain",
    );
    if (!result.ok) throw new Error(result.error);
    const lines = result.body.split("\n");
    const tickIdx = lines.findIndex((l) => l.includes("- [x] `grep -rn"));
    const refIdx = lines.findIndex((l) => l.includes("references."));
    const detailsIdx = lines.findIndex((l) =>
      l.includes("<!-- flow:evidence -->"),
    );
    const nextBulletIdx = lines.findIndex((l) => l === "- [ ] another bullet");
    expect(tickIdx).toBeGreaterThanOrEqual(0);
    expect(refIdx).toBeGreaterThan(tickIdx);
    expect(detailsIdx).toBeGreaterThan(refIdx);
    expect(nextBulletIdx).toBeGreaterThan(detailsIdx);
  });

  it("re-runs idempotently on a multi-line bullet whose evidence sits past the continuation", () => {
    const multiLine = [
      "## Test Steps",
      "",
      '- [ ] `grep -rn "Manual"` returns',
      "      only matches inside this PR's diff context — no surviving live",
      "      references.",
    ].join("\n");
    const first = rewriteBody(
      multiLine,
      {
        bodyFile: "",
        outputFile: "",
        item: "grep -rn",
        exitCode: 0,
        timestamp: "2026-05-02T00:00:00Z",
      },
      "first run",
    );
    if (!first.ok) throw new Error(first.error);
    const second = rewriteBody(
      first.body,
      {
        bodyFile: "",
        outputFile: "",
        item: "grep -rn",
        exitCode: 0,
        timestamp: "2026-05-02T01:00:00Z",
      },
      "second run",
    );
    if (!second.ok) throw new Error(second.error);
    expect(second.replaced).toBe(true);
    expect(second.body).toContain("second run");
    expect(second.body).not.toContain("first run");
    expect(second.body).toContain("references.");
    expect((second.body.match(/<!-- flow:evidence -->/g) ?? []).length).toBe(1);
  });

  it("emits a blank line after </details> so the next bullet renders as a list item", () => {
    // Regression: GFM HTML blocks (type 6/7) end at the next blank
    // line, not at the matching close tag. Without a trailing blank,
    // the next `</details>` (and the bullet between them) get
    // absorbed into a chained raw-HTML block — visible on PR #72
    // before this fix as bullets rendering as plain text and the
    // last `<details>` swallowing the unchecked manual items.
    const result = rewriteBody(
      [
        "## Test Steps",
        "",
        "- [ ] `npm run verify` — pass",
        "- [ ] manual smoke",
      ].join("\n"),
      {
        bodyFile: "",
        outputFile: "",
        item: "npm run verify",
        exitCode: 0,
        timestamp: TS,
      },
      "ok",
    );
    if (!result.ok) throw new Error(result.error);
    const lines = result.body.split("\n");
    const closeIdx = lines.findIndex((l) => l === "</details>");
    expect(closeIdx).toBeGreaterThan(0);
    expect(lines[closeIdx + 1]).toBe("");
    expect(lines[closeIdx + 2]).toBe("- [ ] manual smoke");
  });

  it("does not stack trailing blank lines on re-runs", () => {
    const seed = [
      "## Test Steps",
      "",
      "- [ ] `npm run verify` — pass",
      "- [ ] manual smoke",
    ].join("\n");
    const first = rewriteBody(
      seed,
      {
        bodyFile: "",
        outputFile: "",
        item: "npm run verify",
        exitCode: 0,
        timestamp: "2026-05-02T00:00:00Z",
      },
      "first",
    );
    if (!first.ok) throw new Error(first.error);
    const second = rewriteBody(
      first.body,
      {
        bodyFile: "",
        outputFile: "",
        item: "npm run verify",
        exitCode: 0,
        timestamp: "2026-05-02T01:00:00Z",
      },
      "second",
    );
    if (!second.ok) throw new Error(second.error);
    // No three-in-a-row blank lines — at most a single trailing
    // blank between </details> and the next bullet.
    expect(second.body).not.toMatch(/\n\n\n\n/);
    expect(second.body).toContain("second");
    expect(second.body).not.toContain("first");
  });

  it("inserts a fresh block instead of repairing an orphaned open marker", () => {
    // Hand-edited or interrupted prior write: marker is present but the
    // closing </details> was lost. The helper must not claim to have
    // replaced a block that has no end; it inserts a fresh one alongside
    // the orphan so the human sees the corruption.
    const orphaned = [
      "## Test Steps",
      "",
      "- [ ] `npm run verify` — pass",
      "<details><!-- flow:evidence --><summary>old</summary>",
      "",
      "no closing tag here",
    ].join("\n");
    const result = rewriteBody(
      orphaned,
      {
        bodyFile: "",
        outputFile: "",
        item: "npm run verify",
        exitCode: 0,
        timestamp: TS,
      },
      "fresh output",
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.replaced).toBe(false);
    expect(result.body).toContain("fresh output");
    // Orphan is preserved (we don't try to repair it).
    expect(result.body).toContain("no closing tag here");
    // Exactly one closing </details> from the freshly inserted block.
    expect((result.body.match(/<\/details>/g) ?? []).length).toBe(1);
  });
});

describe("neutralizeHeadings — gate-parser containment", () => {
  // Regression guard for PR #755: a captured `npm test` run printed its
  // own markdown report, whose column-0 `## Regressions (1)` truncated
  // `flow-gate-decide`'s `## Test Steps` extraction. The gate then saw
  // zero unchecked items and returned `auto-merge` on a PR with an
  // unrun manual step.
  it("indents every column-0 ATX heading so an anchored ^## scan cannot match", () => {
    const captured = [
      "# flow-eval compare",
      "## s1 (score 1 -> 1, delta 0)",
      "###### deep",
      "## Regressions (1)",
      "- s1: transcript.finalContextTokens",
    ].join("\n");
    const out = neutralizeHeadings(captured);
    expect(out.split("\n").some((l) => /^#{1,6} /.test(l))).toBe(false);
    // Content is preserved verbatim apart from the one-space indent.
    for (const line of captured.split("\n")) {
      expect(out).toContain(line.startsWith("#") ? ` ${line}` : line);
    }
  });

  it("leaves non-heading hashes alone (a bare #, and # mid-line)", () => {
    const captured = [
      "#not-a-heading",
      "run with #comment",
      "#",
      "  ## indented",
    ].join("\n");
    expect(neutralizeHeadings(captured)).toBe(captured);
  });

  it("buildEvidenceBlock emits no column-0 heading from heading-bearing output", () => {
    const block = buildEvidenceBlock("## Regressions (1)\n- boom", 0, TS);
    expect(block.split("\n").some((l) => /^#{1,6} /.test(l))).toBe(false);
    expect(block).toContain("## Regressions (1)");
  });
});
