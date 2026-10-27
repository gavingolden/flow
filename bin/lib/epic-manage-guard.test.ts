import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFeatureCreateArgs } from "./epic-launch";
import type { EpicManifest, Feature } from "./epic-manifest-schema";
import {
  launchOverridesFor,
  makeSameManifest,
  planLaunches,
  type GuardInput,
  type NodeVerdict,
} from "./epic-manage-guard";
import {
  listRepoStates,
  makeStrictSameRepository,
  type GitRefs,
  type GithubPr,
} from "./epic-manage-observe";
import { reconcile, type ReadFeatureState } from "./epic-reconcile";
import type { EpicRunState, FeatureRunRecord } from "./epic-run-state";
import { writeState, type PipelineState } from "./state";

const EPIC = "my-epic";
const MANIFEST_PATH = `/repo/.flow/epics/${EPIC}/manifest.json`;

const feat = (
  id: string,
  dependsOn: string[] = [],
  extra: Partial<Feature> = {},
): Feature => ({
  id,
  title: id,
  description: `build ${id}`,
  dependsOn,
  ...extra,
});

const manifestOf = (...features: Feature[]): EpicManifest => ({
  epicId: EPIC,
  prompt: "p",
  createdAt: "2026-10-26",
  features,
});

const runStateOf = (
  features: Record<string, FeatureRunRecord> = {},
): EpicRunState => ({
  epicSlug: EPIC,
  repo: "/repo",
  manifestPath: MANIFEST_PATH,
  manifestSha: "sha",
  maxParallel: 3,
  createdAt: "2026-10-26T00:00:00Z",
  updatedAt: "2026-10-26T00:00:00Z",
  features,
});

const stateOf = (
  slug: string,
  over: Partial<PipelineState> = {},
): PipelineState => ({
  slug,
  phase: "implementing",
  repo: "/repo",
  updatedAt: "2026-10-26T00:00:00Z",
  ...over,
});

const tagged = (
  slug: string,
  featureId: string,
  over: Partial<PipelineState> = {},
) => stateOf(slug, { epic: { slug: EPIC, featureId }, ...over });

const ghOk = (...prs: GithubPr[]) => ({ ok: true as const, at: 1, prs });
const pr = (
  number: number,
  headRefName: string,
  state: GithubPr["state"],
): GithubPr => ({
  number,
  headRefName,
  state,
  ci: "none",
});

const emptyGit = (): GitRefs => ({
  branches: new Set(),
  worktreeBranches: new Set(),
  worktreePaths: new Set(),
  branchByWorktree: new Map(),
});

/** Build a GuardInput from a manifest + run.json + states, reconciling like the loop does. */
function input(
  manifest: EpicManifest,
  over: Partial<GuardInput> & { states?: PipelineState[] } = {},
): GuardInput {
  const states = over.states ?? [];
  const runState = over.runState ?? runStateOf();
  const read: ReadFeatureState = (slug) =>
    states.find((s) => s.slug === slug) ?? null;
  return {
    epicSlug: EPIC,
    manifestPath: MANIFEST_PATH,
    sameManifest: (p) => p === MANIFEST_PATH,
    manifest,
    runState,
    result: reconcile({
      manifest,
      runState,
      readFeatureState: read,
      maxParallel: 3,
    }),
    repoStates: states,
    stateSlugExists: (slug) => states.some((s) => s.slug === slug),
    github: ghOk(),
    githubFresh: true,
    git: emptyGit(),
    worktreePathFor: (slug) => `/wt/${slug}`,
    featureFallback: {},
    failed: new Map(),
    launching: new Set(),
    maxParallel: 3,
    ...over,
  };
}

const verdictOf = (
  verdicts: NodeVerdict[],
  id: string,
): NodeVerdict | undefined => verdicts.find((v) => v.id === id);

describe("planLaunches — launch + capacity", () => {
  it("launches every safe frontier node up to the cap and holds the rest on capacity", () => {
    const m = manifestOf(feat("alpha"), feat("beta"), feat("gamma"));
    const out = planLaunches(input(m, { maxParallel: 2 }));
    expect(out.verdicts.map((v) => [v.id, v.action])).toEqual([
      ["alpha", "launch"],
      ["beta", "launch"],
      ["gamma", "capacity"],
    ]);
  });

  it("running features and in-flight launches both consume capacity", () => {
    const m = manifestOf(
      feat("alpha"),
      feat("beta"),
      feat("gamma"),
      feat("delta"),
    );
    const runState = runStateOf({ alpha: { slug: "alpha", launchedAt: "x" } });
    const states = [tagged("alpha", "alpha")];
    const out = planLaunches(
      input(m, {
        runState,
        states,
        maxParallel: 3,
        launching: new Set(["beta"]),
      }),
    );
    expect(out.verdicts.map((v) => [v.id, v.action])).toEqual([
      ["beta", "launching"],
      ["gamma", "launch"],
      ["delta", "capacity"],
    ]);
  });
});

