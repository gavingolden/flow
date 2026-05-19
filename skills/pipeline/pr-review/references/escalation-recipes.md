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

## `consolidator-schema-failure`

Raised by Step 3.5's Consolidator-Validator subagent when
`bun bin/lib/agent-finding-schema.ts --validate <per-agent-path>` exits
1 on any of the six per-agent outputs (one of the upstream agents
produced malformed JSON), OR when the consolidator's own pre-`mv`
`validateConsolidatorResult` call on
`consolidator-result.json.tmp` exits 1 (the consolidator itself
produced malformed JSON in its candidate file). Steps 1, 1.5, 2, and
3 ran before the bail; Steps 3.5 onward did not.

This is an escalation write — it overwrites any prior status. The
read-before-overwrite guard in
[result-artifact-write-protocol.md](result-artifact-write-protocol.md)
does NOT apply here; escalation overwriting a prior `status: "clean"`
is the correct behaviour.

```bash
RESULT_PATH="$WORKTREE/.flow-tmp/pr-review-result.json"
cat > "$RESULT_PATH.tmp" <<'EOF'
{
  "status": "escalated",
  "completed_steps": ["1", "1.5", "2", "3"],
  "missed_steps": ["3.5", "4", "5", "6", "7", "7.5", "8", "8c", "9", "10", "11", "12", "13"],
  "escalation_tag": "consolidator-schema-failure",
  "summary": "Consolidator-Validator subagent failed schema validation — one of the six per-agent outputs (or the consolidator's own .tmp output) did not conform to bin/lib/agent-finding-schema.ts. Wrapper bailed at Step 3.5; supervisor must restart."
}
EOF
bun bin/lib/pr-review-result-schema.ts --validate "$RESULT_PATH.tmp" \
  && mv "$RESULT_PATH.tmp" "$RESULT_PATH"
```

## `consolidator-missing-artifact`

Raised by Step 3.5's wrapper post-spawn existence check when
`test -s "$WORKTREE/.flow-tmp/consolidator-result.json"` fails (the
Consolidator-Validator subagent returned but its artifact is missing
or empty — the subagent crashed before writing). Steps 1, 1.5, 2, and
3 ran before the bail; Steps 3.5 onward did not.

This is an escalation write — same exception as
`consolidator-schema-failure` above. The read-before-overwrite guard
in [result-artifact-write-protocol.md](result-artifact-write-protocol.md)
does NOT apply to escalation writes; escalation overwriting a prior
`status: "clean"` is the correct behaviour.

```bash
RESULT_PATH="$WORKTREE/.flow-tmp/pr-review-result.json"
cat > "$RESULT_PATH.tmp" <<'EOF'
{
  "status": "escalated",
  "completed_steps": ["1", "1.5", "2", "3"],
  "missed_steps": ["3.5", "4", "5", "6", "7", "7.5", "8", "8c", "9", "10", "11", "12", "13"],
  "escalation_tag": "consolidator-missing-artifact",
  "summary": "Consolidator-Validator subagent returned but the artifact at .flow-tmp/consolidator-result.json is missing or empty. Wrapper bailed at Step 3.5's existence check; supervisor must restart."
}
EOF
bun bin/lib/pr-review-result-schema.ts --validate "$RESULT_PATH.tmp" \
  && mv "$RESULT_PATH.tmp" "$RESULT_PATH"
```
