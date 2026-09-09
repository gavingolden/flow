# Compaction anchors — what a compacted supervisor must keep

`AGENTS.md`'s `## Compact Instructions` section carries the short
KEEP/DROP list Claude Code reads when it compacts a conversation. This
file is the long form: the per-phase anchor lists and the one rule that
makes a compaction survivable at all.

Offloaded here rather than inlined so `AGENTS.md` stays clear of Claude
Code's 40k per-session performance warning — the same offload-then-trim
discipline `references/exemption-contracts.md` follows.

## The reload rule (the load-bearing one)

**After a compaction, re-invoke the active sub-skill via the `Skill` tool
before continuing.**

A compaction summarises away the tool result that carried the sub-skill's
body. The supervisor is then running Steps 8-10's gate, merge and
escalation rules from a paraphrase of its own instructions — which is
exactly the failure the phase-write-fidelity eval suite exists to detect.
Reloading is cheap; acting on a summary of a contract is not.

This is why the anchor list below names **the active sub-skill and the
current step within it** (`/flow-pr-review` step 8, `/flow-new-feature`
step 5, …). The supervisor cannot reload instructions it no longer knows
it was following, so the identity of the skill is itself a resume anchor,
not just its output.

`/flow-pipeline`'s `# Resume mode` already reconstructs these same anchors
from disk after a crash. A compaction is the same problem without the
process restart, so it takes the same answer.

## KEEP — the review phase's resume anchors

During `/flow-pr-review` (supervisor step 8), the phase's state lives in
artifacts under `.flow-tmp/`, not in the transcript. Keep their paths:

- `.flow-tmp/pr-review-result.json` — the wrapper's status envelope
  (`clean` / `partial` / `escalated`) and, on `partial`, the missed-step
  list the retry resumes from.
- `.flow-tmp/review-prep.json` — `flow-review-prep`'s setup envelope (scope,
  gated lenses, size band, completeness, critical skips); losing it forces
  Steps 2-7 to re-derive scope from scratch instead of resuming.
- `.flow-tmp/fix-applier-result.json` — what the fix-applier changed,
  its rejected alternatives and anti-patterns, and any UI screenshots.
- `.flow-tmp/consolidator-result.json` — the merged, deduped,
  confidence-thresholded finding set.
- `.flow-tmp/review-scope.json` — the resolved scope and lens gates; a
  lost scope silently widens the next re-entry to all six lenses.
- `.flow-tmp/agent-output-*.json` — the per-lens raw findings.

## KEEP — the rest

- Current pipeline phase, PR number, worktree path, the current pipeline
  step, and any `NEEDS HUMAN: <reason>`.
- `.flow-tmp/plan.md` and `.flow-tmp/scout.md`.
- The active sub-skill and the step within it (see the reload rule).
- `state.interview` while either interview pending phase
  (`triage-pending-interview`, `plan-pending-interview`) is in flight —
  losing it forces re-asking answered questions.
- The pause-output contract — pause-point messages stay slot-labeled
  after compaction.

## DROP — reconstructable, high volume

- Verify failure-log excerpts, raw tool outputs, CI poll progress.
- The raw PR fetch output, the commit-body dump, and `.flow-tmp/diff.txt`
  — all re-derivable from `gh` and the artifacts above.

These are safe to drop precisely because `state.json`, the PR, and a
fresh `gh` / `flow-pre-commit` re-derive them on demand.
