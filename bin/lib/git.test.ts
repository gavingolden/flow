/**
 * Tests for `bin/lib/git.ts` — fail-open helpers used by `flow install
 * --upgrade` (`fastForwardCanonical` and `resolveDefaultBranch`).
 *
 * No real git or network access. The tests inject a Spawner stub that
 * returns scripted SpawnSyncReturns objects per command pattern, mirroring
 * the GitOps-injection pattern in `bin/flow-pre-commit.test.ts`.
 */

import { describe, expect, it } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import {
  changedInstallPaths,
  fastForwardCanonical,
  resolveDefaultBranch,
  type Spawner,
} from "./git";

type ScriptedReturn = {
  status: number;
  stdout?: string;
  stderr?: string;
};

type Matcher = (cmd: string, args: string[]) => boolean;

type Script = Array<{ match: Matcher; result: ScriptedReturn }>;

function ok(stdout = ""): ScriptedReturn {
  return { status: 0, stdout, stderr: "" };
}

function fail(stderr = "boom"): ScriptedReturn {
  return { status: 128, stdout: "", stderr };
}

function matchArgs(...prefix: string[]): Matcher {
  return (_cmd, args) => {
    if (args.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
      if (args[i] !== prefix[i]) return false;
    }
    return true;
  };
}

function makeSpawn(script: Script): { spawn: Spawner; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: Spawner = (cmd, args) => {
    calls.push([cmd, ...args]);
    for (const entry of script) {
      if (entry.match(cmd, args)) {
        return toReturn(entry.result);
      }
    }
    throw new Error(`unscripted spawn call: ${cmd} ${args.join(" ")}`);
  };
  return { spawn, calls };
}

function toReturn(r: ScriptedReturn): SpawnSyncReturns<string> {
  return {
    pid: 0,
    output: ["", r.stdout ?? "", r.stderr ?? ""],
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status,
    signal: null,
  };
}

describe("resolveDefaultBranch", () => {
  it("returns the branch from `git symbolic-ref` when it succeeds", () => {
    const { spawn } = makeSpawn([
      {
        match: matchArgs("symbolic-ref"),
        result: ok("refs/remotes/origin/main\n"),
      },
    ]);
    expect(resolveDefaultBranch("/repo", spawn)).toBe("main");
  });

  it("falls back to parsing `git remote show origin` when symbolic-ref fails", () => {
    const { spawn } = makeSpawn([
      { match: matchArgs("symbolic-ref"), result: fail() },
      {
        match: matchArgs("remote", "show"),
        result: ok(
          [
            "* remote origin",
            "  Fetch URL: git@github.com:foo/bar.git",
            "  HEAD branch: develop",
            "  Remote branches:",
          ].join("\n"),
        ),
      },
    ]);
    expect(resolveDefaultBranch("/repo", spawn)).toBe("develop");
  });

  it("returns null when both probes and the conventional fallbacks fail", () => {
    const { spawn } = makeSpawn([
      { match: matchArgs("symbolic-ref"), result: fail() },
      { match: matchArgs("remote", "show"), result: fail() },
      { match: matchArgs("rev-parse", "--verify"), result: fail() },
    ]);
    expect(resolveDefaultBranch("/repo", spawn)).toBeNull();
  });

  it("falls back to 'main' when symbolic-ref + remote-show both fail but rev-parse confirms origin/main", () => {
    const { spawn } = makeSpawn([
      { match: matchArgs("symbolic-ref"), result: fail() },
      { match: matchArgs("remote", "show"), result: fail() },
      {
        match: (_, a) =>
          a[0] === "rev-parse" && a[2] === "refs/remotes/origin/main",
        result: ok("abc123"),
      },
    ]);
    expect(resolveDefaultBranch("/repo", spawn)).toBe("main");
  });
});

