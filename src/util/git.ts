import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

export async function findGitRoot(cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "--show-toplevel"], {
      cwd,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

// Returns the *primary* (main) worktree path when called from the primary or
// any secondary worktree of a standard repo. `--git-common-dir` resolves to
// `<main>/.git` (the per-worktree subdir's parent for child worktrees);
// stripping the trailing `.git` gives the main worktree.
//
// Fallback: in non-standard layouts (bare repos where the common dir is
// `<name>.git` next to the working trees, custom GIT_DIR, or git invocation
// failures), this falls back to `findGitRoot`, which returns the *current*
// worktree's toplevel — i.e. the caller's worktree, not necessarily the
// primary one. Flow callers operate on plain working repos so the primary
// path is what's exercised in practice; the fallback exists to keep `flow
// start` working in unusual layouts at the cost of the canonical-root
// guarantee. Returns null only when the cwd isn't inside any git repo.
export async function findCanonicalRoot(
  cwd?: string,
): Promise<string | null> {
  try {
    const { stdout } = await execa(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd },
    );
    const commonDir = stdout.trim();
    if (commonDir.endsWith(`${path.sep}.git`) || commonDir.endsWith("/.git")) {
      return path.dirname(commonDir);
    }
    // Bare repos / custom GIT_DIR — fall back to the current worktree
    // toplevel. Documented limitation; see header comment.
    return findGitRoot(cwd);
  } catch {
    return findGitRoot(cwd);
  }
}

export async function findTaskFile(
  taskId: string,
  repoRoot: string,
): Promise<string | null> {
  const candidates = [
    path.join(repoRoot, ".orchestrator", "tasks", `${taskId}.md`),
    path.join(repoRoot, ".orchestrator", "tasks", "archive", `${taskId}.md`),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}
