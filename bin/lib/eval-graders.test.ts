import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expandPlaceholders,
  gradeAll,
  grade,
  matchValue,
  type GraderContext,
} from "./eval-graders";
import type { GraderSpec } from "./eval-suite";
import type { TranscriptMetrics } from "./eval-transcript";

function makeCtx(overrides: Partial<GraderContext> = {}): GraderContext {
  const files: Record<string, string> = {};
  const transcript: TranscriptMetrics = {
    finalContextTokens: 1000,
    totalInputTokens: 500,
    totalOutputTokens: 100,
    assistantMessages: 2,
    toolCalls: { Bash: 3, Read: 1 },
    modelShare: { haiku: 1 },
    subagentsSpawned: 0,
    maxSubagentDepth: 0,
    costUsd: 0.05,
    durationMs: 2000,
    numTurns: 3,
    permissionDenials: 0,
  };
  return {
    repoDir: "/repo",
    fixtureRoot: "/fixture",
    stateSlug: "eval-test-s1-r1",
    stateDir: "/state",
    streamPath: "/out/stream.jsonl",
    assistantTextPath: "/out/assistant-text.txt",
    result: {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 3,
      total_cost_usd: 0.05,
      duration_ms: 2000,
      session_id: "s",
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      structured_output: { decision: "proceed", nested: { flag: true } },
    },
    transcript,
    runCommand: () => ({ exitCode: 0, stdout: "" }),
    readFile: (p) =>
      Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null,
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    ...overrides,
  };
}

describe("matchValue", () => {
  it("equals does a deep-equal", () => {
    expect(matchValue({ equals: { a: 1 } }, { a: 1 }).pass).toBe(true);
    expect(matchValue({ equals: { a: 1 } }, { a: 2 }).pass).toBe(false);
    expect(matchValue({ equals: null }, null).pass).toBe(true);
    expect(matchValue({ equals: null }, undefined).pass).toBe(false); // absent !== null
  });
  it("oneOf checks membership by deep-equal", () => {
    expect(matchValue({ oneOf: ["a", "b"] }, "b").pass).toBe(true);
    expect(matchValue({ oneOf: ["a", "b"] }, "c").pass).toBe(false);
  });
  it("contains works over a string or an array", () => {
    expect(matchValue({ contains: "flow" }, "flow-module-core").pass).toBe(
      true,
    );
    expect(matchValue({ contains: "flow" }, ["a", "flow"]).pass).toBe(true);
    expect(matchValue({ contains: "flow" }, ["a", "b"]).pass).toBe(false);
    expect(
      matchValue({ contains: "Test Step 2" }, [
        "Test Step 2 (screenshot reviewed)",
      ]).pass,
    ).toBe(true);
    expect(matchValue({ contains: "2" }, [2]).pass).toBe(false);
  });
  it("matches/notMatches run a regex over String(actual)", () => {
    expect(matchValue({ matches: "^ok" }, "okay").pass).toBe(true);
    expect(matchValue({ notMatches: "NOTICE" }, "clean output").pass).toBe(
      true,
    );
    expect(
      matchValue({ notMatches: "NOTICE" }, "NOTICE — agent-fallback").pass,
    ).toBe(false);
  });
  it("exists compares presence against the expected boolean", () => {
    expect(matchValue({ exists: true }, "x").pass).toBe(true);
    expect(matchValue({ exists: true }, undefined).pass).toBe(false);
    expect(matchValue({ exists: false }, undefined).pass).toBe(true);
  });
});

describe("expandPlaceholders", () => {
  it("expands $REPO/$FIXTURE/$STREAM directly", () => {
    const ctx = makeCtx();
    expect(expandPlaceholders("$REPO/src/x.ts", ctx)).toBe("/repo/src/x.ts");
    expect(expandPlaceholders("$FIXTURE/case.json", ctx)).toBe(
      "/fixture/case.json",
    );
    expect(expandPlaceholders("$STREAM", ctx)).toBe("/out/stream.jsonl");
  });

  it("expands $ASSISTANT_TEXT to ctx.assistantTextPath", () => {
    const ctx = makeCtx();
    expect(expandPlaceholders("$ASSISTANT_TEXT", ctx)).toBe(
      "/out/assistant-text.txt",
    );
  });

  it("expands $STATE/$CHECKPOINTS through the real helpers", () => {
    const ctx = makeCtx();
    expect(expandPlaceholders("$STATE", ctx)).toContain(
      path.join("/state", `${ctx.stateSlug}.json`),
    );
    expect(expandPlaceholders("$CHECKPOINTS/checkpoint.md", ctx)).toContain(
      path.join("/state", "checkpoints", ctx.stateSlug, "checkpoint.md"),
    );
  });
});

