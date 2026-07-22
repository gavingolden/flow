# Git workflow deep-dives

Offload target for `AGENTS.md` `## Git workflow` mechanics and several
`## Don'ts` bullet bodies that need a durable home but must not become a
new `## ` section in [exemption-contracts.md](exemption-contracts.md) —
that file's h2 sections are pinned 1:1 to the nine Task-tool exemptions
by `bin/skill-md-lint.test.ts`.

## Session marker + trailer mechanics

Every PR `flow-open-pr` freshly creates inside a Claude Code harness ends
with a single-line, self-describing HTML-comment marker —
`<!-- flow: this PR was created by Claude Code session <id> - transcript
at ~/.claude/projects/<encoded-cwd>/<id>.jsonl on the originating machine
-->` — sourced from the `CLAUDE_CODE_SESSION_ID` env var. It is
best-effort and same-machine-only; absent the env var the PR opens with
no marker. Because the marker is an HTML comment it is invisible in
GitHub's rendered view and stripped by the auto-merge gate before it
counts unchecked `- [ ]` items.

The marker is lost from `git history` on squash-merge, so the same
session ID also reaches `git log` / `git blame` as a
`Claude-Code-Session-Id:` trailer — but via a per-commit git hook, not
step 10. `flow-new-worktree` installs a worktree-scoped
`prepare-commit-msg` hook (scoped via `extensions.worktreeConfig` + a
worktree-scoped `core.hooksPath` so it never fires for the user's primary
repo) that appends `Claude-Code-Session-Id: <id>` to **every individual
commit** made in the worktree when `CLAUDE_CODE_SESSION_ID` is set. gh's
default squash concatenation of the branch's commit messages then carries
the trailer into the squash-merge commit — `/flow-pipeline` step 10 runs
a bare `gh pr merge --squash` with zero `--body` manipulation. The
optional `sessionId` field in `~/.flow/state/<slug>.json` is still
written by `flow-open-pr` for the HTML-comment marker path, but step 10
no longer reads it.

## Inline intent annotations

Review-time-scoped per-hunk rationale from `/flow-new-feature` Step 5b as
inline PR-diff comments (`**why:** <1-2 sentences>` + `<!--
flow-intent-v1 -->` suffix, disjoint from `/flow-pr-review`'s Conventional
Comments vocab). Not in `git log`/`git blame` post-merge — durable
rationale belongs in commit-body Why-sections + PR body's `## Why`, with
the exception of surplus (capped-out) hunks: those are pointed at the
commit messages via an `overflowNote` callout appended to the END of the
PR body (outside `## Why`) rather than inlined under it. See
`skills/pipeline/flow-new-feature/SKILL.md` Step 5b (rules a/b/c,
per-file dedup, floor/ratio/ceiling scaling cap — `flowAnnotatePr`
override in `~/.flow/config.json`, `overflowNote`) and
`skills/pipeline/flow-pr-review/SKILL.md` Step 3 for `/flow-pr-review`'s
`{{EXISTING_INTENT_COMMENTS}}` consumption.

## Shared rationale for the nine Task-tool exemptions

`/flow-pipeline`'s "Hard rules" forbid the supervisor from calling the
`Task` / `Agent` tool, with nine named exceptions. The same rationale
covers all nine: (a) the supervisor is itself a top-level Claude Code
session at depth 1, so its own Task calls are never themselves nested;
flow chooses flat one-shot
fan-out even though nesting is now platform-possible — with one
sanctioned nested site, verify-loop → edit-applier, inside the
Verify-Retry-Loop exemption; (b) each subagent is one-shot (returns an artifact + brief
summary, then exits), so the context-bloat constraint doesn't apply
either; (c) every exemption is anchored on its step _heading name_, not
its number, so it survives renumbering; (d) every exemption is documented
bidirectionally in `skills/pipeline/flow-pipeline/SKILL.md` "Hard rules"
and the consumed skill's own SKILL.md; (e) the narrow-and-named-contract
discipline applies — each names exactly one spawn site, and a future
skill needing the same license must be added here by name rather than
generalising the rule. Each exemption's unique contract — spawn site /
triggering step, artifact path, typed artifact fields, model override,
edge-case prose — lives in
[exemption-contracts.md](exemption-contracts.md).

## AskUserQuestion exemption bodies

