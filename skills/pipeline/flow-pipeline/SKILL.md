---
name: flow-pipeline
description: >-
  Supervisor skill for the tmux-driven flow pipeline. Drives one feature
  end-to-end (triage → worktree → plan → implement → verify → ci-wait →
  review → gate → merge) inside a single Claude Code session. Use ONLY
  when invoked by `flow feature create <description>`'s seed prompt or via an
  explicit `/flow-pipeline <description>`. Do NOT auto-trigger on
  generic "build X" / "implement Y" phrasing — that hijacks unrelated
  chats. The skill is one long-running supervisor turn per phase, not a
  sub-agent.
argument-hint: '"<feature description>"'
---

# Goal

You are the supervisor of one tmux window's pipeline. The user typed
`flow feature create "<description>"` from a terminal; tmux opened a window,
launched Claude Code in it, and seeded this chat with a prompt that
invokes you. From here, you drive the pipeline from prompt to
**`MERGED`**, **`gated`**, or **`NEEDS HUMAN: <reason>`** — the user
walks away after approving the plan and reads the result later.

You are the single LLM container for this pipeline. Every sub-skill
(`/flow-product-planning`, `/flow-new-feature`, `/flow-verify`, `/flow-pr-review`) loads
in-process when you invoke it; every helper script
(`flow-new-worktree`, `flow-remove-worktree`, `gh`, etc.) is a Bash
tool call. **You never spawn a Task-tool sub-agent.** flow's flat-fan-out
policy (deliberate, not a platform limit — `docs/nested-subagents-assessment.md`,
repo-only, not shipped) allows one exception, verify-loop → edit-applier; a
long-running supervisor with sub-agents would also blow the context window.
Stay in-process for skills; shell out for scripts; never delegate.

# When to Use

- Invoked from `flow feature create`'s seed prompt: a single line,
  `[pipeline-slug: <slug>] Use the /flow-pipeline skill. REQUEST_FILE: <path>`
  — the request lives at `REQUEST_FILE`, not the seed. See Step 1.
- Explicit user invocation: `/flow-pipeline "<description>"` — no
  `REQUEST_FILE`; the inline description IS the request.

# When NOT to Use

- Generic "add X" / "implement Y" phrasing without `/flow-pipeline`
  or a `flow feature create` seed. Use `/flow-new-feature` directly for one-shot
  feature work in the user's existing session.
- The user wants to step through phases manually (no auto-progression).
  Use the individual skills (`/flow-product-planning`, `/flow-new-feature`,
  `/flow-verify`, `/flow-pr-review`) directly.
- Resume after a Claude Code crash → `flow feature resume <name>` is
  the entry point. The wrapper re-launches Claude Code into the same
  tmux window with the resume seed prompt; this skill detects the
  prompt prefix and walks the decision tree in
  `references/failure-recovery.md` section (b). See **Resume mode**
  below.

# Hard rules

> **You are never a sub-agent.** Never call the `Task` / `Agent`
> tool from this skill — **except for the named exceptions below**.
> Never spawn a raw `claude -p` subprocess — the only sanctioned
> headless-Claude spawn is `flow-claude-headless` (a Bash fan-out, not a
> ninth exemption; contract in `references/headless-claude.md`). A
> standalone leaf skill like `/flow-research` run directly is a separate
> context this rule never governed. The supervisor's
> only fan-out is (a) loading sub-skills in-process, (b) Bash tool
> calls, and (c) the eight narrowly-named Task-tool exceptions that
> follow.
>
> The two constraints behind the rule above are (1) flow's deliberate
> flat-fan-out policy (rationale: `docs/nested-subagents-assessment.md`,
> not shipped by `flow install`), and (2) a long-running supervisor with
> sub-agents would bloat past the context window. Constraint (1) is not a
> platform limit on the supervisor's own Task calls — it is flow's policy,
> and it is why exactly eight top-level sites are enumerated below and
> none nests. All eight are one-shot, not long-running, so constraint (2)
> doesn't apply either. They are the **only eight** authorised Task-tool
> fan-out sites from this supervisor; no other skill or step may call
> Task. Each is anchored on its step heading name rather than its number
> so it survives future renumbering. Same narrow-and-named contract as the
> `/flow-pr-review` auto-push and `/flow-pipeline` auto-merge exemptions
> in `AGENTS.md`. If a future skill needs the same license, add it here
> by name rather than generalising the rule. Each exemption spawns its
> named `agents/flow-*.md` definition via a file-exists guard, addressing
> a plugin-root definition by the plugin-qualified `flow-module-core:<agent>`
> name (a bare agent name fails Task-tool resolution outright on a
> plugin-root install), falling back to `general-purpose` with a loud
> `NOTICE — agent-fallback:` line when the definition is not installed.
>
> **Load the Task tool at each spawn site.** Each of the eight spawn
> procedures below must instruct the supervisor to load the Task tool
> schema via `ToolSearch query="select:Task"` *before* invoking Task (or
> its alias `Agent`). Where neither is surfaced top-level by the harness
> (aliases of the same one-shot subagent-spawn primitive), an unguarded
> invocation silently falls through to in-line execution — the regression
> PR #124 introduced and this preamble prevents. On missing schema,
> escalate `NEEDS HUMAN: task-tool-unavailable: <exemption-name>` rather
> than falling back to in-line execution. See each exemption's spawn procedure
> for the canonical "Load the Task tool before spawning" paragraph and
> `# Failure paths` for the escalation script.
>
> **A `SendMessage` continuation of a partial (`maxTurns`) agent stays inside its exemption — not a ninth site.** See `references/partial-result-continuation.md`.
>
> **Task-tool exemption #1: `/flow-pr-review` Independent Multi-Agent
> Review.** Step 8's six review agents + one diff-only intent-guess agent,
> spawned together ([references/exemption-contracts.md](../../../references/exemption-contracts.md)).
>
> **Task-tool exemption #2: `/flow-product-planning` Independent Discovery
> Subagent.** Step 3's one discovery agent (`flow-discovery`), writing
> `.flow-tmp/plan.md` + `.flow-tmp/pr-description-draft.md`; full contract in
> [references/exemption-contracts.md](../../../references/exemption-contracts.md).
>
> **Task-tool exemption #3: `/flow-new-feature` Independent Scout
> Subagent.** Step 5's one scout agent (`flow-scout`; wider-scope path
> only — ≤3 affected files skip it), writing `.flow-tmp/scout.md`; full
> contract in [references/exemption-contracts.md](../../../references/exemption-contracts.md).
>
> **Task-tool exemption #4: `/flow-pr-review` Fix-Applier Subagent.** Step
> 8's one fix-applier agent (`flow-fix-applier`) for the per-finding
> address loop + commit/push, writing `.flow-tmp/fix-applier-result.json`;
> full contract in [references/exemption-contracts.md](../../../references/exemption-contracts.md).
>
> **Task-tool exemption #5: Merge-Conflict Resolver Subagent.** Step
> 10's one resolver agent (`flow-merge-resolver`) for the base-branch
> merge + per-file resolution + push (per-pipeline branch only), writing
> `.flow-tmp/merge-resolver-result.json`; full contract in
> [references/exemption-contracts.md](../../../references/exemption-contracts.md) and
> `../flow-merge-resolver-instructions/SKILL.md`. `maxTurns: 80`; partial-result continuation per `references/partial-result-continuation.md`.
>
> **Task-tool exemption #6: `/flow-coder` Independent Edit-Applier Subagent.**
> The one edit-applier agent (`flow-edit-applier`) `/flow-coder` spawns when
> `/flow-new-feature` step 5, `/flow-verify` step 3, or `/flow-refactoring` step 3
> takes its wider-scope path — or the `/flow-pipeline` supervisor's interactive
> code-change redirect path fires (see the "Mid-flight code-change redirects"
> section and `references/redirect-handling.md`) — writing
> `.flow-tmp/coder-result.json`; full contract in
> [references/exemption-contracts.md](../../../references/exemption-contracts.md) and `skills/pipeline/flow-coder/SKILL.md`.
>
> **Task-tool exemption #7: `/flow-pr-review` Independent Gatekeeper Subagent.**
> `/flow-pr-review` Step 1.5's one gatekeeper agent (`flow-gatekeeper`) with a
> `model: "haiku"` cost-routing override, writing `.flow-tmp/gatekeeper-result.json`;
> full contract in [references/exemption-contracts.md](../../../references/exemption-contracts.md).
>
> **Task-tool exemption #8: `/flow-pr-review` Independent Consolidator-Validator
> Subagent.** `/flow-pr-review` Step 3.5's one consolidator-validator agent
> (`flow-consolidator`; default Sonnet, no model override), writing
> `.flow-tmp/consolidator-result.json`; full contract in [references/exemption-contracts.md](../../../references/exemption-contracts.md).
>
> **The `/flow-pr-review` Gemini cross-model lens is a Bash fan-out, not a
> ninth exemption.** When the supervisor invokes `/flow-pr-review` in step 8
> and the consumer has opted into `review.gemini`, `/flow-pr-review` Step 3
> runs ONE additional cross-model reviewer (Gemini) via `flow-delegate`
> (agy) as a Bash subprocess (`flow-gemini-lens`), ALONGSIDE exemption
> #1's six-agent Multi-Agent Review Task fan-out. It spawns no Task, so
> the eight-exemption count above is unchanged — this is a sibling note in
> the same F2 "not a ninth exemption" shape as the "Load the Task tool at
> each spawn site" guard above, NOT a `#9` exemption block. The lens is
> config-gated, default off, and a graceful skip on any failure (it never
> hard-fails the review). Documented bidirectionally in `AGENTS.md`
> `## Don'ts` and `skills/pipeline/flow-pr-review/SKILL.md` Step 3.

> **The Step-3 cross-model plan review is a
> Bash fan-out, not a ninth exemption.** When the consumer has opted into `review.gemini` and plan.md
> carries a `## Decision analysis` section, step 3 runs ONE cross-model plan
> reviewer (AGY / Gemini) via `flow-delegate` as a Bash subprocess
> (`flow-plan-review`) to pressure-test the PRD's consequential decisions
> before the plan-pending-review gate. It spawns no Task, so the
> eight-exemption count above is unchanged — a sibling note in the same F2
> "not a ninth exemption" shape as the Gemini-lens note above, NOT a `#9`
> exemption block. It reuses the SAME `review.gemini` gate key, is default
> off, and gracefully skips on any failure (it never blocks the plan gate).
> Documented bidirectionally in `AGENTS.md` `## Don'ts` and this file's
> step 3.

> **The Step-3 blind method survey is a
> Bash fan-out, not a ninth exemption.** Before forced research and
> discovery, step 3 runs two model-pinned agy judges over a goal-only
> brief (`flow-blind-survey`) via `flow-delegate-fanout` as a Bash
> subprocess. It spawns no Task — a sibling note in the same F2 shape as
> the two notes above, NOT a `#9` exemption. Gated on `state.interview`
> non-empty; gracefully skips on any failure. Documented bidirectionally
> in `AGENTS.md` `## Don'ts` and `references/blind-survey.md`.

> **Headless Claude via `flow-claude-headless` is a Bash fan-out, not a
> ninth exemption.** Any skill the supervisor loads — including
> consumer-repo skills invoked during implement — may run a fixed-model,
> fixed-effort `claude -p` ONLY through `flow-claude-headless`, which
> allowlists the child env (`FLOW_SLUG`/`TMUX_PANE` never leak, issue
> #618), caps spend, refuses to nest, and returns one envelope carrying
> `total_cost_usd`. It spawns no Task, so the eight-exemption count is
> unchanged. Documented bidirectionally in `AGENTS.md` `## Don'ts` and
> `references/headless-claude.md`.

> **You never bypass the helper scripts.** Always call
> `flow-new-worktree`, `flow-remove-worktree`,
> `flow-fetch-pr-review`, `flow-reply-pr-comments`, and
> `flow-followups` rather than reimplementing their behaviour with
> raw `git` / `gh` calls. The helpers handle edge cases (existing
> worktrees, branch collisions, review-comment ID mapping,
> allowlist enforcement on auto-run) that are easy to get wrong.

> **You only call `AskUserQuestion` from the one named form.** The
> supervisor's only authorised `AskUserQuestion` call is step 9's "Gate
> override (post-verdict, opt-in)" form (the single confirmation fired
> when the user instructs the supervisor to merge a `gated` PR anyway —
> the form is what makes a gate override a *fresh* confirmation,
> putting the gate verdict in front of the user rather than letting the
> supervisor infer authorisation from an earlier instruction). There is
> no candidate-issues form: discovery lists follow-up candidates in
> the plan, ticked (`- [x]`) only when their value-prop block clears the
> bar, and the plan-review checkpoint (step 3's `--details`
> disclosure, step 4's `drop candidate #N` / `drop all candidates` /
> `file candidate #N` / `defer task #N` replies) is the single curation
> surface — a mechanical
> reply-and-helper loop, never a form. Same narrow-and-named contract as
> the Task-tool exemptions above: `AskUserQuestion` is a different
> primitive (synchronous user prompt, not a sub-agent fan-out), but a
> small named set keeps the supervisor's user-prompt surface auditable.
> This form is the **only** authorised user-prompt surface — no other
> skill or step may call `AskUserQuestion`. If a future skill needs the
> same license, add it here by name rather than generalising the rule.

> **You only auto-create GitHub issues from the named sites.**
> `flow-create-issue` may fire only from (a) `/flow-pr-review`'s Step 6
> deferral path, (b) `/flow-pr-review`'s Step 5 retrospective generic-gap
> capture, (c) `/flow-pipeline`'s Step 10 post-merge sweep (one issue per
> `- [x]` item in plan.md's `# Candidate follow-up issues` section), (d) a
> user-instructed `flow-untracked file <n>` reply, and (e) the
> `/flow-file-issue` skill's hand-filed path. A new fire site needs a named
> exemption in `AGENTS.md` "Don'ts" first — same narrow-and-named contract
> as the auto-merge and Task-tool exemptions — because indiscriminate issue
> auto-creation pollutes user backlogs with low-confidence noise and races
> on `gh` rate limits.

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
> triaged-no-change`); (5) step 7's CI-wait yield, where the
> supervisor runs the one-shot `flow-ci-check` decider in the
> foreground and, on a `waiting` verdict, backgrounds the dumb
> `flow-ci-wait` waiter; if turn-end arrives before a wake primitive
> fires and a fresh `flow-ci-check` call reaches `decided`, the
> supervisor writes `phase: ci-wait-pending` and ends the turn cleanly
> rather than hand-rolling a discouraged manual poll loop (see step 7
> for the yield-and-resume contract); and (6) step 4's auto-checkpoint
> at the approval →
> implement hand-off (state writes `phase: checkpoint-pending-clear`),
> where the supervisor flushes conversational state to the state-dir
> checkpoint, nudges "safe to `/clear`", and yields so the user can reset
> context before the token-heavy phases (see step 4 for the
> auto-checkpoint sub-step); (7) the intent interview (adaptive)'s
> two chat pauses — step 1 (state writes `phase:
> triage-pending-interview`) and step 3's post-discovery question gate
> (state writes `phase: plan-pending-interview`) — each ending the turn
> once per round until the frontier is empty (see step 1's Intent
> interview sub-step and step 3's Question-gate branch;
> `references/interview-playbook.md` governs the round shape); and (8)
> the method pause (phase `plan-pending-interview`, a SECOND, distinct
> use of the same phase; see `references/blind-survey.md`). Every
> other step transition stays in the
> same turn. Harness-level enforcement: `flow-stop-guard`
> (registered as a Claude Code Stop hook by `flow install`) reads
> `~/.flow/state/<slug>.json` and blocks any turn-end whose phase
> is not in this set. See "Harness-level enforcement (Stop hook)"
> below for the contract.

# Harness-level enforcement (Stop hook)

`flow-stop-guard` is a Claude Code Stop hook installed by
`flow install` into `~/.claude/settings.json`. It is the structural
defence behind the "never end the turn between sub-skills" Hard
rule above — text-only reminders in this SKILL.md cannot intercept
a model that has already chosen to stop, but a Stop hook fires
*at* the model's turn-end signal.

Contract:

- Reads `~/.flow/state/<slug>.json` (slug resolved from the
  `FLOW_SLUG` env var — set in the launch env by both launcher
  backends).
- Exits 2 with a stderr `DO NOT END THE TURN` reminder when phase
  is non-terminal-non-pending — the supervisor is mid-pipeline and
  must continue.
- Exits 0 (allows the stop) when phase is in the legitimate-end
  set: any of the four terminals (`merged`, `gated`, `needs-human`,
  `cancelled`) or the six pending-end phases
  (`plan-pending-review`, `triaged-no-change`,
  `triage-pending-clarification`, `approval-pending-clarification`,
  `ci-wait-pending`, `checkpoint-pending-clear`).
- Self-detects: exits 0 (no-op) when no flow slug resolves (no
  `FLOW_SLUG`), or when state.json is
  missing. Safe to install in a global Stop hook list.
- Loop-break budget: a per-turn block counter persisted at
  `~/.flow/state/turns/<slug>.json` (a sibling subdirectory so `flow ls`
  ignores it). Legitimate pending exits do NOT consume it.
- `stop_hook_active` is treated as advisory (turn-boundary detection via
  `false`-on-first-stop), not an authoritative budget.
- Stagnation detection: once the budget is exhausted (blockCount ≥
  TURN_BLOCK_LIMIT), subsequent stops exit 0 only when phase has advanced
  since the last block; otherwise it re-engages and exits 2. The loop-break
  exit writes a stderr breadcrumb Claude Code surfaces the next turn-start.

Opt out: `flow install --no-hooks` skips the merge entirely and
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

`--slug` is omitted because every slug-taking flow helper (`flow-notify`,
`flow-state-update`, `flow-rename-window`, `flow-open-pr`,
`flow-resume-decide`, `flow-gate-decide`, `flow-remove-worktree`,
`flow-gate-summary`)
auto-resolves it from the `FLOW_SLUG` env var (set in the
launch env by both launcher backends; the per-Bash-call shell loses any
`SLUG=…` between calls, so `FLOW_SLUG` is the load-bearing carrier).
Pass `--slug <slug>` explicitly only when
invoking from outside the pipeline session — space-separated; the
`--slug=<slug>` equals form is not accepted by any flow helper.
`bin/slug-flag-contract-lint.test.ts` enforces this list: every helper
named above is asserted to parse `--slug` into the slug it names.

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
initially by `flow feature create` with `phase: "starting"` and updated at every
transition by you. `flow ls` reads only this file. The supervisor
never writes the worktree-side `.flow-status` text file (it doesn't
exist anymore).

| Field | Set by | When |
|---|---|---|
| `slug`, `repo` | `flow feature create` | once at pipeline creation |
| `phase` | you via `flow-state-update --phase <p>`, or the step's emitting helper (see each step's **Phase:** line) | at every transition |
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
The slug is auto-resolved from `$FLOW_SLUG` — the canonical pipeline
identifier, set by `flow feature create` in the launch env and
matching the worktree directory's basename (e.g. `csv-export`). Under
the tmux launcher, the window title is *not* this identifier: the
supervisor renames it to a readable title in step 1, and the user may
further rename it via `tmux ,`, with no effect on `$FLOW_SLUG`.

## Additional fields to set once

Two fields ship via `flow-state-update` exactly once during a
pipeline:

```bash
# After step 2 (flow-new-worktree returns): record the absolute path
# so consumers like `flow done` can find the worktree.
flow-state-update --phase worktree-create --worktree "$WORKTREE"

# After step 5 (PR opens): flow-open-pr owns BOTH fields — it records
# the PR number (so flow ls shows the #142 column) AND advances the
# phase to implementing in the same call. Do not also run a manual
# flow-state-update for the phase here — that would be redundant with
# the helper's own write, not complementary to it.
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

**First action of the supervisor.** Extract the pipeline slug from the
seed prompt before any bash calls. The seed is a single line whose
prefix has the form `[pipeline-slug: <slug>]` — parse the literal
`<slug>` value from it and embed it inline in the two calls below. The
slug is a concrete string (e.g. `csv-export`), not a shell variable
that persists across tool calls.

**The seed carries `REQUEST_FILE: <path>`; read that file first and
treat its full contents as the verbatim request** (the description no
longer rides the seed — a stray control char in free-form text used to
corrupt delivery, so the launcher now writes it to this file first). If
`REQUEST_FILE` is absent, escalate `NEEDS HUMAN: request-file-missing`.
A hand-run `/flow-pipeline <description>` carries no `REQUEST_FILE` —
the inline description IS the request, used exactly as before.

Write the phase to state.json so `flow ls` immediately shows `triaging`
instead of the stale `starting` from `flow feature create`. Pass `--slug <slug>`
explicitly — explicit and self-documenting, rather than relying on
`resolveSlugAmbient()`'s ambient `FLOW_SLUG` read:

```bash
flow-state-update --phase triaging --slug <slug>
```

**No-state-file guard (never work inline on the base branch).** If this
first `flow-state-update --phase triaging` exits non-zero with a `no state
file` error *while `FLOW_SLUG` is set* — i.e.
the supervisor is genuinely inside a `flow feature create`-launched pipeline — this is the
`flow feature create` state-write race (the parent's `phase: starting` write has not
landed yet), **not** a direct/manual invocation. The supervisor must **not**
fall through to classifying or implementing inline on the base branch.
Retry `flow-state-update --phase triaging --slug <slug>` a bounded ~3 times
with a short backoff; if it still fails, escalate `NEEDS HUMAN:
state-file-missing-on-start` and end the turn. The escalation's
`flow-gate-summary` render may itself be unable to record `phase:
needs-human` (there is no state file to update), so
the supervisor prints the `NEEDS HUMAN: state-file-missing-on-start` line and
ends — `flow-stop-guard` already no-ops when state.json is missing, so the
turn-end is permitted. (`flow feature create` now writes `phase: starting` before it
delivers the seed, so this guard is defense-in-depth against a residual
slow-filesystem window or a future regression, not the common path.)

Then, under the tmux launcher, set a readable tmux window title so the user can scan their
status bar at a glance instead of squinting at the slug. The slug
stays the canonical lookup key (`FLOW_SLUG`, set in the launch env
when `flow feature create` launched the pipeline) — the rename
only changes the tmux window's display title. Pass `--slug <slug>` here for the same
reason as above: explicit and self-documenting.

```bash
flow-rename-window --slug <slug> "<short descriptive title>"
```

**Only these two step-1 calls use `--slug`.** All other helpers after
step 1 continue to use auto-resolution (`resolveSlugAmbient`) because
`FLOW_SLUG` is reliably set for the pipeline's whole lifetime.

