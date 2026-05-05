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
  runs format + checks, and reports pass/fail. The `--json` flag emits a single bounded
  JSON object — head/tail-capped failure excerpts plus a `firstErrorText` extraction —
  so this skill returns a compact summary to its caller instead of replaying 50–200 KB
  of raw test stack traces.
- If the binary isn't on PATH, fall back to invoking the relevant `npm run` scripts
  directly (e.g., `npm run check`, `npm run lint`, `npm run test`).

# Instructions

## 1. Run the Pre-Commit Checks

```bash
flow-pre-commit --json $ARGUMENTS
```

If `$ARGUMENTS` is empty, the helper auto-detects scope from `git diff HEAD`. The `--json`
flag is required: it bounds each failed check's output to ~200 lines (head 100 + tail 100)
and extracts a `firstErrorText` field so the model summarising results doesn't have to scrape
a wall of raw stderr. If `flow-pre-commit` isn't on PATH, fall back to running the equivalent
npm scripts in sequence and stopping on the first failure — in that fallback path you don't
have the JSON structure, so summarise manually.

For direct human use at a terminal, the human-readable mode without `--json` is still
available (`flow-pre-commit` with no flag) and that path is unchanged.

## 2. Interpret Results

The helper exits 0 if all checks pass, 1 if any fail. Stdout is a single JSON object with
this shape (failed checks only — passing checks omit the `failure` field):

```json
{
  "scopes": ["src", "scripts"],
  "results": [
    {
      "name": "npm run test",
      "scope": "src",
      "passed": false,
      "durationMs": 4321,
      "failure": {
        "firstErrorLine": 42,
        "firstErrorText": "FAIL  src/foo.test.ts > should bar",
        "headExcerpt": "first 100 lines …",
        "tailExcerpt": "last 100 lines …",
        "totalLines": 5000
      }
    }
  ],
  "allPassed": false,
  "changedFiles": ["src/foo.ts"]
}
```

Parse the JSON — `failure.firstErrorText` and `failure.headExcerpt` are the canonical
source of failure context. Do not paste the full raw stderr back into chat; the bounded
excerpt is intentional. If the supervisor needs more than the excerpt for a non-obvious
failure, the user can re-run `flow-pre-commit` (without `--json`) to see the full output
in the terminal — but that detail does not need to flow back through the supervisor's
context.

## 3. Fix Failures

- For each failed check (`results[].passed === false`), use `failure.firstErrorText`
  to locate the failing file/test, then read the relevant source file directly.
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

Return a compact summary to the caller — at most ≈30 lines per failed check. For each
failed check include: a one-line PASS/FAIL header (`FAIL  npm run test (4.3s) — src`),
the `firstErrorText`, and a short head/tail excerpt. When the helper actually truncated
the output (i.e. `tailExcerpt` is non-empty, which means `totalLines > 200` — the
HEAD_LINES + TAIL_LINES budget set in `bin/flow-pre-commit.ts`), include an explicit
`... [N more lines truncated; total M lines] ...` separator between your head and tail
slices. Do **not** re-emit the raw `failure.headExcerpt` and `tailExcerpt` byte-for-byte —
pick the most informative ~10–15 lines from each.

If changes were made to fix failures, briefly list what was fixed (one bullet per fix,
not a diff).

# Verification

- The pre-commit checks command exits 0
- All scopes relevant to the changes are covered
- The summary returned to the caller does not contain raw uncapped stderr from any
  failed check

# Constraints

- NEVER skip a failing check — investigate and fix it.
- NEVER chain checks with `&&` when running manually — the script handles this correctly.
- NEVER modify tests to make them pass unless the test itself is incorrect.
- NEVER paste the full `failure.headExcerpt` + `failure.tailExcerpt` back into chat
  verbatim — pick a representative slice. The cap exists to bound context, not to be a
  ceremonial truncation that still bloats the supervisor.
