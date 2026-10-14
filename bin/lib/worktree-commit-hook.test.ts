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
  CHAIN_HOOK_SHIM,
  FLOW_HOOK_NAMES,
  installCommitHook,
  repairFlowWorktreeHooks,
} from "./worktree-commit-hook";

// Fixture git calls must not read the host's global/system config (a global
// core.hooksPath or commit-signing setup would change what these cases prove).
const ISOLATED_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function mustGit(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env ?? ISOLATED_ENV,
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
  const env = { ...ISOLATED_ENV };
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

  it("creates an executable shim per hook name and sets worktree-scoped core.hooksPath + extensions.worktreeConfig", () => {
    installCommitHook(fx.worktreeDir);

    const hooksDir = path.join(gitDirOf(fx.worktreeDir), "flow-hooks");
    for (const name of FLOW_HOOK_NAMES) {
      const hookPath = path.join(hooksDir, name);
      expect(fs.readFileSync(hookPath, "utf8"), name).toBe(CHAIN_HOOK_SHIM);
      expect((fs.statSync(hookPath).mode & 0o111) !== 0, name).toBe(true);
    }
    expect(fs.readdirSync(hooksDir).sort()).toEqual(
      [...FLOW_HOOK_NAMES].sort(),
    );

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
    expect(after2).toBe(CHAIN_HOOK_SHIM);

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

describe("chaining to the consumer's hooks", () => {
  let fx: Fixture;
  let scratch: string;
  beforeEach(() => {
    fx = makeFixture();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-commit-hook-out-"));
  });
  afterEach(() => {
    fx.cleanup();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  function writeHook(dir: string, name: string, body: string): void {
    fs.mkdirSync(dir, { recursive: true });
    const hookPath = path.join(dir, name);
    fs.writeFileSync(hookPath, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(hookPath, 0o755);
  }

  function addRemote(): string {
    const remote = path.join(scratch, "remote.git");
    mustGit(["init", "--bare", "-b", "main", remote], scratch);
    mustGit(["remote", "add", "origin", remote], fx.repoDir);
    return remote;
  }

  function pushAttempt(dir: string): { status: number | null; stderr: string } {
    const r = spawnSync("git", ["push", "origin", "feature"], {
      cwd: dir,
      encoding: "utf8",
      env: ISOLATED_ENV,
    });
    return { status: r.status, stderr: r.stderr };
  }

  it("a relative shared core.hooksPath pre-push that exits 3 refuses a worktree push and receives the ref lines on stdin", () => {
    addRemote();
    mustGit(["config", "core.hooksPath", ".githooks"], fx.repoDir);
    const stdinFile = path.join(scratch, "pre-push.stdin");
    const cwdFile = path.join(scratch, "pre-push.cwd");
    writeHook(
      path.join(fx.worktreeDir, ".githooks"),
      "pre-push",
      `cat > "${stdinFile}"; pwd -P > "${cwdFile}"; exit 3`,
    );
    installCommitHook(fx.worktreeDir);

    const pushed = pushAttempt(fx.worktreeDir);
    expect(pushed.status).not.toBe(0);
    const stdin = fs.readFileSync(stdinFile, "utf8");
    expect(stdin).toMatch(
      /^refs\/heads\/feature [0-9a-f]{40} refs\/heads\/feature /,
    );
    expect(fs.readFileSync(cwdFile, "utf8").trim()).toBe(
      fs.realpathSync(fx.worktreeDir),
    );
    expect(mustGit(["ls-remote", "origin"], fx.repoDir)).not.toContain(
      "refs/heads/feature",
    );
  });

  it("a push succeeds when the consumer has no pre-push hook", () => {
    addRemote();
    installCommitHook(fx.worktreeDir);
    const pushed = pushAttempt(fx.worktreeDir);
    expect(pushed.status, pushed.stderr).toBe(0);
  });

  it("runs a default-folder pre-commit hook when core.hooksPath is unset", () => {
    const marker = path.join(scratch, "pre-commit.ran");
    writeHook(
      path.join(fx.repoDir, ".git", "hooks"),
      "pre-commit",
      `echo ran > "${marker}"`,
    );
    installCommitHook(fx.worktreeDir);
    commitAndReadMessage(fx.worktreeDir, "p.txt", undefined);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("a failing consumer pre-commit blocks the commit", () => {
    writeHook(path.join(fx.repoDir, ".git", "hooks"), "pre-commit", "exit 1");
    installCommitHook(fx.worktreeDir);
    fs.writeFileSync(path.join(fx.worktreeDir, "blocked.txt"), "x\n");
    mustGit(["add", "blocked.txt"], fx.worktreeDir);
    const r = spawnSync("git", ["commit", "-m", "blocked"], {
      cwd: fx.worktreeDir,
      encoding: "utf8",
      env: ISOLATED_ENV,
    });
    expect(r.status).not.toBe(0);
  });

  it("keeps both the consumer prepare-commit-msg edit and the session trailer", () => {
    writeHook(
      path.join(fx.repoDir, ".git", "hooks"),
      "prepare-commit-msg",
      `printf 'consumer-edit\\n' >> "$1"`,
    );
    installCommitHook(fx.worktreeDir);
    const message = commitAndReadMessage(fx.worktreeDir, "m.txt", "sess-chain");
    expect(message).toContain("consumer-edit");
    expect(message.trimEnd()).toMatch(/\nClaude-Code-Session-Id: sess-chain$/);
  });

  it("a failing consumer prepare-commit-msg aborts the commit", () => {
    writeHook(
      path.join(fx.repoDir, ".git", "hooks"),
      "prepare-commit-msg",
      "exit 7",
    );
    installCommitHook(fx.worktreeDir);
    fs.writeFileSync(path.join(fx.worktreeDir, "f.txt"), "x\n");
    mustGit(["add", "f.txt"], fx.worktreeDir);
    const r = spawnSync("git", ["commit", "-m", "x"], {
      cwd: fx.worktreeDir,
      encoding: "utf8",
      env: { ...ISOLATED_ENV, CLAUDE_CODE_SESSION_ID: "sess" },
    });
    expect(r.status).not.toBe(0);
  });

  it("does not loop when core.hooksPath at a non-worktree scope names the flow folder itself", () => {
    installCommitHook(fx.worktreeDir);
    const flowDir = path.join(
      mustGit(
        ["rev-parse", "--path-format=absolute", "--git-dir"],
        fx.worktreeDir,
      ),
      "flow-hooks",
    );
    mustGit(["config", "core.hooksPath", flowDir], fx.repoDir);
    const message = commitAndReadMessage(
      fx.worktreeDir,
      "loop.txt",
      "sess-loop",
    );
    expect(message.trimEnd()).toMatch(/\nClaude-Code-Session-Id: sess-loop$/);
  });
});

describe(repairFlowWorktreeHooks, () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  function flowHooksOf(dir: string): string {
    return path.join(
      mustGit(["rev-parse", "--path-format=absolute", "--git-dir"], dir),
      "flow-hooks",
    );
  }

  it("upgrades a stale single-hook worktree to the full shim set", () => {
    installCommitHook(fx.worktreeDir);
    const hooksDir = flowHooksOf(fx.worktreeDir);
    for (const name of fs.readdirSync(hooksDir)) {
      fs.rmSync(path.join(hooksDir, name));
    }
    fs.writeFileSync(
      path.join(hooksDir, "prepare-commit-msg"),
      "#!/bin/sh\n# old single-hook layout\n",
      { mode: 0o755 },
    );

    const result = repairFlowWorktreeHooks(fx.repoDir);
    expect(result.failed).toEqual([]);
    expect(result.repaired.map((d) => fs.realpathSync(d))).toEqual([
      fs.realpathSync(fx.worktreeDir),
    ]);
    expect(fs.readdirSync(hooksDir).sort()).toEqual(
      [...FLOW_HOOK_NAMES].sort(),
    );
    expect(fs.readFileSync(path.join(hooksDir, "pre-push"), "utf8")).toBe(
      CHAIN_HOOK_SHIM,
    );
  });

  it("leaves the primary checkout and an un-installed sibling untouched", () => {
    const sibling = path.join(path.dirname(fx.worktreeDir), "repo-sibling");
    mustGit(["worktree", "add", "-b", "sibling", sibling], fx.repoDir);
    const result = repairFlowWorktreeHooks(fx.repoDir);
    expect(result).toEqual({ repaired: [], failed: [] });
    expect(fs.existsSync(flowHooksOf(sibling))).toBe(false);
  });

  it("skips a prunable worktree whose directory is gone", () => {
    installCommitHook(fx.worktreeDir);
    const gone = path.join(path.dirname(fx.worktreeDir), "repo-gone");
    mustGit(["worktree", "add", "-b", "gone", gone], fx.repoDir);
    installCommitHook(gone);
    fs.rmSync(gone, { recursive: true, force: true });
    expect(mustGit(["worktree", "list", "--porcelain"], fx.repoDir)).toContain(
      "prunable",
    );

    const result = repairFlowWorktreeHooks(fx.repoDir);
    expect(result.failed).toEqual([]);
    expect(result.repaired.map((d) => fs.realpathSync(d))).toEqual([
      fs.realpathSync(fx.worktreeDir),
    ]);
  });
});
