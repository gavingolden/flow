import { describe, expect, it } from "vitest";
import { buildMergeBody, parseArgs } from "./flow-merge-body";

describe("buildMergeBody", () => {
  it("truncates at the first ## Test Steps heading", () => {
    const body = [
      "## Why",
      "Fixes the thing.",
      "",
      "## Test Steps",
      "- [ ] run the tests",
      "",
      "<details>evidence</details>",
    ].join("\n");
    const out = buildMergeBody(body, "sess-1");
    expect(out).toBe("## Why\nFixes the thing.\n\nClaude-Code-Session-Id: sess-1");
    expect(out).not.toContain("## Test Steps");
    expect(out).not.toContain("evidence");
  });

  it("strips a single-line HTML comment from the narrative", () => {
    const body = "## Why\n<!-- flow:authoring-rubric -->\nReal content.\n\n## Test Steps\n- [ ] x";
    const out = buildMergeBody(body, "s");
    expect(out).not.toContain("<!--");
    expect(out).toContain("Real content.");
  });

  it("strips a multi-line HTML comment from the narrative", () => {
    const body = "## Why\n<!--\nmulti\nline\ncomment\n-->\nKept.\n\n## Test Steps\n- [ ] x";
    const out = buildMergeBody(body, "s");
    expect(out).not.toContain("multi");
    expect(out).not.toContain("-->");
    expect(out).toContain("Kept.");
  });

  it("keeps the whole body when there is no ## Test Steps heading", () => {
    const body = "## Why\nJust narrative.\n\n## What\nMore narrative.";
    const out = buildMergeBody(body, "abc");
    expect(out).toBe(
      "## Why\nJust narrative.\n\n## What\nMore narrative.\n\nClaude-Code-Session-Id: abc",
    );
  });

  it("appends the trailer as the final line after one blank line", () => {
    const out = buildMergeBody("narrative", "xyz");
    const lines = out.split("\n");
    expect(lines[lines.length - 1]).toBe("Claude-Code-Session-Id: xyz");
    expect(lines[lines.length - 2]).toBe("");
    expect(lines[lines.length - 3]).toBe("narrative");
  });

  it("does not cut on a mid-line or indented '## Test Steps' occurrence", () => {
    const body = [
      "## Why",
      "We renamed the `## Test Steps` heading parser.",
      "",
      "```",
      "    ## Test Steps",
      "```",
      "End of narrative.",
    ].join("\n");
    const out = buildMergeBody(body, "s");
    expect(out).toContain("End of narrative.");
    expect(out).toContain("renamed the `## Test Steps`");
  });
});

describe("parseArgs", () => {
  it("parses --session-id with a positional body", () => {
    expect(parseArgs(["--session-id", "abc", "the body"])).toEqual({
      sessionId: "abc",
      body: "the body",
    });
  });

  it("parses --session-id with no positional (stdin mode)", () => {
    expect(parseArgs(["--session-id", "abc"])).toEqual({ sessionId: "abc", body: undefined });
  });

  it("errors when --session-id is missing", () => {
    const r = parseArgs(["some body"]);
    expect("error" in r && r.error).toBeTruthy();
  });
});
