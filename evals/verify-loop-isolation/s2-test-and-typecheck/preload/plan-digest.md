# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question (the two load-bearing externals, `claude plugin eval`'s status and the headless `claude -p` result envelope, were verified directly against the installed CLI 2.1.238 during discovery); force with `flow feature create --research`.

# flow-eval: a flow-owned, locally-runnable eval harness for supervisor-scaffold removals

**Goal:** A maintainer runs one command and gets a recorded, comparable score for each of the three 200k-era scaffolds, so f2's removals carry a before/after number.

## Problem Statement

flow's supervisor carries three context-isolation scaffolds sized for 200k-token windows — the step-6 verify-retry-loop subagent (`skills/pipeline/flow-pipeline/SKILL.md` "Step 6 — Local verify"), the haiku-pinned gatekeeper (`skills/pipeline/flow-pr-review/SKILL.md` Step 1.5, `agents/core/flow-gatekeeper.md`), and the step-4 auto-checkpoint → `/clear` → resume hand-off (`checkpoint-pending-clear`, `bin/flow-checkpoint.ts` + `bin/flow-session-start-hook.ts`). The epic wants each one removed or kept on evidence, but today there is no way to produce that evidence: the only existing measurement tooling is `flow-model-bench` (scores *model routing* over agy-delegated surfaces, not supervisor behavior) and `flow-transcript-audit` (a one-off token attribution over a finished pipeline's session JSONL). A removal argued in prose cannot be falsified, and — per the epic's own plan risk — an eval whose scenarios are too small green-lights removals it cannot falsify.

The obvious platform answer, `claude plugin eval`, exists on the installed CLI (2.1.238 lists it with `--json`, `--runs`, `--threshold`) but is org-gated early access (design.md verdict 4, re-verified 2026-08-19), and `.github/workflows/ci.yml` installs Node and Bun only — no `claude` binary — so no claude-driven eval can be a CI gate today regardless of enablement.

## Epic context

Part of epic `modernize-flow-s-supervisor-architecture` (feature `f1-eval-harness`) — design at `.flow/epics/modernize-flow-s-supervisor-architecture/design.md`.

- **Role:** the walking-skeleton root and MVP (`manifest.json` `mvp: true`). Hides decision **D1 — Measurement substrate**: "how supervisor behavior is scored (runner, grader shape, scoring thresholds)" behind a stable `flow-eval` CLI + report schema, so swapping the backend to `claude plugin eval` later is "a runner change, not a consumer change" (design.md §3 D1).
- **Depends on:** none (walking-skeleton root; `dependsOn: []`).
- **Downstream dependents:**
  - `f2-scaffold-stress-test` — consumes the edge artifact "the `flow-eval` runner + the three baseline suites and their recorded baseline scores" (design.md §4 f2). Its acceptance criteria require "a before/after eval delta for that candidate, one candidate per commit", so the **report schema and the compare surface** must stay stable.
  - `f6-workflow-port` (transitively through f2) — "gate the port on the f1/f2 eval suites showing no regression against the prose baseline" (manifest f6 description + AC 4). Same stable interface.
- **Epic-level requirements this feature discharges:** R1 ("a repeatable, locally-runnable eval producing before/after scores … skips cleanly with a named notice where `claude` is absent, e.g. CI").
- **Design constraints carried in from design.md §6 Open Questions:**
  - "`claude plugin eval` enablement" — build the flow-owned harness now, record a forward check at f1's planning (done: see Architecture Decisions, "Seam to `claude plugin eval`").
  - "Eval token cost and determinism" — small fixed scenario set per candidate; deterministic artifact graders over emitted JSON/state, not free-form LLM judgment; multiple runs only where variance demands it; seed scenarios from historical pipeline runs rather than toy examples.
  - "checkpoint-pending-clear interacts with recent work" — PR #640's orientation turn; the eval must specifically cover the post-`/clear` resume path. The checkpoint suite below has a dedicated terminal-orientation scenario.
  - "Scaffold candidate set is fixed at three" — no other isolations are in scope.

## Scope Boundary

**In scope:**

- `bin/flow-eval.ts` (Bun, maintainer-only, never symlinked onto PATH) with `run`, `report`, `compare`, `validate` verbs a `--dry-run` that materializes fixtures and renders prompts without spawning `claude`, a `--record-baseline` that writes the committed baseline files in one command, and an opt-in `--concurrency <n>`.
- A declarative suite/scenario format under a top-level `evals/` directory, a headless scenario runner over `claude -p --output-format stream-json`, deterministic graders over state.json fields, `.flow-tmp/*-result.json` files, the fixture tree, and transcript-derived metrics, and a versioned JSON report + markdown summary.
- The named-skip contract: `claude` absent or not logged in → one-line notice, `skipped` report, exit 0; vitest stays the CI gate (no vitest test ever makes a model call).
- Three committed baseline suites — `verify-loop-isolation`, `haiku-gatekeeper`, `checkpoint-pending-clear` — and their recorded baseline reports under `docs/eval/baseline/`.
- A `compare` verb that turns two reports into per-scenario score deltas and per-metric deltas with `better`/`worse`/`same` verdicts — the interface f2's "before/after delta" consumes.

