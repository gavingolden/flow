/**
 * Tests for flow-remove-worktree.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteBranchWithForceFallback,
  isDeregisteredFailure,
  isNotFullyMergedFailure,
  isRemovalPhaseFailure,
  matchWorktree,
  parseWorktreeListOutput,
  removeWorktreeWithFallback,
  resolveInput,
  stateSlugForInput,
  type RemoveWorktreeDeps,
  type WorktreeListEntry,
} from "./flow-remove-worktree";

// --- parseWorktreeListOutput ---

describe(parseWorktreeListOutput, () => {
  it("should parse a single worktree entry", () => {
    const raw = [
      "worktree /Users/me/code/flow",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
    ].join("\n");

    const entries = parseWorktreeListOutput(raw);
    expect(entries).toEqual([{ path: "/Users/me/code/flow", branch: "main" }]);
  });

  it("should parse multiple worktree entries", () => {
    const raw = [
      "worktree /Users/me/code/flow",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /Users/me/code/flow-feature-foo",
      "HEAD def456",
      "branch refs/heads/feature/foo",
      "",
    ].join("\n");

    const entries = parseWorktreeListOutput(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      path: "/Users/me/code/flow",
      branch: "main",
    });
    expect(entries[1]).toEqual({
      path: "/Users/me/code/flow-feature-foo",
      branch: "feature/foo",
    });
  });

  it("should strip refs/heads/ prefix from branch names", () => {
    const raw = [
      "worktree /repo",
      "branch refs/heads/agent/improve-tooltips",
      "",
    ].join("\n");

    const entries = parseWorktreeListOutput(raw);
    expect(entries[0].branch).toBe("agent/improve-tooltips");
  });

  it("should handle bare worktree entries", () => {
    const raw = ["worktree /repo.git", "bare", ""].join("\n");

    const entries = parseWorktreeListOutput(raw);
    expect(entries).toEqual([{ path: "/repo.git", bare: true }]);
  });

  it("should handle entries without a trailing blank line", () => {
    const raw = ["worktree /repo", "branch refs/heads/main"].join("\n");

    const entries = parseWorktreeListOutput(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ path: "/repo", branch: "main" });
  });

  it("should return empty array for empty input", () => {
    expect(parseWorktreeListOutput("")).toEqual([]);
  });

  it("should handle detached HEAD entries (no branch line)", () => {
    const raw = ["worktree /repo", "HEAD abc123", "detached", ""].join("\n");

    const entries = parseWorktreeListOutput(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("/repo");
    expect(entries[0].branch).toBeUndefined();
  });
});

describe(resolveInput, () => {
  it("returns the explicit positional when given (back-compat)", () => {
    expect(resolveInput("agent/improve-tooltips", () => "auto-resolved")).toBe(
      "agent/improve-tooltips",
    );
  });

  it("falls back to the pane resolver when positional is undefined", () => {
    expect(resolveInput(undefined, () => "csv-export")).toBe("csv-export");
  });

  it("returns null when neither positional nor pane resolve", () => {
    expect(resolveInput(undefined, () => null)).toBeNull();
  });

  it("treats an explicit empty string as 'given' (does not auto-resolve)", () => {
    // The CLI argv layer strips flags but does not pre-validate non-emptiness.
    // resolveInput is intentionally narrow: positional ?? fallback. Empty
    // string passes through and downstream resolveWorktree() rejects it.
    expect(resolveInput("", () => "should-not-be-used")).toBe("");
  });
});

// --- stateSlugForInput ------------------------------------------------------

describe(stateSlugForInput, () => {
  it("returns a bare slug unchanged (a valid state-file key)", () => {
    expect(stateSlugForInput("re-skin-auth-surface-new")).toBe(
      "re-skin-auth-surface-new",
    );
  });

  it("returns undefined for a slash-bearing branch name (never a state key)", () => {
    // agent/foo would map statePath to ~/.flow/state/agent/foo.json — a nested
    // path, never a real state file; the guard skips the readState lookup.
    expect(stateSlugForInput("agent/foo")).toBeUndefined();
  });

  it("returns undefined for a traversing path (guards statePath from ../ escape)", () => {
    expect(stateSlugForInput("../../etc/passwd")).toBeUndefined();
  });

  it("returns undefined for an absolute worktree path", () => {
    expect(stateSlugForInput("/Users/me/code/repo-feat")).toBeUndefined();
  });
});

// --- matchWorktree ----------------------------------------------------------

describe(matchWorktree, () => {
  // The collision hazard in miniature: a sibling pipeline's worktree whose
  // branch name equals the un-suffixed slug, alongside this pipeline's own
  // auto-suffixed `-2` worktree recorded in state.json.
  const sibling: WorktreeListEntry = {
    path: "/Users/me/code/repo-reskin",
    branch: "reskin",
  };
  const own: WorktreeListEntry = {
    path: "/Users/me/code/repo-reskin-2",
    branch: "reskin-2",
  };
  const primary: WorktreeListEntry = {
    path: "/Users/me/code/repo",
    branch: "main",
  };

  it("prefers the recorded path over a colliding sibling branch match", () => {
    // Input is the un-suffixed slug 'reskin'; without the recorded-path
    // preference the exact-branch arm would match the SIBLING (branch 'reskin').
    const match = matchWorktree("reskin", [primary, sibling, own], own.path);
    expect(match).toBe(own);
  });

  it("uses exact absolute-path equality — never resolves a sibling by suffix/branch when the recorded path is present", () => {
    // A recorded path that matches `own` must never fall through to the branch
    // or directory-suffix arms that would pick `sibling`.
    const match = matchWorktree("reskin", [primary, sibling, own], own.path);
    expect(match?.path).toBe(own.path);
    expect(match?.branch).toBe("reskin-2");
  });

  it("falls back to the existing order when no recorded path is supplied", () => {
    // undefined recordedPath → historical behavior: exact-branch match wins.
    const match = matchWorktree("reskin", [primary, sibling, own], undefined);
    expect(match).toBe(sibling);
  });

  it("falls back cleanly when the recorded path is absent from the live list (stale recording)", () => {
    const stalePath = "/Users/me/code/repo-reskin-2-gone";
    const match = matchWorktree("reskin", [primary, sibling, own], stalePath);
    // Recorded path matches nothing live → historical exact-branch match.
    expect(match).toBe(sibling);
  });

  it("still matches by absolute-path and directory-suffix in the no-recorded-path path", () => {
    expect(matchWorktree(own.path, [primary, sibling, own])).toBe(own);
    // Directory-suffix arm: 'agent/foo' → '*-agent-foo'.
    const suffixed: WorktreeListEntry = {
      path: "/Users/me/code/repo-agent-foo",
      branch: "agent/foo",
    };
    expect(matchWorktree("agent/foo", [primary, suffixed])).toBe(suffixed);
  });

  it("returns undefined when nothing matches", () => {
    expect(matchWorktree("nonexistent", [primary, sibling])).toBeUndefined();
  });

  it("canonicalizes both sides so a symlinked/aliased recorded path still matches", () => {
    // Exercises the realpathSync canonicalization: state.json may record the
    // symlinked spelling (/var/...) while `git worktree list` reports the
    // canonical one (/private/var/...), or vice versa. Build a real symlink so
    // the two spellings genuinely differ on disk.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "match-canon-"));
    try {
      const realDir = path.join(root, "real-wt");
      fs.mkdirSync(realDir);
      const linkDir = path.join(root, "link-wt");
      fs.symlinkSync(realDir, linkDir);

      const canonicalReal = fs.realpathSync(realDir);
      const worktrees: WorktreeListEntry[] = [
        { path: "/primary", branch: "main" },
        { path: canonicalReal, branch: "other" },
      ];
      // Recorded path is the symlinked spelling; it must still resolve to the
      // canonical live entry.
      const match = matchWorktree("slug", worktrees, linkDir);
      expect(match?.path).toBe(canonicalReal);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- removeWorktreeWithFallback ---------------------------------------------

describe(isRemovalPhaseFailure, () => {
  it("matches git's ENOTEMPTY 'Directory not empty' deletion failure", () => {
    expect(
      isRemovalPhaseFailure(
        "error: failed to delete '/code/repo-feat': Directory not empty",
      ),
    ).toBe(true);
  });

  it("matches a raw node ENOTEMPTY error string", () => {
    expect(
      isRemovalPhaseFailure(
        "ENOTEMPTY: directory not empty, rmdir '/code/repo-feat/node_modules/.vite'",
      ),
    ).toBe(true);
  });

  it("matches lock-class deletion failures (Operation not permitted)", () => {
    // An esbuild service holding a handle can surface as a lock errno rather
    // than literally ENOTEMPTY — still a post-clean-check deletion-phase failure.
    expect(
      isRemovalPhaseFailure(
        "error: failed to delete '/code/repo-feat': Operation not permitted",
      ),
    ).toBe(true);
  });

  it("does NOT match the clean-check refusal (uncommitted tracked work)", () => {
    expect(
      isRemovalPhaseFailure(
        "'/code/repo-feat' contains modified or untracked files, use --force to delete it",
      ),
    ).toBe(false);
  });
});

describe(isDeregisteredFailure, () => {
  it("matches git's already-deregistered 'is not a working tree' error", () => {
    expect(
      isDeregisteredFailure("fatal: '/code/repo-feat' is not a working tree"),
    ).toBe(true);
  });

  it("does NOT match the clean-check refusal", () => {
    expect(
      isDeregisteredFailure(
        "'/code/repo-feat' contains modified or untracked files, use --force to delete it",
      ),
    ).toBe(false);
  });

  it("does NOT match a deletion-phase failure", () => {
    expect(
      isDeregisteredFailure(
        "error: failed to delete '/code/repo-feat': Directory not empty",
      ),
    ).toBe(false);
  });
});

describe(removeWorktreeWithFallback, () => {
  type Call = { args: string[]; cwd?: string };

  function makeDeps(gitImpl: (args: string[], cwd?: string) => string): {
    deps: RemoveWorktreeDeps;
    gitCalls: Call[];
    rmrfCalls: string[];
    warnCalls: string[];
  } {
    const gitCalls: Call[] = [];
    const rmrfCalls: string[] = [];
    const warnCalls: string[] = [];
    const deps: RemoveWorktreeDeps = {
      git: (args, cwd) => {
        gitCalls.push({ args, cwd });
        return gitImpl(args, cwd);
      },
      rmrf: (dir) => rmrfCalls.push(dir),
      warn: (msg) => warnCalls.push(msg),
    };
    return { deps, gitCalls, rmrfCalls, warnCalls };
  }

  const removes = (calls: Call[]) =>
    calls.filter((c) => c.args[0] === "worktree" && c.args[1] === "remove");
  const prunes = (calls: Call[]) =>
    calls.filter((c) => c.args[0] === "worktree" && c.args[1] === "prune");

  it("happy path: a single git worktree remove, no retry, no rm-rf, no prune", () => {
    const { deps, gitCalls, rmrfCalls, warnCalls } = makeDeps(() => "");
    removeWorktreeWithFallback("/wt", "/primary", deps);

    expect(gitCalls).toEqual([
      { args: ["worktree", "remove", "/wt"], cwd: "/primary" },
    ]);
    expect(rmrfCalls).toEqual([]);
    expect(prunes(gitCalls)).toHaveLength(0);
    expect(warnCalls).toEqual([]);
  });

  it("ENOTEMPTY then the retry succeeds: no rm-rf, no prune", () => {
    let removeAttempts = 0;
    const { deps, gitCalls, rmrfCalls } = makeDeps((args) => {
      if (args[1] === "remove") {
        removeAttempts += 1;
        if (removeAttempts === 1) {
          throw new Error("failed to delete '/wt': Directory not empty");
        }
        return "";
      }
      return "";
    });

    removeWorktreeWithFallback("/wt", "/primary", deps);

    expect(removes(gitCalls)).toHaveLength(2);
    expect(rmrfCalls).toEqual([]);
    expect(prunes(gitCalls)).toHaveLength(0);
  });

  it("ENOTEMPTY on both attempts: falls back to rm -rf + git worktree prune, then returns so branch deletion proceeds", () => {
    const { deps, gitCalls, rmrfCalls, warnCalls } = makeDeps((args) => {
      if (args[1] === "remove") {
        throw new Error(
          "ENOTEMPTY: directory not empty, rmdir '/wt/node_modules/.vite'",
        );
      }
      return ""; // prune succeeds
    });

    // Returns normally (does NOT throw) — main() then proceeds to delete the branch.
    expect(() =>
      removeWorktreeWithFallback("/wt", "/primary", deps),
    ).not.toThrow();

    expect(removes(gitCalls)).toHaveLength(2); // initial + one retry
    expect(rmrfCalls).toEqual(["/wt"]);
    expect(prunes(gitCalls)).toEqual([
      { args: ["worktree", "prune"], cwd: "/primary" },
    ]);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toMatch(/rm -rf/);
  });

  it("prune failure after rm -rf does not abort — branch deletion still proceeds", () => {
    const { deps, gitCalls, rmrfCalls, warnCalls } = makeDeps((args) => {
      if (args[1] === "remove") {
        throw new Error("failed to delete '/wt': Directory not empty");
      }
      if (args[1] === "prune") {
        throw new Error("fatal: could not lock .git/worktrees: File exists");
      }
      return "";
    });

    // The prune failure must NOT propagate: main()'s branch-deletion arm runs
    // only when this returns normally. rm -rf already removed the directory, so
    // a stranded prune is advisory — swallowing it preserves the "branch
    // deletion proceeds" contract this fallback exists to guarantee.
    expect(() =>
      removeWorktreeWithFallback("/wt", "/primary", deps),
    ).not.toThrow();

    expect(rmrfCalls).toEqual(["/wt"]); // rm -rf still fired
    expect(prunes(gitCalls)).toHaveLength(1); // prune was attempted once
    // Two warns: the fallback note, then the swallowed-prune-failure note.
    expect(warnCalls).toHaveLength(2);
    expect(warnCalls[1]).toMatch(/prune failed/);
  });

  it("non-deletion failure (uncommitted tracked work) re-throws without retry, rm-rf, or prune — no auto-force", () => {
    const { deps, gitCalls, rmrfCalls, warnCalls } = makeDeps((args) => {
      if (args[1] === "remove") {
        throw new Error(
          "'/wt' contains modified or untracked files, use --force to delete it",
        );
      }
      return "";
    });

    expect(() => removeWorktreeWithFallback("/wt", "/primary", deps)).toThrow(
      /modified or untracked/,
    );

    expect(removes(gitCalls)).toHaveLength(1); // no retry on a genuine refusal
    expect(rmrfCalls).toEqual([]);
    expect(prunes(gitCalls)).toHaveLength(0);
    expect(warnCalls).toEqual([]);
  });

  it("already-deregistered (not a working tree): rm -rf + prune, NO retry, returns so branch deletion proceeds", () => {
    const { deps, gitCalls, rmrfCalls, warnCalls } = makeDeps((args) => {
      if (args[1] === "remove") {
        throw new Error("fatal: '/wt' is not a working tree");
      }
      return ""; // prune succeeds
    });

    expect(() =>
      removeWorktreeWithFallback("/wt", "/primary", deps),
    ).not.toThrow();

    // The key difference from the deletion-phase class: this error fires
    // before git's clean-check, so there is nothing to retry.
    expect(removes(gitCalls)).toHaveLength(1);
    expect(rmrfCalls).toEqual(["/wt"]);
    expect(prunes(gitCalls)).toEqual([
      { args: ["worktree", "prune"], cwd: "/primary" },
    ]);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toMatch(/not a working tree|already deregistered/);
  });

  it("already-deregistered with a prune failure: swallowed, still returns", () => {
    const { deps, rmrfCalls, gitCalls, warnCalls } = makeDeps((args) => {
      if (args[1] === "remove") {
        throw new Error("fatal: '/wt' is not a working tree");
      }
      if (args[1] === "prune") {
        throw new Error("fatal: could not lock .git/worktrees: File exists");
      }
      return "";
    });

    expect(() =>
      removeWorktreeWithFallback("/wt", "/primary", deps),
    ).not.toThrow();

    expect(rmrfCalls).toEqual(["/wt"]);
    expect(prunes(gitCalls)).toHaveLength(1);
    expect(warnCalls).toHaveLength(2);
    expect(warnCalls[1]).toMatch(/prune failed/);
  });
});

// --- isNotFullyMergedFailure ------------------------------------------------

describe(isNotFullyMergedFailure, () => {
  it("matches git's squash-merge refusal", () => {
    expect(
      isNotFullyMergedFailure("error: the branch 'feat' is not fully merged."),
    ).toBe(true);
  });

  it("does NOT match an unrelated branch -d failure", () => {
    expect(isNotFullyMergedFailure("error: branch 'feat' not found.")).toBe(
      false,
    );
  });
});

// --- deleteBranchWithForceFallback ------------------------------------------

describe(deleteBranchWithForceFallback, () => {
  type Call = { args: string[]; cwd?: string };

  function makeGit(impl: (args: string[], cwd?: string) => string): {
    git: (args: string[], cwd?: string) => string;
    calls: Call[];
  } {
    const calls: Call[] = [];
    const git = (args: string[], cwd?: string) => {
      calls.push({ args, cwd });
      return impl(args, cwd);
    };
    return { git, calls };
  }

  const dCalls = (calls: Call[]) =>
    calls.filter((c) => c.args[0] === "branch" && c.args[1] === "-d");
  const forceCalls = (calls: Call[]) =>
    calls.filter((c) => c.args[0] === "branch" && c.args[1] === "-D");

  it("git branch -d succeeds: status deleted, no -D", () => {
    const { git, calls } = makeGit(() => "");
    const result = deleteBranchWithForceFallback("feat", "/primary", true, git);

    expect(result.status).toBe("deleted");
    expect(dCalls(calls)).toHaveLength(1);
    expect(forceCalls(calls)).toHaveLength(0);
  });

  it("not fully merged + allowForceFallback: retries with git branch -D, status force-deleted", () => {
    const { git, calls } = makeGit((args) => {
      if (args[1] === "-d") {
        throw new Error("error: the branch 'feat' is not fully merged.");
      }
      return "";
    });
    const result = deleteBranchWithForceFallback("feat", "/primary", true, git);

    expect(result.status).toBe("force-deleted");
    expect(dCalls(calls)).toHaveLength(1);
    expect(forceCalls(calls)).toHaveLength(1);
    expect(forceCalls(calls)[0]).toEqual({
      args: ["branch", "-D", "feat"],
      cwd: "/primary",
    });
  });

  it("not fully merged but allowForceFallback=false: no -D, status failed", () => {
    const { git, calls } = makeGit((args) => {
      if (args[1] === "-d") {
        throw new Error("error: the branch 'feat' is not fully merged.");
      }
      return "";
    });
    const result = deleteBranchWithForceFallback(
      "feat",
      "/primary",
      false,
      git,
    );

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      message: expect.stringMatching(/not fully merged/),
    });
    expect(forceCalls(calls)).toHaveLength(0);
  });

  it("a different -d failure does NOT escalate to -D even with allowForceFallback (warn-only preserved)", () => {
    const { git, calls } = makeGit((args) => {
      if (args[1] === "-d") {
        throw new Error("error: branch 'feat' not found.");
      }
      return "";
    });
    const result = deleteBranchWithForceFallback("feat", "/primary", true, git);

    expect(result.status).toBe("failed");
    expect(forceCalls(calls)).toHaveLength(0);
  });

  it("not fully merged + force, but -D also fails: status failed", () => {
    const { git, calls } = makeGit((args) => {
      if (args[1] === "-d") {
        throw new Error("error: the branch 'feat' is not fully merged.");
      }
      if (args[1] === "-D") {
        throw new Error("error: Cannot delete branch");
      }
      return "";
    });
    const result = deleteBranchWithForceFallback("feat", "/primary", true, git);

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      message: expect.stringMatching(/Cannot delete branch/),
    });
    expect(forceCalls(calls)).toHaveLength(1);
  });
});

// --- Integration: scratch-dir cleanup ---------------------------------------

type Fixture = {
  repoDir: string;
  cleanup: () => void;
};

function mustGit(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return r.stdout.trim();
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-remove-worktree-"));
  const repoDir = path.join(root, "repo");

  fs.mkdirSync(repoDir);
  mustGit(["init", "-b", "main"], repoDir);
  mustGit(["config", "user.email", "test@example.com"], repoDir);
  mustGit(["config", "user.name", "Test"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "fixture\n");
  mustGit(["add", "."], repoDir);
  mustGit(["commit", "-m", "initial"], repoDir);

  return {
    repoDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const FLOW_REMOVE_WORKTREE_BIN = path.resolve(
  __dirname,
  "flow-remove-worktree.ts",
);

type SpawnResult = { exitCode: number; stdout: string; stderr: string };

function runHelper(
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", FLOW_REMOVE_WORKTREE_BIN, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (exitCode) =>
      resolve({ exitCode: exitCode ?? -1, stdout, stderr }),
    );
  });
}

describe("flow-remove-worktree (integration: scratch cleanup)", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  it("removes a worktree whose only untracked content is .flow-tmp/, no --force needed", async () => {
    const wtDir = path.join(path.dirname(fx.repoDir), "repo-feature-foo");
    mustGit(["worktree", "add", "-b", "feature-foo", wtDir], fx.repoDir);

    // Drop pipeline scratch: plan.md and pr-description-draft.md inside .flow-tmp/.
    const flowTmp = path.join(wtDir, ".flow-tmp");
    fs.mkdirSync(flowTmp, { recursive: true });
    fs.writeFileSync(path.join(flowTmp, "plan.md"), "# PRD\n");
    fs.writeFileSync(path.join(flowTmp, "pr-description-draft.md"), "## Why\n");
    fs.writeFileSync(path.join(flowTmp, "pr-body.md"), "rendered\n");

    // Sanity check: git would refuse to remove this worktree without --force today.
    const dryRun = spawnSync("git", ["worktree", "remove", wtDir], {
      cwd: fx.repoDir,
      encoding: "utf8",
    });
    expect(
      dryRun.status,
      `expected git to refuse, got: ${dryRun.stderr}`,
    ).not.toBe(0);
    expect(dryRun.stderr).toMatch(/untracked|modified/i);

    // Invoke by branch name so the test is robust to macOS's
    // /var → /private/var canonicalisation (path-equality is brittle there;
    // the supervisor invokes by slug anyway via `flow-remove-worktree <slug>`).
    const r = await runHelper(["feature-foo"], fx.repoDir);
    expect(r.exitCode, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).toBe(0);
    expect(fs.existsSync(wtDir)).toBe(false);

    // Branch survives (no --delete-branch flag).
    const branches = mustGit(["branch", "--list"], fx.repoDir);
    expect(branches).toContain("feature-foo");
  });

  it("still refuses when the worktree has other untracked files outside .flow-tmp/", async () => {
    const wtDir = path.join(path.dirname(fx.repoDir), "repo-feature-bar");
    mustGit(["worktree", "add", "-b", "feature-bar", wtDir], fx.repoDir);

    // Untracked file the user dropped at the worktree root — NOT under .flow-tmp/.
    fs.writeFileSync(path.join(wtDir, "user-scratch.txt"), "oops\n");

    const r = await runHelper(["feature-bar"], fx.repoDir);
    expect(r.exitCode, `expected non-zero, stdout: ${r.stdout}`).not.toBe(0);
    // Worktree must still exist — the helper must not auto-force.
    expect(fs.existsSync(wtDir)).toBe(true);
    expect(fs.existsSync(path.join(wtDir, "user-scratch.txt"))).toBe(true);
  });

  it("hybrid: cleans .flow-tmp/ but still refuses when other untracked files coexist", async () => {
    // Pins the documented order of operations: scratch is cleaned unconditionally
    // before `git worktree remove` runs, so a failed removal leaves the worktree
    // partially cleaned (scratch gone, user-dropped files preserved). The contract
    // is acceptable — scratch is transient by design — but the test exists to make
    // the behaviour explicit so a future refactor doesn't silently invert it.
    const wtDir = path.join(path.dirname(fx.repoDir), "repo-feature-baz");
    mustGit(["worktree", "add", "-b", "feature-baz", wtDir], fx.repoDir);

    const flowTmp = path.join(wtDir, ".flow-tmp");
    fs.mkdirSync(flowTmp, { recursive: true });
    fs.writeFileSync(path.join(flowTmp, "plan.md"), "# PRD\n");
    fs.writeFileSync(path.join(wtDir, "user-scratch.txt"), "oops\n");

    const r = await runHelper(["feature-baz"], fx.repoDir);
    expect(r.exitCode, `expected non-zero, stdout: ${r.stdout}`).not.toBe(0);

    // Worktree and the user's untracked file both survive — no auto-force.
    expect(fs.existsSync(wtDir)).toBe(true);
    expect(fs.existsSync(path.join(wtDir, "user-scratch.txt"))).toBe(true);

    // .flow-tmp/ was already cleaned before git refused — documented contract.
    expect(fs.existsSync(flowTmp)).toBe(false);
  });
});

// --- Integration: .flow-branch sentinel cleanup -----------------------------

const FLOW_NEW_WORKTREE_BIN = path.resolve(__dirname, "flow-new-worktree.ts");

type FreshRepoFixture = {
  /** Primary worktree of the repo. */
  repoDir: string;
  /** Path to the bare remote acting as `origin`. */
  remoteDir: string;
  cleanup: () => void;
};

