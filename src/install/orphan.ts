import fs from "node:fs/promises";
import path from "node:path";

/**
 * Try to remove an orphan install-target path.
 *
 * Returns `true` iff the path is an actual symlink whose target resolves
 * under flow's source tree (i.e. flow definitely managed it). Real files,
 * real directories, and symlinks pointing outside `sourceRoot` are user-owned
 * and left alone. The gitignore entry for the orphan drops out either way on
 * the next `updateGitignoreBlock` call.
 *
 * Path safety:
 * `gitignorePath` comes from the managed `.gitignore` block, which is data
 * the user (or an attacker submitting a PR) can influence. A line like
 * `/../outside/something` would, after normalisation, escape `repoRoot` and
 * could direct `fs.unlink` at a symlink anywhere on disk. We require:
 *   1. The path starts with `expectedPrefix` (`/scripts/` or
 *      `/.claude/skills/`) — the only managed install targets.
 *   2. After resolution, the path remains strictly inside `repoRoot`.
 * Anything else short-circuits to `false` without touching the filesystem.
 */
export async function removeOrphanIfManaged(args: {
  repoRoot: string;
  gitignorePath: string;
  sourceRoot: string;
  expectedPrefix: string;
}): Promise<boolean> {
  const { repoRoot, gitignorePath, sourceRoot, expectedPrefix } = args;

  if (!gitignorePath.startsWith(expectedPrefix)) return false;

  const repoRootAbs = path.resolve(repoRoot);
  const targetPath = path.resolve(repoRootAbs, gitignorePath.slice(1));
  const containment = path.relative(repoRootAbs, targetPath);
  if (
    containment === "" ||
    containment.startsWith("..") ||
    path.isAbsolute(containment)
  ) {
    return false;
  }

  const link = await readLink(targetPath);
  if (link === null) return false;

  const resolved = path.resolve(path.dirname(targetPath), link);
  const sourceRel = path.relative(sourceRoot, resolved);
  if (
    sourceRel === "" ||
    sourceRel.startsWith("..") ||
    path.isAbsolute(sourceRel)
  ) {
    return false;
  }

  await fs.unlink(targetPath);
  return true;
}

async function readLink(p: string): Promise<string | null> {
  try {
    return await fs.readlink(p);
  } catch {
    return null;
  }
}
