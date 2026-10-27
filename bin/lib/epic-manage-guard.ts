/**
 * The pure launch guard for `flow epic manage`: turns a reconcile result plus
 * observations into one verdict per frontier node, and names every sign that a
 * feature is already in flight. It never trusts `run.json` alone — the PR #420
 * drift fixtures (recreated slug, out-of-band merge, manifest drift, unknown
 * slug) all halt here. Any ambiguity holds the node with a reason; the guard
 * never repairs (that is `/flow-epic-run reconcile-drift`) and never writes.
 */

import type { LaunchOverrides } from "./epic-launch";
import {
  EPIC_MANIFEST_FILENAME,
  epicDirRelative,
  type EpicManifest,
  type Feature,
} from "./epic-manifest-schema";
import type { GitRefs, GithubPr, GithubSnapshot } from "./epic-manage-observe";
import type { ReconcileResult } from "./epic-reconcile";
import type { EpicRunState } from "./epic-run-state";
import { slugify } from "./slug";
import type { EffortLevel, ModelAlias, PipelineState } from "./state";

export type NodeVerdict =
  | { id: string; action: "launch"; overrides: LaunchOverrides }
  | { id: string; action: "drift"; reason: string }
  | { id: string; action: "waiting"; waitFor: string }
  | { id: string; action: "capacity" | "github-unverified" | "launching" }
  | { id: string; action: "failed"; reason: string };

export type GuardInput = {
  epicSlug: string;
  manifestPath: string;
  /** True when run.json's recorded manifest path is this checkout's manifest (same repo identity + relative path). */
  sameManifest: (runJsonManifestPath: string) => boolean;
  manifest: EpicManifest;
  runState: EpicRunState;
  result: ReconcileResult;
  /** Pipeline states of THIS repo only (scoping happens in `listRepoStates`). */
  repoStates: PipelineState[];
  /** A state file `<slug>.json` exists (any repo — `flow feature create --slug` collides on it). */
  stateSlugExists: (slug: string) => boolean;
  github: GithubSnapshot | null;
  githubFresh: boolean;
  git: GitRefs | null;
  worktreePathFor: (slug: string) => string;
  featureFallback: { model?: ModelAlias; effort?: EffortLevel };
  failed: ReadonlyMap<string, string>;
  launching: ReadonlySet<string>;
  maxParallel: number;
};

export type GuardResult = {
  verdicts: NodeVerdict[];
  globalDrift: string[];
  boundDrift: { id: string; reason: string }[];
  observedMerged: string[];
};

/** Manager flags fill ONLY a feature's missing hints; an explicit manifest hint is never overridden. */
export function launchOverridesFor(
  feature: Feature,
  fallback: { model?: ModelAlias; effort?: EffortLevel },
): LaunchOverrides {
  const hints = feature.flowNewHints ?? {};
  return {
    ...(!hints.model && fallback.model ? { model: fallback.model } : {}),
    ...(!hints.effort && fallback.effort ? { effort: fallback.effort } : {}),
  };
}

/**
 * run.json records the canonical checkout's absolute manifest path while a
 * linked worktree resolves its own toplevel, so raw strings differ for the
 * SAME manifest. Same means: the recorded path ends with this epic's
 * repo-relative manifest path AND the checkout it names is this repository.
 */
export function makeSameManifest(
  sameRepo: (repoPath: string) => boolean,
  epicSlug: string,
): (runJsonManifestPath: string) => boolean {
  const rel = `/${epicDirRelative(epicSlug)}/${EPIC_MANIFEST_FILENAME}`;
  return (recorded) => {
    const norm = recorded.split("\\").join("/");
    return norm.endsWith(rel) && sameRepo(norm.slice(0, -rel.length));
  };
}

function manifestDrift(input: GuardInput, ids: Set<string>): string[] {
  const out: string[] = [];
  for (const id of Object.keys(input.runState.features)) {
    if (!ids.has(id))
      out.push(
        `the epic's launch record names '${id}', which the manifest no longer has`,
      );
  }
  for (const s of input.repoStates) {
    if (s.epic?.slug === input.epicSlug && !ids.has(s.epic.featureId)) {
      out.push(
        `pipeline '${s.slug}' is tagged ${input.epicSlug}/${s.epic.featureId}, which the manifest no longer has`,
      );
    }
  }
  if (!input.sameManifest(input.runState.manifestPath)) {
    out.push(
      `the epic's launch record points at a different manifest (${input.runState.manifestPath})`,
    );
  }
  return out;
}

const prRef = (pr: GithubPr): string =>
  `${pr.state.toLowerCase()} PR #${pr.number}`;

