import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./git";

export type FlowRootInfo = {
  isWorktree: boolean;
  canonicalRoot: string | null;
};

/**
 * Reports whether `dir` is a secondary git worktree (as opposed to the
 * primary checkout) and, when it is, derives the canonical flow checkout
 * from the shared `--git-common-dir`. Modeled on `worktree-marker.ts`'s
 * `ensureFlowExcludes` (same `--git-common-dir` + relative-resolve idiom,
 * same `git` import from `./git`) — but unlike that helper, this one is
 * FAIL OPEN: `git()` throws on any non-zero exit, including "not a git
 * repository", so every call here is wrapped in try/catch. This is
 * load-bearing, not defensive boilerplate — `bin/lib/setup.test.ts` and
 * `bin/lib/setup-args.test.ts` exercise ~50 cases against plain non-repo
 * tmpdir fixtures, all of which must see this guard degrade to inert
 * (`{ isWorktree: false, canonicalRoot: null }`) rather than throw.
 */
/** Resolves symlinks (e.g. macOS's /var -> /private/var) when possible,
 * falling back to the unresolved path so a not-yet-created target still
 * compares consistently rather than throwing. */
function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export function inspectFlowRoot(
  dir: string,
  run: (args: string[], cwd?: string) => string = git,
): FlowRootInfo {
  try {
    const gitDir = realOrSelf(run(["rev-parse", "--absolute-git-dir"], dir));
    const rawCommonDir = run(["rev-parse", "--git-common-dir"], dir);
    const commonDirAbs = path.isAbsolute(rawCommonDir)
      ? rawCommonDir
      : path.resolve(realOrSelf(dir), rawCommonDir);
    const commonDir = realOrSelf(commonDirAbs);

    const isWorktree = gitDir !== commonDir;

    let canonicalRoot: string | null = null;
    if (path.basename(commonDir) === ".git") {
      const candidateRoot = path.dirname(commonDir);
      const hasFlowBin = fs.existsSync(path.join(candidateRoot, "bin", "flow"));
      const hasSkills = fs.existsSync(path.join(candidateRoot, "skills"));
      if (hasFlowBin && hasSkills) canonicalRoot = candidateRoot;
    }

    return { isWorktree, canonicalRoot };
  } catch {
    return { isWorktree: false, canonicalRoot: null };
  }
}
