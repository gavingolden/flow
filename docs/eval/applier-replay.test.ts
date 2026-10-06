import { describe, expect, it } from "vitest";
import {
  checkFailures,
  editSetFiles,
  extractFlowTmpFiles,
  lastRuns,
  mergeRescore,
  parseWorktree,
  pickBaseSha,
  renderReport,
  rewritePrompt,
  selectTestFiles,
  verdict,
  type RunResult,
} from "./applier-replay";

describe("pickBaseSha", () => {
  const commits = [
    { oid: "aaa", committedDate: "2026-10-05T10:00:00Z" },
    { oid: "bbb", committedDate: "2026-10-05T11:00:00Z" },
    { oid: "ccc", committedDate: "2026-10-05T13:00:00Z" },
  ];
  it("should pick the latest commit at or before the spawn", () => {
    expect(pickBaseSha(commits, "2026-10-05T12:00:00Z", "parent")).toBe("bbb");
    expect(pickBaseSha(commits, "2026-10-05T11:00:00Z", "parent")).toBe("bbb");
  });
  it("should fall back to the first commit's parent when all are later", () => {
    expect(pickBaseSha(commits, "2026-10-05T09:00:00Z", "parent")).toBe(
      "parent",
    );
  });
});

describe("rewritePrompt", () => {
  const prompt = [
    "read the instructions at:",
    "  /home/u/.flow/overlays/slug/.claude/skills/flow-module-core/skills/flow-coder-instructions/SKILL.md",
    "",
    "Working directory (cd here before reading any project files):",
    "  /home/u/code/flow-slug",
    "",
    "Skill base directory (resolve sibling references against this absolute",
    "path — they do not exist relative to the worktree):",
    "  /home/u/.flow/overlays/slug/.claude/skills/flow-module-core/skills/flow-coder",
    "",
    "Write the structured artifact to (absolute path):",
    "  /home/u/code/flow-slug/.flow-tmp/coder-result.json",
  ].join("\n");
  const out = rewritePrompt(prompt, {
    fromWorktree: "/home/u/code/flow-slug",
    toWorktree: "/tmp/replay-1",
    instructionPath: "/runs/before/instructions/SKILL.md",
  });
  it("should rewrite the instruction, worktree, skill-base and artifact paths", () => {
    expect(out).toContain(
      "read the instructions at:\n  /runs/before/instructions/SKILL.md",
    );
    expect(out).toContain(
      "(cd here before reading any project files):\n  /tmp/replay-1\n",
    );
    expect(out).toContain("\n  /runs/before/instructions\n");
    expect(out).toContain("\n  /tmp/replay-1/.flow-tmp/coder-result.json");
  });
  it("should leave no original path behind", () => {
    expect(out).not.toContain("/home/u");
  });
  it("should find the worktree to rewrite", () => {
    expect(parseWorktree(prompt)).toBe("/home/u/code/flow-slug");
  });
});

describe("selectTestFiles", () => {
  const all = ["bin/a.test.ts", "bin/b.test.ts", "docs/eval/c.test.ts"];
  it("should keep a changed test file", () => {
    expect(selectTestFiles(["bin/a.test.ts"], all)).toEqual(["bin/a.test.ts"]);
  });
  it("should add the colocated test of a changed source file", () => {
    expect(selectTestFiles(["bin/b.ts", "docs/eval/c.md"], all)).toEqual([
      "bin/b.test.ts",
      "docs/eval/c.test.ts",
    ]);
  });
  it("should return nothing when no test matches", () => {
    expect(selectTestFiles(["docs/x.md", "bin/zzz.ts"], all)).toEqual([]);
    expect(selectTestFiles(["bin/b.ts"], [])).toEqual([]);
  });
});

const run = (o: Partial<RunResult>): RunResult => ({
  case: "pr-1",
  arm: "before",
  turns: 100,
  costUsd: 2,
  fullVerifies: 2,
  parkedVerifies: 1,
  prettierRounds: 1,
  verifyCalls: 2,
  verifyCallsWithTimeout: 0,
  finalVerify: true,
  tests: 10,
  ...o,
});
const good = (): RunResult[] => [
  run({}),
  run({
    arm: "after",
    turns: 90,
    parkedVerifies: 0,
    prettierRounds: 0,
    verifyCallsWithTimeout: 2,
  }),
];

