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
> Never spawn a separate `claude -p` subprocess. (This binds the
> supervisor and its sub-agents and is NOT relaxed; a standalone leaf
> skill like `/flow-research` run directly firing `claude -p` is a
> separate context this rule never governed.) The supervisor's
> only fan-out is (a) loading sub-skills in-process, (b) Bash tool
> calls, and (c) the nine narrowly-named Task-tool exceptions that
> follow.
>
> The two constraints behind the rule above are (1) sub-agents can't
> spawn sub-agents (one-level cap) and (2) a long-running supervisor
> with sub-agents would bloat past the context window. The supervisor
> is itself a top-level Claude Code session (started by `flow new`
> opening tmux + `claude`), so constraint (1) does not apply to *its*
> Task calls — it applies to *its* sub-agents. All nine exemptions
> below are also one-shot, not long-running, so constraint (2) doesn't
> apply either. They are the **only nine** authorised Task-tool
> fan-out sites from this supervisor; no other skill or step may call
> Task. Each is anchored on its step heading name rather than its
> number so it survives future renumbering. Same narrow-and-named
> contract as the `/pr-review` auto-push and `/flow-pipeline`
> auto-merge exemptions in `AGENTS.md`. If a future skill needs the
> same license, add it here by name rather than generalising the rule.
>
> **Load the Task tool at each spawn site.** Each of the nine spawn
> procedures below must instruct the supervisor to load the Task
> tool schema via `ToolSearch query="select:Task"` *before* invoking
> Task (or its alias `Agent`). In Claude Code sessions where neither `Task` nor its alias `Agent` is
> surfaced top-level by the harness (both are aliases of the same
> one-shot subagent-spawn primitive: identical `subagent_type` /
> `prompt` / `description` schema), an unguarded invocation silently
> falls through to in-line execution — exactly the regression PR #124
> introduced and which this preamble prevents recurring. On missing
> schema, escalate `NEEDS HUMAN: task-tool-unavailable: <exemption-name>`
> rather than falling back to in-line execution; the fan-out's value
> is its context isolation, and an in-line fallback breaks the
> contract that each exemption is justified by. See each exemption's
> spawn procedure for the canonical "Load the Task tool before
> spawning" paragraph and `# Failure paths` below for the escalation
> script. This is a sibling note to the nine exemption blocks below,
> not a tenth exemption.
>
> **Task-tool exemption #1: `/pr-review` Independent Multi-Agent
> Review.** When the supervisor invokes `/pr-review` in step 8,
> `/pr-review`'s "Independent Multi-Agent Review" step spawns six
> review agents in parallel via the Task tool. The multi-agent review
> is one-shot (six parallel agents return JSON findings, then the
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
>
> **Task-tool exemption #5: Merge-Conflict Resolver Subagent.** When
> step 10 (`Merge`) fires `gh pr merge --squash` and the call returns
> a conflict-class failure (stderr matches the documented detection
> patterns in `references/merge-resolver-instructions.md`), the
> supervisor spawns one merge-conflict resolver subagent via the
> Task tool to handle the rebase + per-file conflict resolution +
> force-push inside its own isolated context. After the subagent
> returns, the supervisor retries `gh pr merge --squash` exactly
> once; on second failure, escalates `NEEDS HUMAN: merge-failed`
> with the resolver's summary first sentence appended to the reason.
> The same two rationales apply — top-level Task call (constraint 1
> doesn't apply), one-shot fan-out (constraint 2 doesn't apply) —
> plus the additional context-cost win that the rebase output, the
> per-file resolution prose, and the force-push transcript all stay
> inside the subagent. Without this fan-out the supervisor would
> resolve conflicts inline at the latest, most token-expensive point
> in the pipeline, where the supervisor still has the post-merge
> sweep, step 11's local-follow-ups, and the terminal-state print
> left to do. Force-push is permitted because the resolver runs as
> a Task-tool fan-out inside `/flow-pipeline`'s existing auto-merge
> umbrella, and is scoped to the per-pipeline branch only — never
> the base branch. The only handoff to the supervisor is the
> structured artifact at `<worktree>/.flow-tmp/merge-resolver-result.json`
> (typed fields: `resolved_files`, `ambiguous_resolutions`,
> `rejected_strategies`, `commits`, `force_push_status`, `summary`),
> which the supervisor reads once before retrying `gh pr merge`. The
> contract is documented bidirectionally in
> `references/merge-resolver-instructions.md` (the subagent's
> instructions) and `AGENTS.md` `## Don'ts`. Exactly one resolver
> fan-out per `/flow-pipeline` run; if the post-resolver retry still
> fails, escalate rather than re-fanning-out.
>
> **Task-tool exemption #6: `/coder` Independent Edit-Applier Subagent.**
> When `/flow-pipeline` step 5 loads `/new-feature` (or step 6 loads
> `/verify`, or any pipeline step loads `/refactoring`) and the
> wider-scope path of any of these skills' hybrid thresholds
> fires — or when the `/flow-pipeline` supervisor's
> interactive code-change redirect path fires (a non-trivial code-change redirect at a
> worktree-existing phase; see the "Mid-flight code-change redirects"
> section and `references/redirect-handling.md`) — the wrapper invokes
> `/coder` in-process; `/coder` itself spawns
> one edit-applier agent via the Task tool to apply the caller's edit-set,
> run `flow-pre-commit --json` against the post-edit worktree, and write
> a structured artifact at `<worktree>/.flow-tmp/coder-result.json` (typed
> fields: `edits`, `verify_status`, `rejected_alternatives`,
> `anti_patterns_found`, `summary`). Trivially scoped edits skip the
> subagent via each caller's own hybrid threshold (`/new-feature` step 5:
> ≤1 file AND ≤30 LOC AND every file named in the prompt; `/verify` step
> 3: single-line type/lint error in one file; `/refactoring` step 3: same
> bar as `/new-feature` step 5) and proceed inline. The
> three thresholds are caller-defined — see each skill's "Spawn procedure
> (wider-scope path only)" section for the canonical bar. The same two
> rationales apply — top-level Task call (constraint 1 doesn't apply),
> one-shot fan-out (constraint 2 doesn't apply) — plus the additional
> context-cost win that the per-edit `Edit`/`Write` tool_use bytes and
> diff-bearing tool_result text all stay inside the subagent. The
> in-context verify re-run is load-bearing: type/lint/test failures caused
> by an edit surface where the rationale is still live, rather than after
> the subagent exits when the parent caller sees a verify failure later
> with no intent context. The only handoff to downstream callers is the
> structured artifact, which `/new-feature` step 5, `/verify` step 3, and
> `/refactoring` step 3 read once and reuse. The contract is documented bidirectionally in
> `skills/pipeline/coder/SKILL.md`'s "Independent Edit-Applier Subagent"
> section and `AGENTS.md` `## Don'ts`.
>
> **Task-tool exemption #7: `/pr-review` Independent Gatekeeper Subagent.**
> When `/flow-pipeline` step 8 loads `/pr-review` and `/pr-review` reaches
> its "Independent Gatekeeper Subagent" step (Step 1.5), one gatekeeper
> agent is spawned via the Task tool with a per-spawn `model: "haiku"`
> override. This is the first Task-tool exemption justified primarily by
> **cost-routing** rather than primarily by context isolation — the Task
> tool's per-spawn `model: "sonnet"|"opus"|"haiku"` enum lets this spawn
> site downgrade from Sonnet to Haiku, short-circuiting the four-agent
> Sonnet fan-out on closed/merged/trivial/no-new-commits PRs that
> deterministic skip rules can rule out from a single `gh pr view --json
> state,isDraft,additions,deletions,commits,author` metadata fetch.
> Context-isolation still holds — the metadata fetch and the skip-rule
> eval don't pollute the supervisor's transcript — but it's the secondary
> win. The same two rationales apply — top-level Task call (constraint 1
> doesn't apply), one-shot fan-out (constraint 2 doesn't apply) — plus the
> cost-routing override the per-spawn `model: "haiku"` enum enables. The
> only handoff to the wrapper is the structured artifact at
> `<worktree>/.flow-tmp/gatekeeper-result.json` (typed fields:
> `decision`, `reason`, `skip_kind?`, `summary`); the wrapper reads it
> once and branches: `"skip"` writes a well-formed
> `pr-review-result.json` with `status: "clean"` and `completed_steps:
> ["1", "1.5"]` so `/flow-pipeline` step 8's branch-on-`.status` logic
> sees a clean result and proceeds normally to the auto-merge gate;
> `"proceed"` continues to Step 2 unchanged. On missing Task-tool schema
> at the Step 1.5 spawn-site preamble, the escalation tag is
> `task-tool-unavailable: pr-review-gatekeeper` — propagated by
> `/pr-review` through `pr-review-result.json` and consumed verbatim by
> step 8's branch-on-`.status` logic. The contract is documented
> bidirectionally in `skills/pipeline/pr-review/SKILL.md`'s "Independent
> Gatekeeper Subagent" section and `AGENTS.md` `## Don'ts`.
>
> **Task-tool exemption #8: `/pr-review` Independent Consolidator-Validator
> Subagent.** When `/flow-pipeline` step 8 loads `/pr-review` and
> `/pr-review` reaches its "Independent Consolidator-Validator Subagent"
> step (Step 3.5), one consolidator-validator agent is spawned via the
> Task tool — context-isolation primary, with second-opinion validation
> as a new capability on top. Unlike exemption #7 (Gatekeeper), this
> spawn site does NOT use the `model: "haiku"` override; default Sonnet
> is used because the second-opinion validation pass needs the larger
> model's judgment. The same two rationales apply — top-level Task call
> (constraint 1 doesn't apply), one-shot fan-out (constraint 2 doesn't
> apply) — plus the additional context-cost win: per-finding
> second-opinion prose, the six per-agent JSON output reads, and the
> dedup-by-clustering reasoning all stay inside the subagent rather
> than polluting `/pr-review`'s wrapper context. The only handoff to
> the wrapper is the structured artifact at
> `<worktree>/.flow-tmp/consolidator-result.json` (typed fields:
> `consolidated_findings`, `dropped_by_validation`,
> `rejected_alternatives`, `anti_patterns_found`, `summary`), which
> `/pr-review`'s Step 4 reads once and reuses across Steps 4–7. On
> missing Task-tool schema at the Step 3.5 spawn-site preamble, the
> escalation tag is `task-tool-unavailable: pr-review-consolidator-validator`;
> on schema-failure or missing-artifact post-spawn, the tags are
> `consolidator-schema-failure` / `consolidator-missing-artifact`
> (propagated by `/pr-review` through `pr-review-result.json` and
> consumed verbatim by step 8's branch-on-`.status` logic). The
> contract is documented bidirectionally in
> `skills/pipeline/pr-review/SKILL.md`'s "Independent
> Consolidator-Validator Subagent" section and `AGENTS.md` `## Don'ts`.
>
> **Task-tool exemption #9: Verify-Retry-Loop Subagent.** Step 6
> (`Local verify`) spawns one verify-retry-loop subagent via the Task
> tool to own the 3-outer-attempt `/verify` loop in its isolated
> context: each retry re-invokes `/verify` and re-pastes the prior
> attempt's `flow-pre-commit --json` `failure` object, and the loop also
> owns the Layer-3 `.flow/pre-commit.json` config-authoring branch and
> the UI-smoke pass. Without this fan-out the re-pasted failure JSON
> accumulates in the supervisor's own transcript across all three
> attempts — the one measured unbounded supervisor-context offender
> (every other expensive phase already fans out to a subagent or is
> capped). The same two rationales apply — top-level Task call
> (constraint 1 doesn't apply), one-shot fan-out (constraint 2 doesn't
> apply) — plus the context-cost win that the failure-JSON re-paste and
> `/verify`'s in-process prose stay inside the subagent. The only handoff
> is the structured artifact at
> `<worktree>/.flow-tmp/verify-loop-result.json` (typed fields
> `verify_status`, `attempts`, `config_authored`, `ui_smoke`,
> `final_failure_excerpt?`, `rejected_alternatives`,
> `anti_patterns_found`, `summary`), which the supervisor reads once and
> branches on: `pass` continues to step 7, `exhausted` escalates
> `verify-exhausted` and writes the `> [!CAUTION]` PR-body block from
> `final_failure_excerpt`. The contract is documented bidirectionally in
> `references/exemption-contracts.md` and `AGENTS.md` `## Don'ts`, with
> the subagent's full instructions at
> `skills/pipeline/flow-pipeline/references/verify-loop-instructions.md`.
>
> **The `/pr-review` Gemini cross-model lens is a Bash fan-out, not a
> tenth exemption.** When the supervisor invokes `/pr-review` in step 8
> and the consumer has opted into `review.gemini`, `/pr-review` Step 3
> runs ONE additional cross-model reviewer (Gemini) via `flow-delegate`
> (agy) as a Bash subprocess (`flow-gemini-lens`), ALONGSIDE exemption
> #1's six-agent Multi-Agent Review Task fan-out. It spawns no Task, so
> the nine-exemption count above is unchanged — this is a sibling note in
> the same F2 "not a tenth exemption" shape as the "Load the Task tool at
> each spawn site" guard above, NOT a `#10` exemption block. The lens is
> config-gated, default off, and a graceful skip on any failure (it never
> hard-fails the review). Documented bidirectionally in `AGENTS.md`
> `## Don'ts` and `skills/pipeline/pr-review/SKILL.md` Step 3.

> **You never bypass the helper scripts.** Always call
> `flow-new-worktree`, `flow-remove-worktree`,
> `flow-fetch-pr-review`, `flow-reply-pr-comments`, and
> `flow-followups` rather than reimplementing their behaviour with
> raw `git` / `gh` calls. The helpers handle edge cases (existing
> worktrees, branch collisions, review-comment ID mapping,
> allowlist enforcement on auto-run) that are easy to get wrong.

> **You only call `AskUserQuestion` from the two named forms.** The
> supervisor's only authorised `AskUserQuestion` calls are (a) the
> **candidate-issues form** (the multi-select for picking which
> orthogonal candidates to file post-merge) and (b) step 9's "Gate
> override (post-verdict, opt-in)" form (the single confirmation fired
> when the user instructs the supervisor to merge a `gated` PR anyway —
> the form is what makes a gate override a *fresh* confirmation,
> putting the gate verdict in front of the user rather than letting the
> supervisor infer authorisation from an earlier instruction). The
> candidate-issues form fires from **two locations** — step 4's
> "Candidate follow-up issues sub-step" (the Affirmative branch) AND
> step 3's "Candidate follow-up issues sub-step (non-feature intents)"
> on the `advance-to-step-5` branch — but it is **one** named form, not
> two: the distinct named forms stay at two (candidate-issues +
> gate-override), no third site. Same narrow-and-named contract as the
> Task-tool exemptions above: `AskUserQuestion` is a different primitive
> (synchronous user prompt, not a sub-agent fan-out), but a small named
> set keeps the supervisor's user-prompt surface auditable. These two
> forms are the **only** authorised user-prompt surface — no other
> skill or step may call `AskUserQuestion`. If a future skill needs the
> same license, add it here by name rather than generalising the rule.

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
> triaged-no-change`); (5) step 7's CI-wait yield, where the
> supervisor runs the long-running `flow-ci-wait` call backgrounded
> (it persists its verdict to `$VERDICT_FILE`); if turn-end arrives
> before the verdict file lands, the supervisor writes `phase:
> ci-wait-pending` and ends the turn cleanly rather than hand-rolling
> a discouraged manual poll loop (see step 7 for the yield-and-resume
> contract). Every other step
> transition stays in the same turn. Harness-level enforcement:
> `flow-stop-guard`
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
  `cancelled`) or the five pending-end phases
  (`plan-pending-review`, `triaged-no-change`,
  `triage-pending-clarification`, `approval-pending-clarification`,
  `ci-wait-pending`).
- Self-detects: exits 0 (no-op) outside tmux, in non-flow tmux
  windows (no `@flow-slug` set), or when state.json is missing.
  Safe to install in a global Stop hook list.
- Loop-break budget: the hook owns its own per-turn block counter,
  persisted at `~/.flow/state/turns/<slug>.json` (a sibling
  subdirectory so `flow ls` does not see it as a phantom pipeline).
- Legitimate pending exits do NOT consume the budget — phase=
  `plan-pending-review` / `triaged-no-change` /
  `triage-pending-clarification` / `approval-pending-clarification` /
  `ci-wait-pending` all exit 0 without incrementing the counter.
- `stop_hook_active` is treated as advisory (used to detect turn
  boundaries via `false`-on-first-stop) rather than authoritative
  budget.
- Stagnation detection: once the budget is exhausted (blockCount ≥
  TURN_BLOCK_LIMIT), subsequent stops exit 0 only when phase has
  advanced since the last block; otherwise stagnation re-engages and
  exits 2 with a "phase has not advanced" reminder.
- Loop-break breadcrumb: when the hook exits 0 via the phase-advance
  loop-break path, it writes a single line to stderr
  (`flow-stop-guard: loop-break consumed; subsequent stops will not
  be blocked this turn …`) that Claude Code surfaces on the next
  turn-start.

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

**First action of the supervisor.** Extract the pipeline slug from the
first line of this seed prompt before any bash calls. The first line
of every seed has the form `[pipeline-slug: <slug>]` — parse the
literal `<slug>` value from it and embed it inline in the two calls
below. The slug is a concrete string (e.g. `csv-export`), not a shell
variable that persists across tool calls.

Write the phase to state.json so `flow ls` immediately shows `triaging`
instead of the stale `starting` from `flow new`. Pass `--slug <slug>`
explicitly so the state write is not subject to `resolveSlugFromPane()`'s
ambient-pane resolution, which may race against a parallel pipeline's
window during the brief window between window creation and the first
`@flow-slug` option set:

```bash
flow-state-update --phase triaging --slug <slug>
```

**No-state-file guard (never work inline on the base branch).** If this
first `flow-state-update --phase triaging` exits non-zero with a `no state
file` error *while the pane resolves `@flow-slug` from `$TMUX_PANE`* — i.e.
the supervisor is genuinely inside a `flow new`-created window — this is the
`flow new` state-write race (the parent's `phase: starting` write has not
landed yet), **not** a direct/manual invocation. The supervisor must **not**
fall through to classifying or implementing inline on the base branch.
Retry `flow-state-update --phase triaging --slug <slug>` a bounded ~3 times
with a short backoff; if it still fails, escalate `NEEDS HUMAN:
state-file-missing-on-start` and end the turn. The escalation may itself be
unable to write `phase: needs-human` (there is no state file to update), so
the supervisor prints the `NEEDS HUMAN: state-file-missing-on-start` line and
ends — `flow-stop-guard` already no-ops when state.json is missing, so the
turn-end is permitted. (`flow new` now writes `phase: starting` before it
delivers the seed, so this guard is defense-in-depth against a residual
slow-filesystem window or a future regression, not the common path.)

Then set a readable tmux window title so the user can scan their
status bar at a glance instead of squinting at the slug. The slug
stays the canonical lookup key (it's stored in tmux's `@flow-slug`
user option, set when `flow new` created the window) — the rename
only changes the display. Pass `--slug <slug>` here for the same
reason as above: the explicit slug avoids the pane-resolution race:

```bash
flow-rename-window --slug <slug> "<short descriptive title>"
```

**Only these two step-1 calls use `--slug`.** All other helpers after
step 1 continue to use auto-resolution (`resolveSlugFromPane`) because
by then `@flow-slug` is reliably set on the window.

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

Before classifying, ladder up from the surface request to the
underlying problem / friction / efficiency-gain it serves — what the
user ultimately wants fixed, unblocked, or sped up — using the Ladder
Up technique in
`skills/pipeline/product-planning/references/discovery-playbook.md`
(reference it; don't duplicate it here). Infer the **ultimate goal**
and state it in **one line** in chat, then carry it in your context
through to step 3.

Laddering up is the default framing move; the same playbook carries a
broader set of **framing lenses** — internal-only Five Whys,
Jobs-to-be-Done, first-principles, inversion, pre-mortem, and
second-order effects — for the case where a request is at the right
altitude but still mis-framed. They are **conditional and internal**:
reach for one only when framing is genuinely in doubt, keep it internal
reasoning (never an interrogation, never an emitted/performed section),
and skip them on expert-specified / trivial / time-critical asks.

This is the triage-side entry point for the AGENTS.md `## Output style`
rule **Understand the ultimate goal behind the request, not just the
literal ask.**, and it is **conditional**: do NOT ladder up
expert-specified / trivial / time-critical requests — state the goal in
one line and move on. Infer-and-proceed is the default, weighted heavily
toward proceeding: flow PRs are gated and revertible, so the "offer
both" move — proceed on the most-likely goal and surface the considered
alternative in the PRD and the PR `## Why` (gated at
`plan-pending-review` for feature intent) — beats stopping to ask. Route
non-blocking goal ambiguity to those always-present artifacts, not to a
kickoff question.

**The one question (rare).** Ask exactly one focused goal-framing
question ONLY when no defensible one-line goal can be stated even after
laddering up (the request admits materially-different underlying goals
that would yield materially-different plans) AND guessing wrong would be
costly or hard to reverse. When that bar is met, reuse the existing
mechanism — don't invent a parallel one: write `flow-state-update
--phase triage-pending-clarification`, ask the single question, and end
the turn. The next turn re-enters step 1 with the reply; if it is still
ambiguous, escalate `NEEDS HUMAN: triage-ambiguous` (as in the Ambiguous
branch below) rather than asking twice. Never ask mid-run, and never
interrogate with a chain of "why" — the laddering is internal reasoning,
so emit no ceremonial goal/root-cause section.

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
  then write the phase and persist the answer via a quoted heredoc on
  stdin before ending the turn:

  ```bash
  flow-state-update --phase triaged-no-change --answer-stdin <<'EOF'
  <the answer just given to the user>
  EOF
  ```

  The phase write is what `flow-stop-guard`
  reads to recognise the legitimate stop; the quoted-heredoc + `--answer-stdin`
  stdin transport persists the answer verbatim — immune to shell expansion
  and to argv parsing of a leading `--`, so a markdown answer with backticks,
  `$(...)`, or a leading `---` round-trips byte-for-byte (the prior
  `--answer "<text>"` double-quoted-arg form mangled those). The answer is
  persisted for re-surfacing on resume, since a no-change pipeline has
  no worktree to store it under. Do NOT proceed to step 2.
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
  `flow-new-worktree` enforces this contract mechanically: passing
  a positional slug that doesn't match the pane's `@flow-slug` exits
  non-zero with `slug-mismatch:` rather than silently creating a
  misnamed worktree (the PR #152 footgun).
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

The positional `<slug>` here is belt-and-suspenders: `flow-new-worktree`
reads `@flow-slug` from the pane itself, so a bare `flow-new-worktree`
(no positional) would resolve to the same value. Passing a positional
that doesn't match `@flow-slug` is a hard error (`slug-mismatch:`,
exit 2) rather than a silent footgun — see step 1's "never re-derives
the slug" contract.

Capture the absolute worktree path it prints. Set `$WORKTREE` to
this for the rest of the pipeline. **`cd` into the worktree** —
every subsequent step runs from there.

Now record the worktree path in state.json (the only step where
`--worktree` is set):

```bash
flow-state-update --phase worktree-create --worktree "$WORKTREE"
```

**Runtime `/add-dir` fallback (best-effort, never-blocking).** `flow new`
already pre-authorized the *deterministic* worktree path as a chrome-devtools
MCP workspace root at launch (`claude --add-dir <repo-parent>/<repo>-<slug>`),
so screenshot evidence in step 8c can write to
`<worktree>/.flow-tmp/ui-evidence/` instead of falling back to the session
cwd (issue #317). But when `flow-new-worktree` hit a collision and
auto-suffixed the directory (`-2`/`-3`/…), the **actual** `$WORKTREE` diverges
from the path `flow new` pre-authorized. To cover that divergence, issue a
runtime `/add-dir "$WORKTREE"` now (the slash-command form a running Claude
Code session uses to add a workspace root mid-session) so the *actual*
worktree is authorized regardless. This is purely a reliability nicety for the
supplementary screenshot artifact: the a11y snapshot remains the evidence
gate, and if the runtime `/add-dir` is unavailable or does not propagate to
the MCP server, the screenshot save-path cascade's session-cwd fallback still
applies (see `/pr-review` `references/ui-validation-evidence.md`). Never block
or escalate on it.

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

Fold the **ultimate goal** you inferred in step 1's goal-framing
sub-step into this invocation as explicit context (append it after the
verbatim request), so the isolated Discovery Subagent anchors the PRD
Problem Statement on it instead of re-deriving from the surface request
alone. Discovery still validates the supplied goal against the codebase
and surfaces an Open Question if it disagrees rather than accepting it
blindly — see `discovery-instructions.md` §3 ("User intent").

`/product-planning` is itself a thin wrapper that spawns one
**Independent Discovery Subagent** via the Task tool (the second of
the nine named Task-tool exemptions in "Hard rules" above). The
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
  immediately before ending the turn, render the AWAITING APPROVAL
  block via `flow-gate-summary` so the header rows precede the two
  markdown bullets the user clicks:

  ```bash
  flow-gate-summary --status awaiting-approval --echo-prose \
    --why "plan ready for review (intent=feature)" \
    --worktree "$WORKTREE" \
    --plan-file "$WORKTREE/.flow-tmp/plan.md"
  ```

  Then extract the block between `<!-- flow-echo-recap:start -->` and
  `<!-- flow-echo-recap:end -->` from the helper output and echo it VERBATIM
  as markdown bullets in your assistant message (prose, not tool output) — see
  the [Gate-stage echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose)
  subsection. At AWAITING APPROVAL no reviewable artifact exists yet, so
  `flow-gate-summary --echo-prose` calls `renderEchoRecap({ planFile })`: the
  block still carries the full bounded field set, but the plan-file path is the
  only populated bullet — the PR URL and every review/CI/count field render the
  literal `none`.

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

  Then end the turn. Wait for the user to attach and respond.
  The next turn re-enters at step 4.
- Non-feature intent (`bug`/`refactor`/`docs`/`infra`/`chore`) →
  before falling through to step 5, check `.flow-tmp/plan.md` for a
  prompt-vs-target tension flag via the `flow-step3-route` helper.
  This is the structural enforcement for the AGENTS.md `## Output
  style` rule **Treat user prompts as evidence of intent, not
  exhaustive specifications.** for non-feature intents — without
  this check, a non-feature prompt that names BOTH prescribed methods
  AND a quantitative target would silently run to merge with no user
  checkpoint, even when discovery flagged that the methods can't
  reach the target.

  ```bash
  ROUTE=$(flow-step3-route --intent "$INTENT" --plan-md-file "$WORKTREE/.flow-tmp/plan.md")
  ```

  The helper at `bin/flow-step3-route.ts` returns one of two
  decisions. The four-cell matrix it implements (feature/non-feature
  × Prompt-Interpretation absent/`methods plausibly reach target`/
  any other Recommended path) is documented at
  `skills/pipeline/product-planning/references/discovery-instructions.md`
  "Prompt interpretation (conditional)" — the four enum values live
  there only and the helper exact-matches against them.

  - **`advance-to-step-5`** → no `## Prompt interpretation` section
    OR the section's Recommended path is `methods plausibly reach
    target`. The plan still exists on disk for traceability, but the
    user wasn't asked to ratify it. Run the **non-feature
    candidate-issues sub-step** immediately below before falling
    through to step 5.

    #### Candidate follow-up issues sub-step (non-feature intents)

    Fires ONLY on this `advance-to-step-5` branch (NOT on
    `route-to-step-4`, which already reaches step 4's affirmative-
    branch sub-step — firing here too would double-prompt). This is
    the SAME named candidate-issues form as step 4, fired from a
    second location. It NEVER fires a plan-ratification gate: a
    non-feature intent does not acquire an "approved to proceed"
    checkpoint — only the candidate-issues prompt, and only when
    discovery found candidates. Same thin shape as step 4's sub-step:

    ```bash
    CI=$(flow-candidate-issues --plan-md-file "$WORKTREE/.flow-tmp/plan.md" --json)
    ACTION=$(printf '%s' "$CI" | jq -r '.action')
    ```

    Branch on `.action`:

    - **`no-op`** / **`skip-already-ticked`** → NO prompt, NO
      turn-end; continue straight to step 5 in the same turn. This is
      the common autonomous case — it preserves the "non-feature
      runs to terminal in one uninterrupted turn" principle.
    - **`prompt`** (1–4 unticked candidates) → fire the SAME named
      candidate-issues `AskUserQuestion` multi-select built from
      `.candidates`, map the selections back to 1-based positions,
      `flow-candidate-issues --plan-md-file "$WORKTREE/.flow-tmp/plan.md" --tick <indices>`
      to flip them, then continue to step 5 in the SAME turn. The
      form is synchronous and does not end the turn, so no pending
      phase is needed.
    - **`overflow`** (5+ unticked candidates) → render the AWAITING
      APPROVAL manual-edit guidance via `flow-gate-summary --status
      awaiting-approval --why "5+ candidate follow-up issues —
      option cap exceeded; tick desired items manually in plan.md"
      --worktree "$WORKTREE" --plan-file
      "$WORKTREE/.flow-tmp/plan.md"`, touch the worktree-local marker
      `"$WORKTREE/.flow-tmp/candidate-issues-overflow.pending"` (so a
      crash-resume can tell this apart from a feature plan-approval
      clarification — see Resume mode), write `flow-state-update
      --phase approval-pending-clarification`, and end the turn.

    The `AskUserQuestion` primitive and the decision to fire it stay
    here in the supervisor; `flow-candidate-issues` is LLM-free.

  - **`route-to-step-4`** → the section is present and the
    Recommended path is one of `extend scope with named additional
    safe steps` / `relax target` / `split into multiple pipelines`.
    Write `phase: plan-pending-review` and render the AWAITING
    APPROVAL block via `flow-gate-summary` — same call shape as the
    feature-intent branch above, but with a Why string that names
    the tension flag:

    ```bash
    flow-gate-summary --status awaiting-approval --echo-prose \
      --why "plan ready for review (intent=$INTENT, prompt-interpretation tension)" \
      --worktree "$WORKTREE" \
      --plan-file "$WORKTREE/.flow-tmp/plan.md"
    ```

    Then extract the block between `<!-- flow-echo-recap:start -->` and
    `<!-- flow-echo-recap:end -->` from the helper output and echo it VERBATIM
    as markdown bullets in your assistant message (prose, not tool output) — see
    the [Gate-stage echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose)
    subsection.

    Then end the turn. The next turn re-enters at step 4 with the
    same affirmative/redirect/cancel/ambiguous branches as the
    feature-intent path. The `plan-pending-review` phase value is
    reused (no new phase string is introduced); `flow-stop-guard`
    and `flow-resume-decide` both already handle this phase
    unchanged for non-feature intents.

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
  <slug>`, write `phase: cancelled`, then render the CANCELLED
  block via `flow-gate-summary --status cancelled --why "user
  cancelled at plan-pending-review"`. End.
- **Ambiguous** → write `flow-state-update --phase
  approval-pending-clarification`, then ask the single clarifying
  question and end the turn. The next turn re-enters step 4 with
  the user's reply. If the answer is still unclear, escalate
  `NEEDS HUMAN: approval-ambiguous` (which writes `phase:
  needs-human`).

### Candidate follow-up issues sub-step

Runs only on the **Affirmative** branch above, before stepping to
step 5. The five-branch decision over plan.md's optional
`# Candidate follow-up issues` section is owned by the
`flow-candidate-issues` helper — this sub-step is a thin call site
around it, never re-deriving the matrix in prose:

```bash
CI=$(flow-candidate-issues --plan-md-file "$WORKTREE/.flow-tmp/plan.md" --json)
ACTION=$(printf '%s' "$CI" | jq -r '.action')
```

Branch on `.action`:

- **`no-op`** (section absent, or present with zero items) or
  **`skip-already-ticked`** (the user pre-ticked during plan review —
  their explicit choice wins) → no prompt; continue to step 5.
- **`prompt`** (1–4 unticked candidates) → fire one `AskUserQuestion`
  (multi-select) built from `.candidates` — each `{ title, body }`
  becomes an option. Map the user's selections back to their 1-based
  positions in `.candidates`, then flip the chosen items to `- [x]`
  via the helper (it owns the flip; no hand-matched `Edit`
  `old_string`/`new_string`):

  ```bash
  flow-candidate-issues --plan-md-file "$WORKTREE/.flow-tmp/plan.md" --tick <comma,separated,indices>
  ```

  Then continue to step 5.
- **`overflow`** (5+ unticked candidates) → the form's option cap
  can't fit the candidates. Render the AWAITING APPROVAL block via
  `flow-gate-summary --status awaiting-approval --why "5+ candidate
  follow-up issues — option cap exceeded; tick desired items manually
  in plan.md" --worktree "$WORKTREE" --plan-file
  "$WORKTREE/.flow-tmp/plan.md"` so the user can scroll-tap-edit,
  write `flow-state-update --phase approval-pending-clarification`,
  end the turn. The next turn re-enters step 4.

`AskUserQuestion` is the **only** Claude Code user-prompt primitive
the supervisor calls — see "Hard rules" above for the
narrow-and-named exemption that authorises this site (the same named
candidate-issues form also fires from step 3's non-feature
`advance-to-step-5` sub-step). Other skills and steps may not invoke
it. The decision to fire the form stays here in the supervisor;
`flow-candidate-issues` is LLM-free parse/decide/flip only — it never
calls `AskUserQuestion`.

## Step 5 — Implement

**Phase:** `implementing`

Invoke `/new-feature` in-process. On the first entry to this step,
pass the user's request:

```
/new-feature <verbatim user description>
```

`/new-feature` is itself a thin wrapper that spawns one **Independent
Scout Subagent** via the Task tool (the third of the nine named
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

ADDED=$(git diff --name-only --diff-filter=A "origin/$DEFAULT_BRANCH...HEAD" | \
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

The detection grep uses `--name-only` plus `--diff-filter=A` and the
triple-dot range so the comparison reflects only genuine file
*additions* in the worktree's diff against the merge-base — matching
the additions-only intent the `ADDED` variable name already implies.
Modifications or deletions under `skills/`/`agents/` do not trigger a
re-symlink; only new files do. The default-branch resolution mirrors
`bin/flow-new-worktree.ts` and `bin/flow-pre-commit.ts`; do not
hardcode `origin/main`.

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

```bash
flow-state-update --phase verifying
```

The verify work runs inside one **Independent Verify-Retry-Loop
Subagent** (the ninth named Task-tool exemption — see "Hard rules"
above), not inline in the supervisor. The subagent owns the
**3-outer-attempt `/verify` loop**, the per-retry `flow-pre-commit
--json` `failure`-JSON re-paste, the **Layer-3 `.flow/pre-commit.json`
proactive config-authoring branch**, and the **UI-smoke pass** (see
[references/ui-smoke-pass.md](references/ui-smoke-pass.md)) — the full
bodies of these live in
[references/verify-loop-instructions.md](references/verify-loop-instructions.md).
Isolating the loop is the point: across the 3 attempts the re-pasted
failure JSON would otherwise accumulate unbounded in the supervisor's
own transcript (the one measured unbounded supervisor-context
offender). The supervisor keeps only the spawn, a single artifact read,
and the terminal branch.

**Automated UI-smoke pass (before/alongside `/verify`).** The verify-loop subagent runs the browser-driven UI-smoke pass as part of the loop when the worktree declares a `.flow/ui-validation.json` manifest, following the shared procedure in [references/ui-smoke-pass.md](references/ui-smoke-pass.md): probe the `chrome-devtools` MCP (`ToolSearch query="select:mcp__chrome-devtools__navigate_page"`) → on missing schema run `flow-ui-validate --mcp-absent` (a quiet `ran:false` skip, never a failure) → otherwise `meta.env`-injected launch on dedicated ports → open a per-pipeline isolated page (`new_page` with `isolatedContext` keyed on the pipeline slug) → drive the MCP per route → assemble a captures JSON → `flow-ui-validate --captures`. A shared-profile lock — another pipeline holding chrome-devtools-mcp's default `~/.cache/chrome-devtools-mcp/chrome-profile` (the `already running` / `Use --isolated` error) — is treated as a loud-but-clean skip via `flow-ui-validate --browser-busy` (`ran:false` / `skipped_reason: browser-profile-busy`, loud recovery nudge), never a hard failure, mirroring the MCP-absent degrade; the operator-side cross-pipeline fix is registering the MCP with `--isolated`, while the per-call `isolatedContext` is same-server defense-in-depth only. A `ran:true` result with `ok:false` is a verify failure that feeds the **existing 3-attempt fix loop** above, exactly like any failed `flow-pre-commit` check; headless / MCP-absent runs stay green. **Adaptive noise filter:** when an `ok:false` flags a console error or failed request that is benign noise unrelated to the diff (a favicon 404, a third-party beacon/analytics request, browser-extension noise), do **not** consume a fix-loop attempt on it — add the offending substring to the manifest's `ignoreRequestPatterns` / `ignoreConsolePatterns` in `.flow/ui-validation.json` and **commit that manifest change** (it lands in the reviewable PR diff), then re-run; reserve the 3-attempt fix loop for post-filter errors that the diff actually introduced. **Self-improving manifest (CRITICAL):** when the agent adapts the launch on the fly to make a custom-port run work, it persists the launch adaptation back into `.flow/ui-validation.json` (env/launch/baseUrl) and commits it into the reviewable PR diff, so the next run starts deterministic. See [references/ui-smoke-pass.md](references/ui-smoke-pass.md) for the full probe → launch → drive → assemble → fix-loop body, the screenshot save-path cascade, and the LLM-free / no-`claude -p` / no-Task constraint.

### Independent Verify-Retry-Loop Subagent

**Load the Task tool before spawning** — i.e. before the Task call below. See [../pr-review/references/task-tool-exemption-preamble.md](../pr-review/references/task-tool-exemption-preamble.md) for the full rationale. On missing schema: escalate `NEEDS HUMAN: task-tool-unavailable: flow-pipeline-verify-loop` and exit (do not fall back to in-line execution).

Resolve the inputs the subagent needs, then make exactly **one** Task
call:

```bash
ARTIFACT_PATH="$WORKTREE/.flow-tmp/verify-loop-result.json"
INSTRUCTIONS_PATH="$SKILL_DIR/references/verify-loop-instructions.md"
mkdir -p "$WORKTREE/.flow-tmp"
rm -f "$ARTIFACT_PATH"   # clear any stale artifact from a prior verify cycle
```

Spawn-prompt template (fill the `{{...}}` placeholders before passing to
the Task tool):

```
You are the Independent Verify-Retry-Loop Subagent for /flow-pipeline
step 6. You run in an isolated context and return an artifact on disk
plus a brief both-sides summary.

Read the full instructions at:
  {{INSTRUCTIONS_PATH}}

PR number:
  {{PR}}

Working directory (cd here before running anything):
  {{WORKTREE}}

Plan path (read for PR intent context):
  {{WORKTREE}}/.flow-tmp/plan.md

Write the artifact to (absolute path):
  {{ARTIFACT_PATH}}

Follow the verify-loop-instructions.md steps in order. You are one-shot
— do not ask the user clarifying questions, and do NOT spawn /coder or
any nested Task (apply fixes inline; your context is the isolation
/coder would provide). Stay within 3 outer /verify attempts.

Return a 3–5-sentence summary surfacing both sides — at least one
positive (verdict + attempts used + any Layer-3/UI-smoke action) AND at
least one negative (top `rejected_alternatives` / `anti_patterns_found`
entry, or the failing check on exhaustion). Do not paste the artifact or
the /verify transcript back; the artifact on disk is the durable record.
```

Make the Task call with `subagent_type: general-purpose` and the filled
prompt. After it returns:

1. Existence check: `test -s "$ARTIFACT_PATH"`. If absent, escalate
   `NEEDS HUMAN: verify-loop-missing-artifact` and end (do not re-spawn
   — exactly one verify-loop fan-out per step-6 entry).
2. Read the artifact once and branch on `.verify_status`:

```bash
VERIFY_STATUS=$(jq -r '.verify_status' "$ARTIFACT_PATH")
```

- **`pass`** → the loop exited clean (an outer attempt 1, 2, or 3
  succeeded). Continue to step 7.
- **`exhausted`** → after three failed outer attempts, escalate
  `NEEDS HUMAN: verify-exhausted`. Surface the artifact's
  `final_failure_excerpt` on the PR body's `## Test Steps` section as a
  `> [!CAUTION]` block (idempotent — edit-in-place, do not stack), then
  follow the standard `# Failure paths` escalation:

  ```bash
  mkdir -p "$WORKTREE/.flow-tmp"
  jq -r '.final_failure_excerpt // empty' "$ARTIFACT_PATH" > "$WORKTREE/.flow-tmp/verify-caution.txt"
  gh pr view "$PR" --json body --jq '.body' > "$WORKTREE/.flow-tmp/body.md"
  # upsert the > [!CAUTION] block (built from verify-caution.txt) under
  # ## Test Steps, then
  gh pr edit "$PR" --body-file "$WORKTREE/.flow-tmp/body.md"
  ```

**Re-entry / resume.** Phase stays `verifying` and the resume `step-6`
row re-enters here and re-spawns the subagent (the `/verify` loop
observes the worktree fresh, so a re-spawn is idempotent). The subagent
applies fixes **inline** — it never spawns `/coder` (the one-level
sub-agent cap forbids a nested Task call), so the per-edit diff bytes
stay inside the subagent just as `/coder` would have kept them.

**End condition:** the artifact reports `verify_status: "pass"`.
Continue to step 7.

## Step 7 — CI + Copilot wait

**Phase:** `ci-wait`

**Copilot request decision (before the wait).** Copilot review is opt-in
for non-trivial changes only. Decide whether to request it for this PR
*before* invoking `flow-ci-wait`, so a declined PR can collapse the bot
wait. The decision combines the per-pipeline `copilotReview` override
(from state.json) with `flow-request-copilot`'s deterministic glob
classifier:

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

Append `--copilot-not-requested` to the `flow-ci-wait` call only when no
Copilot review is coming. **Two** signals trigger it: the request decision
was to **decline** (`$REQUESTED` is `false` — a trivial PR, or the global
`bots.copilotSkipWait` budget short-circuit, which forces
`requestCopilot=false` so the wait collapses when your Copilot budget is
spent); or the verdict reports `copilotRequestable:false` (the request
failed because Copilot genuinely isn't available on this repo). Read
`$REQUESTABLE` via `jq` alongside `$REQUESTED`. When `$REQUESTED` is `false`, the verdict's `declineKind` field names which decline it is — `skip-wait` (the `bots.copilotSkipWait` budget toggle) vs `skip-request` (an explicit per-PR `--override never` or a glob class that doesn't warrant a request); both collapse the wait, but the field makes the distinction machine-checkable instead of string-sniffing `reason`.

A `requestSkipReason` (auto-review already enabled, so the helper skipped
the redundant request) **deliberately does NOT** append the flag — the
auto-review will still post, so the supervisor keeps waiting and picks it
up via the historical/author-match path. Coupling the skip to the flag
(the pre-decoupling behaviour) made non-trivial PRs race past their own
auto-review; only a genuine decline or unavailability should collapse the
wait. The flag — **not** a no-op — hard-forces `copilotConfigured=false`,
bypassing BOTH the in-flight `reviewRequests` check AND the historical-PR
fallback; `$SKIP_REASON` may still be read for logging but must not drive
it. A forced request (`--override always`) hard-bypasses this historical short-circuit entirely (the #260 fix), so a forced request never yields a `requestSkipReason` — the POST always fires.

Launch the call (run the Bash tool with `run_in_background: true`):

```bash
VERDICT_FILE="$WORKTREE/.flow-tmp/ci-wait-result.json"
rm -f "$VERDICT_FILE"   # clear any stale verdict from a prior CI cycle
REQUESTABLE=$(printf '%s' "$VERDICT" | jq -r '.copilotRequestable // empty')
SKIP_REASON=$(printf '%s' "$VERDICT" | jq -r '.requestSkipReason // empty')  # logged only; does NOT drive the flag
NOT_REQUESTED_FLAG=""
# Only a genuine decline ($REQUESTED=false: trivial PR or bots.copilotSkipWait
# budget) or genuine unavailability ($REQUESTABLE=false) collapses the wait.
# An auto-review skip ($SKIP_REASON set) keeps the wait so the auto-posted
# Copilot review is still picked up.
if [ "$REQUESTED" = "false" ] || [ "$REQUESTABLE" = "false" ]; then
  NOT_REQUESTED_FLAG="--copilot-not-requested"
fi
# Background-by-default: the 10–20-min poll loop outlives the harness's
# foreground budget. --out persists the final verdict JSON to $VERDICT_FILE
# on every terminal-decision exit path; that file — NOT a stdout capture —
# is the durable handoff the supervisor reads on completion or resume.
flow-ci-wait "$PR" $NOT_REQUESTED_FLAG --out "$VERDICT_FILE"
```

When the backgrounded call exits (or on resume), read the persisted
verdict from the file and branch on `.decision`:

```bash
RESULT=$(cat "$VERDICT_FILE")
DECISION=$(printf '%s' "$RESULT" | jq -r '.decision')
PR_URL=$(printf '%s' "$RESULT" | jq -r '.prUrl // empty')
CI_FAILED_CHECKS=$(printf '%s' "$RESULT" | jq -r '.ciFailedChecks // empty')
```

**Why background-by-default + file-read, not a foreground capture.** A
foreground `RESULT=$(flow-ci-wait …)` command substitution loses the
verdict whenever the harness force-backgrounds the long-running call to
reclaim its budget — `RESULT` comes back empty and there is nothing
durable to recover (observed live: two foreground calls returned empty
stdout, only an explicit background+redirect invocation recovered the
verdict). Running detached with `--out` makes recovery the *normal*
path: `flow-ci-wait` writes the same JSON it prints to stdout to
`$VERDICT_FILE` on every `emitResult` exit, so the supervisor reads a
file that is always there rather than racing the budget.

**On completion.** When the backgrounded `flow-ci-wait` exits, the
harness re-invokes the supervisor; it runs the read block above and
branches on `.decision` immediately.

**Yield-and-resume (`ci-wait-pending`).** If the supervisor reaches
turn-end while the backgrounded call is still running — `$VERDICT_FILE`
does not yet exist or does not parse — it does **not** hand-roll a
discouraged manual poll loop: it writes `flow-state-update --phase
ci-wait-pending` and ends the turn cleanly. `ci-wait-pending` is a
pending phase — `flow-stop-guard` recognises it as a legitimate
turn-end (see "Harness-level enforcement" above) and the exit does not
consume the loop-break budget. On the next re-invocation the supervisor
re-enters step 7: if `$VERDICT_FILE` now exists and parses, it reads the
persisted verdict and branches on `.decision` without re-running the
loop; otherwise it re-launches the backgrounded `flow-ci-wait` (which
resumes the poll loop — CI state is observed fresh from GitHub, not
re-derived from memory).

Branch on `.decision`:

| `.decision` | Action |
|---|---|
| `proceed-to-review` | Continue to step 8. |
| `proceed-to-review-no-bot` | Same as above; the bot review timed out 10 min after CI went terminal, or the Copilot auto-detect short-circuited (see `copilotSkipReason` JSON field — one of `unclaimed-after-deadline`, `self-dismissed`, or `null` when the 10-min timeout fired). |
| `ci-failed` | Continue to step 5 mode=fix. Pass `$CI_FAILED_CHECKS` (extracted above) as the failure log. Subject to the 3-loop ci-fix cap below. |
| `merged-externally` | PR was merged externally mid-flight. Capture follow-ups output to a file: `flow-followups run > "$WORKTREE/.flow-tmp/followups-block.txt"` (still executes auto-allowlisted entries; `>` captures the rendered block). Resolve the slug inline (`SLUG=$(tmux show-options -t "$TMUX_PANE" -v -w @flow-slug)`), in ONE `gh pr view` round-trip guarded by `[ -n "$PR" ]`, capture the diff-size source AND the echo-recap fields (`[ -n "$PR" ] && gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName > "$WORKTREE/.flow-tmp/pr-view.json" && IFS=$'\t' read -r PR_URL PR_TITLE PR_BRANCH < <(jq -r '[.url, .title, .headRefName] \| @tsv' "$WORKTREE/.flow-tmp/pr-view.json") && jq '{additions,deletions,changedFiles,commits:(.commits\|length)}' "$WORKTREE/.flow-tmp/pr-view.json" > "$WORKTREE/.flow-tmp/pr-changes.json"`), then render the snapshot ABOVE the gate block via `flow-pipeline-summary --status merged --state-file ~/.flow/state/"$SLUG".json --pr-changes-file "$WORKTREE/.flow-tmp/pr-changes.json" --pr-review-result "$WORKTREE/.flow-tmp/pr-review-result.json" --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --consolidator-result "$WORKTREE/.flow-tmp/consolidator-result.json" --ci-wait-result "$WORKTREE/.flow-tmp/ci-wait-result.json" --followups-block-file "$WORKTREE/.flow-tmp/followups-block.txt" --filed-issues-file "$WORKTREE/.flow-tmp/filed-issues.txt" --post-comment "$PR" --echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH"` (`--post-comment` durably persists the snapshot as an idempotent PR comment on the MERGED path; it no-ops when `$PR` is empty) — then **extract the block between `<!-- flow-echo-recap:start -->` and `<!-- flow-echo-recap:end -->` from the helper output and echo it VERBATIM as markdown bullets in your assistant message (prose, not tool output)**; see the [Gate-stage echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose) subsection. Render the MERGED block via `flow-gate-summary --status merged --pr-url "$PR_URL" --why "PR was merged externally mid-flight; supervisor cleaned up the worktree" --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt"` **BEFORE** the terminal state transition, so a render failure leaves state.json non-terminal and `flow-stop-guard` nudges retry (the helper silently suppresses the FOLLOW-UPS slot when the file is empty; its final stdout line is the byte-exact sentinel `MERGED`). Then `flow-remove-worktree --delete-branch`, write `phase: merged`, call `flow-notify --status merged --url "$PR_URL"`. End. The roadmap row was self-marked in the PR's diff by `/pr-review` step 7.5; no post-merge sweep required. |
| `pr-closed` | Escalate `NEEDS HUMAN: pr-closed-mid-flight`. |
| `pr-conflicted` | Branch conflicts with base; CI can never run. Advance to the step-10 merge path — `gh pr merge --squash` surfaces the conflict-class failure and the existing Merge-Conflict Resolver Subagent rebases onto base, resolves, and force-pushes, after which CI re-runs on the clean head and the pipeline re-enters step 7. Does NOT consume a ci-fix-loop budget slot (conflict remediation is a rebase, not a code fix). |
| `pr-blocked` | Branch protection blocks the merge — `mergeStateStatus` is still `BLOCKED` (a failing required check, a missing required review, CODEOWNERS, or a linear-history rule outside the `gh pr checks` surface) **after** CI reached terminal and passed. Unlike `pr-conflicted`, this fires only post-CI-terminal (a PR is legitimately `BLOCKED` while required checks are still pending, so `flow-ci-wait` waits CI out first), and unlike a conflict it has no universal mechanical fix the pipeline owns. Escalate `NEEDS HUMAN: pr-blocked` via the standard `# Failure paths` block. Does NOT route to the step-10 merge path and does NOT consume a ci-fix-loop budget slot. |
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
empty'`) and appends `--wait-for-copilot` to the `flow-ci-wait` call
when the value is the literal `true`. Absent ≡ false ≡ auto-detect ON
(the documented default). The flag is set per-pipeline via
`flow new --wait-for-copilot "<description>"`.

**Fix-loop cap: 3 total ci-fix loops** across the whole pipeline.
After the third red CI, escalate `NEEDS HUMAN: ci-fix-exhausted`.

**End condition:** the helper exits 0 with one of the decisions
above. On `proceed-to-review` / `proceed-to-review-no-bot`, continue
to step 8. On `ci-failed`, continue to step 5 mode=fix. On
`pr-conflicted`, advance to the step-10 merge path (the existing
Merge-Conflict Resolver Subagent rebases + resolves + force-pushes; no
ci-fix-loop budget consumed) and re-enter step 7 once CI re-runs on the
clean head. On `merged-externally`, run cleanup and end. On `pr-blocked`
/ `pr-closed` / `ci-hang`, escalate and end.

## Step 8 — Review

**Phase:** `reviewing`

Invoke `/pr-review` in-process with the PR number:

```
/pr-review <PR>
```

When the `chrome-devtools` MCP and a `.flow/ui-validation.json` manifest are present, `/pr-review` Step 8c runs the subjective visual-appearance pass against the browser-validation capability (opening each page in a per-pipeline `isolatedContext`): it drives each enumerated visual-appearance item, judges it via the `ui-ux` skill, captures an a11y snapshot as primary evidence (injected via `flow-inject-evidence`) plus a screenshot referenced by path under `.flow-tmp/ui-evidence/`, and ticks the box. This adds no new Task-tool exemption — Step 8c runs inside the already-exempt Fix-Applier surface.

`/pr-review` itself spawns one **Fix-Applier Subagent** via the Task
tool (the fourth of the nine named Task-tool exemptions in "Hard
rules" above) to handle the per-finding address loop, the pre-commit
run, the commit + push, and the `/verify` re-run — all inside the
subagent's isolated context. The subagent writes a structured
artifact to `<worktree>/.flow-tmp/fix-applier-result.json`; the
wrapper reads it once and reuses the parsed object across its
remaining steps. The supervisor never sees the per-finding fix
prose, only `/pr-review`'s brief return summary.

`/pr-review` also spawns one **Independent Gatekeeper Subagent** via
the Task tool (the seventh of the nine named Task-tool exemptions in
"Hard rules" above) at its Step 1.5, before any other Task-tool
fan-out fires. This short-circuit uses a `model: "haiku"` cost-routing
override to skip closed/merged/trivial/no-new-commits PRs cheaply
without ever paying for the four-agent Sonnet review. On a skip
verdict the wrapper writes a `status: "clean"` result artifact with
`completed_steps: ["1", "1.5"]` and the supervisor proceeds normally
to the auto-merge gate; on `decision: "proceed"` the gatekeeper falls
through to the full review unchanged. The subagent writes its own
single-use artifact at `<worktree>/.flow-tmp/gatekeeper-result.json`
which `/pr-review`'s wrapper reads exactly once and discards after the
branch decision — the supervisor never sees the `gh pr view` metadata
or the skip-rule eval that drove the verdict.

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

### Read the `/pr-review` result artifact and branch on `.status`

After `/pr-review` returns, the wrapper has written a structured
result artifact at `<worktree>/.flow-tmp/pr-review-result.json`
(documented in `skills/pipeline/pr-review/SKILL.md`'s `# Result
artifact` section). Read it exactly once and validate the shape
before branching:

```bash
flow-pr-review-result-schema --validate \
  "$WORKTREE/.flow-tmp/pr-review-result.json"
```

The validator exits 0 on a well-formed artifact and prints
`{ok: true}` on stdout; on a malformed or missing file it exits
non-zero and prints `{ok: false, reason, path?}` on stderr.

**Missing or empty artifact** → escalate `NEEDS HUMAN:
pr-review-missing-artifact` (no retry; mirrors the existing
`fix-applier-missing-artifact` escalation pattern). The wrapper
writes the artifact on every documented exit path, so absence
signals a catastrophic crash that the supervisor cannot recover
from inside this run.

Branch on the artifact's `.status` field — exactly one of the
three string literals `"clean"`, `"partial"`, or `"escalated"`:

- `"clean"` → the skill ran to completion; continue to step 7 (CI
  wait) per the existing flow above, then step 9.
- `"partial"` (with non-empty `.missed_steps`) → re-invoke
  `/pr-review <PR> --resume-from <first-missed-step>` exactly
  once. The `--resume-from` flag instructs `/pr-review` to read
  its existing result artifact, skip the steps already in
  `.completed_steps`, and resume at the named step. After the
  retry returns, re-validate the artifact and re-branch on
  `.status`:
    - retry-`"clean"` → continue per the `"clean"` branch above.
    - retry-`"partial"` → escalate `NEEDS HUMAN: review-partial:
      <missed_steps joined with commas>`.
    - retry-`"escalated"` → propagate `.escalation_tag` verbatim
      into `NEEDS HUMAN: <escalation_tag>` (same as the
      first-call `"escalated"` branch below — collapsing it into
      `review-partial` would drop the actionable tag, e.g.
      `task-tool-unavailable: pr-review-fix-applier`, in favour
      of a generic missed-step list).
  The partial-retry budget is one and is **independent of the
  existing 2-loop review-fix cap above** — the cap counts
  review-fix iterations (critical findings the skill auto-fixed),
  this counter tracks structural missed-step retries.
- `"escalated"` → propagate the `.escalation_tag` verbatim into
  `NEEDS HUMAN: <escalation_tag>` and bail. No retry: the
  escalation tag names a documented bail-out site
  (`task-tool-unavailable: pr-review-gatekeeper`,
  `task-tool-unavailable: pr-review-multi-agent-review`,
  `task-tool-unavailable: pr-review-fix-applier`,
  `gatekeeper-missing-artifact`, or
  `fix-applier-missing-artifact`) for which the resolution is
  user-action, not retry.

On non-zero exit from `/pr-review` itself (Bun-level / shell-level
failure with no artifact written): retry once. If the retry also
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
| `auto-merge` | Run `flow-followups pr-body-upsert "$PR"` (no-op when log is empty; otherwise idempotent in-place upsert of `## Local Follow-ups` so the section survives the squash-merge), then run `flow-foreclosed-paths pr-body-upsert "$PR"` (idempotent; no-ops when there are no foreclosed paths). Continue to step 10 (auto-merge). |
| `gated` | Run `flow-followups pr-body-upsert "$PR"` (idempotent), then run `flow-foreclosed-paths pr-body-upsert "$PR"` (idempotent; no-ops when there are no foreclosed paths), then capture the deferred follow-ups block via `flow-followups run --note-only > "$WORKTREE/.flow-tmp/followups-block.txt"` (the renderer suppresses the FOLLOW-UPS slot when the file is empty). Resolve the slug inline (`SLUG=$(tmux show-options -t "$TMUX_PANE" -v -w @flow-slug)`), in ONE `gh pr view` round-trip, capture the diff-size source AND the echo-recap fields (`gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName > "$WORKTREE/.flow-tmp/pr-view.json" && IFS=$'\t' read -r PR_URL PR_TITLE PR_BRANCH < <(jq -r '[.url, .title, .headRefName] \| @tsv' "$WORKTREE/.flow-tmp/pr-view.json") && jq '{additions,deletions,changedFiles,commits:(.commits\|length)}' "$WORKTREE/.flow-tmp/pr-view.json" > "$WORKTREE/.flow-tmp/pr-changes.json"`), then render the snapshot ABOVE the gate block via `flow-pipeline-summary --status gated --state-file ~/.flow/state/"$SLUG".json --pr-changes-file "$WORKTREE/.flow-tmp/pr-changes.json" --pr-review-result "$WORKTREE/.flow-tmp/pr-review-result.json" --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --consolidator-result "$WORKTREE/.flow-tmp/consolidator-result.json" --ci-wait-result "$WORKTREE/.flow-tmp/ci-wait-result.json" --followups-block-file "$WORKTREE/.flow-tmp/followups-block.txt" --filed-issues-file "$WORKTREE/.flow-tmp/filed-issues.txt" --echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH"` — then **extract the block between `<!-- flow-echo-recap:start -->` and `<!-- flow-echo-recap:end -->` from the helper output and echo it VERBATIM as markdown bullets in your assistant message (prose, not tool output)**; see the [Gate-stage echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose) subsection. Render the GATED block via `flow-gate-summary --status gated --pr-url "$PR_URL" --why "$REASON" --validation-items-file <(printf '%s\n' "$VALIDATION_ITEMS") --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt"` **BEFORE** writing `phase: gated`, so a render failure leaves state.json non-terminal and `flow-stop-guard` nudges retry. Then write `phase: gated`. Call `flow-notify --status gated --url "$PR_URL" --reason "$REASON"` (the helper sets `.reason` to the first `.validationItems` entry, or `auto-merge opted out (--no-auto-merge)` when `autoMerge: false` with zero unchecked items). End. |
| `merged-externally` | Already merged externally. **Do not** run `gh pr merge`. Capture follow-ups output: `flow-followups run > "$WORKTREE/.flow-tmp/followups-block.txt"` (executes allowlisted+auto entries while the worktree is still alive; `>` captures the rendered block). Resolve the slug inline (`SLUG=$(tmux show-options -t "$TMUX_PANE" -v -w @flow-slug)`), in ONE `gh pr view` round-trip guarded by `[ -n "$PR" ]`, capture the diff-size source AND the echo-recap fields (`[ -n "$PR" ] && gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName > "$WORKTREE/.flow-tmp/pr-view.json" && IFS=$'\t' read -r PR_URL PR_TITLE PR_BRANCH < <(jq -r '[.url, .title, .headRefName] \| @tsv' "$WORKTREE/.flow-tmp/pr-view.json") && jq '{additions,deletions,changedFiles,commits:(.commits\|length)}' "$WORKTREE/.flow-tmp/pr-view.json" > "$WORKTREE/.flow-tmp/pr-changes.json"`), then render the snapshot ABOVE the gate block via `flow-pipeline-summary --status merged --state-file ~/.flow/state/"$SLUG".json --pr-changes-file "$WORKTREE/.flow-tmp/pr-changes.json" --pr-review-result "$WORKTREE/.flow-tmp/pr-review-result.json" --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --consolidator-result "$WORKTREE/.flow-tmp/consolidator-result.json" --ci-wait-result "$WORKTREE/.flow-tmp/ci-wait-result.json" --followups-block-file "$WORKTREE/.flow-tmp/followups-block.txt" --filed-issues-file "$WORKTREE/.flow-tmp/filed-issues.txt" --post-comment "$PR" --echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH"` (the helper yields `none` for absent artifacts, so a thin merged-externally snapshot is expected; `--post-comment` durably persists the snapshot as an idempotent PR comment and no-ops when `$PR` is empty) — then **extract the block between `<!-- flow-echo-recap:start -->` and `<!-- flow-echo-recap:end -->` from the helper output and echo it VERBATIM as markdown bullets in your assistant message (prose, not tool output)**; see the [Gate-stage echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose) subsection. Render the MERGED block via `flow-gate-summary --status merged --pr-url "$PR_URL" --why "PR was merged externally; supervisor cleaned up worktree only" --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt"` **BEFORE** the terminal state transition, so a render failure leaves state.json non-terminal and `flow-stop-guard` nudges retry. Then `flow-remove-worktree --delete-branch`, write `phase: merged`, call `flow-notify --status merged --url "$PR_URL"`. End. (The roadmap row was self-marked in the PR's diff by `/pr-review` step 7.5; no post-merge sweep is needed.) |
| `closed-no-merge` | Call `flow-notify --status needs-human --url "$PR_URL" --reason "pr-closed-without-merge"`. Render the NEEDS HUMAN block via `flow-gate-summary --status needs-human --reason pr-closed-without-merge --pr-url "$PR_URL" --why "PR closed without merge"`. End. |
| `escalate-heading-missing` | Render the NEEDS HUMAN block via `flow-gate-summary --status needs-human --reason test-steps-section-missing --pr-url "$PR_URL" --why "PR body has no ## Test Steps heading — gate cannot evaluate"`. End. |
| `escalate-gh-error` | Render the NEEDS HUMAN block via `flow-gate-summary --status needs-human --reason gh-error --pr-url "$PR_URL" --why "$(printf '%s' "$REASON" | tr '\n' ' ' | head -c 200)"` (one-line, length-bounded from the `gh` stderr). End. |

**A `gated` verdict is terminal, not advisory.** When `flow-gate-decide`
returns `gated`, the supervisor renders the GATED block, writes
`phase: gated`, and ends — full stop. The `gated` verdict is **not** an
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

### Gate override (post-verdict, opt-in)

A `gated` run has ended, but the tmux window stays open. If the user then
types a *new* instruction to merge the gated PR anyway, treat it as a
mid-flight redirect and classify it per `references/redirect-handling.md`
"Gate override". An override is authorised **only** when the instruction
is all three of **fresh** (sent after the GATED block was surfaced),
**unambiguous** (about merging this gated PR — bare "merge"/"ship it"/
"lgtm" qualify; the `AskUserQuestion` form fired next is itself the
conscious-confirmation step), and **in-context** (actually about this
gate verdict, not inferred from an earlier instruction given for a
different purpose). A stale or pre-verdict instruction never qualifies.
The "unambiguous" test fails only on inputs that are not about merging
at all (bare "cool", "thanks", "next").

**Re-query the live gate first.** Before firing or refusing the
override, always re-query the live verdict via `flow-gate-decide "$PR"`
and branch on the result. The supervisor's local context may be stale:
the user can tick `- [ ]` boxes in the PR body between the GATED render
and their merge instruction, clearing the gate themselves. The re-query
lets the supervisor distinguish "gate genuinely still applies, fire the
override form" from "gate already cleared, proceed on the auto-merge
path" — without it, the supervisor refuses an override that isn't
needed.

```bash
# 0. Re-query the live gate before deciding fire-form vs refuse-form.
LIVE=$(flow-gate-decide "$PR")
LIVE_DECISION=$(printf '%s' "$LIVE" | jq -r '.decision')
case "$LIVE_DECISION" in
  auto-merge)
    # User cleared the gate themselves between the GATED render and
    # their merge instruction. No override needed. Do NOT fire
    # AskUserQuestion, do NOT call --record-override. Route directly
    # to step 10's auto-merge path; flow-merge-guard there will
    # re-confirm the cleared gate from the live body.
    # supervisor: stop processing the override here and re-enter
    # step 10's auto-merge path with the now-clean verdict.
    return 0
    ;;
  gated)
    # Gate genuinely still applies; proceed with the override
    # decision per the softened "unambiguous" + retained "fresh" +
    # retained "in-context" tests below.
    ;;
  merged-externally|closed-no-merge|escalate-heading-missing|escalate-gh-error)
    # Route per the existing step 9 decision table above; the
    # override flow does not apply.
    # supervisor: handle per step 9's main decision table.
    return 0
    ;;
esac

# 1. Confirm with the verdict in full view. This is the named
#    AskUserQuestion exemption in "Hard rules" above.
#    AskUserQuestion: "PR #<n> is gated — <N> Test Steps unverified
#    (they may include functional checks). Merge anyway?"
# 2. On an affirmative answer only, record the fresh-confirmation token:
flow-merge-guard "$PR" --record-override
# 3. Then re-enter step 10. The flow-merge-guard backstop there reads
#    the token and lets the merge through.
```

On any non-affirmative answer — or when the instruction fails the
"fresh" or "in-context" test, or the "unambiguous" test on an input
that isn't about merging at all — do **not** fire the confirmation and
do **not** record a token. Re-render the GATED block via
`flow-gate-summary --status gated ...`, restate that the verdict is
terminal, and end. The PR stays `gated`.

**Step 10 needs no helper plumbing change.** The mechanical merge guard
`flow-merge-guard` already re-fetches the live PR body via
`fetchPrInputs` on every call (see `bin/flow-merge-guard.ts`'s `run()`
entry — same `gh pr view` round-trip `flow-gate-decide` uses). The
stale-verdict footgun this sub-step's step 0 closes is purely on the
step 9 supervisor-prose decision path — step 10's backstop was already
correct.

## Step 10 — Merge

**Phase:** `merging`

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
  GUARD_REASON=${GUARD_REASON:-"flow-merge-guard exited $GUARD_RC (helper missing from PATH? run flow setup --upgrade)"}
  flow-followups run --note-only > "$WORKTREE/.flow-tmp/followups-block.txt"
  flow-gate-summary --status needs-human \
    --reason gate-override-without-confirmation \
    --pr-url "$PR_URL" --why "$GUARD_REASON" \
    --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt"
  flow-state-update --phase needs-human
  flow-notify --status needs-human --url "$PR_URL" \
    --reason "gate-override-without-confirmation"
  # End. Do NOT merge, do NOT retry the guard.
  exit 1
fi
```

A non-zero `flow-merge-guard` exit means a `gated` verdict was reached
without the fresh-confirmation override (exit 1 = blocked), or the guard
could not run (exit 2 = gh error / bad args, or 127 = helper not yet on
PATH — the user must run `flow setup --upgrade`). In **every** non-zero
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

The `Claude-Code-Session-Id:` trailer is no longer composed here. Step
10 runs a bare `gh pr merge --squash` — no `--body`, no `--subject` —
so gh builds the squash-commit body from its default concatenation of
the branch's individual commit messages and defaults the subject to
`<PR title> (#N)`. The trailer reaches `git log` /
`git blame` because the per-commit `prepare-commit-msg` hook installed
by `flow-new-worktree` appends `Claude-Code-Session-Id: <id>` to every
individual commit in the worktree (when `CLAUDE_CODE_SESSION_ID` is
set); gh's default concatenation then carries it into the squash-merge
commit for free. The step 9 auto-merge gate is unaffected — it inspects
only the live PR body, never the commit trailers.

The primary worktree always has the base branch checked out (flow's
invariant), so gh's post-merge `git checkout <base>` runs as a no-op
there. Running the merge from `$WORKTREE` (which has the feature branch
checked out) would make that checkout collide with the primary worktree
and fail, even though the squash already succeeded server-side.

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
  failure, render the NEEDS HUMAN block via `flow-gate-summary
  --status needs-human --reason merge-failed --pr-url "$PR_URL"
  --why "$(jq -r .summary "$ARTIFACT_PATH" | head -1)"`. End.
- **Non-conflict** (auth, network, branch-protection denied, required
  check failed, PR closed externally, any unrecognised stderr) —
  retry the merge once with `$PRIMARY` re-derived in the same Bash
  call:

  ```bash
  PRIMARY=$(git worktree list --porcelain | awk '/^worktree / {sub(/^worktree /, ""); print; exit}')
  (cd "$PRIMARY" && gh pr merge --squash "$PR")
  ```

  If still
  failing, escalate via the standard `# Failure paths` block (capture
  follow-ups via `flow-followups run --note-only >
  "$WORKTREE/.flow-tmp/followups-block.txt"` → render via
  `flow-gate-summary --status needs-human --reason merge-failed
  --pr-url "$PR_URL" --why "$MERGE_STDERR" --deferred-file
  "$WORKTREE/.flow-tmp/followups-block.txt"` → `flow-state-update
  --phase needs-human` → `flow-notify --status needs-human --url
  "<pr-url>" --reason "merge-failed"`; render BEFORE the terminal
  state transition). Leave the worktree intact. Do **not** spawn the
  resolver — it can't help with non-conflict failures and would waste
  a Task call.

### Independent Merge-Conflict Resolver Subagent

Fires only on the conflict-class branch above. The subagent rebases
the branch onto `origin/<base>`, resolves each conflicted file,
records actions taken + ambiguous calls in a structured artifact,
force-pushes, and returns a brief summary. The supervisor never sees
the rebase output, the per-file resolution prose, or the force-push
transcript — only the artifact and the summary.

**Load the Task tool before spawning** — i.e. before the Task call below. See [../pr-review/references/task-tool-exemption-preamble.md](../pr-review/references/task-tool-exemption-preamble.md) for the full rationale. On missing schema: escalate `NEEDS HUMAN: task-tool-unavailable: flow-pipeline-merge-resolver` and exit (do not fall back to in-line execution).

Resolve the inputs the subagent needs, then make exactly **one**
Task call:

```bash
ARTIFACT_PATH="$WORKTREE/.flow-tmp/merge-resolver-result.json"
INSTRUCTIONS_PATH="$SKILL_DIR/references/merge-resolver-instructions.md"
BASE_BRANCH=$(gh pr view "$PR" --json baseRefName -q .baseRefName)
mkdir -p "$WORKTREE/.flow-tmp"
# Best-effort conflicting-file list. The wrapper does not initiate
# `git rebase` itself — the resolver runs the rebase as Step 2 of its
# instructions. So this list is only non-empty when an outer process
# (a prior failed merge attempt, a manual `git rebase`) already left
# the worktree mid-rebase. `git diff --name-only --diff-filter=U` is
# the canonical query for unmerged paths and catches every U-class
# status (UU/AU/UA/DU/UD), unlike a porcelain prefix grep which misses
# the AU/DU pair where U is in column 2.
(cd "$WORKTREE" && git fetch origin "$BASE_BRANCH") || echo "warn: git fetch origin $BASE_BRANCH failed; resolver will retry the fetch in Step 2" >&2
CONFLICTING_FILES=$(cd "$WORKTREE" && git diff --name-only --diff-filter=U)
PR_DESCRIPTION=$(gh pr view "$PR" --json body -q .body)
```

Spawn-prompt template (fill the `{{...}}` placeholders before passing
to the Task tool):

```
You are the Independent Merge-Conflict Resolver Subagent for /flow-pipeline
step 10. You run in an isolated context and return an artifact on disk
plus a brief summary.

Read the full instructions at:
  {{INSTRUCTIONS_PATH}}

PR number:
  {{PR}}

Base branch:
  {{BASE_BRANCH}}

`gh pr merge --squash` stderr that triggered this resolver:
  {{MERGE_STDERR}}

Conflicting file paths (may be empty if rebase has not yet been
initiated; resolver runs the rebase itself in that case):
  {{CONFLICTING_FILES}}

Working directory (cd here before running any git command):
  {{WORKTREE}}

Plan path (read for PR intent context):
  {{WORKTREE}}/.flow-tmp/plan.md

PR description (verbatim):
  {{PR_DESCRIPTION}}

Write the artifact to (absolute path):
  {{ARTIFACT_PATH}}

Follow the merge-resolver-instructions.md steps in order. You are
one-shot — do not ask the user clarifying questions. When a
resolution requires judgment no defensible default exists for,
record it in `ambiguous_resolutions` with the alternatives you
considered and let the supervisor escalate.

Return a 3–5-sentence summary surfacing both sides — at least one
positive (resolved file count + dominant strategy + force-push
outcome) AND at least one negative (top entry from
`ambiguous_resolutions` or `rejected_strategies`). Do not paste the
artifact, the diff, or the rebase output back; the artifact on disk
is the durable record.
```

Make the Task call with `subagent_type: general-purpose` and the
filled prompt. After it returns:

1. Existence check: `test -s "$ARTIFACT_PATH"`. If absent, escalate
   `NEEDS HUMAN: merge-resolver-missing-artifact` and end. (Do not
   re-spawn the resolver — exactly one Task call per run, per the
   exemption contract.)
2. Read the artifact's `force_push_status`. If `succeeded`, retry the
   merge **exactly once** with `$PRIMARY` re-derived in the same Bash
   call (the supervisor runs this as a fresh shell — `$PRIMARY` from
   the Step 10 block above is not in scope):

   ```bash
   PRIMARY=$(git worktree list --porcelain | awk '/^worktree / {sub(/^worktree /, ""); print; exit}')
   (cd "$PRIMARY" && gh pr merge --squash "$PR")
   ```

   If `failed` or `skipped`, do not retry — render the NEEDS HUMAN
   block via `flow-gate-summary --status needs-human --reason
   merge-failed --pr-url "$PR_URL" --why "$(jq -r .summary
   "$ARTIFACT_PATH" | head -1)"`. End.
3. On retry success, continue to the post-merge sweep below.
4. On retry failure, render the NEEDS HUMAN block via
   `flow-gate-summary --status needs-human --reason merge-failed
   --pr-url "$PR_URL" --why "$(jq -r .summary "$ARTIFACT_PATH" |
   head -1)"`. End. The artifact stays on disk in the worktree for
   human inspection.

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
  # The same helper that owns the candidate-issues decision also owns
  # the ticked-item extraction — `--ticked` reuses its section parse
  # and first-` — ` split, so the section is parsed in exactly one
  # place (no hand-rolled awk + Bash em-dash split here). Emits
  # { ticked: [{ title, body }] }, empty when zero items are ticked.
  TICKED_JSON=$(flow-candidate-issues --plan-md-file "$PLAN" --ticked)
  COUNT=$(printf '%s' "$TICKED_JSON" | jq -r '.ticked | length')
  for ((i = 0; i < COUNT; i++)); do
    TITLE=$(printf '%s' "$TICKED_JSON" | jq -r ".ticked[$i].title")
    BODY=$(printf '%s' "$TICKED_JSON" | jq -r ".ticked[$i].body")
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
  done
fi
if [ "${#FILED[@]}" -eq 0 ] && [ "${#WARN[@]}" -eq 0 ]; then
  echo "No follow-up issues filed"
elif [ "${#WARN[@]}" -gt 0 ]; then
  echo "WARN: filed ${#FILED[@]}/$((${#FILED[@]} + ${#WARN[@]})) follow-up issues; missing: ${WARN[*]}"
else
  echo "Filed ${#FILED[@]} follow-up issues:"
  printf '  %s\n' "${FILED[@]}"
fi
# Capture the sweep's filed URLs + unfiled warnings to a flat file the
# ## PIPELINE SNAPSHOT block reads as --filed-issues-file (a filed line is
# `filed\t<url>`; an unfiled line is `unfiled\t<title>` — a bare `http…` line
# is also accepted by the parser on the resume / hand-authored path). Truncate
# first, then append each array guarded by a length check so an empty array
# does not error.
: > "$WORKTREE/.flow-tmp/filed-issues.txt"
if [ "${#FILED[@]}" -gt 0 ]; then printf 'filed\t%s\n' "${FILED[@]}" >> "$WORKTREE/.flow-tmp/filed-issues.txt"; fi
if [ "${#WARN[@]}" -gt 0 ]; then printf 'unfiled\t%s\n' "${WARN[@]}" >> "$WORKTREE/.flow-tmp/filed-issues.txt"; fi
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

For MERGED, run the helper here and finalize. **Ordering is
load-bearing on two fronts:** (a) `flow-remove-worktree` deletes the
worktree, so both the follow-ups capture and the `flow-gate-summary`
render must happen BEFORE worktree removal; and (b) the
`flow-gate-summary` render must also happen BEFORE
`flow-state-update --phase merged` — otherwise a render failure (bad
args, missing helper, etc.) leaves state.json saying `merged` while
the user never sees the rendered block in scrollback, and
`flow-stop-guard` reads the legitimate terminal phase and stops
nudging:

```bash
flow-followups run > "$WORKTREE/.flow-tmp/followups-block.txt"  # executes auto-allowlisted entries; > captures the rendered block
SLUG=$(tmux show-options -t "$TMUX_PANE" -v -w @flow-slug)       # resolve slug inline for the state-file path
gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName > "$WORKTREE/.flow-tmp/pr-view.json"  # ONE gh pr view round-trip: diff-size + url/title/headRefName for the echo recap
IFS=$'\t' read -r PR_URL PR_TITLE PR_BRANCH < <(jq -r '[.url, .title, .headRefName] | @tsv' "$WORKTREE/.flow-tmp/pr-view.json")
jq '{additions,deletions,changedFiles,commits:(.commits|length)}' "$WORKTREE/.flow-tmp/pr-view.json" > "$WORKTREE/.flow-tmp/pr-changes.json"
flow-pipeline-summary --status merged --state-file ~/.flow/state/"$SLUG".json --pr-changes-file "$WORKTREE/.flow-tmp/pr-changes.json" --pr-review-result "$WORKTREE/.flow-tmp/pr-review-result.json" --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --consolidator-result "$WORKTREE/.flow-tmp/consolidator-result.json" --ci-wait-result "$WORKTREE/.flow-tmp/ci-wait-result.json" --followups-block-file "$WORKTREE/.flow-tmp/followups-block.txt" --filed-issues-file "$WORKTREE/.flow-tmp/filed-issues.txt" --post-comment "$PR" --echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH"  # prints the echo recap (top of stdout) then the ## PIPELINE SNAPSHOT block ABOVE the gate-summary (emits NO sentinel); --post-comment additionally persists the snapshot as an idempotent PR comment (MERGED-only, best-effort)
flow-gate-summary --status merged --pr-url "$PR_URL" \
  --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt"     # renders STATUS/PR/NEXT ACTION/FOLLOW-UPS + sentinel MERGED — must run BEFORE the terminal state transition
flow-state-update --phase merged
flow-notify --status merged --url "$PR_URL"
flow-remove-worktree --delete-branch
```

Then extract the block between `<!-- flow-echo-recap:start -->` and
`<!-- flow-echo-recap:end -->` from the helper output and echo it VERBATIM as
markdown bullets in your assistant message (prose, not tool output). See the
[`### Gate-stage echo-verbatim recap (`--echo-prose`)`](#gate-stage-echo-verbatim-recap---echo-prose)
subsection for the contract and the bounded field set.

The helper silently suppresses the FOLLOW-UPS slot when the follow-ups
file is empty, so call sites do not stat the path first. End.

### `flow-foreclosed-paths` (PR-body `## Foreclosed Paths` upsert)

`flow-foreclosed-paths pr-body-upsert <PR>` persists the rejected
alternatives and anti-patterns the `/pr-review` Fix-Applier and
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

`flow-pipeline-summary` renders a `## PIPELINE SNAPSHOT` block ABOVE the `flow-gate-summary` block at the post-review terminal states (MERGED, GATED, NEEDS HUMAN) so the user reads one continuous terminal block: a phase-by-phase account, then the gate verdict. It is an LLM-free Bun helper that aggregates the structured artifacts the pipeline already writes and renders ONLY sourced facts across six sections — CHANGES (commits/diff size from `gh pr view`), PHASES (`state.json`'s `phaseLog[]` written by `flow-state-update --phase`), FINDINGS (review verdict + fix-applier/consolidator counts + CI/Copilot outcome), FORECLOSED PATHS (the full prose of the fix-applier + consolidator rejected alternatives + anti-patterns, plain-text mode of the same shared formatter the PR-body `## Foreclosed Paths` section uses), FOLLOW-UP ISSUES (filed sweep URLs from `filed-issues.txt` + `/pr-review` deferrals), and MANUAL STEPS (the captured `followups-block.txt` verbatim). Each section prints the literal `none` when its source is absent or empty (explicit-`none` discipline — never a fabricated "looks like it passed"). Degradation of the fix-applier-sourced FINDINGS `fixes:` and FORECLOSED PATHS slots is per-entry, not all-or-nothing: a partially-broken artifact (well-formed top-level keys, one off-shape entry) still renders every well-formed entry and appends a residual `(N unreadable)` marker for the dropped ones, while only a genuinely-unreadable artifact (non-JSON, non-object, or a missing/wrong-typed required top-level key) degrades the whole category to `(unreadable)` — never crashing the snapshot. The same shared formatter still backs both surfaces (so they cannot drift; the cross-surface parity test now also exercises this partial-degradation path). The block NEVER emits a `flow-stop-guard` sentinel (`MERGED` / `GATED:` / `NEEDS HUMAN:` / `cancelled`) — `flow-gate-summary` owns the sentinel as the byte-exact last line of stdout; the snapshot prints above it. v1 scope is the post-review terminal states only: the helper is wired at exactly the four post-review terminal `flow-gate-summary` sites (the step-11 MERGED block, the step-9 `gated` branch, both `merged-externally` renders, and the canonical `# Failure paths` NEEDS HUMAN block) and NOWHERE else — pre-review NEEDS HUMAN escalations (triage-ambiguous, worktree-create-failed, plan-missing) fire before any reviewable artifact exists, so wiring the snapshot there would print an all-`none` block of pure noise.

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
an allowlisted command (e.g. `flow setup --upgrade` failed because of a
permission issue) is rendered in the printed block as `FAIL <command> (exit
N)` with a tail excerpt. The supervisor still ends with `MERGED` — the user
inspects scrollback. Escalating to `NEEDS HUMAN` would block a successful
merge on a peripheral failure, which inverts the priority.

**Canonical fast-forward.** `flow setup --upgrade` opportunistically
fast-forwards the canonical install root before discovery — this fixes
the PR #115 race where freshly-merged skills got orphan-reaped because
the canonical checkout still had the pre-merge tree. The line
`canonical: fast-forwarded N commits` (or `canonical: skipped (<reason>)`
when the fast-forward can't run — `dirty`, `non-default-branch`,
`fetch-failed`, `merge-failed`, `no-default-branch`, or
`not-a-git-repo`) appears in the LOCAL FOLLOW-UPS block before the
symlink summary. As a defense-in-depth layer for the
dirty-canonical case, `removeIfManagedSymlink` (in `bin/lib/symlink.ts`)
now defers reaping a dangling pointer when the recorded source still
exists in `origin/<default>`'s tree but not in the canonical working
tree. Opt out per-run with `flow setup --upgrade --no-pull-canonical`;
the followup itself does NOT pass this flag — the allowlist exact-match
is load-bearing.

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
re-surfaces the PR URL after follow-up commits (a `/pr-review` fix push or a
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

`flow new --resume <name>` writes that prompt; nothing else does.
On detecting it, **do not** start at step 1. Call `flow-resume-decide`
to walk the resume-from-disk decision tree:

```bash
RESULT=$(flow-resume-decide)
RESUME_AT=$(printf '%s' "$RESULT" | jq -r '.resumeAt')
REASON=$(printf '%s' "$RESULT" | jq -r '.reason')
WORKTREE=$(printf '%s' "$RESULT" | jq -r '.context.worktree // empty')
PR=$(printf '%s' "$RESULT" | jq -r '.context.pr // empty')
ANSWER=$(printf '%s' "$RESULT" | jq -r '.context.answer // empty')
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
| `step-4` | Re-enter step 4 (approval) — **but first check for the non-feature candidate-issues overflow marker** (see the note below the table). Absent the marker: re-print the plan summary, then emit the same two markdown bullets as step 3's feature-intent end-condition (worktree absolute path + plan file absolute path, on their own lines as the last lines of the message, no trailing punctuation), and wait — never replay an approval the user gave to a now-dead session. |
| `step-5` | Re-enter step 5 (implement). Re-invoke `/new-feature`. |
| `step-5.5` | Re-enter step 5.5 (re-symlink). Re-run `flow setup --upgrade --source "$WORKTREE"` per step 5.5's end-condition (idempotent). |
| `step-6` | Re-enter step 6 (verify). Re-spawn the Verify-Retry-Loop subagent (phase stays `verifying`; the subagent re-runs the `/verify` loop observing the worktree fresh, so a re-spawn is idempotent). |
| `step-7` | Re-enter step 7 (ci-wait). A `state.json` phase of `ci-wait` **or** `ci-wait-pending` (the yielded-while-backgrounded pending phase) both resolve here. **Read `$WORKTREE/.flow-tmp/ci-wait-result.json` first**: if it exists and parses, the backgrounded `flow-ci-wait` already reached a terminal decision — read the persisted verdict and branch on `.decision` without re-running the loop. Only when the file is absent or unparseable does the supervisor re-launch the backgrounded `flow-ci-wait` (the poll loop restarts, observing CI state fresh from GitHub). |
| `step-8` | Re-enter step 8 (review). Re-invoke `/pr-review <PR>`. |
| `step-9` | Re-enter step 9 (gate). Two sub-cases distinguished by `.reason`: `pr-merged-worktree-still-exists` (run step 11's MERGED branch — which re-runs `flow-pipeline-summary ... --echo-prose ...` and re-echoes the recap verbatim per the [Gate-stage echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose) subsection — then render the MERGED block via `flow-gate-summary --status merged ...` (BEFORE the terminal state transition) and run `flow-remove-worktree --delete-branch`, write `phase: merged`, end; **do not** fall through to step 10's `gh pr merge` on an already-merged PR) vs. `at-auto-merge-gate` (re-evaluate the gate via `flow-gate-decide`). |
| `terminal` | Already in a terminal state. Re-run the corresponding gate render (the same helpers every gate-emission site uses) and end without re-running anything else. On `merged`/`gated` the render re-runs `flow-pipeline-summary ... --echo-prose ...` above `flow-gate-summary --status <merged\|gated> ...`, so the echo recap re-surfaces on resume re-entry — extract the `<!-- flow-echo-recap:start -->`…`<!-- flow-echo-recap:end -->` block and echo it VERBATIM per the [Gate-stage echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose) subsection (re-orientation is exactly the resume use case). `cancelled` has no PR, so `--echo-prose` is a no-op there. `needs-human` re-renders the escalation via `flow-gate-summary --status needs-human ...`. The two no-in-flight-work pending phases short-circuit here pre-tree (reasons `no-change-investigation-complete` for `triaged-no-change`, `awaiting-triage-clarification` for `triage-pending-clarification`): they carry no PR/worktree and have no gate-summary status, so print a one-line note that the pipeline already completed (a no-change investigation, or one awaiting a clarification a resume can't re-ask) and end — do NOT build a worktree. On the `triaged-no-change` path, when `$ANSWER` is non-empty, re-print the saved `$ANSWER` (as markdown) so the user re-reads the original answer instead of the generic terminal note; fall back to the generic note when `$ANSWER` is empty. |
| `escalate` | Escalate `NEEDS HUMAN: <.reason>` (e.g. `worktree-missing-on-resume`, `pr-closed-without-merge`). Leave the worktree + PR intact. |
| `abort` | The state file is missing. Escalate `NEEDS HUMAN: state-missing-on-resume` and end. |

**Non-feature candidate-issues overflow re-route.**
`flow-resume-decide` resolves `approval-pending-clarification` to
`step-4` (`bin/flow-resume-decide.ts` Row 4 — the phase is not in
`POST_APPROVAL_PHASES`). For a *feature* pipeline that is correct: it
takes the normal step-4 plan-approval clarification path above. But a
**non-feature** pipeline never solicited a plan-ratification gate, so
the only way it can be parked at `approval-pending-clarification` is
the candidate-issues 5+ **overflow** case from step 3's non-feature
sub-step. The supervisor disambiguates by the presence of the
worktree-local marker `"$WORKTREE/.flow-tmp/candidate-issues-overflow.pending"`
(written by that overflow branch). When `.resumeAt` is `step-4` AND
that marker exists, do NOT re-run step-4 plan ratification (the user
never gave a plan to ratify). Instead re-enter the candidate-issues
sub-step: re-run `flow-candidate-issues --plan-md-file
"$WORKTREE/.flow-tmp/plan.md" --json` and branch on `.action` — on
`prompt`, fire the candidate-issues `AskUserQuestion` + `--tick`; on
`no-op`/`skip-already-ticked` (the user manually ticked items in
plan.md while away), continue to step 5 — then remove the marker once
resolved. A feature pipeline at the same phase (no marker) is
unaffected.

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
- **Terminal phase (`merged` / `gated` / `needs-human` / `cancelled`).** Render the
  terminal block via `flow-gate-summary --status <merged|gated|needs-human|cancelled>
  ...` (the same helper every gate-emission site uses) and end without
  re-running anything. The window stayed open after a previous run;
  this resume is a no-op. (`needs-human` is sourced from the canonical
  `TERMINAL_PHASES` in `bin/lib/state.ts`, so a crashed escalation
  resolves `terminal` instead of falling through the row tree.)
- **No-in-flight-work pending phase (`triaged-no-change` /
  `triage-pending-clarification`).** `flow-resume-decide` short-circuits
  these to `terminal` pre-tree (reasons `no-change-investigation-complete` /
  `awaiting-triage-clarification`) — they carry no worktree, plan, or PR, so
  there is nothing to resume and no gate-summary status applies. On
  `triaged-no-change`, re-print the saved `$ANSWER` (from `.context.answer`,
  extracted alongside the other `RESULT`/`jq` fields above) as markdown when
  it is non-empty, so the user re-reads the original answer; otherwise print a
  one-line note that the pipeline already completed (a no-change
  investigation, or one awaiting a clarification a resume can't re-ask) and
  end. Do **not** fall through to step 2 and build a worktree — that was the
  bug this short-circuit closed.

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
  `flow-gate-summary --status merged ...` (BEFORE the terminal state
  transition), then run `flow-remove-worktree --delete-branch`, write
  `phase: merged`), not step 10.
  The roadmap row was flipped to `✅ shipped (#$PR)` in the PR's own
  diff by `/pr-review` step 7.5, so no post-merge sweep is needed.
- It does not rewrite state.json on entry. The first transition you
  make from your re-entry step is what updates phase.

# Resource cleanup (before any terminal state)

Before the supervisor reaches **any** terminal state — `MERGED`,
`GATED`, `NEEDS HUMAN`, or `cancelled` — every resource a pipeline step
or sub-skill spawned must already be torn down. A flow agent never
leaves a spawned resource running on the user's machine. The covered
resource classes are:

- **Dev servers / launch subprocesses** — already torn down by the
  UI-smoke and UI-validation passes ("tear the launched server(s) down
  on completion").
- **chrome-devtools MCP pages/contexts** — the per-pipeline isolated
  page each browser pass opens (`new_page` + `isolatedContext`) is
  closed with `close_page` (disposing the `isolatedContext`) on
  completion **and on every error / early-exit path**, symmetric with
  the server teardown. The teardown is scoped strictly to the
  page/context THIS pipeline opened (keyed on the pipeline slug) — never
  a sibling pipeline's page, never the user's own Chrome. The contract
  lives in [references/ui-smoke-pass.md](references/ui-smoke-pass.md)
  "Teardown" and `/pr-review`'s
  `references/ui-validation-evidence.md` "Teardown".
- **Playwright / headless browsers** — any repo headless browser an
  agent stood up (the Step 8c.iii fallback) exits when its Bash
  invocation returns; nothing persists past the call.
- **Background processes** — anything launched `run_in_background` (the
  `flow-ci-wait` poll loop is the canonical case) reaches a terminal
  exit or is reaped before the pipeline ends.

This is a contract, not a swept safety net: cleanup happens at the
point of use (where the handle is held), not via a supervisor-level
sweep at terminal time. A terminal-state sweep of chrome-devtools pages
was evaluated and **deliberately not built** — parallel pipelines may
share one un-isolated MCP server, so a `list_pages`-and-close sweep
cannot reliably distinguish this pipeline's page from a sibling's or
the user's own Chrome, and would risk the exact harm it set out to
prevent. The operator-side `--isolated` MCP registration plus
point-of-use teardown is the scope-safe fix. The same discipline is a
standing rule for every agent in this repo — see `AGENTS.md` `## Don'ts`
"Don't leave spawned resources running".

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
render the NEEDS HUMAN block via `flow-gate-summary`, **then** transition
state and fire the notification. The render must happen before
`flow-state-update --phase needs-human` so a render failure leaves
state.json non-terminal and `flow-stop-guard` keeps nudging; the
existing `# End conditions` sentinel contract is preserved either
way (the helper's final stdout line is the byte-exact sentinel
`NEEDS HUMAN: <reason>`):

```bash
flow-followups run --note-only > "$WORKTREE/.flow-tmp/followups-block.txt"  # captures the deferred LOCAL FOLLOW-UPS block (empty when log is empty)
SLUG=$(tmux show-options -t "$TMUX_PANE" -v -w @flow-slug)                  # resolve slug for the state-file path
ECHO_PROSE_ARGS=()  # echo-prose only on POST-review escalations (a PR exists); guard the field fetch + flags on [ -n "$PR" ] — pre-review escalations have no PR/plan
[ -n "$PR" ] && gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName > "$WORKTREE/.flow-tmp/pr-view.json"  # guard: some escalations precede PR creation; ONE gh pr view round-trip (diff-size + url/title/headRefName)
[ -n "$PR" ] && IFS=$'\t' read -r PR_URL PR_TITLE PR_BRANCH < <(jq -r '[.url, .title, .headRefName] | @tsv' "$WORKTREE/.flow-tmp/pr-view.json") && ECHO_PROSE_ARGS=(--echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH")
[ -n "$PR" ] && jq '{additions,deletions,changedFiles,commits:(.commits|length)}' "$WORKTREE/.flow-tmp/pr-view.json" > "$WORKTREE/.flow-tmp/pr-changes.json"
flow-pipeline-summary --status needs-human --state-file ~/.flow/state/"$SLUG".json --pr-changes-file "$WORKTREE/.flow-tmp/pr-changes.json" --pr-review-result "$WORKTREE/.flow-tmp/pr-review-result.json" --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --consolidator-result "$WORKTREE/.flow-tmp/consolidator-result.json" --ci-wait-result "$WORKTREE/.flow-tmp/ci-wait-result.json" --followups-block-file "$WORKTREE/.flow-tmp/followups-block.txt" --filed-issues-file "$WORKTREE/.flow-tmp/filed-issues.txt" "${ECHO_PROSE_ARGS[@]}"  # prints the ## PIPELINE SNAPSHOT block ABOVE the gate-summary (and the echo recap on top when a PR exists); absent artifacts render as `none`
flow-gate-summary --status needs-human --reason "<reason>" \
  --why "<one-line context>" \
  --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt"
flow-state-update --phase needs-human
flow-notify --status needs-human --reason "<reason>"
```

On a POST-review escalation (a PR exists), after the helper runs, extract the
block between `<!-- flow-echo-recap:start -->` and `<!-- flow-echo-recap:end -->`
from the helper output and echo it VERBATIM as markdown bullets in your assistant
message (prose, not tool output) — see the
[Gate-stage echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose)
subsection. PRE-review escalations (triage-ambiguous, worktree-create-failed,
plan-missing) have no PR/plan, so `ECHO_PROSE_ARGS` stays empty and no recap is
emitted.

The helper looks up the `NEXT ACTION` text from
`NEXT_ACTION_BY_REASON` in `bin/flow-gate-summary.ts` keyed off
`<reason>`, falling back to `DEFAULT_NEXT_ACTION` for unmapped tags;
the final line of stdout is the byte-exact sentinel
`NEEDS HUMAN: <reason>`. Do **not** call `flow-remove-worktree` on
escalation — leave the worktree + PR (and the JSONL log) intact so
the user can inspect and resume.

## Branch-mismatch escalation (no retries)

When `flow-state-update` exits with status 3, the worktree's branch
no longer matches the `.flow-branch` marker written by
`flow-new-worktree`. This means a peer pipeline (or a stray manual
git command) renamed this branch out from under us — the same family
of failure as the 2026-05-01 incident. The mechanical guard refused
to write the phase transition; the supervisor must NOT retry.
Escalate immediately:

```bash
flow-gate-summary --status needs-human --reason branch-mismatch \
  --why "<expected vs actual from stderr>"                  # render BEFORE the terminal state transition
flow-state-update --phase needs-human  # may itself fail; that's ok, scrollback shows the cause
flow-notify --status needs-human --reason "branch-mismatch"
```

There is no auto-recovery — branch state is load-bearing and the
user must inspect (`git reflog`, `git worktree list`) to decide
whether the rename was malicious, accidental, or expected. Leave the
worktree + PR intact.

## Terminal-regression escalation (no retries)

When `flow-state-update` exits with status 4, a terminal→non-terminal
phase regression was detected — the existing phase in state.json is one
of `merged`, `gated`, `needs-human`, `cancelled`, or `epic-approved`,
but the requested transition would move to a non-terminal phase. This
signals an ambient-pane race that wrote to the wrong pipeline's state:
`resolveSlugFromPane()` resolved a stale or mismatched slug and the
write was blocked by the mechanical guard. The supervisor must NOT retry.
Escalate immediately:

```bash
flow-gate-summary --status needs-human --reason terminal-regression \
  --why "<expected→actual from stderr>"   # render BEFORE the terminal state transition
flow-state-update --phase needs-human     # may itself fail; that's ok, scrollback shows the cause
flow-notify --status needs-human --reason "terminal-regression"
```

There is no auto-recovery — the guard blocked the write precisely to
avoid corrupting a finished pipeline's terminal state. Leave the worktree
+ PR intact for the user to inspect.

If you suspect the victim pipeline's state was already corrupted by a
prior race, the operational recovery for an already-corrupted pipeline is:

```bash
flow-state-update --phase <merged|gated|needs-human|...> --force --slug <victim-slug>
```

`--force` bypasses the regression guard; `--slug` targets the specific
pipeline rather than relying on pane resolution. Use only after confirming
which pipeline's state needs correction.

## Task-tool unavailable (no retries)

Fires when any of the nine spawn procedures' load step
(`ToolSearch query="select:Task"`) returns a response that does not
contain *either* a `<function>{"name": "Task", ...}</function>` *or* a
`<function>{"name": "Agent", ...}</function>` line — i.e. the harness
has surfaced neither alias of the one-shot subagent-spawn primitive
top-level in the current session. The supervisor must NOT fall back
to in-line execution; in-line fallback breaks the context-isolation
contract each Task-tool exemption is justified by (PR #124 was the
inaugural silent-fallback regression). Escalate immediately:

```bash
flow-followups run --note-only > "$WORKTREE/.flow-tmp/followups-block.txt"
flow-gate-summary --status needs-human \
  --reason "task-tool-unavailable: <exemption-name>" \
  --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt"   # render BEFORE the terminal state transition
flow-state-update --phase needs-human
flow-notify --status needs-human --reason "task-tool-unavailable: <exemption-name>"
```

The helper parses the `:`-suffix and appends ` (spawn site:
<exemption-name>)` to `NEXT_ACTION_BY_REASON["task-tool-unavailable"]`
so the rendered NEXT ACTION line names the exact spawn site that lost
its Task tool — without this, all nine exemption sites would collapse
to the same generic remediation string. The sentinel line is byte-exact
`NEEDS HUMAN: task-tool-unavailable: <exemption-name>`.

`<exemption-name>` is the spawn site's canonical name — one of
`pr-review-gatekeeper`, `pr-review-multi-agent-review`,
`pr-review-fix-applier`, `pr-review-consolidator-validator`,
`product-planning-discovery`,
`new-feature-scout`, `coder-edit-applier`,
`flow-pipeline-merge-resolver`, `flow-pipeline-verify-loop`.

No retry is appropriate because the deferred-tool surfacing is
environmental — user remediation is to re-run in a session where
either `Task` or its alias `Agent` is surfaced top-level (typically
by restarting `claude` or upgrading the CLI). This complements (does not replace) the
per-step retry caps in `references/failure-recovery.md`. Leave the
worktree + PR intact.

The `pr-review-multi-agent-review` and `pr-review-fix-applier`
exemption sites are now both reachable from the supervisor's
in-process Skill load — the `context: fork` frontmatter directive
has been removed from `/pr-review`, so the wrapper runs inside the
supervisor's session rather than in a forked subprocess. The
escalation fires only if the supervisor's own session has neither
`Task` nor `Agent` surfaced top-level. In that case, the
escalation tag is written verbatim into
`<worktree>/.flow-tmp/pr-review-result.json` with
`status: "escalated"` before `/pr-review` exits, and step 8's
artifact-read above propagates the tag back into `NEEDS HUMAN:
<escalation_tag>` rather than re-discovering it from scrollback.

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
  `flow-remove-worktree`, write `phase: cancelled`, then render the
  CANCELLED block via `flow-gate-summary --status cancelled --why
  "user cancelled mid-flight at $(jq -r .phase ~/.flow/state/$SLUG.json)"`,
  end.
- Ambiguous → one clarifying question; if still unclear, escalate.

## Mid-flight code-change redirects

An imperative redirect splits into two kinds. A **scope/plan redirect**
("redo the plan with different scope") re-runs `/product-planning` or
re-prompts the in-flight sub-skill — the existing behaviour above. A
**code-change redirect** ("rename foo to bar", "change this line") is
different: when it arrives at a phase where the worktree already exists
(`plan-pending-review`, `implementing`, `verifying`, `ci-wait`,
`reviewing`) and is NON-trivial, the supervisor routes it through
`/coder` rather than editing inline. This is the
**interactive code-change redirect** path: the supervisor composes a structured
edit-set `{file, intent, expected_outcome}` from the verbatim redirect,
invokes `/coder` in-process, and reads `.flow-tmp/coder-result.json`
(`verify_status` + `summary`) exactly once — it never sees the per-edit
diff.

A trivial edit may stay inline: ≤1 file AND ≤30 LOC AND every file named
in the redirect (the same bar `/new-feature` step 5 uses). This routing
is distinct from a scope/plan redirect, which re-runs
`/product-planning` or re-prompts the sub-skill — do not collapse the two
paths. See `references/redirect-handling.md` for the per-phase matrix.

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
ci-wait-pending                    (step 7 yield while flow-ci-wait is backgrounded)
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
  via the nine named exceptions in "Hard rules" above:
  `/pr-review`'s "Independent Multi-Agent Review",
  `/product-planning`'s "Independent Discovery Subagent",
  `/new-feature`'s "Independent Scout Subagent",
  `/pr-review`'s "Independent Fix-Applier Subagent",
  step 10's "Merge-Conflict Resolver Subagent",
  `/coder`'s "Independent Edit-Applier Subagent",
  `/pr-review`'s "Independent Gatekeeper Subagent",
  `/pr-review`'s "Independent Consolidator-Validator Subagent",
  and step 6's "Verify-Retry-Loop Subagent".
  No other skill or step may call Task.
- The supervisor never spawned a `claude -p` subprocess.

When the pipeline ends, scrollback contains exactly one of `MERGED`
/ `GATED: <url>` / `NEEDS HUMAN: <reason>` / `cancelled` on its own
line, and the corresponding `phase:` is in state.json.

When `FLOW_NOTIFY=1` is set in the supervisor's environment, every
terminal end-state (`merged`, `gated`, `needs-human`) is preceded
by a `flow-notify` call. The helper is a no-op when the env var is
unset, so the call is unconditional from the skill's perspective.
