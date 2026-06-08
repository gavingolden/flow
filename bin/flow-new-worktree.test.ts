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
import {
  createWorktreeWithRetry,
  parseArgs,
  pickBranchName,
} from "./flow-new-worktree";
import {
  MAX_SUFFIX_ATTEMPTS,
  findAvailableSlot,
  toDirSuffix,
} from "./lib/worktree-slot";
import {
  BRANCH_MARKER_FILENAME,
  FLOW_TMP_DIRNAME,
  ensureFlowExcludes,
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

describe(pickBranchName, () => {
  it("returns the positional when it matches the pane slug", () => {
    expect(pickBranchName("add-csv-export", "add-csv-export")).toEqual({
      kind: "ok",
      branchName: "add-csv-export",
    });
  });

  it("defaults to the pane slug when the positional is omitted", () => {
    expect(pickBranchName(undefined, "fix-tooltip")).toEqual({
      kind: "ok",
      branchName: "fix-tooltip",
    });
  });

  it("errors with slug-mismatch when the positional disagrees with the pane slug", () => {
    // Mirrors PR #152's footgun: pane @flow-slug was the auto-derived value,
    // supervisor passed a different reading of the same description.
    const r = pickBranchName(
      "all-scopes-rename",
      "rename-valid-scopes-all-scopes",
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toContain("slug-mismatch");
    expect(r.message).toContain("all-scopes-rename");
    expect(r.message).toContain("rename-valid-scopes-all-scopes");
    expect(r.exitCode).toBe(2);
  });

  it("uses the positional when no pane slug is available", () => {
    expect(pickBranchName("foo", null)).toEqual({
      kind: "ok",
      branchName: "foo",
    });
  });

  it("errors 'branch name is required' when both positional and pane slug are absent", () => {
    const r = pickBranchName(undefined, null);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toBe("branch name is required");
    expect(r.exitCode).toBe(1);
  });
});

describe(parseArgs, () => {
  // These three cases short-circuit before git rev-parse so they need no
  // fixture — they exercise the discriminated-union wrapper directly via
  // the RunNewWorktreeDeps seam, mirroring flow-state-update.test.ts's
  // RunUpdateDeps parameterisation.
  it("returns { kind: 'help' } for --help", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
  });

  it("returns a help-bannered error when no positional and no pane slug", () => {
    const r = parseArgs([], { resolveSlug: () => null });
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.exitCode).toBe(1);
    expect(r.showHelp).toBe(true);
    expect(r.message).toContain("branch name is required");
  });

  it("returns a no-banner error on slug mismatch (its own message names the fix)", () => {
    const r = parseArgs(["foo"], { resolveSlug: () => "bar" });
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.exitCode).toBe(2);
    expect(r.showHelp).toBeFalsy();
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
  // Empty .gitignore tracked from the start so the integration test below can
  // assert flow-new-worktree leaves it alone (no managed-block pollution).
  fs.writeFileSync(path.join(repoDir, ".gitignore"), "");
  mustGit(["add", "."], repoDir);
  mustGit(["commit", "-m", "initial"], repoDir);

  // Create a bare clone to act as `origin` so origin/main exists.
  mustGit(["clone", "--bare", repoDir, remoteDir], path.dirname(repoDir));
  mustGit(["remote", "add", "origin", remoteDir], repoDir);
  mustGit(["fetch", "origin"], repoDir);
  mustGit(["branch", "--set-upstream-to=origin/main", "main"], repoDir);
  // origin/HEAD makes detectDefaultBranch's first attempt succeed.
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

const FLOW_NEW_WORKTREE_BIN = path.resolve(__dirname, "flow-new-worktree.ts");

type SpawnResult = { exitCode: number; stdout: string; stderr: string };

function spawnHelper(args: string[], cwd: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    // Strip TMUX_PANE so the helper's resolveSlugFromPane() returns null
    // for these integration tests — the runner itself may live inside a
    // flow pipeline window (@flow-slug set), which would otherwise
    // trigger the new slug-mismatch guard against the test's literal
    // positional. Unit tests below exercise the pane-slug path via the
    // injectable seam.
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
    expect(slot.worktreeDir).toBe(
      path.join(path.dirname(fx.repoDir), "repo-foo"),
    );
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
    expect(() => findAvailableSlot("foo", initialDir, fx.repoDir)).toThrow(
      /100 attempts/,
    );
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
    const contents = fs.readFileSync(
      path.join(dir, BRANCH_MARKER_FILENAME),
      "utf8",
    );
    expect(contents).toBe("feature-foo\n");
  });

  it("overwrites a stale marker with the new branch name", () => {
    writeBranchMarker(dir, "old-branch");
    writeBranchMarker(dir, "new-branch");
    const contents = fs.readFileSync(
      path.join(dir, BRANCH_MARKER_FILENAME),
      "utf8",
    );
    expect(contents).toBe("new-branch\n");
  });
});

