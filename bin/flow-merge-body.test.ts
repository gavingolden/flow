import { describe, expect, it, vi } from "vitest";
import { buildMergeBody, parseArgs, run } from "./flow-merge-body";

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

  it("cuts at the real heading, not a column-0 '## Test Steps' inside an HTML comment", () => {
    const body = [
      "## Why",
      "Narrative one.",
      "<!--",
      "stray ## Test Steps",
      "## Test Steps",
      "-->",
      "More narrative kept.",
      "",
      "## Test Steps",
      "- [ ] x",
    ].join("\n");
    const out = buildMergeBody(body, "s");
    expect(out).toContain("More narrative kept.");
    expect(out).not.toContain("<!--");
    expect(out).not.toContain("stray");
    expect(out).toBe(
      "## Why\nNarrative one.\n\nMore narrative kept.\n\nClaude-Code-Session-Id: s",
    );
  });

  it("yields a blank narrative when the body begins with ## Test Steps", () => {
    const out = buildMergeBody("## Test Steps\n- [ ] x", "s");
    expect(out).toBe("\n\nClaude-Code-Session-Id: s");
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

  it("errors on an unknown flag", () => {
    expect(parseArgs(["--session-id", "abc", "--bogus"])).toEqual({
      error: "unknown flag: --bogus",
    });
  });

  it("errors on an unexpected extra positional argument", () => {
    expect(parseArgs(["--session-id", "abc", "body one", "body two"])).toEqual({
      error: "unexpected extra positional argument",
    });
  });

  it("errors when --session-id is the final arg with no value", () => {
    expect(parseArgs(["--session-id"])).toEqual({
      error: "--session-id requires a value",
    });
  });

  it("errors when --session-id is followed by another flag", () => {
    expect(parseArgs(["--session-id", "--body"])).toEqual({
      error: "--session-id requires a value",
    });
  });
});

describe("run", () => {
  it("emits buildMergeBody output plus a trailing newline for a positional body", async () => {
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(s.toString());
      return true;
    });
    const exit = await run(["--session-id", "s", "## Why\nNarrative.\n\n## Test Steps\n- [ ] x"]);
    writeSpy.mockRestore();
    expect(exit).toBe(0);
    expect(writes.join("")).toBe("## Why\nNarrative.\n\nClaude-Code-Session-Id: s\n");
  });

  it("falls back to readStdin when no positional body is given", async () => {
    const readStdin = vi.fn(async () => "## Why\nFrom stdin.\n\n## Test Steps\n- [ ] x");
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(s.toString());
      return true;
    });
    const exit = await run(["--session-id", "s"], readStdin);
    writeSpy.mockRestore();
    expect(exit).toBe(0);
    expect(readStdin).toHaveBeenCalledOnce();
    expect(writes.join("")).toBe("## Why\nFrom stdin.\n\nClaude-Code-Session-Id: s\n");
  });

  it("returns exit code 2 on bad args (no --session-id)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = await run([]);
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });
});
