# PRD

## Problem statement

`bin/flow-new-worktree.ts` is 420 lines — over the AGENTS.md `<200 lines/file`
target. It mixes four unrelated concerns: CLI parsing, slot resolution
(`findAvailableSlot` + suffix collisions), post-creation marker writes
(`writeBranchMarker`, `ensureFlowTmpExclude`, `ensureGitignoreMarkerEntry`),
and the retry-on-race orchestrator (`createWorktreeWithRetry`). Two
secondary bugs ride along: `BRANCH_MARKER_FILENAME` is duplicated in
`bin/flow-state-update.ts` (drift hazard — the two consumers must always
agree on the filename), and `createWorktreeWithRetry`'s catch-and-retry
branch is uncovered by unit tests, relying on the parallel-pipelines
integration test to exercise it via a real race window. Item 21 in
`docs/roadmap.md` bundles these three followups since they touch the same
file.

## Scope boundary

**In scope:**

- Split `bin/flow-new-worktree.ts` into `bin/lib/worktree-slot.ts`,
  `bin/lib/worktree-marker.ts`, and a slimmer orchestrator.
- One source of truth for `BRANCH_MARKER_FILENAME`, imported by
  `bin/flow-new-worktree.ts` and `bin/flow-state-update.ts`.
- A unit test for `createWorktreeWithRetry` that injects a failing
  `git worktree add` callable and asserts the retry path is taken.

**Out of scope:**

- Behaviour changes to any helper. Pure structural refactor.
- Test-file restructuring beyond what's needed to import from the new
  module locations.
- Wider sweep of "constants duplicated across `bin/`" — only
  `BRANCH_MARKER_FILENAME` is on the list. Other duplications stay.

## Acceptance criteria

- Given the current behaviour of `flow-new-worktree`, when the refactor
  lands, then all existing tests in `bin/flow-new-worktree.test.ts` pass
  unchanged (modulo import paths).
- Given `bin/flow-new-worktree.ts` after the refactor, `wc -l` reports
  fewer than 200 lines.
- Given `bin/flow-state-update.ts`, `BRANCH_MARKER_FILENAME` is imported
  from `bin/lib/worktree-marker.ts`, not redeclared as a local constant.
- Given a new unit test, when `createWorktreeWithRetry` is invoked with a
  `gitWorktreeAdd` callable that throws on its first call and succeeds on
  its second, then it returns the slot from the second attempt.
- Given the same test, when the callable throws on every call up to
  `MAX_RACE_RETRIES`, then the function rethrows the last error.
- Given `npm run typecheck:scripts` and `npm run test`, both exit 0.

## Architecture decisions

- **Split boundaries:** `worktree-slot.ts` owns slot resolution
  (`findAvailableSlot`, `branchExists`, `MAX_SUFFIX_ATTEMPTS`).
  `worktree-marker.ts` owns the post-creation marker family
  (`BRANCH_MARKER_FILENAME`, `FLOW_TMP_DIRNAME`, `writeBranchMarker`,
  `ensureFlowTmpExclude`, `ensureGitignoreMarkerEntry`). The orchestrator
  stays in `flow-new-worktree.ts` along with CLI, preflight, symlink
  setup, and `createWorktreeWithRetry`.
- **One source of truth for `BRANCH_MARKER_FILENAME`:** lives in
  `worktree-marker.ts`, since the marker writes are its primary concern.
  `bin/flow-state-update.ts` and `bin/flow-new-worktree.ts` both import
  from there.
- **Test seam for `createWorktreeWithRetry`:** add an optional
  `gitWorktreeAdd` callable parameter, defaulting to the real
  `git worktree add ...` invocation. Tests inject a failing/succeeding
  fake; production callers pass nothing. Cleaner than process-level
  monkey-patching and consistent with how `findAvailableSlot` is already
  parameterised by `repoDir`.
- **No barrel re-exports.** `bin/flow-new-worktree.ts`'s `export`s of
  the moved constants/functions go away — the test file imports from
  the new locations directly. Flow has no external consumers; AGENTS.md
  says no backwards-compat shims.

## Technical constraints

- Bun runtime, `#!/usr/bin/env bun`, ESM imports (`./lib/<name>` —
  consistent with existing `bin/lib/` modules).
- `<200 lines/file` per AGENTS.md.
- No new comments unless the *why* is non-obvious; lift existing
  doc-comments alongside their functions.

## Open questions

None. The roadmap entry's done-when checklist enumerates everything.

# Task breakdown

### Task 1: Extract `bin/lib/worktree-slot.ts`

- **Skill:** `refactoring`
- **Description:** Move `branchExists`, `findAvailableSlot`, and
  `MAX_SUFFIX_ATTEMPTS` from `bin/flow-new-worktree.ts` into a new
  `bin/lib/worktree-slot.ts`. Keep the `git()` helper local to the new
  file (small enough to duplicate; not worth a third module).
