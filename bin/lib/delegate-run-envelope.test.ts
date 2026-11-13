import { describe, expect, it } from "vitest";
import { parseDelegateRun } from "./delegate-run-envelope";

describe("parseDelegateRun", () => {
  it("parses the last non-empty JSON line after noise lines", () => {
    const out = `noise\n${JSON.stringify({ ran: true, artifactPath: "/a" })}\n\n`;
    expect(parseDelegateRun(out, 0, "")).toEqual({
      ran: true,
      artifactPath: "/a",
    });
  });

  it("names a usage exit (2 + empty stdout) and keeps the stderr tail", () => {
    const env = parseDelegateRun(
      "",
      2,
      "flow-delegate: --prompt-file not found: /x\n",
    );
    expect(env).toMatchObject({
      ran: false,
      skipReason: "delegate-usage-error",
      exitCode: 2,
    });
    expect(env.stderrTail).toContain("--prompt-file not found: /x");
  });

  it("omits stderrTail when a usage exit wrote nothing to stderr", () => {
    const env = parseDelegateRun("", 2, "  \n");
    expect(env.skipReason).toBe("delegate-usage-error");
    expect("stderrTail" in env).toBe(false);
  });

  it("redacts secret-looking tokens in the stderr tail", () => {
    const token = "sk-ant-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
    const env = parseDelegateRun("", 2, `bad arg key=${token}`);
    expect(env.stderrTail).not.toContain(token);
  });

  it("keeps a long file path readable in the stderr tail", () => {
    const longPath =
      "/Users/someone/code/me/flow-worktrees.noindex/flow-some-long-slug/.flow-tmp/scratch/gemini-lens/agent-output-gemini.json/prompt.txt";
    const env = parseDelegateRun(
      "",
      2,
      `flow-delegate: --prompt-file not found: ${longPath}`,
    );
    expect(env.stderrTail).toContain(longPath);
  });

  it.each([0, 1, null])("returns {} for empty stdout with exit %s", (code) => {
    expect(parseDelegateRun("", code, "boom")).toEqual({});
  });

  it("reports an unparseable last line", () => {
    expect(parseDelegateRun("not json\n", 0, "")).toEqual({
      ran: false,
      skipReason: "delegate-envelope-unparseable",
    });
  });
});
