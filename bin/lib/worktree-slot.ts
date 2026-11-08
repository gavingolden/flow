import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./git";

/** Maximum auto-suffix attempts before giving up on collision avoidance. */
export const MAX_SUFFIX_ATTEMPTS = 100;

/**
 * Folder beside the main checkout that holds every flow worktree. The
 * `.noindex` suffix is what keeps Spotlight out of it.
 */
export const WORKTREE_CONTAINER_NAME = "flow-worktrees.noindex";

/** Converts a branch name to a directory-safe suffix (e.g. feature/foo → feature-foo). */
export function toDirSuffix(branchName: string): string {
  return branchName.replace(/\//g, "-");
}

export function worktreeContainerDir(repoDir: string): string {
  const parent = path.dirname(repoDir);
  if (path.basename(parent) === WORKTREE_CONTAINER_NAME) return parent;
  return path.join(parent, WORKTREE_CONTAINER_NAME);
}

/** `<repo-parent>/flow-worktrees.noindex/<repo>-<branch suffix>`. */
export function worktreeDirFor(repoDir: string, branchName: string): string {
  return path.join(
    worktreeContainerDir(repoDir),
    `${path.basename(repoDir)}-${toDirSuffix(branchName)}`,
  );
}

function firstSegment(from: string, p: string): string | undefined {
  const rel = path.relative(from, p);
  if (!rel || path.isAbsolute(rel)) return undefined;
  const seg = rel.split(path.sep)[0];
  return seg === ".." ? undefined : seg;
}

/**
 * True when `p` is at or under a flow worktree folder of `repoDir`, in either
 * the container or the old sibling spot. The sibling branch skips the
 * container: a repo named `flow` shares the `flow-` prefix with it.
 */
export function isFlowWorktreePath(repoDir: string, p: string): boolean {
  const prefix = `${path.basename(repoDir)}-`;
  const inContainer = firstSegment(worktreeContainerDir(repoDir), p);
  if (inContainer?.startsWith(prefix)) return true;
  const sibling = firstSegment(path.dirname(repoDir), p);
  return (
    sibling !== undefined &&
    sibling !== WORKTREE_CONTAINER_NAME &&
    sibling.startsWith(prefix)
  );
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
  fs.mkdirSync(path.dirname(initialDir), { recursive: true });
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
