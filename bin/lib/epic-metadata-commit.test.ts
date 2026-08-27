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
  repoCommitState,
  type GitRunner,
} from "./epic-metadata-commit";

type Resp = { stdout?: string; stderr?: string; exitCode?: number };

// `commitEpicStatus` resolves the repo root via a REAL `git rev-parse
// --show-toplevel` (not through the injected GitRunner), so the directory
// dirname(writtenPath) must exist on disk inside a real git repo — only the
// status/add/commit calls themselves are faked.
function withTempRepo<T>(run: (repoRoot: string) => T): T {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-emc-repo-"));
  try {
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
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
      const result = commitEpicStatus({ writtenPath, epicSlug: "e1", git });
      expect(result).toEqual({ committed: true });

      const commitCall = calls.find((c) => c[0] === "commit");
      expect(commitCall).toBeDefined();
      expect(commitCall).toContain("--");
      expect(commitCall).toContain(".flow/epics/e1/status.json");
      // Pins the path-scoped requirement: every "add" call in `calls` must
      // be scoped to the rel path (never a bare whole-index `git add`).
      for (const c of calls) {
        if (c[0] === "add") expect(c).toContain(".flow/epics/e1/status.json");
      }
    });
  });

  it("nothing-staged when the status probe returns empty stdout", () => {
    withTempRepo((repoRoot) => {
      const { git, calls } = makeGit((argv) => {
        if (argv[0] === "status") return { stdout: "" };
        return { exitCode: 0 };
      });
      const writtenPath = path.join(repoRoot, ".flow/epics/e1/status.json");
      const result = commitEpicStatus({ writtenPath, epicSlug: "e1", git });
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
      const result = commitEpicStatus({ writtenPath, epicSlug: "e1", git });
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
        git,
      });
      expect(result).toEqual({ committed: false, reason: "not-a-repo" });
      expect(calls.some((c) => c[0] === "commit")).toBe(false);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });
});

describe("pushEpicStatus", () => {
  it("happy path: argv is EXACTLY the expected push argv", () => {
    const { git, calls } = makeGit((argv) => {
      if (argv[0] === "rev-parse") return { stdout: "main\n" };
      if (argv[0] === "symbolic-ref") return { stdout: "origin/main\n" };
      if (argv[0] === "remote") return { exitCode: 0 };
      if (argv[0] === "ls-remote") return { exitCode: 0 };
      if (argv.includes("push")) return { exitCode: 0 };
      return { exitCode: 0 };
    });
    const result = pushEpicStatus({ repoRoot: "/repo", git });
    expect(result).toEqual({ pushed: true });
    const pushCall = calls.find((c) => c.includes("push"));
    expect(pushCall).toEqual([
      "-c",
      "core.askPass=",
      "-c",
      "credential.helper=",
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
      if (argv[0] === "ls-remote") return { exitCode: 1 };
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
      if (argv[0] === "ls-remote") return { exitCode: 0 };
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
      if (argv[0] === "ls-remote") return { exitCode: 0 };
      if (argv.includes("push"))
        return { exitCode: 1, stderr: "fatal: unable to access\n" };
      return { exitCode: 0 };
    });
    const result = pushEpicStatus({ repoRoot: "/repo", git });
    expect(result.pushed).toBe(false);
    expect(result.reason).toBe("push-failed");
  });
});

describe("forbidden argv pin", () => {
  it("no argv emitted by commitEpicStatus or pushEpicStatus ever contains a forcing/publishing flag", () => {
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

    commitEpicStatus({
      writtenPath: path.join(process.cwd(), ".flow/epics/e1/status.json"),
      epicSlug: "e1",
      git,
    });
    pushEpicStatus({ repoRoot: "/repo", git });

    const forbidden = [
      "--force",
      "--force-with-lease",
      "-f",
      "-u",
      "--set-upstream",
    ];
    for (const argv of allCalls) {
      for (const flag of forbidden) {
        expect(argv).not.toContain(flag);
      }
    }
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
