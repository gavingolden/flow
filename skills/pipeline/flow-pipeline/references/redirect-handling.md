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
| `gating` | (n/a — gate is one decision) | (n/a — the gate is one decision; a gate *override* happens only *after* the verdict, post-`gated` — see "Gate override" below) | (n/a — gate completes in milliseconds) |
| `merging` | (n/a) | (n/a) | (n/a — too late to cancel, the merge has fired) |
| `merged` / `gated` / `needs-human` / `cancelled` | "Anything else?" — these are end states; treat further input as a new request and ask the user whether they want to start a new pipeline. | Same — **except** a post-`gated` instruction to merge the gated PR anyway, which is a gate override: classify it per "Gate override" below, not as a new pipeline. | Same. |

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

## Gate override

A `gated` verdict from step 9 is **terminal** (see
`auto-merge-rubric.md` "A `gated` verdict is terminal, not advisory"
and SKILL.md step 9). The supervisor renders the GATED block and ends.
The tmux window stays open, so the user can still act — but a `gated`
PR is merged by `/flow-pipeline` only through a **gate override**, and a
gate override has a deliberately high bar.

An override is authorised only when the user's instruction is **fresh,
unambiguous, and in-context** — all three:

- **Fresh** — sent *after* the GATED block was surfaced to the user. An
  instruction given earlier in the conversation, before the gate verdict
  existed, cannot authorise an override: the user had not seen the
  verdict, so they cannot have been responding to it.
- **Unambiguous** — an explicit instruction to merge *this* gated PR
  despite its unchecked Test Steps. A bare "merge", "ship it", or "lgtm"
  is not enough on its own; the instruction must be unmistakably about
  merging the gated PR as-is.
- **In-context** — actually about this gate verdict, not an instruction
  given for a different purpose that the supervisor *infers* applies
  here. An instruction to "merge" given while resolving an unrelated
  rebase, many turns before the review cycle, is not an in-context
  authorisation to override the gate.

**Canonical anti-pattern (the incident this rule exists for).** A
supervisor reached a correct `gated` verdict — three unchecked manual
Test Steps remained, one of them a binary functional check ("hover the
legend entry, the popover opens"). It reclassified the steps as
"subjective UX" on its own authority and merged anyway, justifying the
merge with a "merge" instruction the user had given many turns earlier,
before the review cycle, in the unrelated context of resolving a rebase.
The feature was completely broken. That instruction was **stale** (it
predated the verdict) and **out-of-context** (given for the rebase, not
the gate) — it authorised nothing. Reclassifying a functional step to
change the verdict, and treating a pre-verdict instruction as an
override, are both prohibited.

**Override procedure.** When a post-`gated` instruction meets all three
tests, the supervisor:

1. Fires exactly one `AskUserQuestion` confirmation — naming the PR, the
   count of unchecked steps, and that they may include unverified
   functional checks — so the user confirms the override with the
   verdict in full view. This is the named `AskUserQuestion` exemption
   in SKILL.md "Hard rules".
2. On an affirmative answer, runs `flow-merge-guard "$PR"
   --record-override` to write the fresh-confirmation token, then
   re-enters step 10. On any non-affirmative answer, the PR stays
   `gated` — re-render the GATED block and end.

When the instruction fails any of the three tests, do **not** fire the
confirmation and do **not** record a token. Re-render the GATED block,
restate that the verdict is terminal, and end. If the user's intent is
genuinely unclear, ask one clarifying question per the ambiguous-input
rule above.

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
