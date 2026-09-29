import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultDoctorDeps } from "./doctor";
import {
  checkLeakedProcesses,
  checkPipelineState,
  checkStaleWorktrees,
} from "./doctor-resources";
import { makeDeps, scriptedRun, type RunCall } from "./doctor-test-deps";
import type { ReapCliResult } from "./reap-cli";
import type { PipelineState } from "./state";

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doctor-res-")));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function makeRepo(name: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  return repo;
}

function addWorktree(repo: string, name: string, marker: boolean): string {
  const wt = path.join(root, name);
  git(repo, "worktree", "add", "-q", "-b", name, wt);
  if (marker) fs.writeFileSync(path.join(wt, ".flow-branch"), `${name}\n`);
  return wt;
}

function state(over: Partial<PipelineState>): PipelineState {
  return {
    slug: "s",
    phase: "implementing",
    repo: "/nowhere",
    updatedAt: "2023-11-14T00:00:00.000Z",
    ...over,
  } as PipelineState;
}

const realRun = () => makeDeps(root, { run: defaultDoctorDeps().run });

describe("checkStaleWorktrees", () => {
  it("lists marker-bearing worktrees of merged or state-less pipelines only", () => {
    const repo = makeRepo("repo");
    const states: PipelineState[] = [];
    const wts: Record<string, string> = {};
    for (const phase of [
      "merged",
      "cancelled",
      "implementing",
      "paused",
      "gated",
      "needs-human",
      "epic-approved",
    ]) {
      wts[phase] = addWorktree(repo, `wt-${phase}`, true);
      states.push(
        state({ slug: `p-${phase}`, phase, repo, worktree: wts[phase] }),
      );
    }
    const stateless = addWorktree(repo, "wt-stateless", true);
    addWorktree(repo, "wt-unmarked", false);

    const out = checkStaleWorktrees(realRun(), { listStates: () => states });
    const listed = out.map((c) => c.details[0]).sort();
    expect(listed).toEqual([wts.cancelled, wts.merged, stateless].sort());
    for (const c of out) {
      expect(c.status).toBe("warn");
      expect(c.fix).toBe(`cd ${repo} && flow-remove-worktree ${c.details[0]}`);
      expect(c.details[1]).toContain("may delete its branch");
      expect(c.details[1]).toContain("refuses");
    }
  });

  it("passes on a clean repo and scans a repo shared by several states once", () => {
    const repo = makeRepo("repo");
    const calls: RunCall[] = [];
    const real = defaultDoctorDeps().run;
    const deps = makeDeps(root, {
      run: (cmd, args, opts) => {
        calls.push({ cmd, args });
        return real(cmd, args, opts);
      },
    });
    const out = checkStaleWorktrees(deps, {
      listStates: () => [
        state({ slug: "a", repo }),
        state({ slug: "b", repo }),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("pass");
    expect(calls.filter((c) => c.args.includes("worktree")).length).toBe(1);
  });

  it("dedupes a repo reached both by state.repo and by a linked worktree of it", () => {
    const repo = makeRepo("repo");
    const wt = addWorktree(repo, "wt-x", true);
    const out = checkStaleWorktrees(realRun(), {
      listStates: () => [
        state({ slug: "a", repo, worktree: wt }),
        state({ slug: "b", repo: wt }),
      ],
    });
    expect(out.every((c) => c.status === "pass")).toBe(true);
  });

  it("scans the cwd's repo even when no state records it", () => {
    const repo = makeRepo("repo");
    const stale = addWorktree(repo, "wt-orphan", true);
    const deps = { ...realRun(), cwd: repo };
    const out = checkStaleWorktrees(deps, { listStates: () => [] });
    expect(out.map((c) => c.details[0])).toEqual([stale]);
  });

  it("reports a vanished repo as one 'could not inspect' warn and does not throw", () => {
    const gone = path.join(root, "gone-repo");
    const out = checkStaleWorktrees(realRun(), {
      listStates: () => [state({ slug: "old", repo: gone })],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      status: "warn",
      summary: `could not inspect repo at ${gone}`,
      fix: "flow done old",
    });
  });

  it("reports a non-zero or timed-out git worktree list as 'could not inspect' and continues", () => {
    const repo = makeRepo("repo");
    for (const res of [{ status: 128 }, { status: null, timedOut: true }]) {
      const out = checkStaleWorktrees(
        makeDeps(root, { run: scriptedRun(() => res) }),
        { listStates: () => [state({ repo })] },
      );
      expect(out).toHaveLength(1);
      expect(out[0].summary).toContain("could not inspect repo at");
    }
  });
});

describe("checkPipelineState", () => {
  const noWindows = () => [];

  it("warns per unresumable pipeline: unfinished, worktree recorded, directory missing", () => {
    const live = path.join(root, "live-wt");
    fs.mkdirSync(live);
    const out = checkPipelineState(makeDeps(root), {
      listStates: () => [
        state({
          slug: "lost",
          phase: "implementing",
          worktree: path.join(root, "missing"),
        }),
        state({ slug: "here", phase: "implementing", worktree: live }),
        state({
          slug: "done",
          phase: "merged",
          worktree: path.join(root, "gone-too"),
        }),
        state({
          slug: "epic",
          phase: "epic-approved",
          worktree: path.join(root, "gone-3"),
        }),
      ],
      listWindows: noWindows,
    });
    const warns = out.filter((c) => c.id.startsWith("leftovers-unresumable:"));
    expect(warns.map((c) => c.id)).toEqual(["leftovers-unresumable:lost"]);
    expect(warns[0].fix).toBe("flow done lost");
    expect(warns[0].details.join(" ")).toContain("can no longer be resumed");
  });

  it("counts only merged/cancelled records as unclosed, with flow done --merged", () => {
    const out = checkPipelineState(makeDeps(root), {
      listStates: () => [
        state({ slug: "a", phase: "merged" }),
        state({ slug: "b", phase: "cancelled" }),
        state({ slug: "c", phase: "epic-approved" }),
      ],
      listWindows: noWindows,
    });
    const c = out.find((x) => x.id === "leftovers-unclosed")!;
    expect(c.status).toBe("warn");
    expect(c.summary).toContain("2 merged or cancelled");
    expect(c.fix).toBe("flow done --merged");
  });

  it("warns per never-started orphan past the grace window with flow done <slug>", () => {
    const deps = makeDeps(root);
    const fresh = new Date(deps.nowMs() - 5_000).toISOString();
    const out = checkPipelineState(deps, {
      listStates: () => [
        state({ slug: "stuck", phase: "starting" }),
        state({ slug: "cold-start", phase: "starting", updatedAt: fresh }),
      ],
      listWindows: noWindows,
    });
    const warns = out.filter((c) =>
      c.id.startsWith("leftovers-never-started:"),
    );
    expect(warns.map((c) => c.fix)).toEqual(["flow done stuck"]);
  });

  it("never marks a live pipeline dead for having no tmux window", () => {
    const wt = path.join(root, "wt");
    fs.mkdirSync(wt);
    const out = checkPipelineState(makeDeps(root), {
      listStates: () => [
        state({ slug: "running", phase: "implementing", worktree: wt }),
        state({ slug: "waiting", phase: "gated", worktree: wt }),
      ],
      listWindows: noWindows,
    });
    expect(out.every((c) => c.status === "pass")).toBe(true);
  });

  it("reads states from deps.stateDir by default", () => {
    const dir = path.join(root, "home", ".flow", "state");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "old-one.json"),
      JSON.stringify(state({ slug: "old-one", phase: "merged" })),
    );
    const out = checkPipelineState(makeDeps(root), { listWindows: noWindows });
    expect(out.find((c) => c.id === "leftovers-unclosed")?.status).toBe("warn");
  });
});

describe("checkLeakedProcesses", () => {
  const report = (over: Partial<ReapCliResult>): ReapCliResult =>
    ({
      mode: "reap",
      yes: false,
      includeStrays: false,
      registry: { mode: "sweep", yes: false, slugs: [] },
      heuristic: { ran: true, found: [], foundServers: [], signalled: [] },
      ...over,
    }) as unknown as ReapCliResult;

  const slugRow = (
    slug: string,
    dead: number,
    skipped?: "deadline-exceeded",
  ) => ({
    slug,
    reported: { dead, alive: 0, unknown: 0 },
    classified: [
      { verdict: "dead", row: { argv: ["node", "--token=SUPERSECRET"] } },
    ],
    ...(skipped ? { skipped } : {}),
  });

  it("runs report-only against deps.reapBaseDir with a bounded deadline", () => {
    let seen: unknown;
    const deps = makeDeps(root);
    checkLeakedProcesses(deps, (opts) => {
      seen = opts;
      return report({});
    });
    expect(seen).toEqual({
      yes: false,
      baseDir: deps.reapBaseDir,
      deadlineMs: 5000,
    });
  });

  it("passes when nothing leaked", () => {
    const out = checkLeakedProcesses(makeDeps(root), () => report({}));
    expect(out.map((c) => c.status)).toEqual(["pass", "pass"]);
  });

  it("warns on dead registry rows with slugs and counts, never argv", () => {
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({
        registry: {
          mode: "sweep",
          yes: false,
          slugs: [slugRow("alpha", 2), slugRow("beta", 0)],
        } as unknown as ReapCliResult["registry"],
      }),
    );
    const c = out.find((x) => x.id === "leftovers-processes")!;
    expect(c).toMatchObject({ status: "warn", fix: "flow reap --yes" });
    expect(c.summary).toContain("2 process(es)");
    expect(c.details.join(" ")).toContain("alpha");
    expect(c.details.join(" ")).not.toContain("beta");
    expect(JSON.stringify(out)).not.toMatch(/SUPERSECRET|--token/);
  });

  it("caps the slug list so a large registry stays one short line", () => {
    const many = Array.from({ length: 12 }, (_, i) => slugRow(`slug-${i}`, 1));
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({
        registry: {
          mode: "sweep",
          yes: false,
          slugs: many,
        } as unknown as ReapCliResult["registry"],
      }),
    );
    const c = out.find((x) => x.id === "leftovers-processes")!;
    expect(c.summary).toContain("12 process(es)");
    expect(c.details[0]).toContain("(+7 more)");
    expect(c.details[0]).not.toContain("slug-11");
  });

  it("warns about strays as host-wide with the include-strays fix", () => {
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({
        heuristic: {
          ran: true,
          found: [{ pid: 1, argv: "chrome --key=SECRET" }],
          foundServers: [{ pid: 2, command: "mcp --token=SECRET" }],
          signalled: [],
        } as unknown as ReapCliResult["heuristic"],
      }),
    );
    const c = out.find((x) => x.id === "leftovers-strays")!;
    expect(c.status).toBe("warn");
    expect(c.fix).toBe("flow reap --yes --include-strays (host-wide)");
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("skips the stray scan when ps is unavailable", () => {
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({
        heuristic: {
          ran: false,
          skipReason: "ps-unavailable",
          found: [],
          foundServers: [],
          signalled: [],
        },
      }),
    );
    expect(out.find((x) => x.id === "leftovers-strays")?.status).toBe("skip");
  });

  it("warns when the sweep deadline left slugs unchecked", () => {
    const out = checkLeakedProcesses(makeDeps(root), () =>
      report({
        registry: {
          mode: "sweep",
          yes: false,
          slugs: [slugRow("slow", 0, "deadline-exceeded")],
        } as unknown as ReapCliResult["registry"],
      }),
    );
    expect(out.find((x) => x.id === "leftovers-processes")).toMatchObject({
      status: "warn",
      fix: "flow reap",
    });
  });
});
