#!/usr/bin/env bash

# Resolve the flow checkout root BEFORE cd-ing into the tmp repo.
FLOW_ROOT=$(git rev-parse --show-toplevel)

# Smoke: flow new --agent antigravity spawn-shape verification.
# Asserts state.json + tmux window name + pane command match expectations.
# Spawns into a /tmp scratch repo so it doesn't touch user state.
set -euo pipefail

TMPREPO=$(mktemp -d /tmp/flow-smoke-spawn-XXXX)
trap 'rm -rf "$TMPREPO"' EXIT

cd "$TMPREPO"
git init -q -b main
git commit --allow-empty -q -m "init"

SLUG_HINT="spawn-shape-$(date +%s)"
WORKTREE_PATH="$TMPREPO"

# Spawn via the worktree's bin/flow (so we test the new code, not the global install)
bun "$FLOW_ROOT/bin/flow" new --agent antigravity "$SLUG_HINT" >/dev/null

# The slugifier may transform; find the slug by scanning state files for the resolved repo
SLUG=$(jq -r --arg repo "/private$WORKTREE_PATH" 'select(.repo == $repo) | .slug' ~/.flow/state/*.json 2>/dev/null | head -1)
[ -z "$SLUG" ] && SLUG=$(jq -r --arg repo "$WORKTREE_PATH" 'select(.repo == $repo) | .slug' ~/.flow/state/*.json 2>/dev/null | head -1)

if [ -z "$SLUG" ]; then
  echo "FAIL: no state file found for repo $WORKTREE_PATH" >&2
  exit 1
fi
STATE="$HOME/.flow/state/$SLUG.json"

# Assertions
[ "$(jq -r '.agent' "$STATE")" = "antigravity" ] || { echo "FAIL: state.agent != antigravity" >&2; exit 1; }
WINDOW_NAME=$(tmux list-windows -t flow -F '#{window_name}' | grep "agy/$SLUG" || true)
[ -n "$WINDOW_NAME" ] || { echo "FAIL: no tmux window named agy/$SLUG" >&2; exit 1; }
WID=$(tmux list-windows -t flow -F '#{window_id} #{window_name}' | awk -v n="agy/$SLUG" '$2 == n {print $1; exit}')
PANE_PID=$(tmux list-panes -t "$WID" -F '#{pane_pid}' | head -1)
ARGS=$(ps -p "$PANE_PID" -o args= 2>/dev/null || true)
echo "$ARGS" | grep -q "^agy --dangerously-skip-permissions -i Read the file at" \
  || { echo "FAIL: pane command does not match expected Variant A shape; got: $ARGS" >&2; exit 1; }

# Kill the smoke window so we don't leave it behind.
tmux kill-window -t "$WID" 2>/dev/null || true
# Best-effort cleanup of the worktree/branch/state the spawn created.
WORKTREE_FROM_STATE=$(jq -r '.worktree // empty' "$STATE")
if [ -n "$WORKTREE_FROM_STATE" ] && [ -d "$WORKTREE_FROM_STATE" ]; then
  cd "$WORKTREE_PATH"
  git worktree remove --force "$WORKTREE_FROM_STATE" 2>/dev/null || true
fi
git -C "$WORKTREE_PATH" branch -D "$SLUG" 2>/dev/null || true
rm -f "$STATE"

echo "PASS: spawn shape verified"
echo "  state.agent: antigravity"
echo "  window name: agy/$SLUG"
echo "  pane command starts with: agy --dangerously-skip-permissions -i Read the file at"
