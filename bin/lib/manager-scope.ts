/**
 * The one scope grammar shared by grants and `scope.json`: `pipeline:<slug>`,
 * `epic:<slug>`, `repo:<name>`. There is no `all` — the widest scope is one
 * repo.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { managerFile, managerHome, writeJsonAtomic } from "./manager-home";
import { resolveGitCommonDir } from "./repo-root";
import { isValidSlug } from "./slug";
import { FINISHED_PHASE_SET, readState, type PipelineState } from "./state";

export type ScopeKind = "pipeline" | "epic" | "repo";
export type Scope = { kind: ScopeKind; id: string };

export const ALLOWED_SCOPE_KINDS =
  "pipeline:<slug>, epic:<slug> or repo:<name>";

export function parseScope(s: string): Scope | null {
  const m = /^(pipeline|epic|repo):(.+)$/.exec(s);
  if (!m) return null;
  const kind = m[1] as ScopeKind;
  const id = m[2];
  if (kind === "repo") {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return null;
  } else if (!isValidSlug(id)) {
    return null;
  }
  return { kind, id };
}

export function formatScope(s: Scope): string {
  return `${s.kind}:${s.id}`;
}

export type PipelineIdentity = { slug: string; epic?: string; repo: string };

/** Basename of the main checkout, so a linked worktree resolves to its repo's name. */
export function canonicalRepoName(cwd: string): string | null {
  const common = resolveGitCommonDir(cwd);
  if (!common) return null;
  const top = path.basename(common) === ".git" ? path.dirname(common) : common;
  return path.basename(top) || null;
}

/** The repo name for a recorded repo path: the main checkout's basename when the path still exists, else its own basename. */
export function repoNameForPath(repoPath: string): string {
  const canonical =
    repoPath && fs.existsSync(repoPath) ? canonicalRepoName(repoPath) : null;
  return canonical ?? path.basename(repoPath);
}

export function identityForState(s: PipelineState): PipelineIdentity {
  return {
    slug: s.slug,
    ...(s.epic ? { epic: s.epic.slug } : {}),
    repo: repoNameForPath(s.repo),
  };
}

export function scopeMatches(s: Scope, id: PipelineIdentity): boolean {
  if (s.kind === "pipeline") return id.slug === s.id;
  if (s.kind === "epic") return id.epic === s.id;
  return id.repo === s.id;
}

/** Narrower is higher: pipeline 3, epic 2, repo 1. */
export function specificity(s: Scope): 1 | 2 | 3 {
  return s.kind === "pipeline" ? 3 : s.kind === "epic" ? 2 : 1;
}

export type ScopeFile = {
  version: 1;
  scopes: string[];
  updatedAt: string;
  source: "cli" | "owner-words";
};

function scopePath(home?: string): string {
  return managerFile("scope.json", home ?? managerHome());
}

/** Tolerant: a missing file or an invalid shape reads as null. */
export function readScope(home?: string): ScopeFile | null {
  try {
    const v = JSON.parse(fs.readFileSync(scopePath(home), "utf8")) as ScopeFile;
    if (
      v?.version === 1 &&
      Array.isArray(v.scopes) &&
      v.scopes.every((x) => typeof x === "string" && parseScope(x) !== null) &&
      typeof v.updatedAt === "string" &&
      (v.source === "cli" || v.source === "owner-words")
    ) {
      return v;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeScope(f: ScopeFile, home?: string): void {
  writeJsonAtomic(scopePath(home), f);
}

/** Is `slug` inside the manager's stated scope? A missing file or state covers nothing. */
export function scopeCovers(
  slug: string,
  deps: { stateDir?: string; home?: string } = {},
): boolean {
  const file = readScope(deps.home);
  if (!file) return false;
  const state = readState(slug, deps.stateDir);
  if (!state || FINISHED_PHASE_SET.has(state.phase)) return false;
  const id = identityForState(state);
  return file.scopes.some((raw) => {
    const sc = parseScope(raw);
    return sc !== null && scopeMatches(sc, id);
  });
}
