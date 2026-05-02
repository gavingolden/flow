/**
 * Tests for flow-new-worktree.ts.
 *
 * Mix of pure-unit tests for the suffix and marker helpers, plus an
 * integration test that spawns two flow-new-worktree processes in parallel
 * against a real git fixture and asserts cross-pipeline isolation. The
 * integration test is the contract artifact for PR 12.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktreeWithRetry } from "./flow-new-worktree";
import {
  MAX_SUFFIX_ATTEMPTS,
  findAvailableSlot,
  toDirSuffix,
} from "./lib/worktree-slot";
import {
  BRANCH_MARKER_FILENAME,
  FLOW_TMP_DIRNAME,
  ensureFlowTmpExclude,
  ensureGitignoreMarkerEntry,
  writeBranchMarker,
} from "./lib/worktree-marker";
import { SYMLINK_FILES } from "./lib/worktree-fs";

describe(toDirSuffix, () => {
  it("should replace slashes with hyphens", () => {
    expect(toDirSuffix("feature/new-chart")).toBe("feature-new-chart");
  });

  it("should handle multiple slashes", () => {
    expect(toDirSuffix("scope/area/task")).toBe("scope-area-task");
  });

  it("should return unchanged string when no slashes", () => {
    expect(toDirSuffix("simple-branch")).toBe("simple-branch");
  });

  it("should handle trailing slash", () => {
    expect(toDirSuffix("feature/")).toBe("feature-");
  });

  it("should handle leading slash", () => {
    expect(toDirSuffix("/feature")).toBe("-feature");
  });
});

describe("SYMLINK_FILES", () => {
  it("should include .env", () => {
    expect(SYMLINK_FILES).toContain(".env");
  });

  it("should include .claude/settings.local.json", () => {
    expect(SYMLINK_FILES).toContain(".claude/settings.local.json");
  });
});

// --- Test fixture: a self-contained git repo with origin/main ----------------

type Fixture = {
  /** Primary worktree of the repo. */
  repoDir: string;
  /** Path to the bare remote acting as `origin`. */
  remoteDir: string;
  /** Cleanup callback. */
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-new-worktree-"));
  const repoDir = path.join(root, "repo");
  const remoteDir = path.join(root, "origin.git");

  fs.mkdirSync(repoDir);
  mustGit(["init", "-b", "main"], repoDir);
  mustGit(["config", "user.email", "test@example.com"], repoDir);
  mustGit(["config", "user.name", "Test"], repoDir);
  // Empty package.json so the helper's `npm install --silent` is a near no-op.
  fs.writeFileSync(path.join(repoDir, "package.json"), "{}\n");
  // Empty .gitignore so the managed-block writer has a real file to update.
  fs.writeFileSync(path.join(repoDir, ".gitignore"), "");
  mustGit(["add", "."], repoDir);
  mustGit(["commit", "-m", "initial"], repoDir);

  // Create a bare clone to act as `origin` so origin/main exists.
  mustGit(["clone", "--bare", repoDir, remoteDir], path.dirname(repoDir));
  mustGit(["remote", "add", "origin", remoteDir], repoDir);
  mustGit(["fetch", "origin"], repoDir);
  mustGit(["branch", "--set-upstream-to=origin/main", "main"], repoDir);
  // origin/HEAD makes detectDefaultBranch's first attempt succeed.
  mustGit(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], repoDir);

  return {
    repoDir,
    remoteDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const FLOW_NEW_WORKTREE_BIN = path.resolve(__dirname, "flow-new-worktree.ts");

type SpawnResult = { exitCode: number; stdout: string; stderr: string };

function spawnHelper(args: string[], cwd: string): Promise<SpawnResult> {
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

// --- Unit tests on the new helpers ------------------------------------------

describe(findAvailableSlot, () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  it("returns the literal slug when nothing collides", () => {
    const slot = findAvailableSlot(
      "foo",
      path.join(path.dirname(fx.repoDir), "repo-foo"),
      fx.repoDir,
    );
    expect(slot.branchName).toBe("foo");
    expect(slot.worktreeDir).toBe(path.join(path.dirname(fx.repoDir), "repo-foo"));
  });

  it("auto-suffixes to -2 when the directory already exists", () => {
    const initialDir = path.join(path.dirname(fx.repoDir), "repo-foo");
    fs.mkdirSync(initialDir);
    const slot = findAvailableSlot("foo", initialDir, fx.repoDir);
    expect(slot.branchName).toBe("foo-2");
    expect(slot.worktreeDir).toBe(initialDir + "-2");
  });

  it("auto-suffixes to -2 when the branch already exists", () => {
    const initialDir = path.join(path.dirname(fx.repoDir), "repo-foo");
    mustGit(["branch", "foo"], fx.repoDir);
    const slot = findAvailableSlot("foo", initialDir, fx.repoDir);
    expect(slot.branchName).toBe("foo-2");
  });

  it("keeps incrementing past consecutive collisions", () => {
    const initialDir = path.join(path.dirname(fx.repoDir), "repo-foo");
    fs.mkdirSync(initialDir);
    fs.mkdirSync(initialDir + "-2");
    fs.mkdirSync(initialDir + "-3");
    const slot = findAvailableSlot("foo", initialDir, fx.repoDir);
    expect(slot.branchName).toBe("foo-4");
  });

  it("throws after MAX_SUFFIX_ATTEMPTS collisions", () => {
    const initialDir = path.join(path.dirname(fx.repoDir), "repo-foo");
    fs.mkdirSync(initialDir);
    for (let i = 2; i <= MAX_SUFFIX_ATTEMPTS; i++) {
      fs.mkdirSync(initialDir + `-${i}`);
    }
    expect(() => findAvailableSlot("foo", initialDir, fx.repoDir)).toThrow(/100 attempts/);
  });
});

describe(writeBranchMarker, () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-marker-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes the branch name with a trailing newline", () => {
    writeBranchMarker(dir, "feature-foo");
    const contents = fs.readFileSync(path.join(dir, BRANCH_MARKER_FILENAME), "utf8");
    expect(contents).toBe("feature-foo\n");
  });

  it("overwrites a stale marker with the new branch name", () => {
    writeBranchMarker(dir, "old-branch");
    writeBranchMarker(dir, "new-branch");
    const contents = fs.readFileSync(path.join(dir, BRANCH_MARKER_FILENAME), "utf8");
    expect(contents).toBe("new-branch\n");
  });
});