/**
 * Builds a fresh repo whose tracked `.gitignore` does NOT contain
 * `.flow-branch`. This is the consumer-repo state that triggered the original
 * bug: `flow-new-worktree` used to write `.flow-branch` into the primary's
 * working `.gitignore`, but the secondary worktree was checked out from
 * origin/main *before* that edit, so the sentinel showed up as `??` (untracked)
 * — not `!!` (ignored) — and `git worktree remove` refused.
 */
function makeFreshRepoFixture(): FreshRepoFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-branch-cleanup-"));
  const repoDir = path.join(root, "repo");
  const remoteDir = path.join(root, "origin.git");

  fs.mkdirSync(repoDir);
  mustGit(["init", "-b", "main"], repoDir);
  mustGit(["config", "user.email", "test@example.com"], repoDir);
  mustGit(["config", "user.name", "Test"], repoDir);
  // Empty package.json so `npm install --silent` is a near no-op.
  fs.writeFileSync(path.join(repoDir, "package.json"), "{}\n");
  // Tracked .gitignore covers the npm-install side-effects (`package-lock.json`
  // and `node_modules/`) so the only flow-owned untracked-or-ignored file the
  // test exercises is `.flow-branch`. Crucially, this .gitignore does NOT list
  // `.flow-branch` — that absence is the consumer-repo state we're testing.
  fs.writeFileSync(
    path.join(repoDir, ".gitignore"),
    "package-lock.json\nnode_modules/\n",
  );
  mustGit(["add", "."], repoDir);
  mustGit(["commit", "-m", "initial"], repoDir);

  mustGit(["clone", "--bare", repoDir, remoteDir], path.dirname(repoDir));
  mustGit(["remote", "add", "origin", remoteDir], repoDir);
  mustGit(["fetch", "origin"], repoDir);
  mustGit(["branch", "--set-upstream-to=origin/main", "main"], repoDir);
  mustGit(
    ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
    repoDir,
  );

  return {
    repoDir,
    remoteDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function runNewWorktree(args: string[], cwd: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    // Strip TMUX_PANE so flow-new-worktree's resolveSlugFromPane() returns
    // null — these integration tests pass literal positional slugs and
    // would otherwise hit the slug-mismatch guard when the runner itself
    // lives inside a flow pipeline window.
    const env = { ...process.env };
    delete env.TMUX_PANE;
    const child = spawn("bun", ["run", FLOW_NEW_WORKTREE_BIN, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (exitCode) =>
      resolve({ exitCode: exitCode ?? -1, stdout, stderr }),
    );
  });
}

