import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./git";
import { FLOW_CACHE_DIR, repoCacheKey } from "./paths";

/** Files symlinked from the primary repo into each new worktree. */
export const SYMLINK_FILES = [".env", ".claude/settings.local.json"];

const log = {
  success: (msg: string) => console.log(`✅ ${msg}`),
  warn: (msg: string) => console.warn(`⚠️  ${msg}`),
};

/** Returns the primary (main) worktree directory, even when run from a secondary worktree. */
export function getPrimaryDir(repoDir: string): string {
  const raw = git(["worktree", "list", "--porcelain"], repoDir);
  const firstLine = raw.split("\n")[0];
  if (!firstLine?.startsWith("worktree ")) return repoDir;
  return firstLine.slice("worktree ".length);
}

/**
 * Tries origin/HEAD first, then conventional defaults verified against the
 * remote. Throws rather than returning "HEAD" — that would fail downstream
 * ref validation with a less obvious error.
 */
export function detectDefaultBranch(repoDir: string): string {
  try {
    const ref = git(["symbolic-ref", "refs/remotes/origin/HEAD"], repoDir);
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    // origin/HEAD not set — fall through to conventional defaults
  }
  for (const candidate of ["main", "master"]) {
    try {
      git(
        ["rev-parse", "--verify", `refs/remotes/origin/${candidate}`],
        repoDir,
      );
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(
    "Could not auto-detect the default branch. Pass it explicitly as the second argument.",
  );
}

export function validateReusable(
  worktreeDir: string,
  expectedBranch: string,
): void {
  if (!fs.existsSync(worktreeDir)) {
    throw new Error(`--reuse: no worktree at ${worktreeDir} to reuse`);
  }
  if (!fs.existsSync(path.join(worktreeDir, ".git"))) {
    throw new Error(
      `--reuse: ${worktreeDir} is not a git worktree (no .git entry)`,
    );
  }
  const current = git(["branch", "--show-current"], worktreeDir);
  if (current !== expectedBranch) {
    throw new Error(
      `--reuse: ${worktreeDir} is on branch '${current}', expected '${expectedBranch}'`,
    );
  }
}

export function symlinkSharedFiles(
  worktreeDir: string,
  primaryDir: string,
): void {
  for (const relPath of SYMLINK_FILES) {
    const source = path.join(primaryDir, relPath);
    const target = path.join(worktreeDir, relPath);
    if (!fs.existsSync(source)) {
      log.warn(`No ${relPath} found to symlink`);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || stat.isFile()) {
        fs.unlinkSync(target);
      } else {
        log.warn(
          `Skipping symlink for ${relPath}: target exists and is not a file or symlink`,
        );
        continue;
      }
    }
    fs.symlinkSync(source, target);
    log.success(`Symlinked ${relPath}`);
  }
}

/**
 * Symlinks `<worktreeDir>/.claude/agent-memory-local` to a per-repo cache
 * dir under `cacheRoot` so `memory: local` agents (flow-discovery,
 * flow-scout) get a handoff that survives worktree removal — confirmed
 * cwd-relative resolution + symlink-followed writes via the live probe
 * (`docs/subagent-features-probe.md`). Idempotent: a pre-existing symlink
 * that already points at this repo's cache dir is left alone; a symlink
 * pointing anywhere else (including a dangling one, or a repo-committed
 * symlink aimed at an untrusted path) is replaced; a pre-existing REAL
 * directory is never replaced (mirrors `symlinkSharedFiles`'s own
 * non-file/non-symlink skip — never widen scope to clobber a real
 * directory).
 */
export function linkAgentMemory(
  worktreeDir: string,
  primaryDir: string,
  cacheRoot: string = FLOW_CACHE_DIR,
): void {
  const target = path.join(worktreeDir, ".claude", "agent-memory-local");
  const cacheDir = path.join(
    cacheRoot,
    repoCacheKey(primaryDir),
    "agent-memory-local",
  );
  // `fs.existsSync` follows symlinks, so it returns `false` for a dangling
  // link (cache target wiped) and falls through to `symlinkSync` below,
  // which then throws EEXIST because the link path is still occupied.
  // `lstatSync` on the link path itself avoids that trap.
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(target);
  } catch {
    stat = undefined; // absent
  }
  if (stat?.isSymbolicLink()) {
    const current = fs.readlinkSync(target);
    const resolvedCurrent = path.resolve(path.dirname(target), current);
    if (resolvedCurrent === cacheDir) return; // already linked, idempotent no-op
    // Don't trust a pre-existing link's target — a repo could commit a
    // symlink at this path (a tracked path is still checked out by
    // `git worktree add`) pointing somewhere hostile, e.g. absolute paths
    // under the user's own `~/.claude`. Replace it with our own link.
    log.warn(`Replacing agent-memory-local symlink that pointed at ${current}`);
    fs.unlinkSync(target);
  } else if (stat) {
    log.warn(
      "Skipping agent-memory-local symlink: target exists and is a real directory",
    );
    return;
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(cacheDir, target);
  log.success("Symlinked .claude/agent-memory-local");
}

/**
 * Best-effort salvage of `<worktreeDir>/.claude/agent-memory-local` before
 * the worktree is removed. A no-op when the path is a symlink (its target
 * — the cache dir — already survives removal on its own) or absent; when
 * it is a REAL directory (the symlink was never written through, or a
 * caller wrote directly into it), copies its contents into the cache dir.
 * Never throws — this runs on the removal path and must not block cleanup.
 */
export function salvageAgentMemory(
  worktreeDir: string,
  primaryDir: string,
  cacheRoot: string = FLOW_CACHE_DIR,
): void {
  const target = path.join(worktreeDir, ".claude", "agent-memory-local");
  try {
    if (!fs.existsSync(target)) return;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    const cacheDir = path.join(
      cacheRoot,
      repoCacheKey(primaryDir),
      "agent-memory-local",
    );
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.cpSync(target, cacheDir, { recursive: true });
    log.success("Salvaged agent-memory-local into the cache dir");
  } catch (err) {
    log.warn(
      `Could not salvage agent-memory-local: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
