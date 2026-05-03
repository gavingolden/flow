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
> tool from this skill — **except for the named exception below**.
> Never spawn a separate `claude -p` subprocess. The supervisor's
> only fan-out is (a) loading sub-skills in-process, (b) Bash tool
> calls, and (c) the narrowly-named Task-tool exception that follows.
>
> **Task-tool exemption: `/pr-review` Independent Multi-Agent Review.**
> When the supervisor invokes `/pr-review` in step 8, `/pr-review`'s
> "Independent Multi-Agent Review" step spawns four review agents in
> parallel via the Task tool. This is the **only** authorised
> Task-tool fan-out from this supervisor; no other skill or step may
> call Task. The exemption is anchored on the step heading name
> rather than its number so it survives future `/pr-review`
> renumbering. Rationale: the two constraints behind the rule above
> are (1) sub-agents can't spawn sub-agents (one-level cap) and (2) a
> long-running supervisor with sub-agents would bloat past the
> context window. The supervisor is itself a top-level Claude Code
> session (started by `flow new` opening tmux + `claude`), so
> constraint (1) does not apply to *its* Task calls — it applies to
> *its* sub-agents. Constraint (2) requires the fan-out to be
> long-running; the multi-agent review is one-shot (four parallel
> agents return JSON findings, then the parent skill merges and
> exits). Refactoring `/pr-review` to use in-process skill loads
> instead would lose the parallelism and the isolated-context benefit
> each review agent gets; dropping the rule entirely is too broad.
> Same narrow-and-named contract as the `/pr-review` auto-push and
> `/flow-pipeline` auto-merge exemptions in `AGENTS.md`. If a future
> skill needs the same license, add it here by name rather than
> generalising the rule.

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

> **You write every scratch file under `$WORKTREE/.flow-tmp/`.** Every
> transient file the supervisor or a sub-skill produces — PR body
> drafts, commit-message scratch, intermediate logs, mocked-input
> fixtures — lives at `$WORKTREE/.flow-tmp/<name>` rather than `/tmp/`.
> `/tmp` is shared across every parallel pipeline on the host and was
> the source of the Item 7 cross-pipeline body-file overwrite (PR opened
> with stale content from another window's prior session). The
> per-worktree path inherits the worktree's isolation guarantees for
> free. The directory is created lazily by whoever writes first
> (`mkdir -p "$WORKTREE/.flow-tmp"`); cleanup is automatic — `git
> worktree remove` (run by `flow-remove-worktree` after step 10's
> merge) deletes the whole worktree tree, scratch dir included. The path is registered
> in the worktree's per-checkout `.git/info/exclude` by
> `flow-new-worktree`, so it stays untracked without polluting the
> consumer repo's `.gitignore`.

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

> **You never end the turn between sub-skills and the next step.**
> The rule scope is **a change pipeline** — i.e. once step 1 has
> classified the request as `change` and (for ambiguous input) the
> single clarifying question has been answered. Step 1's `no-change`
> outcome answers the user inline and ends the turn before the
> change-pipeline contract activates; that is *not* a violation of
> this rule, it is the pre-pipeline branch. Inside a change pipeline
> the supervisor walks each non-feature run (intent ∈
> `bug` / `refactor` / `docs` / `infra` / `chore`) from triage to a
> terminal end-state in **one uninterrupted run**, and walks each
> feature run in two runs (kickoff → `plan-pending-review`, then
> approval → terminal). Every other step transition stays in the
> same turn. The hazard this rule closes: sub-skill tails and
> long-script tails *look* like natural turn-ends — `/product-planning`
> step 9 ends with "share with user and iterate" and a CTA to invoke
> `/new-feature`; `/verify` and `/pr-review` print summaries that read
> conversationally; `flow-state-update` prints nothing and feels like a
> stopping point. None of these are turn boundaries. The supervisor
> reads them as model-generated text and must keep going. The **only**
> legitimate turn-end points inside a change pipeline are:
>
> 1. **Step 3 → step 4 handoff for feature intent.** When intent is
>    `feature`, step 3 writes `phase: plan-pending-review` and ends
>    the turn. The next turn re-enters at step 4 after the user
>    attaches and responds. Bug / refactor / docs / infra / chore
>    intents skip this entirely — they continue to step 5 in the same
>    turn.
> 2. **The four documented terminal end-states.** `MERGED`,
>    `GATED: <url>`, `NEEDS HUMAN: <reason>`, and `cancelled` —
>    each printed on its own line, after which the turn ends.
> 3. **The single clarifying question allowed in step 1
>    (`triage-ambiguous`) and step 4 (`approval-ambiguous`).** Each
>    step is permitted *one* clarifying question if the user input
>    is genuinely unparseable; the turn ends after the question and
>    re-enters when the user answers. If the answer is still
>    ambiguous, escalate `NEEDS HUMAN: <triage|approval>-ambiguous`
>    instead of asking again.
>
> Every other transition — step 2 → step 3, the non-feature step 3 →
> step 5 path, the step 4 affirmative → step 5 path, step 5 → step
> 5.5, step 5.5 → step 6, step 6 → step 7, step 7 → step 8 (or →
> step 5 mode=fix), step 8 → step 7 (or → step 9), step 9 → step 10
> — happens in the same turn. Three layers of localised reminder
> reinforce this Hard rule: a **leading blockquote** at the top of
> every non-terminal step heading (the first thing you read on step
> entry); the existing **continue-immediately sentences** inline at
> each step's End-condition stanza (the last thing you read on step
> exit); and an inline **`flow-checkpoint`** Bash call after every
> sub-skill return that prints `DO NOT END THE TURN` to stderr (the
> freshest signal in scrollback when the model decides what to do
> next). The leading blockquote is the load-bearing layer because
> sub-skill tail messages — `/product-planning` step 9's "share with
> user and iterate" CTA, `/verify`'s success summary, `/pr-review`'s
> post-push recap — read as natural turn boundaries when only the
> trailing reminder is in view. The blockquote is also lint-enforced:
> `bin/skill-md-lint.test.ts` walks every `## Step ` heading in this
> file and fails CI if any non-terminal step's first content line is
> not a continuation blockquote.