describe("planLaunches — PR #420 drift fixtures halt without a launch", () => {
  it("recreated slug: an orphan record plus a new slug tagged with the epic is bound drift; independent nodes still launch", () => {
    const m = manifestOf(feat("alpha"), feat("beta", ["alpha"]), feat("gamma"));
    const runState = runStateOf({
      alpha: { slug: "alpha-old", launchedAt: "x" },
    });
    const states = [tagged("alpha-new", "alpha")];
    const out = planLaunches(input(m, { runState, states }));
    expect(out.boundDrift).toEqual([
      {
        id: "alpha",
        reason: expect.stringContaining("'alpha-new' is also tagged"),
      },
    ]);
    expect(verdictOf(out.verdicts, "alpha")).toBeUndefined();
    expect(verdictOf(out.verdicts, "beta")).toBeUndefined();
    expect(verdictOf(out.verdicts, "gamma")?.action).toBe("launch");
  });

  it("an orphan record with no stray state is bound drift naming the dead slug", () => {
    const m = manifestOf(feat("alpha"));
    const out = planLaunches(
      input(m, {
        runState: runStateOf({ alpha: { slug: "gone", launchedAt: "x" } }),
      }),
    );
    expect(out.boundDrift).toEqual([
      { id: "alpha", reason: expect.stringContaining("'gone'") },
    ]);
  });

  it("out-of-band merge: a merged PR on branch slugify(id) with no binding halts that node only", () => {
    const m = manifestOf(feat("alpha"), feat("gamma"));
    const out = planLaunches(
      input(m, { github: ghOk(pr(9, "alpha", "MERGED")) }),
    );
    expect(verdictOf(out.verdicts, "alpha")).toEqual({
      id: "alpha",
      action: "drift",
      reason: expect.stringContaining("merged PR #9 is on branch 'alpha'"),
    });
    expect(verdictOf(out.verdicts, "gamma")?.action).toBe("launch");
  });

  it("an OPEN PR on the unbound feature's branch is drift; a CLOSED-unmerged one is not", () => {
    const m = manifestOf(feat("alpha"), feat("beta"));
    const out = planLaunches(
      input(m, {
        github: ghOk(pr(1, "alpha", "OPEN"), pr(2, "beta", "CLOSED")),
      }),
    );
    expect(verdictOf(out.verdicts, "alpha")?.action).toBe("drift");
    expect(verdictOf(out.verdicts, "beta")?.action).toBe("launch");
  });

  it("a surviving local branch or worktree of a CLOSED attempt still holds the node", () => {
    const m = manifestOf(feat("alpha"), feat("beta"), feat("gamma"));
    const git = emptyGit();
    git.branches.add("alpha");
    git.worktreeBranches.add("beta");
    git.worktreePaths.add("/wt/gamma");
    const out = planLaunches(input(m, { git }));
    expect(out.verdicts.map((v) => v.action)).toEqual([
      "drift",
      "drift",
      "drift",
    ]);
  });

  it("manifest drift: run.json holding an id the manifest lacks halts EVERY launch", () => {
    const m = manifestOf(feat("alpha"), feat("gamma"));
    const runState = runStateOf({ ghost: { slug: "ghost", launchedAt: "x" } });
    const out = planLaunches(
      input(m, { runState, states: [tagged("ghost", "ghost")] }),
    );
    expect(out.globalDrift[0]).toContain(
      "'ghost', which the manifest no longer has",
    );
    expect(out.verdicts.map((v) => v.action)).toEqual(["drift", "drift"]);
  });

  it("manifest drift: run.json pointing at a different manifest halts every launch", () => {
    const m = manifestOf(feat("alpha"));
    const out = planLaunches(
      input(m, {
        runState: { ...runStateOf(), manifestPath: "/elsewhere/manifest.json" },
      }),
    );
    expect(out.globalDrift).toEqual([
      expect.stringContaining("different manifest"),
    ]);
    expect(verdictOf(out.verdicts, "alpha")?.action).toBe("drift");
  });

  it("manifest drift: a repo state tagged with an id the manifest lacks halts every launch", () => {
    const m = manifestOf(feat("alpha"));
    const out = planLaunches(
      input(m, { states: [tagged("zzz", "removed-feature")] }),
    );
    expect(out.globalDrift).toEqual([
      expect.stringContaining("removed-feature"),
    ]);
    expect(verdictOf(out.verdicts, "alpha")?.action).toBe("drift");
  });

  it("unknown slug: a state tagged with the unbound feature under another name is drift", () => {
    const m = manifestOf(feat("alpha"), feat("gamma"));
    const out = planLaunches(
      input(m, { states: [tagged("hand-run-name", "alpha")] }),
    );
    expect(verdictOf(out.verdicts, "alpha")).toEqual({
      id: "alpha",
      action: "drift",
      reason: expect.stringContaining("'hand-run-name' is tagged my-epic/a"),
    });
    expect(verdictOf(out.verdicts, "gamma")?.action).toBe("launch");
  });

  it("an untagged state file already named slugify(id) is drift", () => {
    const m = manifestOf(feat("alpha"));
    const out = planLaunches(input(m, { states: [stateOf("alpha")] }));
    expect(verdictOf(out.verdicts, "alpha")?.action).toBe("drift");
  });

  it("a rebind's abandoned slug (priorSlugs) is not stray drift", () => {
    const m = manifestOf(feat("alpha"));
    const runState = runStateOf({
      alpha: { slug: "alpha-2", launchedAt: "x", priorSlugs: ["alpha-1"] },
    });
    const out = planLaunches(
      input(m, {
        runState,
        states: [tagged("alpha-1", "alpha"), tagged("alpha-2", "alpha")],
      }),
    );
    expect(out.boundDrift).toEqual([]);
  });

  it("a PR on the bound feature's branch that is not the binding's own PR is bound drift", () => {
    const m = manifestOf(feat("alpha"));
    const runState = runStateOf({ alpha: { slug: "alpha", launchedAt: "x" } });
    const states = [tagged("alpha", "alpha", { pr: 5, worktree: "/wt/alpha" })];
    const git = emptyGit();
    git.branchByWorktree.set("/wt/alpha", "alpha-2");
    const out = planLaunches(
      input(m, {
        runState,
        states,
        git,
        github: ghOk(pr(5, "alpha-2", "OPEN"), pr(8, "alpha-2", "OPEN")),
      }),
    );
    expect(out.boundDrift).toEqual([
      {
        id: "alpha",
        reason: expect.stringContaining("PR #8 is on branch 'alpha-2'"),
      },
    ]);
  });
});

