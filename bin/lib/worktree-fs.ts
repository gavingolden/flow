import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./git";

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
      git(["rev-parse", "--verify", `refs/remotes/origin/${candidate}`], repoDir);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(
    "Could not auto-detect the default branch. Pass it explicitly as the second argument.",
  );
}

export function validateReusable(worktreeDir: string, expectedBranch: string): void {
  if (!fs.existsSync(worktreeDir)) {
    throw new Error(`--reuse: no worktree at ${worktreeDir} to reuse`);
  }
  if (!fs.existsSync(path.join(worktreeDir, ".git"))) {
    throw new Error(`--reuse: ${worktreeDir} is not a git worktree (no .git entry)`);
  }
  const current = git(["branch", "--show-current"], worktreeDir);
  if (current !== expectedBranch) {
    throw new Error(
      `--reuse: ${worktreeDir} is on branch '${current}', expected '${expectedBranch}'`,
    );
  }
}

export function symlinkSharedFiles(worktreeDir: string, primaryDir: string): void {
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
        log.warn(`Skipping symlink for ${relPath}: target exists and is not a file or symlink`);
        continue;
      }
    }
    fs.symlinkSync(source, target);
    log.success(`Symlinked ${relPath}`);
  }
}