**Out of scope:**

- Removing, changing, or re-litigating any scaffold (f2). Correcting `docs/nested-subagents-assessment.md`'s depth-cap citation (f2).
- Making `claude plugin eval` a runner backend (tracked as a candidate follow-up — blocked on GA).
- Any CI workflow change; any new PATH-bound helper; any skill or agent definition change.
- A live-pipeline scenario recorder (candidate follow-up — needs its own design session).
- LLM-judged graders. Every grader is a deterministic predicate; a scenario's structured verdict is produced by the session under test via `--json-schema`, then graded mechanically against committed truth.

## Behavioral contrast

### User flow

| Before                                                                                                       | After                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| A maintainer arguing for a scaffold removal writes prose and guesses at context/cost impact                  | `bun bin/flow-eval.ts run --suite verify-loop-isolation --out .flow-tmp/eval` prints a score table and writes `report.json`                    |
| No way to say what "no regression" means for a removal                                                       | `bun bin/flow-eval.ts compare --base docs/eval/baseline/<suite>.report.json --candidate <run>/report.json` prints per-metric deltas + verdicts |
| `claude plugin eval` is the only eval surface, and it is org-gated and absent from CI                        | `flow-eval` runs locally; where `claude` is absent it prints `flow-eval: skipped — claude is not on PATH …` and exits 0                        |
| Baseline behavior of the three scaffolds is unrecorded                                                       | `docs/eval/baseline/*.report.json` holds the recorded baseline scores and metrics at a named git SHA                                            |

### System flow

- **Before:**
  - Measurement tooling: `flow-model-bench` (agy fan-out over model-routing fixtures) and `flow-transcript-audit` (post-hoc session-JSONL attribution). Neither can run a supervisor slice headlessly or grade its artifacts.
  - `bin/flow-plugin-contract-lint.ts` keeps its plugin-root fixture materializer (`materializeModuleContent`) module-private.
