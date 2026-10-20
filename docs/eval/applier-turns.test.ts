import { describe, expect, it } from "vitest";
import {
  attributeSpawn,
  classifyBash,
  editScript,
  failureClass,
  isCalendarDate,
  isLookupSegment,
  isVerifyInvocation,
  shellSegments,
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

  it("should not count heredoc bodies that merely mention a verify command", () => {
    expect(
      isVerifyInvocation(
        "python3 -I - <<'EOF'\nopen('r.json','w').write('ran npm run verify')\nEOF",
      ),
    ).toBe(false);
    expect(
      isVerifyInvocation(
        "cat > .flow-tmp/n.md <<'EOF'\nran flow-pre-commit --json\nEOF",
      ),
    ).toBe(false);
    expect(
      isVerifyInvocation("echo 'note: npm run verify is slow' > n.txt"),
    ).toBe(false);
    expect(
      isVerifyInvocation("env -u FLOW_SLUG npm run verify 2>&1 | tail -5"),
    ).toBe(true);
  });
});

describe("isVerifyInvocation after a heredoc", () => {
  it("should still count a real verify that follows a heredoc in the same command", () => {
    expect(
      isVerifyInvocation(
        "cat > n.md <<'EOF'\nran npm run verify\nEOF\nnpm run verify 2>&1 | tail -5",
      ),
    ).toBe(true);
    expect(
      isVerifyInvocation(
        "cat > n.md <<'EOF'\nran npm run verify\nEOF\nflow-pre-commit --json",
      ),
    ).toBe(true);
  });
});

