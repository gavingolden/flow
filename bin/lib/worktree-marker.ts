import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./git";
import { applyManagedBlock, readGitignore, writeGitignore } from "./gitignore";

/** Filename of the worktree-local branch marker, read by flow-state-update's guard. */
export const BRANCH_MARKER_FILENAME = ".flow-branch";

/** Filename used for the supervisor + sub-skill scratch directory inside each worktree. */
export const FLOW_TMP_DIRNAME = ".flow-tmp/";

/** Writes the worktree-local branch-name marker that flow-state-update reads. */
export function writeBranchMarker(worktreeDir: string, branchName: string): void {
  fs.writeFileSync(path.join(worktreeDir, BRANCH_MARKER_FILENAME), branchName + "\n", "utf8");
}

/**
 * Adds `.flow-tmp/` to the worktree's per-checkout `.git/info/exclude` so the
 * supervisor's scratch dir stays untracked without polluting the user's
 * repo-tracked `.gitignore`. Idempotent — only writes when the line is missing.
 *
 * Uses `git rev-parse --git-dir` from inside the worktree so the right
 * `info/exclude` resolves under `.git/worktrees/<name>/info/exclude` for
 * secondary worktrees, not the primary repo's `.git/info/exclude`.
 */
export function ensureFlowTmpExclude(worktreeDir: string): void {
  const gitDir = git(["rev-parse", "--git-dir"], worktreeDir);
  const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(worktreeDir, gitDir);
  const excludePath = path.join(absGitDir, "info", "exclude");
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });

  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  const lines = existing.split("\n");
  if (lines.some((line) => line.trim() === FLOW_TMP_DIRNAME)) return;

  const trailingNewline = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(excludePath, existing + trailingNewline + FLOW_TMP_DIRNAME + "\n", "utf8");
}

/**
 * Ensures the primary repo's .gitignore contains a `# managed by flow runtime`
 * block listing the branch-marker filename. Idempotent — replaces the block in
 * place if already present.
 */
export function ensureGitignoreMarkerEntry(primaryDir: string): void {
  const existing = readGitignore(primaryDir) ?? "";
  const next = applyManagedBlock(existing, {
    tag: "runtime",
    paths: [BRANCH_MARKER_FILENAME],
  });
  if (next !== existing) writeGitignore(primaryDir, next);
}
