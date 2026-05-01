---
name: flow-pipeline
description: >-
  Supervisor skill for the tmux-driven flow pipeline. Drives one feature
  end-to-end (triage → worktree → plan → implement → verify → ci-wait →
  review → gate → merge) inside a single Claude Code session. Use ONLY
  when invoked by `flow new <description>`'s seed prompt or via an
  explicit `/flow-pipeline <description>`. Do NOT auto-trigger on
  generic "build X" / "implement Y" phrasing — that hijacks unrelated
  chats. The skill is one long-running supervisor turn per phase, not a
  sub-agent.
argument-hint: '"<feature description>"'
disable-model-invocation: true
---

# Goal

You are the supervisor of one tmux window's pipeline. The user typed
`flow new "<description>"` from a terminal; tmux opened a window,
launched Claude Code in it, and seeded this chat with a prompt that
invokes you. From here, you drive the pipeline from prompt to
**`MERGED`**, **`gated`**, or **`NEEDS HUMAN: <reason>`** — the user
walks away after approving the plan and reads the result later.

You are the single LLM container for this pipeline. Every sub-skill
(`/product-planning`, `/new-feature`, `/verify`, `/pr-review`) loads
in-process when you invoke it; every helper script
(`flow-new-worktree`, `flow-remove-worktree`, `gh`, etc.) is a Bash
tool call. **You never spawn a Task-tool sub-agent.** Sub-agents
can't spawn sub-agents (the one-level cap), and a long-running
supervisor with sub-agents would blow the context window. Stay
in-process for skills; shell out for scripts; never delegate.

# When to Use

- Invoked from `flow new`'s seed prompt: `Use the /flow-pipeline
  skill for: <description>`.
- Explicit user invocation: `/flow-pipeline "<description>"`.

# When NOT to Use

- Generic "add X" / "implement Y" phrasing without `/flow-pipeline`
  or a `flow new` seed. Use `/new-feature` directly for one-shot
  feature work in the user's existing session.
- The user wants to step through phases manually (no auto-progression).
  Use the individual skills (`/product-planning`, `/new-feature`,
  `/verify`, `/pr-review`) directly.
- Resume after a Claude Code crash → `flow new --resume <name>` is
  the entry point (PR 9; not yet implemented). When that lands, this
  skill gains a `--resume` mode that walks the resume-from-disk tree
  in `references/failure-recovery.md`.

# Hard rules

> **You are never a sub-agent.** Never call the `Task` / `Agent`
> tool from this skill. Never spawn a separate `claude -p`
> subprocess. The supervisor's only fan-out is (a) loading
> sub-skills in-process and (b) Bash tool calls.

> **You never bypass the helper scripts.** Always call
> `flow-new-worktree`, `flow-remove-worktree`,
> `flow-fetch-pr-review`, and `flow-reply-pr-comments` rather than
> reimplementing their behaviour with raw `git` / `gh` calls. The
> helpers handle edge cases (existing worktrees, branch collisions,
> review-comment ID mapping) that are easy to get wrong.

> **You never silently retry past the documented caps.** Verify: 3
> outer attempts. CI-fix loop: 3 total. Review-fix loop: 2 total.
> Past these, escalate `NEEDS HUMAN: <reason>` and end. The
> per-step cap table is in `references/failure-recovery.md`.

> **You never edit code in the main repo's worktree.** Every code
> change happens inside the per-task worktree directory created by
> `flow-new-worktree` in step 2 (the absolute path the helper prints,
> exposed as `$WORKTREE` in this skill). The main worktree is
> read-only from this skill's perspective.

# Status writes: two surfaces, both updated together

PR 1 ships **two** state surfaces. The supervisor must update both at
every phase transition; `flow ls` joins them.

| File | Scope | Carries | Why split |
|---|---|---|---|
| `~/.flow/state/<slug>.json` | global, survives worktree cleanup | `slug`, `repo`, `worktree`, `phase`, `pr`, `updatedAt` | persists after merge so `flow ls` can still show the slug + PR for a recently-merged pipeline |
| `<worktree>/.flow-status` | per-worktree text | `phase`, `last_transition_at` | atomic two-line file; the live source of truth that `flow ls` displays |

`flow new` creates the global state file with `phase: "starting"`.
**You must update both** at every transition.

## At every phase transition, run both writes

```bash
# 1. Per-worktree status (atomic via tmp + rename).
printf 'phase: %s\nlast_transition_at: %s\n' \
  "$PHASE" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$WORKTREE/.flow-status.tmp" \
  && mv "$WORKTREE/.flow-status.tmp" "$WORKTREE/.flow-status"

