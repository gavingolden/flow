/**
 * Resolving what a `flow grant` scope points at: the pipelines it covers, and
 * (for a grant being written) the repo name and, for an epic, the checkout that
 * carries its manifest.
 */

import { epicDirRelative, loadManifestFromRepo } from "./epic-manifest-schema";
import {
  identityForState,
  repoNameForPath,
  type PipelineIdentity,
  type Scope,
} from "./manager-scope";
import { listStates, readState } from "./state";

export function identitiesFor(
  scope: Scope,
  stateDir?: string,
): PipelineIdentity[] {
  if (scope.kind === "repo") return [];
  if (scope.kind === "pipeline") {
    const s = readState(scope.id, stateDir);
    return s ? [identityForState(s)] : [];
  }
  return listStates(stateDir)
    .filter((s) => s.epic?.slug === scope.id)
    .map(identityForState);
}

export type Target =
  | { repo: string; epicRoot?: string; warnings: string[] }
  | { error: string };

export function resolveScopeTarget(
  scope: Scope,
  currentRepoRoot: string | null,
  stateDir?: string,
): Target {
  if (scope.kind === "pipeline") {
    const s = readState(scope.id, stateDir);
    if (!s) {
      return {
        error: `no pipeline '${scope.id}' has a state file — run 'flow ls' to see the live slugs.`,
      };
    }
    return { repo: identityForState(s).repo, warnings: [] };
  }
  if (scope.kind === "repo") {
    const known = [
      ...new Set(listStates(stateDir).map((s) => identityForState(s).repo)),
    ].sort();
    const current = currentRepoRoot ? repoNameForPath(currentRepoRoot) : null;
    const warnings =
      known.includes(scope.id) || scope.id === current
        ? []
        : [
            `no pipeline of a repo named '${scope.id}' is known (known repos: ${known.join(", ") || "none"}) — check the spelling.`,
          ];
    return { repo: scope.id, warnings };
  }
  const roots: string[] = [];
  for (const s of listStates(stateDir)) {
    if (s.epic?.slug !== scope.id) continue;
    for (const r of [s.repo, s.worktree]) if (r) roots.push(r);
  }
  if (currentRepoRoot) roots.push(currentRepoRoot);
  const root = roots.find((r) => loadManifestFromRepo(scope.id, r) !== null);
  if (!root) {
    return {
      error: `no valid manifest for epic '${scope.id}' under ${epicDirRelative(scope.id)} in any repo that carries it — merge the design PR first.`,
    };
  }
  return { repo: repoNameForPath(root), epicRoot: root, warnings: [] };
}