describe("grade", () => {
  it("structured: reads ctx.result.structured_output at a dotted path", () => {
    const ctx = makeCtx();
    const spec: GraderSpec = {
      id: "g1",
      kind: "structured",
      path: "decision",
      equals: "proceed",
    };
    expect(grade(spec, ctx).pass).toBe(true);
    const nested: GraderSpec = {
      id: "g2",
      kind: "structured",
      path: "nested.flag",
      equals: true,
    };
    expect(grade(nested, ctx).pass).toBe(true);
  });

  it("structured: populates expected/actual on failure", () => {
    const ctx = makeCtx();
    const spec: GraderSpec = {
      id: "g1",
      kind: "structured",
      path: "decision",
      equals: "skip",
    };
    const result = grade(spec, ctx);
    expect(result.pass).toBe(false);
    expect(result.expected).toBe("skip");
    expect(result.actual).toBe("proceed");
  });

  it("json-file: reads+parses a file and matches a dotted path", () => {
    const ctx = makeCtx({
      readFile: (p) =>
        p === "/state/eval-test-s1-r1.json"
          ? JSON.stringify({ phase: "verifying" })
          : null,
    });
    const spec: GraderSpec = {
      id: "g1",
      kind: "json-file",
      file: "$STATE",
      path: "phase",
      equals: "verifying",
    };
    expect(grade(spec, ctx).pass).toBe(true);
  });

  it("json-file: fails cleanly when the file is missing", () => {
    const ctx = makeCtx();
    const spec: GraderSpec = {
      id: "g1",
      kind: "json-file",
      file: "$STATE",
      path: "phase",
      equals: "verifying",
    };
    const result = grade(spec, ctx);
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/not found/);
  });

  it("file: matches exists/contains/matches/notMatches on file text", () => {
    const ctx = makeCtx({
      readFile: (p) =>
        p === "/out/stream.jsonl" ? "flow-module-core loaded fine" : null,
      exists: (p) => p === "/out/stream.jsonl",
    });
    expect(
      grade({ id: "g1", kind: "file", file: "$STREAM", exists: true }, ctx)
        .pass,
    ).toBe(true);
    expect(
      grade(
        {
          id: "g2",
          kind: "file",
          file: "$STREAM",
          contains: "flow-module-core",
        },
        ctx,
      ).pass,
    ).toBe(true);
    expect(
      grade(
        {
          id: "g3",
          kind: "file",
          file: "$STREAM",
          notMatches: "NOTICE — agent-fallback:",
        },
        ctx,
      ).pass,
    ).toBe(true);
  });

  it("file: exists is a real filesystem check, not vacuously true (regression: ctx.exists's boolean return must not be re-matched against 'actual !== undefined')", () => {
    const ctx = makeCtx({ exists: () => false });
    // The file does NOT exist, so `exists: true` must FAIL — a prior bug
    // routed this through matchValue's generic exists matcher, which
    // checks `actual !== undefined` on the ALREADY-boolean return of
    // ctx.exists(), making every `exists: true` grader pass unconditionally.
    expect(
      grade({ id: "g1", kind: "file", file: "$STREAM", exists: true }, ctx)
        .pass,
    ).toBe(false);
    expect(
      grade({ id: "g2", kind: "file", file: "$STREAM", exists: false }, ctx)
        .pass,
    ).toBe(true);
  });

  it("file: caps a failed grader's `actual` to a bounded excerpt plus byte count for a large $STREAM", () => {
    const big = "x".repeat(2000);
    const ctx = makeCtx({
      readFile: (p) => (p === "/out/stream.jsonl" ? big : null),
      exists: (p) => p === "/out/stream.jsonl",
    });
    const result = grade(
      { id: "g1", kind: "file", file: "$STREAM", contains: "not-present" },
      ctx,
    );
    expect(result.pass).toBe(false);
    expect(typeof result.actual).toBe("string");
    expect((result.actual as string).length).toBeLessThan(600);
    expect(result.actual).toContain("truncated, 2000 bytes total");
  });

  it("command: runs argv in cwd and compares exit code to expectExit (default 0)", () => {
    const ctx = makeCtx({
      runCommand: (argv) => ({
        exitCode: argv[0] === "bun" ? 0 : 1,
        stdout: "",
      }),
    });
    expect(
      grade({ id: "g1", kind: "command", argv: ["bun", "test"] }, ctx).pass,
    ).toBe(true);
    expect(grade({ id: "g2", kind: "command", argv: ["fail"] }, ctx).pass).toBe(
      false,
    );
    expect(
      grade({ id: "g3", kind: "command", argv: ["fail"], expectExit: 1 }, ctx)
        .pass,
    ).toBe(true);
  });

  it("metric: records {value,direction} and gates only when max/min set", () => {
    const ctx = makeCtx();
    const unbounded: GraderSpec = {
      id: "g1",
      kind: "metric",
      source: "transcript.finalContextTokens",
      direction: "lower",
    };
    const unboundedResult = grade(unbounded, ctx);
    expect(unboundedResult.gate).toBe(false);
    expect(unboundedResult.pass).toBe(true);

    const bounded: GraderSpec = {
      id: "g2",
      kind: "metric",
      source: "transcript.toolCalls.Bash",
      direction: "lower",
      min: 5,
    };
    const boundedResult = grade(bounded, ctx);
    expect(boundedResult.gate).toBe(true);
    expect(boundedResult.pass).toBe(false); // toolCalls.Bash is 3, min is 5
  });
});

