# Redirect handling

How the supervisor interprets free-form user input that arrives via
the tmux window's chat. The user can type at any phase boundary or
mid-phase; the supervisor's next turn must classify the input and
either continue, redirect, or escalate.

## Three categories

Every chat-turn input falls into one of:

- **Affirmative.** `approved`, `ok`, `looks good`, `go ahead`,
  `ship it`, `yes`, `lgtm`, `proceed`, `do it`. Means "continue
  what you were going to do."
- **Imperative redirect.** A non-approval message that contains a
  directive: `actually, also handle TSV`; `redo the plan with
  different scope`; `stop and rebuild against the new schema`;
  `ignore the failing flake test on src/util/race.test.ts`.
- **Cancel.** `cancel`, `abort`, `kill this`, `stop the pipeline`,
  `shut it down`. Means "tear down and exit."

Inputs that don't clearly fall into one of these are **ambiguous** —
ask one clarifying question; if still unclear, escalate `NEEDS HUMAN:
input-ambiguous`.

## Phase × input action matrix

The action depends on **where the supervisor was** when the input
arrived. The phase column is the value the supervisor was about to
write (or just wrote) to `~/.flow/state/<slug>.json` via
`flow-state-update`.

| Phase | Affirmative | Redirect | Cancel |
|---|---|---|---|
| `triaging` | Continue triage. | Restart triage with the redirect appended to the prompt. | Render the CANCELLED block via `flow-gate-summary --status cancelled --why "<context>"`, end. (No worktree to clean up — triage hasn't created one yet.) |
| `worktree-create` | (n/a — no checkpoint here) | (n/a) | (n/a) |
| `planning` | (n/a — no checkpoint until plan ends) | Append the redirect to the in-flight `/product-planning` invocation if possible; otherwise wait for it to end and re-run with the redirect. | Wait for `/product-planning` to end, run `flow-remove-worktree`, render the CANCELLED block via `flow-gate-summary --status cancelled --why "<context>"`, end. |
| `plan-pending-review` | Proceed to step 5 (implement). | Re-run `/product-planning` with the redirect appended (`<original prompt>\n\n<user redirect>`). Re-enter `plan-pending-review` after. | Run `flow-remove-worktree`, render the CANCELLED block via `flow-gate-summary --status cancelled --why "<context>"`, end. |
| `implementing` | Acknowledge ("noted, continuing"), keep going. | Append the redirect to the `/new-feature` invocation if possible; otherwise wait for the current attempt to end and re-prompt with the redirect appended. | Wait for the in-flight commit/push to finish (don't kill mid-write), then close the PR (`gh pr close <pr>`), run `flow-remove-worktree`, render the CANCELLED block via `flow-gate-summary --status cancelled --why "<context>"`, end. |
| `installing-skills` | Acknowledge, keep going. The phase is short-lived (one `flow setup --upgrade` invocation). | Hold the redirect until after step 5.5 returns; classify against the next phase's row (`verifying`). | Same as `implementing`: finish the in-flight `flow setup` call (don't kill mid-symlink), close PR, cleanup, end. |
| `verifying` | Acknowledge, keep going. | Append the redirect to the next `/verify` attempt's prompt (e.g. "ignore the flake test on X"). | Same as `implementing`: finish the in-flight attempt, close PR, cleanup, end. |
| `ci-wait` | Acknowledge, keep polling. | Two flavours: (a) "stop waiting, proceed to review" → break out of the poll loop and go to step 8 (review). (b) "this CI failure isn't real, ignore it" → break out and go to step 5 in fix mode with the redirect as guidance. | Same as `implementing`: close PR, cleanup, end. |
| `reviewing` | Acknowledge, let `/pr-review` finish. | Two flavours: (a) "skip the review, ship it" → break out and go to step 9 (gate). (b) "address this specific finding too" → append to the next `/pr-review` cycle. | Same as `implementing`: close PR, cleanup, end. |
| `gating` | (n/a — gate is one decision) | (n/a — the user can override the gate by typing the merge verb themselves) | (n/a — gate completes in milliseconds) |
| `merging` | (n/a) | (n/a) | (n/a — too late to cancel, the merge has fired) |
| `merged` / `gated` / `needs-human` / `cancelled` | "Anything else?" — these are end states; treat further input as a new request and ask the user whether they want to start a new pipeline. | Same. | Same. |

## How to classify ambiguous input

Ask yourself: **does this input demand a change in what I do next?**

- "Looks good" with no other words → affirmative.
- "Looks good but also do X" → redirect (the `but also` part is the
  redirect).
- "Hmm" / "wait" / "let me think" → ambiguous, ask one clarifying
  question.
- A bare URL or PR number → ambiguous, ask what the user wants.
- Anything starting with "actually" or "instead" → almost always a
  redirect.

When in doubt, ask. The cost of asking is one chat turn; the cost
of misclassifying is a wasted phase.

## Don't conflate redirect with retry

A redirect changes the *intent* of the next phase. A retry repeats
the *same* phase with the same intent, hoping for a different
outcome. The supervisor never auto-retries on user redirect — it
always re-enters the relevant phase with the new intent appended.

Conversely, the supervisor never asks the user to confirm a retry
that's within the per-step budget (verify retries, ci-fix loops,
review-fix loops). Retries are autonomous; redirects are user-driven.

## What gets appended to the next prompt

When a redirect re-enters a phase, the supervisor builds the next
prompt as:

```
<original user request from `flow new`>

USER REDIRECT (received during <phase>):
<the user's verbatim chat input>
```

The verbatim input is preserved — don't paraphrase. If the user is
specific about a file, line, or bug, the sub-skill needs the exact
text to act on it.

## What the supervisor does NOT do

- It does not interpret a question (`why did you do X?`) as a
  redirect. Questions get answered in chat; the phase continues.
- It does not interrupt a write-in-progress (a commit, a PR open,
  a merge) to handle a cancel. The supervisor waits for the
  current atomic action to finish, then handles the cancel from a
  clean state.
- It does not silently swallow ambiguous input. If the supervisor
  isn't sure, it asks. One clarifying question per ambiguous input
  is the cap; after that, escalate.