Pick a 20–30-character title from the user's verbatim description.
Strip imperative verbs and articles (`make`, `add`, `the`, `a`),
keep the topic noun phrase. Examples:

- `"Make tmux window renames safe …"` → `"safe tmux window renames"`
- `"Add CSV export to portfolio page"` → `"CSV export"`
- `"Fix the flow-ci-wait copilot detection bug"` → `"copilot detection fix"`

Fire `flow-rename-window` exactly **once** in this step. If the user
later runs `tmux ,` to rename to something else, do **not** re-rename
in subsequent steps — the user's choice wins.

#### Goal-framing: ladder up to the ultimate goal

Before classifying, ladder up from the surface request to the underlying
problem / friction / efficiency-gain it serves — what the user ultimately
wants fixed, unblocked, or sped up — using the Ladder Up technique in
`skills/pipeline/flow-product-planning/references/discovery-playbook.md`
(reference it; don't duplicate it here). Infer the **ultimate goal** and
state it in **one line** in chat, then carry it in your context to step 3.

Laddering up is the default; the same playbook carries a broader set of
**framing lenses** (internal-only Five Whys, Jobs-to-be-Done,
first-principles, inversion, pre-mortem, second-order effects) for a
request at the right altitude but still mis-framed — reach for one only
when framing is genuinely in doubt, and keep it internal (never an
interrogation or an emitted section).

This is the triage-side entry point for the AGENTS.md `## Output style`
rule **Understand the ultimate goal behind the request, not just the
literal ask.**, and it is **conditional**: skip the whole sub-step —
laddering and lenses alike — on expert-specified / trivial /
time-critical requests. Infer-and-proceed is the default: flow PRs are
gated and revertible, so proceed on the most-likely goal and surface the
considered alternative in the PRD and the PR `## Why` (gated at
`plan-pending-review` for feature intent) rather than stopping to ask.

**Intent interview (adaptive).** After Ladder Up above and the prompt-sanity
gate below, apply the trigger contract in
`references/interview-playbook.md` (fire-by-default for change-intent
requests, with named carve-outs and a mechanical under-~50-character
floor — full detail lives there, not duplicated here). When the trigger
does NOT fire, proceed straight to classification below unchanged.

When the trigger **fires**:

1. Compose the round's questions, then write the phase **together with
   the ask-time digest** — the full interview-to-date with this round's
   questions carried at `still-open` (the third resolution state the
   playbook's `## 7` names):

   ```bash
   flow-state-update --phase triage-pending-interview --interview-stdin <<'EOF'
   <digest: every question asked so far, each ANSWERED/adopted/still-open>
   EOF
   ```

   Unlike step 3's question gate — whose battery survives the pause on
   disk at `.flow-tmp/interview-questions.md` — the step-1 battery
   exists ONLY in the turn being ended here, so a `/clear` or crash at
   the pause would otherwise strand the resume row (`step-1`,
   `awaiting-triage-interview-answers`) with an empty
   `.context.interview` and force it to re-derive a different frontier —
   renumbering questions the user is looking at and breaking the stable
   `Q<n>` ids that make `answer: 3a` unambiguous. This ask-time write is
   what makes the pause itself recoverable.
2. Render the current frontier round per the playbook's `## 3. Question
   format` — every question numbered `Q<n>`, grouped under its category
   heading — inside the `references/pause-output-contract.md` slot
   shape (template: `references/interview-playbook.md` `## 8`; labeled
   slots, no open prose).
   <!-- any new pause site below must reference pause-output-contract.md -->
3. End the turn.
4. On the user's reply, parse it per the playbook's `## 5. Answer
   parsing` (compact `1a 2c 3: <text>` form; a vague/non-committal
   answer silently adopts that question's `Recommended:` option) or
   route an escape verb per `## 6` (`proceed` / `skip interview` /
   `cancel`).
5. Immediately after parsing the reply — BEFORE recomputing the
   frontier — persist the full interview digest so far (every question
   asked in every round up to and including this one, and its
   resolution) via `flow-state-update --interview-stdin` (see the
   playbook's `## 7. Persistence contract`; the write REPLACES the
   prior digest with the full interview-to-date, not a delta). This
   per-round write is what makes a mid-interview crash or `/clear`
   recoverable — a resumed session re-renders from the last persisted
   round instead of losing every answered round since the interview
   started.
6. Recompute the frontier: settled answers may reveal new questions
   (push them to the next round) or the frontier may be empty (proceed
   to step 2). Repeat from step 2 above for a non-empty frontier.

This sub-step is DISTINCT from the unparseable-input branch below
(**Ambiguous** → `triage-pending-clarification`): that branch is a
single, unpersisted clarifying ask for genuinely unparseable input; this
interview is the adaptive, multi-round, persisted battery for a
parseable-but-underspecified change request. Never ask mid-run outside
either of these two named mechanisms.

#### Prompt sanity gate

Bounded pass verifying the prompt's concrete claims against the worktree/attached files (bounded excerpt reads only), reaching **sound** (proceed) / **suspect** (proceed, thread note to step 3) / **contradicted** (ask one question quoting both sides; unresolved ⇒ `NEEDS HUMAN: prompt-contradiction`). Checklist: `references/prompt-sanity.md`.

Then classify:

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
  then write the phase and persist the answer via a quoted heredoc on
  stdin before ending the turn:

  ```bash
  flow-state-update --phase triaged-no-change --answer-stdin <<'EOF'
  <the answer just given to the user>
  EOF
  ```

  The phase write is what `flow-stop-guard` reads to recognise the
  legitimate stop; the quoted-heredoc + `--answer-stdin` transport persists
  the answer verbatim (immune to shell expansion and a leading `--`, so
  backticks, `$(...)`, or a leading `---` round-trip byte-for-byte) for
  re-surfacing on resume, since a no-change pipeline has no worktree. Do NOT
  proceed to step 2.
- **Change** → continue to step 2. The **slug** was already finalized by
  `flow feature create`'s slugify (`bin/lib/slug.ts`) and is the worktree
  directory basename; the supervisor never re-derives or renames it (it is
  the canonical pipeline identifier, set in the launch env as `FLOW_SLUG`
  — changing it would orphan the state file, worktree branch, and
  `flow attach`/`flow done` lookups). The display-title rename
  (`flow-rename-window`, tmux launcher only) is the only exception.
  `flow-new-worktree` enforces
  this: a positional slug not matching the ambient `FLOW_SLUG` exits
  non-zero with `slug-mismatch:` (the PR #152 footgun).
- **Ambiguous** (input is genuinely unparseable) → write
  `flow-state-update --phase triage-pending-clarification`,
  then ask the single clarifying question and end the turn. The
  next turn re-enters step 1 with the user's reply. If the answer
  is still ambiguous, escalate `NEEDS HUMAN: triage-ambiguous` via
  `flow-gate-summary` (which records
  `phase: needs-human` itself) instead of asking again.
  Format this reply per `references/pause-output-contract.md` — labeled slots, no open prose, ≤12 lines, ≤2 bullets per slot (template: `### ❓ Clarification needed` / `**Needs attention:** <the ambiguity>` / `**Next action:** reply with your intent`).
  <!-- any new pause site below must reference pause-output-contract.md -->

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

The positional `<slug>` is belt-and-suspenders: `flow-new-worktree` reads
`$FLOW_SLUG` ambiently, so a bare call resolves the same value; a
positional that doesn't match `$FLOW_SLUG` is a hard error
(`slug-mismatch:`, exit 2), not a silent footgun (step 1's "never
re-derives the slug" contract).

Capture the absolute worktree path it prints. Set `$WORKTREE` to
this for the rest of the pipeline. **`cd` into the worktree** —
every subsequent step runs from there.

Now record the worktree path in state.json (the only step where
`--worktree` is set):

```bash
flow-state-update --phase worktree-create --worktree "$WORKTREE"
```

**Runtime `/add-dir` fallback (best-effort, never-blocking).** `flow feature
create` pre-authorized the *deterministic* worktree path as a
chrome-devtools MCP workspace root at launch, but a collision auto-suffix
(`-2`/`-3`/…) makes the **actual** `$WORKTREE` diverge from it. Issue a
runtime `/add-dir "$WORKTREE"` now so step 8c screenshot evidence can write
to `<worktree>/.flow-tmp/ui-evidence/` (issue #317). Purely a reliability
nicety — the a11y snapshot remains the evidence gate, and the screenshot
save-path cascade's session-cwd fallback covers an unavailable `/add-dir`
(see `/flow-pr-review` `references/ui-validation-evidence.md`). Never block or
escalate on it.

**End condition:** the worktree directory exists, is on a fresh
branch, and `pwd` matches `$WORKTREE`.

On non-zero exit: escalate `NEEDS HUMAN: worktree-create-failed
<stderr>` and end.

## Step 3 — Plan

**Phase:** `planning`

Invoke `/flow-product-planning` in-process with the user's verbatim
request as the argument:

```
/flow-product-planning <verbatim user description>
```

Fold the **ultimate goal** you inferred in step 1's goal-framing sub-step
into this invocation as explicit context (append it after the verbatim
request) so the Discovery Subagent anchors the PRD Problem Statement on it;
discovery still validates the goal against the codebase and surfaces an Open
Question if it disagrees — see `discovery-instructions.md` §3 ("User intent").

**Blind method survey (before forced research and discovery).** Before the
invocation-threading pass below, and before forced research, run the
Step-3 blind method survey: gated on `state.interview` non-empty, the
survey file absent, and `flow-module-status --check research` — on a pass,
author a goal-only brief from step-1's goal line plus goal-level interview
answers (NEVER the raw description or the user's method), and run
`flow-blind-survey --brief-file … --description-file … --out
"$WORKTREE/.flow-tmp/blind-survey.md" --worktree "$WORKTREE"` as a Bash
call with `timeout: 600000`. Branch on `{ran}`, never the exit code; print
one chat line either way (`blind survey: A=… B=…` or `blind survey
skipped — <reason>`); on `ran:true`, thread a `SURVEY:` marker below. Runs
once per pipeline — a revision pass reuses the existing survey file. On a
`ran:true` pass, the post-discovery plan-shape lint backstop also passes
`--survey-ran` so a missing `## Method selection` section is a named miss.
Full gate/brief/run contract: [references/blind-survey.md](references/blind-survey.md).

**Invocation threading.** Before invoking `/flow-product-planning`, thread up
to seven marker lines onto the same append channel as the inferred ultimate
goal — full contract for each in
[references/step3-threading.md](references/step3-threading.md); none add a
new Task-tool exemption or spawn site (all are markers on the existing
Discovery exemption, #2 in Hard rules):

- **Per-phase model (planning) threading** — append `MODEL_PLANNING: <alias>`
  when `state.modelPlanning` / `config.models.planning` resolves non-empty
  ([references/model-routing.md](references/model-routing.md)).
- **Force-on threading (mandatory)** — when `state.forceResearch == true`,
  append `RESEARCH: force-on (flow feature create --research)`.
- **Revision-pass threading (on step-3 re-entry)** — when
  `<worktree>/.flow-tmp/plan.md` already exists, append `REVISION: <n>` so
  discovery runs its Revision pass mode.
- **Epic-membership threading** — when `.epic` is set, append
  `EPIC: <slug>/<featureId> (design at .flow/epics/<slug>/design.md)`.
- **Prompt-sanity threading** — on a `suspect` step-1 verdict, append `PROMPT-SANITY: <note>`.
- **Interview threading** — when `state.interview` is non-empty, append
  `INTERVIEW: <digest>` so discovery treats the persisted intent-interview
  answers as load-bearing user clarifications (full contract:
  [references/step3-threading.md](references/step3-threading.md)).
- **Blind survey threading** — append `SURVEY: <path> (judges: …)` when
  the survey ran (full contract: [references/blind-survey.md](references/blind-survey.md)).

**Deterministic forced research (mandatory on the forced path).** The
discovery subagent's own Step 1.5 was observed to skip the fan-out even when
forced, so on the `forceResearch == true` path you MUST ALSO run the research
yourself BEFORE invoking `/flow-product-planning`: probe
`flow-module-status --check research` (non-zero ⇒ module deselected, notice
already emitted — note the skip and proceed to planning appending nothing),
then run `flow-research-run --task "<verbatim user description>" --out
"$WORKTREE/.flow-tmp/research-findings.md" --status-file
"$WORKTREE/.flow-tmp/research-status.json"`, folding non-empty findings into
the invocation through the same channel, clearly labelled `RESEARCH FINDINGS
(web-grounded, pre-run by supervisor — use as prior context, do NOT re-run
the fan-out):`. This self-degrades to a graceful skip when agy is unavailable
and NEVER blocks planning; full bash in
[references/step3-threading.md](references/step3-threading.md#deterministic-forced-research-mandatory-on-the-forced-path).

`/flow-product-planning` is a thin wrapper that spawns one **Independent
Discovery Subagent** via the Task tool (exemption #2 in "Hard rules"
above) in its own isolated context, writing the consolidated artifact to
`<worktree>/.flow-tmp/plan.md` plus a PR-description draft to
`<worktree>/.flow-tmp/pr-description-draft.md`. The wrapper creates
`.flow-tmp/` before spawning; the supervisor never sees the discovery
transcript, only the wrapper's brief return summary. Full spawn contract
in [references/exemption-contracts.md](../../../references/exemption-contracts.md); the discovery method in
`skills/pipeline/flow-product-planning/references/discovery-instructions.md`.

After the wrapper returns, **read `<worktree>/.flow-tmp/plan.md`** once
and print the plan-summary block to chat per `references/pause-output-contract.md`
— six labeled slots, no open prose, ≤12 lines, ≤2 bullets per slot
(template: `### ⏸ Plan ready for review` / `**TLDR:** <one-sentence
user-visible outcome, suffixed `(N zero-stakes questions resolved
without asking)` when N checked `**Stakes:** none` entries exist>` /
`**Unsolved:** <open answer-sheet items with their `(high)`/`(medium)`
tag and recommended default inline, anchors omitted>` / `**Needs
attention:** <high-stakes decisions read from `## Decision analysis` +
`## Architecture Decisions`, each stated as before→after (from
`## Behavioral contrast`) plus the option chosen and why, plus every
crucial-and-uncertain item (`[confidence: low]` or `**Needs user
input:**`, each carrying the stable `Q<n>` id discovery's numbering rule
assigns to both) as `Q<n> (low): <question> — default: <recommended>`
for a genuine low-confidence recommendation, or `Q<n> (needs input):
<question> — default: none` for a `**Needs user input:**` escape (which
has no `**Recommended:**` line by contract, so it is never rendered as
`(low)`), taking the ceiling first and collapsing to `+N more uncertain — plan:
<path>#Open-Questions` above two, plus one
`Method: <user's> → <chosen> (survey: <verdict>)` line when
`## Method selection` is present, plus one
`Scope: N tasks, M files` line, plus any material risk from
`## Plan risks`>` / `**Untracked:** <the candidate list, one line
each>` / `**Next action:** approve / redirect: … / cancel — plan:
<path>`). **task titles and file lists are not echoed** — the plan
file is the only place they live; the sole scale signal is the
`Scope:` line, counted from `# Task breakdown`'s `**Files:**` lines.
<!-- any new pause site below must reference pause-output-contract.md -->
This is the supervisor's single read of the plan file — the wrapper does
not pre-read it. While plan.md is open, surface any discovery research
skip-note it carries: a `> [!NOTE]` line about **Web-grounded research
(discovery Step 1.5)** being skipped, so the user sees why no research ran
and how to force it (`flow feature create --research`). Reuse this
read — do **not** open plan.md a second time.

**Deterministic note backstop (mandatory, non-skippable).** The discovery
subagent's `> [!NOTE]` is best-effort and has been observed to be skipped, so
after the plan.md read ALWAYS run `flow-research-note ensure --plan-file
"$WORKTREE/.flow-tmp/plan.md" --forced "$(jq -r '.forceResearch // false'
~/.flow/state/<slug>.json)"` (idempotent; self-no-ops when research ran, the
path was dormant, or a note already exists). When its stdout is non-empty,
include that line **verbatim** in the plan-summary block. Full contract in
[references/step3-threading.md](references/step3-threading.md#deterministic-note-backstop-mandatory-non-skippable).

**Follow-up-reference consistency backstop (advisory, deterministic).** After
the note backstop and BEFORE the cross-model plan review below, run
`flow-candidate-issues --lint --plan-md-file "$WORKTREE/.flow-tmp/plan.md"`
(`LINT_RC=$?`) so a plan whose prose references a follow-up missing from
`# Candidate follow-up issues` never ships silently. **Advisory and
non-blocking** — a non-zero exit surfaces a one-line note in the chat
summary, never blocks planning. Full contract in
[references/step3-threading.md](references/step3-threading.md#follow-up-reference-consistency-backstop-advisory-deterministic).

**Plan-shape backstop (advisory, deterministic).** Right after the
follow-up-reference backstop above, independently lint the plan's shape via
`flow-plan-lint --plan-md-file "$WORKTREE/.flow-tmp/plan.md"` when the helper
is on `PATH` (tolerant skip otherwise) — malformed plans are named in chat
even when discovery's own self-check was skipped. **Advisory and
non-blocking**, same as above. Full contract in
[references/step3-threading.md](references/step3-threading.md#plan-shape-backstop-advisory-deterministic).

**Design-spec validation backstop (deterministic, advisory).** After the
follow-up-reference consistency backstop above and BEFORE the cross-model
plan review below, run `flow-design-spec validate` against
`.flow-tmp/design/spec.json` when present (existence-gated no-op otherwise).
On exit 1/2, capture the reason into `DESIGN_SPEC_REASON` and surface it in
both the chat summary and the awaiting-approval gate's `--why` string below
(`design spec INVALID: $DESIGN_SPEC_REASON`) — never a `NEEDS HUMAN` halt.
Full bash + worked example in
[references/step3-threading.md](references/step3-threading.md#design-spec-validation-backstop-deterministic-advisory).

**Cross-model plan review (Layer 2, optional, config-gated).** After the
note backstop above and BEFORE the End conditions branch below, run one
bounded cross-model review pass (one or two reviewers by depth) of the
plan's consequential decisions — fires for **ANY** intent, before the
feature/non-feature end-condition split. Bash `flow-delegate` (AGY) fan-out, same mechanism as
`/flow-pr-review`'s Gemini lens, spawns **no Task** (Hard rules' "Bash
fan-out, not a ninth exemption"). Three-part gate: `review.gemini == true`
in `~/.flow/config.json` (same key the Gemini lens uses), AND a non-empty
`## Decision analysis` section in plan.md, AND
`flow-module-status --check research` passing (`flow-plan-review` is a
`research` helper; the check emits its own named notice); when **any** part
fails, record the reason in the chat summary and skip this sub-step unchanged.

When all three fire, run the review through the async wake ladder below,
mirroring step 7's `flow-ci-check`/`flow-ci-wait` ladder (both new calls
are sub-second, so no explicit `timeout:` override is needed): **(1)**
foreground `flow-plan-review --start --plan-file
"$WORKTREE/.flow-tmp/plan.md" --out "$WORKTREE/.flow-tmp/plan-review.md"
--worktree "$WORKTREE"` — a `ran` field means today's gate-skip branch,
proceed straight to the branching below with no further ladder steps;
`status:"started"` (`reattached` true or false) means a worker is live, go
to (2). **(2)** foreground `flow-plan-review --check --out
"$WORKTREE/.flow-tmp/plan-review.md"` — `decided` branches on the wrapped
envelope (`.status` stripped) exactly as below; `waiting` goes to (3).
**(3)** background the waiter — `flow-spawn --class default --
flow-plan-review-wait "$WORKTREE/.flow-tmp/plan-review.md.run.json"
--max-sec 540` — its completion notification re-runs (2), never a resumed
loop. **(4)** on a missed wake: a bounded Monitor `until` loop or
`ScheduleWakeup` ending in the same `--check`; if neither fires before
turn-end, `flow-state-update --phase plan-review-pending` and re-run (2).
Branch on the `{ran}` envelope
(never the exit code): `ran:false` records `skipReason` and proceeds
unchanged. `skipReason` splits into two classes: an environment skip (e.g.
`agy-not-found`) is a genuine no-op, but `reviewer-empty` /
`reviewer-not-engaged` / `reviewer-timeout` mean the review RAN and
produced nothing usable — surface those three distinctly in the chat
summary (never folded into "agy unavailable" prose), naming
`partialArtifactPath`/`stderrTail` when present. The other two terminal
skips are `review-timed-out` (`--check`'s give-up cap fired) and
`reviewer-worker-died` (detached worker vanished, no result); both differ
from `reviewer-timeout`, where the envelope survived one killed agy call.
`ran:true` weighs each
material AGY point as INPUT (never a verdict), revises plan.md **once**
where warranted, and appends a `### Cross-model review (AGY)` subsection
recording each point **accepted** or **overridden** — also record the
run's `depth` and, per reviewer, `model`/`ran`/`skipReason`/`lensesEngaged`
(as N/6) in the chat summary; a demoted reviewer also carries a one-liner
into the awaiting-approval gate's `--why` string, same precedent as
`design spec INVALID` above. **Convergence rule (deep tier):** applies
ONLY when `reviewers[]` holds exactly two `ran:true` entries — a point
BOTH raised independently is **presumptively accepted**, overriding it
needs a named rationale in that subsection; otherwise (any reviewer
demoted/skipped) every point stays single-reviewer INPUT, same as today.
Then embed the marker hash — run `flow-plan-review --print-hash --plan-file
"$WORKTREE/.flow-tmp/plan.md"` on the FINAL revised plan (never the
pre-revision envelope hash, which would falsely re-fire the next pass) and
embed its stdout as `<!-- flow-plan-review-hash: <sha> -->` inside the
appended subsection.

This is a **bounded single-pass per step-3 pass** — at most one review
and one revision, not an unbounded loop. On re-entry the helper re-fires
ONLY when one of the THREE hashed inputs — the `**Goal:**` line,
`## Decision analysis`, or `## Cut list` — materially changed since the
last reviewed revision, emitting `{ran:false,
skipReason:"decision-analysis-unchanged"}` on a hash match; record that
skip as a one-line chat-summary rationale and never hand-force a
re-review. Full mechanics (the hash-embedding footgun, the
normalized-diff re-fire detection) in
[references/step3-threading.md](references/step3-threading.md#cross-model-plan-review-layer-2--re-fire-hashing-detail).

**End conditions:**

Before branching on intent, check `.flow-tmp/plan.md` for a
prompt-vs-target tension flag and the blind survey's verdict via the
`flow-step3-route` helper. This runs for EVERY intent, not just
non-feature — without hoisting it above the split, a `converge-against`
survey verdict would pause a non-feature pipeline but silently skip the
pause for a feature-intent one, the exact prompt-vs-target-tension gap
the AGENTS.md `## Output style` rule **Treat user prompts as evidence of
intent, not exhaustive specifications.** exists to close:

```bash
METHOD_RESOLVED=$([ -f "$WORKTREE/.flow-tmp/method-resolved" ] && echo 1)
ROUTE=$(flow-step3-route --intent "$INTENT" --plan-md-file "$WORKTREE/.flow-tmp/plan.md" ${METHOD_RESOLVED:+--method-resolved})
```

The helper at `bin/flow-step3-route.ts` returns one of three decisions.
The four-cell Prompt-Interpretation matrix it implements (feature/non-feature
× Prompt-Interpretation absent/`methods plausibly reach target`/any other
Recommended path) is documented at
`skills/pipeline/flow-product-planning/references/discovery-instructions.md`
"Prompt interpretation (conditional)" — the four enum values live there
only and the helper exact-matches against them. The blind survey's
`## Method selection` verdict adds a second axis — full precedence in
[references/blind-survey.md](references/blind-survey.md).

- **`$ROUTE` is `pause-for-method`** (either intent) → both judges ran
  and independently recommended a method materially different from the
  user's (`- **Survey verdict:** converge-against`), unresolved this
  pipeline. Write the question to `.flow-tmp/interview-questions.md`,
  persist via `flow-state-update --phase plan-pending-interview
  --interview-stdin`,
  <!-- any new pause site below must reference pause-output-contract.md -->
  render the `### ❓ Both blind judges recommend a different method`
  template per `references/pause-output-contract.md`, end the turn. On
  reply: `--phase planning --interview-stdin`, `touch "$WORKTREE/.flow-tmp/method-resolved"`
  (marker `$METHOD_RESOLVED` derives from), then re-run the route block above
  (keep-mine: one `REVISION:` pass first). Full protocol in
  [references/blind-survey.md](references/blind-survey.md) "The method pause".

- `$ROUTE` is `route-to-step-4` and intent is `feature` → write `phase: plan-pending-review`. Then,
  immediately before ending the turn:

  **Candidate follow-up issues disclosure.** Discovery lists
  follow-up candidates in the plan, ticked (`- [x]`) only when their
  value-prop block clears the bar, in `# Candidate follow-up issues` —
  see
  `skills/pipeline/flow-product-planning/references/discovery-instructions.md`,
  so there is no separate curation form here; the plan-review checkpoint
  below IS the curation checkpoint. Run `flow-candidate-issues
  --plan-md-file "$WORKTREE/.flow-tmp/plan.md" --details` and, when its
  output is non-empty, echo its output VERBATIM as assistant prose
  before the AWAITING APPROVAL block — same discipline as the
  Gate-stage echo-verbatim recap, never compose the ranked block from
  the `.json` fields by hand. Document the reply verbs available at
  `plan-pending-review` in that same message: `pull #N into the plan`
  (fold candidate #N's text into the plan, ticked or not — an
  Imperative scope/plan redirect back to step 3), `drop candidate #N`
  (mechanical: `flow-candidate-issues --plan-md-file
  "$WORKTREE/.flow-tmp/plan.md" --untick <N>`, confirm in one line,
  stay at `plan-pending-review`), `drop all candidates` (same
  mechanical untick, bulk form — read `flow-candidate-issues
  --plan-md-file "$WORKTREE/.flow-tmp/plan.md" --json` and pass every
  1-based index whose `.candidates[].ticked` is `true` to a single
  `--untick <indices>` call), `file candidate #N` (mechanical:
  `flow-candidate-issues --plan-md-file "$WORKTREE/.flow-tmp/plan.md"
  --tick <N>`, confirm in one line, stay at `plan-pending-review`), and
  `defer task #N` (one or many task
  numbers in one reply — batches ALL of them
  into ONE bounded revision pass back to step 3; see step 4's redirect
  classification below and `references/redirect-handling.md`).

  **Answer sheet (unresolved plan questions).** When `plan.md` still
  carries unresolved `**Needs user input:**` items and/or `## Decision
  analysis` forks the interview (or discovery) left open, render them
  as a numbered answer sheet ABOVE the AWAITING APPROVAL block — stable
  `Q<n>` ids, one line each naming the open item and, where discovery
  recorded one, its recommended resolution. Document the `answer:
  <sheet>` reply verb in the same message (e.g. `answer: 1a 2: use the
  existing retry pattern`) — step 4 classifies it as ONE batched
  Imperative scope/plan revision redirect back to step 3 (see
  `references/redirect-handling.md`), the same disposition as `pull #N
  into the plan` above, never as a fresh interview round. Items render
  escaped and `[confidence: low]` first, then `medium`, then `high` —
  `Q<n>` ids are untouched by this display order. A missing
  `[confidence: …]` tag or missing `**Stakes:**` line (a pre-change
  `plan.md` on resume) reads as `medium`, is never promoted, and never
  errors.

  **Untracked items at plan-pending-review.** When the `**Untracked:**`
  slot lists items carried over from a prior pipeline run of this same
  slug (rare — usually empty this early), document `file #N` (calls
  `flow-untracked file <N>`, mechanical, one-line confirmation, stays
  at `plan-pending-review`) and `drop #N` (`flow-untracked drop <N>`,
  same discipline) as additional reply verbs in the same message —
  distinct from `pull #N into the plan` / `drop candidate #N` above,
  which act on plan.md's own candidate list, not the untracked list.

  Then render the AWAITING APPROVAL block via `flow-gate-summary` so
  the header rows precede the two markdown bullets the user clicks:

  ```bash
  WHY="plan ready for review (intent=feature)"
  [ "$SPEC_RC" != "0" ] && WHY="$WHY; design spec INVALID: $DESIGN_SPEC_REASON"
  LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)
  TLDR="<one sentence, ≤25 words, the plan's outcome for the reader>"
  flow-gate-summary --status awaiting-approval --echo-prose \
    --why "$WHY" \
    --worktree "$WORKTREE" \
    --plan-file "$WORKTREE/.flow-tmp/plan.md" \
    --lens "$LENS" \
    --tldr "$TLDR" \
    --untracked-file <(flow-untracked render --format gate --unfiled-only)
  ```

  Then echo the recap per [Gate-stage echo-verbatim
  recap](#gate-stage-echo-verbatim-recap---echo-prose). At AWAITING
  APPROVAL no reviewable artifact exists yet, so `flow-gate-summary
  --echo-prose` renders only the plan-file bullet — every other field
  (PR URL, review/CI/count) is the literal `none`.

  The helper renders two markdown bullets as the **last** lines of
  the message — the worktree absolute path first, the plan file's
  absolute path (`$WORKTREE/.flow-tmp/plan.md`) second. **No
  trailing punctuation on either bullet line, and no prose after
  them** — most terminals greedily extend URL auto-detection through
  trailing dots (and other adjacent punctuation) and break the click
  target. Rendered example:

  ```
  STATUS: AWAITING APPROVAL
  WHY: plan ready for review (intent=feature)
  NEXT ACTION: reply approve / redirect <new direction> / cancel
    - /Users/you/code/me/flow-my-feature
    - /Users/you/code/me/flow-my-feature/.flow-tmp/plan.md
  ```

  **Plan-review clear point (auto-checkpoint arm).** After writing
  `phase: plan-pending-review` and before ending the turn, arm a
  lightweight checkpoint so the user can `/clear` at `plan-pending-review`
  and approve on a fresh session. Run `flow-checkpoint --probe --site plan-review`,
  branch on `jq -r '.verdict'`, and only on `write` write a minimal
  one-line pointer to the path `flow-checkpoint --path` prints (a still-fresh
  manual note — `verdict: preserve` — wins and is left untouched). Then
  `flow-checkpoint --site plan-review` to arm the marker and record the freshness receipt, and add a one-line nudge: **safe to `/clear` — approve on a fresh session; the plan re-renders on resume.**
  No helper change is needed: `plan-pending-review` is non-terminal, so
  `flow-resume-decide` already resolves it to step-4 and the
  `SessionStart:clear` hook already fires on it when the marker is present.
  `flow-checkpoint --consume` in Resume mode re-injects and retires the body
  like every other resume — archiving it to `checkpoint.consumed.md` (same
  directory), clearing the receipt.

  Format the checkpoint-nudge tail per `references/pause-output-contract.md` — labeled slots, no open prose, appended under the plan-summary block's heading (template: safe to `/clear` folds into the existing `**Next action:**` line — `approve / redirect: … / cancel (safe to /clear — the plan re-renders on resume)`).
  <!-- any new pause site below must reference pause-output-contract.md -->

  Then end the turn. Wait for the user to attach and respond.
  The next turn re-enters at step 4.
- `$ROUTE` is `advance-to-step-5` or `route-to-step-4` and intent is
  non-feature (`bug`/`refactor`/`docs`/`infra`/`chore`) → `$ROUTE` was
  already computed above (either intent shares one `flow-step3-route`
  call); this is the structural enforcement for the AGENTS.md `## Output
  style` rule **Treat user prompts as evidence of intent, not
  exhaustive specifications.** for non-feature intents — without this
  check, a non-feature prompt that names BOTH prescribed methods AND a
  quantitative target would silently run to merge with no user
  checkpoint, even when discovery flagged that the methods can't reach
  the target.

  - **`advance-to-step-5`** → no `## Prompt interpretation` section OR
    Recommended path `methods plausibly reach target`, AND (no survey
    ran OR verdict `converge-with` OR a resolved `converge-against`).
    The plan still exists on disk for traceability, but the
    user wasn't asked to ratify it — fall through to step 5 directly in
    the same turn, no candidate-issues checkpoint fires here (there is
    no turn-ending message to attach one to on this fully-autonomous
    path). **Disclosure obligation:** any bundled tasks and ticked
    (bar-clearing) `# Candidate follow-up issues` items proceed exactly as
    discovery authored them; disclose them in the PR body's `Bundled:` Key
    decisions bullets and in the terminal recap, so the user still sees
    what shipped even though nothing paused for their review.

  - **`route-to-step-4`** → the section is present and the
    Recommended path is one of `extend scope with named additional
    safe steps` / `relax target` / `split into multiple pipelines`, OR
    the survey ran and the verdict is `split`.
    Write `phase: plan-pending-review`. Then, same as the feature-intent
    End condition above, run `flow-candidate-issues --plan-md-file
    "$WORKTREE/.flow-tmp/plan.md" --details` and, when its output is
    non-empty, echo its output VERBATIM as assistant prose immediately
    before the AWAITING APPROVAL block, with the same reply-verb
    documentation (`pull #N into the plan`, `drop candidate #N`, `drop
    all candidates`, `file candidate #N`, `defer task #N`) — this branch
    also lands in step 4, so the user needs the same curation surface.
    Then render the
    AWAITING APPROVAL block via `flow-gate-summary` — same call shape
    as the feature-intent branch above, but with a Why string that
    names the tension flag (and, on `split`, the survey verdict —
    `flow-gate-summary` never parses plan sections, so this is the
    `Method:` line's only channel here):

    ```bash
    SURVEY_VERDICT=$(sed -n 's/^- \*\*Survey verdict:\*\* *//p' "$WORKTREE/.flow-tmp/plan.md" | head -1)  # colon form only; flow-step3-route.ts (authoritative) also tolerates drift; display only
    USER_METHOD=$(sed -n "s/^- \*\*User's method:\*\* *//p" "$WORKTREE/.flow-tmp/plan.md" | head -1)
    CHOSEN_METHOD=$(sed -n 's/^- \*\*Chosen method:\*\* *//p' "$WORKTREE/.flow-tmp/plan.md" | head -1)
    WHY="plan ready for review (intent=$INTENT, prompt-interpretation tension)"
    [ -n "$SURVEY_VERDICT" ] && WHY="$WHY; Method: $USER_METHOD -> $CHOSEN_METHOD (survey: $SURVEY_VERDICT)"
    [ "$SPEC_RC" != "0" ] && WHY="$WHY; design spec INVALID: $DESIGN_SPEC_REASON"
    LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)
    TLDR="<one sentence, ≤25 words, the plan's outcome for the reader>"
    flow-gate-summary --status awaiting-approval --echo-prose \
      --why "$WHY" \
      --worktree "$WORKTREE" \
      --plan-file "$WORKTREE/.flow-tmp/plan.md" \
      --lens "$LENS" \
      --tldr "$TLDR" \
      --untracked-file <(flow-untracked render --format gate --unfiled-only)
    ```

    Then echo the recap per [Gate-stage echo-verbatim
    recap](#gate-stage-echo-verbatim-recap---echo-prose).

    Then end the turn. The next turn re-enters at step 4 with the
    same affirmative/redirect/cancel/ambiguous branches as the
    feature-intent path. The `plan-pending-review` phase value is
    reused (no new phase string is introduced); `flow-stop-guard`
    and `flow-resume-decide` both already handle this phase
    unchanged for non-feature intents. Arm the same **plan-review clear
    point** here (probe + arm `--site plan-review`) as the feature-intent
    End condition above, so a `/clear` at `plan-pending-review` on a
    route-to-step-4 non-feature pipeline also auto-resumes to the plan
    render.

**Question-gate branch.** When `/flow-product-planning` doesn't write
`.flow-tmp/plan.md`, first check whether it wrote
`.flow-tmp/interview-questions.md` instead — discovery's own strict
question-gate (`skills/pipeline/flow-product-planning/references/discovery-instructions.md`
§ question-gate contract) can pause mid-run when every viable plan
branch is invalidated by an unanswered fork. On that signal:

1. Write `flow-state-update --phase plan-pending-interview`.
2. Render the battery from `.flow-tmp/interview-questions.md` inside
   the `references/pause-output-contract.md` slot shape (the same
   template as the step-1 interview — see
   `references/interview-playbook.md` `## 8`).
   <!-- any new pause site below must reference pause-output-contract.md -->
3. End the turn.
4. On the next turn, BEFORE re-invoking `/flow-product-planning`,
   persist the post-gate digest — the union of the question-gate
   battery's questions/answers and any existing triage digest from
   `state.interview` — via `flow-state-update --phase planning
   --interview-stdin` (see the playbook's `## 7. Persistence contract`;
   the write REPLACES the prior digest with the full interview-to-date).
   This is what moves the phase off `plan-pending-interview` and makes
   the answers survive a crash between this write and discovery's
   post-answer re-run finishing. Then re-invoke `/flow-product-planning`
   appending `INTERVIEW ANSWERS (post-discovery): <answers>` onto the
   same threading channel as `## Invocation threading` above, so
   discovery resumes with the answers as load-bearing context instead
   of re-deriving the plan from scratch.

**At most one question-gate fire per pipeline.** If `.flow-tmp/plan.md`
is still absent after the post-answer re-invocation (a second
`interview-questions.md` write), do NOT loop a second gate round —
escalate `NEEDS HUMAN: interview-loop` instead. Scoped per-source: the
method pause's supervisor-side write of `plan-pending-interview` is a
distinct source and never counts toward this escalation.

If `/flow-product-planning` doesn't write `.flow-tmp/plan.md` AND does
NOT write `.flow-tmp/interview-questions.md` either — a genuine
plan-missing failure, not the question gate — re-invoke once with an
explicit instruction to write the consolidated artifact. If the second
attempt also fails, escalate `NEEDS HUMAN: plan-missing`.

## Step 4 — Approval handling

**Phase:** `plan-pending-review` (set by step 3 for feature intent)

This step runs only when the next turn arrives — i.e. when the user
typed something into the tmux chat. Classify the input using
`references/redirect-handling.md`:

- **Affirmative** ("approved", "looks good", "go ahead", etc.) →
  proceed straight to the auto-checkpoint sub-step below, which ends
  the turn at `checkpoint-pending-clear`; the user resumes into step 5
  by typing `continue` (same session) or `/clear` (fresh, auto-resumed
  session). Bundled tasks and ticked candidates proceed exactly as
  authored — the user had the full `--details` disclosure (step 3's End
  condition above) in front of them before replying Affirmative.
- **Candidate curation reply** (`drop candidate #N`, `drop all
  candidates`, `file candidate #N`) → **mechanical, not a redirect and
  not a revision pass.** Run `flow-candidate-issues --plan-md-file
  "$WORKTREE/.flow-tmp/plan.md" --untick <N>` (single index) or
  `--untick <every currently-ticked index>` (bulk `drop all candidates`
  form) — or `--tick <N>` for `file candidate #N`, the mirror of drop —
  confirm the change in one line, and stay at
  `plan-pending-review` awaiting the user's next reply (approve /
  redirect / cancel). Full classifier detail in
  `references/redirect-handling.md`.
- **Imperative redirect** ("actually, also handle TSV"; "redo with
  X") → loop back to step 3, appending the redirect to the
  `/flow-product-planning` prompt as `USER REDIRECT (received during
  plan-pending-review): <verbatim>`. Two named redirect shapes carry
  extra handling:
  - `pull #N into the plan` → fold candidate #N's text into the plan
    body as the redirect payload; on re-entry the `--details` echo
    (step 3's End condition above) RE-FIRES over the full candidate
    list (`renderDetails` prints every candidate, grouped by state, not
    only unticked ones), so pulling one never silently drops the
    others.
  - `defer task #N` (one or many task numbers in a single reply, e.g.
    `defer tasks #2 and #4`) → batch ALL deferred targets into ONE
    `USER REDIRECT: defer task(s) <N[, M...]> (<titles>) to follow-up
    issues` loop back to step 3 with the `REVISION: <n>` marker (same
    re-entry mechanics as any other Imperative redirect). **Defer-
    revision drift guard:** the redirect text MUST scope the resulting
    revision pass to exactly four surgical edits — remove the deferred
    task(s), renumber/repair the dependency table, update the Skills
    Summary if a removed task was its only user of a named skill, and
    append the item as a ticked candidate with a matching ranking-table
    row and a value-prop block whose Problem anchor is the user's
    `defer task #N` instruction — every other section of plan.md is
    preserved byte-for-byte. **Batched-defer corruption guard:** step 3's
    existing deterministic backstops (`flow-plan-lint`,
    `flow-candidate-issues --lint`) already re-validate the revised
    plan's structure on re-entry, so this drift guard adds zero new
    machinery.
- **Cancel** ("cancel", "abort") → run `flow-remove-worktree
  <slug>`, run
  `flow-browser-teardown --reap --record` (registry-driven; records
  outcome in state.json, always exits 0) as a standalone step, then
  render the CANCELLED block via `TLDR="Cancelled at your request before
  any code was written." LENS=$(jq -r '.output.lens // "pm"'
  ~/.flow/config.json 2>/dev/null) flow-gate-summary --status cancelled
  --cleanup --why "user cancelled at plan-pending-review" --tldr "$TLDR"
  --lens "$LENS"` — which records `phase: cancelled` itself, after the
  block reaches stdout (`checkWorktreeBranch` no-ops gracefully against the
  already-deleted worktree, so the earlier `flow-remove-worktree` does not
  block the finalize). End.
- **Ambiguous** → write `flow-state-update --phase
  approval-pending-clarification`, then ask the single clarifying
  question and end the turn. The next turn re-enters step 4 with
  the user's reply. If the answer is still unclear, escalate
  `NEEDS HUMAN: approval-ambiguous` via `flow-gate-summary --status
  needs-human` (which records `phase: needs-human` itself). Format this reply per `references/pause-output-contract.md` — labeled slots, no open prose (template: `### ❓ Clarification needed` / `**Needs attention:** <the ambiguous reply, quoted>` / `**Next action:** approve / redirect: … / cancel`).
  <!-- any new pause site below must reference pause-output-contract.md -->

### Auto-checkpoint sub-step

Runs on the **Affirmative** branch, as the last thing step 4 does before
ending the turn. This is the sub-step the forward-reference above
("proceed straight to the auto-checkpoint sub-step below") resolves to.
It is the approval → implement clear point: it flushes the load-bearing
approval state so the user can `/clear` here and resume into step 5 on
a fresh, low-context session.

1. **Flush approval state to `checkpoint.md` (non-clobbering).** Write it at
   the path `flow-checkpoint --path` prints. Probe with
   `flow-checkpoint --probe --site plan-approval`; only on a `write` verdict
   (a still-fresh manual note reads `preserve` and wins, left untouched)
   write the load-bearing conversational state the fresh process would
   otherwise drop: the approval verdict plus any addenda or conditions the
   user attached (e.g. an "approved with A1" note, a folded-in scope change,
   an "ignore flake X" decision). Unlike the gate auto-checkpoint (near-zero
   residue), this one genuinely flushes approval state, so it uses the fuller
   `/flow-checkpoint`-style flush.
2. **Arm the one-shot marker:** `flow-checkpoint --site plan-approval`
   (validates `checkpoint.md`, writes the `checkpoint.pending` marker on
   a ready verdict, and records the freshness receipt for this site).
3. **Advance the phase:** `flow-state-update --phase checkpoint-pending-clear`.
4. **Nudge and end.** Tell the user: safe to `/clear` — the pipeline
   resumes into step 5 on a fresh session, or type `continue` to proceed
   in this session. Then end the turn.

On resume, Resume mode re-injects `checkpoint.md` and runs
`flow-checkpoint --consume`; `flow-resume-decide` resolves
`checkpoint-pending-clear` → step-5, so the fresh session re-enters at
implement with the approval addenda folded in (no helper change needed —
it's a non-terminal phase the resume + hook machinery already handles).

## Step 5 — Implement

**Phase:** `implementing`

Emitted by `flow-open-pr` as a side effect of returning the value this
step branches on ($PR_URL); there is no separate phase-write command.

Invoke `/flow-new-feature` in-process. On the first entry to this step,
pass the user's request plus the approved plan's path:

```
/flow-new-feature <verbatim user description>
PLAN: $WORKTREE/.flow-tmp/plan.md
```

The `PLAN:` line (same append convention as the `mode:fix` /
`PRIOR FAILURE LOG:` re-entry below) is appended on every first-entry
invocation when `.flow-tmp/plan.md` exists — feature and non-feature
intents alike, since discovery's Contract block is required on every
task regardless of intent and step 3's non-feature `advance-to-step-5`
branch already keeps plan.md on disk for traceability. It hands
`/flow-new-feature` the approved plan so its scout verifies the plan's Task
breakdown contracts against the code instead of re-deriving them, and
its edit-set composition inherits the per-task Contract blocks.
`/flow-new-feature` tolerates plan absence — a missing file or a plan with
no heading matching `Task breakdown` leaves its behaviour exactly as it
is without the line — and `mode:fix` re-entries do NOT carry the
`PLAN:` line.

`/flow-new-feature` is itself a thin wrapper that spawns one **Independent
Scout Subagent** via the Task tool (the third of the eight named
Task-tool exemptions in "Hard rules" above) on its wider-scope path.
The subagent reads the codebase in its isolated context — affected
modules, relevant tests, public API surface, anti-patterns / off-limits
surfaces — and writes the consolidated artifact to
`<worktree>/.flow-tmp/scout.md`. The wrapper creates `.flow-tmp/`
before spawning so the subagent can write directly. The supervisor
never sees the scouting transcript, only the wrapper's brief return
summary. Trivially scoped features (≤3 affected files) skip the
subagent via the wrapper's hybrid threshold and proceed inline.

If `/flow-new-feature` took the wider-scope path and `.flow-tmp/scout.md`
is missing after the call returns, re-invoke `/flow-new-feature` once with
an explicit instruction to spawn the scout and write the artifact
(this counts as a fresh `/flow-new-feature` invocation with its own
one-shot Task call, per the wrapper's "exactly one Task-tool call per
invocation" constraint). If the second attempt also fails, escalate
`NEEDS HUMAN: scout-missing`. Same retry-once-then-escalate semantics
as step 3's `plan-missing` handling for `/flow-product-planning`.

The skill writes code + tests, runs verify internally as a
pre-commit gate, commits, and pushes. **Opening the PR is the
supervisor's job, not the implement skill's** — the supervisor calls
`flow-open-pr` so the PR number lands in state.json atomically.

**Discharging the `advance-to-step-5` disclosure obligation:** if step 3
took the `advance-to-step-5` route (see "Step 3 — Product planning" End
condition above), the PR body's Key decisions section MUST include a
`Bundled:` bullet naming any task-breakdown items and ticked (bar-clearing)
`# Candidate follow-up issues` items discovery authored without a
plan-review checkpoint — this is where that obligation gets discharged,
not just asserted.

Write the PR body to the worktree's scratch dir, then call
`flow-open-pr` once and capture both the URL (from stdout) and the
PR number (from the state.json the helper just wrote):

```bash
mkdir -p "$WORKTREE/.flow-tmp"
# Compose the PR body (typically copied from .flow-tmp/pr-description-draft.md
# that /flow-new-feature wrote, then templated with the final commit list). Both
# the source draft and the rendered body live under .flow-tmp/ so the
# worktree root stays clean for the post-merge git worktree remove.
PR_URL=$(flow-open-pr \
  --body-file "$WORKTREE/.flow-tmp/pr-body.md" \
  --title "<conventional-commit summary>")
# Read the PR number back. `~/.flow/state/<slug>.json` is keyed by slug.
SLUG="$FLOW_SLUG"
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

The phase write is a side effect of `flow-open-pr` — it advances
`phase` to `implementing` as it records `pr`, so obtaining `$PR_URL`
and recording the phase are the same action. Do not write it
separately.

**Re-entry from a fix loop** (called from step 7 ci-red or step 8
review-critical): pass mode=fix and the failure log:

```
/flow-new-feature mode:fix
PRIOR FAILURE LOG:
<truncated log>
```

`/flow-new-feature` knows to make a focused fix commit on the existing
branch and push, without opening a new PR. After re-entry, return
to step 7 (CI wait), **not** directly to step 8 — a fix can break
CI just as easily as it can resolve a review finding.

**End condition:** `$PR` is set; the branch has been pushed.

On non-zero exit without a PR: retry once with the failure context
appended. If the retry also fails, escalate `NEEDS HUMAN:
implement-failed`.

## Step 5.5 — Re-symlink if worktree adds skills/agents

**Phase:** `installing-skills`

Sub-skills loaded by the supervisor in steps 6–8 (`/flow-verify`,
`/flow-pr-review`) are read from `~/.flow/claude-home/.claude/skills/`
(loaded into the supervisor session via the seed session's
`--add-dir ~/.flow/claude-home`), and agents from the same tree, nested
inside each artifact's owning module's plugin root
(`~/.flow/claude-home/.claude/skills/flow-module-<id>/agents/`)
— both populated by `flow install` (and `flow install --upgrade`) via symlink.
A worktree that adds new files under `skills/` or `agents/` in step 5
does not get those files symlinked automatically; the same supervisor
session cannot use them downstream until `flow install --upgrade` runs.
This step closes that gap. Note that a skill ADDED into the already-existing
claude-home skills dir hot-reloads into the running session (Claude Code's
live change detection), and the non-interactive `flow install --upgrade`
below now preserves the existing installed breadth via the install manifest
(gh#435) rather than collapsing to core — the invocation itself is unchanged.

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

ADDED=$(git diff --name-only --diff-filter=A "origin/$DEFAULT_BRANCH...HEAD" | \
          grep -E '^(skills|agents)/' || true)

if [ -n "$ADDED" ]; then
  echo "Detected new skill/agent files; re-symlinking:"
  echo "$ADDED" | sed 's/^/  /'
  flow install --upgrade --source "$WORKTREE"
  # Register a post-merge follow-up so the user's home install also gets
  # re-symlinked against the canonical (post-merge) main, not just this
  # supervisor's in-flight worktree. `--auto` plus the `flow install --upgrade`
  # allowlist entry means step 11 runs it automatically on the MERGED path.
  flow-followups add \
    --command "flow install --upgrade" \
    --reason "new skills/agents added on this branch — re-symlink home install post-merge" \
    --auto \
    --registered-by "flow-pipeline:step-5.5"
else
  echo "No skill/agent additions; skipping re-symlink."
fi
```

The detection grep uses `--name-only --diff-filter=A` and the triple-dot
range so only genuine file *additions* under `skills/`/`agents/` trigger a
re-symlink (modifications/deletions do not); the default-branch resolution
mirrors `bin/flow-new-worktree.ts` / `bin/flow-pre-commit.ts` — do not
hardcode `origin/main`.

`--source "$WORKTREE"` forces `flow install` to read its content tree from
the in-flight worktree (so a flow-self PR adding a skill sees the new files
this session); for non-flow repos the worktree has no `skills/`/`agents/`
tree, so the detection guard above keeps this branch from running. The
override swaps only the **content source** — the **recorded owner** in
`~/.flow/installed.json` stays on the canonical install root via
`resolveFlowSource()`, so a worktree's post-merge removal can't strand
manifest entries, and dangling symlinks from past `--source` runs get
reaped on the next `flow install --upgrade`.

**Concurrency.** `flow install` wraps its symlink work in
`~/.flow/setup.lock` (`bin/lib/lock.ts`), so parallel pipelines that
both add skills/agents serialise here rather than racing on
`~/.flow/claude-home/.claude/skills/` (skills and agents both, each
nested under its owning module's plugin root). Do not add an ad-hoc
lock at this call site.

**End condition:** the helper exits 0. On non-zero exit (the verb
maps `summary.blocked > 0` to exit 1; parser errors map to 2):
retry once. If the retry also fails, escalate
`NEEDS HUMAN: flow-setup-upgrade-failed <stderr>` — the supervisor
cannot safely continue to step 6 without the new skill/agent files
visible.

## Step 6 — Local verify

**Phase:** `verifying`

Write the phase explicitly before invoking verify:

```bash
flow-state-update --phase verifying --slug "$SLUG"
```

The verify work runs **inline** now — the supervisor invokes `/flow-verify`
in-process via the Skill tool and observes its output directly in its own
context (no subagent isolation, no separate artifact). The supervisor owns
the **3-outer-attempt cap**: `/flow-verify` self-loops internally against
`flow-pre-commit --json` until it reports a clean pass or gives up, and the
supervisor re-invokes `/flow-verify` at most 3 times total when an attempt
does not end clean. Each re-invocation observes the worktree fresh (it
re-runs `flow-pre-commit --json` itself), so a re-invocation is idempotent.

**Automated UI-smoke pass.** `/flow-verify` Step 1 already runs the
browser-driven UI-smoke pass inline (when the diff touches a meaningful UI
surface and the `chrome-devtools` MCP is present), following
[references/ui-smoke-pass.md](references/ui-smoke-pass.md), and reports the
outcome — passed / skipped (with a reason) / not-applicable — as part of
its own turn output. Because `/flow-verify` now runs in-process, that
report is directly visible to the supervisor; there is no separate
artifact to read it from. When `/flow-verify`'s report shows the UI-smoke
pass was skipped on a UI-touching diff, upsert a user-visible sibling line
under the PR body's `> [!CAUTION]` verify block (idempotent, edit-in-place,
do not stack) using the reason `/flow-verify` reported:

```bash
gh pr view "$PR" --json body --jq '.body' > "$WORKTREE/.flow-tmp/body.md"
# upsert the sibling line "> [!NOTE] UI changed; browser validation did
# not run — <reason>" under ## Test Steps, then
flow-md-validate --fix-pr-body "$WORKTREE/.flow-tmp/body.md" && gh pr edit "$PR" --body-file "$WORKTREE/.flow-tmp/body.md"
```

Also echo the same line to the user in-session (a plain assistant-message
line, not only the PR-body upsert above) so the gap is visible without
opening the PR.

**Surface UI screenshots.** When `/flow-verify`'s UI-smoke pass captured
screenshots, it names their absolute paths directly in its own report
(sourced from `flow-ui-validate --captures`' `evidence_paths[]`) — print
each surviving path bare, one per line, no bullet marker, no trailing
punctuation (trailing punctuation breaks the terminal's click-target
auto-detection), all of them, no cap.

**Layer-3 proactive config-authoring branch.** `/flow-verify` owns this
directly (see `skills/pipeline/flow-verify/SKILL.md`): when
`flow-pre-commit --json` returns `reason: "unmatched-files"`, it calls the
pure `draftConfigEntryForOrphans` helper (`bin/lib/monorepo-scopes.ts`)
before treating the orphan as a failure, and commits a matched entry to
`.flow/pre-commit.json`. A config-authoring re-run does not consume an
outer attempt.

**Exhaustion.** After 3 failed outer attempts, escalate `NEEDS HUMAN:
verify-exhausted`. `$FINAL_FAILURE_EXCERPT` is the third attempt's
`flow-pre-commit --json` failure excerpt as `/flow-verify` reported it in
its own turn output (there is no separate artifact to read it from — copy
it directly from the visible report). Surface that excerpt on the PR
body's `## Test Steps` section as a `> [!CAUTION]` block (idempotent —
edit-in-place, do not stack), then follow the standard `# Failure paths`
escalation:

```bash
mkdir -p "$WORKTREE/.flow-tmp"
printf '%s\n' "$FINAL_FAILURE_EXCERPT" > "$WORKTREE/.flow-tmp/verify-caution.txt"
gh pr view "$PR" --json body --jq '.body' > "$WORKTREE/.flow-tmp/body.md"
# upsert the > [!CAUTION] block (built from verify-caution.txt) under
# ## Test Steps, then
flow-md-validate --fix-pr-body "$WORKTREE/.flow-tmp/body.md" && gh pr edit "$PR" --body-file "$WORKTREE/.flow-tmp/body.md"
```

**Re-entry / resume.** Phase stays `verifying` and the resume `step-6` row
re-enters here and re-invokes `/flow-verify` inline (it observes the
worktree fresh, so a re-invocation is idempotent). `/flow-verify`'s own
Step 3 hybrid threshold still decides narrow-inline vs.
`/flow-coder`-delegated fixes (the sixth named Task-tool exemption); the
work now happens directly in the supervisor's own context — there is no
longer a diff-bytes isolation boundary to preserve at this step.

**End condition:** `/flow-verify` reports a clean pass. Continue to step 7.

## Step 7 — CI + Copilot wait

**Phase:** `ci-wait`

Emitted by `flow-ci-check` as a side effect of returning the value
this step branches on (`.decision`); there is no separate phase-write
command.

**Copilot-module precheck (before any of this).** Probe
`flow-module-status --check copilot >/dev/null 2>&1` — non-zero means the
`copilot` module is deselected (`flow-request-copilot` never on PATH): skip
the request/classify subsection below (PR treated as declined), note the
skip quietly, and invoke `flow-ci-check` below with `--copilot-not-requested`
(its self-guard prints the one user-facing notice — hence the discarded
stderr). Full rationale in
[references/polling-protocol.md](references/polling-protocol.md#copilot-module-precheck).

**Copilot request decision (before the wait).** Copilot review is opt-in
for non-trivial changes only; decide *before* invoking `flow-ci-check`, so a
declined PR can collapse the bot wait. The decision combines the
per-pipeline `copilotReview` override (from state.json) with
`flow-request-copilot`'s deterministic glob classifier:

```bash
OVERRIDE=$(jq -r '.copilotReview // "auto"' ~/.flow/state/"$SLUG".json)
GLOB_CLASS=$(gh pr diff "$PR" --name-only | flow-request-copilot --classify)
```

Branch on `$GLOB_CLASS`:

- `always-review` / `never-alone` — the classifier is decisive; the
  supervisor does **NOT** judge. (`always-review` → request;
  `never-alone` → decline, unless `$OVERRIDE` is `always`.)
- `ambiguous` — the supervisor makes its own **inline** trivial /
  non-trivial judgment against the rubric *"would a reviewer plausibly
  catch a bug here that CI and the author would miss?"* — with **NO
  `claude -p` subprocess and NO Task spawn** (the load-bearing
  no-nested-LLM constraint). When uncertain, **fail open** to
  requesting. Set `DECISION=non-trivial` (request) or `DECISION=trivial`
  (decline).

Then fire the helper's request mode (it owns the `requested_reviewers`
POST + the queued-verification re-read):

```bash
DECISION_ARG=""    # set to "--decision non-trivial" or "--decision trivial" only for the ambiguous branch
VERDICT=$(gh pr diff "$PR" --name-only \
  | flow-request-copilot --pr "$PR" --override "$OVERRIDE" $DECISION_ARG)
REQUESTED=$(printf '%s' "$VERDICT" | jq -r '.requestCopilot')
```

Two helpers split the old single-file poll loop: `flow-ci-check` is the
one-shot decider (presence checks → conflict/blocked short-circuits →
CI/Copilot/PR-state decision matrix, one fresh `gh` observation per call,
wall-clock anchors durably persisted in `~/.flow/state/<slug>.json`'s
`ciWait` record) and `flow-ci-wait` is the dumb bounded waiter (owns zero
state, zero decisions — it only sleeps). Wake precedence: the Bash
`run_in_background` completion notification on the backgrounded waiter →
a bounded Monitor `until` loop (or `ScheduleWakeup`, equivalent, when
present) → the `ci-wait-pending` yield-and-resume as the last resort —
every layer ends in the same foreground `flow-ci-check` call, so the wake
primitive never changes the verdict. Full contract in
`references/polling-protocol.md`, unit-tested at `bin/lib/ci-decision.test.ts`,
`bin/lib/ci-observe.test.ts`, `bin/flow-ci-check.test.ts`.

Append `--copilot-not-requested` to the `flow-ci-check` call only when no
Copilot review is coming — **two** signals: the request decision was to
**decline** (`$REQUESTED` is `false` — trivial PR or the
`bots.copilotSkipWait` budget short-circuit), or the verdict reports
`copilotRequestable:false` (Copilot unavailable on this repo). Read
`$REQUESTABLE` via `jq` alongside `$REQUESTED`; the verdict's `declineKind`
field (`skip-wait` vs `skip-request`) makes the decline reason
machine-checkable instead of string-sniffing `reason`.

A `requestSkipReason` (auto-review already enabled, so the helper skipped
the redundant request) **deliberately does NOT** append the flag — the
auto-review will still post, so the supervisor keeps waiting and picks it up
via the historical/author-match path. The flag hard-forces
`copilotConfigured=false`, bypassing both the in-flight `reviewRequests`
check and the historical-PR fallback; `$SKIP_REASON` is logged only, never a
driver. A forced request (`--override always`) never yields a
`requestSkipReason` — the POST always fires (the #260 fix).

**(1) Foreground decider call** — `flow-ci-check` directly, NOT backgrounded (one fresh `gh` observation completes in seconds):

```bash
VERDICT_FILE="$WORKTREE/.flow-tmp/ci-wait-result.json"
rm -f "$VERDICT_FILE"   # clear any stale verdict from a prior CI cycle
REQUESTABLE=$(printf '%s' "$VERDICT" | jq -r '.copilotRequestable // empty')
SKIP_REASON=$(printf '%s' "$VERDICT" | jq -r '.requestSkipReason // empty')  # logged only
NOT_REQUESTED_FLAG=""
# A genuine decline or unavailability collapses the wait; an auto-review skip keeps it.
[ "$REQUESTED" = "false" ] || [ "$REQUESTABLE" = "false" ] && NOT_REQUESTED_FLAG="--copilot-not-requested"
# WAIT_FLAG mirrors state.json's waitForCopilot — a per-call shell loses any prior `SLUG=...`, so re-set it from $FLOW_SLUG.
SLUG="$FLOW_SLUG"; WAIT_FLAG=""
[ "$(jq -r '.waitForCopilot // empty' ~/.flow/state/"$SLUG".json)" = "true" ] && WAIT_FLAG="--wait-for-copilot"
flow-ci-check "$PR" $NOT_REQUESTED_FLAG $WAIT_FLAG --out "$VERDICT_FILE" > "$WORKTREE/.flow-tmp/ci-check-stdout.json"
CHECK=$(cat "$WORKTREE/.flow-tmp/ci-check-stdout.json"); STATUS=$(printf '%s' "$CHECK" | jq -r '.status')
```

Branch on `.status`: **`decided`** — go straight to "Branch on `.decision`"
below (`$CHECK` already carries every `RunResult` field; `$VERDICT_FILE`
was written since the exit was decided). **`waiting`** — go to step (2).

**(2) Backgrounded waiter, primary wake** — read `nextCheckSec` (flat 60s,
`FLAT_CADENCE_SEC`) and arm the dumb waiter with `run_in_background: true`:

```bash
NEXT=$(printf '%s' "$CHECK" | jq -r '.nextCheckSec')
flow-spawn --class default -- flow-ci-wait "$PR" --min-sec "$NEXT" --max-sec 540
```

The Bash completion notification (waiter exit, up to 540s later) is the
wake: **on wake, re-run step (1)** — a fresh `flow-ci-check` call, never a
resumed loop.

**(3) Fallback ladder**, only when the primary wake misses a turn: a
bounded Monitor `until` loop (`until flow-ci-check "$PR"
$NOT_REQUESTED_FLAG $WAIT_FLAG --out "$VERDICT_FILE" | jq -e
'.status=="decided"' >/dev/null; do sleep "$NEXT"; done`, ≤3600000 ms) or
`ScheduleWakeup` (same 60s floor, equivalent, when present) — both end in
the same `flow-ci-check` call. If neither fires before turn-end:
**yield-and-resume (`ci-wait-pending`)** — write `flow-state-update --phase
ci-wait-pending` and end the turn cleanly (a pending phase; `flow-stop-guard`
treats it as a legitimate turn-end, no loop-break budget consumed). On
re-invocation, re-run step (1): a parsing `$VERDICT_FILE` short-circuits to
"Branch on `.decision`"; otherwise `flow-ci-check` runs fresh.

**(4) Failed observation.** A `flow-ci-check` call whose `gh` read itself
failed emits `waiting` + `observation:"failed"` + `observationFailedSec`
(from `ciWait.lastObservedAt ?? ciWait.startedAt`) — never a fabricated
decision. Rule: `observationFailedSec >= 1200` ⇒ `NEEDS HUMAN: gh-unavailable`.

**Anchors, not an in-process clock.** Every `elapsedSec` re-derives from
`ciWait.startedAt` in state.json; `ciTerminalAt` prefers GitHub's own
`completedAt` (floored at `startedAt`) over observation time — a
suspended/parked waiter can delay the next `flow-ci-check` call but never
inflate what it reports as elapsed, immune to fabricating `ci-hang`.
`$VERDICT_FILE` is written only on `decided`, so "file exists and parses
⇒ branch" resume logic and `flow-pipeline-summary --ci-wait-result` keep
working unchanged.

Branch on `.decision`. Resolve the render lens once for the whole table: `LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)`. At every terminal `flow-gate-summary` render below (status: merged, gated, needs-human, or cancelled), first author `TLDR="<one sentence, ≤25 words, the user-visible outcome>"` and pass `--tldr "$TLDR"`; a `flow-notify` call in the same row passes `--reason "$TLDR"` (needs-human also passes `--tag <reason-tag>`); a `flow-pipeline-summary` call in the same row adds `--lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)` and, right after, captures `COUNTS_LINE=$(flow-pipeline-summary --status <status> --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)`, threaded into `flow-gate-summary --counts-line "$COUNTS_LINE" --untracked-file <(flow-untracked render --format gate --unfiled-only)`.

| `.decision` | Action |
|---|---|
| `proceed-to-review` | Continue to step 8. |
| `proceed-to-review-no-bot` | Same as above; the bot review timed out 10 min after CI went terminal, or the Copilot auto-detect short-circuited (see `copilotSkipReason` JSON field — one of `unclaimed-after-deadline`, `self-dismissed`, or `null` when the 10-min timeout fired). |
| `ci-failed` | Continue to step 5 mode=fix. Pass `$CI_FAILED_CHECKS` (extracted above) as the failure log. Subject to the 3-loop ci-fix cap below. |
| `merged-externally` | PR was merged externally mid-flight. Capture follow-ups output to a file: `flow-followups run > "$WORKTREE/.flow-tmp/followups-block.txt"` (still executes auto-allowlisted entries; `>` captures the rendered block). Set `SLUG="$FLOW_SLUG"`, in ONE `gh pr view` round-trip guarded by `[ -n "$PR" ]`, capture the diff-size source AND the echo-recap fields (`[ -n "$PR" ] && gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName > "$WORKTREE/.flow-tmp/pr-view.json" && IFS=$'\t' read -r PR_URL PR_TITLE PR_BRANCH < <(jq -r '[.url, .title, .headRefName] \| @tsv' "$WORKTREE/.flow-tmp/pr-view.json") && jq '{additions,deletions,changedFiles,commits:(.commits\|length)}' "$WORKTREE/.flow-tmp/pr-view.json" > "$WORKTREE/.flow-tmp/pr-changes.json"`), then render the snapshot ABOVE the gate block via `flow-pipeline-summary --status merged --state-file ~/.flow/state/"$SLUG".json --pr-changes-file "$WORKTREE/.flow-tmp/pr-changes.json" --pr-review-result "$WORKTREE/.flow-tmp/pr-review-result.json" --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --consolidator-result "$WORKTREE/.flow-tmp/consolidator-result.json" --ci-wait-result "$WORKTREE/.flow-tmp/ci-wait-result.json" --followups-block-file "$WORKTREE/.flow-tmp/followups-block.txt" --filed-issues-file "$WORKTREE/.flow-tmp/filed-issues.txt" --intent-resolution "$WORKTREE/.flow-tmp/intent-resolution.json" --post-comment "$PR" --echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH" --lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)` (`--post-comment` durably persists the snapshot as an idempotent PR comment on the MERGED path; it no-ops when `$PR` is empty), then capture `COUNTS_LINE=$(flow-pipeline-summary --status merged --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)` — then **extract the block between `<!-- flow-echo-recap:start -->` and `<!-- flow-echo-recap:end -->` from the helper output and echo it VERBATIM as markdown bullets in your assistant message (prose, not tool output)**; see the [Gate-stage echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose) subsection. Then render the epic-membership block via `flow-epic-membership --slug "$SLUG" --terminal-state merged-externally` (no-op for non-epic features). Run `flow-browser-teardown --reap --record` (registry-driven reap; records its outcome in state.json and always exits 0 — never blocked, never swallowed) as its own standalone step, then author `TLDR="<one-sentence outcome>"` and render the MERGED block via `flow-gate-summary --status merged --pr-url "$PR_URL" --why "PR was merged externally mid-flight; supervisor cleaned up the worktree" --cleanup --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt" --tldr "$TLDR" --lens "$LENS" --untracked-file <(flow-untracked render --format gate --unfiled-only) --counts-line "$COUNTS_LINE"` — which records `phase: merged` itself, only after its block reaches stdout, so a render failure leaves state.json non-terminal and `flow-stop-guard` nudges retry (the helper silently suppresses the FOLLOW-UPS slot when the file is empty; its final stdout line is the byte-exact sentinel `MERGED`). Then `flow-remove-worktree --delete-branch`, call `flow-notify --status merged --url "$PR_URL" --reason "$TLDR"`. End. The roadmap row was self-marked in the PR's diff by `/flow-pr-review` step 7.5; no post-merge sweep required. |
| `pr-closed` | Escalate `NEEDS HUMAN: pr-closed-mid-flight`. |
| `pr-conflicted` | Branch conflicts with base; CI can never run. Advance to the step-10 merge path — `gh pr merge --squash` surfaces the conflict-class failure and the existing Merge-Conflict Resolver Subagent merges base into the branch, resolves, and pushes, after which CI re-runs on the clean head and the pipeline re-enters step 7. Does NOT consume a ci-fix-loop budget slot (conflict remediation is a merge, not a code fix). |
| `pr-blocked` | Branch protection blocks the merge — `mergeStateStatus` is still `BLOCKED` (a failing required check, a missing required review, CODEOWNERS, or a linear-history rule outside the `gh pr checks` surface) **after** CI reached terminal and passed. Unlike `pr-conflicted`, this fires only post-CI-terminal (a PR is legitimately `BLOCKED` while required checks are still pending, so `flow-ci-check` waits CI out first), and unlike a conflict it has no universal mechanical fix the pipeline owns. Escalate `NEEDS HUMAN: pr-blocked` via the standard `# Failure paths` block. Does NOT route to the step-10 merge path and does NOT consume a ci-fix-loop budget slot. |
| `ci-hang` | Escalate `NEEDS HUMAN: ci-hang`. |

`--copilot-login <login>` overrides the bot login (default reads
`~/.flow/config.json` `bots.copilot`, falling back to
`copilot-pull-request-reviewer`). The helper applies the
`CI_CONFIGURED=0` and `COPILOT_REQUESTED=0` presence overrides
internally — no workflows in `.github/workflows/` collapses to
vacuously-passing CI; bot not requested as a reviewer collapses to
vacuously-posted (skipping the 10-min timeout).

`--wait-for-copilot` is a per-pipeline opt-out of the Copilot
auto-detect short-circuits (see
`references/polling-protocol.md` "Claim-deadline auto-detect" and
"Self-dismissal short-circuit"). The supervisor reads the
`waitForCopilot` field from state.json (`jq -r '.waitForCopilot //
empty'`) and appends `--wait-for-copilot` to the `flow-ci-check` call
when the value is the literal `true`. Absent ≡ false ≡ auto-detect ON
(the documented default). The flag is set per-pipeline via
`flow feature create --wait-for-copilot "<description>"`.

**Fix-loop cap: 3 total ci-fix loops** across the whole pipeline.
After the third red CI, escalate `NEEDS HUMAN: ci-fix-exhausted`.

**End condition:** the helper exits 0 with one of the decisions
above. On `proceed-to-review` / `proceed-to-review-no-bot`, continue
to step 8. On `ci-failed`, continue to step 5 mode=fix. On
`pr-conflicted`, advance to the step-10 merge path (the existing
Merge-Conflict Resolver Subagent merges base in + resolves + pushes; no
ci-fix-loop budget consumed) and re-enter step 7 once CI re-runs on the
clean head. On `merged-externally`, run cleanup and end. On `pr-blocked`
/ `pr-closed` / `ci-hang`, escalate and end.

## Step 8 — Review

**Phase:** `reviewing`

Emitted by `flow-fetch-pr-review` (via `/flow-pr-review` Step 2) as a
side effect of returning the value this step branches on; there is no
separate phase-write command. A gatekeeper `skip` short-circuit
(Step 1.5, closed/merged/trivial PR) bypasses Step 2's fetch and so
never writes `reviewing` — benign: `flow-gate-decide` advances straight
to `gating` at Step 9, and monotonicity means the phase is never
*behind* reality, only the `phaseLog[]` audit row for this step is
missing.

Invoke `/flow-pr-review` in-process with the PR number:

```
/flow-pr-review <PR>
```

Every entry — including fix-loop re-entries — is delta-scoped and
lens-gated by `flow-review-scope` (`flow-pr-review`
`references/review-scope.md`); opt-outs `review.deltaScope` /
`review.lensGates` restore today's full-diff, all-six-lenses behaviour.

When the `chrome-devtools` MCP and a `.flow/ui-validation.json` manifest are present, `/flow-pr-review` Step 8c runs the subjective visual-appearance pass against the browser-validation capability (opening each page in a per-pipeline `isolatedContext`): it drives each enumerated visual-appearance item, judges it via the `ui-ux` skill, captures an a11y snapshot as primary evidence (injected via `flow-inject-evidence`) plus a screenshot referenced by path under `.flow-tmp/ui-evidence/`, and ticks the box. This adds no new Task-tool exemption — Step 8c runs inside the already-exempt Fix-Applier surface. `/flow-pr-review` Step 3.6's intent-mismatch resolution sub-step also runs in this in-process review, comparing the diff-only intent-guess agent's blind guess against the actual request; it may escalate `NEEDS HUMAN: intent-drift` or append an unchecked `- [ ] SUBJECTIVE: confirm scope drift is intentional` item to the PR's Test Steps.

`/flow-pr-review` itself spawns one **Fix-Applier Subagent** via the Task
tool (the fourth of the eight named Task-tool exemptions in "Hard
rules" above) to handle the per-finding address loop, the pre-commit
run, the commit + push, and the `/flow-verify` re-run — all inside the
subagent's isolated context. The subagent writes a structured
artifact to `<worktree>/.flow-tmp/fix-applier-result.json`; the
wrapper reads it once and reuses the parsed object across its
remaining steps. The supervisor never sees the per-finding fix
prose, only `/flow-pr-review`'s brief return summary.

**Surface UI screenshots (review-time).** `/flow-pr-review` Step 8c's
browser pass (above) merges its captured screenshot paths into this same
`fix-applier-result.json`'s `ui_screenshots[]` before this read, so mirror
the same recipe used at step 6 against it:

  ```bash
  jq -r '.ui_screenshots[]?' "$WORKTREE/.flow-tmp/fix-applier-result.json" | while IFS= read -r p; do
    [ -f "$p" ] && printf '%s\n' "$p"
  done
  ```

  Print each surviving absolute path bare — one per line, no bullet
  marker, no trailing punctuation — all of them, no cap.

`/flow-pr-review` also spawns one **Independent Gatekeeper Subagent** via
the Task tool (the seventh of the eight named Task-tool exemptions in
"Hard rules" above) at its Step 1.5, before any other Task-tool
fan-out fires. This short-circuit uses a `model: "haiku"` cost-routing override to skip
closed/merged/trivial/no-new-commits PRs cheaply without paying for the
four-agent Sonnet review. On a skip verdict the wrapper writes a
`status: "clean"` artifact and the supervisor proceeds to the auto-merge
gate; on `decision: "proceed"` it falls through to the full review. Full
contract in [references/exemption-contracts.md](../../../references/exemption-contracts.md).

The skill auto-detects Address vs Review mode from the existing PR
state and:

- In Address mode (existing inline review comments to address):
  resolves each, commits, pushes.
- In Review mode (no existing comments to address): runs the
  multi-agent independent review, posts findings as inline
  comments, auto-fixes any critical findings, commits, pushes.

**Fix-loop cap: 2 total review-fix loops.** If `/flow-pr-review`
surfaces critical findings that it can't auto-fix, loop back to
step 5 with mode=fix and the finding details. After the second
loop-back, escalate `NEEDS HUMAN: review-fix-exhausted`.

After `/flow-pr-review` commits + pushes, return to step 7 (CI wait),
not directly to step 9. The fix commit may have changed CI.

**End condition:** `/flow-pr-review` returns clean (no critical
findings outstanding) AND the most recent CI cycle is green.
Continue to step 9.

### Read the `/flow-pr-review` result artifact and branch on `.status`

After `/flow-pr-review` returns, the wrapper has written a structured
result artifact at `<worktree>/.flow-tmp/pr-review-result.json`
(documented in `skills/pipeline/flow-pr-review/SKILL.md`'s `# Result
artifact` section). Read it exactly once and validate the shape
before branching:

```bash
flow-pr-review-result-schema --validate \
  "$WORKTREE/.flow-tmp/pr-review-result.json"
```

The validator exits 0 and prints `{ok: true}` on a well-formed artifact;
on a malformed or missing file it exits non-zero with
`{ok: false, reason, path?}` on stderr.

**Missing or empty artifact** → escalate `NEEDS HUMAN:
pr-review-missing-artifact` (no retry; mirrors
`fix-applier-missing-artifact`). The wrapper writes the artifact on every
documented exit path, so absence signals a catastrophic crash.

Branch on the artifact's `.status` field — exactly one of the
three string literals `"clean"`, `"partial"`, or `"escalated"`:

- `"clean"` → the skill ran to completion; continue to step 7 (CI
  wait) per the existing flow above, then step 9.
- `"partial"` (with non-empty `.missed_steps`) → re-invoke
  `/flow-pr-review <PR> --resume-from <first-missed-step>` exactly once (the
  `--resume-from` flag skips the steps already in `.completed_steps` and
  resumes at the named step). After the retry returns, re-validate the
  artifact and re-branch on `.status`:
    - retry-`"clean"` → continue per the `"clean"` branch above.
    - retry-`"partial"` → escalate `NEEDS HUMAN: review-partial:
      <missed_steps joined with commas>`.
    - retry-`"escalated"` → propagate `.escalation_tag` verbatim
      into `NEEDS HUMAN: <escalation_tag>` (same as the
      first-call `"escalated"` branch below — collapsing it into
      `review-partial` would drop the actionable tag, e.g.
      `task-tool-unavailable: pr-review-fix-applier`, in favour
      of a generic missed-step list).
  The partial-retry budget is one, **independent of the 2-loop
  review-fix cap above** (that cap counts auto-fixed critical findings;
  this counter tracks structural missed-step retries).
- `"escalated"` → propagate the `.escalation_tag` verbatim into
  `NEEDS HUMAN: <escalation_tag>` and bail. No retry: the tag names a
  documented bail-out site (e.g. `task-tool-unavailable: pr-review-*`,
  `gatekeeper-missing-artifact`, `fix-applier-missing-artifact`) whose
  resolution is user-action.

On non-zero exit from `/flow-pr-review` itself (Bun-level / shell-level
failure with no artifact written): retry once. If the retry also
fails, escalate `NEEDS HUMAN: review-failed`.

## Step 9 — Auto-merge gate

**Phase:** `gating`

Emitted by `flow-gate-decide` as a side effect of returning the value
this step branches on (`.decision`); there is no separate phase-write
command.

`flow-gate-decide` consolidates the rubric parse (heading-presence grep →
section extract → HTML-comment strip → unchecked-`- [ ]`-count) and the
four-state matrix (PR state × autoMerge opt-out × section verdict) into one
call. The heading contract lives in **`references/auto-merge-rubric.md`**
(single source of truth) and is unit-tested at
`bin/flow-gate-decide.test.ts`. The heading-presence check is load-bearing:
a missing heading escalates explicitly rather than collapsing to
auto-merge (which would ship a PR the user expected to be gated).

```bash
RESULT=$(flow-gate-decide "$PR")
DECISION=$(printf '%s' "$RESULT" | jq -r '.decision')
PR_URL=$(printf '%s' "$RESULT" | jq -r '.prUrl // empty')
REASON=$(printf '%s' "$RESULT" | jq -r '.reason // empty')
VALIDATION_ITEMS=$(printf '%s' "$RESULT" | jq -r '.validationItems[]? // empty')
```

The helper reads `autoMerge` from `~/.flow/state/<slug>.json`
itself (defaulting to `true` when absent). `autoMerge: false` —
the user passed `flow feature create --no-auto-merge`, or
`flow-state-update --no-auto-merge` was issued mid-flight — routes
every `OPEN` PR to `gated` regardless of section content. `MERGED`
and `CLOSED` states still take their normal branches.

Branch on `.decision`. Resolve the render lens once for the whole table: `LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)`. At every terminal `flow-gate-summary` render below (status: merged, gated, needs-human, or cancelled), first author `TLDR="<one sentence, ≤25 words, the user-visible outcome>"` and pass `--tldr "$TLDR"`; a `flow-notify` call in the same row passes `--reason "$TLDR"` (needs-human also passes `--tag <reason-tag>`); a `flow-pipeline-summary` call in the same row adds `--lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)` and, right after, captures `COUNTS_LINE=$(flow-pipeline-summary --status <status> --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)`, threaded into `flow-gate-summary --counts-line "$COUNTS_LINE" --untracked-file <(flow-untracked render --format gate --unfiled-only)`.

| `.decision` | Action |
|---|---|
| `auto-merge` | Run `flow-followups pr-body-upsert "$PR"` (no-op when log is empty; otherwise idempotent in-place upsert of `## Local Follow-ups` so the section survives the squash-merge), then run `flow-foreclosed-paths pr-body-upsert "$PR"` (idempotent; no-ops when there are no foreclosed paths). Continue to step 10 (auto-merge). |
| `gated` | Run `flow-followups pr-body-upsert "$PR"` (idempotent), then run `flow-foreclosed-paths pr-body-upsert "$PR"` (idempotent; no-ops when there are no foreclosed paths), then capture the deferred follow-ups block via `flow-followups run --note-only > "$WORKTREE/.flow-tmp/followups-block.txt"` (the renderer suppresses the FOLLOW-UPS slot when the file is empty). Set `SLUG="$FLOW_SLUG"`, in ONE `gh pr view` round-trip, capture the diff-size source AND the echo-recap fields (`gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName > "$WORKTREE/.flow-tmp/pr-view.json" && IFS=$'\t' read -r PR_URL PR_TITLE PR_BRANCH < <(jq -r '[.url, .title, .headRefName] \| @tsv' "$WORKTREE/.flow-tmp/pr-view.json") && jq '{additions,deletions,changedFiles,commits:(.commits\|length)}' "$WORKTREE/.flow-tmp/pr-view.json" > "$WORKTREE/.flow-tmp/pr-changes.json"`), then render the snapshot ABOVE the gate block via `flow-pipeline-summary --status gated --state-file ~/.flow/state/"$SLUG".json --pr-changes-file "$WORKTREE/.flow-tmp/pr-changes.json" --pr-review-result "$WORKTREE/.flow-tmp/pr-review-result.json" --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --consolidator-result "$WORKTREE/.flow-tmp/consolidator-result.json" --ci-wait-result "$WORKTREE/.flow-tmp/ci-wait-result.json" --followups-block-file "$WORKTREE/.flow-tmp/followups-block.txt" --filed-issues-file "$WORKTREE/.flow-tmp/filed-issues.txt" --intent-resolution "$WORKTREE/.flow-tmp/intent-resolution.json" --echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH" --lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)`, then capture `COUNTS_LINE=$(flow-pipeline-summary --status gated --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)` — then **extract the block between `<!-- flow-echo-recap:start -->` and `<!-- flow-echo-recap:end -->` from the helper output and echo it VERBATIM as markdown bullets in your assistant message (prose, not tool output)**; see the [Gate-stage echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose) subsection. Then render the epic-membership block via `flow-epic-membership --slug "$SLUG" --terminal-state gated` (prints nothing for non-epic features). Run `flow-browser-teardown --reap --record` (registry-driven reap; records its outcome in state.json and always exits 0 — never blocked, never swallowed) as its own standalone step, then author `TLDR="<one-sentence outcome + count of items needing you>"` and render the GATED block via `flow-gate-summary --status gated --pr-url "$PR_URL" --why "$REASON" --validation-items-file <(printf '%s\n' "$VALIDATION_ITEMS") --cleanup --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt" --tldr "$TLDR" --lens "$LENS" --untracked-file <(flow-untracked render --format gate --unfiled-only) --counts-line "$COUNTS_LINE"` — which records `phase: gated` itself, only after its block reaches stdout, so a render failure leaves state.json non-terminal and `flow-stop-guard` nudges retry. Call `flow-notify --status gated --url "$PR_URL" --reason "$TLDR"`. End. |
| `merged-externally` | Already merged externally. **Do not** run `gh pr merge`. Capture follow-ups output: `flow-followups run > "$WORKTREE/.flow-tmp/followups-block.txt"` (executes allowlisted+auto entries while the worktree is still alive; `>` captures the rendered block). Set `SLUG="$FLOW_SLUG"`, in ONE `gh pr view` round-trip guarded by `[ -n "$PR" ]`, capture the diff-size source AND the echo-recap fields (`[ -n "$PR" ] && gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName > "$WORKTREE/.flow-tmp/pr-view.json" && IFS=$'\t' read -r PR_URL PR_TITLE PR_BRANCH < <(jq -r '[.url, .title, .headRefName] \| @tsv' "$WORKTREE/.flow-tmp/pr-view.json") && jq '{additions,deletions,changedFiles,commits:(.commits\|length)}' "$WORKTREE/.flow-tmp/pr-view.json" > "$WORKTREE/.flow-tmp/pr-changes.json"`), then render the snapshot ABOVE the gate block via `flow-pipeline-summary --status merged --state-file ~/.flow/state/"$SLUG".json --pr-changes-file "$WORKTREE/.flow-tmp/pr-changes.json" --pr-review-result "$WORKTREE/.flow-tmp/pr-review-result.json" --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --consolidator-result "$WORKTREE/.flow-tmp/consolidator-result.json" --ci-wait-result "$WORKTREE/.flow-tmp/ci-wait-result.json" --followups-block-file "$WORKTREE/.flow-tmp/followups-block.txt" --filed-issues-file "$WORKTREE/.flow-tmp/filed-issues.txt" --intent-resolution "$WORKTREE/.flow-tmp/intent-resolution.json" --post-comment "$PR" --echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH" --lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)` (the helper yields `none` for absent artifacts, so a thin merged-externally snapshot is expected; `--post-comment` durably persists the snapshot as an idempotent PR comment and no-ops when `$PR` is empty), then capture `COUNTS_LINE=$(flow-pipeline-summary --status merged --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)` — then **extract the block between `<!-- flow-echo-recap:start -->` and `<!-- flow-echo-recap:end -->` from the helper output and echo it VERBATIM as markdown bullets in your assistant message (prose, not tool output)**; see the [Gate-stage echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose) subsection. Then render the epic-membership block via `flow-epic-membership --slug "$SLUG" --terminal-state merged-externally` (no-op for non-epic features). Run `flow-browser-teardown --reap --record` (registry-driven reap; records its outcome in state.json and always exits 0 — never blocked, never swallowed) as its own standalone step, then author `TLDR="<one-sentence outcome>"` and render the MERGED block via `flow-gate-summary --status merged --pr-url "$PR_URL" --why "PR was merged externally; supervisor cleaned up worktree only" --cleanup --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt" --tldr "$TLDR" --lens "$LENS" --untracked-file <(flow-untracked render --format gate --unfiled-only) --counts-line "$COUNTS_LINE"` — which records `phase: merged` itself, only after its block reaches stdout, so a render failure leaves state.json non-terminal and `flow-stop-guard` nudges retry. Then `flow-remove-worktree --delete-branch`, call `flow-notify --status merged --url "$PR_URL" --reason "$TLDR"`. End. (The roadmap row was self-marked in the PR's diff by `/flow-pr-review` step 7.5; no post-merge sweep is needed.) |
| `closed-no-merge` | Author `TLDR="The PR was closed without merging; nothing was shipped."`. Call `flow-notify --status needs-human --url "$PR_URL" --reason "$TLDR" --tag pr-closed-without-merge`. Run `flow-browser-teardown --reap --record` (registry-driven reap; records its outcome in state.json and always exits 0 — never blocked, never swallowed) as its own standalone step, then render the NEEDS HUMAN block via `flow-gate-summary --status needs-human --reason pr-closed-without-merge --pr-url "$PR_URL" --why "PR closed without merge" --cleanup --tldr "$TLDR" --lens "$LENS"`. End. |
| `escalate-heading-missing` | Author `TLDR="The PR body is missing its Test Steps section, so I can't tell whether this is safe to auto-merge."`. Run `flow-browser-teardown --reap --record` (registry-driven reap; records its outcome in state.json and always exits 0 — never blocked, never swallowed) as its own standalone step, then render the NEEDS HUMAN block via `flow-gate-summary --status needs-human --reason test-steps-section-missing --pr-url "$PR_URL" --why "PR body has no ## Test Steps heading — gate cannot evaluate" --cleanup --tldr "$TLDR" --lens "$LENS"`. Call `flow-notify --status needs-human --url "$PR_URL" --reason "$TLDR" --tag test-steps-section-missing`. End. |
| `escalate-gh-error` | Author `TLDR="A GitHub API error stopped the gate check; nothing was merged."`. Run `flow-browser-teardown --reap --record` (registry-driven reap; records its outcome in state.json and always exits 0 — never blocked, never swallowed) as its own standalone step, then render the NEEDS HUMAN block via `flow-gate-summary --status needs-human --reason gh-error --pr-url "$PR_URL" --why "$(printf '%s' "$REASON" | tr '\n' ' ' | head -c 200)" --cleanup --tldr "$TLDR" --lens "$LENS"` (one-line, length-bounded from the `gh` stderr). Call `flow-notify --status needs-human --url "$PR_URL" --reason "$TLDR" --tag gh-error`. End. |

**Post-render QA prose.** Any prose the supervisor adds around these terminal renders — a follow-up answer, a post-merge QA reply — is formatted per `references/pause-output-contract.md` (labeled slots, no open prose, ≤12 lines; template: the answer lives as prose ABOVE the block per the contract's Q&A rule, then `### ✅ <terminal state> — question answered` / `**Next action:** <what remains>`), but NEVER as a second block over the helper render: the `flow-gate-summary` / `flow-pipeline-summary` output already satisfies the contract via its own `STATUS:`/`WHY:`/`NEXT ACTION:` grammar and is never duplicated or re-wrapped.
<!-- any new pause site below must reference pause-output-contract.md -->

**A `gated` verdict is terminal, not advisory.** When `flow-gate-decide`
returns `gated`, the supervisor renders the GATED block via
`flow-gate-summary` (which records `phase: gated` itself) and ends — full stop. The `gated` verdict is **not** an
input the supervisor may weigh against its own judgment. The supervisor
must **not** run `gh pr merge` on a `gated` PR on its own authority; must
**not** reclassify the PR's unchecked Test Steps items (in particular, it
must not relabel a functional check — a popover opens, a button works, a
page renders — as "subjective UX") to make the verdict come out
differently; and must **not** treat a "merge" / "ship it" instruction
given *before* the gate verdict was surfaced as authorisation to merge.
The gate exists precisely to stop a non-functional feature from shipping
while manual verification steps are still unchecked; overriding it on the
supervisor's own authority is the exact failure mode this rule
forecloses. The only two routes from `gated` to merged are (a) a human
merging the PR through GitHub themselves, or (b) the fresh-confirmation
gate-override path below. See `references/auto-merge-rubric.md` "A
`gated` verdict is terminal, not advisory" for the full contract.

### Gate auto-checkpoint sub-step

After rendering the GATED block (which records `phase: gated` itself), arm a
lightweight checkpoint so the user can `/clear` during manual validation
without typing `/flow-checkpoint` first — `gated` is the highest-value
context-clear point in the pipeline (it routinely sits through several
rounds of feedback while the supervisor carries a huge `/flow-pr-review`
context the next fix does not need). **Non-clobbering:** probe with
`flow-checkpoint --probe --site gate`; only on a `write` verdict write a
minimal one-line pointer (e.g. `gated on PR #<pr> — feedback-mode
checkpoint`) to the path `flow-checkpoint --path` prints — a still-fresh
manual note (`verdict: preserve`) wins, left untouched. Then arm:
`flow-checkpoint --site gate`.

This is a **near-zero-residue** arm — it flushes no approval state, only
the pointer that lets `SessionStart:clear` fire at `gated`. Add a
one-line nudge after the GATED render: **safe to `/clear` during
validation — the pipeline auto-resumes** into feedback mode
(`flow-resume-decide` resolves `gated` + a checkpoint marker →
`gated-feedback`, see Resume mode). It grants no new merge authority —
the gated verdict stays terminal.

**Feedback-mode turn-ending replies.** While a `gated` PR sits through feedback rounds (including `gated-feedback` resume re-entries), every turn-ending reply — a fix confirmation, a re-verify report, a validation answer — is formatted per `references/pause-output-contract.md` — labeled slots, no open prose, ≤12 lines (template: `### ⏸ GATED — <what this round did>` / `**Unsolved:** <unchecked Test Steps, collapsed to a count line when all are minor>` / `**Needs attention:** <the SUBJECTIVE/gated item touched, with the PR URL>` / `**Untracked:** <unfiled items, `file #N` / `drop #N` to act on one>` / `**Next action:** tick the boxes and say merge, or report another issue`). Solved items from this round collapse into the one count line; they never get their own bullet.
<!-- any new pause site below must reference pause-output-contract.md -->

### Gate override (post-verdict, opt-in)

A `gated` run has ended, but the tmux window stays open. A *new*
instruction to merge the gated PR anyway is a mid-flight redirect,
classified per `references/redirect-handling.md` "Gate override" (full
procedure, the `case`-statement bash, and the canonical anti-pattern this
rule exists for live there). An override is authorised **only** when the
instruction is all three of **fresh** (sent after the GATED block was
surfaced), **unambiguous** (about merging this gated PR — bare
"merge"/"ship it"/"lgtm" qualify; the `AskUserQuestion` form fired next
is itself the conscious-confirmation step), and **in-context** (actually
about this gate verdict, not inferred from an earlier instruction given
for a different purpose). A stale or pre-verdict instruction never
qualifies. The "unambiguous" test fails only on inputs that are not
about merging at all (bare "cool", "thanks", "next").

**Re-query the live gate first.** Before firing or refusing the
override, always re-query the live verdict via `flow-gate-decide "$PR"`
— the user may have ticked `- [ ]` boxes themselves between the GATED
render and their instruction, clearing the gate. `auto-merge` ⇒ no
override needed, route straight to step 10 (`flow-merge-guard` there
re-confirms the cleared gate); `gated` ⇒ proceed to the confirmation
below; any other decision ⇒ route per step 9's main decision table.

When the three tests pass, fire exactly one `AskUserQuestion`
confirmation naming the PR and the unchecked-step count (the named
exemption in "Hard rules"); on an affirmative answer, run
`flow-merge-guard "$PR" --record-override` and re-enter step 10 — the
backstop there reads the token and lets the merge through. On any
non-affirmative answer, or when the instruction fails the "fresh" or
"in-context" test, do **not** fire the confirmation and do **not**
record a token — re-render the GATED block via `flow-gate-summary
--status gated ...`, restate that the verdict is terminal, and end. The
PR stays `gated`. Step 10's `merging` write out of `gated` is the third
allowlisted exit, and the allowlist grants no merge authority — the
override still requires this fresh `AskUserQuestion` confirmation and
`flow-merge-guard --record-override`.

**Step 10 needs no helper plumbing change.** `flow-merge-guard` already
re-fetches the live PR body on every call (see `bin/flow-merge-guard.ts`'s
`run()`), so the stale-verdict footgun the re-query above closes was
purely on the step 9 supervisor-prose decision path.

## Step 10 — Merge

**Phase:** `merging`

Emitted by `flow-merge-guard` as a side effect of returning the
pass/block verdict this step cannot proceed without; there is no
separate phase-write command.

**Mechanical merge guard — run before every merge.** `flow-merge-guard`
is the backstop that makes the merge path mechanically unreachable on a
`gated` verdict the supervisor reached step 10 with anyway. It re-fetches
the *live* PR body and re-parses the `## Test Steps` section (reusing the
same audited parse as `flow-gate-decide`), and blocks unless the section
has zero unchecked items **or** a fresh gate-override token is recorded
(written by the step 9 "Gate override" sub-step). It is mandatory on
every merge path: on a legitimate `auto-merge` verdict it is a no-op
pass, so running it always costs nothing and closes the override hole.

```bash
GUARD_JSON=$(flow-merge-guard "$PR")
GUARD_RC=$?
if [ "$GUARD_RC" -ne 0 ]; then
  PR_URL=$(gh pr view "$PR" --json url -q .url 2>/dev/null)
  GUARD_REASON=$(printf '%s' "$GUARD_JSON" | jq -r '.reason // empty' 2>/dev/null)
  GUARD_REASON=${GUARD_REASON:-"flow-merge-guard exited $GUARD_RC (helper missing from PATH? run flow install --upgrade)"}
  flow-followups run --note-only > "$WORKTREE/.flow-tmp/followups-block.txt"
  flow-browser-teardown --reap --record  # registry-driven; records outcome; always exits 0
  TLDR="Merge is blocked: it needs your fresh confirmation before it can proceed."
  LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)
  flow-gate-summary --status needs-human \
    --reason gate-override-without-confirmation --cleanup \
    --pr-url "$PR_URL" --why "$GUARD_REASON" \
    --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt" \
    --tldr "$TLDR" --lens "$LENS"  # records phase: needs-human itself (flow-gate-summary is the sole terminal-phase emitter)
  flow-notify --status needs-human --url "$PR_URL" \
    --reason "$TLDR" --tag gate-override-without-confirmation
  # End. Do NOT merge, do NOT retry the guard.
  exit 1
fi
```

A non-zero `flow-merge-guard` exit means a `gated` verdict was reached
without the fresh-confirmation override (exit 1 = blocked), or the guard
could not run (exit 2 = gh error / bad args, or 127 = helper not yet on
PATH — the user must run `flow install --upgrade`). In **every** non-zero
case the supervisor escalates `NEEDS HUMAN: gate-override-without-confirmation`
and ends — it never merges past the guard and never retries it. Only
when `GUARD_RC` is `0` does the supervisor continue to the merge below.

```bash
PRIMARY=$(git worktree list --porcelain | awk '/^worktree / {sub(/^worktree /, ""); print; exit}')
MERGE_STDERR=$(cd "$PRIMARY" && gh pr merge --squash "$PR" 2>&1 1>/dev/null)
MERGE_RC=$?
```

**Retry self-containment.** The supervisor runs each retry below as a
separate Bash tool call, and a fresh shell does not inherit `$PRIMARY`
from the block above (a shell-state-loss hazard). So every retry call
site re-derives `PRIMARY=$(git worktree list ...)` in its own block
before invoking `gh pr merge` — the merge command itself takes no extra
flags, so there is nothing else to carry across.

Step 10 runs a bare `gh pr merge --squash` — no `--body`, no `--subject` —
so gh builds the squash-commit body from its default concatenation of the
branch's commit messages. The `Claude-Code-Session-Id:` trailer reaches
`git log` / `git blame` via the per-commit `prepare-commit-msg` hook
`flow-new-worktree` installs (gh's concatenation carries it into the squash
commit for free); the step 9 gate is unaffected — it inspects only the live
PR body. The merge runs from `$PRIMARY` (which has the base branch checked
out) because gh's post-merge `git checkout <base>` would collide with the
primary worktree if run from the feature-branch `$WORKTREE`. Issue #486 re-litigated the bare-squash choice and lost; see [references/git-workflow.md](../../../references/git-workflow.md).

On `MERGE_RC == 0`: continue to the post-merge sweep below.

On non-zero exit, branch on the failure class:

- **Conflict-class** — `MERGE_STDERR` matches any of:
  `Pull Request is not mergeable`, `not mergeable: the merge commit
  cannot be cleanly created`, `merge conflict between`. Spawn the
  Independent Merge-Conflict Resolver Subagent (see below), then
  retry the merge **exactly once** with `$PRIMARY` re-derived in the
  same Bash call:

  ```bash
  PRIMARY=$(git worktree list --porcelain | awk '/^worktree / {sub(/^worktree /, ""); print; exit}')
  (cd "$PRIMARY" && gh pr merge --squash "$PR")
  ```

  On retry success, continue to the post-merge sweep. On retry
  failure, author `TLDR="The merge failed after a conflict resolve and
  retry; nothing was lost."` and render the NEEDS HUMAN block via
  `flow-gate-summary --status needs-human --reason merge-failed
  --pr-url "$PR_URL" --why "$(jq -r .summary "$ARTIFACT_PATH" | head
  -1)" --tldr "$TLDR" --lens "$(jq -r '.output.lens // "pm"'
  ~/.flow/config.json 2>/dev/null)"`. End.
  Then the standard `# Failure paths` chain.
- **Non-conflict** (auth, network, branch-protection denied, required
  check failed, PR closed externally, any unrecognised stderr) —
  retry the merge once with `$PRIMARY` re-derived in the same Bash
  call:

  ```bash
  PRIMARY=$(git worktree list --porcelain | awk '/^worktree / {sub(/^worktree /, ""); print; exit}')
  (cd "$PRIMARY" && gh pr merge --squash "$PR")
  ```

  If still
  failing, author `TLDR="The merge failed for a reason other than a
  conflict; nothing was lost."` and escalate via the standard
  `# Failure paths` block (capture follow-ups via `flow-followups run
  --note-only > "$WORKTREE/.flow-tmp/followups-block.txt"` → render via
  `flow-gate-summary --status needs-human --reason merge-failed
  --pr-url "$PR_URL" --why "$MERGE_STDERR" --deferred-file
  "$WORKTREE/.flow-tmp/followups-block.txt" --tldr "$TLDR" --lens
  "$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)"`
  (records `phase: needs-human` itself) → `flow-notify --status
  needs-human --url "<pr-url>" --reason "$TLDR" --tag merge-failed`. Leave the worktree intact. Do **not** spawn the resolver — it can't help with
  non-conflict failures and would waste a Task call.

### Independent Merge-Conflict Resolver Subagent

Fires only on the conflict-class branch above. The subagent merges
`origin/<base>` into the branch, resolves each conflicted file,
records actions taken + ambiguous calls in a structured artifact,
pushes, and returns a brief summary. The supervisor never sees
the merge output, the per-file resolution prose, or the push
transcript — only the artifact and the summary.

**Load the Task tool before spawning** — i.e. before the Task call below. See [../flow-pr-review/references/task-tool-exemption-preamble.md](../flow-pr-review/references/task-tool-exemption-preamble.md) for the full rationale. On missing schema: escalate `NEEDS HUMAN: task-tool-unavailable: flow-pipeline-merge-resolver` and exit (do not fall back to in-line execution).

Resolve the inputs the subagent needs, then make exactly **one**
Task call:

```bash
ARTIFACT_PATH="$WORKTREE/.flow-tmp/merge-resolver-result.json"
INSTRUCTIONS_PATH="$SKILL_DIR/../flow-merge-resolver-instructions/SKILL.md"; FLOW_ROOT=$(cd -P "$SKILL_DIR/../../.." && pwd -P); MARKER_CHECK_CMD="bun $FLOW_ROOT/bin/flow-conflict-marker-check.ts"  # cd -P+pwd -P load-bearing: a logical cd lands in ~/.flow/claude-home
BASE_BRANCH=$(gh pr view "$PR" --json baseRefName -q .baseRefName)
mkdir -p "$WORKTREE/.flow-tmp"
rm -f "$ARTIFACT_PATH"   # clear any stale artifact from a prior re-entry (step 10 is re-enterable via the step-7 pr-conflicted row)
# Per-phase model (mergeResolver) — resolution field: state.modelMergeResolver.
# Precedence: --model-merge-resolver > config.models.mergeResolver > inherited.
# Empty ⇒ omit model: from the Task call (inherit). See references/model-routing.md.
SLUG="$FLOW_SLUG"
MERGE_RESOLVER_MODEL=$(jq -r '.modelMergeResolver // empty' ~/.flow/state/"$SLUG".json)
[ -z "$MERGE_RESOLVER_MODEL" ] && MERGE_RESOLVER_MODEL=$(jq -r '.models.mergeResolver // empty' ~/.flow/config.json 2>/dev/null)
# Best-effort conflicting-file list — only non-empty when an outer
# process already left the worktree mid-merge (the resolver runs the
# merge itself in Step 2). `git diff --name-only --diff-filter=U`
# catches every U-class status (UU/AU/UA/DU/UD), unlike a porcelain
# prefix grep which misses the AU/DU pair where U is in column 2.
(cd "$WORKTREE" && git fetch origin "$BASE_BRANCH") || echo "warn: git fetch origin $BASE_BRANCH failed; resolver will retry the fetch in Step 2" >&2
CONFLICTING_FILES=$(cd "$WORKTREE" && git diff --name-only --diff-filter=U)
PR_DESCRIPTION=$(gh pr view "$PR" --json body -q .body)
# Guarded agent resolution — contract in references/exemption-contracts.md (exemption #5).
# Plugin-hosted agents resolve ONLY by the plugin-qualified name
# <pluginRootName>:<agentBasename> — a bare name fails Task-tool
# resolution outright (measured: "Agent type 'flow-scout' not found").
MERGE_RESOLVER_SUBAGENT=general-purpose
if [ -f ~/.flow/claude-home/.claude/skills/flow-module-core/agents/flow-merge-resolver.md ]; then
  MERGE_RESOLVER_SUBAGENT=flow-module-core:flow-merge-resolver
else
  echo "NOTICE — agent-fallback: flow-merge-resolver → general-purpose (definition not installed; tool-allowlist containment lost — run \`flow install\`)."
fi
```

See [references/merge-resolver-spawn-prompt.md](references/merge-resolver-spawn-prompt.md) for the verbatim spawn-prompt template (nine `{{...}}` placeholders). Fill the placeholders from the resolve-inputs block above before passing it to the Task tool.

Make the Task call with `subagent_type: $MERGE_RESOLVER_SUBAGENT` (resolved
above — `flow-module-core:flow-merge-resolver` on a plugin-root install, else
`general-purpose`), the per-spawn
`model: "$MERGE_RESOLVER_MODEL"` argument resolved above (precedence
`--model-merge-resolver > config.models.mergeResolver > inherited`; when
`$MERGE_RESOLVER_MODEL` is empty, omit `model:` so the resolver inherits the
session model — see [references/model-routing.md](references/model-routing.md)),
and the filled prompt. After it returns:

1. Spawn-denial check: if the Task call itself returns a permission
   denial / refusal (not a subagent result) AND no artifact was
   written, author `TLDR="The merge-conflict resolver couldn't start;
   nothing was touched."` and escalate `NEEDS HUMAN:
   merge-resolver-spawn-denied` via `flow-gate-summary --status needs-human
   --reason merge-resolver-spawn-denied --pr-url
   "$PR_URL" --tldr "$TLDR" --lens "$(jq -r '.output.lens // "pm"'
   ~/.flow/config.json 2>/dev/null)"`, leave the worktree intact, and
   end — do **not** resolve inline in the supervisor
   (see [references/exemption-contracts.md](../../../references/exemption-contracts.md)
   for why). Then the standard `# Failure paths` chain. **Partial-result continuation:** a Task result marked partial with an agent id and a missing artifact gets one `SendMessage` continuation per `references/partial-result-continuation.md` before escalating.
2. Existence check: `test -s "$ARTIFACT_PATH"`. If absent, escalate
   `NEEDS HUMAN: merge-resolver-missing-artifact` and end. (Do not
   re-spawn the resolver — exactly one Task call per run, per the
   exemption contract.) Then the standard `# Failure paths` chain.
3. Read the artifact's `push_status`. If `succeeded`, retry the
   merge **exactly once** with `$PRIMARY` re-derived in the same Bash
   call (the supervisor runs this as a fresh shell — `$PRIMARY` from
   the Step 10 block above is not in scope):

   ```bash
   PRIMARY=$(git worktree list --porcelain | awk '/^worktree / {sub(/^worktree /, ""); print; exit}')
   (cd "$PRIMARY" && gh pr merge --squash "$PR")
   ```

   If `failed` or `skipped`, do not retry — author `TLDR="The
   conflict-resolver's push didn't take; the merge still needs you."`
   and render the NEEDS HUMAN block via `flow-gate-summary --status needs-human
   --reason merge-failed --pr-url "$PR_URL" --why "$(jq -r
   .summary "$ARTIFACT_PATH" | head -1)" --tldr "$TLDR" --lens "$(jq -r
   '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)"`. End.
   Then the standard `# Failure paths` chain.
4. On retry success, continue to the post-merge sweep below.
5. On retry failure, author `TLDR="The retried merge still failed;
   nothing was lost — the resolved branch is on disk."` and render the
   NEEDS HUMAN block via `flow-gate-summary --status needs-human
   --reason merge-failed --pr-url "$PR_URL" --why "$(jq -r .summary
   "$ARTIFACT_PATH" | head -1)" --tldr "$TLDR" --lens "$(jq -r
   '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)"`. End. Then
   the standard `# Failure paths` chain. The artifact stays on disk in
   the worktree for human inspection.

On success, the roadmap row for this PR was already flipped to
`✅ shipped (#$PR)` in the PR's own diff by `/flow-pr-review` step 7.5
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
REJECTED=()
if [ -f "$PLAN" ] && grep -q '^# Candidate follow-up issues' "$PLAN"; then
  # `--ticked` owns the section parse + em-dash split; metadata fields
  # are `null` sans a matching ranking-table row.
  TICKED_JSON=$(flow-candidate-issues --plan-md-file "$PLAN" --ticked)
  COUNT=$(printf '%s' "$TICKED_JSON" | jq -r '.ticked | length')
  for ((i = 0; i < COUNT; i++)); do
    ITEM=$(printf '%s' "$TICKED_JSON" | jq -c ".ticked[$i]")
    TITLE=$(printf '%s' "$ITEM" | jq -r '.title')
    BODY_FILE="$WORKTREE/.flow-tmp/sweep-$(echo "$TITLE" | tr ' /' '__').md"
    # Body, then the value-prop block (details), then a Rationale/Relation
    # line per non-null field, then the sweep attribution footer.
    printf '%s' "$ITEM" | jq -r --arg pr "$PR" '[.body, (if .details != "" then "\n" + .details else empty end), (if .rationale then "\n**Rationale:** " + .rationale else empty end), (if .relation then "\n**Relation to current request:** " + .relation else empty end), "\nSurfaced by /flow-product-planning during the pipeline that landed PR #" + $pr + "."] | join("\n")' > "$BODY_FILE"
    JSON=$(flow-create-issue \
      --title "$TITLE" \
      --body-file "$BODY_FILE" \
      --label flow-agent,out-of-scope-discovery)
    RC=$?
    # RC=3 (REJECTED, distinct from a WARN gh/Issues-surface failure): the
    # body was rejected by the value-rubric contract; `$JSON` is the
    # rejection envelope, not a URL. Folding it into WARN would launder it.
    if [ $RC -eq 0 ]; then FILED+=("$(printf '%s' "$JSON" | jq -r '.url')")
    elif [ $RC -eq 3 ]; then REJECTED+=("$TITLE")
    else WARN+=("$TITLE"); fi
  done
fi
if [ "${#FILED[@]}" -eq 0 ] && [ "${#WARN[@]}" -eq 0 ] && [ "${#REJECTED[@]}" -eq 0 ]; then
  echo "No follow-up issues filed"
else
  [ "${#WARN[@]}" -gt 0 ] && echo "WARN: no Issues surface for: ${WARN[*]}"
  [ "${#REJECTED[@]}" -gt 0 ] && echo "REJECTED (exit 3, needs repair): ${REJECTED[*]}"
  [ "${#FILED[@]}" -gt 0 ] && { echo "Filed ${#FILED[@]} follow-up issues:"; printf '  %s\n' "${FILED[@]}"; }; fi
# Capture filed/unfiled/rejected entries as filed\t<url> / unfiled\t<title>
# / rejected\t<title> lines; ## PIPELINE SNAPSHOT reads this file. Truncate first.
: > "$WORKTREE/.flow-tmp/filed-issues.txt"
if [ "${#FILED[@]}" -gt 0 ]; then printf 'filed\t%s\n' "${FILED[@]}" >> "$WORKTREE/.flow-tmp/filed-issues.txt"; fi
if [ "${#WARN[@]}" -gt 0 ]; then printf 'unfiled\t%s\n' "${WARN[@]}" >> "$WORKTREE/.flow-tmp/filed-issues.txt"; fi
if [ "${#REJECTED[@]}" -gt 0 ]; then printf 'rejected\t%s\n' "${REJECTED[@]}" >> "$WORKTREE/.flow-tmp/filed-issues.txt"; fi
```

The sweep is best-effort: per-call failure surfaces as a `WARN:` line
but does not fail the pipeline — the merge already shipped.
`flow-create-issue`'s title-collision idempotency makes a sweep re-run
on resume safe (re-firing yields `flow-create-issue`'s `action:
"existing"` and the same URL — distinct from `flow-candidate-issues`'
decision enum).

Continue to step 11 — local follow-ups must run *before*
`flow-remove-worktree` so the JSONL log is still on disk when the
report builds.

## Step 11 — Local follow-ups

**Phase:** still `merging` — no new phase value (see "no resume scenario"
note below).

Local follow-ups are manual local-computer steps a pipeline produced (e.g.
`flow install --upgrade` after a new helper landed). Sub-skills register them
during the run via `flow-followups add`; step 11 reports them and, on the
MERGED path, executes the safe subset.

**Two-layer safety boundary:** an entry's `auto: true` flag declares
*intent*; the helper's hardcoded ALLOWLIST gates *permission* (exact-match:
`flow install`, `flow install --upgrade`, and `brew install shellcheck`). Both
must be true to execute. `bin/flow-followups.test.ts` pins the exact set, so
this enumeration and the code cannot drift silently.
Same narrow-and-named exemption pattern as the `/flow-pr-review` auto-push and
`/flow-pipeline` auto-merge clauses in `AGENTS.md` "Don'ts". Auto-run is
gated by the same `autoMerge` flag as step 10 — `flow feature create --no-auto-merge`
disables both.

**End-state matrix:**

| End-state | Step 11 behaviour |
|---|---|
| MERGED | Run the helper here (post-merge, pre-`flow-remove-worktree`); execute allowlisted+auto entries, note the rest, print `LOCAL FOLLOW-UPS:` block. |
| GATED | Documented in step 9 (`gated` decision branch): `flow-followups pr-body-upsert "$PR"` + `flow-followups run --note-only`. Print before `GATED: <url>`. |
| NEEDS HUMAN | Documented in `# Failure paths`: `flow-followups run --note-only` printed before `NEEDS HUMAN: <reason>`. |
| cancelled | Skipped — the worktree is being removed; pending follow-ups are intentionally lost. |

For MERGED, run the helper here and finalize. **Ordering is
load-bearing on two fronts:** (a) `flow-remove-worktree` deletes the
worktree, so both the follow-ups capture and the `flow-gate-summary`
render must happen BEFORE worktree removal; and (b) `flow-gate-summary`
records `phase: merged` internally, only after its block reaches stdout — so a render failure leaves state.json non-terminal and `flow-stop-guard`
keeps nudging, rather than marking a pipeline merged whose block the user
never saw:

```bash
flow-followups run > "$WORKTREE/.flow-tmp/followups-block.txt"  # executes auto-allowlisted entries; > captures the rendered block
SLUG="$FLOW_SLUG"       # for the state-file path
LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)
gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName > "$WORKTREE/.flow-tmp/pr-view.json"  # ONE gh pr view round-trip: diff-size + url/title/headRefName for the echo recap
IFS=$'\t' read -r PR_URL PR_TITLE PR_BRANCH < <(jq -r '[.url, .title, .headRefName] | @tsv' "$WORKTREE/.flow-tmp/pr-view.json")
jq '{additions,deletions,changedFiles,commits:(.commits|length)}' "$WORKTREE/.flow-tmp/pr-view.json" > "$WORKTREE/.flow-tmp/pr-changes.json"
flow-pipeline-summary --status merged --state-file ~/.flow/state/"$SLUG".json --pr-changes-file "$WORKTREE/.flow-tmp/pr-changes.json" --pr-review-result "$WORKTREE/.flow-tmp/pr-review-result.json" --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --consolidator-result "$WORKTREE/.flow-tmp/consolidator-result.json" --ci-wait-result "$WORKTREE/.flow-tmp/ci-wait-result.json" --followups-block-file "$WORKTREE/.flow-tmp/followups-block.txt" --filed-issues-file "$WORKTREE/.flow-tmp/filed-issues.txt" --intent-resolution "$WORKTREE/.flow-tmp/intent-resolution.json" --post-comment "$PR" --echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH" --lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)  # prints the echo recap (top of stdout) then the ## PIPELINE SNAPSHOT block ABOVE the gate-summary (emits NO sentinel); --post-comment additionally persists the snapshot as an idempotent PR comment (MERGED-only, best-effort)
COUNTS_LINE=$(flow-pipeline-summary --status merged --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)
flow-epic-membership --slug "$SLUG" --terminal-state merged  # epic-membership block (prints nothing for non-epic features)
flow-browser-teardown --reap --record  # registry-driven reap; records the outcome in state.json; always exits 0 — never blocks, never silently no-ops
TLDR="<one sentence, <=25 words, the user-visible outcome>"  # authored here, not derived
flow-gate-summary --status merged --pr-url "$PR_URL" --cleanup --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt" --tldr "$TLDR" --lens "$LENS" --untracked-file <(flow-untracked render --format gate --unfiled-only) --counts-line "$COUNTS_LINE"  # renders TLDR/STATUS/PR/NEEDS ATTENTION/MANUAL ACTION/UNTRACKED/count line/NEXT ACTION/CLEANUP + sentinel MERGED, then records phase: merged itself (after the block reaches stdout)
flow-notify --status merged --url "$PR_URL" --reason "$TLDR"
[ "$(flow-checkpoint --probe --site terminal | jq -r '.verdict')" = write ] && echo "Pipeline reached MERGED at $(date -u +%Y-%m-%dT%H:%M:%SZ)." > "$(flow-checkpoint --path)"; flow-checkpoint --site terminal >/dev/null  # best-effort, non-clobbering arm (stdout muted so the JSON verdict does not land beside the gate block); not armed at the merged-externally rows or the step-9 resume MERGED branch — nothing lost, the body is worktree-independent
flow-remove-worktree --delete-branch
```

Then echo the recap per [Gate-stage echo-verbatim
recap](#gate-stage-echo-verbatim-recap---echo-prose). **Discharging the
`advance-to-step-5` disclosure obligation, part 2:** `flow-pipeline-summary`
reads `--pr-title`/`--pr-url` and `--plan-file`, so a PR body carrying the
`Bundled:` Key decisions bullet (written in step 5 above) surfaces in this
recap automatically — no separate step is needed, but do not drop the
`--plan-file` flag from the call above, since that is what makes the
recap see it.

The helper silently suppresses the FOLLOW-UPS slot when the follow-ups
file is empty, so call sites do not stat the path first. End.

### `flow-foreclosed-paths` (PR-body `## Foreclosed Paths` upsert)

`flow-foreclosed-paths pr-body-upsert <PR>` persists the rejected
alternatives and anti-patterns the `/flow-pr-review` Fix-Applier and
Consolidator subagents recorded (`rejected_alternatives[]` +
`anti_patterns_found[]` from `fix-applier-result.json` and
`consolidator-result.json`) as a durable `## Foreclosed Paths` section in
the PR body. It surfaces the full prose, not just the counts the snapshot
shows. The section is built by the same shared formatter the terminal
`FORECLOSED PATHS` snapshot section consumes (markdown mode here,
plain-text mode there), so the two surfaces cannot drift — a unit-level
cross-surface parity test (`bin/lib/foreclosed-paths-format.test.ts`,
including the partial-degradation path) now guards that claim against a
fix-applier artifact with one off-shape entry. The upsert is
idempotent (replace-in-place via the shared heading-parameterized
primitive) and **no-ops** (exit 0, no `gh pr edit`) when there are no
foreclosed paths or the artifacts are absent — same no-op contract as
`flow-followups pr-body-upsert`. It is wired into step 9 next to the
existing `flow-followups pr-body-upsert "$PR"` call on both the
`auto-merge` and `gated` branches. **Persistence caveat:** the section
lives on the GitHub PR page (reviewer-visible, survives squash-merge on
the PR page) but does NOT reach `git log` / `git blame` — gh builds the
squash commit from concatenated commit messages, not the PR description.
Git-history persistence (a commit-message trailer or a committed file)
would be a separate change.

### `## PIPELINE SNAPSHOT` block (`flow-pipeline-summary`)

`flow-pipeline-summary` renders a `## PIPELINE SNAPSHOT` block ABOVE the `flow-gate-summary` block at the post-review terminal states (MERGED, GATED, NEEDS HUMAN) so the user reads one continuous terminal block: a phase-by-phase account, then the gate verdict. It is an LLM-free Bun helper that aggregates the structured artifacts the pipeline already writes and renders ONLY sourced facts across seven sections — CHANGES (commits/diff size from `gh pr view`), PHASES (`state.json`'s `phaseLog[]` written by `flow-state-update --phase`), INTENT (the `/flow-pr-review` Step 3.6 intent-mismatch verdict from `intent-resolution.json`, explicit `none` when the check never ran), FINDINGS (review verdict + fix-applier/consolidator counts + CI/Copilot outcome), FORECLOSED PATHS (the full prose of the fix-applier + consolidator rejected alternatives + anti-patterns, plain-text mode of the same shared formatter the PR-body `## Foreclosed Paths` section uses), FOLLOW-UP ISSUES (filed sweep URLs from `filed-issues.txt` + `/flow-pr-review` deferrals), and MANUAL STEPS (the captured `followups-block.txt` verbatim). Each section prints the literal `none` when its source is absent or empty (explicit-`none` discipline — never a fabricated "looks like it passed"). Degradation of the fix-applier-sourced FINDINGS `fixes:` and FORECLOSED PATHS slots is per-entry, not all-or-nothing: a partially-broken artifact (well-formed top-level keys, one off-shape entry) still renders every well-formed entry and appends a residual `(N unreadable)` marker for the dropped ones, while only a genuinely-unreadable artifact (non-JSON, non-object, or a missing/wrong-typed required top-level key) degrades the whole category to `(unreadable)` — never crashing the snapshot. The same shared formatter still backs both surfaces (so they cannot drift; the cross-surface parity test now also exercises this partial-degradation path). The block NEVER emits a `flow-stop-guard` sentinel (`MERGED` / `GATED:` / `NEEDS HUMAN:` / `cancelled`) — `flow-gate-summary` owns the sentinel as the byte-exact last line of stdout; the snapshot prints above it. v1 scope is the post-review terminal states only: the helper is wired at exactly the four post-review terminal `flow-gate-summary` sites (the step-11 MERGED block, the step-9 `gated` branch, both `merged-externally` renders, and the canonical `# Failure paths` NEEDS HUMAN block) and NOWHERE else — pre-review NEEDS HUMAN escalations (triage-ambiguous, worktree-create-failed, plan-missing) fire before any reviewable artifact exists, so wiring the snapshot there would print an all-`none` block of pure noise.

**Durable PR-comment persistence (MERGED-only, `--post-comment`).** The scrollback render is transient — close the tmux window or overflow the buffer and the snapshot is gone. On the MERGED terminal state, the three MERGED call sites (the step-11 block and both `merged-externally` renders) additionally pass `--post-comment "$PR"`, which posts the rendered `## PIPELINE SNAPSHOT` as a **top-level PR issue-comment** (not a review), so a merged PR carries its own pipeline provenance. The write is **idempotent**: the comment body is the rendered block plus a single-line HTML-comment marker (`<!-- flow-pipeline-snapshot-v1 -->`); the helper lists the PR's issue-comments, edits the marked one in place if present, and only creates a new one otherwise — a resume / watch-driven re-render replaces rather than duplicates. The marker lives ONLY in the posted comment body, never in stdout, so the scrollback render and the `flow-stop-guard`/auto-merge invariants are byte-for-byte unchanged. Persistence is **MERGED-only** (enforced inside the helper — `--post-comment` is ignored on `gated`/`needs-human` even if supplied), because a gated PR keeps churning and a snapshot comment would go stale while a merged PR is frozen. The write is **best-effort, never escalated** — a `gh` failure (or an empty `$PR`) is reported to stderr and never changes the exit code, the scrollback render, or the terminal verdict; this mirrors the "Failed auto-runs are reported, not escalated" rule below (a peripheral comment-post failure must not un-merge a PR).

**Remote-branch deletion is delegated to GitHub.** `flow-remove-worktree
--delete-branch` runs `git branch -d <branch>` locally only — it does not
push a delete to `origin`. The remote feature branch is reaped by
GitHub's `deleteBranchOnMerge` repo setting (Settings → General →
"Automatically delete head branches"), which fires server-side on
squash. flow assumes this setting is on; consumers who disable it must
either re-enable it or run `git push origin --delete <branch>` manually
after each merge.

**Failed auto-runs are reported, not escalated.** A non-zero exit code from
an allowlisted command (e.g. `flow install --upgrade` failed because of a
permission issue) is rendered in the printed block as `FAIL <command> (exit
N)` with a tail excerpt. The supervisor still ends with `MERGED` — the user
inspects scrollback. Escalating to `NEEDS HUMAN` would block a successful
merge on a peripheral failure, which inverts the priority.

**Canonical fast-forward.** `flow install --upgrade` opportunistically
fast-forwards the canonical install root before discovery — this fixes
the PR #115 race where freshly-merged skills got orphan-reaped because
the canonical checkout still had the pre-merge tree. On an advance the line
reads `flow updated: v<ver>, N commit`/`commits`, optionally suffixed
`, <beforeSha> → <afterSha>`; on a skip it reads `flow: content not
refreshed (<reason>)` — `dirty`, `non-default-branch`, `fetch-failed`,
`merge-failed`, `no-default-branch`, `not-a-git-repo`, or `repointed-source`
(the install-root guard already repointed `installRoot`, so the fast-forward
is skipped) — appearing in LOCAL FOLLOW-UPS before the symlink summary.
As a defense-in-depth layer for the dirty-canonical case,
`removeIfManagedSymlink` (in `bin/lib/symlink.ts`) now defers reaping a
dangling pointer when the recorded source still exists in
`origin/<default>`'s tree but not in the canonical working tree. Opt out
per-run with `flow install --upgrade --no-pull-canonical`; the followup
itself does NOT pass this flag — the allowlist exact-match is load-bearing.

**No new phase value.** Step 11 is bookkeeping inside `merging` (MERGED
path) or a final read just before the terminal print (GATED / NEEDS HUMAN).
Adding `local-followups` to `STEP_PHASES` would force a state.json write
that adds nothing — there's no resume scenario where the supervisor crashed
mid-step-11 and needs to know that.

### Gate-stage echo-verbatim recap (`--echo-prose`)

At each gate stage, AFTER running the helper, the supervisor extracts the
block between `<!-- flow-echo-recap:start -->` and `<!-- flow-echo-recap:end -->`
from the helper's stdout and **echoes it verbatim** as markdown bullets in its
own assistant message body. This is **prose, not tool output** — Claude Code
routinely truncates and collapses Bash tool results, so the two click targets a
returning user needs (the full PR URL and the absolute plan-file path) can be
folded away exactly when they are needed. Echoing the block as assistant prose
re-surfaces the PR URL after follow-up commits (a `/flow-pr-review` fix push or a
CI-fix loop) have scrolled the original PR-open message far up the buffer. The
supervisor's only job is to mirror the pre-rendered block — it does NOT restate
the fields from memory, paraphrase, reorder, or drop any of them; the block is
identical-by-construction (helper-computed), so when echoed it is always
complete and correct.

`--echo-prose` is wired at two helper surfaces. At the post-review PR-bearing
gates (MERGED / GATED / NEEDS HUMAN / merged-externally), `flow-pipeline-summary
--echo-prose` prepends the block at the **top** of its stdout, above the
`## PIPELINE SNAPSHOT` block — a new top section of the SAME single invocation,
NOT a new call between the snapshot and the `flow-gate-summary` gate block, so
the snapshot → gate-summary → phase-transition ordering and the byte-exact
final-line sentinel are untouched. At the AWAITING-APPROVAL gate (where no
reviewable artifact exists yet, so `flow-pipeline-summary` is intentionally not
wired), `flow-gate-summary --status awaiting-approval --echo-prose` emits the
block above its own no-sentinel two-bullet path block.

Each post-review gate site issues a SINGLE
`gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName`
round-trip into `"$WORKTREE/.flow-tmp/pr-view.json"`, then derives BOTH outputs
from that one blob via `jq`: the `pr-changes.json` diff-size object (same shape
as before) and the `url`/`title`/`headRefName` shell vars (`PR_URL` / `PR_TITLE` /
`PR_BRANCH`). It then passes
`--echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH"`
to the existing `flow-pipeline-summary` call. The PR-URL and plan-file bullet
lines carry **NO trailing punctuation** (terminals greedily extend URL
auto-detection through adjacent punctuation and break the click target); the
field-bearing bullets may carry normal punctuation.

The recap renders exactly this **bounded field set** and no more: PR URL,
absolute plan-file path, branch + PR number, PR title, current phase, CI verdict,
review verdict + finding count, and follow-up count. The set is pinned by a
`bin/skill-md-lint.test.ts` anchor so the recap stays a concise re-orientation
block, not a second snapshot. Absent fields render the literal `none` (the same
explicit-`none` discipline the snapshot uses).

Scope: the four post-review PR-bearing gates + AWAITING APPROVAL, and resume
re-entry into a gate state. NOT pre-review NEEDS HUMAN escalations
(triage-ambiguous, worktree-create-failed, plan-missing) — no PR/plan exists
there to echo.

# Resume mode

The supervisor enters resume mode when the seed prompt begins with
the literal prefix:

```
Use the /flow-pipeline skill in --resume mode for: <slug>
```

`flow feature resume <name>` writes that prompt; nothing else does.
On detecting it, **do not** start at step 1. Call `flow-resume-decide`
to walk the resume-from-disk decision tree:

```bash
RESULT=$(flow-resume-decide)
RESUME_AT=$(printf '%s' "$RESULT" | jq -r '.resumeAt')
REASON=$(printf '%s' "$RESULT" | jq -r '.reason')
WORKTREE=$(printf '%s' "$RESULT" | jq -r '.context.worktree // empty')
PR=$(printf '%s' "$RESULT" | jq -r '.context.pr // empty')
ANSWER=$(printf '%s' "$RESULT" | jq -r '.context.answer // empty')
CHECKPOINT_EXISTS=$(printf '%s' "$RESULT" | jq -r '.context.checkpointExists // empty')
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

**Checkpoint re-injection (persisted conversational state).** A fresh
process reconstructs the pipeline *step* from disk but drops any
instruction held only in chat. Before re-entering the resolved step,
check `$CHECKPOINT_EXISTS`: when `true` (a **usable** body — present,
non-empty, still fresh; slug-keyed, so it survives a worktree-less phase and
the `terminal` row re-injects too), resolve
`CHECKPOINT_PATH=$(printf '%s' "$RESULT" | jq -r '.context.checkpointPath // empty')`
and **read `$CHECKPOINT_PATH` BEFORE running `--consume`**, folding its
addenda into the re-entered step — honor the persisted approval
condition, redirect, or in-chat decision as if just given. Then run:

```bash
flow-checkpoint --consume
```

which retires the body — archiving it to `checkpoint.consumed.md` (same
directory, recoverable, never silently deleted), clearing the freshness record,
and deleting the one-shot `checkpoint.pending` marker so a later `/clear` does
not re-fire it. Skip the read-before-consume ordering and an addendum like
"approved with condition X" vanishes on the clear.

Branch on `.resumeAt`:

| `.resumeAt` | Action |
|---|---|
| `step-1` | Re-enter step 1's Intent interview (adaptive) sub-step. `.context.interview` carries `state.interview`'s persisted digest — re-render the frontier's `still-open` questions from it under their existing `Q<n>` ids (do NOT re-derive the frontier from scratch, and do NOT renumber) and continue the round protocol from `references/interview-playbook.md`. Step 1's ask-time write means a digest is present at every `triage-pending-interview` pause; an ABSENT one is a pre-fix state file (or a crash before the phase write landed), so re-derive the frontier from the original request and say so in the re-rendered round, rather than silently presenting renumbered questions as if they were the ones already on screen. |
| `step-2` | Re-enter step 2 (worktree). Recreate via `flow-new-worktree`. |
| `step-3` | Re-enter step 3 (plan). If `state.phase` was `plan-pending-interview`, re-render the battery from `.flow-tmp/interview-questions.md` on disk (the file, not `.context.interview`) instead of blindly re-invoking discovery; `.context.interview`, when present, carries only the prior triage-side digest as background context for framing the re-render, never the battery itself. Otherwise re-invoke `/flow-product-planning`. `!inputs.planExists`-guarded (the `plan-pending-interview` row in `bin/flow-resume-decide.ts`, identified by name rather than line number since the file reflows), so this row is discovery's own question gate only — the method pause (`references/blind-survey.md`) fires AFTER `plan.md` exists and lands on `step-4` instead, a safe, lossy degrade. |
| `step-4` | Re-enter step 4 (approval). Re-print the plan summary, then emit the same two markdown bullets as step 3's feature-intent end-condition (worktree absolute path + plan file absolute path, on their own lines as the last lines of the message, no trailing punctuation), and wait — never replay an approval the user gave to a now-dead session. |
| `step-5` | Re-enter step 5 (implement). Re-invoke `/flow-new-feature`. |
| `step-5.5` | Re-enter step 5.5 (re-symlink). Re-run `flow install --upgrade --source "$WORKTREE"` per step 5.5's end-condition (idempotent). |
| `step-6` | Re-enter step 6 (verify). Re-invoke `/flow-verify` inline (phase stays `verifying`; `/flow-verify` observes the worktree fresh, so a re-invocation is idempotent). |
| `step-7` | Re-enter step 7 (ci-wait). A `state.json` phase of `ci-wait` **or** `ci-wait-pending` (the yielded-while-waiting pending phase) both resolve here. **Read `$WORKTREE/.flow-tmp/ci-wait-result.json` first**: if it exists and parses, a prior `flow-ci-check` call already reached `decided` — read the persisted verdict and branch on `.decision` without re-running anything. Only when the file is absent or unparseable does the supervisor re-run `flow-ci-check` fresh (never re-launch the old poll loop — there is none; a `waiting` verdict re-arms the dumb `flow-ci-wait` waiter per step 7's wake ladder). |
| `step-8` | Re-enter step 8 (review). Re-invoke `/flow-pr-review <PR>`. |
| `step-9` | Re-enter step 9 (gate). Two sub-cases distinguished by `.reason`: `pr-merged-worktree-still-exists` (run step 11's MERGED branch — which re-runs `flow-pipeline-summary ... --echo-prose ...` and re-echoes the recap verbatim per the [Gate-stage echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose) subsection — then render the MERGED block via `flow-gate-summary --status merged ...` (same `--tldr`/`--lens` augmentation as step 11's MERGED block; records `phase: merged` itself, only after its block reaches stdout) and run `flow-remove-worktree --delete-branch`, end; **do not** fall through to step 10's `gh pr merge` on an already-merged PR) vs. `at-auto-merge-gate` (re-evaluate the gate via `flow-gate-decide`). |
| `gated-feedback` | Re-enter feedback mode for a `gated` PR carrying a checkpoint marker. Print `RESUMING AT: gated-feedback (gated-with-checkpoint-marker)`, re-inject `$CHECKPOINT_PATH` (the generic checkpoint re-injection above), then position to take a bug callout → route it through the `/flow-coder` interactive redirect → re-verify (step 6) → re-gate (step 9). **This loop introduces no new merge path and never merges on its own authority:** its re-gate re-enters the normal step 9 gate, which routes every merge through the existing `flow-merge-guard` backstop (Decision A1) — a still-`gated` PR ends terminally at `gated`; the only merge routes are the user ticking all Test Steps boxes (gate re-reads `auto-merge`, `flow-merge-guard` confirms zero-unchecked) or the existing gate-override token. Then `flow-checkpoint --consume` to retire the body (archive to `checkpoint.consumed.md`, clear the freshness record) and drop the one-shot marker. The loop's phase writes are exactly `verifying` (step 6) and `gating` (step 9) — the `/flow-coder` step itself writes no phase — and both are allowlisted in `TERMINAL_EXIT_TRANSITIONS` (`bin/lib/state.ts`) so they no longer trip the exit-4 terminal-regression guard. |
| `terminal` | Already in a terminal state. Re-run the corresponding gate render (the same helpers every gate-emission site uses) and end without re-running anything else. On `merged`/`gated` the render re-runs `flow-pipeline-summary ... --echo-prose ...` above `flow-gate-summary --status <merged\|gated> ...`, so the echo recap re-surfaces on resume re-entry — extract the `<!-- flow-echo-recap:start -->`…`<!-- flow-echo-recap:end -->` block and echo it VERBATIM per the [Gate-stage echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose) subsection (re-orientation is exactly the resume use case). `cancelled` has no PR, so `--echo-prose` is a no-op there. `needs-human` re-renders the escalation via `flow-gate-summary --status needs-human ...` (same `--tldr`/`--lens` augmentation as its originating render). The two no-in-flight-work pending phases short-circuit here pre-tree (reasons `no-change-investigation-complete` for `triaged-no-change`, `awaiting-triage-clarification` for `triage-pending-clarification`): they carry no PR/worktree and have no gate-summary status, so print a one-line note that the pipeline already completed (a no-change investigation, or one awaiting a clarification a resume can't re-ask) and end — do NOT build a worktree. On the `triaged-no-change` path, when `$ANSWER` is non-empty, re-print the saved `$ANSWER` (as markdown) so the user re-reads the original answer instead of the generic terminal note; fall back to the generic note when `$ANSWER` is empty. The re-rendered UNTRACKED row still accepts `file #N` / `drop #N` (`flow-untracked file|drop <N>`) on the very next reply — the resume terminal row is not read-only. |
| `escalate` | Escalate `NEEDS HUMAN: <.reason>` (e.g. `worktree-missing-on-resume`, `pr-closed-without-merge`). Leave the worktree + PR intact. |
| `abort` | The state file is missing. Escalate `NEEDS HUMAN: state-missing-on-resume` and end. |

On the `terminal` row, any post-render QA prose the resume turn adds (answering a user question after re-rendering the gate block) is formatted per `references/pause-output-contract.md` — labeled slots, no open prose, never a second block over the helper render (the re-rendered gate block already satisfies the contract).
<!-- any new pause site below must reference pause-output-contract.md -->

`flow-resume-decide` resolves `approval-pending-clarification` to
`step-4` (`bin/flow-resume-decide.ts` Row 4 — the phase is not in
`POST_APPROVAL_PHASES`) for both feature and `route-to-step-4`
non-feature pipelines alike: it is the phase step 4's Ambiguous branch
writes while awaiting the user's clarifying-question reply, so the
plain step-4 row above already covers it — no disambiguation marker is
needed.

## Edge cases (condensed from `references/failure-recovery.md` section (b))

These mirror the resume-table rows above; the full per-row precondition
table lives in `references/failure-recovery.md` section (b).

- **Worktree path recorded but the directory is gone.** Escalate
  `NEEDS HUMAN: worktree-missing-on-resume` — don't auto-recreate.
- **Worktree exists but state.json shows `phase: starting` /
  `triaging` / `worktree-create`.** Treat as resume-from-step-3 (the
  worktree was created but planning never advanced state).
- **`.flow-tmp/plan.md` exists but no PR.** Resume at step 4 (approval).
  The user may have approved before the crash; re-print the plan
  summary, emit the same two markdown bullets as step 3's
  feature-intent end-condition (worktree absolute path + plan file
  absolute path, last lines, no trailing punctuation), and wait for
  the user to re-confirm. Don't replay an approval the user gave to
  a now-dead session.
- **PR exists but state.json is stale (e.g. `implementing`).** Resume at
  step 6 (verify) — the PR survived; the phase didn't catch up.
- **PR `CLOSED` without merge.** Escalate `NEEDS HUMAN:
  pr-closed-without-merge`; let the user decide reopen vs. abandon.
- **Terminal phase (`merged` / `gated` / `needs-human` / `cancelled`).**
  Render the terminal block via `flow-gate-summary --status
  <merged|gated|needs-human|cancelled> ...` and end without re-running
  anything (`needs-human` sourced from `TERMINAL_PHASES` in
  `bin/lib/state.ts`, so a crashed escalation resolves `terminal`).
- **No-in-flight-work pending phase (`triaged-no-change` /
  `triage-pending-clarification`).** `flow-resume-decide` short-circuits
  these to `terminal` pre-tree — they carry no worktree, plan, or PR. On
  `triaged-no-change`, re-print the saved `$ANSWER` (from `.context.answer`)
  as markdown when non-empty; otherwise a one-line already-completed note.
  Do **not** fall through to step 2 and build a worktree.

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
  step 9's `MERGED` cleanup branch (render the MERGED block via
  `flow-gate-summary --status merged ...` — same `--tldr`/`--lens`
  augmentation as step 11's MERGED block above — which records
  `phase: merged` itself, only after its block reaches stdout), then
  run `flow-remove-worktree --delete-branch`, not step 10.
  The roadmap row was flipped to `✅ shipped (#$PR)` in the PR's own
  diff by `/flow-pr-review` step 7.5, so no post-merge sweep is needed.
- It does not rewrite state.json on entry. The first transition you
  make from your re-entry step is what updates phase.

# Resource cleanup (before any terminal state)

Before the supervisor reaches **any** terminal state — `MERGED`,
`GATED`, `NEEDS HUMAN`, or `cancelled` — every resource a pipeline step
or sub-skill spawned must already be torn down. A flow agent never
leaves a spawned resource running on the user's machine. Three named
layers, in order:

**Layer 1 — point-of-use teardown first.** Close what you opened on
every exit path, at the site that opened it:

- **Dev servers / launch subprocesses** — already torn down by the
  UI-smoke and UI-validation passes ("tear the launched server(s) down on completion").
- **chrome-devtools MCP pages/contexts** — the per-pipeline isolated page each browser pass opens is closed with `close_page` on completion and on every error/early-exit path, scoped to the page/context this pipeline opened. Contract in [references/ui-smoke-pass.md](references/ui-smoke-pass.md) "Teardown" and `/flow-pr-review`'s `references/ui-validation-evidence.md` "Teardown".
- **Playwright / headless browsers** — any repo headless browser an agent stood up (the Step 8c.iii fallback) exits when its Bash invocation returns.
- **Background processes** — anything launched `run_in_background` (the bounded `flow-ci-wait` waiter is the canonical case) reaches a terminal exit or is reaped before the pipeline ends, via `flow-spawn`'s registry (the wrapper process itself is unregistered and lives only for the wait's duration).
- **Agent-written env/config files** — any env/config file a browser/UI pass created is deleted on completion and on every error/early-exit path (see "Teardown" in [references/ui-smoke-pass.md](references/ui-smoke-pass.md)).

**Layer 2 — the guaranteed registry-first backstop.** `close_page`
never closes the Chrome process — chrome-devtools-mcp exposes no
browser-close tool. The pipeline runs
`flow-browser-teardown --reap --record` as a **standalone call**
(never `&&`/`;`-joined to the `flow-gate-summary` call after it — a
non-zero exit here is EXPECTED and must not block the render) before
EVERY terminal state, never `|| true`-swallowed (the helper always
exits 0). Registry-driven, falling back to the ancestry walk (SIGTERM
only, so THIS session's own server's `shutdown()` reaps its Chrome)
for what the registry missed. `--record` writes the verdict to
`~/.flow/state/<slug>.json` as `state.reap`, rendered by the following
`flow-gate-summary --cleanup` as the CLEANUP row. A post-teardown MCP
call in the same session degrades exactly as
`flow-ui-validate --mcp-absent`.

**Layer 3 — `flow reap`, the crash-path net, never the
primary.** `flow reap [--slug <s>] [--yes]` covers both registered
rows left by a session that crashed before reaching Layer 2 and
shape-heuristic strays (`--include-strays`) — report-only by
default, `--yes` required to act. Ad-hoc housekeeping only
(`docs/configuration.md`), never wired into a runbook step.

**Why Layer 2 is ancestry-scoped, not page-enumeration.** A **page-enumeration** sweep (`list_pages`-and-close) was evaluated and **deliberately not built**: parallel pipelines may share one un-isolated MCP server, so it cannot reliably tell this pipeline's page from a sibling's or the user's own Chrome, and would risk the exact harm it set out to prevent. **Process ancestry** does not share that failure mode — a sibling's server is a different session PID, and the user's own Chrome is never a descendant of this session's `claude` process. The operator-side `--isolated` MCP registration is complementary, not sufficient: its temp profile is cleaned up only *after* the browser closes, so it is gated on the very close `close_page` never performs. The same standing rule binds every agent in this repo — `AGENTS.md` `## Don'ts` "Don't leave spawned resources running".

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
documented retry budget; once exhausted, capture deferred follow-ups,
render the NEEDS HUMAN block via `flow-gate-summary` — which records
`phase: needs-human` itself, only after its block reaches stdout, so a
render failure leaves state.json non-terminal and `flow-stop-guard`
keeps nudging — **then** fire the notification. The existing
`# End conditions` sentinel contract is preserved either way (the
helper's final stdout line is the byte-exact sentinel
`NEEDS HUMAN: <reason>`):

```bash
flow-followups run --note-only > "$WORKTREE/.flow-tmp/followups-block.txt"  # captures the deferred LOCAL FOLLOW-UPS block (empty when log is empty)
SLUG="$FLOW_SLUG"                  # for the state-file path
LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)
ECHO_PROSE_ARGS=()  # echo-prose only on POST-review escalations (a PR exists); guard the field fetch + flags on [ -n "$PR" ] — pre-review escalations have no PR/plan
[ -n "$PR" ] && gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName > "$WORKTREE/.flow-tmp/pr-view.json"  # guard: some escalations precede PR creation; ONE gh pr view round-trip (diff-size + url/title/headRefName)
[ -n "$PR" ] && IFS=$'\t' read -r PR_URL PR_TITLE PR_BRANCH < <(jq -r '[.url, .title, .headRefName] | @tsv' "$WORKTREE/.flow-tmp/pr-view.json") && ECHO_PROSE_ARGS=(--echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH")
[ -n "$PR" ] && jq '{additions,deletions,changedFiles,commits:(.commits|length)}' "$WORKTREE/.flow-tmp/pr-view.json" > "$WORKTREE/.flow-tmp/pr-changes.json"
flow-pipeline-summary --status needs-human --state-file ~/.flow/state/"$SLUG".json --pr-changes-file "$WORKTREE/.flow-tmp/pr-changes.json" --pr-review-result "$WORKTREE/.flow-tmp/pr-review-result.json" --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --consolidator-result "$WORKTREE/.flow-tmp/consolidator-result.json" --ci-wait-result "$WORKTREE/.flow-tmp/ci-wait-result.json" --followups-block-file "$WORKTREE/.flow-tmp/followups-block.txt" --filed-issues-file "$WORKTREE/.flow-tmp/filed-issues.txt" --intent-resolution "$WORKTREE/.flow-tmp/intent-resolution.json" "${ECHO_PROSE_ARGS[@]}" --lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)  # prints the ## PIPELINE SNAPSHOT block ABOVE the gate-summary (and the echo recap on top when a PR exists); absent artifacts render as `none`
COUNTS_LINE=$(flow-pipeline-summary --status needs-human --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)
flow-epic-membership --slug "$SLUG" --terminal-state needs-human  # epic-membership block (no-op for non-epic features)
flow-browser-teardown --reap --record  # registry-driven; records outcome; always exits 0
TLDR="<one sentence, <=25 words, the user-visible outcome for <reason>>"  # authored here, not derived
flow-gate-summary --status needs-human --reason "<reason>" \
  --why "<one-line context>" --cleanup \
  --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt" \
  --tldr "$TLDR" --lens "$LENS" \
  --untracked-file <(flow-untracked render --format gate --unfiled-only) \
  --counts-line "$COUNTS_LINE"  # records phase: needs-human itself, after the block reaches stdout
flow-notify --status needs-human --reason "$TLDR" --tag "<reason>"
[ "$(flow-checkpoint --probe --site terminal | jq -r '.verdict')" = write ] && echo "Pipeline escalated to NEEDS HUMAN (<reason>) at $(date -u +%Y-%m-%dT%H:%M:%SZ)." > "$(flow-checkpoint --path)"; flow-checkpoint --site terminal >/dev/null  # terminal arm, stdout muted; MUST follow the flow-gate-summary call above — it appends a phaseLog entry as a side effect, so arming first is stale on arrival and `flow feature resume` would report no checkpoint here
```

On a POST-review escalation (a PR exists), after the helper runs, echo the
recap per [Gate-stage echo-verbatim
recap](#gate-stage-echo-verbatim-recap---echo-prose). PRE-review escalations
(triage-ambiguous, worktree-create-failed, plan-missing) have no PR/plan, so
`ECHO_PROSE_ARGS` stays empty and no recap is emitted.

The helper looks up the `NEXT ACTION` text from
`NEXT_ACTION_BY_REASON` in `bin/flow-gate-summary.ts` keyed off
`<reason>`, falling back to `DEFAULT_NEXT_ACTION` for unmapped tags;
the final line of stdout is the byte-exact sentinel
`NEEDS HUMAN: <reason>`. Do **not** call `flow-remove-worktree` on
escalation — leave the worktree + PR (and the JSONL log) intact so
the user can inspect and resume.

## No-retry escalation variants

Three escalations take a no-retry path with their own procedure. Each is
deterministically triggered and each has a full block in
`references/failure-recovery.md` § (c) No-retry escalation variants — read it
and execute its block rather than acting from memory.

| Trigger | Reason tag | Action |
|---|---|---|
| `flow-state-update` exits 3 | `branch-mismatch` | no retry — read `references/failure-recovery.md` § No-retry escalation variants and execute its block |
| `flow-state-update` exits 4 (a terminal→non-terminal write that is NOT an allowlisted `gated` exit) | `terminal-regression` | no retry — read `references/failure-recovery.md` § No-retry escalation variants and execute its block |
| `ToolSearch query="select:Task"` surfaces neither a `Task` nor an `Agent` schema at a spawn site | `task-tool-unavailable: <exemption-name>` | no retry — read `references/failure-recovery.md` § No-retry escalation variants and execute its block |

The full per-step cap table, the resume-from-disk decision tree, and the
three no-retry escalation variants' full procedures live in
`references/failure-recovery.md`.

# Mid-flight redirects

The user can type into the tmux chat at any phase boundary or
mid-phase. Apply `references/redirect-handling.md`:

- Affirmative input mid-phase → acknowledge, keep going.
- Imperative redirect → re-enter the relevant phase with the
  redirect appended to the next prompt. Verbatim — don't paraphrase.
- Cancel → wait for any in-flight atomic action (commit, push, merge) to
  finish, then close the PR if open, run `flow-remove-worktree`, run
  `flow-browser-teardown --reap --record` (registry-driven; standalone step,
  never `&&`-chained; always exits 0), then author `TLDR="Cancelled at
  your request; nothing further will run."` and render the CANCELLED
  block via `flow-gate-summary --status cancelled --cleanup --why "user
  cancelled mid-flight at $(jq -r .phase ~/.flow/state/$SLUG.json)"
  --tldr "$TLDR" --lens "$(jq -r '.output.lens // "pm"'
  ~/.flow/config.json 2>/dev/null)"` — which records `phase: cancelled`
  itself, only after its block reaches stdout (`checkWorktreeBranch`
  no-ops gracefully against the already-deleted worktree path, so the
  earlier `flow-remove-worktree` does not block the finalize) — then
  best-effort checkpoint, always AFTER that render, since arming first
  is stale on arrival (`flow-checkpoint --probe --site terminal`; on
  `write`, echo a one-line residue to `flow-checkpoint --path`'s
  target, then `flow-checkpoint --site terminal` to arm), end.
- Ambiguous → one clarifying question; if still unclear, escalate.

## Mid-flight code-change redirects

An imperative redirect splits into two kinds. A **scope/plan redirect**
("redo the plan with different scope") re-runs `/flow-product-planning` or
re-prompts the in-flight sub-skill. A **code-change redirect** ("rename
foo to bar", "change this line") arriving at a worktree-existing phase
(`plan-pending-review`, `implementing`, `verifying`, `ci-wait`,
`reviewing`) and NON-trivial takes the **interactive code-change redirect**
path: the supervisor composes a structured edit-set
`{file, intent, expected_outcome}` from the verbatim redirect, invokes
`/flow-coder` in-process, and reads `.flow-tmp/coder-result.json`
(`verify_status` + `summary`) exactly once — never the per-edit diff. A
trivial edit (≤1 file AND ≤30 LOC AND every file named in the redirect,
the same bar `/flow-new-feature` step 5 uses) stays inline. Do not collapse the
two paths. See `references/redirect-handling.md` for the per-phase matrix.

**Gated is an explicit carve-out, not a sixth in-flight phase.** `gated`
is terminal — it is deliberately NOT added to the
`plan-pending-review`/`implementing`/`verifying`/`ci-wait`/`reviewing`
list above. But a **bug callout at `gated`** (a code-change redirect
arriving while the PR sits at the gate during manual validation) still
routes through `/flow-coder`: compose the edit-set, invoke `/flow-coder`, then
re-verify (step 6) and re-gate (step 9). This preserves the
gated-is-terminal / no-new-merge-authority invariant — the re-gate
re-enters the normal step 9 gate and merges only through
`flow-merge-guard`; it is distinct from the post-verdict gate-override
*merge* path (a "merge this gated PR anyway" instruction), which stays
governed by "Gate override". The `gated-feedback` Resume-mode row above
is the auto-resumed entry into exactly this loop after a `/clear`. The
carve-out is mechanical, not only prose — `gated` is the only terminal
phase with a `TERMINAL_EXIT_TRANSITIONS` entry, and its three targets
are the only terminal→non-terminal writes `flow-state-update` accepts
without `--force`.

# Quick reference: phase values

In write-order on the happy path:

```
triaging
worktree-create
planning
plan-pending-review     (feature only; ends turn — pending phase)
checkpoint-pending-clear (feature only; ends turn — pending phase; step 4 auto-checkpoint before implement)
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
triage-pending-interview           (step 1 intent interview (adaptive) round)
approval-pending-clarification     (step 4 single clarifying question)
plan-pending-interview             (step 3 post-discovery question-gate round)
ci-wait-pending                    (step 7 yield while flow-ci-wait is backgrounded)
checkpoint-pending-clear           (step 4 auto-checkpoint at the approval → implement hand-off)
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
  via the eight named exceptions in "Hard rules" above:
  `/flow-pr-review`'s "Independent Multi-Agent Review",
  `/flow-product-planning`'s "Independent Discovery Subagent",
  `/flow-new-feature`'s "Independent Scout Subagent",
  `/flow-pr-review`'s "Fix-Applier Subagent",
  step 10's "Merge-Conflict Resolver Subagent",
  `/flow-coder`'s "Independent Edit-Applier Subagent",
  `/flow-pr-review`'s "Independent Gatekeeper Subagent",
  and `/flow-pr-review`'s "Independent Consolidator-Validator Subagent".
  No other skill or step may call Task.
- The supervisor never spawned a raw `claude -p` subprocess — only
  `flow-claude-headless` calls.

When the pipeline ends, scrollback contains exactly one of `MERGED`
/ `GATED: <url>` / `NEEDS HUMAN: <reason>` / `cancelled` on its own
line, and the corresponding `phase:` is in state.json.

When `FLOW_NOTIFY=1` is set in the supervisor's environment, every
terminal end-state (`merged`, `gated`, `needs-human`) is preceded
by a `flow-notify` call. The helper is a no-op when the env var is
unset, so the call is unconditional from the skill's perspective.