# Continuation reminders (`flow-checkpoint`)

`flow-checkpoint` is a tiny Bun helper whose only job is to print a
two-line `DO NOT END THE TURN` reminder to stderr. Call it as a
Bash tool call after every sub-skill return inside a change pipeline
— most importantly after `/product-planning` (step 3), `/new-feature`
(step 5), `/verify` (step 6), and `/pr-review` (step 8). The helper
exits 0 unconditionally; it is advisory, never a gate.

```bash
flow-checkpoint --from <step-label> --to <step-label> \
                [--note "<one-line context>"]
# stderr:
#   flow-checkpoint: returning from <from> → continuing to <to>
#   note: <text>          # only when --note was passed
#   DO NOT END THE TURN
```

The helper closes the gap that the leading-blockquote layer alone
cannot: when a sub-skill returns, the freshest signal in scrollback
is whatever the sub-skill printed last (e.g. `/product-planning`'s
"share with user and iterate" CTA). The blockquote at the top of
the *next* step is correct but further up; the model's attention
lands on the sub-skill tail. Running `flow-checkpoint` immediately
after the sub-skill returns puts the reminder *below* the tail,
making it the freshest signal.

Skip the call only at the four legitimate turn-end points
documented in the "You never end the turn between sub-skills and
the next step" Hard rule above — at those points, ending the turn
is the desired behaviour, and a `DO NOT END THE TURN` reminder
would be misleading.

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
`$SLUG` is the worktree directory's basename (e.g. `csv-export`) and
matches the tmux window's `@flow-slug` user option — *not* its
display name, which the supervisor renames to a readable title in
step 1 and which the user may further rename via `tmux ,`.

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

> **Pipeline entry — first step of a new change pipeline.** The only
> legitimate turn-end inside this step is the `no-change` branch
> (answer the user's question and stop, before the change-pipeline
> contract activates). Every `change` branch — including after the
> single permitted clarifying question — continues into step 2 in
> the same turn. **DO NOT END THE TURN** otherwise.

**Phase:** `triaging`

**First action of the supervisor.** Before classifying, write the
phase to state.json so `flow ls` immediately shows `triaging`
instead of the stale `starting` from `flow new`:

```bash
flow-state-update "$SLUG" --phase triaging
```

Then set a readable tmux window title so the user can scan their
status bar at a glance instead of squinting at the slug. The slug
stays the canonical lookup key (it's stored in tmux's `@flow-slug`
user option, set when `flow new` created the window) — the rename
only changes the display:

```bash
flow-rename-window "$SLUG" "<short descriptive title>"
```

Pick a 20–30-character title from the user's verbatim description.
Strip imperative verbs and articles (`make`, `add`, `the`, `a`),
keep the topic noun phrase. Examples:

- `"Make tmux window renames safe …"` → `"safe tmux window renames"`
- `"Add CSV export to portfolio page"` → `"CSV export"`
- `"Fix the flow-ci-wait copilot detection bug"` → `"copilot detection fix"`

