import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PipelineState } from "./state";
import {
  discoverFlowRepos,
  gatherWorktreeFacts,
  type FactDeps,
  type RunResult,
  type SweepRun,
} from "./worktree-sweep-facts";
import type { UsageIndex } from "./worktree-sweep-usage";

const OK = (stdout = ""): RunResult => ({
  status: 0,
  stdout,
  stderr: "",
  timedOut: false,
});
const EXIT = (status: number): RunResult => ({
  status,
  stdout: "",
  stderr: "",
  timedOut: false,
});
const TIMEOUT: RunResult = {
  status: null,
  stdout: "",
  stderr: "",
  timedOut: true,
};

type Handler = (
  cmd: string,
  args: string[],
  cwd?: string,
) => RunResult | undefined;

let tmp: string;
let calls: string[];

function makeRun(...handlers: Handler[]): SweepRun {
  return (cmd, args, opts) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    for (const h of handlers) {
      const r = h(cmd, args, opts.cwd);
      if (r) return r;
    }
    return OK();
  };
}

const NO_USAGE: UsageIndex = {
  processesInside: () => [],
  containersMounting: () => [],
  containersUnknown: false,
  mounts: [],
};

function deps(run: SweepRun, over: Partial<FactDeps> = {}): FactDeps {
  return {
    run,
    listStates: () => [],
    liveness: () => "stale",
    windowOpen: () => false,
    cwd: tmp,
    nowMs: () => 1000,
    flowSourcePaths: [],
    listProcs: () => [],
    readCwds: () => new Map(),
    selfPids: [process.pid],
    ...over,
  };
}

function mkdir(...p: string[]): string {
  const dir = path.join(tmp, ...p);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function list(...paths: Array<{ p: string; extra?: string[] }>): string {
  return paths
    .map(({ p, extra }) =>
      ["worktree " + p, "HEAD abc", ...(extra ?? []), ""].join("\n"),
    )
    .join("\n");
}

const prJson = (rows: unknown[]) => OK(JSON.stringify(rows));

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sweep-facts-")));
  calls = [];
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("discoverFlowRepos", () => {
  function fingerprint(dir: string, lines: string[]): void {
    fs.mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".git", "info", "exclude"),
      lines.join("\n"),
    );
  }

  it("unions the launching repo, record repos and flow-fingerprinted siblings", () => {
    const alpha = mkdir("alpha");
    const beta = mkdir("beta");
    const gamma = mkdir("gamma");
    const wt = mkdir("alpha-wt");
    const recorded = mkdir("elsewhere", "rec");
    fingerprint(alpha, [
      ".flow-branch",
      ".flow-tmp/",
      ".claude/agent-memory-local",
    ]);
    fingerprint(beta, [
      ".flow-branch",
      ".flow-tmp/",
      ".claude/agent-memory-local",
    ]);
    fingerprint(gamma, ["node_modules"]);
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: x");
    const run = makeRun((cmd, args, cwd) =>
      cwd ? OK(list({ p: cwd })) : undefined,
    );
    const states = [
      { slug: "r", phase: "merged", repo: recorded },
    ] as PipelineState[];

    const repos = discoverFlowRepos(
      deps(run, { cwd: alpha, listStates: () => states }),
    );

    expect(repos.sort()).toEqual([alpha, beta, recorded].sort());
  });

  it("skips a repo whose worktree list fails", () => {
    const run = makeRun(() => EXIT(128));
    expect(discoverFlowRepos(deps(run, { cwd: mkdir("dead") }))).toEqual([]);
  });
});

