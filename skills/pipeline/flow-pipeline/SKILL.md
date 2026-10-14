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
repo-only, not shipped) allows zero nesting exceptions — the eight
Task-tool exemptions in `.claude/rules/flow-supervisor-contracts.md` are each a flat, one-shot spawn; a
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
  `references/failure-recovery.md` section (b). See
  `references/phases/resume.md`.

# Hard rules

> **You are never a sub-agent.** Never call the `Task` / `Agent`
> tool from this skill — **except for the named exceptions below**.
> Never spawn a raw `claude -p` subprocess — the only sanctioned
> headless-Claude spawn is `flow-claude-headless` (a Bash fan-out, not a
> eighth exemption; contract in `references/headless-claude.md`). A
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
> Task.
>
> **Load the Task tool at each spawn site.**
>
> **A `SendMessage` continuation of a partial (`maxTurns`) agent stays inside its exemption — not an eighth site.** See `references/partial-result-continuation.md`.
>
> **Task-tool exemption #1: `/flow-pr-review` Independent Multi-Agent
> Review.**
>
> **Task-tool exemption #2: `/flow-product-planning` Independent Discovery
> Subagent.**
>
> **Task-tool exemption #3: `/flow-new-feature` Independent Scout
> Subagent.**
>
> **Task-tool exemption #4: `/flow-pr-review` Fix-Applier Subagent.**
>
> **Task-tool exemption #5: Merge-Conflict Resolver Subagent.**
>
> **Task-tool exemption #6: `/flow-coder` Independent Edit-Applier Subagent.**
>
> **Task-tool exemption #7: `/flow-pr-review` Independent Consolidator-Validator
> Subagent.**
>
> **Task-tool exemption #8: `/flow-verify` Independent UI-Driver Subagent.**
>
> **The `/flow-pr-review` Gemini cross-model lens is a Bash fan-out, not an
> eighth exemption.**

> **The Step-3 cross-model plan review is a
> Bash fan-out, not an eighth exemption.**

> **The Step-3 blind method survey is a
> Bash fan-out, not an eighth exemption.**

> **Headless Claude via `flow-claude-headless` is a Bash fan-out, not an
> eighth exemption.**

> **You never bypass the helper scripts.**

> **You only call `AskUserQuestion` from the one named form.** The
> supervisor's only authorised `AskUserQuestion` call is step 9's "Gate
> override (post-verdict, opt-in)" form (the single confirmation fired
> when the user instructs the supervisor to merge a `gated` PR anyway —
> the form is what makes a gate override a *fresh* confirmation,
> putting the gate verdict in front of the user rather than letting the
> supervisor infer authorisation from an earlier instruction).

> **You only auto-create GitHub issues from the named sites.**

> **You never silently retry past the documented caps.** Verify: 3
> outer attempts. CI-fix loop: 3 total. Review-fix loop: 2 total.
> Past these, escalate `NEEDS HUMAN: <reason>` and end. The
> per-step cap table is in `references/failure-recovery.md`.

> **You never edit code in the main repo's worktree.**

> **You never run `git branch -m` or `git switch <other-pipeline-branch>`.**

> **You write every scratch file under `$WORKTREE/.flow-tmp/`.**

> **You read flow's own docs with the Read tool, never awk or pattern-range sed.**
> `grep -n` the heading, then Read with offset/limit (or `sed -n 'N,Mp'`).
> Awk or pattern-range / in-place sed on skill, agent, or reference files
> can be flagged by Claude Code as an edit of a protected `.claude/` file
> and stall an unattended run for hours; flow's launch settings also deny it.

> **You anchor every tmux self-query on `$TMUX_PANE`.**

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
> `references/interview-playbook.md` governs the round shape); (8)
> the method pause (phase `plan-pending-interview`, a SECOND, distinct
> use of the same phase; see `references/blind-survey.md`); and (9)
> step 9's `browser-retry` pause (state writes `phase:
> browser-retry-pending`). Never decide a Step 8c outcome before Step 8c
> runs. Every
> other step transition stays in the
> same turn. Harness-level enforcement: `flow-stop-guard`
> (registered as a Claude Code Stop hook by `flow install`) reads
> `~/.flow/state/<slug>.json` and blocks any turn-end whose phase
> is not in this set. See "Harness-level enforcement (Stop hook)"
> below for the contract.

> Each rule's elaboration and each exemption's full contract: `references/hard-rules-detail.md`.

# Harness-level enforcement (Stop hook)

`flow-stop-guard`, a Claude Code Stop hook that `flow install` registers (`flow install --no-hooks` opts out), blocks a turn end while the pipeline is mid-flight and treats `stop_hook_active` as advisory. Pause only through a pending phase or the pause renderer (`flow-gate-summary` with `--reason <tag>`); a phase value is never a command.

# Notifications

At a terminal end-state (`MERGED`, `GATED`, `NEEDS HUMAN`), call `flow-notify` just before printing the end-state line; it is a no-op unless `FLOW_NOTIFY=1`.

```bash
flow-notify --status <merged|gated|needs-human> \
            [--reason "<one-line summary>"] \
            [--url "<pr-url>"] [--tag "<reason-tag>"]
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

