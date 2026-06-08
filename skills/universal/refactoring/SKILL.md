---
name: refactoring
description: >-
  Improve code quality through cleanup, simplification, and restructuring without
  changing behavior. Use when user says "refactor", "clean up", "simplify",
  "reduce complexity", "extract function", "remove dead code", or "improve readability".
---

# Goal

Elevate code quality by improving readability, modularity, and maintainability without altering
existing business logic or external behavior.

# When to Use

- User explicitly asks for a refactor, cleanup, or restructure
- A function exceeds ~30 lines or has cyclomatic complexity > 5
- Code has deep nesting (> 3 levels) that can be flattened
- Dead code, unused imports, or stale comments need removal
- Performance optimization of existing logic (not new features)

# When NOT to Use

- Introducing new features as a side-effect of a refactor (feature work should be a separate step)
- Styling or CSS changes (defer to `tailwind-shadcn`)
- Writing new tests from scratch (defer to `testing`)
- Database schema changes (defer to `supabase-project`)

# Context

- Source tree: adapt paths to this project's layout (e.g., `src/`, `src/lib/`, `backend/`)
- Coding standards: `AGENTS.md` — all refactored code must comply (comment rules, logging,
  function length, naming, one-liner avoidance, etc.)
- After refactoring, the `testing` skill should be invoked if tests need updating

# Instructions

## 1. Analyze the Target

- Identify functions exceeding ~30 lines, deep nesting, or high cyclomatic complexity.
- Identify duplicated logic that can be extracted.
- Check for violations of `AGENTS.md` coding standards.
- Note files exceeding 300 lines that could be split (per `AGENTS.md`).

## 2. Plan the Refactor

- Present a brief summary of proposed changes before executing.
- Ensure each change is atomic and independently verifiable.
- **CRITICAL:** Confirm no behavior changes are introduced — only structural improvements.

## 3. Apply Transformations

Decide whether to delegate edits to `/coder` based on the **hybrid threshold**:

- **Trivially scoped refactors** (≤1 file AND ≤30 LOC AND every file named in
  the prompt) skip `/coder` and edit inline. Log a one-line reason in chat
  ("trivial scope: single file ≤30 LOC — editing inline") so the user can
  audit the decision in scrollback.
