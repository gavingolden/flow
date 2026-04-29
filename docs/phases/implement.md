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
| `src/pipeline/phases/verify-gate.ts` | `runVerifyGate` (`.flow/verify` shell-out) and `surfaceVerifyFailureOnPr` |
| `src/pipeline/headless.ts` | Generic `claude -p` wrapper |
| `src/pipeline/retry.ts` | `retryOnce` |

## Amendment: pre-PR verify gate (M3 PR 0)

The M2 design let `/new-feature` commit, push, *and* open the PR — meaning a
PR could land on GitHub before any deterministic check ran against the
pushed SHA. M3 PR 0 splits responsibilities so the orchestrator can gate
`gh pr create` on a fresh `.flow/verify` subprocess.

### Responsibility split

- **`/new-feature` (the skill)** implements the feature, writes tests,
  commits, pushes the branch, and writes the final PR body to a file the
  orchestrator supplies. It **does not** call `gh pr create`. The wrapping
  prompt enforces this; the body file path is interpolated into the
  prompt as an absolute path.
- **`runImplementPhase` (the orchestrator)** runs `runVerifyGate` after
  the skill exits. On gate-pass it reads the body file and runs
  `gh pr create --body-file <path>` itself, then records the PR number
  and transitions to `pr-open`.

### Body file path

`<target_repo>/.orchestrator/tasks/<id>-implement/pr-body.md`. The
parent directory is created by the orchestrator before invoking the LLM
(parallel to the existing `<id>-plan/` convention). The directory is
covered by the existing `.orchestrator/` gitignore.

If the body file is missing after the LLM exits (it ignored the
instruction or crashed before writing), the orchestrator falls back to
`<plan-dir>/pr-description-draft.md` and surfaces a `WARN:` line in
`## Phase outputs > implement`. The plan phase guarantees the draft
exists, so the fallback is always available.

### The verify gate

`runVerifyGate(cwd)` lives in `verify-gate.ts` and resolves
`<cwd>/.flow/verify` (literal — no walk-up), checks it's executable
via `fs.access(p, fs.constants.X_OK)`, then spawns it directly via
`execa(scriptPath, [], { cwd, reject: false, all: true, timeout: 10 *
60 * 1000 })`. The contract surface is intentionally minimal: a
single executable file at a known path. No config-file format, no
language probes, no auto-discovery — any repo can satisfy the
contract with a one-line shell wrapper around its own validation
suite.

A missing-or-non-executable script fails the gate with a single
target-repo-generic diagnostic:

> `.flow/verify is missing or not executable in <cwd>; create an
> executable script that runs this repository's required pre-PR
> validation checks`

Both stat-fails (ENOENT) and access-fails (EACCES, missing X_OK bit)
collapse to the same diagnostic — leaking permission-bit minutiae
into the gate's failure surface buys nothing. The `execa` call is
wrapped in try/catch — execa 9.x throws on timeout and on spawn
failure (e.g. a bad shebang interpreter), and the orchestrator
depends on a deterministic `{ ok, output }` return rather than an
exception.

Why `.flow/verify` and not `claude -p "/verify"`: cheaper, fully
deterministic, no LLM context to muddy. Phase 4 (M3 PR 4) will run
the skill route — the divergence is intentional. PR 0's gate is the
deterministic gate at PR-open time; phase 4 is the fresh-LLM-window
re-check after fix-mode pushes.

### Failure modes

The orchestrator detects whether a PR already exists for the branch
*before* invoking the LLM, then chooses between a one-shot attempt and
a retry-once cycle:

- **No PR yet (the M2 happy path).** A single `attempt` (LLM run + gate)
  is wrapped in `retryOnce`. If the LLM run succeeds but the gate fails,
  the failure log is appended to `## Phase outputs > implement` under a
  `### verify-gate failure` subsection and the callback returns a
  retry-able error. `retryOnce` re-invokes `/new-feature` with the
  failure context. If the second attempt's gate also fails, the phase
  returns `failed` with no PR created.
- **PR already exists at phase entry (crash recovery).** The orchestrator
  runs `attempt` exactly once — no `retryOnce` wrapper. Re-invoking the
  LLM on a branch with an open PR would mutate the PR a second time,
  which is exactly what crash recovery should *not* do. On gate failure
  the failure is surfaced on the PR's `## Manual validation` section as
  a `> [!CAUTION]` block via `surfaceVerifyFailureOnPr`. Idempotent: a
  prior caution block from a previous gate failure is replaced, not
  stacked. Phase returns `failed` — a PR with red local verify is in a
  needs-human state.
- **`/new-feature` itself fails.** Existing M2 retry behaviour applies
  on the no-PR path; the gate doesn't run. On the PR-already-exists
  path, the LLM failure is reported once with no retry.

### Idempotency / resume — strengthened

The top-of-phase short-circuit narrows: it now requires *both*
`pr != null` *and* `status === "pr-open"`. A task with `pr != null` but
`status: implementing` is crash recovery — the phase falls through,
detects the existing PR, runs the LLM+gate exactly once (no retry), and
either skips `gh pr create` (idempotent — `detectOpenedPr` finds the
existing PR) on gate-pass or surfaces the failure on the PR on
gate-fail. Legacy `pr-open` tasks created before PR 0 short-circuit
unchanged; we do not retroactively gate them.

### Strengthened `pr-open` invariant

Before PR 0: `pr-open` meant "PR exists." After PR 0: `pr-open` means
"PR exists **and** the local verify suite exited 0 against the pushed
SHA." Phase 4 (M3 PR 4), when it lands, gains real signal because every
`pr-open` it sees has already been gated.