describe("verdict", () => {
  it("should ship when every rule holds", () => {
    expect(verdict(good())).toEqual({ ship: true, reasons: [] });
  });
  const break_ = (fix: Partial<RunResult>, rule: string) => {
    const [b, a] = good();
    const v = verdict([b, { ...a, ...fix }]);
    expect(v.ship).toBe(false);
    expect(v.reasons.some((r) => r.startsWith(`(${rule})`))).toBe(true);
    expect(v.reasons.filter((r) => /^\([a-e]\)/.test(r))).toHaveLength(1);
  };
  it("should fail (a) when a before-pass is not an after-pass", () => {
    break_({ finalVerify: false }, "a");
  });
  it("should fail (b) when the after arm counts fewer tests", () => {
    break_({ tests: 9 }, "b");
  });
  it("should fail (c) when waste events rise", () => {
    break_({ prettierRounds: 2, parkedVerifies: 1 }, "c");
  });
  it("should fail (d) beyond 110% of the before turns", () => {
    break_({ turns: 111 }, "d");
    expect(verdict([good()[0], { ...good()[1], turns: 110 }]).ship).toBe(true);
  });
  it("should fail (e) when a verify call lacks the timeout or none ran", () => {
    break_({ verifyCallsWithTimeout: 1 }, "e");
    break_({ verifyCalls: 0, verifyCallsWithTimeout: 0 }, "e");
  });
  it("should fail (b) for a case with zero tests in both arms", () => {
    const [b, a] = good();
    const v = verdict([
      { ...b, tests: 0 },
      { ...a, tests: 0 },
    ]);
    expect(v.ship).toBe(false);
    expect(v.reasons.some((r) => r.startsWith("(b)"))).toBe(true);
  });
  it("should not ship a failed run or a case missing an arm", () => {
    const [b, a] = good();
    expect(verdict([b, { ...a, error: "error_max_budget_usd" }]).ship).toBe(
      false,
    );
    expect(verdict([b]).ship).toBe(false);
  });
  it("should let a re-run replace the first run of the same case and arm", () => {
    const [b, a] = good();
    const rerun = { ...a, tests: 10 };
    expect(verdict([b, { ...a, tests: 3 }, rerun]).ship).toBe(true);
    expect(lastRuns([b, { ...a, tests: 3 }, rerun])).toHaveLength(2);
  });
});

describe("report --check failure conditions", () => {
  it("should pass a clean result set", () => {
    expect(checkFailures(good())).toEqual([]);
  });
  it("should flag zero tests, a missing final verify and an errored run", () => {
    const [b, a] = good();
    expect(checkFailures([{ ...b, tests: 0 }, a])).toEqual([
      "pr-1/before: counted zero tests",
    ]);
    expect(checkFailures([b, { ...a, finalVerify: null }])).toEqual([
      "pr-1/after: no final verify outcome",
    ]);
    expect(checkFailures([b, { ...a, error: "timeout" }])).toEqual([
      "pr-1/after: run failed (timeout)",
    ]);
  });
  it("should print the verdict line in the report", () => {
    expect(renderReport(good())).toContain("**Verdict:** ship");
    expect(renderReport([good()[0]])).toContain("**Verdict:** no-ship");
  });
});

describe("snapshot recovery", () => {
  const wt = "/w/flow-x";
  const asst = (id: string, name: string, input: object) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
  const res = (id: string, content: string) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
  });
  it("should recover only the .flow-tmp files the run read before writing", () => {
    const files = extractFlowTmpFiles(
      [
        asst("1", "Read", { file_path: `${wt}/.flow-tmp/edit-set.json` }),
        res("1", '1\t[{"file":"a.ts"}]\n2\t'),
        asst("2", "Read", { file_path: `${wt}/.flow-tmp/coder-result.json` }),
        res("2", "1\t{}"),
        asst("3", "Write", { file_path: `${wt}/.flow-tmp/mine.json` }),
        res("3", "ok"),
        asst("4", "Read", { file_path: `${wt}/.flow-tmp/mine.json` }),
        res("4", "1\t{}"),
        asst("5", "Bash", { command: `cat ${wt}/.flow-tmp/scout.md` }),
        res("5", "scout body"),
        asst("6", "Read", { file_path: `${wt}/src/a.ts` }),
        res("6", "1\tx"),
      ],
      wt,
    );
    expect(files).toEqual({
      "edit-set.json": '[{"file":"a.ts"}]\n',
      "scout.md": "scout body",
    });
  });
  it("should read the edit-set files inline or from a recovered file", () => {
    const inline = `Edit-set (verbatim, JSON-shaped):\n  [\n{"file":"a.ts"},\n{"file":"b.ts"}\n]\n\nExcluded`;
    expect(editSetFiles(inline, {}, wt)).toEqual(["a.ts", "b.ts"]);
    const ondisk = `Edit-set (verbatim):\n  ${wt}/.flow-tmp/edit-set.json\n`;
    expect(
      editSetFiles(ondisk, { "edit-set.json": '[{"file":"c.ts"}]' }, wt),
    ).toEqual(["c.ts"]);
    expect(editSetFiles(ondisk, {}, wt)).toBeNull();
  });
});

describe("mergeRescore", () => {
  it("should replace stream fields and keep cost, verify, tests and error", () => {
    const old: RunResult = {
      case: "pr-1",
      arm: "after",
      turns: 10,
      costUsd: 1.5,
      fullVerifies: 2,
      parkedVerifies: 0,
      prettierRounds: 0,
      verifyCalls: 2,
      verifyCallsWithTimeout: 1,
      finalVerify: true,
      tests: 7,
      error: "timeout",
    };
    const fresh = {
      turns: 10,
      fullVerifies: 0,
      parkedVerifies: 0,
      prettierRounds: 0,
      verifyCalls: 0,
      verifyCallsWithTimeout: 0,
    } as Parameters<typeof mergeRescore>[1];
    expect(mergeRescore(old, fresh)).toEqual({
      ...old,
      fullVerifies: 0,
      verifyCalls: 0,
      verifyCallsWithTimeout: 0,
    });
  });
});
