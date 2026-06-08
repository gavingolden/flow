# Phase 7 — gate

The pipeline's auto-merge decision point. Reads the rendered PR body's
`## Test Steps` section, strips HTML comments and whitespace, and
decides whether the PR can auto-merge or whether a human needs to perform
validation steps before merging.

**Status: shipped (PR 8).**

## Inputs

- A task file with `status: reviewing` (clean review just finished),
  `gating` (mid-flight resume), or `gated` (resume after a gated PR was
  merged externally), plus `worktree` (absolute path) and `pr` (integer)
  populated.
- A PR on the remote whose body contains a `## Test Steps`
  section. The implement-phase `TEST_STEPS_RULE` documents the
  contract for the LLM that authors the body; the gate enforces it for
  the runner.

## Outputs

- `## Phase outputs > gate` populated with the decision and the data the
  decision was derived from. One of:
  - **auto-merge** (`OPEN`, section empty after strip-and-trim) — records
    `test_steps: false` and the handoff to merge.
  - **gated** (`OPEN`, section non-empty) — records the validation steps
    verbatim so a post-mortem reader sees what blocked auto-merge.
  - **already-merged** (`MERGED`) — records the merge SHA and the handoff
    to merge for cleanup.
  - **pr-closed-without-merge** (`CLOSED`) — records the state and the
    needs-human escalation.
  - **test-steps-section-missing** — defensive, surfaces a
    hand-edited or regressed PR body.
  - **gh-error / pr-missing / worktree-missing** — preflight or `gh pr
view` failures.
- `frontmatter.test_steps` set to `true` (gated) or `false`
  (auto-merge).
- `frontmatter.merge_commit` set when state is `MERGED` and the SHA
  wasn't already recorded — supports the gated-then-user-merged-externally
  resume path so merge has the SHA without a second `gh pr view`.

Status transitions:

- `reviewing → gating → merging` — empty section, auto-merge path.
- `reviewing → gating → gated` (with `test-steps-required`
  reason) — non-empty section, needs human.
- `gated → gating → merging` — resume after a user merged the PR
  externally; gate observes `state: MERGED` and hands off to merge.
- `reviewing → gating → needs-human` — defensive branches
  (`pr-missing`, `worktree-missing`, `gh-error`, `pr-closed-without-merge`,
  `test-steps-section-missing`).

## Wrapping prompt

N/A — gate is a script-only phase. No LLM, no headless invocation. The
decision is fully derived from `gh pr view --json body,state,mergeCommit`
plus the pure helpers in `gate-helpers.ts`. This matches the architecture
invariant that "the orchestrator carries no LLM context."

## The strip-and-trim contract

The PR body's `## Test Steps` section is parsed in three steps:

1. Extract the section body via the same regex shape used by
   `verify-gate.ts`'s `upsertCautionBlock` — anchored at column 0, runs
   to the next `## ` heading or end-of-input.
2. Strip all HTML comments (`<!--[\s\S]*?-->`, multi-line supported).
3. Trim. Empty result ⇒ `test_steps: false` (auto-merge).
   Non-empty ⇒ `test_steps: true` (gated).

This is the single source of truth for "is the section actually
populated." The implement phase's `TEST_STEPS_RULE` documents the
contract for the LLM so it produces the right shape; the helpers in
`src/pipeline/phases/gate-helpers.ts` enforce it for the runner.

## Failure modes

- **`pr-missing` (preflight).** `task.frontmatter.pr` is null. Mirrors
  ci-wait and review's pre-checks.
- **`worktree-missing` (preflight).** The worktree path in frontmatter
  is null or doesn't exist on disk. The gate needs a gh-aware cwd to
  shell out to `gh`; without one we surface to needs-human rather than
  guess.
- **`gh-error`.** `gh pr view` exited non-zero or returned unparseable
  JSON. The gate doesn't retry — gh failures here are typically auth or
  permission issues that need human attention.
- **`pr-closed-without-merge`.** The PR was closed via the GitHub UI
  without merging. Operator decides: reopen, recreate, or abandon.
- **`test-steps-section-missing`.** The implement phase always
  writes the heading. Missing means a hand-edited PR or a regression
  upstream. Surfacing rather than guessing intent keeps the auto-merge
  path safe.
- **`test-steps-required`.** Not a failure mode — the
  designed-for "needs human" outcome. The PR carries the validation
  steps, the user performs them, the user merges via GitHub UI, and the
  next `flow run <id>` re-enters gate, observes `state: MERGED`, and
  hands off to merge.

## Idempotency / resume

- Re-entering with `status: reviewing` is the canonical entry — the
  runner reaches gate after review keeps the task at `reviewing` on a
  clean cycle.
- Re-entering with `status: gating` (mid-flight crash) starts a fresh
  decision derived from current PR state. The transition to `gating` is
  a no-op in this case (already there). No review re-spawn — gate's
  `unfinishedStatuses` includes `gating` so the runner does not re-enter
  review.
- Re-entering with `status: gated` is the user-merged-externally resume
  path. Gate re-fetches state, observes `MERGED`, captures the SHA, and
  transitions to `merging`.

The decision is always derived from the _current_ `gh pr view` payload —
no in-phase mutable state can corrupt it across re-entries.

## Implementation

| File                                  | Role                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/pipeline/phases/gate.ts`         | Phase entry, gh-CLI shell-out, status transitions, phase-output rendering                                           |
| `src/pipeline/phases/gate-helpers.ts` | Pure helpers: section extraction, HTML-comment stripping, decision enum                                             |
| `src/state/phases.ts`                 | `gating` and `gated` statuses + `STATUS_TO_LAST_CHECKED` / `STATUS_TO_PHASE_LABEL` mappings                         |
| `src/util/notify.ts`                  | `gated` is in `NOTIFY_STATUSES`, so the macOS notifier fires on the `→ gated` transition without phase-side changes |
