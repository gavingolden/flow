## Why

`bin/flow-new-worktree.ts` had grown to 420 lines — over the
AGENTS.md `<200 lines/file` target — by accreting four unrelated
concerns (slot resolution, marker writes, gitignore management, retry
orchestration) into one file. `BRANCH_MARKER_FILENAME` was also
duplicated in `bin/flow-state-update.ts`, and the catch-and-retry
branch in `createWorktreeWithRetry` was only exercised by a
parallel-pipelines integration test that depends on race timing.

## What

- `bin/lib/worktree-slot.ts` owns slot resolution (`findAvailableSlot`,
  `branchExists`, `MAX_SUFFIX_ATTEMPTS`).
- `bin/lib/worktree-marker.ts` owns the post-creation marker family
  (`BRANCH_MARKER_FILENAME`, `FLOW_TMP_DIRNAME`, `writeBranchMarker`,
  `ensureFlowTmpExclude`, `ensureGitignoreMarkerEntry`).
- `bin/flow-state-update.ts` imports `BRANCH_MARKER_FILENAME` from the
  new module — single source of truth.
- `bin/flow-new-worktree.ts` is now under 200 lines and only handles
  CLI, preflight, symlink setup, retry orchestration, and `main()`.
- `createWorktreeWithRetry` accepts an optional `gitWorktreeAdd`
  callable so the retry path is unit-testable without race timing.
- New unit tests cover both the retry-then-succeed and retry-exhaustion
  branches.

## Key decisions

- **Marker module owns the constant.** `BRANCH_MARKER_FILENAME` lives
  in `worktree-marker.ts` (not a separate `branch-marker.ts`) because
  the marker writes are its primary concern; a third single-constant
  module would be premature abstraction.
- **No barrel re-exports.** `bin/flow-new-worktree.ts` no longer
  re-exports the moved symbols; the test file imports from the new
  locations directly. AGENTS.md: no backwards-compat shims.
- **Test seam via callable parameter, not module-level monkey-patching.**
  Adding an optional `gitWorktreeAdd` param keeps the test injection
  explicit and matches how `findAvailableSlot` is already parameterised
  by `repoDir`.

## User-facing changes

none

## Manual validation

<!-- No human verification needed — pure-internal refactor; test suite is the gate. -->
