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

// Returns the *primary* (main) worktree path even when called from inside a
// secondary worktree. `--git-common-dir` resolves to `<main>/.git` (or the
// `.git/worktrees/<name>` subdir's parent for a child worktree); stripping
// the trailing `.git` gives us the main worktree.
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
    // Bare repos and other non-standard layouts — fall back to show-toplevel.
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
