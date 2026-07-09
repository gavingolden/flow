# Redirect handling

How the supervisor interprets free-form user input that arrives via
the tmux window's chat. The user can type at any phase boundary or
mid-phase; the supervisor's next turn must classify the input and
either continue, redirect, or escalate.

## Input categories

Every chat-turn input falls into one of:

- **Affirmative.** `approved`, `ok`, `looks good`, `go ahead`,
  `ship it`, `yes`, `lgtm`, `proceed`, `do it`. Means "continue
  what you were going to do."
- **Imperative redirect.** A non-approval message that contains a
  directive: `actually, also handle TSV`; `redo the plan with
different scope`; `stop and rebuild against the new schema`;
  `ignore the failing flake test on src/util/race.test.ts`.
  Imperative redirects split into two kinds: (i) **scope/plan
  redirects**, which re-run `/product-planning` or re-prompt the
  in-flight sub-skill (the existing behaviour), and (ii)
  **code-change redirects** (`rename foo to bar`, `change this line`),
  which route through `/coder` — see "Code-change redirects route
  through /coder" below.
- **Cancel.** `cancel`, `abort`, `kill this`, `stop the pipeline`,
  `shut it down`. Means "tear down and exit."
- **Checkpoint.** `checkpoint`, `checkpoint this`, `save state
before I clear`. Means "flush the load-bearing conversational
  state to disk so I can `/clear` without losing it." Load the
  `/checkpoint` skill in-process (via the `Skill` tool — no `Task`
  spawn, no new exemption): it summarizes pending approval
  conditions/addenda, unmaterialized redirects, and explicit in-chat
  decisions to `<worktree>/.flow-tmp/checkpoint.md`, runs
  `flow-checkpoint` to write the one-shot `checkpoint.pending`
  marker, tells the user it is safe to `/clear`, and ends the turn.
  It does NOT auto-`/clear` (Claude cannot self-invoke `/clear`).

Inputs that don't clearly fall into one of these are **ambiguous** —
ask one clarifying question; if still unclear, escalate `NEEDS HUMAN:
input-ambiguous`.

## Code-change redirects route through /coder

A code-change-shaped imperative redirect is routed through `/coder`,
distinct from a scope/plan redirect that re-runs `/product-planning`.
At the five worktree-existing phases — `plan-pending-review`,
`implementing`, `verifying`, `ci-wait`, `reviewing` — a NON-trivial
code-change redirect is the **interactive code-change redirect** path:
the supervisor composes the edit-set `{file, intent, expected_outcome}`
from the verbatim redirect text (bare triples — the optional
`contract` / `acceptance` edit-set fields are composed only when a plan
contract is available, which a free-form redirect is not), invokes
`/coder` in-process, and reads `.flow-tmp/coder-result.json` once (never
the per-edit diff). A trivial
edit (≤1 file AND ≤30 LOC AND every file named in the redirect) stays
inline. This does NOT replace the scope/plan re-run path — that path
still re-runs `/product-planning` or re-prompts the sub-skill for
scope/plan redirects. `skills/pipeline/flow-pipeline/SKILL.md` (its
"Mid-flight code-change redirects" section) is the source of truth.

**Bug callout at `gated` (terminal) — explicit carve-out.** `gated` is a
terminal phase, deliberately absent from the five in-flight phases above.
But a code-change redirect (a bug callout) arriving while the PR sits at
`gated` during manual validation still routes through `/coder` → re-verify
(step 6) → re-gate (step 9), preserving the gated-is-terminal /
no-new-merge-authority invariant. This is distinct from a post-`gated`
_merge_ instruction ("merge this gated PR anyway"), which is a **gate
override** governed by "Gate override" below — not a `/coder` route. The
re-gate merges only through `flow-merge-guard`; the `/coder` loop grants
no new merge authority. On a fresh session, `flow-resume-decide` resolves
`gated` + a checkpoint marker to the `gated-feedback` resume mode, which
is the auto-resumed entry into exactly this loop.

## Phase × input action matrix

The action depends on **where the supervisor was** when the input
arrived. The phase column is the value the supervisor was about to
write (or just wrote) to `~/.flow/state/<slug>.json` via
`flow-state-update`.