- **After:**
  - `flow-eval run` materializes a hermetic fixture per scenario (temp repo on a `main`/`eval` branch pair, a seeded `~/.flow/state/eval-<…>.json`, an optional checkpoint body + marker, PATH shims such as a fixture-backed `gh`, and plugin roots materialized from **this checkout's** `skills/`, `agents/`, and `bin/`), runs one `claude -p` session per scenario run with the flow env markers controlled (`FLOW_SLUG` set to the eval slug only when the scenario asks; `TMUX_PANE` stripped; user-level hooks excluded via `--setting-sources project`), captures the stream, grades, tears the fixture down, and writes the report.
  - `materializeModuleContent` moves to `bin/lib/plugin-root.ts` and is shared by the contract lint and the eval fixture materializer.
  - `bin/lib/sources.ts` `MAINTAINER_ONLY` gains `flow-eval`.

**Lost:** none — the change is additive; no existing helper, skill, flag, or install surface is removed or changed in behavior (the contract lint's materializer moves without a behavior change).

## User Stories / Acceptance Criteria

### Story 1: Run a suite and get a machine-readable report plus a human summary

- [ ] Given `claude` is on PATH and logged in, when a maintainer runs `bun bin/flow-eval.ts run --suite haiku-gatekeeper --out <dir>`, then `<dir>/report.json` exists, `bun bin/flow-eval.ts validate <dir>/report.json` exits 0, and stdout ends with a markdown score table (one row per scenario, a suite score line).
- [ ] Given a report directory, when the maintainer runs `bun bin/flow-eval.ts report --in <dir>`, then the same markdown summary prints and the exit code is 0.
- [ ] Given `--threshold 1.0`, when any scenario scores below it, then the exit code is 1 (mirrors `claude plugin eval --threshold`); without `--threshold` the exit code is 0 regardless of score (baseline recording never fails on score).

### Story 2: Named skip when `claude` is unavailable; vitest stays the CI gate

- [ ] Given `--claude-bin /nonexistent/claude`, when `flow-eval run` is invoked, then stderr carries exactly one line starting `flow-eval: skipped — claude is not on PATH`, `<dir>/report.json` has `skipped.reason == "claude-not-on-path"`, and the exit code is 0.
- [ ] Given `claude auth status --json` reports `loggedIn: false`, when `flow-eval run` is invoked, then the skip reason is `claude-not-authenticated` and the exit code is 0 — no scenario session is spawned.
- [ ] Given `npm run test`, when it runs on a host with no `claude` (CI), then every `bin/**/eval*.test.ts` and `bin/flow-eval.test.ts` spec passes using injected spawn doubles and the recorded stream fixture — no test makes a model call on any host.

### Story 3: Deterministic graders over flow's own artifacts

- [ ] Given a scenario with a `structured` grader, when the session's `--json-schema` verdict differs from `truth`, then the grade is `pass: false` with `expected`/`actual` populated and the scenario score drops — no LLM judge involved.
- [ ] Given a scenario run, when grading finishes, then `metrics.finalContextTokens`, `metrics.costUsd`, `metrics.numTurns`, `metrics.subagentsSpawned`, and `metrics.modelShare.<model>` are populated from the captured stream's `result` event (fields `num_turns`, `total_cost_usd`, `modelUsage`, `subagent_stats` — verified present on 2.1.238).
- [ ] Given `--dry-run`, when a suite runs, then every fixture materializes, every prompt renders, every `json-file`/`file` grader evaluates against the materialized fixture (recorded as `status: "skipped"` with the dry-run reason), no `claude` process is spawned, and every `~/.flow/state/eval-*` artifact is removed on exit.

### Story 4: Before/after comparison (f2's consumed interface)

- [ ] Given two reports for the same suite, when `flow-eval compare --base A --candidate B` runs, then stdout prints one table per scenario with `metric | base | candidate | delta | % | verdict`, where `verdict` honours the metric's declared `direction` (`lower`/`higher`) and `--tolerance` (default `0.10`), and reads `noisy` (never `worse`) when the base's own run spread already exceeds the tolerance.
- [ ] Given a metric regressed beyond tolerance or a scenario score dropped, when `--fail-on-regression` is passed, then the exit code is 1 and `regressions[]` in the JSON output names each offender.
- [ ] Given the two reports record different `runner.model` or `tree.gitHead`, when compared, then `warnings[]` names the mismatch (never silently compares apples to oranges).

### Story 5: Baseline suites committed with recorded scores

- [ ] Given the three suite directories under `evals/`, when `bun bin/flow-eval.ts validate evals/verify-loop-isolation evals/haiku-gatekeeper evals/checkpoint-pending-clear` runs, then it exits 0 (every `suite.json` and `case.json` validates; every referenced prompt, fixture, schema, and truth file exists).
- [ ] Given the unchanged tree at the PR's head, when the maintainer runs `bun bin/flow-eval.ts run --all --record-baseline`, then `bun bin/flow-eval.ts validate docs/eval/baseline/*.report.json` exits 0 and each report's `tree.gitHead` is an ancestor of the merge commit.
- [ ] Given a grader that a scaffold removal would make structurally unobservable (e.g. `.flow-tmp/verify-loop-result.json` absent once the loop runs inline), when the baseline suites are authored, then that grader carries `gate: false` — the gated graders assert mechanism-agnostic invariants only (the defect is fixed, the decision matches truth, the addendum survives the reset).

## Architecture Decisions

| Aspect         | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layers touched | `bin/` CLI + `bin/lib/` pure modules; committed fixtures under `evals/`; committed run outputs under `docs/eval/baseline/`; one small lift in `bin/lib/plugin-root.ts`.                                                                                                                                                                                                                                                                                                                               |
| Domain modules | New: `eval-suite`, `eval-fixture`, `eval-runner`, `eval-transcript`, `eval-graders`, `eval-report`. Reused unchanged: `state.ts` (`writeState`/`deleteState`), `checkpoint-freshness.ts` (`checkpointDir`, `deleteCheckpointDir`), `plugin-root.ts` (`ensurePluginRoot`, `pluginDirArgs`, `pluginBinPath`, `withPluginPath`), `paths.ts` (`resolveFlowSource`), `flow-session-start-hook.ts` (`resumeSeedFor`, `terminalContinueSeed`, `terminalCarryOver`), `slug.ts` (`isValidSlug`). |
| Data flow      | `evals/<suite>/suite.json` + `<scenario>/case.json` → materialized fixture → `claude -p … --output-format stream-json --json-schema` → `stream.jsonl` + `result` envelope → graders (fixture files, state.json, structured verdict, transcript metrics) → `report.json` → `renderSummary` / `compareReports`.                                                                                                                                                                                          |
| Pattern        | Mirrors `flow-model-bench` (thin CLI over `bin/lib/model-bench-{manifest,score,report,schema}.ts`, committed fixtures + committed outputs under `docs/model-bench/`, `MAINTAINER_ONLY`) for shape, and `flow-plugin-contract-lint` for the claude-absent named skip (`status: "skipped"`, `reason`, exit 0) and the fixture-HOME plugin-root materialization.                                                                                                                                         |

**Scenario grain — step-scoped supervisor slices.** A scenario prompt tells a fresh session to load the real skill and execute exactly one step (`/flow-pipeline` Step 6; `/flow-pr-review` Steps 1 + 1.5; the resume seed that Step 4's checkpoint hand-off produces), then emit a typed verdict and end the turn. The scaffold under test is the supervisor↔subagent split itself, so the slice must include the supervisor side; a prompt that renders the subagent's spawn prompt directly would measure the subagent alone and miss the context/cost the split exists to save. Full `flow feature create` pipelines are closed as an alternative (see below). Because the slice's prompt is the step's real entry point and never names the scaffold, f2 re-runs the identical suite after editing SKILL.md and the graders measure the new path.

**Context preload.** A step-6 slice starts with an empty context, while a real step 6 arrives with the plan/implement history behind it. Scenarios may declare `preload: ["<file>", …]` — fixture text (a real, sanitized `plan.md` + `scout.md` digest) prepended to the prompt as framed data — so `finalContextTokens` is measured under realistic pressure rather than in a regime where isolation never mattered. Prompt-free and constant across before/after.

**Child-session hygiene (verified on 2.1.238 during discovery):**

- `--setting-sources project` excludes the user's global `~/.claude/settings.json` hooks (`flow-stop-guard`, `flow-session-start-hook`, tmux status hooks) from the child — measured: 4 `Stop` + 2 `UserPromptSubmit` hook events by default, 0 with the flag. Without this, `flow-stop-guard` would block the child's turn-end whenever the eval slug's phase is non-terminal.
- `FLOW_SLUG` is set to the eval slug only for scenarios that declare `env.flowSlug: true` (the step-6 slice needs it for `flow-state-update`); `TMUX_PANE` and `FLOW_SLUG` from the maintainer's own shell are always stripped (memory: a nested `claude` inheriting the parent's `FLOW_SLUG` can overwrite the parent pipeline's state.json — flow#618).
- `HOME` is never overridden: a fixture HOME yields "Not logged in" (`bin/flow-plugin-probe.ts`, the `/not logged in/i` branch). State isolation comes from the `eval-` slug namespace + teardown instead.
- Plugin roots are materialized from **this checkout** (`resolveFlowSource()` + `ensurePluginRoot` + the lifted `materializeModuleContent`) into a temp claude-home and passed via `--add-dir <tempHome> --plugin-dir <root>…`, with `PATH = <shims>:<pluginBinPath(roots)>:$PATH`, so the skills, agents, and helpers under test are the tree under test — exactly what f2's before/after needs. Known fidelity wrinkle: SKILL.md's agent-presence probes test the literal `~/.flow/claude-home/...` path (e.g. Step 6's `[ -f ~/.flow/claude-home/.claude/skills/flow-module-core/agents/flow-verify.md ]`); the *definition resolved* by `flow-module-core:flow-verify` still comes from the `--plugin-dir` root. Recorded in the report under `runner.notes`.
- Permissions: `--permission-mode dontAsk` + `--allowedTools` from the scenario (default `Bash,Read,Edit,Write,Grep,Glob,Skill,Task,Agent,ToolSearch`); denials surface in the envelope's `permission_denials` and are graded as an error.
- Bounds: `--max-budget-usd` (scenario `maxBudgetUsd`, default 4) + an in-process wall-clock kill (scenario `timeoutSec`, default 900). `--max-turns` is **not** listed in 2.1.238's `claude --help`; do not rely on it.
- `--session-id <uuid>` pins the session for traceability; `--no-session-persistence` by default (`--keep-sessions` opts back in so `flow-transcript-audit` can read the JSONL).

**Seam to `claude plugin eval`.** The report schema carries `schemaVersion: 1` and a `runner.name` discriminator (`flow-eval-headless` today). Suites mirror `claude plugin eval`'s vocabulary where it costs nothing — a top-level `evals/` dir, per-scenario `prompt.md`, `runs`, a per-case budget/timeout — so a future `runner.name: "claude-plugin-eval"` backend is an adapter that emits the same `EvalReport`, and `compare`/`report` never change. Forward check recorded per design.md §6: revisit when `claude plugin eval` is GA for flow's org **and** flow's CI installs `claude`; until both hold, the local harness stays primary.

**Scoring.** Each grader is a gate (`gate: true`, default) or informational. A run's score = passed gates / total gates; a scenario's score = mean over runs; the suite score = mean over scenarios. `metric` graders record numbers with a declared `direction`; they gate only when `max`/`min` is set. Baseline suites gate on mechanism-agnostic invariants and record everything else, so a removal can change *how* without tripping a gate while still moving the recorded metrics. The score therefore answers only "does the step still do its job" and is expected to read `1.0` before and after a successful removal; the before/after *number* f2 reads is the per-metric delta table `compare` prints (`finalContextTokens`, `costUsd`, `numTurns`, `subagentsSpawned`, `durationMs`), and `renderSummary` prints those metrics beside the score so neither surface over-indexes on the composite. Because two runs cannot distinguish noise from signal, `compare` marks a metric `noisy` (never `worse`) when the base report's own min–max spread already exceeds the tolerance — a noisy metric is surfaced, not turned into a false regression. Two composite gates guard against a session that emits a plausible verdict without doing the work: a `metric` floor on `transcript.toolCalls.Bash` (`min: 1`) and a `file` grader asserting the captured stream carries no `NOTICE — agent-fallback:` line (a run that silently fell back to `general-purpose` measured the wrong thing).

**Binary-framing check:** the prompt did not frame a binary choice; the one-vs-many-runs question is resolved as `runs: 2` per scenario with `--runs` override (middle ground between a single noisy run and a costly 3+). **Goal-anchor check:** every decision above is validated against the Goal line — a recorded, comparable number per scaffold; nothing here exists for its own sake.

## Technical Constraints

- `bin/` helper conventions (AGENTS.md "Scripts: Bun runtime"): `#!/usr/bin/env bun`, `chmod +x`, `import.meta.main` gate, tests next door, run via `npm run test`.
- `bin/lib/sources.ts:53` `MAINTAINER_ONLY` must gain `"flow-eval"` and `bin/lib/sources.test.ts:75`'s pin must be extended — otherwise `flow install` symlinks it onto users' PATH and `flow-pre-commit`'s exec-bit gate disagrees with the installer.
- No vitest spec may spawn a model call (precedent: `bin/flow-plugin-contract-lint.test.ts` only calls free `claude plugin` subcommands and `it.skipIf`s without `claude`). Runner tests inject `spawn`; grader tests read a committed stream fixture captured from a real haiku run.
- Child env: strip `FLOW_SLUG`/`TMUX_PANE` (memory flow#618; `bin/flow-stop-guard.ts` resolves the slug env-first) and pass `--setting-sources project` (verified above). Never override `HOME` (`bin/flow-plugin-probe.ts` "Not logged in" evidence).
- State hygiene (AGENTS.md "Don't leave spawned resources running"): every state write goes through `writeState`/`deleteState` + `deleteCheckpointDir` under an `eval-` slug prefix that passes `isValidSlug`; teardown runs on every exit path including timeout, budget abort, and SIGINT.
- Fixture placement: `evals/` sits outside `tsconfig.scripts.json`'s `bin/**/*.ts` include and `vitest.config.ts`'s `bin/**/*.test.ts` include, so planted defects in fixture repos never break `npm run typecheck:scripts` / `npm run test`. `.prettierignore` must list `evals/*/*/fixture/` and `evals/*/*/overlay/` (planted files are intentionally unformatted — precedent: `bin/fixtures/model-bench/`) and `docs/eval/baseline/` (generated JSON/markdown — precedent: `docs/model-bench/`).
- Cost / latency (performance-implications category): a full baseline is 11 scenarios × 2 runs = 22 headless sessions, hard-capped at `22 × $4 = $88` by `--max-budget-usd`, expected $10–40 and 30–60 min wall-clock at the default `--concurrency 1`. `--concurrency <n>` (opt-in) runs scenario runs in parallel — each run owns a unique `eval-` slug, temp root, and fixture repo, so state never collides — at the cost of `duration_ms` comparability under CPU contention, which is why the documented baseline protocol keeps concurrency 1. CI time is unaffected (named skip).
- Verified CLI surface (2.1.238 `claude --help`): `-p`, `--output-format json|stream-json`, `--verbose`, `--json-schema` (→ `structured_output` in the result event — verified), `--setting-sources`, `--permission-mode dontAsk`, `--allowedTools`, `--max-budget-usd`, `--session-id`, `--no-session-persistence`, `--add-dir`, `--plugin-dir`, `--model`; `claude auth status --json` → `loggedIn` (free auth probe, no model call).

## Open Questions

- [ ] **Fixtures live under a top-level `evals/`, not `bin/fixtures/eval/`.** On redirect to `bin/fixtures/`, Tasks 7–9 add tsconfig/vitest excludes for planted defects and the `claude plugin eval` dir-name alignment is lost.
  - **Recommended:** `evals/` — `tsconfig.scripts.json` includes `bin/**/*.ts` and `vitest.config.ts` includes `bin/**/*.test.ts`, so planted defects under `bin/` would need per-suite exclusions (model-bench already carries one); `evals/` is outside both globs and is `claude plugin eval`'s default eval dir name.
- [ ] **Scenario prompts carry an eval-side stop clause** ("emit the verdict and end the turn; do not proceed to the next step"). On redirect (no clause), scenarios run to the pipeline's natural pause points, which for the step-6 slice means attempting Step 7 against a nonexistent PR.
  - **Recommended:** keep the clause — it is constant across f2's before/after runs, so it cancels in the delta; bounding each run is what keeps the suite "small and fixed" (manifest AC 3). The fidelity cost is recorded under `runner.notes`.
- [ ] **`runs: 2` per scenario at baseline.** On redirect to 1, variance is invisible; to 3+, baseline cost roughly ×1.5.
  - **Recommended:** 2, with `--runs` override and median-based compare — the design asks for "multiple runs only where variance demands it"; two runs reveal whether a scenario is noisy enough to deserve a third without paying for it everywhere. `compare`'s `noisy` verdict (base spread > tolerance) is what keeps N=2 honest: a metric whose two baseline runs already disagree beyond tolerance is reported as noisy rather than as a regression, and that is the signal to re-record that scenario with `--runs 3`.
- [ ] **Model pinning.** Scenarios inherit the harness default model unless `suite.defaults.model`/`--model` is set; reports record `runner.model` and `modelUsage`, and `compare` warns on mismatch. On redirect (pin a model in every suite), the baseline must be re-recorded whenever the pin changes.
  - **Recommended:** inherit by default — pipelines run on the session default too, so the eval measures the scaffold under the model flow actually runs; the mismatch warning prevents silent apples-to-oranges comparisons.
- [ ] **Historical seeding depth.** Scenario inputs are seeded from existing historical material (the c10-gatekeeper fixture derived from real flow PR shapes; real `~/.flow/state/` phase/checkpoint shapes; a sanitized real `plan.md` as context preload), each recorded in `case.json`'s required `provenance` field. A recorder that turns a live pipeline's trail into a scenario is a candidate follow-up. On redirect (recorder in scope), the diff roughly doubles and a transcript-privacy decision must be made first.
  - **Recommended:** as scoped — it satisfies the design's "seed from historical runs, not toy examples" intent today, and the recorder's open decision (what is captured, transcript privacy per `docs/context-economy-audit.md`'s privacy note) needs its own session.
- [ ] **Who records the baseline and when** — see Decision analysis A. On redirect to in-pipeline recording, Task 10 becomes an implementer step and the PR's gate loses its reason to exist.
  - **Recommended:** the maintainer records at the PR's gate (the manifest already sets `autoMerge: false` for f1), pushes the reports to the PR branch, and ticks the Test Step.
- [ ] **Default per-run budget `$4` and timeout `900s`.** On redirect (lower), long step-6 slices may abort as `error`; (higher) the $88 hard ceiling rises.
  - **Recommended:** `$4` / `900s` — a haiku gatekeeper slice measured ≈$0.04–0.10 during discovery; a sonnet-class step-6 slice with one subagent is expected well under $3; `error` runs are reported, never silently dropped, so a too-low cap is visible on the first baseline run.
- [ ] **Session persistence off by default** (`--no-session-persistence`, `--keep-sessions` opts in). On redirect (persist by default), every baseline run leaves ~22 session files under `~/.claude/projects/`.
  - **Recommended:** off — the captured `stream.jsonl` already holds every signal the graders use; `--keep-sessions` exists for the rare `flow-transcript-audit` deep-dive.

## Decision analysis

**Decision A — who records the baseline, and when?** Three exclusive branches:

- **(a) The implementer records it in-pipeline** — `/flow-new-feature` runs `flow-eval run --all` during Task 10. **0 interruptions.** System flow: a `/flow-pipeline` supervisor session's coder spawns ~22 nested `claude -p` sessions ($10–40, 30–60 min) from inside a supervisor turn — the exact "supervisor never invokes `claude -p` subprocesses" boundary AGENTS.md draws (the leaf-skill carve-out covers standalone skills, not the implement phase), and the pipeline's step 6/7 clock runs while it waits.
- **(b) The maintainer records it at the PR's gate** — the PR is already `gated` (`flowNewHints.autoMerge: false`); one Test Step reads "run the baseline protocol from a plain shell and push the three reports to this branch". **1 interruption per run — the gate that exists anyway.** User flow: the maintainer opens a plain shell in the worktree, runs `bun bin/flow-eval.ts run --all --out .flow-tmp/eval-baseline` (30–60 min, unattended), copies the reports per `docs/eval/README.md`, commits, pushes, ticks the box; the pipeline merges with the baseline in the same PR, so f2's edge artifact is complete at merge.
- **(c) A follow-up PR after merge** — **1 interruption plus a second pipeline**; f2 cannot start until it lands, and the baseline SHA no longer equals the harness SHA.

Verdict: **(b)** — ranked strictly above (a) on the AGENTS.md boundary and above (c) on keeping the baseline and the harness in one reviewable PR; it costs zero interruptions beyond the gate the manifest already mandates.

**Decision B — scenario grain: step-scoped supervisor slices vs subagent-only prompts?** Two exclusive branches. **(i) Slices** load the real skill and run exactly one step, so the measured object is the supervisor↔subagent split (the scaffold); after f2 edits SKILL.md the identical prompt exercises the new inline path and `finalContextTokens`/`subagentsSpawned` move. **(ii) Subagent-only prompts** render `verify-loop-instructions.md` / `gatekeeper-spawn-prompt.md` directly — cheaper and more deterministic, but they measure the subagent in isolation; a removal that deletes the subagent leaves the scenario with nothing to run, so before/after is undefined. 0 interruptions either way. Verdict: **(i)** — it is the only branch under which f2's "before/after delta for that candidate" is well-defined; (ii) survives only as the model-bench surface it already is (`c10-gatekeeper`).

### Cross-model review (AGY)

Depth `deep`; reviewers: Gemini 3.7 Flash (High) — ran, 6/6 lenses; Claude Opus 4.6 (Thinking) — did not run (`agy-error`). One engaged reviewer, so every point below is single-reviewer INPUT (no convergence presumption).

- **Accepted — one-command baseline (`--record-baseline`).** The Goal line says "runs one command"; Task 10's copy/rename/re-render ritual did not. `run --record-baseline` now writes `docs/eval/baseline/<suite>.report.json` + `.summary.md` and the README recorded-at table directly (Task 6, Task 10, Story 5, Test Steps). Commit + push stay with the maintainer.
- **Accepted — opt-in `--concurrency <n>`, default 1.** The reviewer is right that per-run `eval-` slugs and temp roots never collide; the plan's "shared state" rationale was wrong. Default stays 1 so baseline `duration_ms` is recorded without CPU contention; the protocol names that trade-off.
- **Accepted (partial) — `runs: 2` robustness.** Kept at 2 (cost), but `compare` gains a `noisy` verdict: a metric whose base spread already exceeds tolerance is reported as noisy, never as `worse`, and that is the cue to re-record with `--runs 3` (Task 2, Open Questions).
- **Accepted — composite gating against premature verdicts.** Every suite gains a `metric` floor `transcript.toolCalls.Bash ≥ 1` where work is expected (Task 7) and a `file $STREAM notMatches "NOTICE — agent-fallback:"` gate (Tasks 7–9), so a session that fell back to `general-purpose` or emitted a verdict without acting cannot score a pass.
- **Accepted — null-tolerant `gh` shim.** Unknown `--json` keys return `null` (exit 0); unknown subcommands still fail loudly (Task 8).
- **Accepted — grader-kind consolidation.** Nine kinds → six: `file` absorbs exists/absent/matches (+ `notMatches`), and `state-field` is just `json-file` with `file: "$STATE"` (Tasks 1, 3, 7–9).
- **Accepted — `environmentMismatch` on `compare`.** Model/CLI-version mismatch is an explicit boolean plus the existing `warnings[]`; exit semantics are unchanged — f2 re-records the baseline on the same model rather than relaxing tolerance (Task 2).
- **Already present — raw (un-cached) context tokens.** `finalContextTokens` is defined as `input + cache_read + cache_creation` of the last top-level assistant turn, i.e. the raw figure the reviewer asked for; `costUsd` is recorded separately (Task 3, unchanged).
- **Overridden — cut `validate` / `report`.** `validate` is what the Test Steps and `bin/evals-suites.test.ts` run without `claude` (committed suites and baseline reports stay checkable in CI); `report` re-renders a committed report. Both are a few lines over the shared modules.
- **Overridden — static seed text instead of `promptSeed`.** The epic's design constraint is that the checkpoint suite covers PR #640's resume/orientation path as the hook actually delivers it; a pasted copy of the seed rots silently when `flow-session-start-hook.ts` changes. The coupling is one import of pure functions (Task 9).
- **Overridden — `evals/` justified by `claude plugin eval` parity.** The load-bearing reason is the `tsconfig.scripts.json` / `vitest.config.ts` glob boundary (planted defects must never break `npm run verify`); parity is a free secondary. The Open Question already lists them in that order.
- **Overridden — alternative 2 (Agent SDK in-process runner).** The scaffold under test is the CLI's own Skill/Task/plugin machinery; an SDK runner cannot load flow's skills and agents the way a session does, so it would measure a different system.
- **Overridden — alternative 3 (offline transcript replay).** Cannot observe behavioural outcomes (did the fix land, did the decision match truth); noted as a possible complement for the candidate `record` follow-up, not adopted.
- **Overridden — score "drifts from contract".** Intentional: score = "still does its job", metrics = "what it cost". The Scoring paragraph now says so explicitly and `renderSummary` prints metrics beside the score.

<!-- flow-plan-review-hash: e0c01bd1b92ce0432a9314c4059bcac1c7c7dba585db4782069048ab700f71f6 -->

## Alternatives considered

- **Anchor the harness on `claude plugin eval`** — rejected: org-gated early access per design.md §3 verdict 4 (re-verified 2026-08-19), and `.github/workflows/ci.yml` installs Node and Bun only, so it could never be the CI signal; kept as the report-schema seam and a candidate follow-up.
- **Run full `flow feature create` pipelines as scenarios** — rejected: a pipeline needs a remote, a real PR, and CI (`/flow-pipeline` Step 7 `flow-ci-wait`), takes 30–90 min and $5–20 per run, and its outcome depends on live GitHub state — not a "small fixed headless scenario suite" (manifest AC 3) and not hermetic.
- **Isolate the child session by overriding `HOME`** — rejected: `bin/flow-plugin-probe.ts`'s Task-tool probe observed "Not logged in" under a fixture HOME (its `/not logged in/i` branch exists for exactly this); isolation comes from the `eval-` slug namespace, `--setting-sources project`, and teardown instead.

## Recommendation

**Proceed** — the request is the epic's walking-skeleton root, every load-bearing platform fact was verified against the installed CLI during discovery, and the design follows two existing in-repo patterns (`flow-model-bench` for shape, `flow-plugin-contract-lint` for the named skip) rather than inventing one.

**Redundancy:** partial overlap only — `flow-model-bench` (`bin/flow-model-bench.ts`) scores *model routing* over agy-delegated surfaces and `flow-transcript-audit` (`bin/flow-transcript-audit.ts`) attributes a finished pipeline's tokens; neither can run a supervisor slice headlessly or grade its artifacts, and both are reused (the c10-gatekeeper fixture as seed; the usage-summing approach) rather than duplicated.

## Plan risks

The single weakest assumption is that a step-scoped slice with a ~40 KB context preload reproduces enough of a real session's context pressure for `finalContextTokens` to discriminate — if the isolation scaffolds only pay off past several hundred thousand tokens of accumulated history, the verify-loop suite will show a small, clean delta that f2 reads as "no regression" while the real supervisor at step 6 would have lost the protection; the mitigation built in (the `preload` field, sized from a real `plan.md`, plus `runner.notes` naming the wrinkle) makes the regime visible in every report, but it does not make the harness immune to it.

## Cut list

- No `list` verb — three suite directories under `evals/` are their own listing; `validate <dir>` already prints what it loaded.
- No HTML report or publish step (`claude plugin eval` has `--report`/`--publish-report`) — `summary.md` + `report.json` are what f2 consumes; a browser report would be a second renderer to keep in sync with the seam.
- No per-grader weights — binary gates plus recorded metrics keep scoring legible; weights would let a suite author hide a failing gate behind arithmetic, the opposite of the "measured, never a silent retention" intent (design.md R2).

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| `flow-eval record --from-slug <slug>` | High | Medium | Needs its own design/decision session — the open decision is what a recorded live-pipeline trail captures (state.json phaseLog, `.flow-tmp` artifacts, session JSONL) and the transcript-privacy boundary `docs/context-economy-audit.md` draws; directly strengthens the epic's named plan risk | Extends this harness's seeding story beyond the historical fixtures f1 ships | No |
| `claude plugin eval` as a `flow-eval` runner backend | Medium | Medium | Genuinely novel non-trivial feature — an adapter from `claude plugin eval --json` output to `EvalReport` v1 (`runner.name: "claude-plugin-eval"`), blocked on org GA and on CI installing `claude`; the seam this PR ships is what makes it an adapter rather than a rewrite | The forward check design.md §6 asked f1 to record; consumes this PR's report schema unchanged | No |

- [x] `flow-eval record --from-slug <slug>` — record a live pipeline's trail as a replayable eval scenario; decide what is captured and the transcript-privacy boundary first.
- [x] `claude plugin eval` as a `flow-eval` runner backend — adapter emitting `EvalReport` v1; revisit when the command is GA for flow's org and CI installs `claude`.

