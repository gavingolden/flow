import { describe, expect, it } from "vitest";
import {
  attributeSpawn,
  classifyBash,
  failureClass,
  isVerifyInvocation,
  verifyOutcome,
} from "./applier-turns";
import { walkFile } from "./token-spend-audit";

const usage = {
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const asst = (id: string, content: object[]) => ({
  type: "assistant",
  timestamp: "2026-10-01T00:00:00Z",
  message: { id, model: "claude-sonnet-5-5", usage, content },
});
const use = (id: string, name: string, input: object) => ({
  type: "tool_use",
  id,
  name,
  input,
});
const result = (id: string, content: string, is_error = false) => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content, is_error }],
  },
});
const failJson = (names: string[], extra = "") =>
  JSON.stringify({
    allPassed: false,
    results: names.map((name) => ({
      name,
      scope: "docs",
      passed: false,
    })),
  }) + extra;

describe("isVerifyInvocation", () => {
  it("should not count mentions of the helper as a verify run", () => {
    expect(isVerifyInvocation("which flow-pre-commit")).toBe(false);
    expect(isVerifyInvocation("pgrep -f flow-pre-commit")).toBe(false);
    expect(isVerifyInvocation("which flow-md-validate flow-pre-commit")).toBe(
      false,
    );
    expect(isVerifyInvocation("cat bin/flow-pre-commit.ts")).toBe(false);
    expect(isVerifyInvocation("flow-pre-commit --help")).toBe(false);
    expect(
      isVerifyInvocation('ps -ax | grep -E "vitest|flow-pre-commit" | head'),
    ).toBe(false);
  });

  it("should count real invocations including wrapped ones", () => {
    expect(
      isVerifyInvocation(
        "env -u FLOW_SLUG flow-pre-commit --json > out.json 2>&1; echo DONE_$?",
      ),
    ).toBe(true);
    expect(
      isVerifyInvocation('flow-pre-commit --pr "12" 2>&1 | tail -50'),
    ).toBe(true);
    expect(isVerifyInvocation("cd /w && npm run verify")).toBe(true);
  });
});

describe("verifyOutcome", () => {
  const cmd =
    "env -u FLOW_SLUG flow-pre-commit --json > out.json 2>&1; echo DONE_$?";
  it("should read the DONE_ marker as the exit status", () => {
    expect(verifyOutcome("DONE_1", cmd)).toBe(false);
    expect(verifyOutcome("DONE_0", cmd)).toBe(true);
  });

  it("should read allPassed from the JSON report and human output", () => {
    expect(verifyOutcome('{"allPassed": true}', "flow-pre-commit --json")).toBe(
      true,
    );
    expect(
      verifyOutcome("All 3 checks passed.", "flow-pre-commit --pr 4"),
    ).toBe(true);
    expect(
      verifyOutcome("  FAIL  npm run lint (2s)\n1/2 checks passed.", "x"),
    ).toBe(false);
  });

  it("should return null for a parked run", () => {
    expect(
      verifyOutcome("Command moved to the background. ID: b1", cmd),
    ).toBeNull();
  });
});

describe("failureClass", () => {
  it("should call a lint-only failure with warnings prettier-only", () => {
    expect(failureClass(["npm run lint"], true)).toBe("lint-only (prettier)");
    expect(failureClass(["npm run lint"], false)).toBe(
      "lint-only (eslint/other)",
    );
  });

  it("should classify tests, typecheck and unparsed failures", () => {
    expect(failureClass(["npm run test"], false)).toBe("tests");
    expect(failureClass(["npm run typecheck:scripts"], false)).toBe(
      "typecheck",
    );
    expect(failureClass([], false)).toBe("unparsed-fail");
  });
});

describe("classifyBash", () => {
  it("should separate verify, polling, reads and searches", () => {
    expect(classifyBash("flow-pre-commit --json")).toBe(
      "verify:flow-pre-commit",
    );
    expect(classifyBash("npm run verify")).toBe("verify:npm-verify");
    expect(classifyBash("sleep 30; cat /x/tasks/abc.output")).toBe(
      "verify:wait-poll",
    );
    expect(classifyBash("which flow-pre-commit")).toBe("bash-other");
    expect(classifyBash("sed -n '1,20p' a.ts")).toBe("bash-read");
    expect(classifyBash("grep -rn foo bin/")).toBe("bash-search");
    expect(classifyBash("npx vitest run bin/a.test.ts")).toBe("test:targeted");
  });
});