- **Wider scopes** delegate the per-edit `Edit`/`Write` work to `/coder`
  via the Spawn procedure below. Log a one-line reason ("wider scope:
  spawning /coder") so the user can audit.

**Tiebreaker for soft-edge phrasing.** If the description names one file
but contains fan-out language ("and all callers", "every caller of X",
"and downstream consumers", "and update its tests") or introduces a _new_
sibling module / component, route SPAWN regardless of the leading
single-file phrasing. Renames, extractions, and signature changes that
touch all call sites are the canonical case the threshold's wider-scope
path exists for; routing SKIP on a description like "Rename `foo()` to
`bar()` and update all callers" defeats that. Log the tiebreaker reason
("wider scope: fan-out language past leading single-file phrasing —
spawning /coder") so the user can audit.

### Inline edit (trivial path)

Apply standard refactoring techniques as applicable: guard clauses to flatten nesting, function
extraction to reduce length, descriptive renaming, and dead code removal.

Follow `AGENTS.md` comment standards. Do NOT remove existing comments/TODOs unless the related
code has been removed.

### Spawn procedure (wider-scope path only)

1. Compose the **edit-set** from the Step 2 plan and the affected modules.
   Each entry is a JSON-shaped object with three fields:
   - `file` — repo-relative path of the file to edit.
   - `intent` — 1–2 lines naming what the refactor is meant to achieve
     (e.g. "extract validation logic into pure function", "flatten nested
     conditional via guard clauses").
   - `expected_outcome` — 1–2 lines naming the observable post-edit state
     (what test should pass, what structural improvement should hold —
     remembering that behaviour must not change).

   Render the edit-set as a single JSON array — pass it to `/coder` as
   the `EDIT_SET` argument.

2. Invoke `/coder` in-process via the Skill tool, passing the edit-set
   plus the worktree path:

   ```
   /coder
   EDIT_SET: [{...}, {...}]
   WORKTREE: <absolute path>
   ```

   `/coder` is itself a thin wrapper that spawns one **Independent
   Edit-Applier Subagent** via the Task tool (exemption #6 — see
   `skills/pipeline/flow-pipeline/SKILL.md` "Hard rules"). The subagent
   applies every edit in its own isolated context, runs `flow-pre-commit
--json` against the post-edit worktree, and writes the structured
   artifact at `<worktree>/.flow-tmp/coder-result.json`.

3. After `/coder` returns, do a cheap existence check on the artifact:

   ```bash
   test -s "$WORKTREE/.flow-tmp/coder-result.json" \
     || { echo "NEEDS HUMAN: coder-failed" >&2; exit 1; }
   ```

   On missing or empty artifact, surface the failure to the caller —
   the supervisor escalates `NEEDS HUMAN: coder-failed` rather than
   retrying past the 1-retry cap.

4. Read the artifact body once and parse into a typed object. Reuse the
   parsed object across Step 4 (verification, when it needs the
   `verify_status` field) so the artifact is read exactly once. Do not
   re-read.

   The artifact's `verify_status` is the literal `"pass"` or a
   head/tail-capped failure excerpt. On non-pass, surface the failure
   to the caller — `/refactoring` does not retry inside its own
   wrapper; the parent supervisor decides escalation vs re-invoke.

## 4. Verify

**If the wider-scope path was taken in Step 3**, consume the
`verify_status` field from the `coder-result.json` artifact already
parsed at the end of Step 3 rather than re-running checks inline. The
subagent has already run `flow-pre-commit --json` against the post-edit
worktree, so a duplicate inline run only burns context. If
`verify_status === "pass"`, the refactor's verification is complete.
If `verify_status` is a non-`"pass"` failure excerpt, surface it to the
caller per the failure handling below.

**If the trivial path was taken in Step 3**, run the inline verification:

1. Locate the associated test file (e.g., `<file>.test.ts`).
2. Run `npm run test -- <test-file>` to confirm functional equivalence.
3. Run `npm run check` and `npm run lint` to verify no TypeScript errors were introduced.
4. If tests don't exist for the refactored code, note this to the user.

### When Verification Fails

- **Tests fail:** The refactor likely changed behavior. Diff the refactored function against the
  original and identify where logic diverged. Fix the refactor — do not fix the test to match
  new behavior.
- **Type errors from `npm run check`:** Resolve all errors before proceeding. Common causes
  include changed return types and narrowing changes after guard clause introduction.
- **Lint errors:** Run `npm run format` first, then address remaining issues.

# Anti-Patterns

## Behavior Changes During Refactor

A refactor must not change what the code does — only how it's structured. If you discover a bug
during refactoring, note it to the user as a separate follow-up item instead of fixing it inline.

## Over-Abstracting

Don't extract a helper function that's only called once and is only 2-3 lines. Extraction should
reduce complexity, not add indirection. A good heuristic: extract when the logic is reused OR
when the extraction makes the parent function significantly more readable.

## Losing Context

When moving code into a new function, preserve the intent through the function name and a brief
JSDoc comment. The reader should understand the "why" without reading the implementation.

# Verification

- All existing tests pass after refactoring.
- `npm run check` and `npm run lint` pass with no new errors.
- No dead or unused code remains.
- Refactored code complies with `AGENTS.md` standards.

# Constraints

- NEVER introduce new features during a refactor.
- NEVER change external behavior — inputs, outputs, and side effects must remain identical.
- All tests must pass before completing the task.
- NEVER do per-edit `Edit`/`Write` work in the wrapper's context on
  the wider-scope Step 3 path. The `/coder` subagent owns those edits;
  inlining them defeats the migration's whole point.
