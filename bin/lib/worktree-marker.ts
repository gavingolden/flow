import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { git } from "./git";
import { AGENT_MEMORY_RELPATH } from "./paths";

/** Filename of the worktree-local branch marker, read by flow-state-update's guard. */
export const BRANCH_MARKER_FILENAME = ".flow-branch";

/** Filename used for the supervisor + sub-skill scratch directory inside each worktree. */
export const FLOW_TMP_DIRNAME = ".flow-tmp/";

/** Paths that flow writes into each worktree but doesn't track in git. The
 * third entry (no trailing slash — it's a symlink, and git's exclude
 * matches a symlink as a file) is the `linkAgentMemory` handoff target. */
const FLOW_EXCLUDE_PATHS = [
  BRANCH_MARKER_FILENAME,
  FLOW_TMP_DIRNAME,
  AGENT_MEMORY_RELPATH,
] as const;

/** Writes the worktree-local branch-name marker that flow-state-update reads. */
export function writeBranchMarker(
  worktreeDir: string,
  branchName: string,
): void {
  fs.writeFileSync(
    path.join(worktreeDir, BRANCH_MARKER_FILENAME),
    branchName + "\n",
    "utf8",
  );
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
  const absCommonDir = path.isAbsolute(commonDir)
    ? commonDir
    : path.join(worktreeDir, commonDir);
  const excludePath = path.join(absCommonDir, "info", "exclude");
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });

  const existing = fs.existsSync(excludePath)
    ? fs.readFileSync(excludePath, "utf8")
    : "";
  const present = new Set(existing.split("\n").map((l) => l.trim()));
  const toAdd = FLOW_EXCLUDE_PATHS.filter((p) => !present.has(p));
  if (toAdd.length === 0) return;

  const trailingNewline =
    existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(
    excludePath,
    existing + trailingNewline + toAdd.join("\n") + "\n",
    "utf8",
  );
}

/**
 * Result of the worktree-branch guard:
 *   - "ok"      — guard passed (or skipped: no worktree path, dir missing, marker missing).
 *   - "mismatch" — worktree on a different branch than the marker says. Caller
 *                  should refuse to write state and escalate `NEEDS HUMAN: branch-mismatch`.
 */
export type WorktreeBranchGuardResult =
  | { kind: "ok" }
  | { kind: "mismatch"; expected: string; actual: string };

/**
 * Asserts that the worktree's current branch matches the marker file written by
 * `flow-new-worktree`. Best-effort: if the worktree directory is gone or the
 * marker file is missing (e.g. created by an older flow-new-worktree), logs a
 * one-line warning and returns ok. Only an *active* mismatch returns mismatch.
 *
 * Lives in `bin/lib/` (not `bin/flow-state-update.ts`, its original home) so
 * `bin/lib/phase-advance.ts` can call it too — a `bin/lib/` module cannot
 * import from a `bin/*.ts` module. `flow-state-update.ts` re-exports this
 * under its original name for back-compat.
 */
export function checkWorktreeBranch(
  worktreePath: string | undefined,
): WorktreeBranchGuardResult {
  if (!worktreePath) return { kind: "ok" };
  if (!fs.existsSync(worktreePath)) {
    console.error(
      `flow: worktree path '${worktreePath}' does not exist; skipping branch guard`,
    );
    return { kind: "ok" };
  }
  const markerPath = path.join(worktreePath, BRANCH_MARKER_FILENAME);
  if (!fs.existsSync(markerPath)) {
    console.error(
      `flow: ${BRANCH_MARKER_FILENAME} missing in '${worktreePath}'; skipping branch guard ` +
        `(worktree predates the branch-marker fix or was created externally)`,
    );
    return { kind: "ok" };
  }
  const expected = fs.readFileSync(markerPath, "utf8").trim();
  const result = spawnSync(
    "git",
    ["-C", worktreePath, "branch", "--show-current"],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    console.error(
      `flow: 'git branch --show-current' failed in '${worktreePath}'; skipping branch guard`,
    );
    return { kind: "ok" };
  }
  const actual = result.stdout.trim();
  if (actual !== expected) return { kind: "mismatch", expected, actual };
  return { kind: "ok" };
}
