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
  the entry point. The wrapper re-launches Claude Code into the same
  tmux window with the resume seed prompt; this skill detects the
  prompt prefix and walks the decision tree in
  `references/failure-recovery.md` section (b). See **Resume mode**
  below.

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

> **You never run `git branch -m` or `git switch <other-pipeline-branch>`.**
> Branch renames and cross-branch switches
> are the failure mode that opened the door to the 2026-05-01
> worktree-contamination incident: a peer supervisor renamed this
> pipeline's branch and committed its own work into this worktree.
> The supervisor only operates on its own pipeline's branch, captured
> at step 2 from `flow-new-worktree`'s output. If a phase ever needs
> to switch branches, that's a sign of confusion — escalate
> `NEEDS HUMAN: cross-branch-operation-attempted` instead. The
> mechanical guard in `flow-state-update` will also refuse the next
> phase transition (`branch-mismatch`), but don't rely on the guard
> as a license to run the dangerous command in the first place.

> **You anchor every tmux self-query on `$TMUX_PANE`.** When you need
> to read or target your own tmux window — pane id, window name,
> session name, sending keys to yourself, gating logic on "is this
> me?" — pass `-t "$TMUX_PANE"` to every `tmux` invocation.
> Untargeted queries like `tmux display-message -p '#S:#W'` or format
> strings like `#{session_name}` resolve against tmux's *current
> client* — whichever window the user most recently activated — which
> races across parallel pipelines and silently returns another
> supervisor's identity. `$TMUX_PANE` is set by tmux at process spawn
> and is immutable for the life of this process; it is the only safe
> self-anchor. Different failure family from the `git branch -m` rule
> above (it would not have prevented 2026-05-01) but adjacent — both
> are parallel-pipelines self-identification hazards.

# Notifications

