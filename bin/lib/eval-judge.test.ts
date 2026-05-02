import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildJudgePrompt,
  extractAssistantText,
  JUDGE_FLAGS,
  parseVerdicts,
  runSoftChecks,
} from "./eval-judge";

let scratch!: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "eval-judge-"));
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  delete process.env.FLOW_EVAL_CLAUDE_BIN;
});

/** Write a stub claude binary that emits the given stream-json text on stdout. */
function writeStub(stream: string): string {
  const stubPath = path.join(scratch, "claude-stub");
  const streamPath = path.join(scratch, "stream.jsonl");
  fs.writeFileSync(streamPath, stream);
  fs.writeFileSync(
    stubPath,
    `#!/bin/sh\ncat ${JSON.stringify(streamPath)}\n`,
    { mode: 0o755 },
  );
  return stubPath;
}

const assistantText = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-opus-4-7",
      content: [{ type: "text", text }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  });

const resultEvent = (cost: number) =>
  JSON.stringify({ type: "result", subtype: "success", total_cost_usd: cost });

describe("buildJudgePrompt", () => {
  it("includes prompt, diff, and numbered criteria", () => {
    const out = buildJudgePrompt({
      prompt: "add a flag",
      diff: "diff --git a/foo b/foo",
      criteria: ["a", "b"],
    });
    expect(out).toContain("add a flag");
    expect(out).toContain("diff --git a/foo b/foo");
    expect(out).toContain("1. a");
    expect(out).toContain("2. b");
  });

  it("substitutes a placeholder when the diff is empty", () => {
    const out = buildJudgePrompt({ prompt: "x", diff: "", criteria: ["c"] });
    expect(out).toContain("(empty diff — no changes)");
  });
});

describe("parseVerdicts", () => {
  it("parses one verdict per criterion, matched by criterion text", () => {
    const text = [
      JSON.stringify({ criterion: "a", verdict: "yes", reason: "ok" }),
      JSON.stringify({ criterion: "b", verdict: "no", reason: "missing" }),
    ].join("\n");
    const v = parseVerdicts(text, ["a", "b"]);
    expect(v).toEqual([
      { criterion: "a", verdict: "yes", reason: "ok" },
      { criterion: "b", verdict: "no", reason: "missing" },
    ]);
  });

  it("synthesizes 'no' for criteria the judge skipped", () => {
    const text = JSON.stringify({ criterion: "a", verdict: "yes", reason: "ok" });
    const v = parseVerdicts(text, ["a", "b"]);
    expect(v[1]).toEqual({ criterion: "b", verdict: "no", reason: "judge produced no verdict" });
  });

  it("ignores malformed JSON lines and unknown criteria", () => {
    const text = [
      "not json",
      JSON.stringify({ criterion: "ghost", verdict: "yes", reason: "x" }),
      JSON.stringify({ criterion: "a", verdict: "yes", reason: "ok" }),
    ].join("\n");
    const v = parseVerdicts(text, ["a"]);
    expect(v).toEqual([{ criterion: "a", verdict: "yes", reason: "ok" }]);
  });

  it("treats a malformed verdict value as missing", () => {
    const text = JSON.stringify({ criterion: "a", verdict: "maybe", reason: "x" });
    const v = parseVerdicts(text, ["a"]);
    expect(v[0].verdict).toBe("no");
    expect(v[0].reason).toContain("no verdict");
  });
});

describe("extractAssistantText", () => {
  it("concatenates text blocks across assistant events", () => {
    const stream = [assistantText("hello "), assistantText("world")].join("\n");
    expect(extractAssistantText(stream)).toBe("hello world");
  });

  it("returns empty string when no assistant events exist", () => {
    expect(extractAssistantText("")).toBe("");
  });
});

describe("runSoftChecks", () => {
  it("returns pass=true with empty verdicts when criteria list is empty", async () => {
    const r = await runSoftChecks({ prompt: "x", diff: "y", criteria: [] });
    expect(r.pass).toBe(true);
    expect(r.verdicts).toEqual([]);
    expect(r.judgeCost.usd).toBe(0);
  });

  it("invokes the stubbed claude binary and parses verdicts", async () => {
    const stream = [
      assistantText(JSON.stringify({ criterion: "a", verdict: "yes", reason: "good" }) + "\n"),
      resultEvent(0.0123),
    ].join("\n");
    process.env.FLOW_EVAL_CLAUDE_BIN = writeStub(stream);

    const r = await runSoftChecks({ prompt: "x", diff: "y", criteria: ["a"] });

    expect(r.pass).toBe(true);
    expect(r.verdicts).toEqual([{ criterion: "a", verdict: "yes", reason: "good" }]);
    expect(r.judgeCost.usd).toBe(0.0123);
  });

  it("returns pass=false when any verdict is no", async () => {
    const stream = [
      assistantText(
        JSON.stringify({ criterion: "a", verdict: "yes", reason: "ok" }) +
          "\n" +
          JSON.stringify({ criterion: "b", verdict: "no", reason: "missing" }),
      ),
      resultEvent(0.001),
    ].join("\n");
    process.env.FLOW_EVAL_CLAUDE_BIN = writeStub(stream);

    const r = await runSoftChecks({ prompt: "x", diff: "y", criteria: ["a", "b"] });
    expect(r.pass).toBe(false);
    expect(r.verdicts.find((v) => v.criterion === "b")?.verdict).toBe("no");
  });

  it("throws when the judge process exits non-zero", async () => {
    const stubPath = path.join(scratch, "claude-fail");
    fs.writeFileSync(stubPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    process.env.FLOW_EVAL_CLAUDE_BIN = stubPath;

    await expect(runSoftChecks({ prompt: "x", diff: "y", criteria: ["a"] })).rejects.toThrow(
      /judge invocation failed/,
    );
  });
});

describe("JUDGE_FLAGS", () => {
  // Regression: --bare disables keychain reads, breaking OAuth/subscription
  // auth (the default for Claude Code users). The judge must run with normal
  // auth-discovery, isolated from project context via cwd instead.
  it("does not include --bare", () => {
    expect(JUDGE_FLAGS).not.toContain("--bare");
  });

  it("disables tools, slash commands, and session persistence", () => {
    expect(JUDGE_FLAGS).toContain("--no-session-persistence");
    expect(JUDGE_FLAGS).toContain("--disable-slash-commands");
    expect(JUDGE_FLAGS).toContain("--tools");
  });

  it("runs the judge in an empty cwd so worktree CLAUDE.md does not leak in", async () => {
    // The stub captures its cwd via $PWD into a sentinel file the test reads.
    const cwdFile = path.join(scratch, "cwd.txt");
    const stubPath = path.join(scratch, "claude-cwd");
    fs.writeFileSync(
      stubPath,
      `#!/bin/sh\necho "$PWD" > ${JSON.stringify(cwdFile)}\necho '${resultEvent(0)}'\n`,
      { mode: 0o755 },
    );
    process.env.FLOW_EVAL_CLAUDE_BIN = stubPath;

    await runSoftChecks({ prompt: "x", diff: "y", criteria: ["a"] });

    const recordedCwd = fs.readFileSync(cwdFile, "utf8").trim();
    expect(recordedCwd).not.toBe(process.cwd());
    // The harness creates a flow-eval-judge-* tmpdir per invocation.
    expect(path.basename(recordedCwd)).toMatch(/^flow-eval-judge-/);
  });
});