Fire `flow-rename-window` exactly **once** in this step. If the user
later runs `tmux ,` to rename to something else, do **not** re-rename
in subsequent steps — the user's choice wins.

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
- **Change** → continue to step 2. The **slug** was already finalized
  by `flow new`'s aggressive slugify (`bin/lib/slug.ts`: stop-word
  filter + 5-token cap + `task-<hash8>` fallback) and is the basename
  of `$SLUG`. The supervisor never re-derives or renames the slug;
  it is the canonical pipeline identifier (stored in the window's
  `@flow-slug` tmux option) and changing it would orphan the state
  file, the worktree branch, and `flow attach`/`flow done` lookups.
  The display-title rename above (`flow-rename-window`) is the only
  permitted exception, fires exactly once here in step 1, and never
  touches the slug.

If classification is ambiguous after one clarifying question,
escalate `NEEDS HUMAN: triage-ambiguous` and end.

## Step 2 — Worktree

> **Continue immediately from step 1 — DO NOT END THE TURN.** You
> arrived here via the `change` classification (or after the single
> permitted clarifying question resolved). Create the worktree and
> walk into step 3 in the same turn.

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

> **Continue immediately from step 2 — DO NOT END THE TURN.** This
> step *does* have one legitimate turn-end — the `feature`-intent
> path that writes `phase: plan-pending-review` and waits for the
> user to attach + approve. Every other intent
> (`bug`/`refactor`/`docs`/`infra`/`chore`) continues directly to
> step 5 in the same turn, regardless of how `/product-planning`'s
> tail message reads. The skill ends with a "share with user and
> iterate" CTA designed for manual invocation; that CTA is **not** a
> turn boundary inside `/flow-pipeline`.

**Phase:** `planning`

Invoke `/product-planning` in-process with the user's verbatim
request as the argument:

```
/product-planning <verbatim user description>
```