describe("isCalendarDate", () => {
  it("should accept real dates and reject impossible or malformed ones", () => {
    expect(isCalendarDate("2026-09-05")).toBe(true);
    expect(isCalendarDate("2026-99-99")).toBe(false);
    expect(isCalendarDate("2026-02-31")).toBe(false);
    expect(isCalendarDate("2026-9-5")).toBe(false);
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

  it("should read the top-level allPassed, not one quoted in a failure excerpt", () => {
    const report = JSON.stringify({
      results: [
        {
          name: "npm run test",
          scope: "scripts",
          passed: false,
          failure: { firstErrorText: '  "allPassed": true,\n' },
        },
      ],
      allPassed: false,
    });
    expect(verifyOutcome(report, "flow-pre-commit --json")).toBe(false);
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

  it("should open a failed round when a backgrounded verify later reports a failure", () => {
    const s = attributeSpawn([
      asst("m1", [use("t1", "Bash", { command: "flow-pre-commit --json" })]),
      result("t1", "Command moved to the background. ID: b1"),
      asst("m2", [
        use("t2", "Bash", { command: "sleep 20; cat /t/tasks/b1.output" }),
      ]),
      result("t2", failJson(["npm run lint"], "\n[warn] a.ts")),
      asst("m3", [use("t3", "Bash", { command: "flow-pre-commit --json" })]),
      result("t3", '{"allPassed": true}'),
    ]);
    expect(s.rounds).toEqual([
      { cls: "lint-only (prettier)", turns: 1, next: "pass" },
    ]);
    expect(s.prettierRounds).toBe(1);
    expect(s.finalVerify).toBe(true);
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

describe("shellSegments", () => {
  it("should split on &&, ||, ; and newlines", () => {
    expect(shellSegments("a && b || c; d\ne")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("should strip a leading cd and heredoc bodies", () => {
    expect(shellSegments("cd /w && grep x f | head")).toEqual([
      "grep x f | head",
    ]);
    expect(
      shellSegments("python3 - <<'EOF'\nprint(1); print(2)\nEOF\nnpx vitest"),
    ).toEqual(["python3 -", "npx vitest"]);
  });
});

describe("isLookupSegment", () => {
  it("should accept read-only commands", () => {
    for (const c of [
      "cat a.ts",
      "sed -n '1,20p' a.ts",
      "grep -n x a.ts 2>/dev/null",
      "rg x",
      "head -5 a",
      "tail -5 a",
      "ls docs",
      "wc -l a",
      "find . -name '*.ts'",
      "git diff --stat",
      "git log --oneline",
      "git show HEAD:a",
      "git status",
    ]) {
      expect(isLookupSegment(c), c).toBe(true);
    }
  });

  it("should not read an operator inside a quoted pattern as a redirect", () => {
    for (const c of [
      'grep -n "=>" a.ts',
      'grep -n "() =>" src/a.ts',
      "rg 'x -> y'",
      'grep -n "a > b" a.ts',
    ]) {
      expect(isLookupSegment(c), c).toBe(true);
    }
    expect(isLookupSegment('grep -n "x" a.ts > out.txt')).toBe(false);
  });

  it("should reject writes and other commands", () => {
    for (const c of [
      "cat > a.ts",
      "sed -i s/a/b/ f",
      "find . -delete",
      "npx vitest run",
      "git commit -m x",
      "python3 -",
    ]) {
      expect(isLookupSegment(c), c).toBe(false);
    }
  });
});

describe("editScript", () => {
  const script = (body: string, tail = "") =>
    `python3 - <<'EOF'\n${body}\nEOF${tail}`;

  it("should return null unless a python heredoc writes a file", () => {
    expect(editScript("cat a.ts")).toBeNull();
    expect(editScript(script("print(1)"))).toBeNull();
    expect(
      editScript(
        script("open('r.json','w').write('x')").replace(
          "r.json",
          "coder-result.json",
        ),
      ),
    ).toBeNull();
  });

  it("should detect a match guard", () => {
    expect(
      editScript(
        script("s=open('a').read()\nassert 'x' in s\nopen('a','w').write(s)"),
      ),
    ).toEqual({ guarded: true, chained: false });
    expect(
      editScript(script("s=open('a').read()\nopen('a','w').write(s)")),
    ).toEqual({ guarded: false, chained: false });
  });

  it("should detect a chained check", () => {
    expect(
      editScript(script("open('a','w').write('x')", "\ngit diff --stat")),
    ).toEqual({ guarded: false, chained: true });
  });
});

describe("attributeSpawn tool-use habit", () => {
  const bash = (id: string, mid: string, command: string) =>
    asst(mid, [use(id, "Bash", { command })]);
  const verify = "flow-pre-commit --json";

  it("should read the auto-mode steer from an attachment record", () => {
    const att = (v: string) => ({
      type: "attachment",
      attachment: { type: "auto_mode", bashFirstSteer: v },
    });
    expect(attributeSpawn([att("relaxed")]).autoModeSteer).toBe("relaxed");
    expect(attributeSpawn([att("strict"), att("relaxed")]).autoModeSteer).toBe(
      "strict",
    );
    expect(attributeSpawn([asst("m1", [])]).autoModeSteer).toBe("none");
  });

  it("should count tool calls, shell operations and lookup-only turns", () => {
    const s = attributeSpawn([
      asst("m1", [
        use("t1", "Read", { file_path: "/w/a.ts" }),
        use("t2", "Grep", { pattern: "x" }),
      ]),
      result("t1", "x"),
      result("t2", "x"),
      bash("t3", "m2", "cd /w && cat a.ts && sed -n '1,5p' b.ts"),
      result("t3", "x"),
      bash("t4", "m3", "npx vitest run"),
      result("t4", "ok"),
      bash("t5", "m4", "grep x a.ts"),
      result("t5", "x"),
    ]);
    expect(s.toolCalls).toBe(5);
    expect(s.multiCallTurns).toBe(1);
    expect(s.bashCalls).toBe(3);
    expect(s.shellOps).toBe(4);
    expect(s.chainedBash).toBe(1);
    expect(s.lookupTurns).toBe(3);
    expect(s.lookupAfterLookup).toBe(1);
  });

  it("should not read a quoted > in a search pattern as a file write", () => {
    const s = attributeSpawn([
      bash("t1", "m1", verify),
      result("t1", failJson(["npm run lint"])),
      bash("t2", "m2", 'grep -n "() =>" src/a.ts'),
      result("t2", "1:x"),
      bash("t3", "m3", verify),
      result("t3", '{"allPassed": true}'),
    ]);
    expect(s.fixRounds).toBe(0);
    expect(s.noEditReruns).toBe(1);
    expect(s.lookupTurns).toBe(1);
  });

  it("should count edit scripts and tracebacks", () => {
    const cmd =
      "python3 - <<'EOF'\ns=open('a').read()\nassert 'x' in s\nopen('a','w').write(s)\nEOF\ngit diff";
    const s = attributeSpawn([
      bash("t1", "m1", cmd),
      result("t1", "Traceback (most recent call last):\n  AssertionError"),
    ]);
    expect(s.editScripts).toBe(1);
    expect(s.editScriptsGuarded).toBe(1);
    expect(s.editScriptsChained).toBe(1);
    expect(s.editScriptTracebacks).toBe(1);
  });

  it("should count only edit-separated verifies as fix rounds", () => {
    const s = attributeSpawn([
      bash("t1", "m1", verify),
      result("t1", failJson(["npm run lint"])),
      bash("t2", "m2", verify),
      result("t2", failJson(["npm run lint"])),
      asst("m3", [use("t3", "Edit", { file_path: "/w/a.ts" })]),
      result("t3", "ok"),
      bash("t4", "m4", verify),
      result("t4", failJson(["npm run lint"])),
      asst("m5", [
        use("t5", "Write", { file_path: "/w/.flow-tmp/coder-result.json" }),
      ]),
      result("t5", "ok"),
      bash("t6", "m6", verify),
      result("t6", '{"allPassed": true}'),
      bash("t7", "m7", "sed -i s/a/b/ a.ts"),
      result("t7", ""),
      bash("t8", "m8", `${verify} 2>&1 | tail -5`),
      result("t8", '{"allPassed": true}'),
      bash("t9", "m9", "which flow-pre-commit"),
      result("t9", "/bin/flow-pre-commit"),
    ]);
    expect(s.fixRounds).toBe(2);
    expect(s.noEditReruns).toBe(2);
  });
});
