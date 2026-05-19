# Result-artifact read-before-overwrite protocol

Shared write protocol for every `/pr-review` clean-exit site that lands
`status: "clean"` in `<worktree>/.flow-tmp/pr-review-result.json`. The
protocol is a single load-bearing guard: **read the prior artifact's
`.status` before overwriting; if it is already `"escalated"`, exit
cleanly without touching the file**. This file is the canonical
reference; every clean-exit write site links here.

## Why

The wrapper writes `pr-review-result.json` on every exit path. Without
the read-before-overwrite guard, a downstream clean-exit site can
silently overwrite an earlier escalation site's `status: "escalated"`
verdict — masking a real failure as a clean run.

A worked failure mode the protocol prevents: an earlier step writes
`status: "escalated"` with `escalation_tag: "consolidator-schema-failure"`
and prints `NEEDS HUMAN: ...` to stderr; the wrapper's control flow
continues past the escalation (a `return` missed, a `set -e` clause
disabled by an upstream `&&`, a subshell scope leak) and falls through
to Step 13's clean-completion write. Without the guard, that
clean-completion write replaces the escalation artifact and the
supervisor at `/flow-pipeline` step 8 reads `status: "clean"` instead of
`"escalated"` — the run merges as if nothing failed.

The guard makes that regression class shape-impossible: the first
`status: "escalated"` write wins, and every subsequent clean-exit write
becomes a no-op once the escalation flag is on disk.

## The contract

Every write that would set `status: "clean"` MUST first run the
**read-before-overwrite guard** below before constructing the new
artifact. The literal one-line form (suitable for inlining):

```bash
[ -f "$RESULT_PATH" ] && [ "$(jq -r '.status' "$RESULT_PATH" 2>/dev/null)" = "escalated" ] && exit 0
```

The multi-line form (preferred when the surrounding script already has
prose comments):

```bash
RESULT_PATH="$WORKTREE/.flow-tmp/pr-review-result.json"

# read-before-overwrite: a prior escalation site's status: "escalated"
# verdict must not be overwritten by this clean-exit write. The guard
# exits cleanly if an escalation is already on disk; the supervisor
# reads the escalation tag verbatim.
if [ -f "$RESULT_PATH" ]; then
  PRIOR_STATUS="$(jq -r '.status' "$RESULT_PATH" 2>/dev/null || true)"
  if [ "$PRIOR_STATUS" = "escalated" ]; then
    exit 0
  fi
fi
```

The guard MUST appear before the heredoc that writes the new candidate
`pr-review-result.json.tmp`. Pair it with `set -o pipefail` in the
surrounding script so the `jq` pipeline's exit code is the script's
exit code (not the trailing `||`'s).

## Worked example

```bash
set -o pipefail
RESULT_PATH="$WORKTREE/.flow-tmp/pr-review-result.json"

# read-before-overwrite guard — see result-artifact-write-protocol.md
[ -f "$RESULT_PATH" ] && [ "$(jq -r '.status' "$RESULT_PATH" 2>/dev/null)" = "escalated" ] && exit 0

cat > "$RESULT_PATH.tmp" <<EOF
{
  "status": "clean",
  "completed_steps": ["1", "1.5", "2", "3", "3.5", "4", "5", "6", "7", "7.5", "8", "8c", "9", "10", "11", "12", "13"],
  "missed_steps": [],
  "escalation_tag": null,
  "summary": "<step-12 headline>"
}
EOF
bun bin/lib/pr-review-result-schema.ts --validate "$RESULT_PATH.tmp" \
  && mv "$RESULT_PATH.tmp" "$RESULT_PATH"
```

The atomic write (write-`.tmp` → validate-`.tmp` → `mv`-into-place)
applies in tandem with the read-before-overwrite guard. The guard
short-circuits the entire block when an escalation is already on disk;
the atomic write keeps a half-written or off-shape artifact from ever
landing where a reader expects a well-formed JSON object.

## Where the contract applies

Every clean-exit write site in `/pr-review`'s wrapper:

- **Step 1.5 Gatekeeper "skip" branch** — when the Gatekeeper subagent
  returns `decision: "skip"`, the wrapper writes
  `pr-review-result.json` with `status: "clean"` and
  `completed_steps: ["1", "1.5"]`. The guard prevents an earlier
  preamble-failure (`task-tool-unavailable: pr-review-gatekeeper`) from
  being overwritten if the Gatekeeper bails post-escalation.
- **Step 3.5 Consolidator-Validator clean-exit on degenerate case** —
  when the consolidator merges six per-agent outputs into an empty
  findings array (no findings cleared the >=80 confidence bar), the
  wrapper still proceeds through Steps 4–13 to a clean Step 13 write;
  the same guard applies to that write. The consolidator's own
  artifact write at `consolidator-result.json` is a separate atomic
  write, not gated by this protocol.
- **Step 13 clean-completion** — the canonical clean-exit site. Every
  upstream escalation must short-circuit this write.

## What the contract does NOT do

- **It is not a lock.** Each `/pr-review` invocation is one process;
  the protocol is a single-process control-flow guard, not a
  cross-process mutex. Two concurrent `/pr-review` runs against the
  same worktree would still race (and the worktree-marker contract in
  `/flow-pipeline` already prevents that case).
- **It is not a coordination primitive across pipelines.** Each
  `/pr-review` run is one process; cross-pipeline coordination lives
  in `~/.flow/state/<slug>.json`, not in the result artifact.
- **It does not apply to escalation writes.** An escalation write
  overwriting a prior `status: "clean"` is the correct behaviour: the
  later failure is the source of truth. The guard is one-directional
  — escalation always wins over clean.
- **It does not validate the prior artifact's shape.** A malformed
  prior artifact (corrupted JSON, missing `.status`) reads as the
  empty string from `jq -r '.status' 2>/dev/null` and the guard
  falls through to the clean-exit write — which then atomically
  overwrites the malformed file with a well-formed one.