`/product-planning` produces a PRD + task breakdown + PR-description
draft and writes the consolidated artifact to
`<worktree>/.flow-tmp/plan.md` (the skill creates `.flow-tmp/` on
demand). The path lives under `.flow-tmp/` so the post-merge
`git worktree remove` (run after step 10's merge) doesn't choke on a
stray untracked file at the worktree root — same reason the supervisor
itself writes all scratch under `$WORKTREE/.flow-tmp/`.

After it returns, **read `<worktree>/.flow-tmp/plan.md`** and print a
3-5 line summary to chat (just the problem statement and the task
titles — the user reads scrollback).

**End conditions:**

- Intent is `feature` → write `phase: plan-pending-review` and
  **end the turn**. Wait for the user to attach and respond. The
  next turn re-enters at step 4.
- Non-feature intent (`bug`/`refactor`/`docs`/`infra`/`chore`) →
  skip the checkpoint and continue directly to step 5. The plan
  still exists on disk for traceability, but the user wasn't asked
  to ratify it. **Continue immediately to step 5 in the same turn —
  do not end the turn.** `/product-planning`'s tail message
  ("share with user and iterate" + CTA to invoke `/new-feature`) is
  correct for manual invocation but is *not* a turn boundary inside
  a `/flow-pipeline` run. Fire the continuation reminder before
  invoking `/new-feature`:

  ```bash
  flow-checkpoint --from step-3 --to step-5 \
                  --note "/product-planning returned (non-feature intent)"
  ```

If `/product-planning` doesn't write `.flow-tmp/plan.md`, re-invoke
once with an explicit instruction to write the consolidated artifact.
If the second attempt also fails, escalate `NEEDS HUMAN: plan-missing`.

## Step 4 — Approval handling

> **New turn — user just replied to the plan-pending-review
> checkpoint.** The previous turn legitimately ended at step 3 for
> `feature` intent; you are now re-entering with the user's reply in
> scrollback. Classify the reply (affirmative / redirect / cancel /
> ambiguous) and continue into step 5 (or loop back to step 3) in
> *this* turn. **DO NOT END THE TURN AGAIN** unless the reply is
> ambiguous and the single permitted clarifying question has not yet
> been asked.

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

> **Continue immediately from step 3 (non-feature intent), step 4
> (feature post-approval), step 7 (`ci-failed` re-entry), or step 8
> (review-fix re-entry) — DO NOT END THE TURN.** `/new-feature`'s
> tail message is not a turn boundary; neither is `flow-open-pr`'s
> URL print. After `/new-feature` returns, run `flow-checkpoint
> --from step-5 --to step-5.5` (defined below) to refresh the
> reminder in scrollback before continuing.

**Phase:** `implementing`

Invoke `/new-feature` in-process. On the first entry to this step,
pass the user's request:

```
/new-feature <verbatim user description>
```

The skill writes code + tests, runs verify internally as a
pre-commit gate, commits, and pushes. **Opening the PR is the
supervisor's job, not the implement skill's** — the supervisor calls
`flow-open-pr` so the PR number lands in state.json atomically.

Write the PR body to the worktree's scratch dir, then call
`flow-open-pr` once and capture both the URL (from stdout) and the
PR number (from the state.json the helper just wrote):

```bash
mkdir -p "$WORKTREE/.flow-tmp"
# Compose the PR body (typically copied from .flow-tmp/pr-description-draft.md
# that /new-feature wrote, then templated with the final commit list). Both
# the source draft and the rendered body live under .flow-tmp/ so the
# worktree root stays clean for the post-merge git worktree remove.
PR_URL=$(flow-open-pr "$SLUG" \
  --body-file "$WORKTREE/.flow-tmp/pr-body.md" \
  --title "<conventional-commit summary>")
PR=$(jq -r '.pr' ~/.flow/state/"$SLUG".json)
```

`flow-open-pr` runs `gh pr create`, reads the PR number back via
`gh pr view`, and writes it to `~/.flow/state/<slug>.json` in one
step. It is **idempotent**: if the branch already has a PR (resume
after a crash), the helper falls through to the read-back path
instead of failing on `gh pr create`'s "already exists" error.

Do **not** call `gh pr create` directly and do **not** call
`flow-state-update --pr` separately — both are subsumed by
`flow-open-pr`. Bypassing the helper is the regression Item 15
closed: the previous three-call sequence stranded PRs in `pr: —`
when the supervisor crashed between `gh pr create` and the state
write.

Then transition the phase (preserving the `pr` field the helper
just wrote):

```bash
flow-state-update "$SLUG" --phase implementing
```

Fire the continuation reminder before walking into step 5.5:

```bash
flow-checkpoint --from step-5 --to step-5.5 \
                --note "/new-feature returned; PR #$PR opened"
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

## Step 5.5 — Re-symlink if worktree adds skills/agents

> **Continue immediately from step 5 — DO NOT END THE TURN.**
> `flow setup --upgrade`'s summary output is informational, not a
> stopping point. Whether the helper actually re-symlinks or the
> grep skips it, walk into step 6 in the same turn.

**Phase:** `installing-skills`

Sub-skills loaded by the supervisor in steps 6–8 (`/verify`,
`/pr-review`) are read from `~/.claude/skills/` and `~/.claude/agents/`
— populated by `flow setup` (and `flow setup --upgrade`) via symlink.
A worktree that adds new files under `skills/` or `agents/` in step 5
does not get those files symlinked automatically; the same supervisor
session cannot use them downstream until `flow setup --upgrade` runs.
This step closes that gap.

```bash
flow-state-update "$SLUG" --phase installing-skills

# Resolve the default branch dynamically — same approach as
# flow-new-worktree.ts and flow-pre-commit.ts. Hardcoding origin/main
# silently breaks on any repo whose default is `master` (or anything
# else): `git diff origin/main...HEAD` would fail, `|| true` would
# swallow the error, and the re-symlink would be silently skipped.
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null \
                  | sed 's|^refs/remotes/origin/||')
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"

ADDED=$(git diff --name-only "origin/$DEFAULT_BRANCH...HEAD" | \
          grep -E '^(skills|agents)/' || true)

if [ -n "$ADDED" ]; then
  echo "Detected new skill/agent files; re-symlinking:"
  echo "$ADDED" | sed 's/^/  /'
  flow setup --upgrade --source "$WORKTREE"
else
  echo "No skill/agent additions; skipping re-symlink."
