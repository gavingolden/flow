import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARMS,
  AUTO_MODE_STEER,
  armVerdict,
  buildMap,
  checkArtifact,
  checkShipped,
  ghRepoFromUrl,
  pickPr,
  slugFromWorktree,
  tokenWasRead,
  treeDrift,
  verdictsFor,
  withArmToken,
  type Production,
  recordedSteer,
} from "./applier-batching";
import type { RunResult } from "./applier-replay";

describe("slugFromWorktree", () => {
  it("should strip the repo prefix from the worktree directory name", () => {
    expect(slugFromWorktree("/c/me/econ-data-fix-it", "econ-data")).toBe(
      "fix-it",
    );
    expect(slugFromWorktree("/c/me/flow-a-b-2/", "flow")).toBe("a-b-2");
  });
  it("should return null for another repo or the bare clone", () => {
    expect(slugFromWorktree("/c/me/econ-data", "econ-data")).toBeNull();
    expect(slugFromWorktree("/c/me/pokemon-x", "flow")).toBeNull();
  });
});

describe("treeDrift", () => {
  const wt = "/w/econ-data-s";
  const read = (id: string, file: string, extra = {}) => ({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id,
          name: "Read",
          input: { file_path: file, ...extra },
        },
      ],
    },
  });
  const res = (id: string, text: string, is_error = false) => ({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: id, content: text, is_error },
      ],
    },
  });
  const base: Record<string, string> = { "a.ts": "one\ntwo\n" };
  const at = (rel: string) => base[rel] ?? null;

  it("should be empty when a whole-file read matches the base", () => {
    expect(
      treeDrift(
        [read("1", `${wt}/a.ts`), res("1", "     1\tone\n     2\ttwo\n")],
        wt,
        at,
      ),
    ).toEqual([]);
  });
  it("should list a whole-file read that differs from the base", () => {
    expect(
      treeDrift(
        [read("1", `${wt}/a.ts`), res("1", "     1\tone\n     2\tCHANGED\n")],
        wt,
        at,
      ),
    ).toEqual(["a.ts"]);
  });
  it("should list a read of a file absent at the base", () => {
    expect(
      treeDrift([read("1", `${wt}/new.ts`), res("1", "     1\tx\n")], wt, at),
    ).toEqual(["new.ts"]);
  });
  it("should ignore partial reads, errors, .flow-tmp and files edited first", () => {
    const edit = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "e",
            name: "Edit",
            input: { file_path: `${wt}/a.ts` },
          },
        ],
      },
    };
    expect(
      treeDrift(
        [
          read("1", `${wt}/a.ts`, { offset: 3 }),
          res("1", "     3\tzzz\n"),
          read("2", `${wt}/a.ts`),
          res("2", "File does not exist", true),
          read("3", `${wt}/.flow-tmp/plan.md`),
          res("3", "1\tx"),
          edit,
          read("4", `${wt}/a.ts`),
          res("4", "     1\tdifferent\n"),
        ],
        wt,
        at,
      ),
    ).toEqual([]);
  });
  it("should read a whole-file cat as a pre-edit read", () => {
    const cat = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "c",
            name: "Bash",
            input: { command: `cd ${wt} && cat a.ts` },
          },
        ],
      },
    };
    expect(treeDrift([cat, res("c", "one\ntwo\n")], wt, at)).toEqual([]);
    expect(treeDrift([cat, res("c", "other\n")], wt, at)).toEqual(["a.ts"]);
  });
});

describe("pickPr", () => {
  const prs = [
    { number: 1, createdAt: "2026-09-01T00:00:00Z" },
    { number: 2, createdAt: "2026-10-01T00:00:00Z" },
    { number: 3, createdAt: "2026-10-05T00:00:00Z" },
  ];
  it("should take the PR created nearest after the spawn", () => {
    expect(pickPr(prs, "2026-09-30T00:00:00Z")).toBe(2);
    expect(pickPr(prs, "2026-10-02T00:00:00Z")).toBe(3);
  });
  it("should fall back to the latest earlier PR, and null when none", () => {
    expect(pickPr(prs, "2026-11-01T00:00:00Z")).toBe(3);
    expect(pickPr([], "2026-11-01T00:00:00Z")).toBeNull();
  });
});

describe("ghRepoFromUrl", () => {
  it("should parse https and ssh remotes", () => {
    expect(ghRepoFromUrl("https://github.com/o/r.git")).toBe("o/r");
    expect(ghRepoFromUrl("git@github.com:o/r.git")).toBe("o/r");
    expect(ghRepoFromUrl("/local/path")).toBeNull();
  });
});

