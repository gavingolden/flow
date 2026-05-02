# M3 — verify, ci, review (plan)

Read first: `architecture.md`, `task-schema.md`, `phases/m2-plan.md`, and the M3 row of `roadmap.md`.

## Context

After M2, `flow run` takes a `triaged` task to `pr-open`. M3 closes the loop from `pr-open` to `gated`: run the local test suite, watch CI checks, run a review pass, and bounce back into `implement` when either the build or a reviewer flags something critical. The point of M3 isn't just "more phases" — it is the first time `flow` can self-correct. Every M3 design choice is in service of that loop being safe, bounded, and traceable.

## Goal

Add three phases (verify, ci, review), a `mode` parameter on `implement`, and a `flow resume` command. After M3:

```
pr-open ─► verifying ─► verified ─► ci ─► ci-passed ─► reviewing ─► gated  (M4 takes over)
              │                      │                     │
              ▼ (3x in-place)        ▼ red                  ▼ critical
          needs-human          implementing(fix)      implementing(fix)
                                       │                     │
                                       └────► pr-open ◄──────┘
```

Two cross-phase loops (ci→implement, review→implement) and one in-place loop (verify retries). All three are bounded; exhaustion routes to `needs-human`.

## Prerequisites (not part of M3)

- **Phase 3 amendment** lands as **M3 PR 0** (see PR-sequence table below). `runImplementPhase` (mode `"create"`) runs `npm run verify` locally and confirms it exits 0 *before* `gh pr create`. The new invariant for `pr-open` is "PR exists **and** the local test suite passed against the pushed SHA".

## Resolved open questions

These were asked in the triage. The plan resolves each here so implementation tasks don't re-litigate them.

### `/pr-review` "critical" mapping

`/pr-review` (in `skills/pipeline/pr-review/`) emits findings as JSON with `label`, `decoration`, and `confidence` fields. There is **no single "critical" label**. M3 defines critical as:

```
(label == "issue" || label == "todo") && decoration == "blocking" && confidence >= 80
```

Rationale: 80 is the same threshold the skill already uses to filter findings before posting. `blocking` is the skill's existing "must fix before merge" signal, applied today via `event="REQUEST_CHANGES"` when posting reviews. `issue` and `todo` are the two labels the skill uses for actionable problems (vs `praise`, `nitpick`, `suggestion`, `question`). This combination already exists in the skill's output — we are reusing the skill's own bar, not inventing a new one.

### CI poll cadence under load

30s is safe. `gh pr checks --json` issues two REST requests per call (resolve PR + list checks). At 30s cadence, one task burns ~240 req/hour. GitHub's authenticated REST limit is 5000 req/hour. M3 is single-task, so headroom is ~20× — confirmed sufficient. M5 multi-task work will revisit if N > 15 concurrent.

### `flow resume <task-id>` UX

Flag-based, not interactive. The pipeline half of `flow` is scripted; an interactive prompt here would be a regression in composability.

```
flow resume <task-id>            # default: reset all phase_counts, transition status
                                 #   to the entry status of the phase that paused.
flow resume <task-id> --keep-budgets       # don't reset phase_counts (e.g. resume after manual fix
                                           # without re-rolling the budget dice)
flow resume <task-id> --phase <name>       # override the auto-detected re-entry phase
```

Auto-detection reads the new frontmatter field `paused_at_phase` (set when transitioning to `needs-human`); resume maps that phase back to its canonical entry status (e.g. `verify` → `pr-open`, `ci` → `verified`, `review` → `ci-passed`). If `paused_at_phase` is absent (legacy task), `flow resume` errors with a hint to use `--phase`.

### Budget tracking storage

`phase_counts` lives in task frontmatter:

```yaml
phase_counts:
  verify: 0     # cap 6  — phase invocations, not in-place retries
  ci: 0         # cap 6
  implement: 0  # cap 4  — total across create + fix modes
  review: 0     # cap 3  — initial + 2 fix-driven re-runs
paused_at_phase: null  # set to PhaseName when transitioning to needs-human
```