- **Inputs:** existing `bin/flow-new-worktree.ts`.
- **Outputs:** new `bin/lib/worktree-slot.ts` with named exports;
  `flow-new-worktree.ts` imports from it.
- **Acceptance criteria:** `bin/flow-new-worktree.test.ts`'s
  `findAvailableSlot` describe block passes after the import path is
  updated. `npm run typecheck:scripts` clean.

### Task 2: Extract `bin/lib/worktree-marker.ts` (one source of truth for `BRANCH_MARKER_FILENAME`)

- **Skill:** `refactoring`
- **Description:** Move `BRANCH_MARKER_FILENAME`, `FLOW_TMP_DIRNAME`,
  `writeBranchMarker`, `ensureFlowTmpExclude`, and
  `ensureGitignoreMarkerEntry` into a new `bin/lib/worktree-marker.ts`.
  Update `bin/flow-state-update.ts` to import `BRANCH_MARKER_FILENAME`
  from this module (delete the local redeclaration on line 45).
  `bin/flow-new-worktree.ts` imports the rest.
- **Inputs:** Task 1 complete.
- **Outputs:** new `bin/lib/worktree-marker.ts`; updated imports in
  `flow-new-worktree.ts` and `flow-state-update.ts`.
- **Acceptance criteria:** all `writeBranchMarker`,
  `ensureGitignoreMarkerEntry`, `ensureFlowTmpExclude` test blocks pass
  after import-path updates. `flow-state-update.test.ts` (if it
  references the constant) still compiles. Grep confirms exactly one
  occurrence of the literal `".flow-branch"` filename across the repo
  (in `worktree-marker.ts`).

### Task 3: Slim `bin/flow-new-worktree.ts` orchestrator + add retry test seam

- **Skill:** `refactoring`
- **Description:** With the moves complete, the orchestrator file should
  hold just CLI parsing, `parseArgs`, `preflight`, `validateRefName`,
  `validateReusable`, `getPrimaryDir`, `detectDefaultBranch`,
  `symlinkSharedFiles`, `createWorktreeWithRetry`, `main`, and the
  `if (import.meta.main)` guard. Add an optional
  `gitWorktreeAdd?: (args: string[], cwd: string) => void` parameter to
  `createWorktreeWithRetry` (default: invokes `git worktree add ...`)
  so the catch-and-retry branch becomes injectable. Confirm the file
  is under 200 lines (`wc -l bin/flow-new-worktree.ts`).
- **Inputs:** Tasks 1 + 2 complete.
- **Outputs:** slimmer orchestrator; `createWorktreeWithRetry` exposes
  a test seam.
- **Acceptance criteria:** `wc -l bin/flow-new-worktree.ts` < 200.
  All existing integration tests in
  `bin/flow-new-worktree.test.ts` pass unchanged. Production callers
  (`main()`) do not pass `gitWorktreeAdd` — the default real-git path
  is what runs in production.

### Task 4: Unit test for `createWorktreeWithRetry`'s catch-and-retry branch

- **Skill:** `testing`
- **Description:** Add a `describe(createWorktreeWithRetry, ...)` block
  to `bin/flow-new-worktree.test.ts` (or a new
  `bin/createWorktreeWithRetry.test.ts` if scope drifts). Two tests
  minimum: (a) callable throws on attempt 1, succeeds on attempt 2 →
  returns the second-attempt slot, exit code 0; (b) callable throws
  every attempt → rethrows the last error after `MAX_RACE_RETRIES`.
  Use the test fixture (`makeFixture`) to provide a real git repo so
  `findAvailableSlot` works against it; only the `gitWorktreeAdd`
  callable is faked.
- **Inputs:** Task 3 complete (test seam exists).
- **Outputs:** two new tests passing under `npm run test`.
- **Acceptance criteria:** new tests pass without flaking. Coverage of
  `createWorktreeWithRetry`'s catch block no longer depends on the
  parallel-isolation integration test's race timing.

### Task 5: Verify

- **Skill:** `verify`
- **Description:** Run `npm run verify` (typecheck + tests) and confirm
  green.
- **Inputs:** Tasks 1–4 complete.
- **Outputs:** clean verify output.
- **Acceptance criteria:** `npm run typecheck:scripts` exit 0;
  `npm run test` exit 0; no test skipped or pending.

## Skills summary

| Skill | Recommended? | Reason |
|---|---|---|
| `refactoring` | Yes (Tasks 1–3) | Pure structural change, no behaviour delta. |
| `testing` | Yes (Task 4) | New unit test for the retry branch. |
| `verify` | Yes (Task 5) | Pre-commit gate. |
| `new-feature` | No | Not a user-facing feature. |
| `database` / `supabase` | No | No schema or DB layer involved. |
| `svelte` / `tailwind-shadcn` | No | No UI. |
| `pr-review` | No (separate phase) | Runs in `/flow-pipeline` step 8, not part of the implement phase. |

# PR description draft

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