fi
```

The detection grep uses `--name-only` plus the triple-dot range so
the comparison reflects the worktree's diff against the merge-base,
not the absolute set of changed files. The default-branch resolution
mirrors `bin/flow-new-worktree.ts` and `bin/flow-pre-commit.ts`; do
not hardcode `origin/main`.

The `--source "$WORKTREE"` argument forces `flow setup` to read its
content tree from the in-flight worktree rather than the original
install root. Without it, a PR against flow itself that adds a new
skill under `skills/...` would not see the new files in the same
supervisor session — `resolveFlowSource()` derives the source from
the installed binary's canonical path. For PRs against repos *other
than flow*, the override is harmless: flow's source is already the
original install root and the worktree is an unrelated repo's tree,
so passing `--source "$WORKTREE"` would point at a tree that has no
`skills/` or `agents/` directories. The detection guard above keeps
this branch from running in that case.

The override only swaps the **content source** — the worktree path
is the location `flow setup` reads files from. The **recorded owner**
written to `~/.flow/installed.json` stays on the canonical install
root via `resolveFlowSource()`. That split means a worktree's
post-merge removal cannot strand worktree-rooted manifest entries,
and any dangling symlinks left by past `--source <worktree>` runs get
reaped on the next `flow setup --upgrade` (the relaxed orphan-pruning
path).

**Concurrency.** `flow setup` wraps its symlink work in
`~/.flow/setup.lock` (`bin/lib/lock.ts`), so parallel pipelines that
both add skills/agents serialise here rather than racing on
`~/.claude/skills/` and `~/.claude/agents/`. Do not add an ad-hoc
lock at this call site.

**End condition:** the helper exits 0. On non-zero exit (the verb
maps `summary.blocked > 0` to exit 1; parser errors map to 2):
retry once. If the retry also fails, escalate
`NEEDS HUMAN: flow-setup-upgrade-failed <stderr>` — the supervisor
cannot safely continue to step 6 without the new skill/agent files
visible. On success: **continue immediately to step 6 in the same
turn — do not end the turn.** `flow setup --upgrade`'s summary
output is informational, not a stopping point.

## Step 6 — Local verify

> **Continue immediately from step 5.5 — DO NOT END THE TURN.**
> `/verify`'s success summary reads conversationally but is the
> localised end of one phase, not a session boundary. After
> `/verify` returns clean, run `flow-checkpoint --from step-6 --to
> step-7` to refresh the reminder before invoking `flow-ci-wait`.

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

**Retries do not change model or effort.** The Skill tool has no
per-invocation override for either today, so the escalation between
attempts is *prompt-side only* — the prior failure log narrows the
search space, but the underlying model and reasoning effort are the
same on attempt 3 as on attempt 1. If a per-invocation override
mechanism becomes available (Item 7 revisited, or a future harness
primitive), document the syntax here and gate it on attempt count.
Do not silently re-invent the override claim — if the doc still says
"prompt-side only" but the harness has changed, fix the doc.

After three failed outer attempts, escalate `NEEDS HUMAN:
verify-exhausted`. Surface the final failure log on the PR body's
`## Test Steps` section as a `> [!CAUTION]` block (idempotent —
edit-in-place, do not stack):

```bash
mkdir -p "$WORKTREE/.flow-tmp"
gh pr view "$PR" --json body --jq '.body' > "$WORKTREE/.flow-tmp/body.md"
# upsert caution block under ## Test Steps, then
gh pr edit "$PR" --body-file "$WORKTREE/.flow-tmp/body.md"
```

**End condition:** `/verify` exits clean (an outer attempt 1, 2, or
3 succeeds). Fire the continuation reminder before invoking
`flow-ci-wait`:

```bash
flow-checkpoint --from step-6 --to step-7 \
                --note "/verify clean"
```

**Continue immediately to step 7 in the same turn — do not end the
turn.** `/verify`'s success summary is the localised end of one
phase, not a session boundary.

## Step 7 — CI + Copilot wait

> **Continue immediately from step 6 (verify-clean) or step 8
> (review-pushed) — DO NOT END THE TURN.** `flow-ci-wait` blocks
> until CI is terminal and prints a single JSON verdict; the wait
> can stretch to the 20-min wall-clock cap, but the supervisor is
> still in the same turn the whole time. When the helper returns,
> branch on `.decision` and continue in this turn.

**Phase:** `ci-wait`

`flow-ci-wait` consolidates the entire poll loop (one-shot presence
checks → cadence ramp → 20-min wall-clock cap → 10-min Copilot
timeout → CI/Copilot/PR-state decision matrix) into a single Bash
call that returns one JSON verdict on stdout. The contract —
terminal-state taxonomy, cadence ramp, lowercased Copilot login on
both sides, the `not configured` overrides, the Copilot timeout
relative to the first ci-terminal poll — lives in
`references/polling-protocol.md` and is unit-tested at
`bin/flow-ci-wait.test.ts`. Per-iteration progress (`CI poll N,
elapsed XmYYs of 20m, cadence Zs`) is written to stderr so the JSON
on stdout is cleanly capturable.

```bash
RESULT=$(flow-ci-wait "$PR")
DECISION=$(printf '%s' "$RESULT" | jq -r '.decision')
PR_URL=$(printf '%s' "$RESULT" | jq -r '.prUrl // empty')
CI_FAILED_CHECKS=$(printf '%s' "$RESULT" | jq -r '.ciFailedChecks // empty')
```