describe("planLaunches — repo identity", () => {
  let tmp!: string;
  const git = (cwd: string, ...args: string[]): void => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  const initRepo = (name: string): string => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    git(
      dir,
      "-c",
      "user.email=a@b.c",
      "-c",
      "user.name=x",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "i",
    );
    return dir;
  };
  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "flow-guard-")),
    );
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("a worktree resolving its own toplevel does NOT drift against run.json's canonical manifest path", () => {
    const canonical = initRepo("canonical");
    const wt = path.join(tmp, "wt");
    git(canonical, "worktree", "add", "-q", "-b", "side", wt);
    const recorded = path.join(
      canonical,
      ".flow",
      "epics",
      EPIC,
      "manifest.json",
    );
    const m = manifestOf(feat("alpha"));
    const sameManifest = makeSameManifest(makeStrictSameRepository(wt), EPIC);
    const out = planLaunches(
      input(m, {
        runState: { ...runStateOf(), manifestPath: recorded },
        sameManifest,
      }),
    );
    expect(out.globalDrift).toEqual([]);
    expect(verdictOf(out.verdicts, "alpha")?.action).toBe("launch");
  });

  it("a manifest path in ANOTHER repo, or a different epic's path, does drift", () => {
    const mine = initRepo("mine");
    const other = initRepo("other");
    const same = makeSameManifest(makeStrictSameRepository(mine), EPIC);
    expect(
      same(path.join(other, ".flow", "epics", EPIC, "manifest.json")),
    ).toBe(false);
    expect(
      same(path.join(mine, ".flow", "epics", "other-epic", "manifest.json")),
    ).toBe(false);
    expect(same(path.join(mine, ".flow", "epics", EPIC, "manifest.json"))).toBe(
      true,
    );
  });

  it("another repo's state tagged with the same epic and feature is neither drift nor in-flight", () => {
    const mine = initRepo("mine");
    const other = initRepo("other");
    const stateDir = path.join(tmp, "state");
    writeState(tagged("their-a", "alpha", { repo: other }), stateDir);
    const repoStates = listRepoStates(makeStrictSameRepository(mine), stateDir);
    expect(repoStates).toEqual([]);
    const m = manifestOf(feat("alpha"));
    const out = planLaunches(
      input(m, { repoStates, stateSlugExists: () => false }),
    );
    expect(out.globalDrift).toEqual([]);
    expect(verdictOf(out.verdicts, "alpha")?.action).toBe("launch");
  });
});

