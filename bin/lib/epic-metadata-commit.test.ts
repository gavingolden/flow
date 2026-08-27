import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  commitEpicStatus,
  dirtyEpicMetadata,
  epicStatusRelPath,
  pushEpicStatus,
  pushEpicStatusFromWrittenPath,
  repoCommitState,
  resolveContainedRepoRoot,
  type GitRunner,
} from "./epic-metadata-commit";
import {
  BASE_BRANCH_GUARD_HOOK,
  BASE_BRANCH_GUARD_VERSION,
  LEGACY_HOOK_BODIES,
} from "./base-branch-guard";

type Resp = { stdout?: string; stderr?: string; exitCode?: number };

// `commitEpicStatus` resolves the repo root via a REAL `git rev-parse
// --show-toplevel` (not through the injected GitRunner), so the directory
// dirname(writtenPath) must exist on disk inside a real git repo — only the
// status/add/commit calls themselves are faked.
function withTempRepo<T>(run: (repoRoot: string) => T): T {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-emc-repo-"));
  try {
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
    spawnSync("git", ["config", "user.email", "t@example.com"], {
      cwd: repoRoot,
    });
    spawnSync("git", ["config", "user.name", "Flow Test"], { cwd: repoRoot });
    fs.mkdirSync(path.join(repoRoot, ".flow", "epics", "e1"), {
      recursive: true,
    });
    // realpathSync inside commitEpicStatus requires the written file to
    // actually exist on disk (mirroring production, where fs.writeFileSync
    // already ran before commitEpicStatus is called).
    fs.writeFileSync(
      path.join(repoRoot, ".flow", "epics", "e1", "status.json"),
      "{}\n",
      "utf8",
    );
    return run(repoRoot);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

function makeTempRepo(prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  spawnSync("git", ["config", "user.email", "t@example.com"], {
    cwd: repoRoot,
  });
  spawnSync("git", ["config", "user.name", "Flow Test"], { cwd: repoRoot });
  return repoRoot;
}

// Two independent real repos: repoA carries the board, repoB stands in for
// the operator's current directory. Exercises resolveContainedRepoRoot and
// the two writers it gates without duplicating withTempRepo's board-writing
// setup for a single repo.
function withTwoTempRepos<T>(run: (repoA: string, repoB: string) => T): T {
  const repoA = makeTempRepo("flow-emc-repoA-");
  const repoB = makeTempRepo("flow-emc-repoB-");
  try {
    fs.mkdirSync(path.join(repoA, ".flow", "epics", "e1"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repoA, ".flow", "epics", "e1", "status.json"),
      "{}\n",
      "utf8",
    );
    return run(repoA, repoB);
  } finally {
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
  }
}

function makeGit(respond: (argv: string[]) => Resp | undefined) {
  const calls: string[][] = [];
  const git: GitRunner = (argv) => {
    calls.push(argv);
    const r = respond(argv) ?? {};
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.exitCode ?? 0,
    };
  };
  return { git, calls };
}

describe("epicStatusRelPath", () => {
  it("returns forward-slashed .flow/epics/<slug>/status.json", () => {
    expect(epicStatusRelPath("my-epic")).toBe(
      ".flow/epics/my-epic/status.json",
    );
  });
});

describe("commitEpicStatus", () => {
  it("happy path: status then add then commit -- <rel>, returns committed:true", () => {
    withTempRepo((repoRoot) => {
      const { git, calls } = makeGit((argv) => {
        if (argv[0] === "status")
          return { stdout: " M .flow/epics/e1/status.json\n" };
        return { exitCode: 0 };
      });
      const writtenPath = path.join(repoRoot, ".flow/epics/e1/status.json");
      const result = commitEpicStatus({
        writtenPath,
        epicSlug: "e1",
        cwd: repoRoot,
        git,
      });
      expect(result).toEqual({ committed: true });

      const commitCall = calls.find((c) => c[0] === "commit");
      expect(commitCall).toBeDefined();
      expect(commitCall).toContain("--");
      expect(commitCall).toContain(".flow/epics/e1/status.json");
      // Exact call sequence — NOT just "for each add call, it's scoped",
      // which iterates zero times (and passes vacuously) if `git add` were
      // ever deleted from production. `cat-file` is Task 2's post-commit
      // HEAD-verify probe (never removed, never loosened to `.some()`).
      expect(calls.map((c) => c[0])).toEqual([
        "status",
        "add",
        "commit",
        "cat-file",
      ]);
      expect(calls[1]).toContain(".flow/epics/e1/status.json");
    });
  });

  it("real git: commits a brand-new UNTRACKED board (no injected git, no `add` guard)", () => {
    withTempRepo((repoRoot) => {
      const untrackedDir = path.join(repoRoot, ".flow", "epics", "e2");
      fs.mkdirSync(untrackedDir, { recursive: true });
      const writtenPath = path.join(untrackedDir, "status.json");
      fs.writeFileSync(writtenPath, "{}\n", "utf8");
      const result = commitEpicStatus({
        writtenPath,
        epicSlug: "e2",
        cwd: repoRoot,
      });
      expect(result).toEqual({ committed: true });
      const log = spawnSync("git", ["log", "--oneline", "-1"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(log.stdout).toContain("sync e2 status board");
    });
  });

  it("git-error when `git add` itself fails", () => {
    withTempRepo((repoRoot) => {
      const { git, calls } = makeGit((argv) => {
        if (argv[0] === "status")
          return { stdout: " M .flow/epics/e1/status.json\n" };
        if (argv[0] === "add")
          return { exitCode: 1, stderr: "fatal: add failed\n" };
        return { exitCode: 0 };
      });
      const writtenPath = path.join(repoRoot, ".flow/epics/e1/status.json");
      const result = commitEpicStatus({
        writtenPath,
        epicSlug: "e1",
        cwd: repoRoot,
        git,
      });
      expect(result).toEqual({
        committed: false,
        reason: "git-error",
        detail: "fatal: add failed",
      });
      expect(calls.some((c) => c[0] === "commit")).toBe(false);
    });
  });

  it("nothing-staged when the status probe returns empty stdout", () => {
    withTempRepo((repoRoot) => {
      const { git, calls } = makeGit((argv) => {
        if (argv[0] === "status") return { stdout: "" };
        return { exitCode: 0 };
      });
      const writtenPath = path.join(repoRoot, ".flow/epics/e1/status.json");
      const result = commitEpicStatus({
        writtenPath,
        epicSlug: "e1",
        cwd: repoRoot,
        git,
      });
      expect(result).toEqual({ committed: false, reason: "nothing-staged" });
      expect(calls.some((c) => c[0] === "commit")).toBe(false);
    });
  });

  it("commit-refused when the commit exits non-zero, detail carries truncated stderr", () => {
    withTempRepo((repoRoot) => {
      const { git } = makeGit((argv) => {
        if (argv[0] === "status")
          return { stdout: " M .flow/epics/e1/status.json\n" };
        if (argv[0] === "add") return { exitCode: 0 };
        if (argv[0] === "commit") {
          return {
            exitCode: 1,
            stderr: "refusing to commit on the base branch\nmore\n",
          };
        }
        return { exitCode: 0 };
      });
      const writtenPath = path.join(repoRoot, ".flow/epics/e1/status.json");
      const result = commitEpicStatus({
        writtenPath,
        epicSlug: "e1",
        cwd: repoRoot,
        git,
      });
      expect(result.committed).toBe(false);
      expect(result.reason).toBe("commit-refused");
      expect(result.detail).toContain("refusing to commit on the base branch");
    });
  });

  it("not-a-repo when writtenPath is outside any repo", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "flow-emc-norepo-"));
    try {
      const { git } = makeGit(() => ({ exitCode: 0 }));
      const result = commitEpicStatus({
        writtenPath: path.join(outside, "status.json"),
        epicSlug: "e1",
        cwd: outside,
        git,
      });
      expect(result).toEqual({ committed: false, reason: "not-a-repo" });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("STALE-CACHE GUARD: writtenPath resolves to a repo but is outside repoRoot means not-a-repo, no commit argv", () => {
    // Simulate a stale-cache path by resolving repoRoot to THIS repo while
    // writtenPath points into a sibling temp dir with no .git at all —
    // resolveRepoRoot(dirname(writtenPath)) then returns null, so this is
    // exercised as the "no repo found for the written path" branch.
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "flow-emc-stale-"));
    try {
      const { git, calls } = makeGit(() => ({ exitCode: 0 }));
      const result = commitEpicStatus({
        writtenPath: path.join(sibling, ".flow/epics/e1/status.json"),
        epicSlug: "e1",
        cwd: sibling,
        git,
      });
      expect(result).toEqual({ committed: false, reason: "not-a-repo" });
      expect(calls.some((c) => c[0] === "commit")).toBe(false);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });
});

// Task 2's self-heal + board-vanished coverage. Per the header comment
// above: `commitEpicStatus` resolves the repo root via REAL git, and
// `installedGuardCapability`/`installBaseBranchGuard`/`resolveHooksTarget`
// all use the module-level `git()` from `bin/lib/git.ts` plus real `fs` — a
// fake `GitRunner` will NOT intercept them, so these tests stand up a real
// repo and a real hook file and call `commitEpicStatus` with NO injected
// `git` (falling back to the real `defaultGit`).
describe("commitEpicStatus — self-heal", () => {
  const hookPath = (repoRoot: string) =>
    path.join(repoRoot, ".git", "hooks", "pre-commit");

  const writeRealHook = (repoRoot: string, contents: string) => {
    fs.mkdirSync(path.dirname(hookPath(repoRoot)), { recursive: true });
    fs.writeFileSync(hookPath(repoRoot), contents, "utf8");
    fs.chmodSync(hookPath(repoRoot), 0o755);
  };

  // Both flow-session markers must be SET for the real hook to actually
  // refuse/allow a base-branch commit (see base-branch-guard.ts's
  // BASE_BRANCH_GUARD_HOOK doc comment) — set-and-restore around each test
  // so a leak can't affect a sibling file (a known cross-file flake source
  // in this repo).
  const withSessionMarkers = <T>(fn: () => T): T => {
    const prevSession = process.env.CLAUDE_CODE_SESSION_ID;
    const prevSlug = process.env.FLOW_SLUG;
    process.env.CLAUDE_CODE_SESSION_ID = "sess-emc-heal-test";
    process.env.FLOW_SLUG = "emc-heal-test";
    try {
      return fn();
    } finally {
      if (prevSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = prevSession;
      if (prevSlug === undefined) delete process.env.FLOW_SLUG;
      else process.env.FLOW_SLUG = prevSlug;
    }
  };

  it("heals a real v3 hook in place and commits a session-marked board on main", () => {
    withTempRepo((repoRoot) => {
      writeRealHook(repoRoot, LEGACY_HOOK_BODIES["base-branch"][2]);
      const writtenPath = path.join(repoRoot, ".flow/epics/e1/status.json");

      const result = withSessionMarkers(() =>
        commitEpicStatus({ writtenPath, epicSlug: "e1", cwd: repoRoot }),
      );

      expect(result.committed).toBe(true);
      expect(result.healedHook).toEqual({
        from: 3,
        to: BASE_BRANCH_GUARD_VERSION,
      });
      expect(fs.readFileSync(hookPath(repoRoot), "utf8")).toBe(
        BASE_BRANCH_GUARD_HOOK,
      );
    });
  });

  it("declines a hand-edited v3 hook (marker intact, custom lines appended) and leaves it byte-for-byte unchanged", () => {
    withTempRepo((repoRoot) => {
      const handEdited = `${LEGACY_HOOK_BODIES["base-branch"][2]}# custom line 1\n# custom line 2\n`;
      writeRealHook(repoRoot, handEdited);
      const writtenPath = path.join(repoRoot, ".flow/epics/e1/status.json");

      const result = withSessionMarkers(() =>
        commitEpicStatus({ writtenPath, epicSlug: "e1", cwd: repoRoot }),
      );

      // v3 has no status.json carve-out, so with both session markers set on
      // the default branch the hand-edited hook still refuses the commit —
      // proof the decline left the hook's actual behaviour untouched, not
      // just its bytes.
      expect(result.committed).toBe(false);
      expect(result.reason).toBe("commit-refused");
      expect(result.healedHook).toBeUndefined();
      expect(fs.readFileSync(hookPath(repoRoot), "utf8")).toBe(handEdited);
    });
  });

  it("never heals an absent hook (no pre-commit file at all)", () => {
    withTempRepo((repoRoot) => {
      const writtenPath = path.join(repoRoot, ".flow/epics/e1/status.json");
      const result = commitEpicStatus({
        writtenPath,
        epicSlug: "e1",
        cwd: repoRoot,
      });
      expect(result.committed).toBe(true);
      expect(result.healedHook).toBeUndefined();
      expect(fs.existsSync(hookPath(repoRoot))).toBe(false);
    });
  });

  it("board-vanished when the board is absent from both HEAD and disk", () => {
    withTempRepo((repoRoot) => {
      const writtenPath = path.join(repoRoot, ".flow/epics/e1/status.json");
      fs.rmSync(writtenPath); // simulate a stale run-state cache pointing at a since-removed board
      const result = commitEpicStatus({
        writtenPath,
        epicSlug: "e1",
        cwd: repoRoot,
      });
      expect(result).toEqual({ committed: false, reason: "board-vanished" });
    });
  });
});

describe("resolveContainedRepoRoot / foreign-repo containment", () => {
  it("commitEpicStatus refuses with foreign-repo and makes zero git calls when board and cwd are different repos", () => {
    withTwoTempRepos((repoA, repoB) => {
      const { git, calls } = makeGit(() => ({ exitCode: 0 }));
      const writtenPath = path.join(repoA, ".flow/epics/e1/status.json");
      const result = commitEpicStatus({
        writtenPath,
        epicSlug: "e1",
        cwd: repoB,
        git,
      });
      expect(result.committed).toBe(false);
      expect(result.reason).toBe("foreign-repo");
      expect(calls.some((c) => c[0] === "add" || c[0] === "commit")).toBe(
        false,
      );
    });
  });

  it("accepts a sibling git worktree of the same repo as the operator cwd (Q1 property)", () => {
    withTwoTempRepos((repoA, _repoB) => {
      fs.writeFileSync(path.join(repoA, "README.md"), "hello\n");
      spawnSync("git", ["add", "README.md"], { cwd: repoA });
      spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: repoA });
      const worktreeDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "flow-emc-wt-"),
      );
      fs.rmSync(worktreeDir, { recursive: true, force: true });
      spawnSync(
        "git",
        ["worktree", "add", "-b", "feature-branch", worktreeDir],
        { cwd: repoA },
      );
      try {
        const { git } = makeGit((argv) => {
          if (argv[0] === "status")
            return { stdout: " M .flow/epics/e1/status.json\n" };
          return { exitCode: 0 };
        });
        const writtenPath = path.join(repoA, ".flow/epics/e1/status.json");
        const result = commitEpicStatus({
          writtenPath,
          epicSlug: "e1",
          cwd: worktreeDir,
          git,
        });
        expect(result.committed).toBe(true);
      } finally {
        spawnSync("git", ["worktree", "remove", "--force", worktreeDir], {
          cwd: repoA,
        });
        fs.rmSync(worktreeDir, { recursive: true, force: true });
      }
    });
  });

  it("fails closed (foreign-repo) when cwd resolves to no repo at all", () => {
    withTwoTempRepos((repoA) => {
      const outside = fs.mkdtempSync(
        path.join(os.tmpdir(), "flow-emc-norepo-cwd-"),
      );
      try {
        const { git } = makeGit(() => ({ exitCode: 0 }));
        const writtenPath = path.join(repoA, ".flow/epics/e1/status.json");
        const result = resolveContainedRepoRoot({
          writtenPath,
          cwd: outside,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe("foreign-repo");

        const committed = commitEpicStatus({
          writtenPath,
          epicSlug: "e1",
          cwd: outside,
          git,
        });
        expect(committed).toEqual({
          committed: false,
          reason: "foreign-repo",
          detail: expect.any(String),
        });
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it("pushEpicStatusFromWrittenPath collapses a foreign board to pushed:false, reason:foreign-repo", () => {
    withTwoTempRepos((repoA, repoB) => {
      const { git } = makeGit(() => ({ exitCode: 0 }));
      const writtenPath = path.join(repoA, ".flow/epics/e1/status.json");
      const result = pushEpicStatusFromWrittenPath({
        writtenPath,
        cwd: repoB,
        git,
      });
      expect(result).toEqual({
        pushed: false,
        reason: "foreign-repo",
        detail: expect.any(String),
      });
    });
  });
});

describe("pushEpicStatus", () => {
  it("happy path: argv is EXACTLY the expected push argv", () => {
    const { git, calls } = makeGit((argv) => {
      if (argv[0] === "rev-parse") return { stdout: "main\n" };
      if (argv[0] === "symbolic-ref") return { stdout: "origin/main\n" };
      if (argv[0] === "remote") return { exitCode: 0 };
      if (argv.includes("ls-remote")) return { exitCode: 0 };
      if (argv.includes("push")) return { exitCode: 0 };
      return { exitCode: 0 };
    });
    const result = pushEpicStatus({ repoRoot: "/repo", git });
    expect(result).toEqual({ pushed: true });
    const pushCall = calls.find((c) => c.includes("push"));
    expect(pushCall).toEqual([
      "-c",
      "core.askPass=",
      "push",
      "origin",
      "HEAD:main",
    ]);
  });

  it("detached-head when rev-parse returns the literal HEAD", () => {
    const { git, calls } = makeGit((argv) => {
      if (argv[0] === "rev-parse") return { stdout: "HEAD\n" };
      return { exitCode: 0 };
    });
    const result = pushEpicStatus({ repoRoot: "/repo", git });
    expect(result).toEqual({ pushed: false, reason: "detached-head" });
    expect(calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("detached-head when rev-parse exits non-zero", () => {
    const { git, calls } = makeGit((argv) => {
      if (argv[0] === "rev-parse") return { exitCode: 1 };
      return { exitCode: 0 };
    });
    const result = pushEpicStatus({ repoRoot: "/repo", git });
    expect(result).toEqual({ pushed: false, reason: "detached-head" });
    expect(calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("not-base-branch when the current branch differs from the default", () => {
    const { git, calls } = makeGit((argv) => {
      if (argv[0] === "rev-parse") return { stdout: "feat/x\n" };
      if (argv[0] === "symbolic-ref") return { stdout: "origin/main\n" };
      return { exitCode: 0 };
    });
    const result = pushEpicStatus({ repoRoot: "/repo", git });
    expect(result).toEqual({ pushed: false, reason: "not-base-branch" });
    expect(calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("no-remote when `remote get-url origin` fails", () => {
    const { git, calls } = makeGit((argv) => {
      if (argv[0] === "rev-parse") return { stdout: "main\n" };
      if (argv[0] === "symbolic-ref") return { stdout: "origin/main\n" };
      if (argv[0] === "remote") return { exitCode: 1 };
      return { exitCode: 0 };
    });
    const result = pushEpicStatus({ repoRoot: "/repo", git });
    expect(result).toEqual({ pushed: false, reason: "no-remote" });
    expect(calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("no-remote-branch when ls-remote reports the branch absent", () => {
    const { git, calls } = makeGit((argv) => {
      if (argv[0] === "rev-parse") return { stdout: "main\n" };
      if (argv[0] === "symbolic-ref") return { stdout: "origin/main\n" };
      if (argv[0] === "remote") return { exitCode: 0 };
      if (argv.includes("ls-remote")) return { exitCode: 1 };
      return { exitCode: 0 };
    });
    const result = pushEpicStatus({ repoRoot: "/repo", git });
    expect(result).toEqual({ pushed: false, reason: "no-remote-branch" });
    expect(calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("non-fast-forward when the push stderr matches the non-fast-forward signature", () => {
    const { git } = makeGit((argv) => {
      if (argv[0] === "rev-parse") return { stdout: "main\n" };
      if (argv[0] === "symbolic-ref") return { stdout: "origin/main\n" };
      if (argv[0] === "remote") return { exitCode: 0 };
      if (argv.includes("ls-remote")) return { exitCode: 0 };
      if (argv.includes("push")) {
        return {
          exitCode: 1,
          stderr: "! [rejected] main -> main (non-fast-forward)\n",
        };
      }
      return { exitCode: 0 };
    });
    const result = pushEpicStatus({ repoRoot: "/repo", git });
    expect(result.pushed).toBe(false);
    expect(result.reason).toBe("non-fast-forward");
  });

  it("push-failed on a generic push stderr", () => {
    const { git } = makeGit((argv) => {
      if (argv[0] === "rev-parse") return { stdout: "main\n" };
      if (argv[0] === "symbolic-ref") return { stdout: "origin/main\n" };
      if (argv[0] === "remote") return { exitCode: 0 };
      if (argv.includes("ls-remote")) return { exitCode: 0 };
      if (argv.includes("push"))
        return { exitCode: 1, stderr: "fatal: unable to access\n" };
      return { exitCode: 0 };
    });
    const result = pushEpicStatus({ repoRoot: "/repo", git });
    expect(result.pushed).toBe(false);
    expect(result.reason).toBe("push-failed");
  });

  it("extra-local-commits when HEAD carries non-board changes beyond the remote SHA — never publishes them", () => {
    const { git, calls } = makeGit((argv) => {
      if (argv[0] === "rev-parse") return { stdout: "main\n" };
      if (argv[0] === "symbolic-ref") return { stdout: "origin/main\n" };
      if (argv[0] === "remote") return { exitCode: 0 };
      if (argv.includes("ls-remote"))
        return { stdout: "abc123\trefs/heads/main\n", exitCode: 0 };
      if (argv[0] === "diff")
        return { stdout: "src/index.ts\n.flow/epics/e1/status.json\n" };
      return { exitCode: 0 };
    });
    const result = pushEpicStatus({ repoRoot: "/repo", git });
    expect(result).toEqual({ pushed: false, reason: "extra-local-commits" });
    expect(calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("pushes when HEAD's delta beyond the remote SHA is board-only", () => {
    const { git, calls } = makeGit((argv) => {
      if (argv[0] === "rev-parse") return { stdout: "main\n" };
      if (argv[0] === "symbolic-ref") return { stdout: "origin/main\n" };
      if (argv[0] === "remote") return { exitCode: 0 };
      if (argv.includes("ls-remote"))
        return { stdout: "abc123\trefs/heads/main\n", exitCode: 0 };
      if (argv[0] === "diff") return { stdout: ".flow/epics/e1/status.json\n" };
      if (argv.includes("push")) return { exitCode: 0 };
      return { exitCode: 0 };
    });
    const result = pushEpicStatus({ repoRoot: "/repo", git });
    expect(result).toEqual({ pushed: true });
    expect(calls.some((c) => c.includes("push"))).toBe(true);
  });
});

describe("forbidden argv pin", () => {
  it("no argv emitted by commitEpicStatus or pushEpicStatus ever contains a forcing/publishing flag — and the commit half is NOT vacuous", () => {
    withTempRepo((repoRoot) => {
      const allCalls: string[][] = [];
      const record = (argv: string[]): Resp => {
        allCalls.push(argv);
        if (argv[0] === "status")
          return { stdout: " M .flow/epics/e1/status.json\n" };
        if (argv[0] === "rev-parse") return { stdout: "main\n" };
        if (argv[0] === "symbolic-ref") return { stdout: "origin/main\n" };
        return { exitCode: 0 };
      };
      const git: GitRunner = (argv) => {
        const r = record(argv);
        return {
          stdout: r.stdout ?? "",
          stderr: r.stderr ?? "",
          exitCode: r.exitCode ?? 0,
        };
      };

      const commitResult = commitEpicStatus({
        writtenPath: path.join(repoRoot, ".flow/epics/e1/status.json"),
        epicSlug: "e1",
        cwd: repoRoot,
        git,
      });
      // Prove this test is NOT vacuously green: commitEpicStatus must have
      // actually reached and recorded a commit call, not bailed early
      // (e.g. "not-a-repo") before ever touching git.
      expect(commitResult.committed).toBe(true);
      expect(allCalls.some((c) => c[0] === "commit")).toBe(true);

      pushEpicStatus({ repoRoot: "/repo", git });

      const forbidden = [
        "--force",
        "--force-with-lease",
        "-f",
        "-u",
        "--set-upstream",
        "--no-verify",
      ];
      for (const argv of allCalls) {
        for (const flag of forbidden) {
          expect(argv).not.toContain(flag);
        }
      }
    });
  });
});

describe("dirtyEpicMetadata", () => {
  it("parses staged, unstaged, untracked, and a rename (post-arrow path returned)", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-emc-dirty-"));
    try {
      fs.mkdirSync(path.join(repoRoot, ".flow/epics/e1"), { recursive: true });
      const { git } = makeGit((argv) => {
        if (argv[0] === "status") {
          return {
            stdout:
              [
                "M  .flow/epics/e1/status.json",
                " M .flow/epics/e2/status.json",
                "?? .flow/epics/e3/status.json",
                "R  .flow/epics/e1/old.json -> .flow/epics/e1/new.json",
              ].join("\n") + "\n",
          };
        }
        return { exitCode: 0 };
      });
      const result = dirtyEpicMetadata({ repoRoot, git });
      expect(result).toEqual([
        ".flow/epics/e1/status.json",
        ".flow/epics/e2/status.json",
        ".flow/epics/e3/status.json",
        ".flow/epics/e1/new.json",
      ]);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("real git: a brand-new untracked epic directory reports per-file entries, not one collapsed directory line", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-emc-untr-"));
    try {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
      fs.writeFileSync(path.join(repoRoot, "README.md"), "x\n", "utf8");
      spawnSync("git", ["add", "-A"], { cwd: repoRoot });
      spawnSync("git", ["config", "user.email", "t@example.com"], {
        cwd: repoRoot,
      });
      spawnSync("git", ["config", "user.name", "Flow Test"], {
        cwd: repoRoot,
      });
      spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd: repoRoot });
      fs.mkdirSync(path.join(repoRoot, ".flow/epics/new-epic"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(repoRoot, ".flow/epics/new-epic/status.json"),
        "{}\n",
        "utf8",
      );
      fs.writeFileSync(
        path.join(repoRoot, ".flow/epics/new-epic/manifest.json"),
        "{}\n",
        "utf8",
      );
      const result = dirtyEpicMetadata({ repoRoot });
      expect(result).toEqual(
        expect.arrayContaining([
          ".flow/epics/new-epic/status.json",
          ".flow/epics/new-epic/manifest.json",
        ]),
      );
      expect(result).not.toContain(".flow/epics/new-epic/");
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("returns [] on non-zero exit", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-emc-dirty2-"));
    try {
      fs.mkdirSync(path.join(repoRoot, ".flow/epics"), { recursive: true });
      const { git } = makeGit(() => ({ exitCode: 1 }));
      expect(dirtyEpicMetadata({ repoRoot, git })).toEqual([]);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("returns [] on a thrown runner", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-emc-dirty3-"));
    try {
      fs.mkdirSync(path.join(repoRoot, ".flow/epics"), { recursive: true });
      const git: GitRunner = () => {
        throw new Error("boom");
      };
      expect(dirtyEpicMetadata({ repoRoot, git })).toEqual([]);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("returns [] when the epics dir does not exist (zero-cost, no git spawn)", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-emc-dirty4-"));
    try {
      const { git, calls } = makeGit(() => ({ exitCode: 0 }));
      expect(dirtyEpicMetadata({ repoRoot, git })).toEqual([]);
      expect(calls.length).toBe(0);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("repoCommitState", () => {
  it("clean by default", () => {
    const { git } = makeGit((argv) => {
      if (argv[0] === "rev-parse") return { stdout: ".git\n" };
      if (argv[0] === "symbolic-ref") return { exitCode: 0 };
      return { exitCode: 0 };
    });
    expect(repoCommitState({ repoRoot: "/repo", git })).toBe("clean");
  });

  it("detached when symbolic-ref exits non-zero", () => {
    const { git } = makeGit((argv) => {
      if (argv[0] === "rev-parse") return { stdout: ".git\n" };
      if (argv[0] === "symbolic-ref") return { exitCode: 1 };
      return { exitCode: 0 };
    });
    expect(repoCommitState({ repoRoot: "/repo", git })).toBe("detached");
  });

  it("rebase when .git/rebase-merge exists", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-emc-rebase-"));
    try {
      fs.mkdirSync(path.join(repoRoot, ".git", "rebase-merge"), {
        recursive: true,
      });
      const { git } = makeGit((argv) => {
        if (argv[0] === "rev-parse") return { stdout: ".git\n" };
        return { exitCode: 0 };
      });
      expect(repoCommitState({ repoRoot, git })).toBe("rebase");
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("merge when .git/MERGE_HEAD exists", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-emc-merge-"));
    try {
      fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
      fs.writeFileSync(
        path.join(repoRoot, ".git", "MERGE_HEAD"),
        "sha\n",
        "utf8",
      );
      const { git } = makeGit((argv) => {
        if (argv[0] === "rev-parse") return { stdout: ".git\n" };
        return { exitCode: 0 };
      });
      expect(repoCommitState({ repoRoot, git })).toBe("merge");
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