describe(ensureGitignoreMarkerEntry, () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ignore-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("creates the managed block in an empty gitignore", () => {
    fs.writeFileSync(path.join(dir, ".gitignore"), "");
    ensureGitignoreMarkerEntry(dir);
    const contents = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(contents).toContain("# managed by flow runtime");
    expect(contents).toContain(".flow-branch");
    expect(contents).toContain("# end flow runtime");
  });

  it("creates the managed block when no gitignore file exists", () => {
    ensureGitignoreMarkerEntry(dir);
    const contents = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(contents).toContain(".flow-branch");
  });

  it("is idempotent — calling twice does not duplicate the block", () => {
    ensureGitignoreMarkerEntry(dir);
    const after1 = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    ensureGitignoreMarkerEntry(dir);
    const after2 = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(after2).toBe(after1);
    const blockMatches = after2.match(/# managed by flow runtime/g) ?? [];
    expect(blockMatches.length).toBe(1);
  });

  it("preserves unrelated content around the managed block", () => {
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\ndist/\n");
    ensureGitignoreMarkerEntry(dir);
    const contents = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(contents).toContain("node_modules");
    expect(contents).toContain("dist/");
    expect(contents).toContain(".flow-branch");
  });
});

describe(ensureFlowTmpExclude, () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  // Resolves to the shared exclude file — the only one git reads patterns from.
  // In the primary worktree this is .git/info/exclude; in a secondary worktree
  // git rev-parse --git-common-dir resolves to the same primary .git/.
  function sharedExcludePath(): string {
    return path.join(fx.repoDir, ".git", "info", "exclude");
  }

  it("appends .flow-tmp/ to the shared .git/info/exclude", () => {
    if (fs.existsSync(sharedExcludePath())) fs.unlinkSync(sharedExcludePath());
    ensureFlowTmpExclude(fx.repoDir);
    const contents = fs.readFileSync(sharedExcludePath(), "utf8");
    expect(contents.split("\n")).toContain(FLOW_TMP_DIRNAME.replace(/\/$/, "/"));
  });

  it("is idempotent — second call does not duplicate the line", () => {
    ensureFlowTmpExclude(fx.repoDir);
    const after1 = fs.readFileSync(sharedExcludePath(), "utf8");
    ensureFlowTmpExclude(fx.repoDir);
    const after2 = fs.readFileSync(sharedExcludePath(), "utf8");
    expect(after2).toBe(after1);
    const matches = after2.match(/^\.flow-tmp\/$/gm) ?? [];
    expect(matches.length).toBe(1);
  });

  it("preserves existing exclude content", () => {
    fs.mkdirSync(path.dirname(sharedExcludePath()), { recursive: true });
    fs.writeFileSync(sharedExcludePath(), "# Pre-existing user content\n*.tmp\n");
    ensureFlowTmpExclude(fx.repoDir);
    const contents = fs.readFileSync(sharedExcludePath(), "utf8");
    expect(contents).toContain("# Pre-existing user content");
    expect(contents).toContain("*.tmp");
    expect(contents).toContain(FLOW_TMP_DIRNAME);
  });

  it("normalizes a missing trailing newline before appending", () => {
    fs.mkdirSync(path.dirname(sharedExcludePath()), { recursive: true });
    fs.writeFileSync(sharedExcludePath(), "*.tmp"); // no trailing newline
    ensureFlowTmpExclude(fx.repoDir);
    const contents = fs.readFileSync(sharedExcludePath(), "utf8");
    expect(contents).toContain("*.tmp\n.flow-tmp/\n");
  });

  // Regression guard for the bug fixed in this PR: when invoked from inside
  // a *secondary* worktree, the line must land in the primary's shared
  // .git/info/exclude (which git actually reads), NOT the per-worktree
  // .git/worktrees/<name>/info/exclude (which git ignores for exclude
  // patterns). Under the old --git-dir resolution this test would write to
  // the per-worktree path and `git check-ignore` would still exit 1.
  it("from a secondary worktree, writes to the primary's shared exclude (not the per-worktree one)", () => {
    const wtDir = path.join(path.dirname(fx.repoDir), "secondary");
    mustGit(["worktree", "add", "-b", "secondary", wtDir], fx.repoDir);

    if (fs.existsSync(sharedExcludePath())) fs.unlinkSync(sharedExcludePath());

    ensureFlowTmpExclude(wtDir);

    // The shared file got the line.
    const sharedContents = fs.readFileSync(sharedExcludePath(), "utf8");
    expect(sharedContents).toContain(FLOW_TMP_DIRNAME);

    // The per-worktree file (if it exists at all) did NOT.
    const perWorktreeExclude = path.join(
      fx.repoDir,
      ".git",
      "worktrees",
      "secondary",
      "info",
      "exclude",
    );
    if (fs.existsSync(perWorktreeExclude)) {
      expect(fs.readFileSync(perWorktreeExclude, "utf8")).not.toContain(FLOW_TMP_DIRNAME);
    }

    // And git agrees that .flow-tmp/ is now ignored from inside the worktree.
    const checkIgnore = spawnSync("git", ["check-ignore", ".flow-tmp/"], {
      cwd: wtDir,
      encoding: "utf8",
    });
    expect(checkIgnore.status).toBe(0);
  });
});