Branch on `.decision`:

| `.decision` | Action |
|---|---|
| `proceed-to-review` | **Continue immediately to step 8 in the same turn — do not end the turn.** |
| `proceed-to-review-no-bot` | Same as above; the bot review timed out 10 min after CI went terminal. |
| `ci-failed` | **Continue immediately to step 5 mode=fix in the same turn — do not end the turn.** Pass `$CI_FAILED_CHECKS` (extracted above) as the failure log. Subject to the 3-loop ci-fix cap below. |
| `merged-externally` | PR was merged externally mid-flight. Run `flow-remove-worktree <slug>`, write `phase: merged`, call `flow-notify --status merged --slug "$SLUG" --url "$PR_URL"`, print `MERGED`. End. The roadmap row was self-marked in the PR's diff by `/pr-review` step 7.5; no post-merge sweep required. |
| `pr-closed` | Escalate `NEEDS HUMAN: pr-closed-mid-flight`. |
| `ci-hang` | Escalate `NEEDS HUMAN: ci-hang`. |

`--copilot-login <login>` overrides the bot login (default reads
`~/.flow/config.json` `bots.copilot`, falling back to
`copilot-pull-request-reviewer`). The helper applies the
`CI_CONFIGURED=0` and `COPILOT_REQUESTED=0` presence overrides
internally — no workflows in `.github/workflows/` collapses to
vacuously-passing CI; bot not requested as a reviewer collapses to
vacuously-posted (skipping the 10-min timeout).

**Fix-loop cap: 3 total ci-fix loops** across the whole pipeline.
After the third red CI, escalate `NEEDS HUMAN: ci-fix-exhausted`.

**End condition:** the helper exits 0 with one of the decisions
above. On `proceed-to-review` / `proceed-to-review-no-bot`, continue
to step 8 in the same turn. On `ci-failed`, continue to step 5
mode=fix in the same turn. On `merged-externally`, run cleanup and
end. On `pr-closed` / `ci-hang`, escalate and end. The decision
printout is a localised end of one phase, not a session boundary.

## Step 8 — Review

> **Continue immediately from step 7 (`proceed-to-review` /
> `proceed-to-review-no-bot`) — DO NOT END THE TURN.** `/pr-review`'s
> post-push summary is not a turn boundary. After it returns, you
> either loop back to step 5 mode=fix (review-critical), step 7 (CI
> re-check after pushed fix), or walk into step 9 — all in this
> turn. Run `flow-checkpoint --from step-8 --to step-7` (or
> `--to step-9`, depending on the branch) to refresh the reminder
> before continuing.

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
step 5 with mode=fix and the finding details. Fire the continuation
reminder before re-invoking `/new-feature`:

```bash
flow-checkpoint --from step-8 --to step-5 \
                --note "/pr-review surfaced critical findings; mode=fix"
```

**Continue immediately to step 5 in the same turn — do not end the
turn.** After the second loop-back, escalate `NEEDS HUMAN:
review-fix-exhausted`.

After `/pr-review` commits + pushes, **return to step 7** (CI
wait), not directly to step 9. The fix commit may have changed CI.
Fire the continuation reminder before re-invoking `flow-ci-wait`:

```bash
flow-checkpoint --from step-8 --to step-7 \
                --note "/pr-review pushed review-fix; re-checking CI"
```

**Continue immediately to step 7 in the same turn — do not end the
turn.** `/pr-review`'s post-push summary reads conversationally but
is not a turn boundary.

**End condition:** `/pr-review` returns clean (no critical
findings outstanding) AND the most recent CI cycle is green. Fire
the continuation reminder before invoking `flow-gate-decide`:

```bash
flow-checkpoint --from step-8 --to step-9 \
                --note "/pr-review clean; CI green"
```

On this clean state: **continue immediately to step 9 in the same
turn — do not end the turn.**

On non-zero exit from `/pr-review`: retry once. If the retry also
fails, escalate `NEEDS HUMAN: review-failed`.

## Step 9 — Auto-merge gate

> **Continue immediately from step 8 — DO NOT END THE TURN.**
> `/pr-review` returned clean and the most recent CI cycle is green.
> Run `flow-gate-decide`, branch on `.decision`, and either continue
> into step 10 (`auto-merge`) or land on a terminal end-state in
> this turn.

**Phase:** `gating`