describe("buildMap", () => {
  it("should map an edit-applier spawn to its repo, slug and PR from the prompt's worktree", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "map-"));
    const sa = path.join(dir, "-canon", "sid", "subagents");
    fs.mkdirSync(sa, { recursive: true });
    const prompt =
      "You are the Independent Edit-Applier Subagent.\nWorking directory (cd here before reading any project files):\n  /c/me/econ-data-my-slug\n";
    const recs = [
      {
        type: "user",
        cwd: "/c/me/econ-data",
        timestamp: "2026-10-01T00:00:00Z",
        message: { role: "user", content: prompt },
      },
      {
        type: "assistant",
        timestamp: "2026-10-01T00:00:01Z",
        message: {
          id: "m1",
          model: "claude-sonnet-5-5",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [],
        },
      },
    ];
    fs.writeFileSync(
      path.join(sa, "agent-1.jsonl"),
      recs.map((r) => JSON.stringify(r)).join("\n"),
    );
    fs.writeFileSync(
      path.join(sa, "agent-1.meta.json"),
      JSON.stringify({ agentType: "flow-edit-applier" }),
    );
    const asked: string[] = [];
    const rows = buildMap(
      { projects: dir, since: Date.parse("2026-09-01T00:00:00Z") },
      {
        ghRepoOf: () => "o/econ-data",
        prsFor: (gh, slug) => {
          asked.push(`${gh}#${slug}`);
          return [{ number: 7, createdAt: "2026-10-02T00:00:00Z" }];
        },
      },
    );
    expect(rows).toEqual([
      [
        "2026-10-01T00:00:00Z",
        "econ-data",
        "my-slug",
        "claude-sonnet-5-5",
        1,
        7,
        path.join("-canon", "sid", "subagents", "agent-1.jsonl"),
      ],
    ]);
    expect(asked).toEqual(["o/econ-data#my-slug"]);
    expect(
      buildMap(
        { projects: dir, since: Date.parse("2026-11-01T00:00:00Z") },
        { ghRepoOf: () => null, prsFor: () => [] },
      ),
    ).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("withArmToken", () => {
  it("should insert the token line directly after the sentinel", () => {
    const text = "# T\n\n<!-- flow-instructions-sentinel: x -->\n\nbody\n";
    expect(withArmToken(text, "arm-1")).toBe(
      "# T\n\n<!-- flow-instructions-sentinel: x -->\n<!-- replay-arm-token: arm-1 -->\n\nbody\n",
    );
  });
  it("should throw when the sentinel line is missing", () => {
    expect(() => withArmToken("# T\nbody", "t")).toThrow(/sentinel/);
  });
});

describe("tokenWasRead", () => {
  const ev = (content: unknown) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "1", content }] },
  });
  it("should find the token in any tool result form", () => {
    expect(
      tokenWasRead([ev("   3\t<!-- replay-arm-token: t-1 -->")], "t-1"),
    ).toBe(true);
    expect(tokenWasRead([ev([{ type: "text", text: "x t-1 y" }])], "t-1")).toBe(
      true,
    );
    expect(
      tokenWasRead([ev("<!-- replay-arm-token: t-1 -->\nrest")], "t-1"),
    ).toBe(true);
  });
  it("should be false when no result carries it", () => {
    expect(tokenWasRead([ev("nothing")], "t-1")).toBe(false);
    expect(
      tokenWasRead(
        [
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "t-1" }] },
          },
        ],
        "t-1",
      ),
    ).toBe(false);
    expect(tokenWasRead([], "t-1")).toBe(false);
  });
});

describe("checkArtifact", () => {
  const art = (edits: object[], drop?: string) => {
    const a: Record<string, unknown> = {
      status: "complete",
      edits,
      verify_status: "pass",
      rejected_alternatives: [],
      anti_patterns_found: [],
      summary: "s",
    };
    if (drop) delete a[drop];
    return JSON.stringify(a);
  };
  const e = (file: string, applied = true) => ({ file, applied });
  it("should accept a complete artifact that matches the diff", () => {
    expect(
      checkArtifact(
        art([e("a.ts"), e("b.ts", false)]),
        ["a.ts", "b.ts"],
        ["a.ts"],
      ),
    ).toBe(true);
  });
  it("should reject a missing, unparsable or key-short artifact", () => {
    expect(checkArtifact(null, ["a.ts"], ["a.ts"])).toBe(false);
    expect(checkArtifact("{", ["a.ts"], ["a.ts"])).toBe(false);
    expect(checkArtifact(art([e("a.ts")], "summary"), ["a.ts"], ["a.ts"])).toBe(
      false,
    );
  });
  it("should reject an unaccounted edit-set file or an applied file with no diff", () => {
    expect(checkArtifact(art([e("a.ts")]), ["a.ts", "b.ts"], ["a.ts"])).toBe(
      false,
    );
    expect(checkArtifact(art([e("a.ts")]), ["a.ts"], [])).toBe(false);
  });
});

