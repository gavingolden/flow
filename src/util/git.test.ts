import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findCanonicalRoot, findGitRoot } from "./git.js";

// Real-git integration tests. Each test builds a tiny throwaway repo (and
// optionally a worktree) so we exercise the actual `git rev-parse
// --git-common-dir` semantics rather than mocking them.
describe("findCanonicalRoot", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-canonical-"));
    await execa("git", ["init", "-q", "--initial-branch=main", tmp]);
    await execa("git", ["-C", tmp, "config", "user.email", "t@e.test"]);
    await execa("git", ["-C", tmp, "config", "user.name", "t"]);
    await fs.writeFile(path.join(tmp, "README"), "x");
    await execa("git", ["-C", tmp, "add", "."]);
    await execa("git", ["-C", tmp, "commit", "-q", "-m", "init"]);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns the main worktree path when called from the main worktree", async () => {
    // realpath: macOS tmp is symlinked from /tmp → /private/tmp.
    const expected = await fs.realpath(tmp);
    const got = await findCanonicalRoot(tmp);
    expect(got).not.toBeNull();
    expect(await fs.realpath(got!)).toBe(expected);
  });

  it("returns the main worktree path when called from a child worktree", async () => {
    const childDir = path.join(path.dirname(tmp), `${path.basename(tmp)}-child`);
    await execa(
      "git",
      ["-C", tmp, "worktree", "add", "-b", "child-branch", childDir],
    );
    try {
      const got = await findCanonicalRoot(childDir);
      expect(got).not.toBeNull();
      const expected = await fs.realpath(tmp);
      expect(await fs.realpath(got!)).toBe(expected);
      // findGitRoot from inside the child returns the *child*, not main —
      // proving the canonical helper does additional work.
      const naive = await findGitRoot(childDir);
      expect(await fs.realpath(naive!)).toBe(await fs.realpath(childDir));
    } finally {
      await execa("git", ["-C", tmp, "worktree", "remove", "--force", childDir]);
    }
  });

  it("returns null outside any git repo", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "flow-canonical-out-"));
    try {
      const got = await findCanonicalRoot(outside);
      expect(got).toBeNull();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
