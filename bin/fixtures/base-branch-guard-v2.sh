#!/bin/sh
[ -n "$CLAUDE_CODE_SESSION_ID" ] || exit 0
flow_slug=${FLOW_SLUG:-}
if [ -z "$flow_slug" ] && [ -n "$TMUX_PANE" ]; then
  flow_slug=$(tmux show-options -w -t "$TMUX_PANE" -q -v @flow-slug 2>/dev/null)
fi
[ -n "$flow_slug" ] || exit 0

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
  echo "flow: refusing to commit on the base branch '$default_branch' inside a flow session." >&2
  echo "flow: pipeline work belongs on a per-pipeline worktree behind a PR, not the base branch." >&2
  exit 1
fi
exit 0
