import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// node:child_process's built-in module namespace has non-configurable
// properties in vitest's runtime, so a plain `vi.spyOn(childProcess,
// "spawnSync")` throws "Cannot redefine property". Mocking the module
// (preserving the real implementation via `importOriginal`) makes
// `spawnSync` a `vi.fn` we can inspect, while every other test in this
// file (which shells out to set up real git fixtures) keeps working
// unchanged.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

import { spawnSync } from "node:child_process";
import {
  resolveRepoRoot,
  resolveGitCommonDir,
  makeSameRepository,
} from "./repo-root";

const spawnSyncMock = vi.mocked(spawnSync);

describe("resolveRepoRoot", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-repo-root-"));
    spawnSync("git", ["init", "-q"], { cwd: repoDir });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns the repo toplevel for a path inside a git repo", () => {
    const nested = path.join(repoDir, "nested");
    fs.mkdirSync(nested);
    const resolved = resolveRepoRoot(nested);
    // Resolve both sides through fs.realpathSync to tolerate macOS's
    // /tmp -> /private/tmp symlink, which `git rev-parse --show-toplevel`
    // reports as the realpath.
    expect(resolved).toBe(fs.realpathSync(repoDir));
  });

  it("returns null when the path is not inside a git repo", () => {
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-repo-root-outside-"),
    );
    try {
      expect(resolveRepoRoot(outside)).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("returns null when git exits non-zero (e.g. a nonexistent cwd)", () => {
    const missing = path.join(repoDir, "does-not-exist");
    expect(resolveRepoRoot(missing)).toBeNull();
  });

  it("returns null when the resolved toplevel does not exist", () => {
    // Exercises the `!fs.existsSync(out)` guard specifically — a status-0
    // git run whose reported toplevel is missing, distinct from the
    // status-non-zero branch the two cases above already cover.
    const ghost = path.join(repoDir, "ghost-worktree");
    spawnSync("git", ["config", "core.worktree", ghost], { cwd: repoDir });
    const probe = spawnSync(
      "git",
      ["-C", repoDir, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    );
    if (probe.status !== 0) {
      // Local git disagrees on reporting a missing core.worktree verbatim;
      // skip rather than fail for the wrong reason.
      return;
    }
    expect(resolveRepoRoot(repoDir)).toBeNull();
  });
});

describe("resolveGitCommonDir", () => {
  let repoDir: string;
  let worktreeDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-common-dir-"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repoDir,
    });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n");
    spawnSync("git", ["add", "README.md"], { cwd: repoDir });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
  });

  afterEach(() => {
    if (worktreeDir) {
      spawnSync("git", ["worktree", "remove", "--force", worktreeDir], {
        cwd: repoDir,
      });
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns the same value for a main checkout and its linked worktree", () => {
    worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-common-dir-wt-"));
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    spawnSync("git", ["worktree", "add", "-b", "feature-branch", worktreeDir], {
      cwd: repoDir,
    });
    const mainCommon = resolveGitCommonDir(repoDir);
    const worktreeCommon = resolveGitCommonDir(worktreeDir);
    expect(mainCommon).not.toBeNull();
    expect(worktreeCommon).toBe(mainCommon);
  });

  it("resolves correctly from a subdirectory of a main checkout", () => {
    const nested = path.join(repoDir, "nested");
    fs.mkdirSync(nested);
    const rootCommon = resolveGitCommonDir(repoDir);
    const nestedCommon = resolveGitCommonDir(nested);
    expect(nestedCommon).toBe(rootCommon);
  });

  it("returns different values for two independent repos", () => {
    const otherRepo = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-common-dir-other-"),
    );
    try {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: otherRepo });
      const a = resolveGitCommonDir(repoDir);
      const b = resolveGitCommonDir(otherRepo);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).not.toBe(b);
    } finally {
      fs.rmSync(otherRepo, { recursive: true, force: true });
    }
  });

  it("returns null for a cwd not inside any git repo", () => {
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-common-dir-outside-"),
    );
    try {
      expect(resolveGitCommonDir(outside)).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("makeSameRepository", () => {
  let repoDir: string;
  let worktreeDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-same-repo-"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repoDir,
    });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n");
    spawnSync("git", ["add", "README.md"], { cwd: repoDir });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
  });

  afterEach(() => {
    if (worktreeDir) {
      spawnSync("git", ["worktree", "remove", "--force", worktreeDir], {
        cwd: repoDir,
      });
      fs.rmSync(worktreeDir, { recursive: true, force: true });
      worktreeDir = "";
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("fails open (returns true) for an empty repoPath", () => {
    const sameRepo = makeSameRepository(repoDir);
    expect(sameRepo("")).toBe(true);
    expect(sameRepo("   ")).toBe(true);
  });

  it("returns true when repoPath is the same repo as cwd", () => {
    const sameRepo = makeSameRepository(repoDir);
    expect(sameRepo(repoDir)).toBe(true);
  });

  it("returns true when repoPath is a linked worktree of cwd's repo", () => {
    worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-same-repo-wt-"));
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    spawnSync("git", ["worktree", "add", "-b", "feature-branch", worktreeDir], {
      cwd: repoDir,
    });
    const sameRepo = makeSameRepository(repoDir);
    expect(sameRepo(worktreeDir)).toBe(true);
  });

  it("returns false for two separate repos", () => {
    const otherRepo = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-same-repo-other-"),
    );
    try {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: otherRepo });
      const sameRepo = makeSameRepository(repoDir);
      expect(sameRepo(otherRepo)).toBe(false);
    } finally {
      fs.rmSync(otherRepo, { recursive: true, force: true });
    }
  });

  it("returns false for a deleted path, with zero spawnSync calls for it", () => {
    const deleted = path.join(
      os.tmpdir(),
      "flow-same-repo-deleted-does-not-exist",
    );
    const sameRepo = makeSameRepository(repoDir);
    spawnSyncMock.mockClear(); // drop the constructor's own resolveGitCommonDir(cwd) call
    expect(sameRepo(deleted)).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("matches a symlinked tmpdir path against its realpath'd twin", () => {
    // On macOS, os.tmpdir() commonly resolves through a /var -> /private/var
    // symlink; resolveGitCommonDir realpath's its result, so a caller
    // standing in the non-realpath'd path must still match.
    const realCwd = fs.realpathSync(repoDir);
    const sameRepo = makeSameRepository(realCwd);
    expect(sameRepo(repoDir)).toBe(true);
  });

  it("memoizes: two calls with the same repoPath spawn git only once", () => {
    const sameRepo = makeSameRepository(repoDir);
    spawnSyncMock.mockClear();
    sameRepo(repoDir);
    const firstCallCount = spawnSyncMock.mock.calls.length;
    sameRepo(repoDir);
    expect(spawnSyncMock.mock.calls.length).toBe(firstCallCount);
  });
});
