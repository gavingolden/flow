import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./git";

/** Maximum auto-suffix attempts before giving up on collision avoidance. */
export const MAX_SUFFIX_ATTEMPTS = 100;

/** Converts a branch name to a directory-safe suffix (e.g. feature/foo → feature-foo). */
export function toDirSuffix(branchName: string): string {
  return branchName.replace(/\//g, "-");
}

/** Returns true when the named branch ref exists locally. */
export function branchExists(branchName: string, repoDir: string): boolean {
  try {
    git(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
      repoDir,
    );
    return true;
  } catch {
    return false;
  }
}

/** True when `dir` exists and is a directory with no entries. */
function isEmptyDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

function resolveForCompare(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Picks the first non-colliding (branch, worktreeDir) pair starting from the
 * literal pair, then `<slug>-2`, `<slug>-3`, ..., up to MAX_SUFFIX_ATTEMPTS.
 * The first attempt uses the bare slug (no `-1` suffix) — only collisions
 * trigger numeric suffixing. A slot whose dir is the launch-reserved EMPTY
 * folder (`reservedDir`) counts as available; the branch must still be free.
 */
export function findAvailableSlot(
  initialBranch: string,
  initialDir: string,
  repoDir: string,
  reservedDir?: string,
): { branchName: string; worktreeDir: string } {
  const reserved = reservedDir ? resolveForCompare(reservedDir) : undefined;
  for (let i = 1; i <= MAX_SUFFIX_ATTEMPTS; i++) {
    const branchName = i === 1 ? initialBranch : `${initialBranch}-${i}`;
    const worktreeDir = i === 1 ? initialDir : `${initialDir}-${i}`;
    if (branchExists(branchName, repoDir)) continue;
    if (
      !fs.existsSync(worktreeDir) ||
      (reserved !== undefined &&
        resolveForCompare(worktreeDir) === reserved &&
        isEmptyDir(worktreeDir))
    ) {
      return { branchName, worktreeDir };
    }
  }
  throw noSlotError(initialBranch);
}

function noSlotError(initialBranch: string): Error {
  return new Error(
    `flow-new-worktree: could not find an available slot after ${MAX_SUFFIX_ATTEMPTS} attempts ` +
      `(starting from ${initialBranch}). If this many parallel pipelines are intentional, ` +
      `clean up stale worktrees first with 'git worktree list' / 'flow done'.`,
  );
}

/**
 * Claims a slot at launch by creating its (empty) folder, so the folder exists
 * when Claude starts and `--add-dir` keeps it. Picks via findAvailableSlot
 * WITHOUT `reservedDir` (a racing launch must not adopt another run's stale
 * empty folder); races settle through the non-recursive mkdir's EEXIST.
 */
export function reserveWorktreeSlot(
  initialBranch: string,
  initialDir: string,
  repoDir: string,
): { branchName: string; worktreeDir: string } {
  for (let attempt = 0; attempt < MAX_SUFFIX_ATTEMPTS; attempt++) {
    const slot = findAvailableSlot(initialBranch, initialDir, repoDir);
    try {
      fs.mkdirSync(slot.worktreeDir);
      return slot;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }
  throw noSlotError(initialBranch);
}

/** Removes a reserved folder only when it is an empty directory. Never throws. */
export function releaseReservedWorktree(dir: string | undefined): void {
  if (!dir) return;
  try {
    if (isEmptyDir(dir)) fs.rmdirSync(dir);
  } catch {
    // best-effort cleanup
  }
}
