# Phase 3 — implement

The M2 terminal phase. Spawns a headless Claude session **inside the
worktree** to invoke `/new-feature`, write code, write tests, commit,
push, and open a PR. Records the PR number on the task and exits.

**Status: shipped (M2).**

## Inputs

- A task file with `status: worktree-ready`, `worktree` (absolute path),
  and `branch` (string) populated.
- Plan deliverables in
  `<target-repo>/.orchestrator/tasks/<id>-plan/`:
  - `prd.md`
  - `task-breakdown.md`
  - `pr-description-draft.md`

## Outputs

- `frontmatter.pr` — GitHub PR number (integer).
- `## Phase outputs > implement` populated with PR + branch.
- A pushed branch + open PR on the target repo's GitHub remote.

Status transitions: `worktree-ready → implementing → pr-open`.
`pr-open` is the M2 terminal status — M3 phases (verify, ci, review)
take over from there.

## Wrapping prompt — the Manual validation rule

`/new-feature` doesn't know about flow's auto-merge rule. The implement
phase wraps the slash-command invocation with an instruction (the
`MANUAL_VALIDATION_RULE` constant in
`src/pipeline/phases/implement.ts`) telling the skill to populate a
`## Manual validation` section in the PR body when the diff matches
risky-change heuristics:

- a database migration
- a new external API integration
- a UI change (`.svelte` files in `src/lib/`)
- a behaviour change to a critical path

For pure refactors / docs / internal-logic changes, the skill leaves
the section empty (heading + an HTML comment). The gate phase (M4)
parses this section and decides whether to auto-merge or escalate to
`needs-human`.

This wires in via option (A) from m2-plan.md §"Phase 3 — implement"
— a wrapping prompt rather than a skill upstream change. Revisit when
M4 lands and we see how reliable the heuristic is in practice.

## Reading the plan phase's draft

The wrapping prompt explicitly points the skill at
`<plan-dir>/pr-description-draft.md` as the seed for the PR body. The
skill should distil the draft into the actual PR description rather
than paste it verbatim — `pr-description-draft.md` may include scope
details that don't belong in the final PR description.

## Detecting the opened PR

After the headless run exits 0, the phase queries
`gh pr list --head <branch> --json number --limit 1` from the worktree
and parses the first match. If `gh` returns an empty list, the phase
fails with reason `"implement returned ok but no PR was opened"` —
this is an integrity check, not a retry trigger.

## Allowed tools / timeout

The phase grants a wide tool set because real implementation needs it:

```
Read, Write, Edit, MultiEdit, Glob, Grep,
Bash(npm *), Bash(git *), Bash(gh *), Bash(npx *), Bash(bun *), Bash(node *)
```

Timeout: 30 minutes. Real features take time; cutting too short causes
spurious retries.

## Failure modes / retry

m2-plan.md grants one retry. Implementation:

- The phase wraps the headless call in `retryOnce`. The second attempt
  receives the first failure's stderr/stdout appended to the prompt
  with instructions to revise the approach.
- If both attempts fail, the phase returns `status: failed` with the
  last failure log as the reason.
- If `gh pr list` returns empty after a successful headless run, the
  phase fails immediately — this isn't a flaky condition and retry
  won't help.

## Idempotency / resume

If `frontmatter.pr` is already set, the phase short-circuits to
`status: ok` and bumps status to `pr-open` (handles crash-recovery
where `pr` was written but the final transitionStatus didn't run).
Re-running `flow run <id>` on a `pr-open` task is a no-op end-to-end
— see `acceptance criteria` in m2-plan.md.

## Implementation

| File | Role |
|---|---|
| `src/pipeline/phases/implement.ts` | Phase entry, wrapping prompt, PR detection, status transitions |
| `src/pipeline/headless.ts` | Generic `claude -p` wrapper |
| `src/pipeline/retry.ts` | `retryOnce` |