describe(createWorktreeWithRetry, () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  it("returns the second-attempt slot when gitWorktreeAdd throws on attempt 1 and succeeds on attempt 2", () => {
    const initialDir = path.join(path.dirname(fx.repoDir), "repo-foo");
    const calls: { branchName: string; worktreeDir: string }[] = [];
    let count = 0;
    const fakeGitAdd = (worktreeDir: string, branchName: string) => {
      calls.push({ branchName, worktreeDir });
      count += 1;
      if (count === 1) {
        // Simulate a peer winning the race: take the slot we'd planned to use,
        // so the next findAvailableSlot call moves on to the next suffix.
        fs.mkdirSync(worktreeDir, { recursive: true });
        throw new Error("simulated: directory '" + worktreeDir + "' already exists");
      }
    };

    const slot = createWorktreeWithRetry("foo", initialDir, "main", fx.repoDir, fakeGitAdd);

    expect(slot.branchName).toBe("foo-2");
    expect(slot.worktreeDir).toBe(initialDir + "-2");
    expect(calls).toHaveLength(2);
    expect(calls[0].branchName).toBe("foo");
    expect(calls[1].branchName).toBe("foo-2");
  });

  it("rethrows the last error when gitWorktreeAdd fails on every attempt", () => {
    const initialDir = path.join(path.dirname(fx.repoDir), "repo-foo");
    let count = 0;
    const fakeGitAdd = (worktreeDir: string) => {
      count += 1;
      // Take the slot so findAvailableSlot picks a fresh one each retry.
      fs.mkdirSync(worktreeDir, { recursive: true });
      throw new Error(`simulated failure ${count}`);
    };

    expect(() =>
      createWorktreeWithRetry("foo", initialDir, "main", fx.repoDir, fakeGitAdd),
    ).toThrow(/simulated failure 5/);
    expect(count).toBe(5);
  });
});

// --- Integration tests against a real git fixture ---------------------------

