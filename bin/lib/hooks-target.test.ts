import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveHooksTarget } from "./hooks-target";

function mustGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("resolveHooksTarget", () => {
  let repoDir!: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-hooks-target-"));
    mustGit(["init", "-b", "main"], repoDir);
    mustGit(["config", "user.email", "t@example.com"], repoDir);
    mustGit(["config", "user.name", "Flow Test"], repoDir);
    fs.writeFileSync(path.join(repoDir, "seed.txt"), "seed\n", "utf8");
    mustGit(["add", "seed.txt"], repoDir);
    mustGit(["commit", "-m", "seed"], repoDir);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("resolves hooksDir to <repo>/.git/hooks for a plain repo with no core.hooksPath", () => {
    const target = resolveHooksTarget(repoDir);
    expect(target.mainWorktree).toBe(fs.realpathSync(repoDir));
    expect(target.hooksDir).toBe(
      path.join(fs.realpathSync(repoDir), ".git", "hooks"),
    );
    expect(target.manager).toBe("none");
    expect(target.sidecarDir).toBe(target.hooksDir);
  });

  it("resolves hooksDir to the configured dir when core.hooksPath is ABSOLUTE", () => {
    const customHooks = path.join(repoDir, "my-hooks");
    fs.mkdirSync(customHooks, { recursive: true });
    mustGit(["config", "core.hooksPath", customHooks], repoDir);

    const target = resolveHooksTarget(repoDir);
    // git echoes an absolute core.hooksPath verbatim (no realpath resolve),
    // so compare against the literal configured path, not its realpath.
    expect(target.hooksDir).toBe(customHooks);
  });

  it("resolves hooksDir to the configured dir when core.hooksPath is RELATIVE, joined against mainWorktree not cwd", () => {
    mustGit(["config", "core.hooksPath", ".githooks"], repoDir);

    const target = resolveHooksTarget(repoDir);
    expect(target.hooksDir).toBe(
      path.join(fs.realpathSync(repoDir), ".githooks"),
    );
  });

  it("resolves mainWorktree to the primary checkout from inside a plain `git worktree`", () => {
    const worktreeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-hooks-target-wt-"),
    );
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    mustGit(["worktree", "add", "-b", "feature", worktreeDir], repoDir);
    try {
      const target = resolveHooksTarget(worktreeDir);
      expect(target.mainWorktree).toBe(fs.realpathSync(repoDir));
      expect(target.hooksDir).toBe(
        path.join(fs.realpathSync(repoDir), ".git", "hooks"),
      );
    } finally {
      mustGit(["worktree", "remove", "--force", worktreeDir], repoDir);
    }
  });

  // Regression spec: the reported bug. A flow worktree sets a
  // WORKTREE-SCOPED core.hooksPath pointing at its own <gitdir>/flow-hooks
  // (mirroring worktree-commit-hook.ts's installCommitHook). The base-branch
  // guard must still target the MAIN worktree's hooks dir, never that
  // per-worktree flow-hooks dir.
  it("resolves mainWorktree to the primary checkout even when the worktree carries a WORKTREE-SCOPED core.hooksPath (flow-worktree shape)", () => {
    const worktreeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-hooks-target-flowwt-"),
    );
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    mustGit(["worktree", "add", "-b", "flow-feature", worktreeDir], repoDir);
    try {
      const gitDir = mustGit(["rev-parse", "--git-dir"], worktreeDir);
      const absGitDir = path.isAbsolute(gitDir)
        ? gitDir
        : path.join(worktreeDir, gitDir);
      const flowHooksDir = path.join(absGitDir, "flow-hooks");
      mustGit(["config", "extensions.worktreeConfig", "true"], worktreeDir);
      mustGit(
        ["config", "--worktree", "core.hooksPath", flowHooksDir],
        worktreeDir,
      );

      const target = resolveHooksTarget(worktreeDir);
      expect(target.mainWorktree).toBe(fs.realpathSync(repoDir));
      // Must NOT be the per-worktree flow-hooks dir.
      expect(target.hooksDir).not.toBe(flowHooksDir);
      expect(target.hooksDir).toBe(
        path.join(fs.realpathSync(repoDir), ".git", "hooks"),
      );
    } finally {
      mustGit(["worktree", "remove", "--force", worktreeDir], repoDir);
    }
  });

  it('reports manager "husky" when hooksDir basename is `_` and a sibling husky.sh exists', () => {
    const huskyDir = path.join(repoDir, ".husky", "_");
    fs.mkdirSync(huskyDir, { recursive: true });
    fs.writeFileSync(path.join(huskyDir, "husky.sh"), "# husky\n", "utf8");
    mustGit(["config", "core.hooksPath", huskyDir], repoDir);

    const target = resolveHooksTarget(repoDir);
    expect(target.manager).toBe("husky");
  });

  it('reports manager "none" when hooksDir basename is `_` but no husky.sh/h sibling exists', () => {
    const underscoreDir = path.join(repoDir, "custom", "_");
    fs.mkdirSync(underscoreDir, { recursive: true });
    mustGit(["config", "core.hooksPath", underscoreDir], repoDir);

    const target = resolveHooksTarget(repoDir);
    expect(target.manager).toBe("none");
  });

  it("sets sidecarDir to the parent dir under husky and to hooksDir otherwise", () => {
    const huskyDir = path.join(repoDir, ".husky", "_");
    fs.mkdirSync(huskyDir, { recursive: true });
    fs.writeFileSync(path.join(huskyDir, "husky.sh"), "# husky\n", "utf8");
    mustGit(["config", "core.hooksPath", huskyDir], repoDir);

    const huskyTarget = resolveHooksTarget(repoDir);
    expect(huskyTarget.sidecarDir).toBe(path.dirname(huskyTarget.hooksDir));

    const plainDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-hooks-target-plain-"),
    );
    try {
      mustGit(["init", "-b", "main"], plainDir);
      const plainTarget = resolveHooksTarget(plainDir);
      expect(plainTarget.sidecarDir).toBe(plainTarget.hooksDir);
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it("falls back to <repoDir>/.git/hooks for a non-git directory without throwing", () => {
    const nonGitDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-hooks-target-nongit-"),
    );
    try {
      expect(() => resolveHooksTarget(nonGitDir)).not.toThrow();
      const target = resolveHooksTarget(nonGitDir);
      expect(target.mainWorktree).toBe(nonGitDir);
      expect(target.hooksDir).toBe(path.join(nonGitDir, ".git", "hooks"));
      expect(target.manager).toBe("none");
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("falls back to repoDir for mainWorktree when the repo is a submodule", () => {
    const superDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-hooks-target-super-"),
    );
    const subSourceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-hooks-target-subsrc-"),
    );
    try {
      mustGit(["init", "-b", "main"], subSourceDir);
      mustGit(["config", "user.email", "t@example.com"], subSourceDir);
      mustGit(["config", "user.name", "Flow Test"], subSourceDir);
      fs.writeFileSync(path.join(subSourceDir, "sub.txt"), "sub\n", "utf8");
      mustGit(["add", "sub.txt"], subSourceDir);
      mustGit(["commit", "-m", "sub seed"], subSourceDir);

      mustGit(["init", "-b", "main"], superDir);
      mustGit(["config", "user.email", "t@example.com"], superDir);
      mustGit(["config", "user.name", "Flow Test"], superDir);
      mustGit(
        [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          subSourceDir,
          "sub",
        ],
        superDir,
      );
      mustGit(["commit", "-m", "add submodule"], superDir);

      const submodulePath = path.join(superDir, "sub");
      const target = resolveHooksTarget(submodulePath);
      // The submodule fallback returns repoDir literally (no realpath), so
      // compare against the literal path passed in.
      expect(target.mainWorktree).toBe(submodulePath);
    } finally {
      fs.rmSync(superDir, { recursive: true, force: true });
      fs.rmSync(subSourceDir, { recursive: true, force: true });
    }
  });
});
