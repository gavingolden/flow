import { describe, expect, it } from "vitest";
import {
  buildEvidenceBlock,
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
      parseArgs(["--body-file", "b.md", "--item", "x", "--output-file", "o.txt"]),
    ).toEqual({ error: "--exit-code must be an integer" });
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["--bogus", "x"])).toEqual({ error: "unknown flag: --bogus" });
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
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
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
    expect(block).toMatch(/\n```\n\n<\/details>$/);
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
    expect(
      (second.body.match(/<!-- flow:evidence -->/g) ?? []).length,
    ).toBe(1);
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
    const nested = [
      "## Test Steps",
      "",
      "  - [ ] indented item",
    ].join("\n");
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
    const tickIdx = lines.findIndex((l) => l.includes('- [x] `grep -rn'));
    const refIdx = lines.findIndex((l) => l.includes("references."));
    const detailsIdx = lines.findIndex((l) => l.includes("<!-- flow:evidence -->"));
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
    expect(
      (second.body.match(/<!-- flow:evidence -->/g) ?? []).length,
    ).toBe(1);
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
