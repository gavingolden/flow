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
  fs.writeFileSync(path.join(repoDir, ".gitignore"), "package-lock.json\nnode_modules/\n");
  mustGit(["add", "."], repoDir);
  mustGit(["commit", "-m", "initial"], repoDir);

  mustGit(["clone", "--bare", repoDir, remoteDir], path.dirname(repoDir));
  mustGit(["remote", "add", "origin", remoteDir], repoDir);
  mustGit(["fetch", "origin"], repoDir);
  mustGit(["branch", "--set-upstream-to=origin/main", "main"], repoDir);
  mustGit(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], repoDir);

  return {
    repoDir,
    remoteDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function runNewWorktree(args: string[], cwd: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", FLOW_NEW_WORKTREE_BIN, ...args], {
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

describe("flow-remove-worktree (integration: .flow-branch cleanup)", () => {
  let fx: FreshRepoFixture;
  beforeEach(() => {
    fx = makeFreshRepoFixture();
  });
  afterEach(() => fx.cleanup());

  it("on a fresh repo, .flow-branch lands as ignored (not untracked) after flow-new-worktree", async () => {
    const create = await runNewWorktree(["feat"], fx.repoDir);
    expect(create.exitCode, `flow-new-worktree stderr: ${create.stderr}`).toBe(0);
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
    const lines = status.stdout.split("\n").filter((l) => l.includes(".flow-branch"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.startsWith("!! "), `expected '!! ' prefix, got: ${JSON.stringify(line)}`).toBe(
        true,
      );
    }

    // The user's tracked .gitignore was NOT touched — flow-runtime metadata
    // lives in .git/info/exclude only.
    const gitignore = fs.readFileSync(path.join(fx.repoDir, ".gitignore"), "utf8");
    expect(gitignore).not.toContain(".flow-branch");
  });

  it("on a fresh repo, flow-remove-worktree succeeds without --force", async () => {
    const create = await runNewWorktree(["feat"], fx.repoDir);
    expect(create.exitCode, `flow-new-worktree stderr: ${create.stderr}`).toBe(0);
    const wtDir = path.join(path.dirname(fx.repoDir), "repo-feat");
    expect(fs.existsSync(wtDir)).toBe(true);

    const remove = await runHelper(["feat"], fx.repoDir);
    expect(remove.exitCode, `stderr: ${remove.stderr}\nstdout: ${remove.stdout}`).toBe(0);
    expect(fs.existsSync(wtDir)).toBe(false);

    // The worktree is gone from `git worktree list`.
    const list = mustGit(["worktree", "list", "--porcelain"], fx.repoDir);
    expect(list).not.toContain(wtDir);
  });

  it("legacy path: succeeds even when .flow-branch is NOT registered in info/exclude (rm fallback)", async () => {
    const create = await runNewWorktree(["legacy-feat"], fx.repoDir);
    expect(create.exitCode, `flow-new-worktree stderr: ${create.stderr}`).toBe(0);
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
    expect(untracked.length, `expected .flow-branch as untracked, got status:\n${status.stdout}`)
      .toBeGreaterThan(0);

    // The rm fallback in flow-remove-worktree clears `.flow-branch` before
    // `git worktree remove`, so removal still succeeds.
    const remove = await runHelper(["legacy-feat"], fx.repoDir);
    expect(remove.exitCode, `stderr: ${remove.stderr}\nstdout: ${remove.stdout}`).toBe(0);
    expect(fs.existsSync(wtDir)).toBe(false);
  });
});
