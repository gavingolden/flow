/**
 * Symlink primitives for `flow setup`.
 *
 * The "managed symlink" rule: a symlink at the install target is owned by
 * flow if and only if it points to a path under `<flow-source>/`. Real files
 * are never deleted; only flow-owned symlinks are touched. Without --force,
 * any non-symlink at the target blocks the install (preserves user-authored
 * content with the same name).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type LinkResult = "created" | "updated" | "exists" | "blocked";

/**
 * Ensures `target` is a symlink pointing at `source`. Returns the action
 * taken so the caller can summarise. Resolves source to its real path so
 * the recorded link target isn't itself a symlink (avoids long chains).
 */
export function ensureSymlink(target: string, source: string, force: boolean): LinkResult {
  const realSource = fs.realpathSync(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const existing = readSymlink(target);
  if (existing !== null) {
    const existingResolved = path.resolve(path.dirname(target), existing);
    if (existingResolved === realSource) return "exists";
    fs.unlinkSync(target);
    fs.symlinkSync(realSource, target);
    return "updated";
  }

  const stat = lstatOrNull(target);
  if (stat) {
    // Real file or directory at target. Refuse without --force.
    if (!force || stat.isDirectory()) return "blocked";
    fs.unlinkSync(target);
    fs.symlinkSync(realSource, target);
    return "updated";
  }

  fs.symlinkSync(realSource, target);
  return "created";
}

/**
 * Removes `target` only if it's a symlink we own per the manifest's recorded
 * source. Returns true if removed, false otherwise.
 *
 * The check has two branches:
 *   1. The on-disk symlink points at the recorded source (with realpath
 *      canonicalization on both sides — `ensureSymlink` writes realpath'd
 *      pointers, and platform-level canonicalization like /var → /private/var
 *      on macOS would otherwise yield false negatives). Remove — still ours.
 *   2. The symlink is dangling (link target does not exist on disk). Remove —
 *      we recorded this target and the file the link pointed at is gone, so
 *      reaping it is safe even if the pointer no longer references the
 *      recorded source. This is the cleanup path for legacy damage left by
 *      prior `--source <worktree>` runs whose worktree was removed
 *      post-merge.
 *
 * Working symlinks pointing somewhere unexpected (the user replaced ours
 * with their own that still resolves) are preserved.
 */
export function removeIfManagedSymlink(target: string, recordedSource: string): boolean {
  const link = readSymlink(target);
  if (link === null) return false;
  const resolved = path.resolve(path.dirname(target), link);

  const recordedAbs = path.resolve(recordedSource);
  let recordedReal: string | null = null;
  try {
    recordedReal = fs.realpathSync(recordedSource);
  } catch {
    // Recorded source no longer exists — fall through to the dangling check.
  }

  if (resolved === recordedAbs || (recordedReal !== null && resolved === recordedReal)) {
    fs.unlinkSync(target);
    return true;
  }

  if (!fs.existsSync(resolved)) {
    fs.unlinkSync(target);
    return true;
  }

  return false;
}

function readSymlink(p: string): string | null {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}
