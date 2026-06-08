/**
 * Tests for worktree-commit-hook.ts.
 *
 * Exercises installCommitHook against a real temp git repo + secondary
 * worktree fixture. Commit-time behaviour is verified by spawning real
 * `git commit` with CLAUDE_CODE_SESSION_ID explicitly set/unset per case —
 * the suite never depends on an ambient session id.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PREPARE_COMMIT_MSG_HOOK,
  installCommitHook,
} from "./worktree-commit-hook";

function mustGit(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env ?? process.env,
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return r.stdout.trim();
}

type Fixture = {
  /** Primary worktree of the repo. */
  repoDir: string;
  /** Secondary worktree where the hook is installed. */
  worktreeDir: string;
  cleanup: () => void;
};

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-commit-hook-"));
  const repoDir = path.join(root, "repo");

  fs.mkdirSync(repoDir);
  mustGit(["init", "-b", "main"], repoDir);
  mustGit(["config", "user.email", "test@example.com"], repoDir);
  mustGit(["config", "user.name", "Test"], repoDir);
  fs.writeFileSync(path.join(repoDir, "file.txt"), "initial\n");
  mustGit(["add", "."], repoDir);
  mustGit(["commit", "-m", "initial"], repoDir);

  const worktreeDir = path.join(root, "repo-feature");
  mustGit(["worktree", "add", "-b", "feature", worktreeDir], repoDir);

  return {
    repoDir,
    worktreeDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Commits a fresh change in `dir` and returns the resulting commit message body. */
function commitAndReadMessage(
  dir: string,
  fileName: string,
  sessionId: string | undefined,
): string {
  fs.writeFileSync(
    path.join(dir, fileName),
    `content ${Date.now()}-${Math.random()}\n`,
  );
  const env = { ...process.env };
  if (sessionId === undefined) {
    delete env.CLAUDE_CODE_SESSION_ID;
  } else {
    env.CLAUDE_CODE_SESSION_ID = sessionId;
  }
  mustGit(["add", fileName], dir, env);
  mustGit(["commit", "-m", `commit ${fileName}`], dir, env);
  return mustGit(["log", "-1", "--format=%B"], dir, env);
}

describe(installCommitHook, () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  function gitDirOf(worktreeDir: string): string {
    const raw = mustGit(["rev-parse", "--git-dir"], worktreeDir);
    return path.isAbsolute(raw) ? raw : path.join(worktreeDir, raw);
  }

  it("creates the hook file and sets worktree-scoped core.hooksPath + extensions.worktreeConfig", () => {
    installCommitHook(fx.worktreeDir);

    const hooksDir = path.join(gitDirOf(fx.worktreeDir), "flow-hooks");
    const hookPath = path.join(hooksDir, "prepare-commit-msg");
    expect(fs.existsSync(hookPath)).toBe(true);
    expect((fs.statSync(hookPath).mode & 0o111) !== 0).toBe(true);

    expect(
      mustGit(["config", "extensions.worktreeConfig"], fx.worktreeDir),
    ).toBe("true");
    expect(
      mustGit(["config", "--worktree", "core.hooksPath"], fx.worktreeDir),
    ).toBe(hooksDir);
  });

  it("stamps a Claude-Code-Session-Id trailer on a commit when the env var is set", () => {
    installCommitHook(fx.worktreeDir);
    const message = commitAndReadMessage(
      fx.worktreeDir,
      "a.txt",
      "sess-abc-123",
    );
    expect(message.trimEnd()).toMatch(
      /\nClaude-Code-Session-Id: sess-abc-123$/,
    );
  });

  it("adds no trailer when CLAUDE_CODE_SESSION_ID is unset", () => {
    installCommitHook(fx.worktreeDir);
    const message = commitAndReadMessage(fx.worktreeDir, "b.txt", undefined);
    expect(message).not.toContain("Claude-Code-Session-Id");
  });

  it("does not double-stamp a message that already carries the trailer", () => {
    installCommitHook(fx.worktreeDir);
    const message = commitAndReadMessage(fx.worktreeDir, "c.txt", "sess-dup");
    const occurrences = (message.match(/Claude-Code-Session-Id:/g) ?? [])
      .length;
    expect(occurrences).toBe(1);
  });

  it("is idempotent — a second install does not duplicate config or corrupt the hook", () => {
    installCommitHook(fx.worktreeDir);
    const hookPath = path.join(
      gitDirOf(fx.worktreeDir),
      "flow-hooks",
      "prepare-commit-msg",
    );
    const after1 = fs.readFileSync(hookPath, "utf8");

    installCommitHook(fx.worktreeDir);
    const after2 = fs.readFileSync(hookPath, "utf8");
    expect(after2).toBe(after1);
    expect(after2).toBe(PREPARE_COMMIT_MSG_HOOK);

    // git config --worktree --get-all returns one value per set; a duplicated
    // install would yield two lines.
    const hooksPathValues = mustGit(
      ["config", "--worktree", "--get-all", "core.hooksPath"],
      fx.worktreeDir,
    );
    expect(hooksPathValues.split("\n").filter(Boolean)).toHaveLength(1);

    // The hook still stamps correctly after the second install.
    const message = commitAndReadMessage(fx.worktreeDir, "d.txt", "sess-idem");
    expect(message.trimEnd()).toMatch(/\nClaude-Code-Session-Id: sess-idem$/);
  });

  it("does not affect the primary repo — a primary-repo commit gets no trailer", () => {
    installCommitHook(fx.worktreeDir);
    // Commit in the primary repo with the env var set: the worktree-scoped
    // core.hooksPath must not leak to the primary.
    const message = commitAndReadMessage(
      fx.repoDir,
      "primary.txt",
      "sess-leak-check",
    );
    expect(message).not.toContain("Claude-Code-Session-Id");
  });

  it("does not affect a sibling worktree that never had installCommitHook run", () => {
    installCommitHook(fx.worktreeDir);
    // A second plain `git worktree add` sibling — no installCommitHook call.
    // Both worktrees share the same common git-dir and `extensions.worktreeConfig`
    // is a repo-global flag once set by the first install; this proves the
    // `--worktree`-scoped `core.hooksPath` truly isolates per-worktree and does
    // not implicitly opt the sibling into the flow hook.
    const siblingDir = path.join(path.dirname(fx.worktreeDir), "repo-sibling");
    mustGit(["worktree", "add", "-b", "sibling", siblingDir], fx.repoDir);
    const message = commitAndReadMessage(
      siblingDir,
      "sibling.txt",
      "sess-sibling-check",
    );
    expect(message).not.toContain("Claude-Code-Session-Id");
  });
});