describe("fastForwardCanonical", () => {
  function defaultProbes(extra: Script = []): Script {
    return [
      { match: matchArgs("status", "--porcelain"), result: ok() },
      {
        match: matchArgs("symbolic-ref"),
        result: ok("refs/remotes/origin/main\n"),
      },
      {
        match: matchArgs("rev-parse", "--abbrev-ref", "HEAD"),
        result: ok("main\n"),
      },
      ...extra,
    ];
  }

  it("returns 'ahead' with advanced=N when clean tree is behind by N commits", () => {
    const { spawn } = makeSpawn(
      defaultProbes([
        { match: matchArgs("fetch", "origin"), result: ok() },
        { match: matchArgs("rev-list", "--count"), result: ok("3\n") },
        {
          match: matchArgs("rev-parse", "--short", "HEAD"),
          result: ok("abc1234\n"),
        },
        { match: matchArgs("merge", "--ff-only"), result: ok() },
      ]),
    );
    const result = fastForwardCanonical({ canonicalRoot: "/repo", spawn });
    expect(result.status).toBe("ahead");
    expect(result.advanced).toBe(3);
  });

  it("populates beforeSha/afterSha (short form) on an ahead result", () => {
    let shortCalls = 0;
    const script: Script = [
      { match: matchArgs("status", "--porcelain"), result: ok() },
      {
        match: matchArgs("symbolic-ref"),
        result: ok("refs/remotes/origin/main\n"),
      },
      {
        match: matchArgs("rev-parse", "--abbrev-ref", "HEAD"),
        result: ok("main\n"),
      },
      { match: matchArgs("fetch", "origin"), result: ok() },
      { match: matchArgs("rev-list", "--count"), result: ok("2\n") },
      {
        match: matchArgs("rev-parse", "--short", "HEAD"),
        // Stateful: first call → before SHA, second → after SHA.
        get result() {
          return ok(shortCalls++ === 0 ? "a1b2c3d\n" : "e4f5g6h\n");
        },
      },
      { match: matchArgs("merge", "--ff-only"), result: ok() },
    ];
    const { spawn } = makeSpawn(script);
    const result = fastForwardCanonical({ canonicalRoot: "/repo", spawn });
    expect(result).toEqual({
      status: "ahead",
      advanced: 2,
      beforeSha: "a1b2c3d",
      afterSha: "e4f5g6h",
    });
  });

  it("returns 'up-to-date' when there are no commits to advance", () => {
    const { spawn } = makeSpawn(
      defaultProbes([
        { match: matchArgs("fetch", "origin"), result: ok() },
        { match: matchArgs("rev-list", "--count"), result: ok("0\n") },
      ]),
    );
    expect(fastForwardCanonical({ canonicalRoot: "/repo", spawn })).toEqual({
      status: "up-to-date",
    });
  });

  it("returns skipped/dirty when status --porcelain shows uncommitted changes", () => {
    const { spawn } = makeSpawn([
      {
        match: matchArgs("status", "--porcelain"),
        result: ok(" M bin/lib/git.ts\n"),
      },
    ]);
    expect(fastForwardCanonical({ canonicalRoot: "/repo", spawn })).toEqual({
      status: "skipped",
      reason: "dirty",
    });
  });

  it("returns skipped/non-default-branch when HEAD is on a feature branch", () => {
    const { spawn } = makeSpawn([
      { match: matchArgs("status", "--porcelain"), result: ok() },
      {
        match: matchArgs("symbolic-ref"),
        result: ok("refs/remotes/origin/main\n"),
      },
      {
        match: matchArgs("rev-parse", "--abbrev-ref", "HEAD"),
        result: ok("feature/x\n"),
      },
    ]);
    expect(fastForwardCanonical({ canonicalRoot: "/repo", spawn })).toEqual({
      status: "skipped",
      reason: "non-default-branch",
    });
  });

  it("returns skipped/fetch-failed when the network round-trip fails", () => {
    const { spawn } = makeSpawn(
      defaultProbes([
        { match: matchArgs("fetch", "origin"), result: fail("network down") },
      ]),
    );
    expect(fastForwardCanonical({ canonicalRoot: "/repo", spawn })).toEqual({
      status: "skipped",
      reason: "fetch-failed",
    });
  });

  it("returns skipped/merge-failed when fetch succeeds but ff-only merge diverges", () => {
    const { spawn } = makeSpawn(
      defaultProbes([
        { match: matchArgs("fetch", "origin"), result: ok() },
        { match: matchArgs("rev-list", "--count"), result: ok("2\n") },
        {
          match: matchArgs("rev-parse", "--short", "HEAD"),
          result: ok("abc1234\n"),
        },
        {
          match: matchArgs("merge", "--ff-only"),
          result: fail("Not possible to fast-forward"),
        },
      ]),
    );
    expect(fastForwardCanonical({ canonicalRoot: "/repo", spawn })).toEqual({
      status: "skipped",
      reason: "merge-failed",
    });
  });

  it("returns skipped/no-default-branch when resolveDefaultBranch returns null", () => {
    const { spawn } = makeSpawn([
      { match: matchArgs("status", "--porcelain"), result: ok() },
      { match: matchArgs("symbolic-ref"), result: fail() },
      { match: matchArgs("remote", "show"), result: fail() },
      { match: matchArgs("rev-parse", "--verify"), result: fail() },
    ]);
    expect(fastForwardCanonical({ canonicalRoot: "/repo", spawn })).toEqual({
      status: "skipped",
      reason: "no-default-branch",
    });
  });

  it("returns skipped/not-a-git-repo when status --porcelain itself fails", () => {
    const { spawn } = makeSpawn([
      {
        match: matchArgs("status", "--porcelain"),
        result: fail("not a git repository"),
      },
    ]);
    expect(fastForwardCanonical({ canonicalRoot: "/repo", spawn })).toEqual({
      status: "skipped",
      reason: "not-a-git-repo",
    });
  });

  it("does not call merge when no commits are pending (avoids redundant work)", () => {
    const { spawn, calls } = makeSpawn(
      defaultProbes([
        { match: matchArgs("fetch", "origin"), result: ok() },
        { match: matchArgs("rev-list", "--count"), result: ok("0\n") },
      ]),
    );
    fastForwardCanonical({ canonicalRoot: "/repo", spawn });
    expect(calls.find((c) => c[1] === "merge")).toBeUndefined();
  });
});

