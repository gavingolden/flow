/**
 * Tests for flow-remove-worktree.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseWorktreeListOutput } from "./flow-remove-worktree";

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
    const raw = ["worktree /repo", "branch refs/heads/agent/improve-tooltips", ""].join("\n");

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

const FLOW_REMOVE_WORKTREE_BIN = path.resolve(__dirname, "flow-remove-worktree.ts");

type SpawnResult = { exitCode: number; stdout: string; stderr: string };

function runHelper(args: string[], cwd: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", FLOW_REMOVE_WORKTREE_BIN, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
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
    expect(dryRun.status, `expected git to refuse, got: ${dryRun.stderr}`).not.toBe(0);
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
});
