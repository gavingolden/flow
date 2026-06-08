# Result-artifact read-before-overwrite protocol

Shared write protocol for **every** write to
`<worktree>/.flow-tmp/pr-review-result.json` — both clean-exit writes
(`status: "clean"`) and wrapper-issued escalation writes
(`status: "escalated"`). The protocol is a single load-bearing guard:
**read the prior artifact's `.status` before overwriting; if it is
already `"escalated"`, exit cleanly without touching the file**. This
file is the canonical reference; every write site links here.

## Why

The wrapper writes `pr-review-result.json` on every exit path. Without
the read-before-overwrite guard, two distinct regression classes
appear:

1. **A clean-exit overwriting an earlier escalation.** A downstream
   clean-exit site silently overwrites an earlier escalation site's
   `status: "escalated"` verdict — masking a real failure as a clean
   run. Worked failure mode: an earlier step writes
   `status: "escalated"` with `escalation_tag:
"consolidator-schema-failure"` and prints `NEEDS HUMAN: ...` to
   stderr; the wrapper's control flow continues past the escalation
   (a `return` missed, a `set -e` clause disabled by an upstream
   `&&`, a subshell scope leak) and falls through to Step 13's
   clean-completion write. Without the guard, that clean-completion
   write replaces the escalation artifact and the supervisor at
   `/flow-pipeline` step 8 reads `status: "clean"` instead of
   `"escalated"` — the run merges as if nothing failed.
2. **A generic wrapper escalation overwriting a specific subagent
   escalation.** A subagent writes `status: "escalated"` with a
   specific tag (e.g. `consolidator-schema-failure` or
   `consolidator-missing-artifact`); then the wrapper's post-spawn
   check fires and writes its own generic escalation
   (`consolidator-missing-artifact` for a missing artifact, etc.).
   Without the guard, the generic wrapper tag clobbers the specific
   subagent tag and the supervisor loses the root-cause signal.

The guard makes both regression classes shape-impossible: the first
`status: "escalated"` write wins, and every subsequent write —
clean-exit OR wrapper-escalation — becomes a no-op once the
escalation flag is on disk. The only escalations that legitimately
overwrite a prior `status: "clean"` write are direct subagent writes
_before_ any clean write has landed, which is the expected ordering
(escalation paths short-circuit further wrapper progress to Step 13).

## The contract

Every write to `pr-review-result.json` — both clean-exit writes
(`status: "clean"`) AND wrapper-issued escalation writes
(`status: "escalated"`) — MUST first run the
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
# verdict must not be overwritten — neither by a clean-exit write nor
# by a generic wrapper-escalation that would clobber a specific
# subagent tag. The guard exits cleanly if an escalation is already on
# disk; the supervisor reads the prior escalation tag verbatim.
if [ -f "$RESULT_PATH" ]; then
  PRIOR_STATUS="$(jq -r '.status' "$RESULT_PATH" 2>/dev/null || true)"
  if [ "$PRIOR_STATUS" = "escalated" ]; then
    exit 0
  fi
fi
```

The guard MUST appear before the heredoc that writes the new candidate
`pr-review-result.json.tmp`. The trailing `|| true` on the `jq`
invocation is load-bearing: when `RESULT_PATH` is missing or the file
contains malformed JSON, `jq -r '.status'` exits non-zero, and under
`set -e` that would abort the surrounding script before the guard's
own comparison could run. The `|| true` swallows the non-zero exit so
the comparison falls through cleanly to the clean-exit write path
(which is what we want when no prior artifact exists). There is no
pipeline here — `set -o pipefail` is not required.

## Worked example

```bash
RESULT_PATH="$WORKTREE/.flow-tmp/pr-review-result.json"

# read-before-overwrite guard — see result-artifact-write-protocol.md
[ -f "$RESULT_PATH" ] && [ "$(jq -r '.status' "$RESULT_PATH" 2>/dev/null || true)" = "escalated" ] && exit 0

cat > "$RESULT_PATH.tmp" <<EOF
{
  "status": "clean",
  "completed_steps": ["1", "1.5", "2", "3", "3.5", "4", "5", "6", "7", "7.5", "8", "8c", "9", "10", "11", "12", "13"],
  "missed_steps": [],
  "escalation_tag": null,
  "summary": "<step-12 headline>"
}
EOF
flow-pr-review-result-schema --validate "$RESULT_PATH.tmp" \
  && mv "$RESULT_PATH.tmp" "$RESULT_PATH"
```

The atomic write (write-`.tmp` → validate-`.tmp` → `mv`-into-place)
applies in tandem with the read-before-overwrite guard. The guard
short-circuits the entire block when an escalation is already on disk;
the atomic write keeps a half-written or off-shape artifact from ever
landing where a reader expects a well-formed JSON object.

## Where the contract applies

**Every write** to `pr-review-result.json` in `/pr-review`'s wrapper
— clean-exit AND wrapper-escalation alike:

- **Step 1.5 Gatekeeper "skip" branch** — when the Gatekeeper subagent
  returns `decision: "skip"`, the wrapper writes
  `pr-review-result.json` with `status: "clean"` and
  `completed_steps: ["1", "1.5"]`. The guard prevents an earlier
  preamble-failure (`task-tool-unavailable: pr-review-gatekeeper`) from
  being overwritten if the Gatekeeper bails post-escalation.
- **Step 3.5 Consolidator-Validator wrapper-escalation writes** — the
  wrapper's post-spawn existence check
  (`consolidator-missing-artifact`) and the wrapper's schema-failure
  bail (`consolidator-schema-failure`) BOTH go through the guard. The
  subagent itself may have already written `status: "escalated"` with
  a more specific tag; the guard ensures the wrapper's generic
  escalation does not clobber that specific tag. The recipes in
  `escalation-recipes.md` include the guard inline.
- **Step 3.5 Consolidator-Validator clean-exit on degenerate case** —
  when the consolidator merges six per-agent outputs into an empty
  findings array (no findings cleared the >=80 confidence bar), the
  wrapper still proceeds through Steps 4–13 to a clean Step 13 write;
  the same guard applies to that write. The consolidator's own
  artifact write at `consolidator-result.json` is a separate atomic
  write, not gated by this protocol (different file).
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
- **It does not block escalation overwriting a prior `clean`.** An
  escalation write overwriting a prior `status: "clean"` is the
  correct behaviour: the later failure is the source of truth. The
  guard is one-directional — escalation always wins over clean.
  Escalation-over-escalation, however, is blocked: a generic
  wrapper-escalation must not clobber a more specific subagent
  escalation that is already on disk. Concretely: the guard's
  `[ "$PRIOR_STATUS" = "escalated" ] && exit 0` returns early
  regardless of whether THIS write was going to land `status:
"clean"` or `status: "escalated"`.
- **It does not validate the prior artifact's shape.** A malformed
  prior artifact (corrupted JSON, missing `.status`) reads as the
  empty string from `jq -r '.status' 2>/dev/null` and the guard
  falls through to the clean-exit write — which then atomically
  overwrites the malformed file with a well-formed one.