describe("changedInstallPaths", () => {
  it("maps skills/ and bin/ diffs to display names, deduped", () => {
    const { spawn } = makeSpawn([
      {
        match: matchArgs("-C", "/repo", "diff", "--name-only"),
        result: ok(
          [
            "skills/pipeline/flow-pr-review/SKILL.md",
            "skills/pipeline/flow-pr-review/references/x.md",
            "skills/universal/flow-refactoring/SKILL.md",
            "bin/flow-ci-wait.ts",
            "bin/flow-ci-wait.test.ts",
            "bin/lib/git.ts",
            "README.md",
            "package.json",
          ].join("\n"),
        ),
      },
    ]);
    expect(
      changedInstallPaths({
        canonicalRoot: "/repo",
        beforeSha: "a1b2c3d",
        afterSha: "e4f5g6h",
        spawn,
      }),
    ).toEqual(["flow-pr-review", "flow-refactoring", "flow-ci-wait"]);
  });

  it("returns [] without throwing when SHAs are missing", () => {
    let called = false;
    const spawn: Spawner = () => {
      called = true;
      throw new Error("should not spawn");
    };
    expect(changedInstallPaths({ canonicalRoot: "/repo", spawn })).toEqual([]);
    expect(called).toBe(false);
  });

  it("returns [] without throwing when the diff command fails", () => {
    const { spawn } = makeSpawn([
      {
        match: matchArgs("-C", "/repo", "diff", "--name-only"),
        result: fail("bad revision"),
      },
    ]);
    expect(
      changedInstallPaths({
        canonicalRoot: "/repo",
        beforeSha: "a1b2c3d",
        afterSha: "e4f5g6h",
        spawn,
      }),
    ).toEqual([]);
  });
});