describe("AUTO_MODE_STEER", () => {
  it("should be a system-reminder carrying the Bash-first wording", () => {
    expect(AUTO_MODE_STEER.startsWith("<system-reminder>")).toBe(true);
    expect(AUTO_MODE_STEER.endsWith("</system-reminder>")).toBe(true);
    expect(AUTO_MODE_STEER).toContain("through the Bash tool");
  });
});

const prod: Production = { bashShare: 0.9, shellOpsPerTurn: 3.5 };
const row = (
  id: string,
  arm: string,
  o: Partial<RunResult> = {},
): RunResult => ({
  case: id,
  arm,
  turns: 100,
  costUsd: 2,
  fullVerifies: 2,
  parkedVerifies: 0,
  prettierRounds: 0,
  verifyCalls: 2,
  verifyCallsWithTimeout: 2,
  finalVerify: true,
  tests: 10,
  toolCalls: 100,
  bashCalls: 90,
  shellOps: 350,
  backgroundedVerifies: 0,
  pollCalls: 0,
  steerInjected: true,
  instructionsRead: true,
  artifactValid: true,
  ...o,
});
const AFTER_OK = { turns: 80, costUsd: 1.5, shellOps: 400 };
const trio = (
  arm: string,
  ids: string[],
  after: Partial<RunResult> = AFTER_OK,
  before: Partial<RunResult> = {},
) =>
  ids.flatMap((id) => [
    row(id, "before", before),
    row(id, arm, id === ids[0] ? after : AFTER_OK),
  ]);
const FLOW = ["pr-1", "pr-2", "pr-3"];
const ECON = ["econ-data-1", "econ-data-2"];
const batching = (runs: RunResult[]) => armVerdict("batching", runs, prod);
const timeout = (runs: RunResult[]) => armVerdict("verify-timeout", runs, prod);
const reasons = (v: { reasons: string[] }) => v.reasons.join("\n");

describe("armVerdict validity and exclusions", () => {
  it("should ship a clean batching fixture", () => {
    const v = batching(trio("batching", FLOW));
    expect(v.reasons).toEqual([]);
    expect(v.verdict).toBe("ship");
    expect(v.turns).toEqual({ before: 300, after: 240 });
    expect(v.shellOpsPerTurn.before).toBeCloseTo(3.5);
    expect(v.shellOpsPerTurn.after).toBeCloseTo(5);
  });
  it("should be inconclusive when a scored run lacks steerInjected or instructionsRead", () => {
    const a = trio("batching", FLOW, { ...AFTER_OK, instructionsRead: false });
    expect(batching(a).verdict).toBe("inconclusive");
    expect(reasons(batching(a))).toContain("instructionsRead=false");
    const b = trio("batching", FLOW, { ...AFTER_OK, steerInjected: undefined });
    expect(batching(b).verdict).toBe("inconclusive");
  });
  it("should exclude rateLimited rows from scoring", () => {
    const runs = [
      ...trio("batching", FLOW),
      row("pr-1", "batching", {
        rateLimited: true,
        finalVerify: null,
        tests: 0,
        instructionsRead: false,
      }),
    ];
    expect(batching(runs).verdict).toBe("ship");
  });
  it("should let a later row replace an earlier one", () => {
    const runs = [
      row("pr-1", "batching", { finalVerify: false, ...AFTER_OK }),
      ...trio("batching", FLOW),
    ];
    expect(batching(runs).verdict).toBe("ship");
    const worse = [
      ...trio("batching", FLOW),
      row("pr-1", "batching", { ...AFTER_OK, finalVerify: false }),
    ];
    expect(batching(worse).verdict).toBe("no-change");
  });
  it("should be inconclusive with no scored runs", () => {
    expect(batching([]).verdict).toBe("inconclusive");
    expect(timeout(trio("verify-timeout", FLOW)).verdict).toBe("inconclusive");
  });
});

