---
name: verify
description: >-
  Run pre-commit verification checks, fix failures, and re-run until clean. Use
  when user says "verify", "run checks", "check my changes", "pre-commit", or
  before committing changes.
argument-hint: "[--scope frontend,backend,scripts] [--pr <number>]"
---

# Goal

Run all relevant pre-commit checks, fix any failures, and re-run until every check passes.

# When to Use

- Before committing changes
- User asks to "verify", "run checks", "check my changes"
- After completing a refactor, feature, or bug fix
- As a sub-step of other skills (e.g., pr-review Step 6)

# When NOT to Use

- When the user wants to run a single specific check (e.g., just `npm run test`)
- When the user is only running `npm run format` without checks

# Context

- `flow-pre-commit` (installed globally by `flow setup` and on PATH) auto-detects scope,
  runs format + checks, and reports pass/fail.
- If the binary isn't on PATH, fall back to invoking the relevant `npm run` scripts
  directly (e.g., `npm run check`, `npm run lint`, `npm run test`).

# Instructions

## 1. Run the Pre-Commit Checks

```bash
flow-pre-commit $ARGUMENTS
```

If `$ARGUMENTS` is empty, the helper auto-detects scope from `git diff HEAD`. If
`flow-pre-commit` isn't available, run the equivalent npm scripts in sequence and stop on
the first failure.

## 2. Interpret Results

- The helper exits 0 if all checks pass, 1 if any fail.
- Failed checks include their output inline — read it to identify the failing file/test.

## 3. Fix Failures

- For each failed check, identify the root cause from the output.
- Fix the issue in the source file.
- **Type errors** (`npm run check`): Resolve type mismatches, missing imports, or incorrect generics.
- **Lint errors** (`npm run lint`): Run `npm run format` first, then fix remaining issues manually.
- **Test failures** (`npm run test`): Read the failing test, understand the assertion, fix the code
  (not the test) unless the test itself is wrong.
- **Go errors** (`go vet`, `go test`): Fix in the relevant `backend/` file.

## 4. Re-Run Until Clean

- After fixing, re-run the same checks with the same arguments.
- Repeat until all checks pass.
- Do not give up after one round — some fixes reveal new errors.

## 5. Report

- Confirm all checks pass.
- If changes were made to fix failures, briefly list what was fixed.

# Verification

- The pre-commit checks command exits 0
- All scopes relevant to the changes are covered

# Constraints

- NEVER skip a failing check — investigate and fix it.
- NEVER chain checks with `&&` when running manually — the script handles this correctly.
- NEVER modify tests to make them pass unless the test itself is incorrect.