describe("planLaunches — bound PR merged in the GitHub UI", () => {
  it("is observedMerged (not drift) and, fed through the readFeatureState seam, unblocks its dependents", () => {
    const m = manifestOf(feat("alpha"), feat("beta", ["alpha"]));
    const runState = runStateOf({ alpha: { slug: "alpha", launchedAt: "x" } });
    const states = [tagged("alpha", "alpha", { phase: "gated", pr: 7 })];
    const github = ghOk(pr(7, "alpha", "MERGED"));
    const first = planLaunches(input(m, { runState, states, github }));
    expect(first.observedMerged).toEqual(["alpha"]);
    expect(first.boundDrift).toEqual([]);
    expect(verdictOf(first.verdicts, "beta")).toBeUndefined();

    const merged: ReadFeatureState = (slug) => {
      const s = states.find((x) => x.slug === slug) ?? null;
      return s && first.observedMerged.includes(s.epic!.featureId)
        ? { ...s, phase: "merged" }
        : s;
    };
    const result = reconcile({
      manifest: m,
      runState,
      readFeatureState: merged,
      maxParallel: 3,
    });
    const second = planLaunches(input(m, { runState, states, github, result }));
    expect(verdictOf(second.verdicts, "beta")?.action).toBe("launch");
  });

  it("a feature whose state already says merged is not re-reported", () => {
    const m = manifestOf(feat("alpha"));
    const runState = runStateOf({ alpha: { slug: "alpha", launchedAt: "x" } });
    const out = planLaunches(
      input(m, {
        runState,
        states: [tagged("alpha", "alpha", { phase: "merged", pr: 7 })],
        github: ghOk(pr(7, "alpha", "MERGED")),
      }),
    );
    expect(out.observedMerged).toEqual([]);
  });
});

describe("planLaunches — mid-launch hold", () => {
  it("a node whose state file exists without a binding holds as launching instead of drifting", () => {
    const m = manifestOf(feat("alpha"));
    const states = [tagged("alpha", "alpha")];
    const held = planLaunches(
      input(m, { states, launching: new Set(["alpha"]) }),
    );
    expect(verdictOf(held.verdicts, "alpha")?.action).toBe("launching");
    const unheld = planLaunches(input(m, { states }));
    expect(verdictOf(unheld.verdicts, "alpha")?.action).toBe("drift");
  });
});

describe("planLaunches — unverified, waiting, failed", () => {
  it.each([
    ["no snapshot", { github: null }],
    [
      "a failed snapshot",
      { github: { ok: false as const, at: 1, error: "boom" } },
    ],
    ["a stale snapshot", { githubFresh: false }],
    ["an unreadable git probe", { git: null }],
  ])("pauses launches on %s", (_label, over) => {
    const out = planLaunches(input(manifestOf(feat("alpha")), over));
    expect(out.verdicts).toEqual([
      { id: "alpha", action: "github-unverified" },
    ]);
  });

  it("local drift still wins over the unverified pause", () => {
    const out = planLaunches(
      input(manifestOf(feat("alpha")), {
        github: null,
        states: [stateOf("alpha")],
      }),
    );
    expect(verdictOf(out.verdicts, "alpha")?.action).toBe("drift");
  });

  it("a waitFor node is waiting and never launched", () => {
    const m = manifestOf(
      feat("wait-node", [], { waitFor: "the rollout lands" }),
      feat("alpha"),
    );
    const out = planLaunches(input(m));
    expect(verdictOf(out.verdicts, "wait-node")).toEqual({
      id: "wait-node",
      action: "waiting",
      waitFor: "the rollout lands",
    });
    expect(verdictOf(out.verdicts, "alpha")?.action).toBe("launch");
  });

  it("a failed launch is reported and not retried", () => {
    const out = planLaunches(
      input(manifestOf(feat("alpha")), {
        failed: new Map([["alpha", "exit 2: tmux gone"]]),
      }),
    );
    expect(out.verdicts).toEqual([
      { id: "alpha", action: "failed", reason: "exit 2: tmux gone" },
    ]);
  });
});

describe("launchOverridesFor — manager flags fill only missing hints", () => {
  it("fills model and effort when the manifest has neither", () => {
    const f = feat("alpha");
    const o = launchOverridesFor(f, { model: "haiku", effort: "low" });
    expect(o).toEqual({ model: "haiku", effort: "low" });
    const args = buildFeatureCreateArgs(f, EPIC, o);
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args[args.indexOf("--effort") + 1]).toBe("low");
  });

  it("never overrides a manifest hint — the hint reaches argv exactly once", () => {
    const f = feat("alpha", [], {
      flowNewHints: { model: "opus", effort: "high" },
    });
    const o = launchOverridesFor(f, { model: "haiku", effort: "low" });
    expect(o).toEqual({});
    const args = buildFeatureCreateArgs(f, EPIC, o);
    expect(args.filter((a) => a === "--model")).toHaveLength(1);
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });

  it("an empty fallback adds nothing", () => {
    expect(launchOverridesFor(feat("alpha"), {})).toEqual({});
  });
});