/** Evidence that an UNBOUND feature is already in flight, or null. */
function unboundDrift(id: string, input: GuardInput): string | null {
  const slug = slugify(id);
  const tagged = input.repoStates.find(
    (s) => s.epic?.slug === input.epicSlug && s.epic.featureId === id,
  );
  if (tagged) {
    return `pipeline '${tagged.slug}' is tagged ${input.epicSlug}/${id} but the epic's launch record has no entry for it`;
  }
  if (input.stateSlugExists(slug)) {
    return `a pipeline named '${slug}' already exists but the epic's launch record has no entry for '${id}'`;
  }
  const pr = input.github?.ok
    ? input.github.prs.find(
        (p) => p.headRefName === slug && p.state !== "CLOSED",
      )
    : undefined;
  if (pr)
    return `${prRef(pr)} is on branch '${slug}' but the epic's launch record has no entry for '${id}'`;
  const git = input.git;
  if (git?.branches.has(slug) || git?.worktreeBranches.has(slug)) {
    return `a local branch or worktree '${slug}' exists but the epic's launch record has no entry for '${id}'`;
  }
  if (git?.worktreePaths.has(input.worktreePathFor(slug))) {
    return `a worktree at ${input.worktreePathFor(slug)} exists but the epic's launch record has no entry for '${id}'`;
  }
  return null;
}

export function planLaunches(input: GuardInput): GuardResult {
  const features = new Map(input.manifest.features.map((f) => [f.id, f]));
  const statesBySlug = new Map(input.repoStates.map((s) => [s.slug, s]));
  const prs = input.github?.ok ? input.github.prs : [];
  const globalDrift = manifestDrift(input, new Set(features.keys()));

  const observedMerged: string[] = [];
  const boundDrift: { id: string; reason: string }[] = [];
  for (const row of input.result.board) {
    const record = input.runState.features[row.id];
    if (!record?.slug || input.launching.has(row.id)) continue;
    const state = statesBySlug.get(record.slug);
    const ownPr = state?.pr ?? record.pr;
    if (
      state?.phase !== "merged" &&
      ownPr !== undefined &&
      prs.some((p) => p.number === ownPr && p.state === "MERGED")
    ) {
      observedMerged.push(row.id);
      continue;
    }
    const known = new Set([record.slug, ...(record.priorSlugs ?? [])]);
    const stray = input.repoStates.find(
      (s) =>
        s.epic?.slug === input.epicSlug &&
        s.epic.featureId === row.id &&
        !known.has(s.slug),
    );
    if (stray) {
      boundDrift.push({
        id: row.id,
        reason: `pipeline '${stray.slug}' is also tagged ${input.epicSlug}/${row.id} but the epic's launch record binds '${record.slug}'`,
      });
      continue;
    }
    if (row.status === "orphan") {
      boundDrift.push({
        id: row.id,
        reason: `${row.id} was launched as '${record.slug}', but that pipeline no longer exists`,
      });
      continue;
    }
    const branch = state?.worktree
      ? input.git?.branchByWorktree.get(state.worktree)
      : undefined;
    const other =
      branch && ownPr !== undefined
        ? prs.find(
            (p) =>
              p.headRefName === branch &&
              p.state !== "CLOSED" &&
              p.number !== ownPr,
          )
        : undefined;
    if (other) {
      boundDrift.push({
        id: row.id,
        reason: `${prRef(other)} is on branch '${branch}' but the binding's PR is #${ownPr}`,
      });
    }
  }

  const unbound = new Set(
    [...input.launching].filter((id) => !input.runState.features[id]),
  );
  let slots = Math.max(
    0,
    input.maxParallel - input.result.summary.running - unbound.size,
  );
  const verdicts: NodeVerdict[] = [];
  for (const row of input.result.board) {
    if (row.status !== "ready" && row.status !== "waiting") continue;
    const id = row.id;
    const feature = features.get(id)!;
    if (row.status === "waiting") {
      verdicts.push({
        id,
        action: "waiting",
        waitFor: row.waitFor ?? feature.waitFor ?? "",
      });
    } else if (input.launching.has(id)) {
      verdicts.push({ id, action: "launching" });
    } else if (input.failed.has(id)) {
      verdicts.push({ id, action: "failed", reason: input.failed.get(id)! });
    } else if (globalDrift.length > 0) {
      verdicts.push({ id, action: "drift", reason: globalDrift[0]! });
    } else {
      const drift = unboundDrift(id, input);
      if (drift) verdicts.push({ id, action: "drift", reason: drift });
      else if (!input.github?.ok || !input.githubFresh || !input.git) {
        verdicts.push({ id, action: "github-unverified" });
      } else if (slots <= 0) {
        verdicts.push({ id, action: "capacity" });
      } else {
        slots -= 1;
        verdicts.push({
          id,
          action: "launch",
          overrides: launchOverridesFor(feature, input.featureFallback),
        });
      }
    }
  }
  return { verdicts, globalDrift, boundDrift, observedMerged };
}