Increment in `writeTask` paths from each phase entry. Inner caps (verify's 3 in-place retries, ci→implement's 3 cycles, review→implement's 2 cycles) are enforced from these counts plus per-cycle accounting in the runner. Inner counters effectively reset per outer cycle because each loop-back invokes `implement`, which re-enters `verify` with a fresh in-cycle attempt count, but the lifetime cap on `phase_counts.verify` is what prevents runaway loops.

### Auto-reviewer wait with empty bot list

`AUTO_REVIEWER_BOTS` configurable list, default `["Copilot"]`. When the list is empty (or no listed bot has been requested as a reviewer on this PR), the wait is a **no-op** — zero wall-clock delay. Phase 5 proceeds straight to terminal-CI determination.

### CI hard timeout

**30 minutes**, not 60. Most TS/JS test suites finish in under 10 min; 30 covers heavy linters + e2e. If a check is still pending at 30 min it is likely stuck. On timeout, escalate to `needs-human` with the last-known check states surfaced in the phase output ("3 checks still `in_progress` at timeout: …").

### Verify phase redundancy after Phase 3 amendment

**Keep verify as a separate phase.** Three reasons:

1. **Belt-and-suspenders for LLM-claims-pass-but-didn't.** `/verify` inside implement runs in the LLM's tool window; nothing prevents the LLM from concluding "tests passed" when they didn't. Phase 4 re-runs the same command from outside the LLM context with deterministic exit-code checking.
2. **Re-fires after fix-mode pushes.** `mode: "fix"` skips local verify (see below). Phase 4 is the first deterministic verification on every loop iteration after the initial pr-open.
3. **Cheap.** Re-running `npm run verify` against an unchanged SHA is fast (most checkers cache); re-running against new commits is exactly when we need it.

`mode: "fix"` deliberately skips its own local-verify gate to keep iteration tight — Phase 4 catches what fix mode introduces. If verify fails in the loop-back path, the loop continues (verify failure → cap → needs-human), which is the correct behaviour.

### Test infrastructure

**Vitest.** Matches `skills/pipeline/testing` conventions (Vitest + Testing Library) and fits Node + tsc + tsx without needing a bundler. Set up in PR 1 with a single smoke test, then every subsequent PR lands its own tests.

### `mode: "fix"` skill choice — push back on `/new-feature`

The triage asked us to investigate whether `/new-feature` could double as a fix-mode skill. The answer is **no**, on three grounds the skill itself documents:

1. **`/new-feature`'s "When NOT to Use" explicitly excludes** "small bug fixes or single-line changes" and "adding tests to existing code".
2. **Its workflow requires upfront `it.todo()` test specs and a blocking user-approval gate** before any code is written. Headless fix mode has no user to approve, and a CI/review failure has no a-priori test list — the failing test already exists.
3. **The mental model is wrong.** Fix mode receives concrete failure context (CI log / review finding) and must produce a minimal targeted patch. `/new-feature`'s critical-analysis phase (customer value, technical complexity, debt risk) is friction in this loop.

**Decision: introduce a `/fix` skill in `skills/pipeline/fix/`** (alongside `pr-review`, `verify`, `new-feature`). It reuses the `testing` skill's framework for any new test scaffolding it needs. Contract:

- **Input arguments:** the task id and a failure-context block (truncated CI log or review findings).
- **Workflow:** read the task file and the failure block → diagnose → make minimal targeted edits → run `/verify` (best-effort) → commit with a fix message → push. **Does not** create a PR (one already exists).
- **No it.todo() approval gate.** The trigger is an existing failure; the skill's job is to make it pass.

The `/fix` skill ships in flow's bundled skills directory. It is **not** part of flow's own source PRs but is a prerequisite for PR 6 (the first ci-loop-back caller). It can land in parallel with PRs 1–5; the M3 plan calls it out explicitly so the user can `flow start` a separate task to author it.

The `/fix` skill is authored via a separate `flow start` task — it lives in `skills/pipeline/fix/` once shipped, is written from scratch (not forked from `/new-feature`, whose `it.todo()` user-approval gate would hang in headless mode), and is a prerequisite for PR 6 only.

## State machine deltas

Add two statuses to `TASK_STATUSES` in `src/state/phases.ts`:

```
"verified"    // exit of phase 4 = entry of phase 5
"ci-passed"   // exit of phase 5 = entry of phase 6
```

Updated transitions:

| Phase | Entry status (and prior mid-flight) | Mid-flight | Exit (ok) | Exit (fail / loop) |
|---|---|---|---|---|
| verify | `pr-open` | `verifying` | `verified` | in-place retry; on cap exhaustion → `needs-human` |
| ci | `verified` | `ci` | `ci-passed` | red → `implementing` (loop-back, mode:"fix"); cap exhaustion → `needs-human`; timeout → `needs-human` |
| review | `ci-passed` | `reviewing` | `gated` | critical → `implementing` (loop-back, mode:"fix"); cap exhaustion → `needs-human` |

`STATUS_TO_LAST_CHECKED` map: only two entries are new — `verified → verify` and `ci-passed → ci`. The other transient/terminal mappings (`verifying → implement`, `ci → verify`, `reviewing → ci`, `gated → review`) already exist in `src/state/phases.ts` from the M2 scaffold and are unchanged.

The runner's `unfinishedStatuses` arrays for the new phases:

```ts
{ name: "verify",  unfinishedStatuses: ["pr-open", "verifying"],   phase: runVerifyPhase  },
{ name: "ci",      unfinishedStatuses: ["verified", "ci"],         phase: runCiPhase      },
{ name: "review",  unfinishedStatuses: ["ci-passed", "reviewing"], phase: runReviewPhase  },
```

`implementing` keeps its existing entry status `worktree-ready` for create-mode plus is now also reachable mid-loop from ci/review; the runner dispatches by current status — re-entering `implementing` from `ci` or `reviewing` simply means the prior phase set status to `implementing` after deciding to loop back.

## Phase 4 — verify

| | |
|---|---|
| **Type** | headless Claude Code subprocess in the *worktree* |
| **Skill invoked** | `/verify` |
| **Entry status** | `pr-open` |
| **Mid-flight** | `verifying` |
| **Exit status (ok)** | `verified` |
| **In-place retry cap** | 3 attempts (via `retryN(fn, 3)`) |
| **Lifetime cap** | `phase_counts.verify ≤ 6` |
| **Tools allowed** | `Read, Bash(npm *), Bash(npx *), Bash(bun *), Bash(node *)` |
| **Timeout** | 10 min per attempt |

On retry, append the prior failure log (truncated to last 200 lines + lines matching `/error|fail|panic/i`, both bounded to 4 KB combined) to the next attempt's prompt — same shape as M2's existing `lastFailure` mechanism in `implement.ts`.

On 3-attempt exhaustion: write the failure log to `## Phase outputs > verify`, set `paused_at_phase: "verify"`, transition to `needs-human` with reason `verify cap 3 exhausted; counts: verify=N ci=N implement=N review=N`. Per the triage's "still open the PR" rule, the PR is already open from phase 3; verify-failure inside the loop just records the failure on the task — it never blocks a PR from existing. (The "open PR with failing verify in Test Steps" rule applies only to the Phase 3 amendment, where the PR has not yet opened.)

When verify passes on attempt > 1, append a flake note to `## Phase outputs > verify`: e.g. `verify: 2/3 passed (1 retry — suspected flake)`.

## Phase 5 — ci

| | |
|---|---|
| **Type** | script (no LLM) |
| **Action** | poll `gh pr checks --json` until terminal; then absorb auto-reviewer wait |
| **Entry status** | `verified` |
| **Mid-flight** | `ci` |
| **Exit status (ok)** | `ci-passed` |
| **Exit status (red)** | `implementing` (loop-back) |
| **Loop-back cap** | `phase_counts.ci ≤ 6` and per-loop `ci→implement ≤ 3` cycles |
| **Poll cadence** | 30s |
| **Hard timeout** | 30 min |

### Polling

```
loop:
  result = gh pr checks <pr> --json --required  # output includes name, status, conclusion
  if every check is terminal (success | failure | cancelled | skipped | neutral):
    break
  if elapsed > 30 min: timeout → needs-human
  sleep 30s
```

Custom poller (not `gh pr checks --watch`) so it survives a `flow run` crash — re-running is idempotent (re-queries current state).

Terminal-state classification:
- **green:** every check is `success` (or `skipped` / `neutral` — those don't fail).
- **red:** at least one is `failure` or `cancelled`.

### Auto-reviewer wait

After CI reaches terminal, before declaring phase 5 done, wait up to `AUTO_REVIEWER_WAIT_MS` (5 min) for any reviewer in `AUTO_REVIEWER_BOTS` (default `["Copilot"]`) to post a review. If the bot list is empty *or* none of the listed bots is requested as a reviewer on the PR, **skip the wait entirely**. Collected bot findings are written to `## Phase outputs > ci` as `### auto-reviewers` and consumed by phase 6.

### Loop-back on red

On red CI:
1. Truncate failing checks' logs (`gh run view <run-id> --log-failed`) using the same 200-line + error-line algorithm as verify; combined budget 8 KB.
2. Append to `## Phase outputs > ci`.
3. Transition status to `implementing`. The runner's next iteration dispatches `runImplementPhase(task, { mode: "fix", failureContext })`.
4. After fix-mode succeeds, status returns to `pr-open`; the pipeline re-enters verify → ci automatically.

### Caps

- `phase_counts.ci` increments on every entry to `runCiPhase`.
- A separate per-cycle counter (in-memory or derived from phase log) caps ci→implement loops at 3.
- Lifetime: `phase_counts.ci > 6` → `needs-human` with reason `ci lifetime cap 6 exhausted`.

## Phase 6 — review

| | |
|---|---|
| **Type** | headless Claude Code subprocess (in worktree) |
| **Skill invoked** | `/pr-review` |
| **Entry status** | `ci-passed` |
| **Mid-flight** | `reviewing` |
| **Exit status (ok)** | `gated` |
| **Exit status (critical)** | `implementing` (loop-back) |
| **Loop-back cap** | `phase_counts.review ≤ 3` and per-loop `review→implement ≤ 2` cycles |
| **Tools allowed** | `Read, Glob, Grep, Bash(gh *), Bash(git *)` |
| **Timeout** | 20 min |

### Posting findings

Per `feedback_pr_review_comment_style` (user memory): findings post as **individual inline comments**, not a formal review (`gh pr review` with `--request-changes`). Each finding becomes a `gh api` POST to `/repos/.../pulls/<pr>/comments`. The `/pr-review` skill already supports this output mode; M3 invokes it with the right flag (or wrapping prompt instruction, mirroring how `implement.ts` injects the Test Steps rule).

### Critical detection

After the skill exits, parse `## Phase outputs > review` for a fenced JSON block listing the run's findings, and count those matching:

```
(label == "issue" || label == "todo") && decoration == "blocking" && confidence >= 80
```

The `/pr-review` skill itself produces a markdown report — not a parseable JSON sidecar. To bridge this gap, the phase 6 wrapping prompt explicitly instructs the skill to also emit a JSON block under `## Phase outputs > review` with shape:

```json
[
  {"file": "path", "line": 42, "label": "issue", "decoration": "blocking", "confidence": 90, "subject": "...", "addressed": false}
]
```

This mirrors how `implement.ts` injects the Test Steps rule via prompt suffix. The contract is owned by `runReviewPhase` (it builds the prompt and parses the result); if the skill's report format ever evolves to natively emit JSON, the wrapping prompt becomes a no-op.

If the JSON block is missing or unparseable, the phase fails with `failed` (not `needs-human`) — the runner's retry budget for review covers a one-attempt re-prompt before escalating.

If count > 0: loop back. Truncate the critical findings (full body, not truncated by line count — they're already short by skill convention) into the implement-fix prompt under a `CRITICAL REVIEW FINDINGS` heading.

### Auto-reviewer findings as second-opinion

If phase 5 collected bot findings, prepend them to the `/pr-review` prompt as context: *"Auto-reviewers also flagged the following — consider their findings while running your own review."* This is the only cross-phase artefact phase 5 hands to phase 6.

## Implement re-entry — the `mode` parameter

Today, `runImplementPhase` short-circuits when `task.frontmatter.pr != null` (`src/pipeline/phases/implement.ts:30`). M3 changes this to a `mode` parameter on the phase function:

```ts
type ImplementMode = "create" | "fix";

interface ImplementOptions {
  mode: ImplementMode;
  failureContext?: string;  // required iff mode === "fix"
}

export async function runImplementPhase(
  task: Task,
  opts: ImplementOptions = { mode: "create" },
): Promise<PhaseResult>
```

Behaviour:

- **`mode: "create"`** (default): existing behaviour. Short-circuits on `task.pr != null`. Runs local `/verify` before `gh pr create` (Phase 3 amendment). Sets status `pr-open`, populates `pr` field.
- **`mode: "fix"`**: requires `task.pr != null` (PR must already exist). **Skips local-verify gate** — phase 4 catches verify regressions. Invokes `/fix` (not `/new-feature`) with the failure context. After successful exit, transitions status to `pr-open` (re-using the same status; the phase log records the fix-iteration). Increments `phase_counts.implement`.

The runner does not call `runImplementPhase` directly with `mode: "fix"` — phase 5 (ci) and phase 6 (review) wrap the call when looping back. The runner's own dispatch always uses `mode: "create"` for status `worktree-ready` or `implementing` reached from `pr-open` for the first time.

`phase_counts.implement` increments on every entry; cap 4 lifetime. Hitting the cap escalates to `needs-human` with the failure context surfaced.

### `pending_implement_mode` frontmatter (introduced by PR 5)

A crash mid-loop-back creates a status-only ambiguity: the task is in
`implementing` and a PR exists, but was the runner heading into create
(legacy crash recovery from PR 0) or fix (loop-back from ci/review)?
Phase log parsing is fragile. PR 5 introduces a dedicated frontmatter
field:

```yaml
pending_implement_mode: "fix" | null
```

- **Set by** ci (phase 5) or review (phase 6) when transitioning the task
  to `implementing` for a loop-back. Value `"fix"`.
- **Read by** the runner. Dispatches `runImplementPhase(task, { mode:
  "fix", failureContext })` when the field is `"fix"`; otherwise
  defaults to `mode: "create"` (the PR 0 crash-recovery path runs the
  gate and either skips `gh pr create` or surfaces the failure on the
  existing PR).
- **Cleared** after a successful re-entry (set back to `null`).

PR 0 does **not** add this field — it only documents the decision so
PR 5 implements it consistently. PR 0's crash recovery (status
`implementing` + `pr != null`) leans on `mode: "create"` semantics: the
gate runs, `detectOpenedPr` finds the existing PR and skips
`gh pr create`.

## Retry helper — `retryN`

Replace `src/pipeline/retry.ts`:

```ts
export type AttemptResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export async function retryN<T>(
  fn: (attempt: number, lastFailure?: string) => Promise<AttemptResult<T>>,
  n: number,
): Promise<AttemptResult<T>> {
  let last: AttemptResult<T> | undefined;
  for (let i = 1; i <= n; i++) {
    const r = await fn(i, last && !last.ok ? last.error : undefined);
    if (r.ok) return r;
    last = r;
  }
  return last!;
}
```

Migrate `runImplementPhase` (currently `retryOnce(...)`) to `retryN(..., 2)`. No behaviour change.

## Hardcoded knobs (M3 — defer config to M5+)

Single file `src/pipeline/budgets.ts`:

```ts
export const VERIFY_INNER_RETRY_CAP = 3;
export const VERIFY_LIFETIME_CAP = 6;

export const CI_POLL_INTERVAL_MS = 30 * 1000;
export const CI_HARD_TIMEOUT_MS = 30 * 60 * 1000;
export const CI_LIFETIME_CAP = 6;
export const CI_LOOPBACK_CAP = 3;          // ci→implement cycles per task

export const REVIEW_LIFETIME_CAP = 3;
export const REVIEW_LOOPBACK_CAP = 2;      // review→implement cycles per task

export const IMPLEMENT_LIFETIME_CAP = 4;

export const AUTO_REVIEWER_BOTS = ["Copilot"] as const;
export const AUTO_REVIEWER_WAIT_MS = 5 * 60 * 1000;
```

Centralising these in one file makes the M5 swap to `.orchestrator/config.toml` mechanical.

**Caveat — what binds when both loops fire.** `IMPLEMENT_LIFETIME_CAP = 4` is the binding constraint when both ci and review loops fire on the same task: `CI_LOOPBACK_CAP + REVIEW_LOOPBACK_CAP = 5` is unreachable because each loop-back consumes one implement attempt, and implement caps at 4. The per-loop caps therefore only bind when one of the two loops fires alone.

## New / changed source files

```
src/
├── cli.ts                                  # extend: register `resume` command
├── commands/
│   └── resume.ts                           # new
├── pipeline/
│   ├── runner.ts                           # extend M2_PIPELINE → M3_PIPELINE with verify/ci/review
│   ├── retry.ts                            # retryOnce → retryN
│   ├── budgets.ts                          # new — all hardcoded caps
│   ├── log-truncate.ts                     # new — shared 200-line + error-line truncator
│   └── phases/
│       ├── implement.ts                    # extend: mode parameter, fix-mode prompt builder
│       ├── verify.ts                       # new
│       ├── ci.ts                           # new — gh pr checks poller + auto-reviewer wait
│       └── review.ts                       # new — /pr-review wrapper + critical-finding parser
├── state/
│   ├── phases.ts                           # add "verified", "ci-passed" to TASK_STATUSES + map
│   └── task-file.ts                        # extend frontmatter: phase_counts, paused_at_phase;
│                                           # bump-on-write; soft-default for legacy tasks
└── tests/
    ├── retry.test.ts                       # PR 1
    ├── runner.test.ts                      # PR 8 (M2 catch-up)
    ├── task-file.test.ts                   # PR 8 (M2 catch-up — Progress regen)
    └── phases/
        ├── verify.test.ts                  # PR 4
        ├── ci.test.ts                      # PR 6
        └── review.test.ts                  # PR 7

skills/pipeline/
└── fix/                                    # NEW skill, lands separately (prereq for PR 6)
    ├── SKILL.md
    └── references/...

docs/
├── task-schema.md                          # extend: document `phase_counts` +
│                                           # `paused_at_phase` frontmatter;
│                                           # add `verified` and `ci-passed`
│                                           # to the status state machine
│                                           # (lands in PR 2)
└── roadmap.md                              # M3 row + done-criteria sync
                                            # (CI hard timeout 30 min, not 60;
                                            # any other deltas vs the plan)
                                            # (touch up alongside PR 6)
```

## PR sequence

Nine PRs, each non-breaking with respect to the M2 happy path. PR 0 is the Phase 3 amendment (pre-PR verify gate); PRs 1–3 are pure scaffolding; PRs 4, 6, 7 each extend the pipeline by one phase and shift the M3 terminal status forward; PR 5 introduces fix-mode infrastructure ahead of its first caller; PR 8 is the M2 test catch-up.

| # | Title | Pipeline terminal after merge | Skill |
|---|---|---|---|
| 0 | Phase 3 amendment: pre-PR verify gate in implement | unchanged (`pr-open`) | `refactoring` |
| 1 | Vitest setup + `retryN` helper | unchanged (`pr-open`) | `refactoring` (and `testing` for tests) |
| 2 | `phase_counts` + `paused_at_phase` frontmatter | unchanged (`pr-open`) | `refactoring` |
| 3 | `flow resume <task-id>` command | unchanged (`pr-open`) | `new-feature` |
| 4 | Phase 4 (verify) | `verified` | `new-feature` |
| 5 | `runImplementPhase` `mode: "fix"` infra (no caller) | unchanged (`verified`) | `new-feature` |
| 6 | Phase 5 (ci) + auto-reviewer wait + ci-loop-back | `ci-passed` | `new-feature` |
| 7 | Phase 6 (review) + critical-loop-back | `gated` (M4 takes over) | `new-feature` |
| 8 | M2 catch-up tests (`runner.ts`, `task-file.ts` Progress regen) | unchanged | `testing` |

Out-of-band, in parallel: **`/fix` skill in `skills/pipeline/fix/`.** Must exist before PR 6 lands. Authored via a separate `flow start` task; not part of flow's source PR sequence.

### Why this ordering

- **PR 0 lands first because every later PR depends on the strengthened `pr-open` invariant.** Phase 4 (PR 4) is mostly redundant on the happy path without it — every verify run would inherit a tree the LLM just claimed was green, with no deterministic re-check between the claim and the PR. PR 0 closes that gap before any of the new phases land. Standalone (not folded into PR 1) so "behaviour change in implement.ts" and "test framework setup" stay as separate diffs.
- **PR 1 lands test infra alongside the first thing worth testing.** A standalone "set up vitest" PR is reviewable but small enough to bundle with `retryN`. They share fate — `retryN`'s correctness is the smoke test for vitest.
- **PRs 2–3 are pure plumbing.** `phase_counts` is added before any phase reads it (PR 2). `flow resume` lands before any phase can route to `needs-human` (PR 3) — so the user has the recovery tool before they need it.
- **PR 4 (verify) lands before PR 5 (fix mode)** because verify is callable in the M2 happy path with no fix-mode dependency. Pipeline terminates at `verified` after this PR — that is the new "M2 happy path" until PR 6.
- **PR 5 (fix mode) is no-op-by-default.** Adding `mode` parameter with a default of `"create"` means existing call sites are unaffected. PR 5's only test is a hand-written fixture exercising the new branch.
- **PR 6 (ci) is the first PR that wires fix-mode end-to-end.** This is also the first PR that requires the `/fix` skill to be present.
- **PR 7 (review) closes the loop.** After this, M3 happy path is `pr-open → … → gated`.
- **PR 8 (M2 catch-up) lands last** because it has no dependencies on the new phases — it just tests existing M2 code that didn't get tests when shipped. Putting it last avoids merge conflicts with earlier PRs that touch `runner.ts` and `task-file.ts`.

## Acceptance criteria

After all 8 PRs merge:

- A `flow run <id>` on a `triaged` task whose code change passes verify and CI cleanly with no critical review findings reaches status `gated` with no human intervention. M4 takes over from there.
- A `flow run <id>` with a deliberately broken local test that does **not** also break CI (rare but possible — a flaky local check) escalates to `needs-human` after the 3-attempt in-place retry cap exhausts (`phase_counts.verify == 1`, in-cycle attempts == 3) with the final failure log surfaced. The lifetime cap of 6 only binds when verify is re-entered across multiple outer loop-back cycles (CI/review fix-mode pushes re-firing verify).
- A `flow run <id>` with a CI-only failure that the `/fix` skill cannot resolve escalates to `needs-human` after 3 ci→implement cycles, with the failing CI logs surfaced and `phase_counts.implement` showing the loop count.
- A `flow run <id>` whose review yields critical findings the `/fix` skill cannot resolve escalates to `needs-human` after 2 review→implement cycles.
- `flow resume <id>` on a `needs-human` task transitions status back to the auto-detected phase's entry status, resets `phase_counts`, and clears `paused_at_phase`. A subsequent `flow run <id>` resumes cleanly.
- Task frontmatter on every terminal-or-paused state contains accurate `phase_counts`. The phase log's needs-human reason includes per-phase counts.
- Auto-reviewer wait with empty `AUTO_REVIEWER_BOTS` adds no measurable delay (< 1s). With Copilot configured but not requested as reviewer on this PR, also no delay.

## Verification methodology

End-to-end manual run against econ-data, plus unit tests landing per PR.

```sh
cd /Users/gavingolden/code/me/econ-data

# Happy path
flow start "add a small read-only badge to the dashboard footer"
flow run <id>
# Expect: status reaches `gated` autonomously. Verify on disk + GitHub.

# Verify-failure path: deliberately break a test in the worktree mid-run
# (race the implement phase; or hand-edit a test in the worktree before
# `flow run` re-enters verify).
flow run <id>
# Expect: needs-human after 3 verify retries. Log surfaces failing test.
flow resume <id>
# Expect: paused_at_phase cleared, phase_counts reset.

# CI-failure path: configure a target repo with a CI check that always fails.
flow run <id>
# Expect: ci→implement loop runs 3 cycles, then needs-human.

# Review-failure path: target repo PR with a forced critical issue
# (e.g. obvious null deref) that the /fix skill should partially address.
flow run <id>
# Expect: review→implement runs up to 2 cycles, then either gated or needs-human.
```

Unit-test surface (the catch-up promise):

- `retryN`: 1-attempt success, 2-attempt success, 3-attempt failure, error-passing between attempts.
- `runner.ts`: dispatch given each `TaskStatus`; mid-flight resume from `verifying` / `ci` / `reviewing`; refusal to advance when phase returns non-ok.
- `task-file.ts`: `## Progress` regeneration for each status; `phase_counts` increment on `writeTask`; `updated` timestamp set; legacy task without `phase_counts` round-trips with default zeros.
- Phase-specific: `verify` retry budget; `ci` poll loop with mocked `gh` outputs (mocking `execa`); `review` JSON parsing + critical-finding detection.

## Scope guardrails (don't do these in M3)

- No `.orchestrator/config.toml`. All knobs hardcoded.
- No bot-identity / separate `gh` auth.
- No LLM-driven CI-log summarisation. Truncation only.
- No cross-task budget sharing.
- No gate / merge phase. M4.
- No multi-task queue, `--all`, `--max`. M5.
- No rebase / `auto_rebase` policy. Default `false` implicitly; revisit only if it bites in real runs.
- No automated remediation of detected flakes. Just visibility (the `verify: 2/3 passed` annotation).
- No retry-with-LLM-context. Every retry re-invokes `claude -p` with the failure log appended; no conversation carries between attempts (architecture invariant).
