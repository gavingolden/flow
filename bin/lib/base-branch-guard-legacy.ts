/**
 * Every rendered `pre-commit` hook body flow has EVER shipped, keyed by hook
 * ROLE name (today only `base-branch`; a future pre-push guard adds its own
 * key rather than widening this one). Split out purely to keep
 * `base-branch-guard.ts` under the AGENTS.md < 200 lines/file target — these
 * are DATA, not logic.
 *
 * ANY edit to `BASE_BRANCH_GUARD_HOOK`'s body (in `base-branch-guard.ts`)
 * requires bumping `BASE_BRANCH_GUARD_VERSION` AND appending the prior body
 * here plus a matching `bin/fixtures/<role>-guard-v<N>.sh` fixture — the
 * `version-drift lock` describe block in `base-branch-guard.test.ts`
 * enforces this mechanically.
 *
 * Held inline (not read from the fixtures at runtime): `bin/lib/` is never
 * symlinked onto PATH (only top-level `bin/*.ts` is — see `discoverHelpers`
 * in `bin/lib/sources.ts`), so `bin/fixtures/` only exists inside the
 * canonical checkout; a runtime read would break under the known
 * `flow setup --source <worktree>` dangling-source failure mode.
 */

/** v1 (tmux-only) — rendered bytes pinned at bin/fixtures/base-branch-guard-v1.sh. */
const V1_BODY = `#!/bin/sh
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

/** v2 (env-first FLOW_SLUG, pre-marker) — rendered bytes pinned at bin/fixtures/base-branch-guard-v2.sh. */
const V2_BODY = `#!/bin/sh
[ -n "$CLAUDE_CODE_SESSION_ID" ] || exit 0
flow_slug=\${FLOW_SLUG:-}
if [ -z "$flow_slug" ] && [ -n "$TMUX_PANE" ]; then
  flow_slug=$(tmux show-options -w -t "$TMUX_PANE" -q -v @flow-slug 2>/dev/null)
fi
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

/** v3 (env-first slug) — rendered bytes pinned at bin/fixtures/base-branch-guard-v3.sh. */
const V3_BODY = `#!/bin/sh
# flow:base-branch-guard v3
# managed by flow — edits are overwritten on the next \`flow feature create\`.
[ -n "$CLAUDE_CODE_SESSION_ID" ] || exit 0
flow_slug=\${FLOW_SLUG:-}
if [ -z "$flow_slug" ] && [ -n "$TMUX_PANE" ]; then
  flow_slug=$(tmux show-options -w -t "$TMUX_PANE" -q -v @flow-slug 2>/dev/null)
fi
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

/** v4 (env-first slug, tmux pane fallback) — rendered bytes pinned at bin/fixtures/base-branch-guard-v4.sh. */
const V4_BODY = `#!/bin/sh
# flow:base-branch-guard v4
# managed by flow — edits are overwritten on the next \`flow feature create\`.
[ -n "$CLAUDE_CODE_SESSION_ID" ] || exit 0
flow_slug=\${FLOW_SLUG:-}
if [ -z "$flow_slug" ] && [ -n "$TMUX_PANE" ]; then
  flow_slug=$(tmux show-options -w -t "$TMUX_PANE" -q -v @flow-slug 2>/dev/null)
fi
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
  # Narrow carve-out: a machine-derived epic status board is committable here.
  # See AGENTS.md "Auto-commit exemption: flow-epic-sync --commit".
  # --no-renames: default rename detection prints only the destination path
  # of a git-mv, so e.g. renaming .flow/epics/<e>/manifest.json to
  # .flow/epics/<e>/status.json would show one allowlisted line and pass
  # this check while committing a DELETION of manifest.json to the base
  # branch.
  staged=$(git diff --cached --no-renames --name-only)
  if [ -n "$staged" ] && ! printf '%s\n' "$staged" | grep -qvE '^\\.flow/epics/[^/]+/status\\.json$'; then
    # jq-gated staged-content sanity check, allow-path only, fail-open when
    # jq is absent — this must never reach the common non-flow commit path.
    if command -v jq >/dev/null 2>&1; then
      for p in $staged; do
        if ! git show ":$p" | jq -e . >/dev/null 2>&1; then
          echo "flow: refusing to commit a malformed epic status board '$p'." >&2
          exit 1
        fi
      done
    fi
    exit 0
  fi
  echo "flow: refusing to commit on the base branch '$default_branch' inside a flow session." >&2
  echo "flow: pipeline work belongs on a per-pipeline worktree behind a PR, not the base branch." >&2
  exit 1
fi
exit 0
`;

export const LEGACY_HOOK_BODIES: Record<string, string[]> = {
  "base-branch": [V1_BODY, V2_BODY, V3_BODY, V4_BODY],
};