describe("flow-remove-worktree (integration: .flow-branch cleanup)", () => {
  let fx: FreshRepoFixture;
  beforeEach(() => {
    fx = makeFreshRepoFixture();
  });
  afterEach(() => fx.cleanup());

  it("on a fresh repo, .flow-branch lands as ignored (not untracked) after flow-new-worktree", async () => {
    const create = await runNewWorktree(["feat"], fx.repoDir);
    expect(create.exitCode, `flow-new-worktree stderr: ${create.stderr}`).toBe(
      0,
    );
    const wtDir = path.join(path.dirname(fx.repoDir), "repo-feat");

    // The marker file exists (flow-state-update's branch-mismatch guard reads it).
    expect(fs.existsSync(path.join(wtDir, ".flow-branch"))).toBe(true);

    // Git classifies it as ignored (!!), not untracked (??). This is the
    // root-cause fix: registering `.flow-branch` in the common-dir
    // `.git/info/exclude` rather than the consumer's tracked `.gitignore`.
    const status = spawnSync("git", ["status", "--porcelain", "--ignored"], {
      cwd: wtDir,
      encoding: "utf8",
    });
    expect(status.status, `git status stderr: ${status.stderr}`).toBe(0);
    const lines = status.stdout
      .split("\n")
      .filter((l) => l.includes(".flow-branch"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(
        line.startsWith("!! "),
        `expected '!! ' prefix, got: ${JSON.stringify(line)}`,
      ).toBe(true);
    }

    // The user's tracked .gitignore was NOT touched — flow-runtime metadata
    // lives in .git/info/exclude only.
    const gitignore = fs.readFileSync(
      path.join(fx.repoDir, ".gitignore"),
      "utf8",
    );
    expect(gitignore).not.toContain(".flow-branch");
  });

  it("on a fresh repo, flow-remove-worktree succeeds without --force", async () => {
    const create = await runNewWorktree(["feat"], fx.repoDir);
    expect(create.exitCode, `flow-new-worktree stderr: ${create.stderr}`).toBe(
      0,
    );
    const wtDir = path.join(path.dirname(fx.repoDir), "repo-feat");
    expect(fs.existsSync(wtDir)).toBe(true);

    const remove = await runHelper(["feat"], fx.repoDir);
    expect(
      remove.exitCode,
      `stderr: ${remove.stderr}\nstdout: ${remove.stdout}`,
    ).toBe(0);
    expect(fs.existsSync(wtDir)).toBe(false);

    // The worktree is gone from `git worktree list`.
    const list = mustGit(["worktree", "list", "--porcelain"], fx.repoDir);
    expect(list).not.toContain(wtDir);
  });

  it("zero-arg invocation outside a flow pane fails with the @flow-slug error (not the help banner)", async () => {
    // Regression: the supervisor calls `flow-remove-worktree` with zero
    // args and expects the slug to resolve from $TMUX_PANE. The previous
    // `args.length === 0 → printHelp + exit 0` short-circuit silently
    // succeeded without removing the worktree. Now zero-args must fall
    // through to resolveSlugFromPane(); when that returns null (TMUX_PANE
    // unset), the helper exits non-zero with a slug-related error rather
    // than printing the help banner and exiting 0.
    const child = spawn("bun", ["run", FLOW_REMOVE_WORKTREE_BIN], {
      cwd: fx.repoDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TMUX_PANE: "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    const exitCode: number = await new Promise((resolve) =>
      child.on("close", (code) => resolve(code ?? -1)),
    );
    expect(exitCode, `stdout: ${stdout}\nstderr: ${stderr}`).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain("@flow-slug");
  });

  it("legacy path: succeeds even when .flow-branch is NOT registered in info/exclude (rm fallback)", async () => {
    const create = await runNewWorktree(["legacy-feat"], fx.repoDir);
    expect(create.exitCode, `flow-new-worktree stderr: ${create.stderr}`).toBe(
      0,
    );
    const wtDir = path.join(path.dirname(fx.repoDir), "repo-legacy-feat");

    // Simulate an older worktree whose common dir's exclude file does NOT yet
    // list `.flow-branch`. Strip every `.flow-branch` line from
    // .git/info/exclude — git will now classify the sentinel as ?? (untracked)
    // and `git worktree remove` would refuse without the rm fallback.
    const excludePath = path.join(fx.repoDir, ".git", "info", "exclude");
    if (fs.existsSync(excludePath)) {
      const stripped = fs
        .readFileSync(excludePath, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== ".flow-branch")
        .join("\n");
      fs.writeFileSync(excludePath, stripped, "utf8");
    }

    // Sanity: the sentinel is now untracked, not ignored.
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: wtDir,
      encoding: "utf8",
    });
    const untracked = status.stdout
      .split("\n")
      .filter((l) => l.startsWith("?? ") && l.includes(".flow-branch"));
    expect(
      untracked.length,
      `expected .flow-branch as untracked, got status:\n${status.stdout}`,
    ).toBeGreaterThan(0);

    // The rm fallback in flow-remove-worktree clears `.flow-branch` before
    // `git worktree remove`, so removal still succeeds.
    const remove = await runHelper(["legacy-feat"], fx.repoDir);
    expect(
      remove.exitCode,
      `stderr: ${remove.stderr}\nstdout: ${remove.stdout}`,
    ).toBe(0);
    expect(fs.existsSync(wtDir)).toBe(false);
  });
});