describe("armVerdict gates", () => {
  it("g1: should be inconclusive when the before Bash share is off production by over 0.10", () => {
    const runs = trio("batching", FLOW, AFTER_OK, { bashCalls: 70 });
    const v = batching(runs);
    expect(v.verdict).toBe("inconclusive");
    expect(reasons(v)).toContain("g1");
    expect(
      batching(trio("batching", FLOW, AFTER_OK, { bashCalls: 81 })).verdict,
    ).toBe("ship");
  });
  it("g2: should be inconclusive when before shell ops per turn are off production by over 25%", () => {
    const v = batching(trio("batching", FLOW, AFTER_OK, { shellOps: 200 }));
    expect(v.verdict).toBe("inconclusive");
    expect(reasons(v)).toContain("g2");
    expect(
      batching(trio("batching", FLOW, AFTER_OK, { shellOps: 270 })).verdict,
    ).toBe("ship");
  });
  it("g3: should be inconclusive below the before-arm pass minimum", () => {
    const runs = trio("batching", FLOW).map((r) =>
      r.arm === "before" && r.case === "pr-1"
        ? { ...r, finalVerify: false }
        : r,
    );
    const v = batching(runs);
    expect(v.verdict).toBe("inconclusive");
    expect(reasons(v)).toContain("g3");
  });
  it("g3: should need 2 passes for verify-timeout over econ-data cases only", () => {
    const wait = { parkedVerifies: 1, ...{} };
    const ok = [
      ...trio(
        "verify-timeout",
        ECON,
        { turns: 90, costUsd: 1.5, shellOps: 350 },
        wait,
      ),
    ];
    expect(timeout(ok).reasons.join()).not.toContain("g3");
    const one = ok.map((r) =>
      r.arm === "before" && r.case === "econ-data-1"
        ? { ...r, finalVerify: false }
        : r,
    );
    expect(reasons(timeout(one))).toContain("g3");
    const flowOnly = trio("verify-timeout", FLOW, AFTER_OK, wait);
    expect(timeout(flowOnly).verdict).toBe("inconclusive");
  });
  it("g4: should need a parked or backgrounded verify in the before arm", () => {
    const none = trio("verify-timeout", ECON, {
      turns: 90,
      costUsd: 1.5,
      shellOps: 350,
    });
    expect(reasons(timeout(none))).toContain("g4");
    expect(timeout(none).verdict).toBe("inconclusive");
    const bg = trio(
      "verify-timeout",
      ECON,
      { turns: 90, costUsd: 1.5, shellOps: 350 },
      { backgroundedVerifies: 1 },
    );
    expect(reasons(timeout(bg))).not.toContain("g4");
  });
});

describe("armVerdict batching conditions", () => {
  const verdictOf = (
    after: Partial<RunResult>,
    tweak?: (r: RunResult[]) => RunResult[],
  ) => {
    const runs = trio("batching", FLOW, after);
    return batching(tweak ? tweak(runs) : runs);
  };
  it("(a): should fail when a before pass becomes an after fail, or either is missing", () => {
    const v = verdictOf({ ...AFTER_OK, finalVerify: false });
    expect(v.verdict).toBe("no-change");
    expect(reasons(v)).toContain("(a) pr-1");
    expect(reasons(verdictOf({ ...AFTER_OK, finalVerify: null }))).toContain(
      "(a)",
    );
    const missing = verdictOf(AFTER_OK, (rs) =>
      rs.filter((r) => !(r.case === "pr-3" && r.arm === "batching")),
    );
    expect(reasons(missing)).toContain("(a) pr-3: missing");
    expect(missing.verdict).toBe("no-change");
  });
  it("(b): should fail on a zero test count or fewer summed after tests", () => {
    expect(reasons(verdictOf({ ...AFTER_OK, tests: 0 }))).toContain("(b) pr-1");
    const fewer = verdictOf({ ...AFTER_OK, tests: 9 });
    expect(reasons(fewer)).toContain("(b) summed tests");
    expect(fewer.verdict).toBe("no-change");
    expect(verdictOf({ ...AFTER_OK, tests: 12 }).verdict).toBe("ship");
  });
  it("(c): should fail above 0.90 of before turns or when cost rises", () => {
    expect(verdictOf({ turns: 140, costUsd: 1.5, shellOps: 400 }).verdict).toBe(
      "no-change",
    );
    expect(
      reasons(verdictOf({ turns: 140, costUsd: 1.5, shellOps: 400 })),
    ).toContain("(c) turns");
    const dear = verdictOf({ ...AFTER_OK, costUsd: 9 });
    expect(reasons(dear)).toContain("(c) cost");
    expect(dear.verdict).toBe("no-change");
  });
  it("(d): should fail unless pooled after shell ops per turn exceed before", () => {
    const v = verdictOf({ ...AFTER_OK, shellOps: 200 }, (rs) =>
      rs.map((r) => (r.arm === "batching" ? { ...r, shellOps: 200 } : r)),
    );
    expect(reasons(v)).toContain("(d)");
    expect(v.verdict).toBe("no-change");
  });
  it("(e): should fail when a valid before artifact has an invalid after artifact", () => {
    const v = verdictOf({ ...AFTER_OK, artifactValid: false });
    expect(reasons(v)).toContain("(e) pr-1");
    expect(v.verdict).toBe("no-change");
    const both = trio(
      "batching",
      FLOW,
      { ...AFTER_OK, artifactValid: false },
      { artifactValid: false },
    );
    expect(batching(both).verdict).toBe("ship");
  });
});

