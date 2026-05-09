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
import { spawnSync } from "node:child_process";

export type LinkResult = "created" | "updated" | "exists" | "blocked";

export type RemoveOptions = {
  /** Canonical install root (a git checkout). When supplied with `defaultBranch`,
   *  enables the PR #115 race backstop: if the recorded source is in
   *  `origin/<defaultBranch>`'s tree but not the working tree, preserve the
   *  symlink (a `git pull` would restore the file). Backstop fails OPEN —
   *  any spawn failure falls through to today's dangling-reap behaviour. */
  canonicalRoot?: string;
  /** Default branch name (e.g. "main"); paired with `canonicalRoot`. */
  defaultBranch?: string;
  /** Optional log callback for the "skipped: ..." backstop message. */
  log?: (msg: string) => void;
};

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
export function removeIfManagedSymlink(
  target: string,
  recordedSource: string,
  opts?: RemoveOptions,
): boolean {
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
    if (shouldDeferDanglingReap(recordedSource, opts)) {
      const branch = opts!.defaultBranch!;
      const root = opts!.canonicalRoot!;
      opts?.log?.(
        `  ! ${path.basename(target)}  (skipped: exists on origin/${branch} but not in canonical working tree — run \`cd ${root} && git pull && flow setup --upgrade\`)`,
      );
      return false;
    }
    fs.unlinkSync(target);
    return true;
  }

  return false;
}

/**
 * PR #115 race backstop. Returns true when:
 *   - opts supplies canonicalRoot AND defaultBranch AND the canonicalRoot
 *     looks like a git repo (the spawn calls succeed), AND
 *   - the recordedSource's path-relative-to-canonicalRoot is present in
 *     `git ls-tree -r origin/<defaultBranch> --name-only` output, AND
 *   - the same path is NOT present in the canonical working tree.
 *
 * Fails OPEN — any spawn failure (canonical not a git repo, git not on PATH,
 * malformed branch resolution) returns false so the legacy dangling-reap
 * behavior fires. This is critical for the PR #79 regression test fixture
 * (no .git directory) which expects the legacy reap to fire.
 */
function shouldDeferDanglingReap(recordedSource: string, opts: RemoveOptions | undefined): boolean {
  if (!opts || !opts.canonicalRoot || !opts.defaultBranch) return false;
  const recordedAbs = path.resolve(recordedSource);
  const rel = path.relative(opts.canonicalRoot, recordedAbs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  try {
    const tree = spawnSync(
      "git",
      ["-C", opts.canonicalRoot, "ls-tree", "-r", `origin/${opts.defaultBranch}`, "--name-only"],
      { encoding: "utf8" },
    );
    if (tree.status !== 0) return false;
    // `ls-tree -r` lists blob (file) paths, not directories. The recorded
    // source can be either a file (helper binary) or a directory (skill).
    // Treat both — present in-tree means an exact-match line OR any line
    // whose path starts with `<rel>/`.
    const prefix = rel + "/";
    const inTree = (tree.stdout ?? "").split("\n").some((line) => {
      const trimmed = line.trim();
      return trimmed === rel || trimmed.startsWith(prefix);
    });
    if (!inTree) return false;
    if (fs.existsSync(recordedAbs)) return false;
    return true;
  } catch {
    return false;
  }
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
