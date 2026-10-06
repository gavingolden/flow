# Delegated scout (Step 1b)

When `delegate.models.scout` names an agy variant, `flow-agy-scout` runs the
scout on the user's idle Google AI Ultra quota (Claude Opus via agy) and
writes `scout.md` only from a complete report. The Claude Task scout in
Step 1b item 3 is the fallback for every case it cannot deliver — the slot
is unset, the Google plan is cooling down after a quota failure, or the
agy run came back empty, incomplete or failed. This is a Bash fan-out, not
a new Task-tool exemption; the Task call below is the existing scout
exemption.

## When it applies

Only when `command -v flow-agy-scout` succeeds. Otherwise run Step 1b
exactly as written.

## Procedure

Run these in ONE Bash call with an explicit `timeout: 600000` — the default
120000 ms kills an 8-minute agy run. The description file is written in the
same call so the delegation adds no supervisor turn:

```bash
mkdir -p "$WORKTREE/.flow-tmp"
cat > "$WORKTREE/.flow-tmp/scout-description.md" <<'FLOW_SCOUT_DESCRIPTION'
<the verbatim user feature description>
FLOW_SCOUT_DESCRIPTION
flow-agy-scout --worktree "$WORKTREE" --skill-dir "$SKILL_DIR" \
  --description-file "$WORKTREE/.flow-tmp/scout-description.md" \
  --out "$SCOUT_PATH" --plan "$PLAN_PATH" \
  --excluded-paths "$WORKTREE/.flow-tmp/excluded-paths.json" \
  --memory-dir "$PWD/.claude/agent-memory-local/flow-module-core-flow-scout"
```

`$PLAN_PATH` is the literal `absent` when no approved plan exists. The scout's
saved memory lives under the SUPERVISOR's working directory, not the
worktree, so `--memory-dir` is `$PWD/...`; the helper reads it read-only and
omits it when the directory is absent. Omit `--excluded-paths` when no
excluded-paths file exists.

The helper prints one JSON envelope. Branch on `.ran`, never the exit code:

- `ran: true` — `scout.md` is complete at `$SCOUT_PATH`. Skip the Task call
  in item 3 entirely and use the envelope's `summary` as the chat output
  (item 4's existence check still applies).
- anything else — print one line naming `skipReason` (for example
  `scout: delegated run unavailable (agy-cooldown) — using the Claude scout`),
  then spawn the Task scout exactly as item 3 describes.

`scout-delegation-off` and `agy-cooldown` make no agy call, so they cost
nothing but the one Bash call.
