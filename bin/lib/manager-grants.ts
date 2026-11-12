/**
 * Scoped autonomy grants: `~/.flow/manager/grants.json`, one entry per scope
 * (`pipeline:` / `epic:` / `repo:`). Granted only by `flow grant` (an
 * owner-typed command, see grant-cli.ts); withdrawn by `flow grant ... off`,
 * by manager prune, and by `flow feature create` when a slug is reused; read
 * by the executive.
 *
 * Resolution reports the MOST SPECIFIC live covering grant's scope and expiry
 * (pipeline > epic > repo), but unions the classes across EVERY live covering
 * grant, so a narrow plan-only grant never strips a broader class.
 */

import * as fs from "node:fs";
import {
  loadManifestFromRepo,
  type EpicManifest,
} from "./epic-manifest-schema";
import { withFileLockSync } from "./lock";
import {
  managerFile,
  managerHome,
  managerLockPath,
  writeJsonAtomic,
} from "./manager-home";
import {
  identityForState,
  parseScope,
  scopeMatches,
  specificity,
  type PipelineIdentity,
} from "./manager-scope";
import { appendManagerLog, readManagerLog } from "./manager-log";
import { readState } from "./state";

/**
 * `plan`: the executive may approve plans. `subjective`: reserved for delegated
 * UI sign-off. `relay`: the owner may answer a paused pipeline from the manager
 * window (a `source: owner` ruling); it never switches the executive on.
 */
export type GrantClass = "plan" | "subjective" | "relay";

const GRANT_CLASSES: readonly string[] = ["plan", "subjective", "relay"];

export type ScopedGrant = {
  scope: string;
  classes: GrantClass[];
  grantedAt: string;
  expiresAt?: string;
  grantedBy: "owner-cli";
};

export type GrantsFile = { version: 1; grants: ScopedGrant[] };

function grantsPath(home?: string): string {
  return managerFile("grants.json", home ?? managerHome());
}

function isScopedGrant(v: unknown): v is ScopedGrant {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Record<string, unknown>;
  return (
    typeof g.scope === "string" &&
    parseScope(g.scope) !== null &&
    Array.isArray(g.classes) &&
    g.classes.length > 0 &&
    g.classes.every((c) => GRANT_CLASSES.includes(c as string)) &&
    typeof g.grantedAt === "string" &&
    (g.expiresAt === undefined || typeof g.expiresAt === "string") &&
    g.grantedBy === "owner-cli"
  );
}

/** Tolerant: a missing file reads as none; an invalid entry is skipped. */
export function readGrants(home?: string): ScopedGrant[] {
  try {
    const v = JSON.parse(fs.readFileSync(grantsPath(home), "utf8")) as {
      version?: unknown;
      grants?: unknown;
    };
    if (v?.version !== 1 || !Array.isArray(v.grants)) return [];
    return v.grants.filter(isScopedGrant);
  } catch {
    return [];
  }
}

function locked<T>(home: string | undefined, fn: () => T): T {
  return withFileLockSync(managerLockPath("grants", home ?? managerHome()), fn);
}

function write(grants: ScopedGrant[], home?: string): void {
  const file: GrantsFile = { version: 1, grants };
  writeJsonAtomic(grantsPath(home), file);
}

/** One entry per scope: a re-grant replaces the earlier entry in place. */
export function upsertGrant(g: ScopedGrant, home?: string): void {
  locked(home, () => {
    const all = readGrants(home);
    const i = all.findIndex((x) => x.scope === g.scope);
    if (i >= 0) all[i] = g;
    else all.push(g);
    write(all, home);
  });
}

export function removeGrant(scope: string, home?: string): boolean {
  return locked(home, () => {
    const all = readGrants(home);
    const next = all.filter((x) => x.scope !== scope);
    if (next.length === all.length) return false;
    write(next, home);
    return true;
  });
}

/**
 * Remove a `pipeline:<slug>` grant and log `grant-withdrawn`. A grant is keyed
 * by slug alone, so one left by an earlier pipeline must not cover a later
 * pipeline that reuses the slug. `repo` receives the prior `grant` log line's
 * repo so each caller picks its own precedence.
 */
export function withdrawPipelineGrant(
  slug: string,
  opts: {
    repo: (priorRepo?: string) => string;
    reason: string;
    now: Date;
    home?: string;
  },
): { removed: boolean; logError?: string } {
  const scope = `pipeline:${slug}`;
  if (!readGrants(opts.home).some((g) => g.scope === scope)) {
    return { removed: false };
  }
  if (!removeGrant(scope, opts.home)) return { removed: false };
  try {
    const prior = readManagerLog({ slug }, opts.home)
      .filter((e) => e.kind === "grant")
      .at(-1)?.repo;
    appendManagerLog(
      {
        ts: opts.now.toISOString(),
        kind: "grant-withdrawn",
        scope,
        repo: opts.repo(prior),
        slug,
        reason: opts.reason,
      },
      { home: opts.home },
    );
  } catch (err) {
    return {
      removed: true,
      logError: err instanceof Error ? err.message : String(err),
    };
  }
  return { removed: true };
}

