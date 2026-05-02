import { spawnSync } from "node:child_process";

/**
 * Runs a git command and returns trimmed stdout. Throws on non-zero exit
 * with the trimmed stderr (or a synthetic "git <subcmd> failed" message).
 *
 * Shared by the worktree helpers — `bin/flow-new-worktree.ts`,
 * `bin/lib/worktree-slot.ts`, `bin/lib/worktree-marker.ts`,
 * `bin/lib/worktree-fs.ts`. Other `bin/lib/*` modules predate this helper
 * and inline `spawnSync` directly; migrate them opportunistically.
 */
export function git(args: string[], cwd?: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(stderr || `git ${args[0]} failed with exit code ${result.status}`);
  }
  return (result.stdout ?? "").trim();
}
