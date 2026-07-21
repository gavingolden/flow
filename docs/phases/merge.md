> [!WARNING]
> **Historical document.** This describes the deleted Node-orchestrator era of flow and is kept as a historical artefact. For the current state, see the [README](../../README.md) and [AGENTS.md](../../AGENTS.md).

# Phase 8 — merge

The pipeline's terminal phase. Squash-merges the PR, captures the merge
commit SHA, removes the worktree, and archives the task file. Closes the
auto-merge loop so a low-risk task reaches `merged` with no human touch.

**Status: shipped (PR 8).**

## Inputs

- A task file with `status: merging`, `worktree` (path), `branch`
  (string), `target_repo` (path), and `pr` (integer) populated. Gate is
  the only path into merge under normal flow.
- A `scripts/remove-agent-worktree.ts` script in the target repo (linked
  by `flow install`). Best-effort: a missing or failing script does not
  block archive.

## Outputs

- `## Phase outputs > merge` populated with:
  - The PR number and whether merge ran fresh or was a no-op
    (idempotent short-circuit on a re-entry where the PR is already
    `MERGED`).
  - `merge_commit` SHA.
  - Branch deletion status.
  - Worktree-removal outcome: `removed`, `already gone (no-op)`, or
    `WARN: <stderr/reason>`.
  - The archive path (`.orchestrator/tasks/archive/<id>.md`).
- `frontmatter.merge_commit` populated with the squash-merge SHA when
  not already set.
- The task file moved from `.orchestrator/tasks/<id>.md` to
  `.orchestrator/tasks/archive/<id>.md` (POSIX-atomic `fs.rename`). The
  in-memory `Task.path` is updated so the final `transitionStatus` to
  `merged` writes to the new location.

Status transitions:

- `merging → merged` — happy path, PR squash-merged, worktree removed,
  task archived.
- `merging → needs-human` with reason `pr-missing` (preflight),
  `worktree-missing` (frontmatter null), `gh-error` (gh pr view failed),
  `gh-merge-failed` (gh pr merge non-zero), or `pr-closed-without-merge`
  (defensive — shouldn't fire because gate routes CLOSED to needs-human).

## Wrapping prompt

N/A — merge is a script-only phase. No LLM, no headless invocation. All
side effects go through `gh`, the target-repo's
`remove-agent-worktree.ts` script, and `fs.rename`.

## Idempotency contract

Merge is designed to re-enter cleanly after a crash at any point:

1. **Pre-`gh pr merge` crash.** Re-entry re-checks PR state via
   `gh pr view --json state,mergeCommit`. If `state: OPEN`, the merge
   call fires (idempotent on the gh side too — gh refuses to re-merge a
   merged PR).
2. **Post-`gh pr merge`, pre-cleanup crash.** Re-entry observes
   `state: MERGED`, skips the merge call, captures the SHA, and
   continues to worktree-removal + archive.
3. **Post-cleanup, pre-archive crash.** Re-entry observes the worktree
   is already gone (`existsSync` false), skips the removal script, and
   archives.
4. **Post-archive, pre-final-transition crash.** The task file is
   already at the archive path. Re-entry detects this and skips the
   rename, then finalises the transition.

Worktree removal is wrapped in best-effort semantics: a non-zero exit
from `remove-agent-worktree.ts` is downgraded to a `WARN:` line in the
phase output and a logger warning, but the merge phase still returns ok
and the task still reaches `merged`. The PR is already merged at that
point — rolling back is impossible — so an archive failure would just
strand the task.

## Failure modes

- **`pr-missing` (preflight).** `task.frontmatter.pr` is null. Mirrors
  gate, ci-wait, and review's pre-checks.
- **`worktree-missing` (preflight).** Worktree path is null in
  frontmatter (the worktree phase never set it). Distinct from "the
  worktree directory was already removed on disk" — that case is
  best-effort below.
- **`gh-error`.** `gh pr view` failed or returned unparseable JSON.
  Surfaces to needs-human.
- **`gh-merge-failed`.** `gh pr merge --squash --delete-branch` exited
  non-zero. Typically a permissions or branch-protection issue
  requiring human attention. The merge phase does not retry — merging
  is a stateful side effect, not an idempotent read.
- **`pr-closed-without-merge`.** PR was closed between gate and merge.
  Defensive — gate should have caught this; treated as needs-human for
  consistency.

## Worktree removal

Invokes `<target_repo>/scripts/remove-agent-worktree.ts <branch>
--delete-branch` with `cwd: target_repo`. The script handles being
invoked while another worktree may have been the caller's CWD; running
from the primary worktree avoids the "remove the directory I'm standing
in" gotcha.

If the worktree directory is already gone (a prior partial run cleaned
it up), the script invocation is skipped entirely.

## Archive

`.orchestrator/tasks/archive/` is created lazily via `mkdir -p` at merge
time — no `flow install` step required. The rename is a single
POSIX-atomic step.

## Implementation

| File                                         | Role                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/pipeline/phases/merge.ts`               | Phase entry, gh-CLI calls, worktree removal, archive, final transition                                                |
| `src/state/phases.ts`                        | `merging` and `merged` statuses + helpers                                                                             |
| `templates/scripts/remove-agent-worktree.ts` | Worktree removal script (linked into target repo by `flow install`)                                                   |
| `src/util/notify.ts`                         | `merged` is in `NOTIFY_STATUSES`, so the macOS notifier fires on the `→ merged` transition without phase-side changes |
