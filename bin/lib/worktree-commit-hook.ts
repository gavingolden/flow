import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./git";

/**
 * POSIX shell `prepare-commit-msg` hook body. When `CLAUDE_CODE_SESSION_ID`
 * is set and non-empty, appends a `Claude-Code-Session-Id:` trailer to the
 * commit-message file (`$1`) via `git interpret-trailers`. A no-op when the
 * env var is unset/empty. `--if-exists doNothing` makes a re-stamp (a
 * `git commit --amend` over an already-trailered message) idempotent.
 *
 * Authored as `#!/bin/sh` — NOT a Bun shebang — because git invokes this on
 * every commit and a per-commit interpreter start is real latency.
 */
export const PREPARE_COMMIT_MSG_HOOK = `#!/bin/sh
if [ -n "$CLAUDE_CODE_SESSION_ID" ]; then
  git interpret-trailers --if-exists doNothing --in-place \\
    --trailer "Claude-Code-Session-Id: $CLAUDE_CODE_SESSION_ID" "$1"
fi
`;

/** Filename git invokes for the commit-message-rewrite hook. */
const HOOK_FILENAME = "prepare-commit-msg";

/** Flow-owned hooks directory name, placed inside the worktree's git-dir. */
const FLOW_HOOKS_DIRNAME = "flow-hooks";

/**
 * Installs the `prepare-commit-msg` hook into a single flow worktree,
 * scoped so it never fires for the user's primary repo or other worktrees.
 * Idempotent — `git config` set is idempotent and the hook file is
 * overwritten unconditionally with identical content (mirrors
 * `writeBranchMarker`'s unconditional-overwrite style).
 *
 * Resolves the hooks dir via `git rev-parse --git-dir` run *from the
 * worktree* — the per-worktree `.git/worktrees/<name>/` path, NOT
 * `--git-common-dir`. `--git-common-dir` would resolve to the shared
 * primary `.git/`, leaking the hook into the user's primary repo and
 * every other worktree.
 *
 * This is DELIBERATELY the opposite polarity of `bin/lib/hooks-target.ts`'s
 * `resolveHooksTarget`, which resolves the MAIN worktree for the
 * base-branch guard: the session-id trailer here must apply only inside
 * one worktree (each worktree gets its own hook), while the base-branch
 * guard must protect the base branch's own checkout regardless of which
 * worktree `flow feature create` happens to run from. The two installers
 * look symmetric — do not "unify" them. `worktree-commit-hook.test.ts`
 * pins this worktree-scoped behaviour; it must NOT start resolving the
 * main worktree.
 */
export function installCommitHook(worktreeDir: string): void {
  const gitDir = git(["rev-parse", "--git-dir"], worktreeDir);
  const absGitDir = path.isAbsolute(gitDir)
    ? gitDir
    : path.join(worktreeDir, gitDir);
  const hooksDir = path.join(absGitDir, FLOW_HOOKS_DIRNAME);

  git(["config", "extensions.worktreeConfig", "true"], worktreeDir);
  git(["config", "--worktree", "core.hooksPath", hooksDir], worktreeDir);

  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, HOOK_FILENAME);
  fs.writeFileSync(hookPath, PREPARE_COMMIT_MSG_HOOK, "utf8");
  fs.chmodSync(hookPath, 0o755);
}
