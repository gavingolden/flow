# Escalation Recipes

This file carries the three worked heredoc + validate + `mv` recipes
for the bail-out paths in `/pr-review`'s wrapper. Each recipe writes
`<worktree>/.flow-tmp/pr-review-result.json` with `status: "escalated"`
and the per-tag `completed_steps[]` / `missed_steps[]` arrays the
supervisor's branch-on-status logic reads at `/flow-pipeline` step 8.
The three blocks are kept distinct (not templated) because the
per-tag arrays differ in load-bearing ways — see each recipe's intro
for what fires it.

## `task-tool-unavailable: pr-review-multi-agent-review`

Raised by Step 3's preamble when `ToolSearch query="select:Task"`
returns neither `"name": "Task"` nor `"name": "Agent"`. Steps 1 and 2
ran before the bail; Steps 3 onward did not.

```bash
RESULT_PATH="$WORKTREE/.flow-tmp/pr-review-result.json"
cat > "$RESULT_PATH.tmp" <<'EOF'
{
  "status": "escalated",
  "completed_steps": ["1", "2"],
  "missed_steps": ["3", "4", "5", "6", "7", "7.5", "8", "8c", "9", "10", "11", "12", "13"],
  "escalation_tag": "task-tool-unavailable: pr-review-multi-agent-review",
  "summary": "Bailed at the Multi-Agent Review spawn-site preamble — neither Task nor Agent surfaced top-level in this session; supervisor must restart in a session where the alias is available."
}
EOF
bun bin/lib/pr-review-result-schema.ts --validate "$RESULT_PATH.tmp" \
  && mv "$RESULT_PATH.tmp" "$RESULT_PATH"
```

## `task-tool-unavailable: pr-review-fix-applier`

Raised by the Fix-Applier Spawn-procedure preamble when
`ToolSearch query="select:Task"` returns neither `"name": "Task"` nor
`"name": "Agent"`. Steps 1 through 5 ran before the bail; the
Fix-Applier-owned Steps 6/7/7.5/8 and downstream did not.

```bash
RESULT_PATH="$WORKTREE/.flow-tmp/pr-review-result.json"
cat > "$RESULT_PATH.tmp" <<'EOF'
{
  "status": "escalated",
  "completed_steps": ["1", "2", "3", "4", "5"],
  "missed_steps": ["6", "7", "7.5", "8", "8c", "9", "10", "11", "12", "13"],
  "escalation_tag": "task-tool-unavailable: pr-review-fix-applier",
  "summary": "Bailed at the Fix-Applier spawn-site preamble — neither Task nor Agent surfaced top-level in this session; supervisor must restart in a session where the alias is available."
}
EOF
bun bin/lib/pr-review-result-schema.ts --validate "$RESULT_PATH.tmp" \
  && mv "$RESULT_PATH.tmp" "$RESULT_PATH"
```

## `fix-applier-missing-artifact`

Raised by Step 8's post-spawn existence check when
`test -s "$ARTIFACT_PATH"` fails (the Fix-Applier subagent returned
but its artifact at `.flow-tmp/fix-applier-result.json` is missing or
empty). Steps 1 through 5 plus the Step 8 spawn ran; Steps 8c onward
did not.

```bash
RESULT_PATH="$WORKTREE/.flow-tmp/pr-review-result.json"
cat > "$RESULT_PATH.tmp" <<'EOF'
{
  "status": "escalated",
  "completed_steps": ["1", "2", "3", "4", "5", "8"],
  "missed_steps": ["8c", "9", "10", "11", "12", "13"],
  "escalation_tag": "fix-applier-missing-artifact",
  "summary": "Fix-Applier subagent returned but the artifact at .flow-tmp/fix-applier-result.json is missing or empty. Wrapper bailed at Step 8's existence check; supervisor must restart."
}
EOF
bun bin/lib/pr-review-result-schema.ts --validate "$RESULT_PATH.tmp" \
  && mv "$RESULT_PATH.tmp" "$RESULT_PATH"
```