# 2. Global registry (helper handles atomic JSON merge).
flow-state-update "$SLUG" --phase "$PHASE"
```

Use the `flow-state-update` helper rather than writing the JSON
yourself — it merges fields preserving repo, worktree, pr, and
refreshes `updatedAt`. The helper exits non-zero if the slug has no
state file, which surfaces drift instead of papering over it.

`$PHASE` must be one of the values listed in the phase table below.
`$WORKTREE` is the absolute worktree path returned by
`flow-new-worktree`. `$SLUG` is the worktree directory's basename
(e.g. `csv-export`).

## Additional fields to set once

Beyond phase, two fields ship via `flow-state-update` exactly once
during a pipeline:

```bash
# After step 2 (worktree create): record the absolute path so
# `flow ls` can read .flow-status without scraping disk.
flow-state-update "$SLUG" --phase worktree-create --worktree "$WORKTREE"

# After step 5 (PR opens): record the PR number so flow ls shows
# the #142 column.
flow-state-update "$SLUG" --phase implementing --pr "$PR"
```

After the PR is set, never overwrite it — subsequent transitions
just pass `--phase`, the helper preserves `pr` from the existing
file.

# The 10-step pipeline

Each step's phase value goes to `.flow-status` *before* the step's
work starts. The step ends when its end-condition is met; the next
step's phase value is written next. There is **no inter-step state
file** — the worktree contents and the PR are the state.

## Step 1 — Triage

**Phase:** `triaging`

Classify the request. Apply the heuristics from `flow-add` /
`docs/phases/triage.md`:

| Pattern | Class |
|---|---|
| "how does X work?", "explain Y", "what's the difference …" | no-change |
| "add", "implement", "build", "fix", "refactor", "change", "remove" | change |
| Ambiguous ("I'm thinking about …", "what would it take to …") | **ASK** before classifying |

Then assign an **intent**: `feature` / `bug` / `refactor` / `docs` /
`infra` / `chore`. Intent governs whether step 4 (approval) runs:
`feature` triggers the plan checkpoint; non-feature intents skip it.

**End conditions:**

- **No-change** → answer the user's question in chat directly. End
  the turn. Do NOT proceed to step 2.
- **Change** → derive a 3-5 word kebab-case **slug** from the
  request (e.g. `csv-export`, `version-flag`). Continue to step 2.

If classification is ambiguous after one clarifying question,
escalate `NEEDS HUMAN: triage-ambiguous` and end.

## Step 2 — Worktree

**Phase:** `worktree-create`

Create the per-task worktree:

```bash
flow-new-worktree <slug>
```

Capture the absolute worktree path it prints. Set `$WORKTREE` to
this for the rest of the pipeline. **`cd` into the worktree** —
every subsequent step runs from there.

Then record the path in the global state file (the only step where
`--worktree` is set):

```bash
flow-state-update "$SLUG" --phase worktree-create --worktree "$WORKTREE"
```

The `<worktree>/.flow-status` write happens after the worktree
exists, in the same shape pinned in the "Status writes" section.

**End condition:** the worktree directory exists, is on a fresh
branch, and `pwd` matches `$WORKTREE`.

On non-zero exit: escalate `NEEDS HUMAN: worktree-create-failed
<stderr>` and end.

## Step 3 — Plan

**Phase:** `planning`

Invoke `/product-planning` in-process with the user's verbatim
request as the argument:

```
/product-planning <verbatim user description>
```

`/product-planning` produces a PRD + task breakdown + PR-description
draft and writes the consolidated artifact to `<worktree>/plan.md`.

After it returns, **read `<worktree>/plan.md`** and print a 3-5
line summary to chat (just the problem statement and the task
titles — the user reads scrollback).

**End conditions:**

- Intent is `feature` → write `phase: plan-pending-review` and
  **end the turn**. Wait for the user to attach and respond. The
  next turn re-enters at step 4.
- Non-feature intent (`bug`/`refactor`/`docs`/`infra`/`chore`) →
  skip the checkpoint and continue directly to step 5. The plan
  still exists on disk for traceability, but the user wasn't asked
  to ratify it.

If `/product-planning` doesn't write `plan.md`, re-invoke once with
an explicit instruction to write the consolidated artifact. If the
second attempt also fails, escalate `NEEDS HUMAN: plan-missing`.

## Step 4 — Approval handling

**Phase:** `plan-pending-review` (set by step 3 for feature intent)

This step runs only when the next turn arrives — i.e. when the user
typed something into the tmux chat. Classify the input using
`references/redirect-handling.md`:

- **Affirmative** ("approved", "looks good", "go ahead", etc.) →
  continue to step 5.
- **Imperative redirect** ("actually, also handle TSV"; "redo with
  X") → loop back to step 3, appending the redirect to the
  `/product-planning` prompt as `USER REDIRECT (received during
  plan-pending-review): <verbatim>`.
- **Cancel** ("cancel", "abort") → run `flow-remove-worktree
  <slug>`, write `phase: cancelled`, print `cancelled`, end.
- **Ambiguous** → ask one clarifying question; if still unclear,
  escalate `NEEDS HUMAN: approval-ambiguous`.

## Step 5 — Implement

**Phase:** `implementing`

Invoke `/new-feature` in-process. On the first entry to this step,
pass the user's request:

```
/new-feature <verbatim user description>
```

The skill writes code + tests, runs verify internally as a
pre-commit gate, commits, pushes, and opens the PR via `gh`.
Capture the PR number after it returns:

```bash
gh pr view --json number --jq '.number'
```

Set `$PR` to this for the rest of the pipeline. Then record it in
the global state (the only step where `--pr` is set):

```bash
flow-state-update "$SLUG" --phase implementing --pr "$PR"
```

**Re-entry from a fix loop** (called from step 7 ci-red or step 8
review-critical): pass mode=fix and the failure log:

```
/new-feature mode:fix
PRIOR FAILURE LOG:
<truncated log>
```

`/new-feature` knows to make a focused fix commit on the existing
branch and push, without opening a new PR. After re-entry, return
to step 7 (CI wait), **not** directly to step 8 — a fix can break
CI just as easily as it can resolve a review finding.

**End condition:** `$PR` is set; the branch has been pushed.

On non-zero exit without a PR: retry once with the failure context
appended. If the retry also fails, escalate `NEEDS HUMAN:
implement-failed`.

## Step 6 — Local verify

**Phase:** `verifying`

Invoke `/verify` in-process inside the worktree.

**Outer cap: 3 attempts.** `/verify` self-loops internally; the
outer cap fires only when `/verify` exits without a clean pass.
Each retry re-invokes `/verify` with the prior attempt's failure
log appended to the prompt:

```
/verify

