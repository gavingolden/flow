/**
 * One tick's observation and planning for `flow epic manage`: read the
 * manifest, run.json, and repo-scoped states; refresh the GitHub snapshot when
 * due; reconcile (counting a GitHub-observed merge of a bound feature's own PR
 * as completed in memory); probe git only when a launch candidate exists; and
 * ask the pure guard for a verdict per frontier node.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { validateDag } from "../flow-epic-dag";
import { readEpicMaxParallel } from "./epic-config";
import { appendManagerLog } from "./epic-manager-log";
import { iso, safely } from "./epic-manage-events";
import { planLaunches, type GuardResult } from "./epic-manage-guard";
import { expireHolds } from "./epic-manage-launch";
import type { LoopContext, LoopDeps } from "./epic-manage-loop";
import {
  fetchGithubSnapshot,
  listRepoStates,
  probeGitRefs,
  resolveGithubRepo,
  type GitRefs,
  type GithubSnapshot,
} from "./epic-manage-observe";
import {
  validateEpicManifest,
  type EpicManifest,
} from "./epic-manifest-schema";
import { reconcile, type ReconcileResult } from "./epic-reconcile";
import { readEpicRunState, type EpicRunState } from "./epic-run-state";
import { readCommittedStatus } from "./epic-status-schema";
import { deriveWorktreePath } from "./feature";
import { slugify } from "./slug";
import { readState, type PipelineState } from "./state";

function readManifest(manifestPath: string): EpicManifest {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    throw new Error(`manifest unreadable at ${manifestPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `manifest is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const shape = validateEpicManifest(parsed);
  if (!shape.ok) throw new Error(`invalid manifest — ${shape.reason}`);
  if (!validateDag(shape.value.features).ok)
    throw new Error("manifest DAG is malformed");
  return shape.value;
}

export const githubFresh = (ctx: LoopContext, now: number): boolean =>
  ctx.lastGood !== null && now - ctx.lastGood.at <= 2 * ctx.cfg.githubPollMs;

async function refreshGithub(
  ctx: LoopContext,
  deps: LoopDeps,
  watchedPrs: number[],
  branches: string[],
): Promise<void> {
  const now = deps.now();
  if (ctx.lastFetchAt !== null && now - ctx.lastFetchAt < ctx.cfg.githubPollMs)
    return;
  ctx.lastFetchAt = now;
  ctx.repoRef ??= await resolveGithubRepo(ctx.cfg.manager.repo, deps.exec);
  const snap: GithubSnapshot = ctx.repoRef
    ? await fetchGithubSnapshot({
        repo: ctx.cfg.manager.repo,
        ...ctx.repoRef,
        watchedPrs,
        branches,
        exec: deps.exec,
        now: deps.now,
      })
    : {
        ok: false,
        at: now,
        error: "could not resolve the GitHub repository (gh repo view failed)",
      };
  ctx.github = snap;
  if (snap.ok) ctx.lastGood = snap;
}

export async function headSha(
  ctx: LoopContext,
  deps: LoopDeps,
): Promise<string | null> {
  const now = deps.now();
  if (ctx.head && now - ctx.head.at < 15_000) return ctx.head.value;
  let value: string | null;
  if (deps.headSha) value = await deps.headSha();
  else {
    const r = await deps.exec(
      "git",
      ["rev-parse", "--short", "HEAD"],
      ctx.cfg.manager.repo,
      10_000,
    );
    value = r.exitCode === 0 ? r.stdout.trim() || null : null;
  }
  ctx.head = { value, at: now };
  return value;
}

export type Observation = {
  manifest: EpicManifest;
  runState: EpicRunState;
  repoStates: PipelineState[];
  maxParallel: number;
};

export function observe(ctx: LoopContext, deps: LoopDeps): Observation {
  const manifest = readManifest(ctx.cfg.manifestPath);
  const now = deps.now();
  const runState: EpicRunState = readEpicRunState(ctx.epic, deps.epicsDir) ?? {
    epicSlug: ctx.epic,
    repo: ctx.cfg.manager.repo,
    manifestPath: ctx.cfg.manifestPath,
    manifestSha: "",
    createdAt: iso(now),
    updatedAt: iso(now),
    features: {},
  };
  expireHolds(ctx, now, (id) => runState.features[id] !== undefined);
  return {
    manifest,
    runState,
    repoStates: listRepoStates(ctx.sameRepo, deps.stateDir),
    maxParallel:
      runState.maxParallel ?? (deps.readMaxParallel ?? readEpicMaxParallel)(),
  };
}

/**
 * Reconcile, with a GitHub-observed merge of a bound feature's own PR counted
 * as completed IN MEMORY: the seam reports `merged` for those slugs, so
 * `reconcile()` itself is unchanged and run.json / the state file stay untouched.
 */
