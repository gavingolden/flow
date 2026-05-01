# Polling protocol

How the supervisor waits for CI and the bot reviewer (Copilot) to
finish on an open PR. This is a sleep + poll loop run as Bash tool
calls inside one conversation turn.

## Goals

1. Detect "CI is terminal AND a bot review has posted" so step 8
   (review) can run.
2. Detect "CI is terminal but no bot review will arrive" so the
   pipeline doesn't block forever on a Copilot timeout.
3. Detect "CI failed" so step 7 can loop back to implement(fix)
   without waiting the full cap.
4. Cap total wait time so a hung CI doesn't burn unbounded context.

## Cadence

- **Initial cadence:** 30 seconds between polls. (Matches the
  legacy `ci-wait.ts` baseline; `gh pr checks` JSON is small and
  GitHub rate limits are generous at this rate.)
- **Optional back-off:** documented but **not active in PR 2**. If
  cost telemetry from PR 6 shows the in-turn token cost growing,
  switch to: 30s for the first 5 polls, then 60s, then 90s. Pinned
  here so the implementation is one-line when we want it.

## Hard cap

**20 minutes from the first poll.** If neither CI nor a bot review
has reached a terminal state by then, escalate `NEEDS HUMAN: ci-hang
<url>` and end. The PR + worktree are preserved.

## Per-poll commands

Run both each iteration. Both are read-only and idempotent.

```bash
# CI check status — terminal states are SUCCESS, FAILURE, CANCELLED, TIMED_OUT.
# PENDING and IN_PROGRESS mean "keep polling".
gh pr checks <pr> --json name,state,conclusion

# Reviews from any source (Copilot, humans, other bots).
gh pr view <pr> --json reviews,state
```

Combine the two JSON payloads in shell (jq) to derive a single state
per poll:

```
ci_terminal     := all checks have conclusion ∈ {SUCCESS, FAILURE, CANCELLED, SKIPPED}
ci_passed       := ci_terminal AND every conclusion ∈ {SUCCESS, SKIPPED}
ci_failed       := ci_terminal AND any conclusion ∈ {FAILURE, CANCELLED, TIMED_OUT}
copilot_posted  := reviews[].author.login contains "Copilot" AND review.state ∈ {APPROVED, CHANGES_REQUESTED, COMMENTED}
pr_state        := <`OPEN`, `MERGED`, `CLOSED`>
```

## Decision matrix

Re-evaluate after each poll:

| `ci_passed` | `ci_failed` | `copilot_posted` | Elapsed | Decision |
|---|---|---|---|---|
| true | — | true | — | **proceed to step 8 (review)**. |
| true | — | false | < 10 min after `ci_terminal` | **keep polling** (waiting on Copilot). |
| true | — | false | ≥ 10 min after `ci_terminal` | **proceed to step 8 without bot review** (Copilot timed out). |
| — | true | — | — | **loop back to step 5 in fix mode** (cap: 3 fix-loops total before escalation). Pass the failing-check log into the implement-fix prompt. |
| false | false | — | < 20 min from first poll | **keep polling** (CI still in progress). |
| false | false | — | ≥ 20 min from first poll | **escalate `NEEDS HUMAN: ci-hang`**. End. |
| — | — | — | `pr_state == CLOSED` mid-poll | **escalate `NEEDS HUMAN: pr-closed-mid-flight`**. End. |
| — | — | — | `pr_state == MERGED` mid-poll | the user merged manually; **skip review and gate, run `flow-remove-worktree`, print `MERGED`, end**. |

## The fix-loop cap

When CI fails, the supervisor loops back to step 5 (implement) in
`fix` mode with the failing-check log appended to the prompt. The
cap is **3 fix-loops** across the whole pipeline — after the third
red CI, escalate `NEEDS HUMAN: ci-fix-exhausted` and end. Each
fix-loop counts regardless of whether CI was failing for the same
reason (a different test failing on attempt 2 still counts).

## Bot reviewer name

Default: `Copilot`. If the repo uses a different bot reviewer (e.g.
`coderabbitai`), the supervisor reads the bot name from
`~/.flow/config.json` (the per-machine config introduced in PR 1).
If the file is absent or doesn't define one, fall back to `Copilot`.

## What "in one conversation turn" means for this loop

The supervisor's polling loop is a Bash tool call followed by a
`sleep`, looped inside the supervisor's *own* turn — there is no
separate "agent invocation" per poll. Every poll's tool result
appends to the conversation, but the payloads are small (CI JSON +
reviews JSON ≈ 1-2 KB each). At 30s cadence and a 20-min cap, that's
~40 polls × 2-4 KB = ~80-160 KB of conversation growth in the worst
case. Within budget.

The legacy `ci-wait.ts` script ran in a separate process to keep the
orchestrator stateless. The new design keeps state in the supervisor
session; the trade-off is conversation growth, which we monitor in
PR 6.

## When to revisit this protocol

- PR 6 (cost reporting) surfaces per-pipeline `$` spent. If polling
  is responsible for a meaningful fraction of cost on idle pipelines,
  enable the back-off above.
- If GitHub starts rate-limiting `gh pr checks` at 30s cadence
  (currently fine), back off to 60s baseline.
- If Copilot routinely takes > 10 min after CI terminal, raise the
  Copilot timeout. (Today it's well under 5 min on most repos.)
