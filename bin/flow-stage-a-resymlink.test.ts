/**
 * Tests for `bin/flow-stage-a-resymlink.ts` — stage A's step 5.5 as a
 * binary. Every subprocess is injected (`Runner`), so the decision table is
 * exercised without a git checkout or a real `flow install`; the recorded
 * argv list is the assertion surface.
 */

import { describe, expect, it } from "vitest";
import {
  FOLLOWUP_REASON,
  addedInstallPaths,
  parseArgs,
  parseDefaultBranch,
  resymlink,
  type RunResult,
  type Runner,
} from "./flow-stage-a-resymlink";

const OK: RunResult = { stdout: "", stderr: "", exitCode: 0 };

type Stub = {
  run: Runner;
  calls: string[][];
};

/**
 * A runner that answers by first-two-argv-token prefix. `git symbolic-ref`
 * and `git diff` default to a clean `main` checkout with nothing added;
 * every other call defaults to exit 0.
 */
function stub(
  overrides: Partial<{
    symbolicRef: RunResult;
    diff: RunResult;
    install: RunResult[];
  }> = {},
): Stub {
  const calls: string[][] = [];
  const installQueue = [...(overrides.install ?? [])];
  const run: Runner = (argv) => {
    calls.push(argv);
    if (argv[0] === "git" && argv[1] === "symbolic-ref") {
      return (
        overrides.symbolicRef ?? {
          ...OK,
          stdout: "refs/remotes/origin/main\n",
        }
      );
    }
    if (argv[0] === "git" && argv[1] === "diff") {
      return overrides.diff ?? OK;
    }
    if (argv[0] === "flow" && argv[1] === "install") {
      return installQueue.shift() ?? OK;
    }
    return OK;
  };
  return { run, calls };
}

const installCalls = (calls: string[][]) =>
  calls.filter((c) => c[0] === "flow" && c[1] === "install");
const followupCalls = (calls: string[][]) =>
  calls.filter((c) => c[0] === "flow-followups");

describe("flow-stage-a-resymlink — parseArgs", () => {
  it("accepts --worktree and --slug in either order", () => {
    expect(parseArgs(["--slug", "s", "--worktree", "/w"])).toEqual({
      worktree: "/w",
      slug: "s",
    });
  });

  it("rejects a missing flag, an unknown flag, and a valueless flag", () => {
    expect(parseArgs(["--worktree", "/w"])).toEqual({
      error: "--slug is required",
    });
    expect(parseArgs(["--nope", "x"])).toEqual({
      error: "unknown flag: --nope",
    });
    expect(parseArgs(["--worktree", "--slug"])).toEqual({
      error: "--worktree requires a value",
    });
  });
});

describe("flow-stage-a-resymlink — branch + path parsing", () => {
  it("reads the default branch out of git symbolic-ref", () => {
    expect(
      parseDefaultBranch({ ...OK, stdout: "refs/remotes/origin/trunk\n" }),
    ).toBe("trunk");
  });

  it("falls back to main on a failed or unexpected symbolic-ref", () => {
    expect(parseDefaultBranch({ ...OK, exitCode: 128 })).toBe("main");
    expect(parseDefaultBranch({ ...OK, stdout: "garbage\n" })).toBe("main");
  });

  it("selects only added paths under skills/, agents/, or workflows/", () => {
    const diff = [
      "skills/pipeline/flow-x/SKILL.md",
      "agents/core/flow-y.md",
      "workflows/core/z.workflow.js",
      "bin/flow-unrelated.ts",
      "docs/notes.md",
      "skillsets/not-a-match.md",
    ].join("\n");
    expect(addedInstallPaths(diff)).toEqual([
      "skills/pipeline/flow-x/SKILL.md",
      "agents/core/flow-y.md",
      "workflows/core/z.workflow.js",
    ]);
  });
});

describe("flow-stage-a-resymlink — no-op path", () => {
  it("reports added:false and runs no install when the branch adds nothing", () => {
    const s = stub({ diff: { ...OK, stdout: "bin/flow-unrelated.ts\n" } });
    expect(resymlink("/w", "slug", s.run)).toEqual({
      added: false,
      installOk: true,
      attempts: 0,
    });
    expect(installCalls(s.calls)).toEqual([]);
    expect(followupCalls(s.calls)).toEqual([]);
  });

  it("treats a failing git diff as nothing-added and warns rather than escalating", () => {
    const warnings: string[] = [];
    const s = stub({ diff: { ...OK, exitCode: 128, stderr: "bad revision" } });
    expect(resymlink("/w", "slug", s.run, (l) => warnings.push(l))).toEqual({
      added: false,
      installOk: true,
      attempts: 0,
    });
    expect(installCalls(s.calls)).toEqual([]);
    expect(warnings.join("\n")).toContain("git diff against origin/main");
  });
});

describe("flow-stage-a-resymlink — install path", () => {
  const ADDED = { ...OK, stdout: "skills/pipeline/flow-x/SKILL.md\n" };

  it("installs once from the worktree and registers the post-merge follow-up", () => {
    const s = stub({ diff: ADDED });
    expect(resymlink("/w", "slug", s.run)).toEqual({
      added: true,
      installOk: true,
      attempts: 1,
    });
    expect(installCalls(s.calls)).toEqual([
      ["flow", "install", "--upgrade", "--source", "/w"],
    ]);
    const followup = followupCalls(s.calls)[0];
    expect(followup).toContain("flow install --upgrade");
    expect(followup).toContain(FOLLOWUP_REASON);
    expect(followup).toContain("--auto");
  });

  it("retries exactly once and reports installOk on the retry's success", () => {
    const s = stub({
      diff: ADDED,
      install: [{ ...OK, exitCode: 1 }, OK],
    });
    expect(resymlink("/w", "slug", s.run)).toEqual({
      added: true,
      installOk: true,
      attempts: 2,
    });
    expect(installCalls(s.calls)).toHaveLength(2);
  });

  it("reports installOk:false after two failures, and still registers the follow-up", () => {
    const s = stub({
      diff: ADDED,
      install: [
        { ...OK, exitCode: 1 },
        { ...OK, exitCode: 1 },
      ],
    });
    expect(resymlink("/w", "slug", s.run)).toEqual({
      added: true,
      installOk: false,
      attempts: 2,
    });
    expect(installCalls(s.calls)).toHaveLength(2);
    expect(followupCalls(s.calls)).toHaveLength(1);
  });

  it("never retries a third time", () => {
    const s = stub({
      diff: ADDED,
      install: [{ ...OK, exitCode: 1 }, { ...OK, exitCode: 1 }, OK],
    });
    resymlink("/w", "slug", s.run);
    expect(installCalls(s.calls)).toHaveLength(2);
  });

  it("threads FLOW_SLUG to the install and follow-up subprocesses", () => {
    const seen: Array<{ argv: string[]; env?: Record<string, string> }> = [];
    const run: Runner = (argv, opts) => {
      seen.push({ argv, env: opts.env });
      if (argv[1] === "symbolic-ref")
        return { ...OK, stdout: "refs/remotes/origin/main\n" };
      if (argv[1] === "diff") return ADDED;
      return OK;
    };
    resymlink("/w", "my-slug", run);
    const withEnv = seen.filter((c) => c.env?.FLOW_SLUG === "my-slug");
    expect(withEnv.map((c) => c.argv[0])).toEqual(["flow", "flow-followups"]);
  });
});
