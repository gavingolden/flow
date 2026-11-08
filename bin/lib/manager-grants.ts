/**
 * Scoped autonomy grants: `~/.flow/manager/grants.json`, one entry per scope
 * (`pipeline:` / `epic:` / `repo:`). Written only by `flow grant` (an
 * owner-typed command, see grant-cli.ts); read by the executive.
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
import { readState } from "./state";

export type GrantClass = "plan" | "subjective";

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
    g.classes.every((c) => c === "plan" || c === "subjective") &&
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
): { scope: string; classes: GrantClass[]; expiresAt?: string } | null {
  const covering = coveringGrants(id, now, home);
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
  const resolved = resolveGrant(identityForState(state), now, deps.home);
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

/** The most specific live grant (`epic:` over `repo:`) covering an epic in `repo`; the wave review's gate. */
export function grantForEpic(
  epic: string,
  repo: string,
  now: Date,
  home?: string,
): ScopedGrant | null {
  return coveringGrants({ slug: "", epic, repo }, now, home)[0] ?? null;
}