**Candidate-issues form (two firing locations).** The multi-select form
that picks which orthogonal candidates to file post-merge. It is ONE
named form fired from TWO locations: (a) step 4's "Candidate follow-up
issues sub-step" on the Affirmative branch, and (b) step 3's "Candidate
follow-up issues sub-step (non-feature intents)" on the
`advance-to-step-5` branch (so bug/refactor/docs/infra/chore pipelines,
which skip step 4, still get offered their discovered follow-ups). The
five-branch decision is owned by the LLM-free `flow-candidate-issues`
helper; the `AskUserQuestion` primitive and the decision to fire it stay
in the supervisor sub-steps.

**Step 9 gate-override sub-step.** The single confirmation form fired
during step 9's "Gate override (post-verdict, opt-in)" sub-step, when the
user instructs the supervisor to merge a `gated` PR anyway — a _fresh_
confirmation that puts the gate verdict in front of the user rather than
inferring authorisation from an earlier instruction. An affirmative
answer is recorded by `flow-merge-guard --record-override` and enforced
by the step-10 backstop.

These two named forms are the **only** authorised `AskUserQuestion`
sites, documented bidirectionally with
`skills/pipeline/flow-pipeline/SKILL.md`.

## Auto-merge exemption detail (`/flow-pipeline` step 10)

The exemption covers exactly one operation: `gh pr merge --squash <PR>`
inside step 10, only when the auto-merge gate fires (`flow-gate-decide`
returns `auto-merge` — the Test Steps section has zero unchecked items)
and only on a PR opened by `/flow-pipeline` itself. It does **not**
extend to a `gated` verdict: a `gated` verdict is terminal, and a `gated`
PR is merged by `/flow-pipeline` only through the fresh-confirmation
gate-override path (a new, unambiguous, in-context user instruction
confirmed via `AskUserQuestion`, recorded by `flow-merge-guard
--record-override`, enforced by the `flow-merge-guard` step-10 backstop).
The supervisor may never substitute its own judgment for a `gated`
verdict — see
`skills/pipeline/flow-pipeline/references/auto-merge-rubric.md` "A
`gated` verdict is terminal, not advisory".

**Anti-patterns this exemption explicitly forecloses:** (a)
reclassifying an unchecked functional Test Steps item as "subjective UX"
so the gate verdict comes out as `auto-merge`; (b) merging a `gated` PR
on the strength of a stale or inferred "merge" / "ship it" instruction
given before the gate verdict was surfaced.

Invoking `/flow-pipeline` is itself the user's authorisation; opt out
per-pipeline with `flow feature create --no-auto-merge` (the supervisor
stops at the gated state regardless of the gate verdict).

## Auto-issue-create exemption detail

`flow-create-issue` may fire only from two named sites: (a)
`/flow-pr-review` deferring a finding past the 3-criterion bar
(`--label flow-agent,deferred-review`), and (b) `/flow-pipeline` step
10's post-merge sweep (`--label flow-agent,out-of-scope-discovery`, once
per `- [x]` candidate in plan.md). Indiscriminate auto-creation pollutes
backlogs and races on `gh` rate limits; both sites have explicit user
opt-in. Documented bidirectionally in
`skills/pipeline/flow-pipeline/SKILL.md`,
`skills/pipeline/flow-pr-review/SKILL.md` Step 6, and
`bin/flow-create-issue.ts`.

## `/flow-epic-create` and `/flow-epic-run` detail

`flow epic create` spawns a fresh top-level `/flow-epic-create` session,
so `/flow-pipeline`'s exactly-9 and two-form rules are unaffected by its
two named surfaces (distinct openers, in
`skills/pipeline/flow-epic-create/SKILL.md`): **Task-tool fan-out:
`/flow-epic-create` → /flow-product-planning MODE: epic designer.** and
**AskUserQuestion form: `/flow-epic-create` clarification round.** Its
cross-model design review is a Bash fan-out, not a tenth exemption —
`review.gemini`-gated `flow-plan-review` over `design.md`; no Task, no
form; graceful skip sans agy.

`flow epic run <slug>` opens a fresh `/flow-epic-run` playbook session
(invariants unaffected) — a playbook, not a loop: an LLM reconciles the
manifest against GitHub/git truth and repairs run.json drift via
`flow epic bind` / `flow epic launch`, one human-in-the-loop step at a
time. Zero named fan-out: no Task/Agent sub-agent, no AskUserQuestion
form. `gated ⇒ escalate-only`, never merges a feature PR.
