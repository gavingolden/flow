> [!WARNING]
> **Historical document.** This describes the deleted Node-orchestrator era of flow and is kept as a historical artefact. For the current state, see the [README](../../README.md) and [AGENTS.md](../../AGENTS.md).

# Phase 4 — verify

The first M3 phase. Spawns a headless Claude session **inside the
worktree** to invoke `/flow-verify`, lets the skill self-heal failures
in place, then runs `.flow/verify` itself as the deterministic
ground-truth post-check. Up to three attempts before escalating to
`needs-human`.

**Status: shipped (PR 5).**

## Inputs

- A task file with `status: pr-open` (or `verifying` on resume),
  `worktree` (absolute path), `branch` (string), and `pr` (integer)
  populated.
- An executable `.flow/verify` script in the worktree. The contract is
  intentionally minimal: a single executable file at a known path that
  runs the project's pre-PR validation suite.

## Outputs

- `## Phase outputs > verify` populated with the attempt count line:
  - `verify: 1/3 passed` — clean first attempt.
  - `verify: 2/3 passed (1 retry — suspected flake)` — recovered after
    one retry.
  - `verify: 3/3 passed (2 retries — suspected flake)` — recovered
    after two retries.
  - `verify: 3/3 attempts failed` followed by a fenced failure block —
    on exhaustion.
- On exhaustion, the same failure log is upserted into the PR body's
  `## Test Steps` section as a `> [!CAUTION]` block via
  `surfaceVerifyFailureOnPr` (idempotent — a prior caution block is
  replaced, not stacked).

Status transitions:

- `pr-open → verifying → ci` (success path).
- `pr-open → verifying → needs-human` with reason
  `verify-exhausted` (after three failed attempts).
- `pr-open → needs-human` with reason `verify-script-missing` (preflight
  fail — no LLM invocation).
- `pr-open → needs-human` with reason `pr-missing` (preflight fail —
  defensive, should never fire on the happy path).

## Wrapping prompt

`/flow-verify` runs against the worktree without any flow-specific context;
the orchestrator wraps the slash-command invocation with a
non-interactive preamble, the task path, the worktree, the branch, the
PR number, and (on attempts 2/3) a `PRIOR ATTEMPT FAILED — failure
log:` block carrying the previous attempt's truncated log. The wrapping
prompt instructs the skill **not** to open or edit the PR — verification
is read-only with respect to GitHub state.

## The retry loop

The phase wraps a verify-attempt callback in `retryN(fn, 3)`. Each
attempt:

1. Build the wrapping prompt (with prior-failure block on retries).
2. `runHeadless` the `/flow-verify` skill in the worktree (30-min timeout).
3. If the headless run exits non-zero, count the attempt as failed.
4. Otherwise, run `runVerifyGate(worktree)` as ground truth. Gate-fail
   counts as a failed attempt — even if the skill self-reported
   success. Disagreement = retry.

The skill itself loops "run checks → fix → re-run" internally; the
orchestrator's three-attempt cap is a meta-loop that fires only when
the skill exits without success (its own internal cap, or a
self-declared success that the gate disagreed with). Worst-case bound:
3 attempts × 30-min timeout = 90 min before exhaustion.

### Failure-log truncation

`truncateForRetryPrompt(log)` is a pure function (no I/O) reused by
both the next-attempt prompt and the on-exhaustion phase-output write.
For a log ≤ 200 lines it passes through; otherwise it returns:

```
[matched <n> error/fail/panic line(s) from earlier in the log; showing first 100]
<up to 100 matched lines>
[…tail…]
<last 200 lines>
```

The match cap (100) prevents a pathological all-error log from
re-flooding the prompt on retry.

## Allowed tools / timeout

```
Read, Write, Edit, MultiEdit, Glob, Grep,
Bash(npm *), Bash(git *), Bash(npx *), Bash(bun *), Bash(node *)
```

Intentionally narrower than implement's tool list — verify never opens
or edits PRs, so `Bash(gh *)` is omitted.

Timeout: 30 minutes per attempt (matches implement's
`HEADLESS_TIMEOUT_MS`). Each attempt is a full self-healing pass, not
a single check run, so the budget needs to accommodate the skill's own
fix loops.

## Failure modes

- **`verify-script-missing` (preflight).** `<worktree>/.flow/verify`
  is missing, not a regular file, or not executable. The phase exits
  to `needs-human` _before_ invoking the LLM, converting a 30-90 min
  exhaustion into a sub-second failure with a precise reason.
- **`pr-missing` (preflight).** `task.frontmatter.pr` is null. This
  shouldn't happen on the happy path because implement opens the PR
  before transitioning to `pr-open`, but it catches resume-from-bad-state
  and direct `flow run --phase verify` invocations.
- **`verify-exhausted`.** Three full attempts failed. The final failure
  log is surfaced on both the task file and the PR body's
  `## Test Steps` section (via `surfaceVerifyFailureOnPr`).
- **Headless invocation failure.** A non-zero exit from `claude -p`
  counts as a failed attempt — same retry treatment as a gate failure.

## Idempotency / resume

- Re-entering with `status: pr-open` runs the phase normally.
- Re-entering with `status: verifying` (a crash mid-flight) starts a
  fresh attempt loop. Re-running attempts is safe: each is independent
  and each writes the same target subsection on the task file (upsert,
  not append).
- Re-entering with `status: ci` short-circuits at the runner level —
  verify is no longer in the runner's `unfinishedStatuses` set for
  `ci`, so the next phase (ci-wait) picks up.

## Implementation

| File                                 | Role                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `src/pipeline/phases/verify.ts`      | Phase entry, wrapping prompt, retry loop, status transitions              |
| `src/pipeline/phases/verify-gate.ts` | `runVerifyGate` (`.flow/verify` shell-out) and `surfaceVerifyFailureOnPr` |
| `src/pipeline/retry.ts`              | `retryN(fn, n)` — generic bounded-retry primitive                         |
| `src/pipeline/headless.ts`           | Generic `claude -p` wrapper                                               |
