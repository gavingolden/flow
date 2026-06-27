import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./git";
import { dim } from "./color";

/**
 * POSIX shell `pre-commit` hook body. Refuses a commit (`exit 1`) when HEAD is
 * on the repo's default branch AND the commit is happening inside a flow
 * supervisor session; a no-op (`exit 0`) in every other case.
 *
 * Authored as `#!/bin/sh` — NOT a Bun shebang — because git invokes pre-commit
 * on EVERY commit, so the common path (no flow session) must exit 0 with
 * near-zero cost. For the same reason the default-branch idiom is inlined in
 * sh here rather than shelling out to the TS `detectDefaultBranch`: a Bun/TS
 * spawn would add a per-commit interpreter start and a runtime dependency.
 *
 * BOTH session gates are load-bearing: `CLAUDE_CODE_SESSION_ID` alone is set
 * for the user's own hand-driven Claude Code commits, so the tmux `@flow-slug`
 * pane option is what narrows the guard to a flow-supervisor window — without
 * it the hook would block the user's own legitimate commits to the base branch.
 */
export const BASE_BRANCH_GUARD_HOOK = `#!/bin/sh
[ -n "$CLAUDE_CODE_SESSION_ID" ] || exit 0
[ -n "$TMUX_PANE" ] || exit 0
flow_slug=$(tmux show-options -w -t "$TMUX_PANE" -q -v @flow-slug 2>/dev/null)
[ -n "$flow_slug" ] || exit 0

# origin/HEAD is the source of truth for the default branch; the local
# main/master fallback is load-bearing for repos with no origin/HEAD (a fresh
# "git init -b main" test repo has none).
default_branch=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
default_branch=\${default_branch#origin/}
if [ -z "$default_branch" ]; then
  if git show-ref --verify --quiet refs/heads/main; then
    default_branch=main
  elif git show-ref --verify --quiet refs/heads/master; then
    default_branch=master
  else
    default_branch=main
  fi
fi

current_branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || git rev-parse --abbrev-ref HEAD 2>/dev/null)

if [ "$current_branch" = "$default_branch" ]; then
  echo "flow: refusing to commit on the base branch '$default_branch' inside a flow session." >&2
  echo "flow: pipeline work belongs on a per-pipeline worktree behind a PR, not the base branch." >&2
  exit 1
fi
exit 0
`;

/**
 * Pure refuse/allow decision mirrored by the sh hook above, factored out so the
 * branching logic is unit-testable without spawning a real commit. Refuses ONLY
 * when both flow-session markers are present AND HEAD is the default branch.
 */
export function baseBranchGuardDecision(input: {
  sessionId?: string;
  flowSlug?: string;
  currentBranch: string;
  defaultBranch: string;
}): "refuse" | "allow" {
  const sessionMarked = Boolean(input.sessionId) && Boolean(input.flowSlug);
  if (sessionMarked && input.currentBranch === input.defaultBranch) {
    return "refuse";
  }
  return "allow";
}

export type BaseBranchGuardInstall = {
  installed: boolean;
  reason: "installed" | "exists" | "idempotent";
};

/** Absolute hooks dir, robust to worktrees/custom git-dirs. */
function resolveHooksDir(repoDir: string): string {
  try {
    const p = git(["rev-parse", "--git-path", "hooks"], repoDir);
    return path.isAbsolute(p) ? p : path.join(repoDir, p);
  } catch {
    return path.join(repoDir, ".git", "hooks");
  }
}

/**
 * Idempotently installs the base-branch guard as the repo's `pre-commit` hook.
 * Installs into the *effective* hooks dir — the default `.git/hooks` or a
 * `core.hooksPath`-configured custom dir (git resolves `core.hooksPath`
 * transparently via `git rev-parse --git-path hooks`, so `resolveHooksDir`
 * already returns the right target for both). Never clobbers a pre-existing
 * `pre-commit` in that dir — it is the user's own hook, so we warn and leave it
 * untouched. A re-install over our own identical hook is a silent no-op.
 */
export function installBaseBranchGuard(
  repoDir: string,
): BaseBranchGuardInstall {
  const hooksDir = resolveHooksDir(repoDir);
  const hookPath = path.join(hooksDir, "pre-commit");

  if (fs.existsSync(hookPath)) {
    if (fs.readFileSync(hookPath, "utf8") === BASE_BRANCH_GUARD_HOOK) {
      return { installed: true, reason: "idempotent" };
    }
    console.error(
      dim(
        "flow new: base-branch guard not installed — existing pre-commit hook present",
      ),
    );
    return { installed: false, reason: "exists" };
  }

  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(hookPath, BASE_BRANCH_GUARD_HOOK, "utf8");
  fs.chmodSync(hookPath, 0o755);
  return { installed: true, reason: "installed" };
}
