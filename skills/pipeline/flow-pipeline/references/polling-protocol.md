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
  GitHub rate limits are generous at this rate.) **Unconditional on
  the first iteration** — empty `gh` results never short-circuit
  the wait when presence is affirmed; only the presence checks
  below can legitimately skip.
- **Optional back-off:** documented but **not active in PR 2**. If
  cost telemetry from PR 6 shows the in-turn token cost growing,
  switch to: 30s for the first 5 polls, then 60s, then 90s. Pinned
  here so the implementation is one-line when we want it.

## Hard cap

**20 minutes from the first poll.** If neither CI nor a bot review
has reached a terminal state by then, escalate `NEEDS HUMAN: ci-hang
<url>` and end. The PR + worktree are preserved.

## Per-poll counter

Each iteration prints exactly one summary line on stdout so the user
reading scrollback (or attaching mid-wait) can see progress at a
glance:

```
CI poll <N>/40, elapsed <X>m<Y>s of 20m
```

`N` starts at 1 and increments each iteration; `40` is the cap (20
min ÷ 30s cadence). `<X>m<Y>s` is wall-clock elapsed since the first
poll began. The line is rendered before the gh calls fire — if the
calls fail or hang, the user still sees the iteration started.

## Presence checks

The first poll on a freshly-opened PR may legitimately return empty
results because nothing has been posted yet. To distinguish "not
posted yet" (keep polling) from "not configured" (legitimately skip
the wait), the supervisor runs two one-shot presence checks **once at
loop entry**, before the first poll:

### CI workflows

```bash
find .github/workflows -maxdepth 1 \( -name '*.yml' -o -name '*.yaml' \) \
  -print -quit 2>/dev/null
```

Non-empty stdout → at least one workflow file exists → `CI_CONFIGURED=1`.
Empty → `CI_CONFIGURED=0`; the supervisor treats `ci_passed` as vacuously
true and never calls `gh pr checks`.

This is a filesystem check, not an API call: the supervisor is already
inside the worktree, the answer is deterministic from disk, and a
filesystem stat costs nothing.

### Copilot reviewer

```bash
gh pr view "$PR" --json reviewRequests \
  --jq '[.reviewRequests[].login] | map(ascii_downcase) | join(",")'
```

If the configured Copilot login (`copilot-pull-request-reviewer` by
default — see "Bot reviewer name" below) appears in the list,
`COPILOT_REQUESTED=1`. Otherwise `COPILOT_REQUESTED=0`; the supervisor
treats `copilot_posted` as vacuously true and never waits the 10-min
bot timeout.

### Why per-PR `reviewRequests` and not `gh api .../installations`

The intuitive alternative — `gh api repos/<owner>/<repo>/installations`
— requires a GitHub App JWT to authenticate. User tokens (which `gh`
issues by default) get `401: A JSON web token could not be decoded`
from that endpoint. Per-PR requested-reviewers is the right
substitute: it answers a strictly more useful question ("is Copilot
expected on **this** PR?") with no auth ceremony, and `scripts/ci-wait.ts`
already uses the same approach via `prRequestedReviewers`.

### Override semantics

Once both presence flags are resolved, the per-poll derivations of
`ci_passed` / `ci_failed` / `copilot_posted` are **overridden** as
follows on every iteration:

- `CI_CONFIGURED == 0` → `ci_passed := true`, `ci_failed := false`,
  `ci_terminal := true` (vacuous; the `gh pr checks` call is also
  skipped for the iteration).
- `COPILOT_REQUESTED == 0` → `copilot_posted := true` (vacuous; the
  10-minute bot-timeout branch in the decision matrix is unreachable).

When both flags are 0 the loop exits on its first iteration without
waiting, which is the correct behaviour for a repo with no CI and no
bot reviewer configured.

## Per-poll commands

Run both each iteration. Both are read-only and idempotent.

```bash
# CI check status — terminal states are SUCCESS, FAILURE, CANCELLED,
# TIMED_OUT, SKIPPED, STARTUP_FAILURE, STALE. Pending states are
# PENDING, QUEUED, IN_PROGRESS. `gh pr checks` does not expose a
# `conclusion` JSON field — `state` already encodes the verdict, and
# requesting `conclusion` triggers an `Unknown JSON field` error from
# `gh` (see `scripts/ci-wait.ts` for the same hard-won lesson).
gh pr checks <pr> --json name,state

# Reviews from any source (Copilot, humans, other bots).
gh pr view <pr> --json reviews,state
```

Combine the two JSON payloads in shell (jq) to derive a single state
per poll:

```
ci_terminal     := every check has state ∉ {PENDING, QUEUED, IN_PROGRESS}
ci_passed       := ci_terminal AND every state ∈ {SUCCESS, SKIPPED}
ci_failed       := ci_terminal AND any state ∈ {FAILURE, CANCELLED, TIMED_OUT, STARTUP_FAILURE, STALE}
copilot_posted  := some review where author.login matches the configured
                   bot login (default `copilot-pull-request-reviewer`,
                   case-insensitive exact match) AND
                   review.state ∈ {APPROVED, CHANGES_REQUESTED, COMMENTED}
pr_state        := <`OPEN`, `MERGED`, `CLOSED`>
```

## Decision matrix

Re-evaluate after each poll. The `ci_passed` / `ci_failed` /
`copilot_posted` columns are the **post-override** values — see
"Presence checks" above for how `CI_CONFIGURED=0` and
`COPILOT_REQUESTED=0` short-circuit the corresponding waits.

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

Default reviewer login: `copilot-pull-request-reviewer`. The supervisor
treats a bot review as posted only when `reviews[].author.login`
matches the configured login by exact (case-insensitive) string
equality. Substring matching (`contains "Copilot"`) is wrong — the
real GitHub Copilot reviewer's login is `copilot-pull-request-reviewer`,
not `Copilot`, and a substring rule risks colliding with unrelated
reviewer names.

If the repo uses a different bot reviewer (e.g. `coderabbitai`), the
supervisor reads the reviewer login from `~/.flow/config.json` (the
per-machine config introduced in PR 1). If the file is absent or
doesn't define one, fall back to `copilot-pull-request-reviewer`.

`scripts/ci-wait.ts` makes the same choice for the same reason — see
its `DEFAULT_CONFIG.bots` and the rationale comment above it.

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