When the pipeline reaches a terminal end-state (`MERGED`, `GATED`,
or `NEEDS HUMAN`), call `flow-notify` immediately *before* printing
the end-state line. The helper is opt-in (`FLOW_NOTIFY=1` in the
environment that started the supervisor's tmux session) and a no-op
otherwise — so calling it unconditionally is safe; the user
controls firing via the env var, not the skill prompt.

```bash
flow-notify --status <merged|gated|needs-human> \
            --slug "$SLUG" \
            [--reason "<one-line summary>"] \
            [--url "<pr-url>"]
```

- darwin-only; non-mac hosts and unset `FLOW_NOTIFY` both no-op.
- Backend: `terminal-notifier` preferred (click-through to
  `--url`), `osascript display notification` fallback.
- Detached + fire-and-forget. The helper exits 0 even if the
  notifier fails — it must never break the supervisor's terminal
  print.
- `cancelled` is **not** a notify status. Cancellation is
  user-initiated; they already know.

The exact call sites are listed inline at steps 9, 10, and at every
escalation site documented under `# Failure paths`.

# State: `~/.flow/state/<slug>.json`

One state file per pipeline at `~/.flow/state/<slug>.json`, written
initially by `flow new` with `phase: "starting"` and updated at every
transition by you. `flow ls` reads only this file. The supervisor
never writes the worktree-side `.flow-status` text file (it doesn't
exist anymore).

| Field | Set by | When |
|---|---|---|
| `slug`, `repo` | `flow new` | once at pipeline creation |
| `phase` | you, via `flow-state-update --phase <p>` | at every transition |
| `worktree` | you, via `flow-state-update --worktree <path>` | once after step 2 (`flow-new-worktree` returns) |
| `pr` | you, via `flow-state-update --pr <n>` | once after step 5 (the PR opens) |
| `updatedAt` | `flow-state-update` | refreshed on every call |

## At every phase transition, run

```bash
flow-state-update "$SLUG" --phase "$PHASE"
```

The helper merges fields preserving `repo`, `worktree`, and `pr`,
and refreshes `updatedAt`. It exits non-zero if the slug has no
state file, surfacing drift instead of papering over it.

`$PHASE` must be one of the values listed in the phase table below.
`$SLUG` is the worktree directory's basename (e.g. `csv-export`) —
matches the tmux window name.

## Additional fields to set once

Two fields ship via `flow-state-update` exactly once during a
pipeline:

```bash
# After step 2 (flow-new-worktree returns): record the absolute path
# so consumers like `flow done` can find the worktree.
flow-state-update "$SLUG" --phase worktree-create --worktree "$WORKTREE"

# After step 5 (PR opens): record the PR number so flow ls shows
# the #142 column.
flow-state-update "$SLUG" --phase implementing --pr "$PR"
```

After the PR is set, never overwrite it — subsequent transitions
just pass `--phase`, the helper preserves `pr` from the existing
file.

# The 10-step pipeline

Each step's phase value goes to `state.json` (via `flow-state-update`)
*before* the step's work starts. The step ends when its end-condition
is met; the next step's phase value is written next. There is **no
inter-step state file beyond `state.json`** — the worktree contents,
state.json, and the PR are the state.

## Step 1 — Triage

**Phase:** `triaging`

**First action of the supervisor.** Before classifying, write the
phase to state.json so `flow ls` immediately shows `triaging`
instead of the stale `starting` from `flow new`:

```bash
flow-state-update "$SLUG" --phase triaging
```

Then classify. Apply the heuristics from `flow-add` /
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

First, advertise the phase before doing the work — `flow-new-worktree`
can take a couple of seconds, and the user shouldn't see a stale
`triaging` row in `flow ls` while git is working:

```bash
flow-state-update "$SLUG" --phase worktree-create
```

Then create the worktree:

```bash
flow-new-worktree <slug>
```

Capture the absolute worktree path it prints. Set `$WORKTREE` to
this for the rest of the pipeline. **`cd` into the worktree** —
every subsequent step runs from there.

Now record the worktree path in state.json (the only step where
`--worktree` is set):

```bash
flow-state-update "$SLUG" --phase worktree-create --worktree "$WORKTREE"
```

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

- 30s between polls. **Unconditional on the first iteration** —
  empty results from `gh pr checks` or `gh pr view --json reviews`
  mean "not yet posted," never "skip the wait." Only the presence
  checks below can legitimately short-circuit.
- 20-min hard cap from first poll → max 40 polls.
- Bot review timeout: 10 min after CI goes terminal.

### One-shot presence checks (before the first poll)

Run these once at loop entry. They distinguish "not configured"
(legitimately skip) from "not yet posted" (keep polling). See
`references/polling-protocol.md` § "Presence checks" for the
rationale and the rejected `installations`-API alternative.

```bash
# CI: are there any workflows in this worktree?
if find .github/workflows -maxdepth 1 \( -name '*.yml' -o -name '*.yaml' \) \
     -print -quit 2>/dev/null | grep -q .; then
  CI_CONFIGURED=1
else
  CI_CONFIGURED=0    # no workflows → ci_passed is vacuously true; never poll for checks
fi

# Copilot: was the bot login requested as a reviewer on this PR?
# Both sides of the comparison are lowercased so the match is a true
# case-insensitive exact match — see polling-protocol.md "Bot reviewer
# name" for the case-insensitive contract. Without the local-side
# tolower, swapping COPILOT_LOGIN for a value with mixed case (e.g.
# from ~/.flow/config.json) would silently fail to match.
COPILOT_LOGIN_NORMALIZED=$(printf '%s' "${COPILOT_LOGIN:-copilot-pull-request-reviewer}" | tr '[:upper:]' '[:lower:]')
REQUESTED_REVIEWERS=$(gh pr view "$PR" --json reviewRequests \
  --jq '[.reviewRequests[].login] | map(ascii_downcase) | join(",")')
case ",$REQUESTED_REVIEWERS," in
  *",$COPILOT_LOGIN_NORMALIZED,"*) COPILOT_REQUESTED=1 ;;
  *)                               COPILOT_REQUESTED=0 ;;  # bot not requested → don't wait
esac

echo "CI configured: $CI_CONFIGURED  |  Copilot requested: $COPILOT_REQUESTED"
```

Per-PR `reviewRequests` is the deliberate Copilot-detection mechanism;
`gh api repos/<owner>/<repo>/installations` requires a GitHub App JWT
and 401s for user tokens. `scripts/ci-wait.ts` uses the same per-PR
approach (`prRequestedReviewers`).

### Each poll runs

```bash
# Skip the checks call entirely when CI_CONFIGURED=0.
gh pr checks "$PR" --json name,state          # only if CI_CONFIGURED=1
gh pr view "$PR" --json reviews,state
```

`gh pr checks` does not expose a `conclusion` JSON field — `state`
already encodes the verdict. See `references/polling-protocol.md`
and the matching note in `scripts/ci-wait.ts` for the hard-won
lesson behind this.

### Per-poll counter

Print one line per iteration so the user reading scrollback sees
progress without guessing. Compute the elapsed split with arithmetic
expansion — these are runnable Bash:

```bash
ELAPSED=$(( $(date +%s) - START ))   # seconds since the first poll
MIN=$(( ELAPSED / 60 ))
SEC=$(( ELAPSED % 60 ))
echo "CI poll $POLLS/40, elapsed ${MIN}m${SEC}s of 20m"
```

`POLLS` increments from 1 each iteration; the printed denominator
`40` reflects the 20-min ÷ 30s budget (the actual cap is the 20-min
wall-clock check below, not a poll-count guard).

### Loop body (in the supervisor's own turn)

The block below is **pseudocode**, not runnable Bash — `POLLS += 1`,
the `case decision:` arrow notation, and the `→` rules describe the
control flow the supervisor follows in its own turn. Use the runnable
Bash from "Per-poll counter" above for the per-iteration printout;
use the gh calls from "Each poll runs" for the actual API reads.

```text
initialize POLLS=0, START=$(date +%s), CI_TERMINAL_AT=""

run the one-shot presence checks above

while true:
  POLLS += 1
  ELAPSED = $(date +%s) - START
  print "CI poll $POLLS/40, elapsed $((ELAPSED/60))m$((ELAPSED%60))s of 20m"

  poll:
    if CI_CONFIGURED == 0: treat checks as [] without calling gh
    else:                  gh pr checks "$PR" --json name,state
    gh pr view "$PR" --json reviews,state

  derive per references/polling-protocol.md decision matrix:
    ci_terminal, ci_passed, ci_failed, copilot_posted, pr_state
  apply presence overrides:
    if CI_CONFIGURED == 0:    ci_terminal = true, ci_passed = true, ci_failed = false
    if COPILOT_REQUESTED == 0: copilot_posted = true   # vacuous — never wait the 10m bot timeout

  if ci_terminal and CI_TERMINAL_AT == "": CI_TERMINAL_AT = $(date +%s)

  case decision:
    pr_state == MERGED                                            → break, run flow-remove-worktree, MERGED
    pr_state == CLOSED                                            → escalate pr-closed-mid-flight
    ci_failed                                                     → break, go to step 5 with mode=fix
    ci_passed && copilot_posted                                   → break, go to step 8
    ci_passed && !copilot_posted && ($(date +%s) - CI_TERMINAL_AT) >= 600 → break, go to step 8 (no bot review)
    ELAPSED >= 1200                                               → escalate ci-hang
    else                                                          → sleep 30s, loop
```

When `CI_CONFIGURED=1` and `gh pr checks` returns `[]`, that means
"CI hasn't reported yet" — keep polling. Same for Copilot when
`COPILOT_REQUESTED=1` and no review is in the list.

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

The skill auto-detects Address vs Review mode from the existing PR
state and:

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

The heading contract — which heading to look for, what counts as
empty / non-empty / missing — lives in **`references/auto-merge-rubric.md`**
(single source of truth). Read it once if the section parsing isn't
already cached in your head; otherwise apply it inline.

Fetch the PR body, state, and merge commit; the rubric's four-step
parse turns the body into one of `empty` / `non-empty` / `missing`.
The decision matrix below combines that result with PR state and
this pipeline's `autoMerge` opt-out:

```bash
gh pr view "$PR" --json body,state,mergeCommit
AUTO_MERGE=$(jq -r '.autoMerge // true' ~/.flow/state/"$SLUG".json)
```

`AUTO_MERGE === false` means the user passed `flow new --no-auto-merge`
(or `flow-state-update --no-auto-merge` was issued mid-flight): every
`OPEN` PR routes to **gated** regardless of section content. `MERGED`
and `CLOSED` states still take their normal branches.

| State | Section after trim | autoMerge | Action |
|---|---|---|---|
| `OPEN` | empty | `true` (default) | Go to step 10 (auto-merge). |
| `OPEN` | empty | `false` | Write `phase: gated`. Call `flow-notify --status gated --slug "$SLUG" --url "<pr-url>" --reason "auto-merge opted out"`. Print: `GATED:`, the PR URL, and `merge with: gh pr merge --squash <PR>`. End. |
| `OPEN` | non-empty | (any) | Write `phase: gated`. Call `flow-notify --status gated --slug "$SLUG" --url "<pr-url>" --reason "<first validation step>"`. Print: `GATED:`, the PR URL, the validation steps verbatim, and `merge with: gh pr merge --squash <PR>`. End. |
| `MERGED` | (any) | (any) | Already merged externally. Go to step 10.5 (post-merge sweep) — **do not** run `gh pr merge`. After 10.5 returns, run `flow-remove-worktree <slug>`, write `phase: merged`, call `flow-notify --status merged ...`, print `MERGED`. End. |
| `CLOSED` | (any) | (any) | Call `flow-notify --status needs-human --slug "$SLUG" --url "<pr-url>" --reason "pr-closed-without-merge"`. Escalate `NEEDS HUMAN: pr-closed-without-merge`. End. |

**Defensive cases** (full list in the rubric):

- Manual-validation heading missing → escalate `NEEDS HUMAN:
  manual-validation-section-missing`. Don't treat as empty.
- `gh` non-zero or unparseable JSON → escalate `NEEDS HUMAN:
  gh-error <stderr>`.

## Step 10 — Merge

**Phase:** `merging`

```bash
gh pr merge --squash --delete-branch "$PR"
```

On `gh pr merge` failure: retry once. If still failing, call
`flow-notify --status needs-human --slug "$SLUG" --url "<pr-url>" --reason "merge-failed"`,
then escalate `NEEDS HUMAN: merge-failed`. Leave the worktree intact
(do not proceed to step 10.5).

On success, continue to step 10.5 (post-merge sweep) **before**
removing the worktree — so a sweep failure leaves the worktree intact
for inspection.

## Step 10.5 — Post-merge roadmap sweep

**Phase:** `housekeeping`

Run the helper unconditionally on every successful merge — not gated
by the Manual-validation rubric. The helper edits `docs/roadmap.md`
on `main` via `gh api PUT /contents/...`, flipping the merged PR's
table row + `Status:` line to `✅ shipped (#$PR)`. Idempotent: if
the row is already `✅ shipped (#$PR)` the helper is a no-op.

```bash
flow-state-update "$SLUG" --phase housekeeping
flow-roadmap-mark-shipped --pr "$PR"
```

**Failure handling: best-effort, non-blocking.** The merge already
succeeded; metadata sweep that fails should not gate the pipeline's
terminal state. On non-zero exit:

- Retry once.
- On second failure, print `WARN: roadmap-sweep-failed code=<N>
  (manual flip needed)` — include the helper's exit code so the user
  knows which class of fix applies (see exit-code semantics below).
  Continue to terminal `MERGED` — do **not** escalate `NEEDS HUMAN`.
  The user can re-run the helper by hand (`flow-roadmap-mark-shipped
  --pr <N>`) once the underlying issue (auth, transient 5xx, missing
  self-mark) clears.

Exit-code semantics from the helper:

- `0` — success (changed or no-op).
- `2` — argument / no-row / ambiguity. The PR's diff didn't annotate
  the row, or two rows reference the same PR number. Print the
  `WARN:` line and continue.
- `3` — 409 conflict twice. Same handling as `2`: warn and continue.
- `4` — gh API failure (auth, 5xx). Same handling.

After step 10.5 returns (success or warn), then:

```bash
flow-remove-worktree <slug>
flow-state-update "$SLUG" --phase merged
flow-notify --status merged --slug "$SLUG" --url "<pr-url>"
```

(the PR URL is available from `gh pr view "$PR" --json url -q .url`).
Print `MERGED` on its own line. End.

# Resume mode

The supervisor enters resume mode when the seed prompt begins with
the literal prefix:

```
Use the /flow-pipeline skill in --resume mode for: <slug>
```

`flow new --resume <name>` writes that prompt; nothing else does.
On detecting it, **do not** start at step 1. Instead, walk the
resume-from-disk decision tree below and re-enter at the first step
whose precondition is **not** met. Each step in the 10-step
pipeline has at least one inspectable side-effect on disk or on
GitHub, so the supervisor can always answer "what was already
done?" without any in-process memory.

## First-turn protocol

1. Read `~/.flow/state/<slug>.json`. The wrapper already verified it
   exists, but if you find it missing now, escalate
   `NEEDS HUMAN: state-missing-on-resume` and end — something
   removed it between the wrapper check and your turn.
2. Set `$SLUG` to the value from the prompt (and from state.json —
   they must match).
3. Set `$WORKTREE` to `state.worktree` if present.
4. Set `$PR` to `state.pr` if present.
5. Walk the table top-down; resume at the first row whose "done"
   column is `false`.
6. Print `RESUMING AT: <step name> (<reason>)` on its own line
   before re-entering the step, so the user reading scrollback can
   confirm.
7. From that step onward, behave exactly as the normal pipeline —
   the same phase transitions, the same `flow-state-update` calls,
   the same caps.

## Decision tree

| Step | "Done" check | Notes |
|---|---|---|
| 2 — worktree | `$WORKTREE` is set in state.json **and** the directory exists and is a git checkout | If unset / missing, recreate via `flow-new-worktree`. |
| 3 — plan | `<worktree>/plan.md` exists and is non-empty | If missing, re-invoke `/product-planning`. |
| 4 — approval | state.json shows `phase` ∈ {`implementing`, `verifying`, `ci-wait`, `reviewing`, `gating`, `merging`, `housekeeping`, `merged`, `gated`} | If false, re-print the plan and wait for the user — we never replay an approval the user gave to a now-dead session. |
| 5 — implement | `gh pr view` for the worktree's branch returns a PR (any state) | If no PR, re-invoke `/new-feature`. |
| 6 — verify | state.json shows `phase` ∈ {`ci-wait`, `reviewing`, `gating`, `merging`, `housekeeping`, `merged`, `gated`} | If false, re-invoke `/verify`. |
| 7 — ci-wait | PR's checks all reached terminal state | If still pending, re-enter the poll loop. |
| 8 — review | PR has a `pr-review` commit on HEAD (look for the commit subject prefix `review:` or the trailer `Co-Authored-By: ... pr-review`) | If false, re-invoke `/pr-review <PR>`. |
| 9 — gate | (PR is `MERGED` **and** worktree directory removed) **or** state.json shows `phase: gated` | If false: when PR is `MERGED` but the worktree still exists, re-enter step 9's `MERGED` branch (route to step 10.5, then `flow-remove-worktree`, write `phase: merged`, print `MERGED`, end) — **do not** fall through to step 10 and re-run `gh pr merge` on an already-merged PR. Otherwise re-evaluate the gate. |
| 10 — merge | PR is `MERGED` (state.json may show `merging` if the supervisor crashed between merge and step 10.5) | If false, re-evaluate the gate; if `MERGED`, jump to step 10.5. |
| 10.5 — housekeeping | `gh api /repos/.../contents/docs/roadmap.md?ref=main` returns content where the merged PR's row is `✅ shipped (#$PR)` | If false, re-invoke `flow-roadmap-mark-shipped --pr "$PR"` (idempotent — safe to re-run). On warn, continue. |

The first row whose "done" condition is **false** is your re-entry
step. If every row is `true`, the pipeline is in a terminal state
— print `MERGED` (or `gated`) and end without re-running anything.

## Edge cases (verbatim from `references/failure-recovery.md` section (b))

- **Worktree path recorded but the directory is gone.** Escalate
  `NEEDS HUMAN: worktree-missing-on-resume`. Don't auto-recreate —
  the user may have removed it deliberately.
- **Worktree exists but state.json shows `phase: starting` /
  `triaging` / `worktree-create`.** Treat as resume-from-step-3
  (plan). The worktree was created but the pipeline crashed before
  the planning phase advanced state.
- **`plan.md` exists but no PR.** Resume at step 4 (approval). The
  user may have approved before the crash; re-print the plan and
  wait for the user to re-confirm. Don't replay an approval the
  user gave to a now-dead session.
- **PR exists but state.json is stale (e.g. still shows
  `implementing`).** Resume at step 6 (verify). The PR survived;
  the phase value didn't catch up before the crash.
- **PR `CLOSED` without merge.** Escalate `NEEDS HUMAN:
  pr-closed-without-merge`; do not resume. Let the user decide
  reopen vs. abandon.
- **Terminal phase (`merged` / `gated` / `cancelled`).** Print the
  terminal line and end without re-running anything. The window
  stayed open after a previous run; this resume is a no-op.

## What resume mode does NOT do

- It does not re-run verify or review steps if they previously
  passed. Their successful exit is observable from disk + PR state.
- It does not auto-merge a PR that's already in `gated` state — the
  user gated it intentionally.
- It does not delete a worktree on entry. Worktree cleanup is a
  step-10.5 effect (or step-9 when the PR was merged externally); if
  neither ran, the worktree stays.
- It does not re-run `gh pr merge` on a PR that is already `MERGED`.
  An already-merged PR with the worktree still present resumes into
  step 9's `MERGED` cleanup branch (route into step 10.5 sweep, then
  `flow-remove-worktree` + write `phase: merged` + print `MERGED`),
  not step 10.
