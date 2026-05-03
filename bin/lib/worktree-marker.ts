import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./git";

/** Filename of the worktree-local branch marker, read by flow-state-update's guard. */
export const BRANCH_MARKER_FILENAME = ".flow-branch";

/** Filename used for the supervisor + sub-skill scratch directory inside each worktree. */
export const FLOW_TMP_DIRNAME = ".flow-tmp/";

/** Paths that flow writes into each worktree but doesn't track in git. */
const FLOW_EXCLUDE_PATHS = [BRANCH_MARKER_FILENAME, FLOW_TMP_DIRNAME] as const;

/** Writes the worktree-local branch-name marker that flow-state-update reads. */
export function writeBranchMarker(worktreeDir: string, branchName: string): void {
  fs.writeFileSync(path.join(worktreeDir, BRANCH_MARKER_FILENAME), branchName + "\n", "utf8");
}

/**
 * Adds flow-owned filenames (`.flow-branch`, `.flow-tmp/`) to the shared
 * `.git/info/exclude` so they stay untracked across every worktree of the repo
 * without polluting the user's tracked `.gitignore`. Idempotent — only writes
 * lines that are missing.
 *
 * Resolves via `git rev-parse --git-common-dir`, not `--git-dir`. Git reads
 * `info/exclude` from the *common* dir (the primary repo's `.git/info/`),
 * never from a secondary worktree's `.git/worktrees/<name>/info/`, so writing
 * to the per-worktree path would be a silent no-op — `git status` would still
 * list flow's marker files as untracked. The idempotency check below also
 * makes the shared file safe under N concurrent worktrees: each one greps
 * before appending.
 */
export function ensureFlowExcludes(worktreeDir: string): void {
  const commonDir = git(["rev-parse", "--git-common-dir"], worktreeDir);
  const absCommonDir = path.isAbsolute(commonDir) ? commonDir : path.join(worktreeDir, commonDir);
  const excludePath = path.join(absCommonDir, "info", "exclude");
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });

  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  const present = new Set(existing.split("\n").map((l) => l.trim()));
  const toAdd = FLOW_EXCLUDE_PATHS.filter((p) => !present.has(p));
  if (toAdd.length === 0) return;

  const trailingNewline = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(excludePath, existing + trailingNewline + toAdd.join("\n") + "\n", "utf8");
}