describe("flow-new-worktree (integration)", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  it("creates a worktree on the literal slug when nothing collides", async () => {
    const r = await spawnHelper(["foo"], fx.repoDir);
    expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);

    const expectedDir = path.join(path.dirname(fx.repoDir), "repo-foo");
    expect(fs.existsSync(expectedDir)).toBe(true);
    expect(fs.readFileSync(path.join(expectedDir, BRANCH_MARKER_FILENAME), "utf8").trim()).toBe(
      "foo",
    );
    expect(fs.readFileSync(path.join(fx.repoDir, ".gitignore"), "utf8")).toContain(".flow-branch");

    // The shared .git/info/exclude (the only one git reads patterns from) must
    // list .flow-tmp/ so the supervisor's scratch dir stays untracked. Writing
    // to the per-worktree path under .git/worktrees/<name>/info/exclude was the
    // bug fixed by switching ensureFlowTmpExclude to --git-common-dir; the
    // assertion below is the integration-level regression guard for that fix.
    const sharedExclude = path.join(fx.repoDir, ".git", "info", "exclude");
    expect(fs.existsSync(sharedExclude)).toBe(true);
    expect(fs.readFileSync(sharedExclude, "utf8")).toContain(".flow-tmp/");

    // And git agrees: .flow-tmp/ is ignored inside the new worktree.
    const checkIgnore = spawnSync("git", ["check-ignore", ".flow-tmp/"], {
      cwd: expectedDir,
      encoding: "utf8",
    });
    expect(checkIgnore.status, `check-ignore stderr: ${checkIgnore.stderr}`).toBe(0);
  });

  it("two parallel calls with the same slug return distinct paths and branches", async () => {
    const [a, b] = await Promise.all([
      spawnHelper(["pr-4-cleanup"], fx.repoDir),
      spawnHelper(["pr-4-cleanup"], fx.repoDir),
    ]);
    expect(a.exitCode, `a stderr: ${a.stderr}`).toBe(0);
    expect(b.exitCode, `b stderr: ${b.stderr}`).toBe(0);

    const dirA = path.join(path.dirname(fx.repoDir), "repo-pr-4-cleanup");
    const dirB = path.join(path.dirname(fx.repoDir), "repo-pr-4-cleanup-2");
    expect(fs.existsSync(dirA)).toBe(true);
    expect(fs.existsSync(dirB)).toBe(true);

    const markerA = fs.readFileSync(path.join(dirA, BRANCH_MARKER_FILENAME), "utf8").trim();
    const markerB = fs.readFileSync(path.join(dirB, BRANCH_MARKER_FILENAME), "utf8").trim();
    expect(markerA).toBe("pr-4-cleanup");
    expect(markerB).toBe("pr-4-cleanup-2");

    // Each worktree is on its own distinct branch — no cross-mutation.
    const branches = mustGit(["branch", "--list"], fx.repoDir);
    expect(branches).toContain("pr-4-cleanup");
    expect(branches).toContain("pr-4-cleanup-2");
  });

  it("--reuse on an existing matching worktree exits 0 and does not recreate", async () => {
    const first = await spawnHelper(["foo"], fx.repoDir);
    expect(first.exitCode, `first stderr: ${first.stderr}`).toBe(0);

    const dir = path.join(path.dirname(fx.repoDir), "repo-foo");
    const stampFile = path.join(dir, "stamp.txt");
    fs.writeFileSync(stampFile, "do-not-clobber");

    const second = await spawnHelper(["foo", "--reuse"], fx.repoDir);
    expect(second.exitCode, `second stderr: ${second.stderr}`).toBe(0);
    expect(fs.readFileSync(stampFile, "utf8")).toBe("do-not-clobber");
  });

  it("--reuse on a missing worktree exits non-zero with a clear error", async () => {
    const r = await spawnHelper(["does-not-exist", "--reuse"], fx.repoDir);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("--reuse");
  });

  it("--reuse on a worktree that's on the wrong branch exits non-zero", async () => {
    const first = await spawnHelper(["foo"], fx.repoDir);
    expect(first.exitCode, `first stderr: ${first.stderr}`).toBe(0);
    const dir = path.join(path.dirname(fx.repoDir), "repo-foo");
    mustGit(["switch", "-c", "wrong-branch"], dir);

    const second = await spawnHelper(["foo", "--reuse"], fx.repoDir);
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toContain("expected 'foo'");
  });

  it("--reuse with no slug exits non-zero with a clear missing-branch-name error", async () => {
    // Regression: previously crashed inside toDirSuffix() with an unhelpful
    // "Cannot read property 'replace' of undefined" TypeError.
    const r = await spawnHelper(["--reuse"], fx.repoDir);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("branch name is required");
  });
});
