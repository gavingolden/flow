import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Shared repo-root resolver. Consolidates four divergent copies that used to
 * live at `bin/lib/feature.ts`, `bin/lib/epic.ts`, `bin/flow-epic-sync.ts`,
 * and `bin/flow-epic-membership.ts`.
 */
export function resolveRepoRoot(cwd: string): string | null {
  // node:child_process spawnSync (not Bun.spawnSync) so the vitest cases run
  // under node — Bun.spawnSync is undefined in the vitest worker. Production
  // runs through bin/flow (bun-shebanged), so node-compat here costs nothing.
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  if (!out || !fs.existsSync(out)) return null;
  return out;
}

/**
 * Resolves the repository's shared git dir (`--git-common-dir`), which is
 * byte-identical for a main checkout and every linked worktree of it, and
 * differs across separate repositories. Used to detect when two paths
 * belong to the same repository regardless of which worktree each is in.
 */
export function resolveGitCommonDir(cwd: string): string | null {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  if (!out) return null;
  // git returns a RELATIVE path ('.git', '../.git') from a main checkout but
  // an ABSOLUTE path from a linked worktree — resolve against cwd, not
  // process.cwd().
  const resolved = path.resolve(cwd, out);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}