PRIOR ATTEMPT FAILED — failure log:
<truncated log; cap 200 lines / 100 matched-error lines>
```

After three failed outer attempts, escalate `NEEDS HUMAN:
verify-exhausted`. Surface the final failure log on the PR body's
`## Manual validation` section as a `> [!CAUTION]` block (idempotent —
edit-in-place, do not stack):

```bash
gh pr view "$PR" --json body --jq '.body' > /tmp/body.md
# upsert caution block under ## Manual validation, then
gh pr edit "$PR" --body-file /tmp/body.md
```

**End condition:** `/verify` exits clean (an outer attempt 1, 2, or
3 succeeds).

## Step 7 — CI + Copilot wait

**Phase:** `ci-wait`

Sleep + poll loop. Cadence + cap from
`references/polling-protocol.md`:

- 30s between polls.
- 20-min hard cap from first poll.
- Bot review timeout: 10 min after CI goes terminal.

Each poll runs:

```bash
# `gh pr checks` does not expose a `conclusion` JSON field — `state`
# already encodes the verdict. See `references/polling-protocol.md`
# and the matching note in `scripts/ci-wait.ts` for the hard-won
# lesson behind this.
gh pr checks "$PR" --json name,state
gh pr view "$PR" --json reviews,state
```

Loop body (in the supervisor's own turn):

```
while elapsed < 20m:
  poll
  case decision (see references/polling-protocol.md decision matrix):
    ci_passed && copilot_posted        → break, go to step 8
    ci_passed && copilot_timed_out     → break, go to step 8 (no bot review)
    ci_failed                          → break, go to step 5 with mode=fix
    pr_state == MERGED                 → break, run flow-remove-worktree, MERGED
    pr_state == CLOSED                 → escalate pr-closed-mid-flight
    still_pending && elapsed < 20m     → sleep 30s, poll again
    still_pending && elapsed >= 20m    → escalate ci-hang
```

**Fix-loop cap: 3 total ci-fix loops** across the whole pipeline.
After the third red CI, escalate `NEEDS HUMAN: ci-fix-exhausted`.

**End condition:** decision is "proceed to review", "merged
externally", or escalation.

## Step 8 — Review

**Phase:** `reviewing`

Invoke `/pr-review` in-process with the PR number:

```
/pr-review <PR>
```

**Native invocation** — no `RESULT_JSON_PATH` or other machine-mode
flags. The skill auto-detects Address vs Review mode from the
existing PR state and:

- In Address mode (existing inline review comments to address):
  resolves each, commits, pushes.
- In Review mode (no existing comments to address): runs the
  multi-agent independent review, posts findings as inline
  comments, auto-fixes any critical findings, commits, pushes.

**Fix-loop cap: 2 total review-fix loops.** If `/pr-review`
surfaces critical findings that it can't auto-fix, loop back to
step 5 with mode=fix and the finding details. After the second
loop-back, escalate `NEEDS HUMAN: review-fix-exhausted`.

After `/pr-review` commits + pushes, **return to step 7** (CI
wait), not directly to step 9. The fix commit may have changed CI.

**End condition:** `/pr-review` returns clean (no critical
findings outstanding) AND the most recent CI cycle is green.

On non-zero exit from `/pr-review`: retry once. If the retry also
fails, escalate `NEEDS HUMAN: review-failed`.

## Step 9 — Auto-merge gate

**Phase:** `gating`

Apply `references/auto-merge-rubric.md`. Read the PR body, extract
the `## Manual validation` section, strip HTML comments, trim:

```bash
gh pr view "$PR" --json body,state,mergeCommit
```

Decision matrix:

| State | Section after trim | Action |
|---|---|---|
| `OPEN` | empty | Go to step 10 (auto-merge). |
| `OPEN` | non-empty | Write `phase: gated`. Print: `GATED:`, the PR URL, the validation steps verbatim, and `merge with: gh pr merge --squash <PR>`. End. |
| `MERGED` | (any) | Already merged externally. Run `flow-remove-worktree <slug>`. Write `phase: merged`. Print `MERGED`. End. |
| `CLOSED` | (any) | Escalate `NEEDS HUMAN: pr-closed-without-merge`. End. |

**Defensive cases:**

- Manual-validation heading missing → escalate `NEEDS HUMAN:
  manual-validation-section-missing`. Don't treat as empty.
- `gh` non-zero or unparseable JSON → escalate `NEEDS HUMAN:
  gh-error <stderr>`.

## Step 10 — Merge

**Phase:** `merging`

```bash
gh pr merge --squash --delete-branch "$PR"
```

Then:

```bash
flow-remove-worktree <slug>
```

Then write `phase: merged` and print `MERGED` on its own line. End.

On `gh pr merge` failure: retry once. If still failing, escalate
`NEEDS HUMAN: merge-failed`. Leave the worktree intact.

# End conditions

Every pipeline ends with one of these on its own line, so a user
reading scrollback or running `flow ls` knows the state at a
glance:

| Output | Phase value | Meaning |
|---|---|---|
| `MERGED` | `merged` | PR squash-merged, branch deleted, worktree removed. |
| `GATED: <url>` | `gated` | PR open; user must validate and merge manually. |
| `NEEDS HUMAN: <reason>` | `needs-human` | Pipeline stalled; user attaches + redirects. Worktree + PR intact. |
| `cancelled` | `cancelled` | User cancelled before merge. Worktree removed. |

After printing the end-condition line, **end the turn**. The tmux
window stays open with full scrollback. The user closes it later
with `flow done <name>`.

# Failure paths

The general rule: **escalate over silent retry**. Each step has a
documented retry budget; once exhausted, write `phase: needs-human`,
print `NEEDS HUMAN: <reason>`, and end. Do **not** call
`flow-remove-worktree` on escalation — leave the worktree + PR
intact so the user can inspect and resume.

The full per-step cap table and the resume-from-disk decision tree
live in `references/failure-recovery.md`.

# Mid-flight redirects

The user can type into the tmux chat at any phase boundary or
mid-phase. Apply `references/redirect-handling.md`:

- Affirmative input mid-phase → acknowledge, keep going.
- Imperative redirect → re-enter the relevant phase with the
  redirect appended to the next prompt. Verbatim — don't paraphrase.
- Cancel → wait for any in-flight atomic action (commit, push,
  merge) to finish, then close the PR if open, run
  `flow-remove-worktree`, write `phase: cancelled`, print
  `cancelled`, end.
- Ambiguous → one clarifying question; if still unclear, escalate.

# Quick reference: phase values

In write-order on the happy path:

```
triaging
worktree-create
planning
plan-pending-review     (feature only; ends turn)
implementing
verifying
ci-wait
reviewing
gating
merging
merged                  (terminal)
```

Off-path terminals: `gated`, `needs-human`, `cancelled`.

# Verification (this skill)

After each phase transition:

- `<worktree>/.flow-status` exists and contains the two pinned
  lines (`phase:` + `last_transition_at:`).
- `~/.flow/state/<slug>.json` exists and reflects the same `phase`,
  the populated `worktree` and (post-step-5) `pr` fields, and a
  fresh `updatedAt`.
- `flow ls` (run from any terminal) shows the right phase **and PR
  number** for this pipeline's window.
- The supervisor never invoked the `Task` / `Agent` tool.
- The supervisor never spawned a `claude -p` subprocess.

When the pipeline ends, scrollback contains exactly one of `MERGED`
/ `GATED: <url>` / `NEEDS HUMAN: <reason>` / `cancelled` on its own
line, and the corresponding `phase:` is in `.flow-status`.
