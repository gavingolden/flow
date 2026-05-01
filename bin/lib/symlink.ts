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
 * Removes `target` only if it's a symlink whose resolved path lives under
 * `flowSource`. Returns true if removed, false otherwise (so a user's own
 * symlink to an unrelated location is never reaped). flowSource is
 * realpath'd before comparison so platform-level path canonicalization
 * (e.g. /var → /private/var on macOS) doesn't yield false negatives.
 */
export function removeIfManagedSymlink(target: string, flowSource: string): boolean {
  const link = readSymlink(target);
  if (link === null) return false;
  const resolved = path.resolve(path.dirname(target), link);
  const realFlow = (() => {
    try {
      return fs.realpathSync(flowSource);
    } catch {
      return flowSource;
    }
  })();
  const matches = resolved === realFlow || resolved.startsWith(realFlow + path.sep);
  if (!matches) return false;
  fs.unlinkSync(target);
  return true;
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
