import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

/** Maximum auto-suffix attempts before giving up on collision avoidance. */
export const MAX_SUFFIX_ATTEMPTS = 100;

/** Converts a branch name to a directory-safe suffix (e.g. feature/foo → feature-foo). */
export function toDirSuffix(branchName: string): string {
  return branchName.replace(/\//g, "-");
}

function git(args: string[], cwd?: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(stderr || `git ${args[0]} failed with exit code ${result.status}`);
  }
  return (result.stdout ?? "").trim();
}

/** Returns true when the named branch ref exists locally. */
export function branchExists(branchName: string, repoDir: string): boolean {
  try {
    git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repoDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Picks the first non-colliding (branch, worktreeDir) pair starting from the
 * literal pair, then `<slug>-2`, `<slug>-3`, ..., up to MAX_SUFFIX_ATTEMPTS.
 * The first attempt uses the bare slug (no `-1` suffix) — only collisions
 * trigger numeric suffixing.
 */
export function findAvailableSlot(
  initialBranch: string,
  initialDir: string,
  repoDir: string,
): { branchName: string; worktreeDir: string } {
  for (let i = 1; i <= MAX_SUFFIX_ATTEMPTS; i++) {
    const branchName = i === 1 ? initialBranch : `${initialBranch}-${i}`;
    const worktreeDir = i === 1 ? initialDir : `${initialDir}-${i}`;
    if (!branchExists(branchName, repoDir) && !fs.existsSync(worktreeDir)) {
      return { branchName, worktreeDir };
    }
  }
  throw new Error(
    `flow-new-worktree: could not find an available slot after ${MAX_SUFFIX_ATTEMPTS} attempts ` +
      `(starting from ${initialBranch}). If this many parallel pipelines are intentional, ` +
      `clean up stale worktrees first with 'git worktree list' / 'flow done'.`,
  );
}