## Phase dispatch

Each step's procedure lives in its own doc. On entering a step, Read its doc with the Read tool before acting; the one-liner here is only the floor if you have not. Phase values come from `STEP_PHASES` and `PENDING_PHASES` in `bin/lib/state.ts`; `PIPELINE_PHASES` also holds the terminals.

| Step | Phases | Non-negotiable | Doc |
|---|---|---|---|
| 0 — Echo | none | echo the request verbatim as the first output | `references/phases/step-00-echo.md` |
| 1 — Triage | `triaging`, `triage-pending-clarification`, `triage-pending-interview`, `triaged-no-change` | classify before any worktree; a question-only request ends in `triaged-no-change` | `references/phases/step-01-triage.md` |
| 2 — Worktree | `worktree-create` | `flow-new-worktree` creates it, never raw git | `references/phases/step-02-worktree.md` |
| 3 — Plan | `planning`, `plan-pending-interview`, `plan-review-pending` | the discovery agent authors the plan; helpers route and back-stop it | `references/phases/step-03-plan.md` + `shared-gate-contracts.md` |
| 4 — Approval | `plan-pending-review`, `approval-pending-clarification`, `checkpoint-pending-clear` | only a feature plan waits for approval | `references/phases/step-04-approval.md` + `shared-gate-contracts.md` |
| 5 — Implement | `implementing` | `flow-open-pr` opens the PR and records it | `references/phases/step-05-implement.md` |
| 5.5 — Install skills | `installing-skills` | runs only when the worktree adds skills or agents | `references/phases/step-05.5-install-skills.md` |
| 6 — Verify | `verifying` | three outer attempts, then `NEEDS HUMAN` | `references/phases/step-06-verify.md` |
| 7 — CI wait | `ci-wait`, `ci-wait-pending` | `flow-ci-check` decides; never hand-poll CI | `references/phases/step-07-ci-wait.md` + `shared-gate-contracts.md` |
| 8 — Review | `reviewing` | the `/flow-pr-review` result artifact's status decides the branch | `references/phases/step-08-review.md` |
| 9 — Gate | `gating`, `browser-retry-pending` | `flow-gate-decide` decides; never merge on prose judgment | `references/phases/step-09-gate.md` + `shared-gate-contracts.md` |
| 10 — Merge | `merging`, `merged` | merge only through `flow-merge-guard`, which re-checks the gate | `references/phases/step-10-merge.md` + `shared-gate-contracts.md` |
| 11 — Follow-ups | none | run only allowlisted follow-ups, then print the end-state line | `references/phases/step-11-follow-ups.md` + `shared-gate-contracts.md` |

## On-demand references

Open one only when its situation arises.

| Doc | Read when |
|---|---|
| `references/phases/shared-gate-contracts.md` | gate echo, TLDR, checkpoint contracts |
| `references/phases/resume.md` | resume seed or crash re-entry |
| `references/phases/resource-cleanup.md` | before any terminal state |
| `references/phases/failure-paths.md` | any escalation or retry cap |
| `references/phases/mid-flight-redirects.md` | user redirects a running pipeline |
| `references/hard-rules-detail.md` | a rule's elaboration, Stop hook, notifications |
| `references/auto-merge-rubric.md` | step 9 gate rubric |
| `references/blind-survey.md` | step 3 blind method survey |
| `references/failure-recovery.md` | escalation tags, retry caps |
| `references/headless-claude.md` | `flow-claude-headless` fan-out |
| `references/interview-playbook.md` | intent interview rounds |
| `references/merge-resolver-spawn-prompt.md` | merge-conflict resolver spawn |
| `references/model-routing.md` | per-phase model choice |
| `references/partial-result-continuation.md` | partial `maxTurns` agent result |
| `references/pause-output-contract.md` | rendering any pause message |
| `references/polling-protocol.md` | waiting on CI or agents |
| `references/prompt-sanity.md` | step 1 prompt checks |
| `references/redirect-handling.md` | handling a user redirect |
| `references/skill-overlay.md` | step 5.5 skill sync |
| `references/solution-fit.md` | step 1 solution-fit check |
| `references/step3-threading.md` | step 3 backstop detail |
| `references/ui-smoke-pass.md` | UI changes, smoke pass |

## After a compaction or resume

A compaction keeps only the first ~20,000 characters of this skill: this core is sized to survive it whole, the step docs are not. If this skill is not in your context, invoke it again. On a `--resume mode` seed, Read `references/phases/resume.md` and run `flow-resume-decide` instead. Otherwise read `phase` from `~/.flow/state/<slug>.json`, find it in the table above, and Read that step's doc before you act. Never continue a step from a summary alone.

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
PR not yet merged):`) block written by step 11 — see `references/phases/step-11-follow-ups.md`
for when it appears. The `cancelled` line is never preceded by a
follow-ups block.

After printing the end-condition line, **end the turn**. The tmux
window stays open with full scrollback. The user closes it later
with `flow done <name>`.