`flow-gate-decide` consolidates the four-step rubric parse
(heading-presence grep → section extract → HTML-comment strip →
unchecked-`- [ ]`-count) and the four-state matrix (PR state ×
autoMerge opt-out × section verdict) into one call. The heading
contract — which heading to look for, what counts as
no-unchecked-items / has-unchecked-items / missing — lives in
**`references/auto-merge-rubric.md`** (single source of truth) and
is unit-tested at `bin/flow-gate-decide.test.ts`. The
heading-presence check is load-bearing: silently treating a missing
heading as "no unchecked items" would ship a PR the user expected
to be gated, so the helper escalates that case explicitly rather
than collapsing it to auto-merge.

```bash
RESULT=$(flow-gate-decide "$PR" --slug "$SLUG")
DECISION=$(printf '%s' "$RESULT" | jq -r '.decision')
PR_URL=$(printf '%s' "$RESULT" | jq -r '.prUrl // empty')
REASON=$(printf '%s' "$RESULT" | jq -r '.reason // empty')
VALIDATION_ITEMS=$(printf '%s' "$RESULT" | jq -r '.validationItems[]? // empty')
```

The helper reads `autoMerge` from `~/.flow/state/<slug>.json`
itself (defaulting to `true` when absent). `autoMerge: false` —
the user passed `flow new --no-auto-merge`, or
`flow-state-update --no-auto-merge` was issued mid-flight — routes
every `OPEN` PR to `gated` regardless of section content. `MERGED`
and `CLOSED` states still take their normal branches.

Branch on `.decision`:

| `.decision` | Action |
|---|---|
| `auto-merge` | Continue to step 10 (auto-merge). |
| `gated` | Write `phase: gated`. Call `flow-notify --status gated --slug "$SLUG" --url "$PR_URL" --reason "$REASON"` (the helper sets `.reason` to the first `.validationItems` entry, or `auto-merge opted out (--no-auto-merge)` when `autoMerge: false` with zero unchecked items). Print: `GATED:`, the PR URL, `$VALIDATION_ITEMS` (one per line, already newline-separated by the jq above), and `merge with: gh pr merge --squash <PR>`. End. |
| `merged-externally` | Already merged externally. **Do not** run `gh pr merge`. Run `flow-remove-worktree <slug>`, write `phase: merged`, call `flow-notify --status merged --slug "$SLUG" --url "$PR_URL"`, print `MERGED`. End. (The roadmap row was self-marked in the PR's diff by `/pr-review` step 7.5; no post-merge sweep is needed.) |
| `closed-no-merge` | Call `flow-notify --status needs-human --slug "$SLUG" --url "$PR_URL" --reason "pr-closed-without-merge"`. Escalate `NEEDS HUMAN: pr-closed-without-merge`. End. |
| `escalate-heading-missing` | Escalate `NEEDS HUMAN: test-steps-section-missing`. |
| `escalate-gh-error` | Escalate `NEEDS HUMAN: gh-error <.reason>`. |

## Step 10 — Merge

> **Continue immediately from step 9 (`auto-merge`) — DO NOT END
> THE TURN until *after* the terminal `MERGED` line.** Run
> `gh pr merge`, clean up the worktree, fire the notification,
> print `MERGED` on its own line, *then* end the turn — the
> terminal end-state line is itself the legitimate stopping point.

**Phase:** `merging`

```bash
gh pr merge --squash --delete-branch "$PR"
```

On `gh pr merge` failure: retry once. If still failing, call
`flow-notify --status needs-human --slug "$SLUG" --url "<pr-url>" --reason "merge-failed"`,
then escalate `NEEDS HUMAN: merge-failed`. Leave the worktree intact.

On success, the roadmap row for this PR was already flipped to
`✅ shipped (#$PR)` in the PR's own diff by `/pr-review` step 7.5
(self-mark + sweep), so no post-merge metadata sweep is required.
Clean up the worktree and finalize:

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
On detecting it, **do not** start at step 1. Call `flow-resume-decide`
to walk the resume-from-disk decision tree:

```bash
RESULT=$(flow-resume-decide "$SLUG")
RESUME_AT=$(printf '%s' "$RESULT" | jq -r '.resumeAt')
REASON=$(printf '%s' "$RESULT" | jq -r '.reason')
WORKTREE=$(printf '%s' "$RESULT" | jq -r '.context.worktree // empty')
PR=$(printf '%s' "$RESULT" | jq -r '.context.pr // empty')
```

The helper reads `~/.flow/state/<slug>.json`, probes the worktree +
plan + PR + CI + HEAD commit, and returns one of the values below.
Each step in the 10-step pipeline has at least one inspectable
side-effect on disk or on GitHub, so the helper can always answer
"what was already done?" without any in-process memory; the contract
is unit-tested at `bin/flow-resume-decide.test.ts`. The full per-row
precondition table lives in `references/failure-recovery.md`
section (b).

Print `RESUMING AT: <resumeAt> (<reason>)` on its own line before
re-entering the step, so the user reading scrollback can confirm.
From that step onward, behave exactly as the normal pipeline — the
same phase transitions, the same `flow-state-update` calls, the same
caps.

Branch on `.resumeAt`:

| `.resumeAt` | Action |
|---|---|
| `step-2` | Re-enter step 2 (worktree). Recreate via `flow-new-worktree`. |
| `step-3` | Re-enter step 3 (plan). Re-invoke `/product-planning`. |
| `step-4` | Re-enter step 4 (approval). Re-print the plan and wait — never replay an approval the user gave to a now-dead session. |
| `step-5` | Re-enter step 5 (implement). Re-invoke `/new-feature`. |
| `step-5.5` | Re-enter step 5.5 (re-symlink). Re-run `flow setup --upgrade --source "$WORKTREE"` per step 5.5's end-condition (idempotent). |
| `step-6` | Re-enter step 6 (verify). Re-invoke `/verify`. |
| `step-7` | Re-enter step 7 (ci-wait). Re-enter the poll loop via `flow-ci-wait`. |
| `step-8` | Re-enter step 8 (review). Re-invoke `/pr-review <PR>`. |
| `step-9` | Re-enter step 9 (gate). Two sub-cases distinguished by `.reason`: `pr-merged-worktree-still-exists` (run step 9's MERGED-cleanup branch — `flow-remove-worktree`, write `phase: merged`, print `MERGED`, end; **do not** fall through to step 10's `gh pr merge` on an already-merged PR) vs. `at-auto-merge-gate` (re-evaluate the gate via `flow-gate-decide`). |
| `terminal` | Already in a terminal state. Print the corresponding line (`MERGED` / `gated` / `cancelled`) and end without re-running anything. |
| `escalate` | Escalate `NEEDS HUMAN: <.reason>` (e.g. `worktree-missing-on-resume`, `pr-closed-without-merge`). Leave the worktree + PR intact. |
| `abort` | The state file is missing. Escalate `NEEDS HUMAN: state-missing-on-resume` and end. |

## Edge cases (verbatim from `references/failure-recovery.md` section (b))

- **Worktree path recorded but the directory is gone.** Escalate
  `NEEDS HUMAN: worktree-missing-on-resume`. Don't auto-recreate —
  the user may have removed it deliberately.
- **Worktree exists but state.json shows `phase: starting` /
  `triaging` / `worktree-create`.** Treat as resume-from-step-3
  (plan). The worktree was created but the pipeline crashed before
  the planning phase advanced state.
- **`.flow-tmp/plan.md` exists but no PR.** Resume at step 4 (approval).
  The user may have approved before the crash; re-print the plan and
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
- It does not delete a worktree on entry. Worktree cleanup happens
  after step 10's merge (or in step 9's MERGED branch when the PR
  was merged externally); if neither ran, the worktree stays.
