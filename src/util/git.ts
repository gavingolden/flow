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