export function isLive(g: ScopedGrant, now: Date): boolean {
  if (g.expiresAt === undefined) return true;
  const t = Date.parse(g.expiresAt);
  return Number.isFinite(t) && t > now.getTime();
}

export function liveGrants(now: Date, home?: string): ScopedGrant[] {
  return readGrants(home).filter((g) => isLive(g, now));
}

/** Live grants covering the identity, most specific first. */
function coveringGrants(
  id: PipelineIdentity,
  now: Date,
  home?: string,
): ScopedGrant[] {
  return liveGrants(now, home)
    .map((g) => ({ g, s: parseScope(g.scope) }))
    .filter(
      (x): x is { g: ScopedGrant; s: NonNullable<typeof x.s> } =>
        x.s !== null && scopeMatches(x.s, id),
    )
    .sort((a, b) => specificity(b.s) - specificity(a.s))
    .map((x) => x.g);
}

export function resolveGrant(
  id: PipelineIdentity,
  now: Date,
  home?: string,
  opts: { pipelineNotBefore?: string } = {},
): { scope: string; classes: GrantClass[]; expiresAt?: string } | null {
  const notBefore = Date.parse(opts.pipelineNotBefore ?? "");
  const covering = coveringGrants(id, now, home).filter((g) => {
    if (!Number.isFinite(notBefore) || !g.scope.startsWith("pipeline:")) {
      return true;
    }
    const at = Date.parse(g.grantedAt);
    return Number.isFinite(at) && at >= notBefore;
  });
  if (covering.length === 0) return null;
  const top = covering[0];
  const classes = [...new Set(covering.flatMap((g) => g.classes))].sort();
  return {
    scope: top.scope,
    classes: classes as GrantClass[],
    ...(top.expiresAt ? { expiresAt: top.expiresAt } : {}),
  };
}

export type GrantResolution =
  | {
      granted: true;
      scope: string;
      classes: GrantClass[];
      epic?: string;
      featureId?: string;
    }
  | {
      granted: false;
      reason: "no-grant" | "state-missing" | "other-epic" | "unknown-feature";
    };

/**
 * Is `slug` covered by a live grant? `expectedEpic`, when given, must match the
 * slug's own epic binding. An epic feature must also still be in its manifest.
 */
export function grantForSlug(
  slug: string,
  deps: {
    stateDir?: string;
    home?: string;
    now?: () => Date;
    expectedEpic?: string;
    loadManifest?: (epic: string, repoRoot: string) => EpicManifest | null;
  } = {},
): GrantResolution {
  const state = readState(slug, deps.stateDir);
  if (!state) return { granted: false, reason: "state-missing" };
  if (
    deps.expectedEpic !== undefined &&
    deps.expectedEpic !== state.epic?.slug
  ) {
    return { granted: false, reason: "other-epic" };
  }
  const now = (deps.now ?? (() => new Date()))();
  const resolved = resolveGrant(identityForState(state), now, deps.home, {
    pipelineNotBefore: state.createdAt,
  });
  if (!resolved) return { granted: false, reason: "no-grant" };
  if (!state.epic) {
    return { granted: true, scope: resolved.scope, classes: resolved.classes };
  }
  const { slug: epic, featureId } = state.epic;
  const load = deps.loadManifest ?? loadManifestFromRepo;
  const roots = [state.worktree, state.repo].filter(
    (r): r is string => typeof r === "string" && r !== "",
  );
  for (const root of roots) {
    const manifest = load(epic, root);
    if (manifest) {
      return manifest.features.some((f) => f.id === featureId)
        ? {
            granted: true,
            scope: resolved.scope,
            classes: resolved.classes,
            epic,
            featureId,
          }
        : { granted: false, reason: "unknown-feature" };
    }
  }
  return { granted: false, reason: "unknown-feature" };
}

/** The most specific live grant (`epic:` over `repo:`) covering an epic in `repo`, carrying the classes of every covering grant; the wave review's gate. */
export function grantForEpic(
  epic: string,
  repo: string,
  now: Date,
  home?: string,
): ScopedGrant | null {
  const covering = coveringGrants({ slug: "", epic, repo }, now, home);
  if (covering.length === 0) return null;
  const classes = [...new Set(covering.flatMap((g) => g.classes))].sort();
  return { ...covering[0], classes: classes as GrantClass[] };
}
