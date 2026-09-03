#!/bin/sh
# flow:base-branch-guard v5
# managed by flow — edits are overwritten on the next `flow feature create`.
[ -n "$CLAUDE_CODE_SESSION_ID" ] || exit 0
[ -n "$FLOW_SLUG" ] || exit 0

# origin/HEAD is the source of truth for the default branch; the local
# main/master fallback is load-bearing for repos with no origin/HEAD (a fresh
# "git init -b main" test repo has none).
default_branch=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
default_branch=${default_branch#origin/}
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
  if [ -n "$staged" ] && ! printf '%s
' "$staged" | grep -qvE '^\.flow/epics/[^/]+/status\.json$'; then
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