function reconcileWith(
  ctx: LoopContext,
  deps: LoopDeps,
  o: Observation,
  merged: ReadonlySet<string>,
): ReconcileResult {
  const idBySlug = new Map(
    Object.entries(o.runState.features).flatMap(([id, r]) =>
      r.slug ? [[r.slug, id] as const] : [],
    ),
  );
  return reconcile({
    manifest: o.manifest,
    runState: o.runState,
    maxParallel: o.maxParallel,
    committedStatus: readCommittedStatus(path.dirname(ctx.cfg.manifestPath)),
    readFeatureState: (slug) => {
      const s = readState(slug, deps.stateDir);
      const id = idBySlug.get(slug);
      if (id === undefined || !merged.has(id)) return s;
      return s
        ? { ...s, phase: "merged" }
        : {
            slug,
            phase: "merged",
            repo: ctx.cfg.manager.repo,
            updatedAt: iso(deps.now()),
          };
    },
  });
}

export async function plan(
  ctx: LoopContext,
  deps: LoopDeps,
  o: Observation,
  hooks: { onMerged: (fresh: string[]) => Promise<void>; beat: () => void },
): Promise<{
  result: ReconcileResult;
  guard: GuardResult;
  replan: () => GuardResult;
}> {
  const bySlug = new Map(o.repoStates.map((s) => [s.slug, s]));
  const watched = new Set<number>();
  for (const rec of Object.values(o.runState.features)) {
    const s = rec.slug ? bySlug.get(rec.slug) : undefined;
    const pr = s?.pr ?? rec.pr;
    if (pr !== undefined && s?.phase !== "merged") watched.add(pr);
  }
  const branches = o.manifest.features
    .filter((f) => !o.runState.features[f.id])
    .map((f) => slugify(f.id));
  await refreshGithub(ctx, deps, [...watched], branches);
  hooks.beat();

  let result = reconcileWith(ctx, deps, o, new Set());
  let git: GitRefs | null = null;
  const guardOf = (r: ReconcileResult): GuardResult =>
    planLaunches({
      epicSlug: ctx.epic,
      manifestPath: ctx.cfg.manifestPath,
      sameManifest: ctx.sameManifest,
      manifest: o.manifest,
      runState: o.runState,
      result: r,
      repoStates: o.repoStates,
      stateSlugExists: (slug) => readState(slug, deps.stateDir) !== null,
      github: ctx.lastGood,
      githubFresh: githubFresh(ctx, deps.now()),
      git,
      worktreePathFor: (slug) => deriveWorktreePath(ctx.cfg.manager.repo, slug),
      featureFallback: ctx.cfg.manager.featureFallback,
      failed: ctx.failed,
      launching: new Set(ctx.launching.keys()),
      maxParallel: o.maxParallel,
    });
  const observedMerged = guardOf(result).observedMerged;
  if (observedMerged.length > 0) {
    const fresh = observedMerged.filter((id) => !ctx.observed.has(id));
    for (const id of fresh) {
      ctx.observed.add(id);
      const slug = o.runState.features[id]?.slug;
      safely(() =>
        appendManagerLog(
          ctx.epic,
          {
            ts: iso(deps.now()),
            kind: "merged-observed",
            featureId: id,
            ...(slug ? { slug } : {}),
            key: `merged-observed:${id}`,
            reason: "its PR merged on GitHub (observed; run.json untouched)",
          },
          deps.stateDir,
        ),
      );
    }
    if (fresh.length > 0) await hooks.onMerged(fresh);
    result = reconcileWith(ctx, deps, o, new Set(observedMerged));
  }
  // Git refs are only read when a launch candidate exists (after observed merges unblock dependents).
  if (result.board.some((r) => r.status === "ready")) {
    git = await probeGitRefs(ctx.cfg.manager.repo, deps.exec);
  }
  const guard = guardOf(result);
  return { result, guard, replan: () => guardOf(result) };
}