| Phase                                            | Affirmative                                                                                                                               | Redirect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Cancel                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `triaging`                                       | Continue triage.                                                                                                                          | Restart triage with the redirect appended to the prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Render the CANCELLED block via `flow-gate-summary --status cancelled --why "<context>"`, end. (No worktree to clean up — triage hasn't created one yet.)                                                                               |
| `worktree-create`                                | (n/a — no checkpoint here)                                                                                                                | (n/a)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | (n/a)                                                                                                                                                                                                                                  |
| `planning`                                       | (n/a — no checkpoint until plan ends)                                                                                                     | Append the redirect to the in-flight `/product-planning` invocation if possible; otherwise wait for it to end and re-run with the redirect.                                                                                                                                                                                                                                                                                                                                                                            | Wait for `/product-planning` to end, run `flow-remove-worktree`, render the CANCELLED block via `flow-gate-summary --status cancelled --why "<context>"`, end.                                                                         |
| `plan-pending-review`                            | Proceed to step 5 (implement).                                                                                                            | A scope/plan redirect re-runs `/product-planning` with the redirect appended (`<original prompt>\n\n<user redirect>`); re-enter `plan-pending-review` after. A non-trivial code-change redirect routes through `/coder` instead (see "Code-change redirects route through /coder").                                                                                                                                                                                                                                    | Run `flow-remove-worktree`, render the CANCELLED block via `flow-gate-summary --status cancelled --why "<context>"`, end.                                                                                                              |
| `implementing`                                   | Acknowledge ("noted, continuing"), keep going.                                                                                            | A scope/plan redirect appends to the `/new-feature` invocation if possible, else waits for the current attempt to end and re-prompts with the redirect appended. A non-trivial code-change redirect routes through `/coder` instead (see "Code-change redirects route through /coder").                                                                                                                                                                                                                                | Wait for the in-flight commit/push to finish (don't kill mid-write), then close the PR (`gh pr close <pr>`), run `flow-remove-worktree`, render the CANCELLED block via `flow-gate-summary --status cancelled --why "<context>"`, end. |
| `installing-skills`                              | Acknowledge, keep going. The phase is short-lived (one `flow install --upgrade` invocation).                                              | Hold the redirect until after step 5.5 returns; classify against the next phase's row (`verifying`).                                                                                                                                                                                                                                                                                                                                                                                                                   | Same as `implementing`: finish the in-flight `flow install` call (don't kill mid-symlink), close PR, cleanup, end.                                                                                                                     |
| `verifying`                                      | Acknowledge, keep going.                                                                                                                  | A scope/plan redirect appends to the next `/verify` attempt's prompt (e.g. "ignore the flake test on X"). A non-trivial code-change redirect routes through `/coder` instead (see "Code-change redirects route through /coder").                                                                                                                                                                                                                                                                                       | Same as `implementing`: finish the in-flight attempt, close PR, cleanup, end.                                                                                                                                                          |
| `ci-wait`                                        | Acknowledge, keep polling.                                                                                                                | Two flavours: (a) "stop waiting, proceed to review" → break out of the poll loop and go to step 8 (review). (b) "this CI failure isn't real, ignore it" → break out and go to step 5 in fix mode with the redirect as guidance. A non-trivial code-change redirect routes through `/coder` instead (see "Code-change redirects route through /coder").                                                                                                                                                                 | Same as `implementing`: close PR, cleanup, end.                                                                                                                                                                                        |
| `reviewing`                                      | Acknowledge, let `/pr-review` finish.                                                                                                     | Two flavours: (a) "skip the review, ship it" → break out and go to step 9 (gate). (b) "address this specific finding too" → append to the next `/pr-review` cycle. A non-trivial code-change redirect routes through `/coder` instead (see "Code-change redirects route through /coder").                                                                                                                                                                                                                              | Same as `implementing`: close PR, cleanup, end.                                                                                                                                                                                        |
| `gating`                                         | (n/a — gate is one decision)                                                                                                              | (n/a — the gate is one decision; a gate _override_ happens only _after_ the verdict, post-`gated` — see "Gate override" below)                                                                                                                                                                                                                                                                                                                                                                                         | (n/a — gate completes in milliseconds)                                                                                                                                                                                                 |
| `merging`                                        | (n/a)                                                                                                                                     | (n/a)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | (n/a — too late to cancel, the merge has fired)                                                                                                                                                                                        |
| `merged` / `gated` / `needs-human` / `cancelled` | "Anything else?" — these are end states; treat further input as a new request and ask the user whether they want to start a new pipeline. | Same — **except at `gated`**, where a redirect splits two ways: (a) a **bug callout / code-change redirect** routes through `/coder` → re-verify (step 6) → re-gate (step 9) — see "Bug callout at `gated`" above (the re-gate merges only through `flow-merge-guard`; no new merge authority); (b) a **merge instruction** ("merge this gated PR anyway") is a **gate override**: classify it per "Gate override" below, not as a new pipeline. The two `gated` sub-cases are distinct and neither is a new pipeline. | Same.                                                                                                                                                                                                                                  |

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

- **Fresh** — sent _after_ the GATED block was surfaced to the user. An
  instruction given earlier in the conversation, before the gate verdict
  existed, cannot authorise an override: the user had not seen the
  verdict, so they cannot have been responding to it.
- **Unambiguous** — an instruction that is _about merging this gated
  PR_. Bare "merge", "ship it", "lgtm", and equivalent merge-vocabulary
  inputs all qualify — they are unambiguously about merging, and the
  `AskUserQuestion` confirmation step that fires next is itself the
  conscious-confirmation surface that puts the verdict in front of the
  user. This test fails only on inputs that are not about merging at
  all — bare "cool", "thanks", "next", "ok", a question about an
  unrelated topic. Refusing to fire the form on a bare "merge" inverts
  the form's own design: the form is what makes the override conscious.
- **In-context** — actually about this gate verdict, not an instruction
  given for a different purpose that the supervisor _infers_ applies
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

**Override procedure.** When a post-`gated` instruction reaches the
supervisor:

0. **Re-query the live gate first.** Before deciding fire-form vs
   refuse-form, run `flow-gate-decide "$PR"` and branch on the live
   `decision`. The verdict in the supervisor's local context may be
   stale: between the GATED render and the user's merge instruction,
   the user can tick `- [ ]` boxes in the PR body and clear the gate
   themselves. Without the re-query, the supervisor refuses an override
   that isn't needed — re-rendering a verdict that no longer holds.
   - `decision: "auto-merge"` → the user cleared the gate themselves.
     **No override is needed.** Do NOT fire `AskUserQuestion`, do NOT
     call `--record-override`. Route directly to step 10's auto-merge
     path; the mechanical `flow-merge-guard` backstop there will
     re-confirm the cleared gate from the live body and let the merge
     through.
   - `decision: "gated"` → the gate genuinely still applies. Proceed
     to step 1 below with the softened "unambiguous" + retained
     "fresh" + retained "in-context" tests.
   - `decision: "merged-externally"` / `"closed-no-merge"` /
     `"escalate-heading-missing"` / `"escalate-gh-error"` → route per
     the existing step 9 decision table.
1. When the instruction passes all three tests (fresh + unambiguous +
   in-context), fire exactly one `AskUserQuestion` confirmation —
   naming the PR, the count of unchecked steps, and that they may
   include unverified functional checks — so the user confirms the
   override with the verdict in full view. This is the named
   `AskUserQuestion` exemption in SKILL.md "Hard rules".
2. On an affirmative answer, run `flow-merge-guard "$PR"
--record-override` to write the fresh-confirmation token, then
   re-enter step 10. On any non-affirmative answer, the PR stays
   `gated` — re-render the GATED block and end.

When the instruction fails the "fresh" or "in-context" test — or the
"unambiguous" test on an input that isn't about merging at all — do
**not** fire the confirmation and do **not** record a token. Re-render
the GATED block, restate that the verdict is terminal, and end. If the
user's intent is genuinely unclear, ask one clarifying question per the
ambiguous-input rule above.

Canonical precedent: the rule this section softens was established by
[PR #216](https://github.com/gavingolden/flow/pull/216) ("feat: make a
gated auto-merge verdict terminal", merged 2026-05-22). PR #216 made
the `gated` verdict terminal and added the three-test override bar; the
present softening keeps the verdict terminal and keeps the three-test
bar — it only widens the door to the `AskUserQuestion` form so the bare
"merge" case fires the conscious-confirmation surface rather than
refusing it, and adds the live re-query so a self-cleared gate routes
to auto-merge instead of a refused override.

## Don't conflate redirect with retry

A redirect changes the _intent_ of the next phase. A retry repeats
the _same_ phase with the same intent, hoping for a different
outcome. The supervisor never auto-retries on user redirect — it
always re-enters the relevant phase with the new intent appended.

Conversely, the supervisor never asks the user to confirm a retry
that's within the per-step budget (verify retries, ci-fix loops,
review-fix loops). Retries are autonomous; redirects are user-driven.

## What gets appended to the next prompt

When a redirect re-enters a phase, the supervisor builds the next
prompt as:

```
<original user request from `flow feature create`>

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