- It does not skip step 10.5 on resume just because phase advanced
  past `housekeeping`. The roadmap-sweep helper is idempotent — re-
  running on an already-shipped row is a no-op — so resume always
  invokes it before declaring `MERGED`. This guarantees a partial-
  sweep crash (PUT failed mid-pipeline) gets retried on resume
  without manual intervention.
- It does not rewrite state.json on entry. The first transition you
  make from your re-entry step is what updates phase.

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
fire a notification, print `NEEDS HUMAN: <reason>`, and end:

```bash
flow-state-update "$SLUG" --phase needs-human
flow-notify --status needs-human --slug "$SLUG" --reason "<reason>"
echo "NEEDS HUMAN: <reason>"
```

Do **not** call `flow-remove-worktree` on escalation — leave the
worktree + PR intact so the user can inspect and resume.

## Branch-mismatch escalation (no retries)

When `flow-state-update` exits with status 3, the worktree's branch
no longer matches the `.flow-branch` marker written by
`flow-new-worktree`. This means a peer pipeline (or a stray manual
git command) renamed this branch out from under us — the same family
of failure as the 2026-05-01 incident. The mechanical guard refused
to write the phase transition; the supervisor must NOT retry.
Escalate immediately:

```bash
flow-state-update "$SLUG" --phase needs-human  # may itself fail; that's ok, scrollback shows the cause
flow-notify --status needs-human --slug "$SLUG" --reason "branch-mismatch"
echo "NEEDS HUMAN: branch-mismatch <expected vs actual from stderr>"
```