describe("attributeSpawn", () => {
  const verifyCmd =
    "env -u FLOW_SLUG flow-pre-commit --json > out.json 2>&1; echo DONE_$?";
  const transcript = [
    asst("m1", [use("t1", "Edit", { file_path: "/w/a.ts" })]),
    result(
      "t1",
      "<tool_use_error>File has not been read yet.</tool_use_error>",
      true,
    ),
    asst("m2", [use("t2", "Read", { file_path: "/w/a.ts" })]),
    result("t2", "1\tcontent"),
    asst("m3", [use("t3", "Bash", { command: verifyCmd, timeout: 600000 })]),
    result("t3", "DONE_1"),
    asst("m4", [use("t4", "Bash", { command: "cat out.json" })]),
    result("t4", failJson(["npm run lint"], "\n[warn] a.ts")),
    asst("m5", [
      use("t5", "Bash", {
        command: "flow-pre-commit --json",
        timeout: 120000,
      }),
    ]),
    result("t5", "Command moved to the background. ID: b1"),
    asst("m6", [
      use("t6", "Bash", { command: "sleep 20; cat /t/tasks/b1.output" }),
    ]),
    result("t6", '{"allPassed": true}'),
  ];

  it("should count the verify and waste events", () => {
    const s = attributeSpawn(transcript);
    expect(s.turns).toBe(6);
    expect(s.refusedEdits).toBe(1);
    expect(s.verifyCalls).toBe(2);
    expect(s.fullVerifies).toBe(2);
    expect(s.verifyCallsWithTimeout).toBe(1);
    expect(s.parkedVerifies).toBe(1);
    expect(s.pollCalls).toBe(1);
    expect(s.finalVerify).toBe(true);
    expect(s.model).toBe("claude-sonnet-5-5");
  });

  it("should close a failed verify as a round whose next verify is parked", () => {
    const s = attributeSpawn([
      ...transcript.slice(0, 6),
      asst("m4", [
        use("t4", "Bash", {
          command: "flow-pre-commit --json 2>&1 | tail -80",
        }),
      ]),
      result("t4", failJson(["npm run lint"], "\n[warn] a.ts")),
      asst("m5", [use("t5", "Bash", { command: "flow-pre-commit --json" })]),
      result("t5", "Command moved to the background. ID: b1"),
    ]);
    expect(s.rounds).toEqual([
      { cls: "unparsed-fail", turns: 1, next: "fail" },
      { cls: "lint-only (prettier)", turns: 1, next: "unknown" },
    ]);
    expect(s.prettierRounds).toBe(1);
    expect(s.finalVerify).toBeNull();
  });

  it("should split a multi-tool turn evenly across categories", () => {
    const s = attributeSpawn([
      asst("m1", [
        use("a", "Grep", { pattern: "x" }),
        use("b", "Read", { file_path: "/w/a.ts" }),
      ]),
      result("a", "hit"),
      result("b", "body"),
    ]);
    expect(s.catTurns).toEqual({ search: 0.5, "read:first": 0.5 });
    expect(s.shares.search).toBe(0.5);
  });

  it("should repeat no turn for repeated lines of one message.id", () => {
    const s = attributeSpawn([
      asst("m1", [{ type: "text", text: "thinking" }]),
      asst("m1", [use("a", "Grep", { pattern: "x" })]),
      result("a", "hit"),
    ]);
    expect(s.turns).toBe(1);
    expect(s.catTurns).toEqual({ search: 1 });
  });

  it("should count turns the way the token-spend audit does", () => {
    const lines = transcript.map((r) => JSON.stringify(r));
    let audit = 0;
    walkFile(
      lines,
      { parseErrors: 0, missingUsage: 0, unknownModels: new Map() },
      () => audit++,
    );
    expect(attributeSpawn(transcript).turns).toBe(audit);
  });

  it("should read a stream-json trace the same as a transcript", () => {
    const stream = [
      { type: "system", subtype: "init", session_id: "s", model: "m" },
      ...transcript,
      { type: "result", subtype: "success", num_turns: 6, total_cost_usd: 1 },
    ];
    const a = attributeSpawn(transcript);
    const b = attributeSpawn(stream);
    expect(b).toEqual(a);
  });
});