describe("armVerdict verify-timeout conditions", () => {
  const waits = { parkedVerifies: 1, pollCalls: 4 };
  const quiet = { parkedVerifies: 0, pollCalls: 0 };
  const same = { turns: 100, costUsd: 2, shellOps: 350 };
  const build = (
    after: Partial<RunResult>,
    only?: (r: RunResult) => Partial<RunResult>,
  ): RunResult[] =>
    ECON.flatMap((id) => {
      const a = row(id, "verify-timeout", { ...same, ...quiet, ...after });
      return [row(id, "before", waits), { ...a, ...(only?.(a) ?? {}) }];
    });
  const onFirst = (patch: Partial<RunResult>) => (r: RunResult) =>
    r.case === "econ-data-1" ? patch : {};
  it("should ship when waits fall and turns and cost do not rise", () => {
    const v = timeout(build({}));
    expect(v.reasons).toEqual([]);
    expect(v.verdict).toBe("ship");
  });
  it("(a): should fail when a before pass becomes an after fail", () => {
    const v = timeout(build({}, onFirst({ finalVerify: false })));
    expect(reasons(v)).toContain("(a) econ-data-1");
    expect(v.verdict).toBe("no-change");
  });
  it("(b): should fail on a zero test count", () => {
    const v = timeout(build({}, onFirst({ tests: 0 })));
    expect(reasons(v)).toContain("(b) econ-data-1");
    expect(v.verdict).toBe("no-change");
  });
  it("(c): should allow no turn increase and no cost increase", () => {
    expect(reasons(timeout(build({ turns: 101 })))).toContain("(c) turns");
    expect(reasons(timeout(build({ costUsd: 2.5 })))).toContain("(c) cost");
    expect(timeout(build({ turns: 100, costUsd: 2 })).verdict).toBe("ship");
  });
  it("(e): should fail on an invalid after artifact", () => {
    const v = timeout(build({ artifactValid: false }));
    expect(reasons(v)).toContain("(e)");
    expect(v.verdict).toBe("no-change");
  });
  it("(f): should fail unless summed waits fall", () => {
    const v = timeout(build(waits));
    expect(reasons(v)).toContain("(f)");
    expect(v.verdict).toBe("no-change");
    expect(timeout(build({ parkedVerifies: 1, pollCalls: 3 })).verdict).toBe(
      "ship",
    );
  });
});

describe("verdictsFor and checkShipped", () => {
  it("should score both arms and compare each ship verdict to the live skill", () => {
    const runs = trio("batching", FLOW);
    const v = verdictsFor(runs, prod);
    expect(v.batching.verdict).toBe("ship");
    expect(v["verify-timeout"].verdict).toBe("inconclusive");
    expect(checkShipped(v, "no markers")).toEqual([
      "batching ships but its marker is not in the live skill",
    ]);
    expect(checkShipped(v, ARMS.batching.marker)).toEqual([]);
    expect(
      checkShipped(
        v,
        `${ARMS.batching.marker} ${ARMS["verify-timeout"].marker}`,
      ),
    ).toEqual([
      "verify-timeout does not ship but its marker is in the live skill",
    ]);
  });
});

describe("recordedSteer", () => {
  const att = (steer?: string) =>
    JSON.stringify({
      type: "attachment",
      attachment: { type: "auto_mode", bashFirstSteer: steer },
    });
  it("should return the first auto_mode attachment's steer flag", () => {
    expect(
      recordedSteer([
        JSON.stringify({ type: "user" }),
        att("relaxed"),
        att("strict"),
      ]),
    ).toBe("relaxed");
  });
  it("should return none when no auto_mode attachment is recorded", () => {
    expect(recordedSteer([JSON.stringify({ type: "user" })])).toBe("none");
  });
});