There is no auto-recovery — branch state is load-bearing and the
user must inspect (`git reflog`, `git worktree list`) to decide
whether the rename was malicious, accidental, or expected. Leave the
worktree + PR intact.

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
housekeeping            (post-merge roadmap sweep; non-blocking)
merged                  (terminal)
```

Off-path terminals: `gated`, `needs-human`, `cancelled`.

# Verification (this skill)

After each phase transition:

- `~/.flow/state/<slug>.json` reflects the new `phase`, the populated
  `worktree` (post-step-2) and `pr` (post-step-5) fields, and a
  fresh `updatedAt`.
- `flow ls` (run from any terminal) shows the right phase **and PR
  number** for this pipeline's window.
- The supervisor never invoked the `Task` / `Agent` tool.
- The supervisor never spawned a `claude -p` subprocess.

When the pipeline ends, scrollback contains exactly one of `MERGED`
/ `GATED: <url>` / `NEEDS HUMAN: <reason>` / `cancelled` on its own
line, and the corresponding `phase:` is in state.json.

When `FLOW_NOTIFY=1` is set in the supervisor's environment, every
terminal end-state (`merged`, `gated`, `needs-human`) is preceded
by a `flow-notify` call. The helper is a no-op when the env var is
unset, so the call is unconditional from the skill's perspective.