describe("gatherWorktreeFacts", () => {
  const repoPath = () => path.join(tmp, "repo");
  let wtA: string;
  let wtB: string;

  beforeEach(() => {
    mkdir("repo");
    wtA = mkdir("repo-a");
    wtB = mkdir("repo-b");
  });

  function git(over: {
    worktrees?: string;
    status?: RunResult;
    ancestorMain?: RunResult;
    ancestorPr?: RunResult[];
    gh?: RunResult;
  }): Handler[] {
    const pr = [...(over.ancestorPr ?? [OK()])];
    return [
      (cmd, args) =>
        cmd === "git" && args[0] === "worktree"
          ? OK(
              over.worktrees ??
                list(
                  { p: repoPath() },
                  { p: wtA, extra: ["branch refs/heads/a"] },
                ),
            )
          : undefined,
      (cmd, args) =>
        cmd === "git" && args[0] === "symbolic-ref"
          ? OK("refs/remotes/origin/main\n")
          : undefined,
      (cmd, args) => (cmd === "gh" ? (over.gh ?? prJson([])) : undefined),
      (cmd, args) =>
        cmd === "git" && args[0] === "status"
          ? (over.status ?? OK(""))
          : undefined,
      (cmd, args) =>
        cmd === "git" && args[0] === "merge-base"
          ? args[3] === "origin/main"
            ? (over.ancestorMain ?? EXIT(1))
            : pr.length > 1
              ? pr.shift()
              : pr[0]
          : undefined,
      (cmd, args) =>
        cmd === "git" && args[0] === "check-ignore" ? EXIT(1) : undefined,
    ];
  }

  const merged = (branch: string, n = 5) => ({
    number: n,
    state: "MERGED",
    headRefName: branch,
    headRefOid: "deadbeef",
  });

  it("marks a squash-merged folder contained via the PR head and calls gh once per repo", () => {
    const worktrees = list(
      { p: repoPath() },
      { p: wtA, extra: ["branch refs/heads/a"] },
      { p: wtB, extra: ["branch refs/heads/b"] },
    );
    const run = makeRun(
      ...git({ worktrees, gh: prJson([merged("a"), merged("b", 6)]) }),
    );

    const facts = gatherWorktreeFacts(repoPath(), deps(run), NO_USAGE, 9999);

    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({
      path: wtA,
      branch: "a",
      dirty: false,
      headContained: true,
      localConfigDiffers: false,
      prs: [{ number: 5, state: "MERGED", headOid: "deadbeef" }],
    });
    expect(calls.filter((c) => c.startsWith("gh "))).toHaveLength(1);
  });

  it("uses the origin/<default> ancestor as the fast path without touching the PR head", () => {
    const run = makeRun(
      ...git({ gh: prJson([merged("a")]), ancestorMain: OK() }),
    );
    gatherWorktreeFacts(repoPath(), deps(run), NO_USAGE, 9999);
    expect(calls.some((c) => c.includes("deadbeef"))).toBe(false);
  });

  it("fetches the PR head once when the commit is missing locally", () => {
    const run = makeRun(
      ...git({ gh: prJson([merged("a")]), ancestorPr: [EXIT(128), OK()] }),
    );
    const [f] = gatherWorktreeFacts(repoPath(), deps(run), NO_USAGE, 9999);
    expect(f.headContained).toBe(true);
    expect(
      calls.filter((c) => c.includes("fetch --quiet origin refs/pull/5/head")),
    ).toHaveLength(1);
  });

  it("reports unknown containment when the fetch fails", () => {
    const run = makeRun(
      (cmd, args) => (args[0] === "fetch" ? EXIT(1) : undefined),
      ...git({ gh: prJson([merged("a")]), ancestorPr: [EXIT(128)] }),
    );
    expect(
      gatherWorktreeFacts(repoPath(), deps(run), NO_USAGE, 9999)[0]
        .headContained,
    ).toBe("unknown");
  });

  it("reports not-contained when the local HEAD is ahead of the PR head", () => {
    const run = makeRun(
      ...git({ gh: prJson([merged("a")]), ancestorPr: [EXIT(1)] }),
    );
    expect(
      gatherWorktreeFacts(repoPath(), deps(run), NO_USAGE, 9999)[0]
        .headContained,
    ).toBe(false);
  });

  it("treats a branch absent from the listing as having no PR", () => {
    const run = makeRun(...git({ gh: prJson([merged("other")]) }));
    expect(
      gatherWorktreeFacts(repoPath(), deps(run), NO_USAGE, 9999)[0].prs,
    ).toEqual([]);
  });

  it("marks every folder unreachable when the gh listing times out", () => {
    const run = makeRun(...git({ gh: TIMEOUT }));
    const [f] = gatherWorktreeFacts(repoPath(), deps(run), NO_USAGE, 9999);
    expect(f.prs).toBe("unreachable");
    expect(f.dirty).toBe("unknown");
  });

  it("flags a real .env.local that differs from the main checkout", () => {
    fs.writeFileSync(path.join(wtA, ".env.local"), "SECRET=1");
    fs.writeFileSync(path.join(repoPath(), ".env.local"), "SECRET=2");
    const run = makeRun(
      (cmd, args) => (args[0] === "check-ignore" ? OK() : undefined),
      ...git({ gh: prJson([merged("a")]) }),
    );
    expect(
      gatherWorktreeFacts(repoPath(), deps(run), NO_USAGE, 9999)[0]
        .localConfigDiffers,
    ).toBe(true);
  });

  it("does not flag a symlinked .env or an identical real file", () => {
    fs.writeFileSync(path.join(repoPath(), ".env"), "A=1");
    fs.symlinkSync(path.join(repoPath(), ".env"), path.join(wtA, ".env"));
    fs.writeFileSync(path.join(wtA, ".env.local"), "SAME");
    fs.writeFileSync(path.join(repoPath(), ".env.local"), "SAME");
    const run = makeRun(
      (cmd, args) => (args[0] === "check-ignore" ? OK() : undefined),
      ...git({ gh: prJson([merged("a")]) }),
    );
    expect(
      gatherWorktreeFacts(repoPath(), deps(run), NO_USAGE, 9999)[0]
        .localConfigDiffers,
    ).toBe(false);
  });

  it("includes unmarked folders, reports locked and detached entries, and skips prunable and bare ones", () => {
    const gone = path.join(tmp, "repo-gone");
    const worktrees = list(
      { p: repoPath() },
      { p: wtA, extra: ["detached", "locked reason"] },
      { p: gone, extra: ["branch refs/heads/g", "prunable gitdir missing"] },
      { p: wtB, extra: ["bare"] },
    );
    const run = makeRun(...git({ worktrees }));
    const facts = gatherWorktreeFacts(repoPath(), deps(run), NO_USAGE, 9999);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      path: wtA,
      locked: true,
      branch: undefined,
    });
  });

  it("attaches owners by canonical worktree or reserved path with liveness and window state", () => {
    const states = [
      { slug: "mine", phase: "implementing", repo: repoPath(), worktree: wtA },
      { slug: "other", phase: "implementing", repo: repoPath(), worktree: wtB },
    ] as PipelineState[];
    const run = makeRun(...git({ gh: prJson([merged("a")]) }));
    const [f] = gatherWorktreeFacts(
      repoPath(),
      deps(run, {
        listStates: () => states,
        liveness: () => "alive",
        windowOpen: (s) => s === "mine",
      }),
      NO_USAGE,
      9999,
    );
    expect(f.owners).toEqual([
      {
        slug: "mine",
        phase: "implementing",
        liveness: "alive",
        windowOpen: true,
      },
    ]);
  });

  it("flags the worktree that contains the running flow checkout", () => {
    const run = makeRun(...git({ gh: prJson([merged("a")]) }));
    const [f] = gatherWorktreeFacts(
      repoPath(),
      deps(run, { flowSourcePaths: [path.join(wtA, "nested")] }),
      NO_USAGE,
      9999,
    );
    expect(f.isFlowSource).toBe(true);
  });

  it("asks git for untracked files regardless of the user's status.showUntrackedFiles", () => {
    const run = makeRun(...git({ gh: prJson([merged("a")]) }));
    gatherWorktreeFacts(repoPath(), deps(run), NO_USAGE, 9999);
    const status = calls.find((c) => c.startsWith("git status"));
    expect(status).toContain("--untracked-files=normal");
    expect(status).toContain("--ignore-submodules=none");
  });

  it("ignores a fork PR that shares the branch name", () => {
    const fork = { ...merged("a"), isCrossRepository: true };
    const run = makeRun(...git({ gh: prJson([fork]) }));
    const [f] = gatherWorktreeFacts(repoPath(), deps(run), NO_USAGE, 9999);
    expect(f.prs).toEqual([]);
    expect(
      calls.find((c) => c.startsWith("gh "))?.includes("isCrossRepository"),
    ).toBe(true);
  });

  it("carries live processes and container mounts for the folder", () => {
    const run = makeRun(...git({ gh: prJson([merged("a")]) }));
    const usage: UsageIndex = {
      ...NO_USAGE,
      processesInside: (p) => (p === wtA ? [{ pid: 7, command: "vite" }] : []),
      containersMounting: (p) => (p === wtA ? ["supabase_db"] : []),
    };
    const [f] = gatherWorktreeFacts(repoPath(), deps(run), usage, 9999);
    expect(f.processesInside).toEqual([{ pid: 7, command: "vite" }]);
    expect(f.containersMounting).toEqual(["supabase_db"]);
  });

  it("fails closed when Docker could not be checked", () => {
    const run = makeRun(...git({ gh: prJson([merged("a")]) }));
    const usage: UsageIndex = { ...NO_USAGE, containersUnknown: true };
    const [f] = gatherWorktreeFacts(repoPath(), deps(run), usage, 9999);
    expect(f.containersMounting).toBe("unknown");
  });

  it("flags the folder the sweep was launched from, including from a subfolder", () => {
    const run = makeRun(...git({ gh: prJson([merged("a")]) }));
    const sub = mkdir("repo-a", "src");
    const [here] = gatherWorktreeFacts(
      repoPath(),
      deps(run, { cwd: sub }),
      NO_USAGE,
      9999,
    );
    const [elsewhere] = gatherWorktreeFacts(
      repoPath(),
      deps(run, { cwd: repoPath() }),
      NO_USAGE,
      9999,
    );
    expect(here.containsLaunchDir).toBe(true);
    expect(elsewhere.containsLaunchDir).toBe(false);
  });

  it("skips the slow per-folder checks once the deadline has passed", () => {
    const run = makeRun(...git({ gh: prJson([merged("a")]) }));
    const [f] = gatherWorktreeFacts(
      repoPath(),
      deps(run, { nowMs: () => 5000 }),
      NO_USAGE,
      1000,
    );
    expect(f.deadlineReached).toBe(true);
    expect(calls.some((c) => /^git (status|merge-base|fetch)/.test(c))).toBe(
      false,
    );
  });

  it("fails closed when the process table was unreadable and carries the deadline", () => {
    const run = makeRun(...git({ gh: prJson([merged("a")]) }));
    const usage: UsageIndex = {
      ...NO_USAGE,
      processesSkipped: "ps-unavailable",
    };
    const [f] = gatherWorktreeFacts(
      repoPath(),
      deps(run, { nowMs: () => 5000 }),
      usage,
      1000,
    );
    expect(f.processesInside).toBe("unknown");
    expect(f.deadlineReached).toBe(true);
  });
});
