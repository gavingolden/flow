/**
 * The committed branch diff the design review keys on. One implementation so
 * the verify-time gate and the auto-merge backstop never disagree on the base:
 * the PR base when known, else the repo's default branch. Never
 * `git diff HEAD` — that is uncommitted-only and empty after implement commits.
 */
import { resolveDefaultBranch, type Spawner } from "./git";
import { spawnSync } from "node:child_process";

export type DiffDeps = { spawn?: Spawner };

const defaultSpawn: Spawner = (cmd, args, options) =>
  spawnSync(cmd, args, options);

function nameOnly(
  worktree: string,
  range: string,
  spawn: Spawner,
): string[] | null {
  const r = spawn("git", ["diff", "--name-only", range], {
    cwd: worktree,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").split("\n").filter((l) => l.length > 0);
}

/** `git diff --name-only origin/<base>...HEAD`, or null on any git failure. */
export function branchChangedFiles(
  worktree: string,
  base?: string | null,
  deps: DiffDeps = {},
): string[] | null {
  const spawn = deps.spawn ?? defaultSpawn;
  const name = base || resolveDefaultBranch(worktree, spawn);
  if (!name) return null;
  return nameOnly(worktree, `origin/${name}...HEAD`, spawn);
}

/** Files changed between a recorded commit and HEAD; null when unreadable. */
export function changedSinceCommit(
  worktree: string,
  sha: string,
  deps: DiffDeps = {},
): string[] | null {
  return nameOnly(worktree, `${sha}...HEAD`, deps.spawn ?? defaultSpawn);
}
