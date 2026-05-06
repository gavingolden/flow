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
> tool from this skill — **except for the named exceptions below**.
> Never spawn a separate `claude -p` subprocess. The supervisor's
> only fan-out is (a) loading sub-skills in-process, (b) Bash tool
> calls, and (c) the four narrowly-named Task-tool exceptions that
> follow.
>
> The two constraints behind the rule above are (1) sub-agents can't
> spawn sub-agents (one-level cap) and (2) a long-running supervisor
> with sub-agents would bloat past the context window. The supervisor
> is itself a top-level Claude Code session (started by `flow new`
> opening tmux + `claude`), so constraint (1) does not apply to *its*
> Task calls — it applies to *its* sub-agents. All four exemptions
> below are also one-shot, not long-running, so constraint (2) doesn't
> apply either. They are the **only four** authorised Task-tool
> fan-out sites from this supervisor; no other skill or step may call
> Task. Each is anchored on its step heading name rather than its
> number so it survives future renumbering. Same narrow-and-named
> contract as the `/pr-review` auto-push and `/flow-pipeline`
> auto-merge exemptions in `AGENTS.md`. If a future skill needs the
> same license, add it here by name rather than generalising the rule.
>
> **Task-tool exemption #1: `/pr-review` Independent Multi-Agent
> Review.** When the supervisor invokes `/pr-review` in step 8,
> `/pr-review`'s "Independent Multi-Agent Review" step spawns four
> review agents in parallel via the Task tool. The multi-agent review
> is one-shot (four parallel agents return JSON findings, then the
> parent skill merges and exits). Refactoring `/pr-review` to use
> in-process skill loads instead would lose the parallelism and the
> isolated-context benefit each review agent gets; dropping the rule
> entirely is too broad.
>
> **Task-tool exemption #2: `/product-planning` Independent Discovery
> Subagent.** When the supervisor invokes `/product-planning` in step
> 3, the wrapper spawns one discovery agent via the Task tool. The
> rationale is context cost: discovery reads the README, scans the
> skill directory, examines domain models, drafts a PRD — none of
> which the supervisor refers to in steps 5–10, but all of which would
> otherwise sit in the supervisor's transcript for the rest of the
> run. Since the only handoff from `/product-planning` to downstream
> steps is `.flow-tmp/plan.md` already, isolating the discovery in a
> subagent costs nothing the supervisor was using. Like the
> multi-agent review, the discovery is one-shot — the subagent writes
> two artifacts on disk (`.flow-tmp/plan.md`,
> `.flow-tmp/pr-description-draft.md`) and returns a brief summary,
> then exits.
>
> **Task-tool exemption #3: `/new-feature` Independent Scout
> Subagent.** When the supervisor invokes `/new-feature` in step 5,
> the wrapper spawns one scout agent via the Task tool — but only on
> the wider-scope path of its hybrid threshold (≤3 affected files
> skips the scout entirely). The rationale is identical to exemption
> #2 and PR #95's precedent: codebase scouting reads source files,
> scans adjacent modules, identifies test coverage, enumerates the
> public API surface, and flags anti-patterns / off-limits surfaces
> — none of which the supervisor refers to in steps 6–10, but all of
> which would otherwise sit in the supervisor's transcript for the
> rest of the run. The handoff is `.flow-tmp/scout.md`; the
> supervisor reads it exactly once during Critical Analysis and never
> re-reads. Like the discovery and the multi-agent review, the scout
> is one-shot — the subagent writes the artifact on disk and returns
> a brief both-sides summary (positive findings AND negative findings
> — what NOT to do alongside what to do), then exits.
>
> **Task-tool exemption #4: `/pr-review` Fix-Applier Subagent.** When
> the supervisor invokes `/pr-review` in step 8, `/pr-review`'s
> "Independent Fix-Applier Subagent" step spawns one fix-applier agent
> via the Task tool to handle the per-finding address loop (Steps 6,
> 7, 7.5, plus the pre-commit / commit / push that step 8 used to
> own). The subagent re-runs `/verify` against the post-fix worktree
> *before returning*, so CI breakage caused by a fix surfaces
> in-context where the fix rationale is still live, rather than
> showing up after the subagent exits when the supervisor re-enters
> step 7 of the pipeline with no intent context. The same two
> rationales apply — top-level Task call (constraint 1 doesn't apply),
> one-shot fan-out (constraint 2 doesn't apply) — plus the additional
> context-cost win that the per-finding fix prose, `flow-pre-commit`
> output, and `/verify` transcript all stay inside the subagent. The
> only handoff to downstream steps is the structured artifact at
> `<worktree>/.flow-tmp/fix-applier-result.json` (typed fields:
> `commits`, `deferred`, `rejected_alternatives`, `anti_patterns_found`,
> `summary`), which `/pr-review`'s Steps 9 / 10 / 11 / 12 read once
> and reuse. The contract is documented bidirectionally in
> `skills/pipeline/pr-review/SKILL.md`'s "Fix-Applier Subagent" section
> and `AGENTS.md` `## Don'ts`.

> **You never bypass the helper scripts.** Always call
> `flow-new-worktree`, `flow-remove-worktree`,
> `flow-fetch-pr-review`, `flow-reply-pr-comments`, and
> `flow-followups` rather than reimplementing their behaviour with
> raw `git` / `gh` calls. The helpers handle edge cases (existing
> worktrees, branch collisions, review-comment ID mapping,
> allowlist enforcement on auto-run) that are easy to get wrong.

> **You only call `AskUserQuestion` from the named site.** The
> supervisor's only authorised `AskUserQuestion` call is in step 4's
> "Candidate follow-up issues sub-step" (the multi-select form for
> picking which orthogonal candidates to file post-merge). Same
> narrow-and-named contract as the Task-tool exemptions above:
> `AskUserQuestion` is a different primitive (synchronous user prompt,
> not a sub-agent fan-out), but a single named site keeps the
> supervisor's user-prompt surface auditable. No other skill or step
> may call `AskUserQuestion`. If a future skill needs the same license,
> add it here by name rather than generalising the rule.

> **You only auto-create GitHub issues from the named sites.**
> `flow-create-issue` may fire only from (a) `/pr-review`'s Step 6
> deferral path (when a finding clears the deferral bar) and (b)
> `/flow-pipeline`'s Step 10 post-merge sweep (one issue per `- [x]`
> item in plan.md's `# Candidate follow-up issues` section). Adding a
> new fire site requires a named exemption added to `AGENTS.md`
> "Don'ts" first — same narrow-and-named contract as the auto-merge
> and Task-tool exemptions. The constraint exists because indiscriminate
> issue auto-creation pollutes user backlogs with low-confidence noise
> and races on `gh` rate limits.

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
> Inside a change pipeline (after step 1's `change` classification,
> ambiguity resolved), the supervisor walks each non-feature run
> from triage to a terminal end-state in one uninterrupted run, and
> walks each feature run in two runs (kickoff →
> `plan-pending-review`, then approval → terminal). The only
> legitimate turn-end points inside a change pipeline are: (1) the
> step 3 → step 4 handoff for feature intent, where state writes
> `phase: plan-pending-review`; (2) the four documented terminal
> end-states (`MERGED`, `GATED: <url>`, `NEEDS HUMAN: <reason>`,
> `cancelled`); (3) the single clarifying question allowed in step
> 1 (state writes `phase: triage-pending-clarification`) and step 4
> (state writes `phase: approval-pending-clarification`); (4) the
> no-change branch of step 1 (state writes `phase:
> triaged-no-change`). Every other step transition stays in the
> same turn. Harness-level enforcement: `flow-stop-guard`
> (registered as a Claude Code Stop hook by `flow setup`) reads
> `~/.flow/state/<slug>.json` and blocks any turn-end whose phase
> is not in this set. See "Harness-level enforcement (Stop hook)"
> below for the contract.

# Harness-level enforcement (Stop hook)

`flow-stop-guard` is a Claude Code Stop hook installed by
`flow setup` into `~/.claude/settings.json`. It is the structural
defence behind the "never end the turn between sub-skills" Hard
rule above — text-only reminders in this SKILL.md cannot intercept
a model that has already chosen to stop, but a Stop hook fires
*at* the model's turn-end signal.

Contract:

- Reads `~/.flow/state/<slug>.json` (slug from the tmux window's
  `@flow-slug` user option).
- Exits 2 with a stderr `DO NOT END THE TURN` reminder when phase
  is non-terminal-non-pending — the supervisor is mid-pipeline and
  must continue.
- Exits 0 (allows the stop) when phase is in the legitimate-end
  set: any of the four terminals (`merged`, `gated`, `needs-human`,
  `cancelled`) or the four pending-end phases
  (`plan-pending-review`, `triaged-no-change`,
  `triage-pending-clarification`, `approval-pending-clarification`).
- Self-detects: exits 0 (no-op) outside tmux, in non-flow tmux
  windows (no `@flow-slug` set), or when state.json is missing.
  Safe to install in a global Stop hook list.
- Loop-break: respects Claude Code's `stop_hook_active` payload
  flag. After one block this turn, subsequent stops exit 0
  unconditionally so a model that genuinely needs to stop can.

Opt out: `flow setup --no-hooks` skips the merge entirely and
leaves `~/.claude/settings.json` untouched. The supervisor's
contract still holds — the hook is the mechanical guardrail, not
the contract itself.

# Notifications

When the pipeline reaches a terminal end-state (`MERGED`, `GATED`,
or `NEEDS HUMAN`), call `flow-notify` immediately *before* printing
the end-state line. The helper is opt-in (`FLOW_NOTIFY=1` in the
environment that started the supervisor's tmux session) and a no-op
otherwise — so calling it unconditionally is safe; the user
controls firing via the env var, not the skill prompt.

```bash
flow-notify --status <merged|gated|needs-human> \
            [--reason "<one-line summary>"] \
            [--url "<pr-url>"]
```

`--slug` is omitted in the call above because every flow helper that takes
a slug (`flow-notify`, `flow-state-update`, `flow-rename-window`,
`flow-open-pr`, `flow-resume-decide`, `flow-gate-decide`,
`flow-remove-worktree`) auto-resolves it from `$TMUX_PANE`'s `@flow-slug`
window option. The supervisor's per-Bash-call shell loses any `SLUG=…` it
sets between calls, but the tmux option set by `flow new`'s `createWindow`
is durable for the life of the window. Pass `--slug <slug>` (or the
positional, depending on the helper) only when invoking from outside the
pipeline window — every example below relies on the auto-resolve path.

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
flow-state-update --phase "$PHASE"
```

The helper merges fields preserving `repo`, `worktree`, and `pr`,
and refreshes `updatedAt`. It exits non-zero if the slug has no
state file, surfacing drift instead of papering over it.

`$PHASE` must be one of the values listed in the phase table below.
The slug is auto-resolved from `$TMUX_PANE`'s `@flow-slug` window
option — the canonical pipeline identifier, set by `flow new` when
creating the window and matching the worktree directory's basename
(e.g. `csv-export`). It is *not* the display name, which the
supervisor renames to a readable title in step 1 and which the user
may further rename via `tmux ,`.

## Additional fields to set once

Two fields ship via `flow-state-update` exactly once during a
pipeline:

```bash
# After step 2 (flow-new-worktree returns): record the absolute path
# so consumers like `flow done` can find the worktree.
flow-state-update --phase worktree-create --worktree "$WORKTREE"

# After step 5 (PR opens): record the PR number so flow ls shows
# the #142 column.
flow-state-update --phase implementing --pr "$PR"
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
flow-state-update --phase triaging
```

Then set a readable tmux window title so the user can scan their
status bar at a glance instead of squinting at the slug. The slug
stays the canonical lookup key (it's stored in tmux's `@flow-slug`
user option, set when `flow new` created the window) — the rename
only changes the display:

```bash
flow-rename-window "<short descriptive title>"
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

- **No-change** → answer the user's question in chat directly,
  then write `flow-state-update --phase triaged-no-change`
  before ending the turn. The phase write is what `flow-stop-guard`
  reads to recognise the legitimate stop. Do NOT proceed to step 2.
- **Change** → continue to step 2. The **slug** was already finalized
  by `flow new`'s aggressive slugify (`bin/lib/slug.ts`: stop-word
  filter + 5-token cap + `task-<hash8>` fallback) and is the basename
  of the worktree directory. The supervisor never re-derives or
  renames the slug; it is the canonical pipeline identifier (stored
  in the window's `@flow-slug` tmux option) and changing it would
  orphan the state file, the worktree branch, and `flow attach`/
  `flow done` lookups. The display-title rename above
  (`flow-rename-window`) is the only permitted exception, fires
  exactly once here in step 1, and never touches the slug.
- **Ambiguous** (input is genuinely unparseable) → write
  `flow-state-update --phase triage-pending-clarification`,
  then ask the single clarifying question and end the turn. The
  next turn re-enters step 1 with the user's reply. If the answer
  is still ambiguous, escalate `NEEDS HUMAN: triage-ambiguous`
  (which writes `phase: needs-human`) instead of asking again.

## Step 2 — Worktree

**Phase:** `worktree-create`

First, advertise the phase before doing the work — `flow-new-worktree`
can take a couple of seconds, and the user shouldn't see a stale
`triaging` row in `flow ls` while git is working:

```bash
flow-state-update --phase worktree-create
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
flow-state-update --phase worktree-create --worktree "$WORKTREE"
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

`/product-planning` is itself a thin wrapper that spawns one
**Independent Discovery Subagent** via the Task tool (the second of
the four named Task-tool exemptions in "Hard rules" above). The
subagent does all the discovery in its own isolated context — reading
the README, scanning the skill directory, examining domain models,
drafting the PRD — and writes the consolidated artifact to
`<worktree>/.flow-tmp/plan.md` plus a PR-description draft to
`<worktree>/.flow-tmp/pr-description-draft.md`. The wrapper creates
`.flow-tmp/` before spawning so the subagent can write directly. The
supervisor never sees the discovery transcript, only the wrapper's
brief return summary. The path lives under `.flow-tmp/` so the
post-merge `git worktree remove` (run after step 10's merge) doesn't
choke on a stray untracked file at the worktree root — same reason
the supervisor itself writes all scratch under `$WORKTREE/.flow-tmp/`.

After the wrapper returns, **read `<worktree>/.flow-tmp/plan.md`**
and print a 3-5 line summary to chat (just the problem statement and
the task titles — the user reads scrollback). This is the supervisor's
single read of the plan file; the wrapper does not pre-read it (that
would duplicate this read in the same supervisor context and erode the
context-cost win the subagent fan-out is designed to deliver).

**End conditions:**

- Intent is `feature` → write `phase: plan-pending-review`. Then,
  immediately before ending the turn, emit two markdown bullets on
  their own lines as the **last** lines of the message — the
  worktree absolute path first, the plan file's absolute path
  (`$WORKTREE/.flow-tmp/plan.md`) second. **No trailing punctuation
  on either bullet line, and no prose after them** — most terminals
  greedily extend URL auto-detection through trailing dots (and
  other adjacent punctuation) and break the click target. Rendered
  example:

  ```
  - /Users/you/code/me/flow-my-feature
  - /Users/you/code/me/flow-my-feature/.flow-tmp/plan.md
  ```

  Then end the turn. Wait for the user to attach and respond.
  The next turn re-enters at step 4.
- Non-feature intent (`bug`/`refactor`/`docs`/`infra`/`chore`) →
  continue directly to step 5. The plan still exists on disk for
  traceability, but the user wasn't asked to ratify it.

If `/product-planning` doesn't write `.flow-tmp/plan.md`, re-invoke
once with an explicit instruction to write the consolidated artifact.
If the second attempt also fails, escalate `NEEDS HUMAN: plan-missing`.

## Step 4 — Approval handling

**Phase:** `plan-pending-review` (set by step 3 for feature intent)

This step runs only when the next turn arrives — i.e. when the user
typed something into the tmux chat. Classify the input using
`references/redirect-handling.md`:

- **Affirmative** ("approved", "looks good", "go ahead", etc.) →
  run the candidate-issues sub-step below, then continue to step 5.
- **Imperative redirect** ("actually, also handle TSV"; "redo with
  X") → loop back to step 3, appending the redirect to the
  `/product-planning` prompt as `USER REDIRECT (received during
  plan-pending-review): <verbatim>`.
- **Cancel** ("cancel", "abort") → run `flow-remove-worktree
  <slug>`, write `phase: cancelled`, print `cancelled`, end.
- **Ambiguous** → write `flow-state-update --phase
  approval-pending-clarification`, then ask the single clarifying
  question and end the turn. The next turn re-enters step 4 with
  the user's reply. If the answer is still unclear, escalate
  `NEEDS HUMAN: approval-ambiguous` (which writes `phase:
  needs-human`).

### Candidate follow-up issues sub-step

Runs only on the **Affirmative** branch above, before stepping to
step 5. Reads `$WORKTREE/.flow-tmp/plan.md`, locates the optional
`# Candidate follow-up issues` section, and applies this matrix:

| Section state | Action |
|---|---|
| Section absent | No-op. Continue to step 5. |
| Section present, every item is `- [ ]`, **count is 1–4** | Fire one `AskUserQuestion` (multi-select) listing each candidate. Persist the user's selections back to plan.md by flipping `- [ ]` → `- [x]` for every chosen item using the `Edit` tool with explicit `old_string`/`new_string` matches. Continue to step 5. |
| Section present, **any item already `- [x]`** | The user pre-ticked during plan review (their explicit choice wins). Skip the form. Continue to step 5. |
| Section present, count is `0` | No-op. Continue to step 5. |
| Section present, **count is 5+** unticked | The form's option cap can't fit the candidates. Print a one-liner naming the absolute plan.md path so the user can scroll-tap-edit (`<worktree>/.flow-tmp/plan.md`), write `flow-state-update --phase approval-pending-clarification`, end the turn. The next turn re-enters step 4. |

**Quick presence probe.** Before reading the whole file, run a fast
grep so the early-exit cases don't pull plan.md into context twice
in the same supervisor session:

```bash
if ! grep -q '^# Candidate follow-up issues' "$WORKTREE/.flow-tmp/plan.md" 2>/dev/null; then
  : # section absent — fall through to step 5
fi
```

`AskUserQuestion` is the **only** Claude Code user-prompt primitive
the supervisor calls — see "Hard rules" above for the
narrow-and-named exemption that authorises this single site. Other
skills and steps may not invoke it.

## Step 5 — Implement

**Phase:** `implementing`

Invoke `/new-feature` in-process. On the first entry to this step,
pass the user's request:

```
/new-feature <verbatim user description>
```

`/new-feature` is itself a thin wrapper that spawns one **Independent
Scout Subagent** via the Task tool (the third of the four named
Task-tool exemptions in "Hard rules" above) on its wider-scope path.
The subagent reads the codebase in its isolated context — affected
modules, relevant tests, public API surface, anti-patterns / off-limits
surfaces — and writes the consolidated artifact to
`<worktree>/.flow-tmp/scout.md`. The wrapper creates `.flow-tmp/`
before spawning so the subagent can write directly. The supervisor
never sees the scouting transcript, only the wrapper's brief return
summary. Trivially scoped features (≤3 affected files) skip the
subagent via the wrapper's hybrid threshold and proceed inline.

If `/new-feature` took the wider-scope path and `.flow-tmp/scout.md`
is missing after the call returns, re-invoke `/new-feature` once with
an explicit instruction to spawn the scout and write the artifact
(this counts as a fresh `/new-feature` invocation with its own
one-shot Task call, per the wrapper's "exactly one Task-tool call per
invocation" constraint). If the second attempt also fails, escalate
`NEEDS HUMAN: scout-missing`. Same retry-once-then-escalate semantics
as step 3's `plan-missing` handling for `/product-planning`.

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
PR_URL=$(flow-open-pr \
  --body-file "$WORKTREE/.flow-tmp/pr-body.md" \
  --title "<conventional-commit summary>")
# Read the PR number back. `~/.flow/state/<slug>.json` is keyed by slug,
# so resolve the slug from the pane inline — single Bash call, single shell.
SLUG=$(tmux show-options -t "$TMUX_PANE" -v -w @flow-slug)
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
flow-state-update --phase implementing
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

**Phase:** `installing-skills`

Sub-skills loaded by the supervisor in steps 6–8 (`/verify`,
`/pr-review`) are read from `~/.claude/skills/` and `~/.claude/agents/`
— populated by `flow setup` (and `flow setup --upgrade`) via symlink.
A worktree that adds new files under `skills/` or `agents/` in step 5
does not get those files symlinked automatically; the same supervisor
session cannot use them downstream until `flow setup --upgrade` runs.
This step closes that gap.

```bash
flow-state-update --phase installing-skills

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
  # Register a post-merge follow-up so the user's home install also gets
  # re-symlinked against the canonical (post-merge) main, not just this
  # supervisor's in-flight worktree. `--auto` plus the `flow setup --upgrade`
  # allowlist entry means step 11 runs it automatically on the MERGED path.
  flow-followups add \
    --command "flow setup --upgrade" \
    --reason "new skills/agents added on this branch — re-symlink home install post-merge" \
    --auto \
    --registered-by "flow-pipeline:step-5.5"
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
visible.

## Step 6 — Local verify

**Phase:** `verifying`

Invoke `/verify` in-process inside the worktree.

**Outer cap: 3 attempts.** `/verify` self-loops internally; the
outer cap fires only when `/verify` exits without a clean pass.
The cap on retry-prompt size is enforced *structurally* by
`flow-pre-commit --json` (see `bin/flow-pre-commit.ts` —
`buildFailureExcerpt` head/tail-caps each failed check at 100+100
lines), not by an instruction the supervisor must remember to
follow. Each retry re-invokes `/verify` and pastes the prior
attempt's `failure` JSON object verbatim:

```
/verify

PRIOR ATTEMPT FAILED — failure JSON (one entry per failed check):
{
  "name": "npm run test",
  "scope": "src",
  "failure": {
    "firstErrorLine": 42,
    "firstErrorText": "FAIL  src/foo.test.ts > should bar",
    "headExcerpt": "<≤100 lines>",
    "tailExcerpt": "<≤100 lines>",
    "totalLines": 5000
  }
}
```

`firstErrorText` is the first line matching the error/fail regex;
`headExcerpt` + `tailExcerpt` are bounded slices of the un-ANSI'd
output. The supervisor can paste this verbatim because the helper
has already done the trimming — the entire `failure` object for a
single check is at most ~30 KB and shrinks as the check's output
shrinks. No further hand-truncation is required.

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
3 succeeds). Continue to step 7.

## Step 7 — CI + Copilot wait

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
| `proceed-to-review` | Continue to step 8. |
| `proceed-to-review-no-bot` | Same as above; the bot review timed out 10 min after CI went terminal. |
| `ci-failed` | Continue to step 5 mode=fix. Pass `$CI_FAILED_CHECKS` (extracted above) as the failure log. Subject to the 3-loop ci-fix cap below. |
| `merged-externally` | PR was merged externally mid-flight. Run `flow-followups run` (executes auto-allowlisted entries while the worktree is still alive), then `flow-remove-worktree`, write `phase: merged`, call `flow-notify --status merged --url "$PR_URL"`, print `MERGED`. End. The roadmap row was self-marked in the PR's diff by `/pr-review` step 7.5; no post-merge sweep required. |
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
to step 8. On `ci-failed`, continue to step 5 mode=fix. On
`merged-externally`, run cleanup and end. On `pr-closed` / `ci-hang`,
escalate and end.

## Step 8 — Review

**Phase:** `reviewing`

Invoke `/pr-review` in-process with the PR number:

```
/pr-review <PR>
```

`/pr-review` itself spawns one **Fix-Applier Subagent** via the Task
tool (the fourth of the four named Task-tool exemptions in "Hard
rules" above) to handle the per-finding address loop, the pre-commit
run, the commit + push, and the `/verify` re-run — all inside the
subagent's isolated context. The subagent writes a structured
artifact to `<worktree>/.flow-tmp/fix-applier-result.json`; the
wrapper reads it once and reuses the parsed object across its
remaining steps. The supervisor never sees the per-finding fix
prose, only `/pr-review`'s brief return summary.

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

After `/pr-review` commits + pushes, return to step 7 (CI wait),
not directly to step 9. The fix commit may have changed CI.

**End condition:** `/pr-review` returns clean (no critical
findings outstanding) AND the most recent CI cycle is green.
Continue to step 9.

On non-zero exit from `/pr-review`: retry once. If the retry also
fails, escalate `NEEDS HUMAN: review-failed`.

## Step 9 — Auto-merge gate

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
RESULT=$(flow-gate-decide "$PR")
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
| `auto-merge` | Run `flow-followups pr-body-upsert "$PR"` (no-op when log is empty; otherwise idempotent in-place upsert of `## Local Follow-ups` so the section survives the squash-merge). Continue to step 10 (auto-merge). |
| `gated` | Run `flow-followups pr-body-upsert "$PR"` (idempotent), then `flow-followups run --note-only` (the deferred LOCAL FOLLOW-UPS block — see step 11 for the contract). Write `phase: gated`. Call `flow-notify --status gated --url "$PR_URL" --reason "$REASON"` (the helper sets `.reason` to the first `.validationItems` entry, or `auto-merge opted out (--no-auto-merge)` when `autoMerge: false` with zero unchecked items). Print: `GATED:`, the PR URL, `$VALIDATION_ITEMS` (one per line, already newline-separated by the jq above), and `merge with: gh pr merge --squash <PR>`. End. |
| `merged-externally` | Already merged externally. **Do not** run `gh pr merge`. Run `flow-followups run` (executes allowlisted+auto entries while the worktree is still alive), then `flow-remove-worktree`, write `phase: merged`, call `flow-notify --status merged --url "$PR_URL"`, print `MERGED`. End. (The roadmap row was self-marked in the PR's diff by `/pr-review` step 7.5; no post-merge sweep is needed.) |
| `closed-no-merge` | Call `flow-notify --status needs-human --url "$PR_URL" --reason "pr-closed-without-merge"`. Escalate `NEEDS HUMAN: pr-closed-without-merge`. End. |
| `escalate-heading-missing` | Escalate `NEEDS HUMAN: test-steps-section-missing`. |
| `escalate-gh-error` | Escalate `NEEDS HUMAN: gh-error <.reason>`. |

## Step 10 — Merge

**Phase:** `merging`

```bash
gh pr merge --squash --delete-branch "$PR"
```

On `gh pr merge` failure: retry once. If still failing, escalate via
the standard `# Failure paths` block (`flow-state-update --phase
needs-human` → `flow-followups run --note-only` → `flow-notify
--status needs-human --url "<pr-url>" --reason "merge-failed"` →
`echo "NEEDS HUMAN: merge-failed"`). Leave the worktree intact.

On success, the roadmap row for this PR was already flipped to
`✅ shipped (#$PR)` in the PR's own diff by `/pr-review` step 7.5
(self-mark + sweep), so no post-merge metadata sweep is required.

### Post-merge follow-up sweep

Runs **before** `flow-remove-worktree` (which would delete plan.md
and orphan the candidate-issue list) and before step 11. Reads
`$WORKTREE/.flow-tmp/plan.md`'s `# Candidate follow-up issues`
section, fires `flow-create-issue` once per `- [x]` item, prints a
summary line above `MERGED`. No-op if plan.md is absent (non-feature
pipelines won't have one) or the section is missing or has zero
ticked items.

```bash
PLAN="$WORKTREE/.flow-tmp/plan.md"
FILED=()
WARN=()
if [ -f "$PLAN" ] && grep -q '^# Candidate follow-up issues' "$PLAN"; then
  # Extract ticked lines ("- [x] Title — body") from the section,
  # stopping at the next top-level heading.
  TICKED=$(awk '
    /^# Candidate follow-up issues/ {section=1; next}
    /^# / && section {exit}
    section && /^- \[x\] / {sub(/^- \[x\] /, ""); print}
  ' "$PLAN")
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # Split on the FIRST " — " only: title before, body after. Bash
    # parameter expansion does this cleanly:
    #   ${line%% — *} — strip longest suffix matching " — *" → title
    #   ${line#* — }  — strip shortest prefix matching "* — " → body
    # A naive awk -F ' — ' '{$1=""; print}' would rebuild $0 with
    # OFS=" " and collapse every subsequent em-dash inside the body
    # into a plain space, so we avoid awk's field-rebuild for this.
    TITLE="${line%% — *}"
    if [ "$TITLE" = "$line" ]; then
      # No " — " delimiter — whole line is the title, body is empty.
      BODY=""
    else
      BODY="${line#* — }"
    fi
    BODY_FILE="$WORKTREE/.flow-tmp/sweep-$(echo "$TITLE" | tr ' /' '__').md"
    printf '%s\n\nSurfaced by /product-planning during the pipeline that landed PR #%s.\n' \
      "$BODY" "$PR" > "$BODY_FILE"
    JSON=$(flow-create-issue \
      --title "$TITLE" \
      --body-file "$BODY_FILE" \
      --label flow-agent,out-of-scope-discovery)
    RC=$?
    if [ $RC -eq 0 ]; then
      URL=$(printf '%s' "$JSON" | jq -r '.url')
      FILED+=("$URL")
    else
      WARN+=("$TITLE")
    fi
  done <<< "$TICKED"
fi
if [ "${#FILED[@]}" -eq 0 ] && [ "${#WARN[@]}" -eq 0 ]; then
  echo "No follow-up issues filed"
elif [ "${#WARN[@]}" -gt 0 ]; then
  echo "WARN: filed ${#FILED[@]}/$((${#FILED[@]} + ${#WARN[@]})) follow-up issues; missing: ${WARN[*]}"
else
  echo "Filed ${#FILED[@]} follow-up issues:"
  printf '  %s\n' "${FILED[@]}"
fi
```

The sweep is best-effort: per-call failure surfaces as a `WARN:` line
but does not fail the pipeline — the merge already shipped. The
helper's title-collision idempotency makes a sweep re-run on resume
safe (re-firing yields `action: "existing"` and the same URL).

Continue to step 11 — local follow-ups must run *before*
`flow-remove-worktree` so the JSONL log is still on disk when the
report builds.

## Step 11 — Local follow-ups

**Phase:** still `merging` — no new phase value (see "no resume scenario"
note below).

Local follow-ups are manual local-computer steps a pipeline produced (e.g.
`flow setup --upgrade` after a new helper landed). Sub-skills register them
during the run via `flow-followups add`; step 11 reports them and, on the
MERGED path, executes the safe subset.

**Two-layer safety boundary:** an entry's `auto: true` flag declares
*intent*; the helper's hardcoded ALLOWLIST gates *permission* (exact-match,
v1: `flow setup` and `flow setup --upgrade`). Both must be true to execute.
Same narrow-and-named exemption pattern as the `/pr-review` auto-push and
`/flow-pipeline` auto-merge clauses in `AGENTS.md` "Don'ts". Auto-run is
gated by the same `autoMerge` flag as step 10 — `flow new --no-auto-merge`
disables both.

**End-state matrix:**

| End-state | Step 11 behaviour |
|---|---|
| MERGED | Run the helper here (post-merge, pre-`flow-remove-worktree`); execute allowlisted+auto entries, note the rest, print `LOCAL FOLLOW-UPS:` block. |
| GATED | Documented in step 9 (`gated` decision branch): `flow-followups pr-body-upsert "$PR"` + `flow-followups run --note-only`. Print before `GATED: <url>`. |
| NEEDS HUMAN | Documented in `# Failure paths`: `flow-followups run --note-only` printed before `NEEDS HUMAN: <reason>`. |
| cancelled | Skipped — the worktree is being removed; pending follow-ups are intentionally lost. |

For MERGED, run the helper here and finalize:

```bash
flow-followups run                                # executes auto-allowlisted entries; prints block
flow-remove-worktree
flow-state-update --phase merged
flow-notify --status merged --url "<pr-url>"
```

(the PR URL is available from `gh pr view "$PR" --json url -q .url`).
Print `MERGED` on its own line. End.

**Failed auto-runs are reported, not escalated.** A non-zero exit code from
an allowlisted command (e.g. `flow setup --upgrade` failed because of a
permission issue) is rendered in the printed block as `FAIL <command> (exit
N)` with a tail excerpt. The supervisor still ends with `MERGED` — the user
inspects scrollback. Escalating to `NEEDS HUMAN` would block a successful
merge on a peripheral failure, which inverts the priority.

**No new phase value.** Step 11 is bookkeeping inside `merging` (MERGED
path) or a final read just before the terminal print (GATED / NEEDS HUMAN).
Adding `local-followups` to `STEP_PHASES` would force a state.json write
that adds nothing — there's no resume scenario where the supervisor crashed
mid-step-11 and needs to know that.

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
RESULT=$(flow-resume-decide)
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
| `step-4` | Re-enter step 4 (approval). Re-print the plan summary, then emit the same two markdown bullets as step 3's feature-intent end-condition (worktree absolute path + plan file absolute path, on their own lines as the last lines of the message, no trailing punctuation), and wait — never replay an approval the user gave to a now-dead session. |
| `step-5` | Re-enter step 5 (implement). Re-invoke `/new-feature`. |
| `step-5.5` | Re-enter step 5.5 (re-symlink). Re-run `flow setup --upgrade --source "$WORKTREE"` per step 5.5's end-condition (idempotent). |
| `step-6` | Re-enter step 6 (verify). Re-invoke `/verify`. |
| `step-7` | Re-enter step 7 (ci-wait). Re-enter the poll loop via `flow-ci-wait`. |
| `step-8` | Re-enter step 8 (review). Re-invoke `/pr-review <PR>`. |
| `step-9` | Re-enter step 9 (gate). Two sub-cases distinguished by `.reason`: `pr-merged-worktree-still-exists` (run step 11's MERGED branch — `flow-followups run` then `flow-remove-worktree`, write `phase: merged`, print `MERGED`, end; **do not** fall through to step 10's `gh pr merge` on an already-merged PR) vs. `at-auto-merge-gate` (re-evaluate the gate via `flow-gate-decide`). |
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
  The user may have approved before the crash; re-print the plan
  summary, emit the same two markdown bullets as step 3's
  feature-intent end-condition (worktree absolute path + plan file
  absolute path, last lines, no trailing punctuation), and wait for
  the user to re-confirm. Don't replay an approval the user gave to
  a now-dead session.
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

The first three lines (`MERGED` / `GATED: <url>` / `NEEDS HUMAN: <reason>`)
may be preceded by a `LOCAL FOLLOW-UPS:` (or `LOCAL FOLLOW-UPS (deferred —
PR not yet merged):`) block written by step 11 — see the step 11 contract
above for when it appears. The `cancelled` line is never preceded by a
follow-ups block.

After printing the end-condition line, **end the turn**. The tmux
window stays open with full scrollback. The user closes it later
with `flow done <name>`.

# Failure paths

The general rule: **escalate over silent retry**. Each step has a
documented retry budget; once exhausted, write `phase: needs-human`,
print any deferred follow-ups, fire a notification, print
`NEEDS HUMAN: <reason>`, and end:

```bash
flow-state-update --phase needs-human
flow-followups run --note-only       # prints LOCAL FOLLOW-UPS (deferred …) if log non-empty; silent otherwise
flow-notify --status needs-human --reason "<reason>"
echo "NEEDS HUMAN: <reason>"
```

Do **not** call `flow-remove-worktree` on escalation — leave the
worktree + PR (and the JSONL log) intact so the user can inspect and
resume.

## Branch-mismatch escalation (no retries)

When `flow-state-update` exits with status 3, the worktree's branch
no longer matches the `.flow-branch` marker written by
`flow-new-worktree`. This means a peer pipeline (or a stray manual
git command) renamed this branch out from under us — the same family
of failure as the 2026-05-01 incident. The mechanical guard refused
to write the phase transition; the supervisor must NOT retry.
Escalate immediately:

```bash
flow-state-update --phase needs-human  # may itself fail; that's ok, scrollback shows the cause
flow-notify --status needs-human --reason "branch-mismatch"
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
plan-pending-review     (feature only; ends turn — pending phase)
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

Pending phases (legitimate turn-ends mid-pipeline; recognised by
`flow-stop-guard`):

```
plan-pending-review                (step 3 → 4 handoff for feature intent)
triaged-no-change                  (step 1 no-change branch)
triage-pending-clarification       (step 1 single clarifying question)
approval-pending-clarification     (step 4 single clarifying question)
```

The canonical phase set is exported from `bin/lib/state.ts` as
`PIPELINE_PHASES`; `flow-state-update --phase` rejects values
outside that set so a typo can't silently land in state.json and
defeat the Stop hook.

# Verification (this skill)

After each phase transition:

- `~/.flow/state/<slug>.json` reflects the new `phase`, the populated
  `worktree` (post-step-2) and `pr` (post-step-5) fields, and a
  fresh `updatedAt`.
- `flow ls` (run from any terminal) shows the right phase **and PR
  number** for this pipeline's window.
- The supervisor never invoked the `Task` / `Agent` tool, **except**
  via the four named exceptions in "Hard rules" above:
  `/pr-review`'s "Independent Multi-Agent Review",
  `/product-planning`'s "Independent Discovery Subagent",
  `/new-feature`'s "Independent Scout Subagent",
  and `/pr-review`'s "Independent Fix-Applier Subagent".
  No other skill or step may call Task.
- The supervisor never spawned a `claude -p` subprocess.

When the pipeline ends, scrollback contains exactly one of `MERGED`
/ `GATED: <url>` / `NEEDS HUMAN: <reason>` / `cancelled` on its own
line, and the corresponding `phase:` is in state.json.

When `FLOW_NOTIFY=1` is set in the supervisor's environment, every
terminal end-state (`merged`, `gated`, `needs-human`) is preceded
by a `flow-notify` call. The helper is a no-op when the env var is
unset, so the call is unconditional from the skill's perspective.
