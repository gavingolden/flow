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
});
