import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./git";

/**
 * POSIX shell `prepare-commit-msg` hook body. When `CLAUDE_CODE_SESSION_ID`
 * is set and non-empty, appends a `Claude-Code-Session-Id:` trailer to the
 * commit-message file (`$1`) via `git interpret-trailers`. When
 * `ANTIGRAVITY_CONVERSATION_ID` is set and non-empty, appends an
 * `Antigravity-Conversation-Id:` trailer in parallel. A no-op when both
 * env vars are unset/empty. `--if-exists doNothing` makes a re-stamp (a
 * `git commit --amend` over an already-trailered message) idempotent.
 *
 * Authored as `#!/bin/sh` — NOT a Bun shebang — because git invokes this
 * on every commit and a per-commit interpreter start is real latency.
 * The hook is purely env-driven; it never reads state.json (parsing JSON
 * in /bin/sh would require spawning an interpreter on every commit).
 */
export const PREPARE_COMMIT_MSG_HOOK = `#!/bin/sh
if [ -n "$CLAUDE_CODE_SESSION_ID" ]; then
  git interpret-trailers --if-exists doNothing --in-place \\
    --trailer "Claude-Code-Session-Id: $CLAUDE_CODE_SESSION_ID" "$1"
fi
if [ -n "$ANTIGRAVITY_CONVERSATION_ID" ]; then
  git interpret-trailers --if-exists doNothing --in-place \\
    --trailer "Antigravity-Conversation-Id: $ANTIGRAVITY_CONVERSATION_ID" "$1"
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
 */
export function installCommitHook(worktreeDir: string): void {
  const gitDir = git(["rev-parse", "--git-dir"], worktreeDir);
  const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(worktreeDir, gitDir);
  const hooksDir = path.join(absGitDir, FLOW_HOOKS_DIRNAME);

  git(["config", "extensions.worktreeConfig", "true"], worktreeDir);
  git(["config", "--worktree", "core.hooksPath", hooksDir], worktreeDir);

  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, HOOK_FILENAME);
  fs.writeFileSync(hookPath, PREPARE_COMMIT_MSG_HOOK, "utf8");
  fs.chmodSync(hookPath, 0o755);
}