// --- Integration: auto-delete merged branches -------------------------------

describe("flow-remove-worktree (integration: auto-delete merged branches)", () => {
  let fx: FreshRepoFixture;
  beforeEach(() => {
    fx = makeFreshRepoFixture();
  });
  afterEach(() => fx.cleanup());

  it("auto-deletes the local branch when its tip is reachable from origin/<base>", async () => {
    const create = await runNewWorktree(["merged-feat"], fx.repoDir);
    expect(create.exitCode, `flow-new-worktree stderr: ${create.stderr}`).toBe(
      0,
    );
    const wtDir = path.join(path.dirname(fx.repoDir), "repo-merged-feat");

    // Commit on the per-task branch from inside the worktree.
    fs.writeFileSync(path.join(wtDir, "feature.txt"), "shipped\n");
    mustGit(["add", "."], wtDir);
    mustGit(["commit", "-m", "feat"], wtDir);

    // Fast-forward origin/main to the per-task branch tip so the branch is
    // provably reachable from origin/main, then refresh the primary's
    // remote-tracking ref so detectDefaultBranch + the merge probe both see it.
    mustGit(["push", "origin", "merged-feat:main"], wtDir);
    mustGit(["fetch", "origin"], fx.repoDir);

    const r = await runHelper(["merged-feat"], fx.repoDir);
    expect(r.exitCode, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).toBe(0);
    expect(fs.existsSync(wtDir)).toBe(false);

    const branches = mustGit(["branch", "--list"], fx.repoDir);
    expect(branches).not.toContain("merged-feat");
    expect(r.stdout, `stdout: ${r.stdout}`).toMatch(
      /fully merged into origin\/main/,
    );
  });

  it("preserves the local branch when it has commits not in origin/<base>", async () => {
    const create = await runNewWorktree(["unmerged-feat"], fx.repoDir);
    expect(create.exitCode, `flow-new-worktree stderr: ${create.stderr}`).toBe(
      0,
    );
    const wtDir = path.join(path.dirname(fx.repoDir), "repo-unmerged-feat");

    // Commit on the per-task branch but DO NOT push — origin/main stays at the
    // initial commit, so the branch tip is unreachable from origin/main.
    fs.writeFileSync(path.join(wtDir, "wip.txt"), "in progress\n");
    mustGit(["add", "."], wtDir);
    mustGit(["commit", "-m", "wip"], wtDir);

    const r = await runHelper(["unmerged-feat"], fx.repoDir);
    expect(r.exitCode, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).toBe(0);
    expect(fs.existsSync(wtDir)).toBe(false);

    const branches = mustGit(["branch", "--list"], fx.repoDir);
    expect(branches).toContain("unmerged-feat");
    expect(r.stdout, `stdout: ${r.stdout}`).toMatch(/was kept/);
  });

  it("--delete-branch flag still force-attempts deletion regardless of merge state", async () => {
    const create = await runNewWorktree(["flag-feat"], fx.repoDir);
    expect(create.exitCode, `flow-new-worktree stderr: ${create.stderr}`).toBe(
      0,
    );
    const wtDir = path.join(path.dirname(fx.repoDir), "repo-flag-feat");

    // No new commits — branch tip equals origin/main, so `git branch -d`
    // would succeed anyway. The point of this spec is that the legacy
    // success line ("Branch 'flag-feat' deleted.") fires WITHOUT the
    // "fully merged into" suffix, proving the auto-detection arm did NOT
    // run when --delete-branch was set.
    const r = await runHelper(["flag-feat", "--delete-branch"], fx.repoDir);
    expect(r.exitCode, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).toBe(0);
    expect(fs.existsSync(wtDir)).toBe(false);

    const branches = mustGit(["branch", "--list"], fx.repoDir);
    expect(branches).not.toContain("flag-feat");
    expect(r.stdout, `stdout: ${r.stdout}`).toContain(
      "Branch 'flag-feat' deleted.",
    );
    expect(r.stdout, `stdout: ${r.stdout}`).not.toMatch(/fully merged into/);
  });

  it("--delete-branch force-deletes a not-fully-merged (squash-merge-like) branch", async () => {
    const create = await runNewWorktree(["squash-feat"], fx.repoDir);
    expect(create.exitCode, `flow-new-worktree stderr: ${create.stderr}`).toBe(
      0,
    );
    const wtDir = path.join(path.dirname(fx.repoDir), "repo-squash-feat");

    // Commit on the per-task branch but DO NOT push/merge into origin/main, so
    // its tip is unreachable from origin/main and `git branch -d` would refuse
    // with 'not fully merged' — the squash-merge case the force-fallback handles.
    fs.writeFileSync(path.join(wtDir, "squash.txt"), "squashed work\n");
    mustGit(["add", "."], wtDir);
    mustGit(["commit", "-m", "feat: squashed"], wtDir);

    const r = await runHelper(["squash-feat", "--delete-branch"], fx.repoDir);
    expect(r.exitCode, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).toBe(0);
    expect(fs.existsSync(wtDir)).toBe(false);

    const branches = mustGit(["branch", "--list"], fx.repoDir);
    expect(branches).not.toContain("squash-feat");
    expect(r.stdout, `stdout: ${r.stdout}`).toMatch(/force-deleted/);
  });
});

