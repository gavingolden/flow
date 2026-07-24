import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./git";
import { getPrimaryDir } from "./worktree-fs";

export type HooksTarget = {
  mainWorktree: string;
  hooksDir: string;
  manager: "none" | "husky";
  sidecarDir: string;
};

/** Resolves symlinks when possible, falling back to the unresolved path. */
function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * A submodule's `--git-common-dir` resolves to
 * `<superproject>/.git/modules/<name>`, whose dirname is the superproject's
 * `.git`, not a worktree — detect that shape (a `/modules/` segment nested
 * under a `.git` dir) so a submodule launch guards its own checkout instead
 * of a bogus superproject-adjacent path.
 */
function looksLikeSubmoduleCommonDir(commonDir: string): boolean {
  const segments = commonDir.split(path.sep);
  const gitIdx = segments.lastIndexOf(".git");
  return gitIdx !== -1 && segments[gitIdx + 1] === "modules";
}

function isSubmodule(repoDir: string): boolean {
  try {
    const out = git(["rev-parse", "--show-superproject-working-tree"], repoDir);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolves the repo's MAIN (primary) worktree, never the ephemeral
 * per-worktree checkout a flow pipeline runs from. Three arms, each
 * individually fail-open:
 *   1. `--git-common-dir`, modeled on `worktree-source.ts`'s `inspectFlowRoot`
 *      idiom (NOT reused directly — `inspectFlowRoot` only returns a root
 *      when the candidate holds both `bin/flow` and `skills/`, so in any
 *      consumer repo it returns null and would silently reproduce the exact
 *      mis-target bug this module fixes).
 *   2. `getPrimaryDir` (porcelain `git worktree list` parse).
 *   3. `repoDir` itself.
 */
function resolveMainWorktree(repoDir: string): string {
  try {
    const rawCommonDir = git(["rev-parse", "--git-common-dir"], repoDir);
    const commonDirAbs = path.isAbsolute(rawCommonDir)
      ? rawCommonDir
      : path.resolve(realOrSelf(repoDir), rawCommonDir);
    const commonDir = realOrSelf(commonDirAbs);

    if (looksLikeSubmoduleCommonDir(commonDir) || isSubmodule(repoDir)) {
      // Inside a submodule, --git-common-dir resolves to the superproject's
      // .git/modules/<name>, whose dirname is NOT a worktree — guard the
      // submodule's own checkout instead of a bogus superproject-adjacent
      // path.
      return repoDir;
    }

    if (path.basename(commonDir) === ".git") {
      return path.dirname(commonDir);
    }
  } catch {
    // fall through to the next arm
  }

  try {
    return getPrimaryDir(repoDir);
  } catch {
    // fall through to the final fallback
  }

  return repoDir;
}

/** husky regenerates `hooksDir/_` on every install/commit; anything flow
 * writes there is destroyed on the next husky run. */
function detectManager(hooksDir: string): "none" | "husky" {
  if (path.basename(hooksDir) !== "_") return "none";
  const shSibling = path.join(hooksDir, "husky.sh");
  const hSibling = path.join(hooksDir, "h");
  if (fs.existsSync(shSibling) || fs.existsSync(hSibling)) return "husky";
  return "none";
}

/**
 * Resolves the hook-installation target for a repo: the MAIN worktree's
 * effective hooks dir (honouring `core.hooksPath`, absolute or relative),
 * and whether husky manages it. NEVER THROWS — every git invocation is
 * individually try/caught so a launch can never fail on hook-target
 * resolution.
 */
export function resolveHooksTarget(repoDir: string): HooksTarget {
  const mainWorktree = resolveMainWorktree(repoDir);

  let hooksDir: string;
  try {
    const p = git(["rev-parse", "--git-path", "hooks"], mainWorktree);
    hooksDir = path.isAbsolute(p) ? p : path.join(mainWorktree, p);
  } catch {
    hooksDir = path.join(mainWorktree, ".git", "hooks");
  }

  const manager = detectManager(hooksDir);
  const sidecarDir = manager === "husky" ? path.dirname(hooksDir) : hooksDir;

  return { mainWorktree, hooksDir, manager, sidecarDir };
}
