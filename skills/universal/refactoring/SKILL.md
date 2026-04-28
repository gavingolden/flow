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
- Database schema changes (defer to `supabase`)

# Context

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

Apply standard refactoring techniques as applicable: guard clauses to flatten nesting, function
extraction to reduce length, descriptive renaming, and dead code removal.

Follow `AGENTS.md` comment standards. Do NOT remove existing comments/TODOs unless the related
code has been removed.

## 4. Verify

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