describe("git-clean grading", () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "flow-eval-gitclean-"));
    spawnSync("git", ["init", "-q"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "test@test.local"], {
      cwd: repo,
    });
    spawnSync("git", ["config", "user.name", "test"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "tracked.txt"), "hi\n");
    spawnSync("git", ["add", "tracked.txt"], { cwd: repo });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function realRunCommand(argv: string[], cwd: string) {
    const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8" });
    return { exitCode: result.status ?? -1, stdout: result.stdout ?? "" };
  }

  it("passes on a clean tree", () => {
    const ctx = makeCtx({ repoDir: repo, runCommand: realRunCommand });
    expect(grade({ id: "g1", kind: "git-clean" }, ctx).pass).toBe(true);
  });

  it("fails when there is an unignored dirty path", () => {
    fs.writeFileSync(path.join(repo, "dirty.txt"), "oops\n");
    const ctx = makeCtx({ repoDir: repo, runCommand: realRunCommand });
    expect(grade({ id: "g1", kind: "git-clean" }, ctx).pass).toBe(false);
  });

  it("ignores paths matching allow globs", () => {
    fs.writeFileSync(path.join(repo, "scratch.log"), "noise\n");
    const ctx = makeCtx({ repoDir: repo, runCommand: realRunCommand });
    expect(
      grade({ id: "g1", kind: "git-clean", allow: ["*.log"] }, ctx).pass,
    ).toBe(true);
  });

  it("matches allow globs on unstaged modifications (` M` porcelain rows)", () => {
    fs.appendFileSync(path.join(repo, "tracked.txt"), "more\n");
    const ctx = makeCtx({ repoDir: repo, runCommand: realRunCommand });
    const result = grade(
      { id: "g1", kind: "git-clean", allow: ["tracked.txt"] },
      ctx,
    );
    expect(result.pass).toBe(true);
  });

  it("reports the full path (not truncated) for an unstaged modification", () => {
    fs.appendFileSync(path.join(repo, "tracked.txt"), "more\n");
    const ctx = makeCtx({ repoDir: repo, runCommand: realRunCommand });
    const result = grade({ id: "g1", kind: "git-clean" }, ctx);
    expect(result.pass).toBe(false);
    expect(result.actual).toEqual(["tracked.txt"]);
  });
});

describe("gradeAll", () => {
  it("computes score as passed gates / total gates, and records metrics separately", () => {
    const ctx = makeCtx();
    const specs: GraderSpec[] = [
      {
        id: "structured-ok",
        kind: "structured",
        path: "decision",
        equals: "proceed",
      },
      {
        id: "structured-bad",
        kind: "structured",
        path: "decision",
        equals: "skip",
      },
      {
        id: "informational",
        kind: "structured",
        path: "decision",
        equals: "skip",
        gate: false,
      },
      {
        id: "transcript.finalContextTokens",
        kind: "metric",
        source: "transcript.finalContextTokens",
        direction: "lower",
      },
    ];
    const { grades, metrics, score } = gradeAll(specs, ctx);
    expect(grades).toHaveLength(4);
    expect(score).toBe(0.5); // 1 of 2 real gates passed; informational + unbounded-metric excluded
    expect(metrics["transcript.finalContextTokens"]).toEqual({
      value: 1000,
      direction: "lower",
    });
  });

  it("excludes a thresholded (gate-only) metric spec from the recorded metrics map", () => {
    const ctx = makeCtx();
    const specs: GraderSpec[] = [
      {
        id: "bash-calls-floor",
        kind: "metric",
        source: "transcript.toolCalls.Bash",
        direction: "lower",
        min: 1,
      },
      {
        id: "transcript.toolCalls.Bash",
        kind: "metric",
        gate: false,
        source: "transcript.toolCalls.Bash",
        direction: "lower",
      },
    ];
    const { grades, metrics } = gradeAll(specs, ctx);
    expect(grades.find((g) => g.id === "bash-calls-floor")?.gate).toBe(true);
    expect(metrics["bash-calls-floor"]).toBeUndefined();
    expect(metrics["transcript.toolCalls.Bash"]).toBeDefined();
  });
});