describe(ensureFlowExcludes, () => {
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

  it("appends both .flow-tmp/ and .flow-branch to the shared .git/info/exclude", () => {
    if (fs.existsSync(sharedExcludePath())) fs.unlinkSync(sharedExcludePath());
    ensureFlowExcludes(fx.repoDir);
    const lines = fs.readFileSync(sharedExcludePath(), "utf8").split("\n");
    expect(lines).toContain(FLOW_TMP_DIRNAME);
    expect(lines).toContain(BRANCH_MARKER_FILENAME);
  });

  it("creates info/exclude when missing", () => {
    const dir = path.dirname(sharedExcludePath());
    if (fs.existsSync(sharedExcludePath())) fs.unlinkSync(sharedExcludePath());
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    ensureFlowExcludes(fx.repoDir);
    expect(fs.existsSync(sharedExcludePath())).toBe(true);
  });

  it("is idempotent — second call does not duplicate either line", () => {
    ensureFlowExcludes(fx.repoDir);
    const after1 = fs.readFileSync(sharedExcludePath(), "utf8");
    ensureFlowExcludes(fx.repoDir);
    const after2 = fs.readFileSync(sharedExcludePath(), "utf8");
    expect(after2).toBe(after1);
    const tmpMatches = after2.match(/^\.flow-tmp\/$/gm) ?? [];
    const branchMatches = after2.match(/^\.flow-branch$/gm) ?? [];
    expect(tmpMatches.length).toBe(1);
    expect(branchMatches.length).toBe(1);
  });

  it("preserves existing exclude content", () => {
    fs.mkdirSync(path.dirname(sharedExcludePath()), { recursive: true });
    fs.writeFileSync(
      sharedExcludePath(),
      "# Pre-existing user content\n*.tmp\n",
    );
    ensureFlowExcludes(fx.repoDir);
    const contents = fs.readFileSync(sharedExcludePath(), "utf8");
    expect(contents).toContain("# Pre-existing user content");
    expect(contents).toContain("*.tmp");
    expect(contents).toContain(FLOW_TMP_DIRNAME);
    expect(contents).toContain(BRANCH_MARKER_FILENAME);
  });

  it("normalizes a missing trailing newline before appending", () => {
    fs.mkdirSync(path.dirname(sharedExcludePath()), { recursive: true });
    fs.writeFileSync(sharedExcludePath(), "*.tmp"); // no trailing newline
    ensureFlowExcludes(fx.repoDir);
    const contents = fs.readFileSync(sharedExcludePath(), "utf8");
    expect(contents.startsWith("*.tmp\n")).toBe(true);
    expect(contents).toContain(`\n${BRANCH_MARKER_FILENAME}\n`);
    expect(contents).toContain(`\n${FLOW_TMP_DIRNAME}\n`);
  });

  it("only appends the missing entries when one is already present", () => {
    fs.mkdirSync(path.dirname(sharedExcludePath()), { recursive: true });
    fs.writeFileSync(sharedExcludePath(), `${FLOW_TMP_DIRNAME}\n`);
    ensureFlowExcludes(fx.repoDir);
    const contents = fs.readFileSync(sharedExcludePath(), "utf8");
    const tmpMatches = contents.match(/^\.flow-tmp\/$/gm) ?? [];
    const branchMatches = contents.match(/^\.flow-branch$/gm) ?? [];
    expect(tmpMatches.length).toBe(1);
    expect(branchMatches.length).toBe(1);
  });

  // Regression guard for the bug fixed when ensureFlowTmpExclude was first
  // introduced: when invoked from inside a *secondary* worktree, the lines
  // must land in the primary's shared .git/info/exclude (which git actually
  // reads), NOT the per-worktree .git/worktrees/<name>/info/exclude (which git
  // ignores for exclude patterns).
  it("from a secondary worktree, writes to the primary's shared exclude (not the per-worktree one)", () => {
    const wtDir = path.join(path.dirname(fx.repoDir), "secondary");
    mustGit(["worktree", "add", "-b", "secondary", wtDir], fx.repoDir);

    if (fs.existsSync(sharedExcludePath())) fs.unlinkSync(sharedExcludePath());

    ensureFlowExcludes(wtDir);

    // The shared file got both lines.
    const sharedContents = fs.readFileSync(sharedExcludePath(), "utf8");
    expect(sharedContents).toContain(FLOW_TMP_DIRNAME);
    expect(sharedContents).toContain(BRANCH_MARKER_FILENAME);

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
      const perContents = fs.readFileSync(perWorktreeExclude, "utf8");
      expect(perContents).not.toContain(FLOW_TMP_DIRNAME);
      expect(perContents).not.toContain(BRANCH_MARKER_FILENAME);
    }

    // And git agrees that both paths are now ignored from inside the worktree.
    for (const p of [FLOW_TMP_DIRNAME, BRANCH_MARKER_FILENAME]) {
      const checkIgnore = spawnSync("git", ["check-ignore", p], {
        cwd: wtDir,
        encoding: "utf8",
      });
      expect(
        checkIgnore.status,
        `git check-ignore ${p} stderr: ${checkIgnore.stderr}`,
      ).toBe(0);
    }
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
        throw new Error(
          "simulated: directory '" + worktreeDir + "' already exists",
        );
      }
    };

    const slot = createWorktreeWithRetry(
      "foo",
      initialDir,
      "main",
      fx.repoDir,
      fakeGitAdd,
    );

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
      createWorktreeWithRetry(
        "foo",
        initialDir,
        "main",
        fx.repoDir,
        fakeGitAdd,
      ),
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
    expect(
      fs
        .readFileSync(path.join(expectedDir, BRANCH_MARKER_FILENAME), "utf8")
        .trim(),
    ).toBe("foo");

    // The user's tracked .gitignore must NOT have been touched — flow-runtime
    // metadata lives in .git/info/exclude (common dir), not the consumer
    // repo's tracked ignore rules.
    expect(fs.readFileSync(path.join(fx.repoDir, ".gitignore"), "utf8")).toBe(
      "",
    );

    // The shared .git/info/exclude (the only one git reads patterns from) must
    // list both .flow-tmp/ and .flow-branch so they stay untracked across every
    // worktree of the repo.
    const sharedExclude = path.join(fx.repoDir, ".git", "info", "exclude");
    expect(fs.existsSync(sharedExclude)).toBe(true);
    const sharedExcludeContents = fs.readFileSync(sharedExclude, "utf8");
    expect(sharedExcludeContents).toContain(FLOW_TMP_DIRNAME);
    expect(sharedExcludeContents).toContain(BRANCH_MARKER_FILENAME);

    // And git agrees: both paths are ignored inside the new worktree.
    for (const p of [FLOW_TMP_DIRNAME, BRANCH_MARKER_FILENAME]) {
      const checkIgnore = spawnSync("git", ["check-ignore", p], {
        cwd: expectedDir,
        encoding: "utf8",
      });
      expect(
        checkIgnore.status,
        `check-ignore ${p} stderr: ${checkIgnore.stderr}`,
      ).toBe(0);
    }

    // flow-new-worktree wires in the prepare-commit-msg hook (best-effort) on
    // worktree creation — assert the install actually fired. The hook lives
    // under the worktree's own git-dir (not --git-common-dir), so resolve it
    // from inside the worktree.
    const gitDirRaw = mustGit(["rev-parse", "--git-dir"], expectedDir);
    const gitDir = path.isAbsolute(gitDirRaw)
      ? gitDirRaw
      : path.join(expectedDir, gitDirRaw);
    expect(
      fs.existsSync(path.join(gitDir, "flow-hooks", "prepare-commit-msg")),
    ).toBe(true);
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

    const markerA = fs
      .readFileSync(path.join(dirA, BRANCH_MARKER_FILENAME), "utf8")
      .trim();
    const markerB = fs
      .readFileSync(path.join(dirB, BRANCH_MARKER_FILENAME), "utf8")
      .trim();
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