- It does not re-run `gh pr merge` on a PR that is already `MERGED`.
  An already-merged PR with the worktree still present resumes into
  step 9's `MERGED` cleanup branch (run `flow-remove-worktree`, write
  `phase: merged`, print `MERGED`), not step 10. The roadmap row was
  flipped to `✅ shipped (#$PR)` in the PR's own diff by `/pr-review`
  step 7.5, so no post-merge sweep is needed.
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
installing-skills       (only if worktree adds skills/agents; otherwise skipped)
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

- `~/.flow/state/<slug>.json` reflects the new `phase`, the populated
  `worktree` (post-step-2) and `pr` (post-step-5) fields, and a
  fresh `updatedAt`.
- `flow ls` (run from any terminal) shows the right phase **and PR
  number** for this pipeline's window.
- The supervisor never invoked the `Task` / `Agent` tool, **except**
  via the named `/pr-review` "Independent Multi-Agent Review"
  exception in "Hard rules" above — no other skill or step may call
  Task.
- The supervisor never spawned a `claude -p` subprocess.

When the pipeline ends, scrollback contains exactly one of `MERGED`
/ `GATED: <url>` / `NEEDS HUMAN: <reason>` / `cancelled` on its own
line, and the corresponding `phase:` is in state.json.

When `FLOW_NOTIFY=1` is set in the supervisor's environment, every
terminal end-state (`merged`, `gated`, `needs-human`) is preceded
by a `flow-notify` call. The helper is a no-op when the env var is
unset, so the call is unconditional from the skill's perspective.
