#!/usr/bin/env bash

# Resolve the flow checkout root BEFORE cd-ing into the tmp repo.
FLOW_ROOT=$(git rev-parse --show-toplevel)

# Smoke: prewriteAgyTrust short-circuits agy's workspace trust prompt.
# Spawns flow new --agent antigravity against a fresh repo, waits for agy
# to render its first UI, then asserts the pane content does NOT contain
# the trust prompt.
set -euo pipefail

TMPREPO=$(mktemp -d /tmp/flow-smoke-trust-XXXX)
trap 'rm -rf "$TMPREPO"' EXIT

cd "$TMPREPO"
git init -q -b main
git commit --allow-empty -q -m "init"

# Verify the worktree is NOT already in trustedWorkspaces (otherwise the
# test is vacuous — the prompt would be skipped regardless of pre-write).
RESOLVED=$(cd "$TMPREPO" && pwd -P)
if jq -e --arg p "$RESOLVED" '(.trustedWorkspaces // []) | index($p)' ~/.gemini/antigravity-cli/settings.json >/dev/null 2>&1; then
  echo "FAIL: pre-condition broken — $RESOLVED is already trusted" >&2
  exit 1
fi

SLUG_HINT="trust-skip-$(date +%s)"
bun "$FLOW_ROOT/bin/flow" new --agent antigravity "$SLUG_HINT" >/dev/null

# Find the new window
SLUG=$(jq -r --arg repo "$RESOLVED" 'select(.repo == $repo) | .slug' ~/.flow/state/*.json 2>/dev/null | head -1)
[ -z "$SLUG" ] && { echo "FAIL: state file for $RESOLVED not found" >&2; exit 1; }
STATE="$HOME/.flow/state/$SLUG.json"
WID=$(tmux list-windows -t flow -F '#{window_id} #{window_name}' | awk -v n="agy/$SLUG" '$2 == n {print $1; exit}')
[ -z "$WID" ] && { echo "FAIL: window agy/$SLUG not found" >&2; exit 1; }

# Wait up to 30 seconds for agy's TUI to render. The trust prompt would
# appear in the first few seconds; the Read instruction shows up after.
# We poll until we see EITHER signal then assert it's NOT the trust prompt.
SECONDS_WAITED=0
until tmux capture-pane -t "$WID" -p 2>/dev/null | grep -qE "Do you trust this folder|Read the file at"; do
  sleep 1
  SECONDS_WAITED=$((SECONDS_WAITED + 1))
  if [ "$SECONDS_WAITED" -ge 30 ]; then
    echo "FAIL: agy rendered no UI within 30s" >&2
    tmux kill-window -t "$WID" 2>/dev/null || true
    exit 1
  fi
done

PANE=$(tmux capture-pane -t "$WID" -p)
if echo "$PANE" | grep -q "Do you trust this folder"; then
  echo "FAIL: trust prompt still showed despite prewriteAgyTrust" >&2
  echo "$PANE" | grep -A2 -B2 "Do you trust" >&2
  tmux kill-window -t "$WID" 2>/dev/null || true
  exit 1
fi

# Confirm the workspace is now in trustedWorkspaces (sanity check on the
# pre-write itself).
jq -e --arg p "$RESOLVED" '(.trustedWorkspaces // []) | index($p)' ~/.gemini/antigravity-cli/settings.json >/dev/null \
  || { echo "FAIL: $RESOLVED not in trustedWorkspaces after spawn" >&2; exit 1; }

# Cleanup
tmux kill-window -t "$WID" 2>/dev/null || true
WORKTREE_FROM_STATE=$(jq -r '.worktree // empty' "$STATE" 2>/dev/null)
if [ -n "$WORKTREE_FROM_STATE" ] && [ -d "$WORKTREE_FROM_STATE" ]; then
  git -C "$RESOLVED" worktree remove --force "$WORKTREE_FROM_STATE" 2>/dev/null || true
fi
git -C "$RESOLVED" branch -D "$SLUG" 2>/dev/null || true
rm -f "$STATE"

echo "PASS: trust prompt skipped"
echo "  trustedWorkspaces now contains: $RESOLVED"
echo "  pane content: (no 'Do you trust' substring)"
