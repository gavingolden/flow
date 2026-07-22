/**
 * Tests for worktree-source.ts.
 *
 * Exercises inspectFlowRoot against real temp git repo + secondary worktree
 * fixtures (mirrors worktree-commit-hook.test.ts's mustGit/makeFixture
 * idiom), plus a plain non-git dir to prove the fail-open guard never
 * throws.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectFlowRoot } from "./worktree-source";

function mustGit(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return r.stdout.trim();
}

/** Stamps `dir` with the two files inspectFlowRoot requires to treat it as
 * a canonical flow checkout: bin/flow and a skills/ dir. */
function stampCanonicalCheckout(dir: string): void {
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "flow"), "#!/usr/bin/env bun\n");
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
}

type Fixture = {
  /** Primary (canonical) checkout of the repo. */
  repoDir: string;
  /** Secondary worktree. */
  worktreeDir: string;
  cleanup: () => void;
};

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-worktree-source-"));
  const repoDir = path.join(root, "repo");

  fs.mkdirSync(repoDir);
  mustGit(["init", "-b", "main"], repoDir);
  mustGit(["config", "user.email", "test@example.com"], repoDir);
  mustGit(["config", "user.name", "Test"], repoDir);
  stampCanonicalCheckout(repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "initial\n");
  mustGit(["add", "."], repoDir);
  mustGit(["commit", "-m", "initial"], repoDir);

  const worktreeDir = path.join(root, "repo-sibling");
  mustGit(["worktree", "add", "-b", "sibling", worktreeDir], repoDir);

  return {
    repoDir,
    worktreeDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

describe("inspectFlowRoot", () => {
  let fx!: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    fx.cleanup();
  });

  it("identifies a secondary worktree and derives the canonical root", () => {
    const info = inspectFlowRoot(fx.worktreeDir);
    expect(info.isWorktree).toBe(true);
    expect(info.canonicalRoot).toBe(fs.realpathSync(fx.repoDir));
  });

  it("identifies the main checkout as not a worktree", () => {
    const info = inspectFlowRoot(fx.repoDir);
    expect(info.isWorktree).toBe(false);
  });

  it("fails open (no throw) against a plain non-git directory", () => {
    const plainDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-worktree-source-plain-"),
    );
    try {
      expect(() => inspectFlowRoot(plainDir)).not.toThrow();
      expect(inspectFlowRoot(plainDir)).toEqual({
        isWorktree: false,
        canonicalRoot: null,
      });
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it("reports a worktree with canonicalRoot null when the common dir's parent isn't a flow checkout", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-worktree-source-bare-"),
    );
    const bareRepoDir = path.join(root, "repo");
    fs.mkdirSync(bareRepoDir);
    mustGit(["init", "-b", "main"], bareRepoDir);
    mustGit(["config", "user.email", "test@example.com"], bareRepoDir);
    mustGit(["config", "user.name", "Test"], bareRepoDir);
    // Deliberately NOT stamped with bin/flow + skills/.
    fs.writeFileSync(path.join(bareRepoDir, "README.md"), "initial\n");
    mustGit(["add", "."], bareRepoDir);
    mustGit(["commit", "-m", "initial"], bareRepoDir);
    const bareWorktreeDir = path.join(root, "repo-sibling");
    mustGit(["worktree", "add", "-b", "sibling", bareWorktreeDir], bareRepoDir);

    try {
      const info = inspectFlowRoot(bareWorktreeDir);
      expect(info.isWorktree).toBe(true);
      expect(info.canonicalRoot).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