// --- Integration: collision auto-suffix cross-pipeline safety ----------------

// Reproduces the reported hazard end-to-end: when flow-new-worktree auto-suffixes
// on a collision (<slug>-2), the pipeline slug / @flow-slug / state.json filename
// stay the un-suffixed <slug>. A bare `flow-remove-worktree --delete-branch`
// resolving from the un-suffixed slug must remove THIS pipeline's own -2 worktree
// (recorded in state.json) and delete branch <slug>-2 — never the sibling whose
// branch name equals <slug>. Reverting the matchWorktree recorded-path preference
// makes this spec fail: the exact-branch arm resolves the sibling instead.
describe("flow-remove-worktree (integration: collision auto-suffix safety)", () => {
  let fx: FreshRepoFixture;
  let home: string;
  let stateDir: string;

  beforeEach(() => {
    fx = makeFreshRepoFixture();
    // A throwaway HOME so the spawned helper's FLOW_STATE_DIR (derived from
    // $HOME) points at a temp state dir we control — same seam as
    // flow-state-update.test.ts's --answer-stdin spawn suite.
    home = fs.mkdtempSync(path.join(os.tmpdir(), "flow-collision-home-"));
    stateDir = path.join(home, ".flow", "state");
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => {
    fx.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("removes the recorded -2 worktree + branch and leaves the colliding sibling intact", async () => {
    const slug = "reskin";

    // Sibling pipeline: bare slot, branch `reskin`, dir `repo-reskin`.
    const sibling = await runNewWorktree([slug], fx.repoDir);
    expect(sibling.exitCode, `sibling stderr: ${sibling.stderr}`).toBe(0);
    const siblingDir = path.join(path.dirname(fx.repoDir), `repo-${slug}`);
    expect(fs.existsSync(siblingDir)).toBe(true);

    // This pipeline: same slug collides → auto-suffixed to `reskin-2` /
    // `repo-reskin-2`. The warning fires on stderr (Task 3).
    const own = await runNewWorktree([slug], fx.repoDir);
    expect(own.exitCode, `own stderr: ${own.stderr}`).toBe(0);
    const ownDir = path.join(path.dirname(fx.repoDir), `repo-${slug}-2`);
    expect(fs.existsSync(ownDir), `expected -2 worktree at ${ownDir}`).toBe(
      true,
    );
    expect(
      own.stderr,
      `expected collision warning, got: ${own.stderr}`,
    ).toMatch(/collided/);

    // state.json (keyed by the UN-suffixed slug) records the true -2 path,
    // exactly as /flow-pipeline step 2 writes it from flow-new-worktree output.
    fs.writeFileSync(
      path.join(stateDir, `${slug}.json`),
      JSON.stringify({
        slug,
        phase: "merging",
        repo: fx.repoDir,
        worktree: ownDir,
        updatedAt: "2026-07-02T00:00:00Z",
      }),
    );

    // Bare-slug cleanup, exactly as step 11 runs it.
    const remove = await runHelper([slug, "--delete-branch"], fx.repoDir, {
      ...process.env,
      HOME: home,
      TMUX_PANE: "",
    });
    expect(
      remove.exitCode,
      `stderr: ${remove.stderr}\nstdout: ${remove.stdout}`,
    ).toBe(0);

    // The pipeline's OWN -2 worktree is gone; its branch `reskin-2` is deleted.
    expect(fs.existsSync(ownDir), `-2 worktree should be removed`).toBe(false);
    // The SIBLING worktree + branch `reskin` survive untouched.
    expect(
      fs.existsSync(siblingDir),
      `sibling worktree must NOT be removed`,
    ).toBe(true);

    const branches = mustGit(["branch", "--list"], fx.repoDir);
    expect(branches, `branches: ${branches}`).not.toContain(`${slug}-2`);
    expect(branches, `branches: ${branches}`).toContain(slug);

    // The sibling is still a registered worktree; the -2 one is not.
    const list = mustGit(["worktree", "list", "--porcelain"], fx.repoDir);
    expect(list).toContain(siblingDir);
    expect(list).not.toContain(ownDir);
  });
});
