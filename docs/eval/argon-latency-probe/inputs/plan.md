# PRD

# Argon 4 time limits and routing evidence for every agy-delegated flow step

**Goal:** Every Argon-routed flow step gets a time limit sized from measured Argon latency, plus Argon 4 High/Medium quality evidence and a per-step routing recommendation to discuss.

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — agy returned no findings (the Gemini 4 Argon (High) gather hit its 3-minute limit with an empty answer, and both Claude refuters were refused with a quota that resets in ~92h); force with `flow feature create --research`.

**Research findings (prior context, from a direct web lookup after the agy fan-out came back empty):**

- **high** — Google AI Ultra's Antigravity quota "refreshes every five hours" and is also subject to weekly limits; no numbers are published (https://antigravity.google/docs/plans).
- **high** — Google publishes nothing on whether Argon's thinking level (High vs Medium) changes quota use; the plans page only says more complex agent work uses more quota (same page).
- **low** — Users report Claude and GPT models drawing from one weekly pool separate from Gemini, with multi-day lockouts once it runs dry (https://discuss.ai.google.dev/t/google-ai-ultra-max-20x-quota-issue-20-weekly-limit-gone-in-one-hour/174110). Treated as a risk below, never a plan assumption.

## Problem Statement

**Premise check:** the request assumes Argon 4 still has to be put "in place of the old 3.1 model". The codebase shows the swap already shipped on 2026-10-13 (PR #925): five Google-plan steps — PR intent guessing, the Gemini review lens, research gathering, the first plan reviewer and the first method-survey judge — moved to Gemini 4 Argon (High) with no measurement, because agy retired Gemini 3.1 Pro / 3.7 Flash. What is missing is evidence, not the swap.

flow's single user pays for every model choice twice: in Claude spend when a step runs on Claude, and in Google AI Ultra quota when it runs through agy. Today nobody can say whether the five Argon-routed steps are as good as what they replaced, whether Argon Medium would do the same job for less quota, or which other steps could move off Claude. Three live signals say this matters now:

| Signal                              | What the user experienced                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| This pipeline's method survey       | The first judge (Argon 4 High) hit its 3-minute limit and returned nothing; the second judge also returned nothing.                                                                                                                                                                                              |
| This discovery pass's research step | The Argon 4 High research gather spent 163 s of model time, read ~114k tokens of search results, and was cut at 3 minutes with an empty answer.                                                                                                                                                                  |
| Same research step, Claude side     | Both Claude Opus 5.5 (Medium) calls were refused: "Individual quota reached … Resets in 92h31m22s" — the Claude pool on the Google plan is locked for ~4 days, so the plan reviewer #2, method-survey judge #2 and research fact-check (all Claude via agy) are silently missing from every pipeline until then. |
| This plan's cross-model review      | The Argon 4 High plan reviewer wrote 24 KB of real findings and was cut off mid-answer at 3 minutes; the pipeline recorded it as a timeout.                                                                                                                                                                      |

The 3-minute limits on three Argon steps are now the most visible cost: every pipeline that reaches them can lose its first plan reviewer, its first survey judge and its research gather, and the user receives a "timed out" line instead of the review. Raising them is not a one-number change: the survey, the research run, the intent guess and the Gemini review each run inside a single tool call that the host kills at 10 minutes, so a longer limit needs a different way of waiting.

The measuring tool itself cannot run as-is: its default roster names three models agy no longer offers, so every slot would fail before measuring anything.

## Request vetting

- **Hypothesis:** lifting every Argon-routed limit to at least 10 minutes, sized from a production-realistic latency probe, turns the observed 3-minute empty answers into usable ones, and a fixture bench scored against ground truth and the committed pre-retirement results separates Argon High from Medium per step clearly enough to ground a routing discussion.
- **Case against:** a longer limit only helps if Argon converges — the research gather explored for 163 s and never started an answer, so it may stall at 10 minutes too, at a higher quota cost per call [anchor: bin/flow-research-run.ts]; four callers run inside one 10-minute tool call and the plan-review waiter records a ~600 s ceiling on background calls, so a 10-minute call cannot simply be "raised" [anchor: bin/lib/delegate-timeouts.ts] [anchor: bin/flow-plan-review-wait.ts]; and static fixture prompts never measured agentic answer time, the failure that motivated this [anchor: docs/model-bench/report.md].
- **Sources:** https://antigravity.google/docs/plans ; in-repo delegate helpers, waiter and bench report; this plan's partial cross-model review (Argon reviewer #1, cut off at 3 minutes).
- **Verdict:** adopt-with-conditions: each lifted limit equals the larger of 10 minutes and 3× the Stage 0 median Argon High answer time (20-minute ceiling), every caller waits through a detached run instead of one tool call, and routing verdicts gate on fixture ground truth, not on the Opus 5.5 baseline.
- **Cross-model case against:** the research gather has no bound on searches or pages read, so a longer limit may only lengthen an empty answer; and survey + research + plan review run in series, so at the 20-minute ceiling the pre-implementation wait can reach ~76–86 minutes.

## Existing-code assessment

- **bin/flow-model-bench.ts:** simplify — 584 lines (target < 200) and its default roster names retired models; retire the stale defaults and put every new behaviour (resume, warm-up skip) in `bin/lib` modules rather than growing this file; its transport retry re-fires `agy-timeout` slots twice, which stops being a blip once cases run at production limits [anchor: bin/flow-model-bench.ts:83]
- **bin/lib/model-bench-score.ts:** simplify — the Limitations line hardcodes "claude-sonnet-4-6" regardless of `--incumbent`, a candidate silently passes every gate on a case/arm where the baseline has no rows, and the latency gate always runs [anchor: bin/lib/model-bench-score.ts:466]
- **bin/lib/model-bench-schema.ts:** keep — extend the surface list and add optional case fields [anchor: bin/lib/model-bench-schema.ts:21]
- **bin/lib/model-bench-manifest.ts:** keep — `toFanoutEntries` already maps per-case fields onto fanout entries; one more field fits [anchor: bin/lib/model-bench-manifest.ts:253]
- **bin/lib/model-bench-report.ts:** keep — add one report section [anchor: bin/lib/model-bench-report.ts:111]
- **docs/eval/review-model-recall/run.ts:** keep — the agy arm table is the designed extension point; its failure counter needs a quota class [anchor: docs/eval/review-model-recall/run.ts:54]
- **docs/eval/review-model-recall/score-arms.ts:** keep — per-cell stats already carry duration, so a recall view at the production 8-minute lens limit is one pure function [anchor: docs/eval/review-model-recall/score-arms.ts:15]
- **bin/lib/delegate-models.ts:** keep — dated evidence comments only, no value changes [anchor: bin/lib/delegate-models.ts:74]
- **bin/flow-plan-review.ts:** keep — one constant; the give-up cap already re-derives from it [anchor: bin/flow-plan-review.ts:186]
- **bin/flow-blind-survey.ts:** keep — one constant; its caller moves to a detached run [anchor: bin/flow-blind-survey.ts:69]
- **bin/flow-research-run.ts:** keep — one constant, shared by gather and fact-check; its status file (written on every exit path, unlike its stdout) becomes an atomic write so a waiter can rely on it [anchor: bin/flow-research-run.ts:63]
- **bin/lib/delegate-timeouts.ts:** simplify — the 9-minute clamp exists only because callers ran inside a 10-minute tool call; once they detach it becomes a 20-minute sanity bound [anchor: bin/lib/delegate-timeouts.ts:37]
- **bin/flow-gemini-lens.ts:** simplify — the diff-only retry's budget is derived from the 9-minute ceiling; it becomes a fixed 2 minutes [anchor: bin/flow-gemini-lens.ts:384]
- **bin/flow-plan-review-wait.ts:** keep — already a generic bounded file waiter; add a complete-line mode and a wake when the launched process exits [anchor: bin/flow-plan-review-wait.ts:110]
- **bin/flow-delegate-fanout.ts:** keep — make the result write atomic so a waiter never reads half a file, and carry each delegate envelope's failure class into its entry (today only the skip reason is copied) [anchor: bin/flow-delegate-fanout.ts:319]
- **Skill call sites (survey, forced research, Gemini lens, intent guess, discovery research):** keep — swap the one blocking call for the detach-and-wait recipe the plan review already uses [anchor: skills/pipeline/flow-pipeline/references/step3-threading.md:431]

## Scope Boundary

**In scope:**

- A Stage 0 latency probe: the three calls that timed out in this pipeline (research gather, plan reviewer #1, survey judge A) plus the two opt-in review steps, re-run on Argon High and Medium under production conditions (same prompts, same repository read access) with a 20-minute cap, sizing a limit per step for each model.
- Lifting every Argon-routed time limit to at least 10 minutes, sized from that probe, and making every enclosing wait coherent: the survey, forced research, discovery research, the Gemini review and the intent guess wait through a detached run; the plan review's give-up time follows automatically.
- Make the bench runnable on today's agy roster and able to finish a run that is split across quota windows.
- Two new fixtures for the never-measured steps: research gathering and the method-survey judge (the latter with repository-style read access).
- A report that cannot silently clear a model: no-baseline cases are flagged, and the latency gate is off for this run; with a ground-truth floor set, a case with no baseline rows or a case every model aces is judged against the fixture's ground truth instead of being written off as inconclusive.
- Argon High on the review-lens recall harness (the delegated Claude lenses — the largest Claude cost a pipeline can move to agy), run unconditionally and early in Stage 1; Argon Medium follows only if High clears the lens bar; recall is also reported at the production 8-minute lens limit.
- A pre-registered decision rule, committed before any routing measurement, then the run itself, and a per-step recommendation table for discussion.

**Out of scope:**

- Changing any routing default (interview Q1: "discuss first").
- Any Opus 5.5 run through Claude Code (user: "exclude claude code opus 5.5").
- The Opus 5.5 reference tranche through agy: it waits for the Google plan's Claude pool to reset (~2026-10-18 evening), so it moves to a ticked follow-up instead of holding the lifted limits back (product critique P1).
- New delegation seams for write-capable phases — coder, fix-applier, discovery, merge-resolver (interview Q4; candidate follow-up).
- The supervisor, which stays on Claude Code.
- Argon 4 Low and Gemini 3.8 Flash arms (interview Q2: High + Medium only).
- The delegated Claude lens and scout limits (8 minutes): they run Claude through agy today, not Argon; they move with any routing change agreed after the discussion.

## Behavioral contrast

### User flow

| Before                                                                                                                      | After                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan reviewer #1, survey judge A and the research gather are cut at 3 minutes; this pipeline lost all three to "timed out". | Each Argon step gets at least 10 minutes, sized from measured Argon times; a slow answer arrives instead of nothing, at the cost of a longer wait on that step.                                   |
| The method survey, forced research, the Gemini review and the intent guess must finish inside one 10-minute tool call.      | They run detached; flow waits until each finishes, exits without an answer, or its own give-up time passes, then reports the result, the existing skip line or a named timeout exactly as before. |
| Running the bench with no `--models` targets three retired models; every slot fails as "model unavailable".                 | Defaults to Gemini 4 Argon High + Medium, scored against fixture ground truth and the last measured models' committed results.                                                                    |
| A quota refusal mid-run is recorded as a model failure and drags that model's reliability score down.                       | The run stops at the first quota refusal, prints how many slots remain and when quota resets, and `--resume` finishes the remaining slots later.                                                  |
| "Is Argon right for plan review?" has no answer; the source comments say "unbenchmarked".                                   | One table per step: Argon High vs Medium vs the pre-retirement models, Argon High on the Claude review lenses, production-realistic answer times, and a recommendation to discuss.                |

### System flow

- **Before:**
  - Three Argon steps carry 3-minute limits, the intent guess 5 and the Gemini lens 8; a 9-minute clamp stops anyone configuring more, because the callers run inside a 10-minute tool call.
  - The bench dispatches only through agy, writes results once at the very end, and dispatches every case at a flat 15 minutes.
  - Research gathering and the method-survey judge have no fixture, so no run can measure them.
- **After:**
  - Every Argon-routed limit is at least 10 minutes (sized from the Stage 0 probe, 20-minute ceiling), except a step Stage 0 marks "stalls", which keeps its old limit and is named in the PR; the callers launch the helper detached and wait in re-armed, ≤9-minute steps, so no single tool call holds the agy call.
  - The plan review's give-up time grows on its own (it is computed from the reviewer limits): 8 → 15 minutes standard, 23 → 30 minutes deep at a 10-minute limit.
  - The bench writes results after every chunk, separates quota refusals and tool-denied empty answers from model failures, resumes into an existing results file, and dispatches each case at its step's production limit without re-firing a slot that timed out there.
  - A waiter wakes when the detached helper exits, so a helper that skips without printing (forced research on an agy outage) no longer holds the step until its give-up time.
  - Fourteen fixtures; two carry the production web-search posture and one the production read-access posture.

**Lost:** a stuck Argon call now holds its step for up to its new limit (at least 10 minutes) instead of 3, so a pipeline whose Argon calls hang gets slower; the Gemini review's diff-only retry no longer shrinks to fit a 10-minute tool call (fixed at 2 minutes); the bench's default roster no longer names Gemini 3.1 Pro / 3.6 Flash / Sonnet 4.6 (agy no longer offers them) — their committed results stay in `docs/model-bench/` as historical evidence and become the primary comparison.

## User Stories / Acceptance Criteria

### Story 1: Time limits come from production-realistic measurement

- [ ] Given the probe harness, when it builds its calls, then each one uses the production prompt builder and the production read-access / web-search posture for its step — unit test in `docs/eval/argon-latency-probe/run.test.ts`.
- [ ] Given probe records, when `sizeLimit` runs for a model, then it returns the larger of 10 minutes and 3× that model's median answer time, capped at 20 minutes, and marks a step whose calls on that model are mostly empty as "stalls" — unit test, covering a step that stalls on High and fits on Medium.
- [ ] Given the committed Stage 0 evidence, when it is read, then it holds at least 13 Argon High records and an Argon High and an Argon Medium limit for plan review, survey and research gather — `jq -e` check.

### Story 2: Every Argon-routed step gets its lifted limit end to end

- [ ] Given the code, when the five Argon limits are read, then each is at least 600 seconds, except a step Stage 0 marks "stalls" on Argon High, which keeps its old limit and is named in the PR's TLDR and Test Steps — a `bun -e` check over the non-stalling steps.
- [ ] Given the plan review at a 10-minute reviewer #1 limit, when the give-up cap is computed, then it equals reviewer #1 + reviewer #2 + 300 s slack — unit test on `maxElapsedSec`.
- [ ] Given the five call-site docs, when the lint runs, then each launches its helper with `flow-spawn --detach` and waits with the complete-line waiter bound to the launched pid, and none runs it as one blocking tool call — `bin/long-delegate-calls-lint.test.ts`.
- [ ] Given `--complete-line`, when the watched file is empty or ends mid-line, then the waiter keeps waiting — unit test; given `--pid` of an exited process and an empty file, then the waiter returns at once — unit test; given a fanout run or a research status write, then the file appears only complete — unit tests.

### Story 3: The bench runs on today's roster and survives quota windows

- [ ] Given no `--models` flag, when the bench parses arguments, then the roster is `gemini-4-argon-high,gemini-4-argon-medium` — a unit test in `bin/flow-model-bench.test.ts` asserts it.
- [ ] Given a dispatch where an entry's agy error text matches the quota pattern, when the chunk completes, then no further chunk is dispatched, the slot is stored with `failureClass: "quota-exhausted"` and the reset duration, and the process exits 3 — a unit test with a fake fanout asserts all three.
- [ ] Given an existing results file with some slots done, when the bench runs with `--resume --max-calls N`, then pending slots are selected before the cap, so a second tranche dispatches new slots — unit test.
- [ ] Given a resume, when the blinded packet is rebuilt, then every earlier row keeps its id — unit test.
- [ ] Given a quota-refused attempt, when the scorer computes reliability, then that attempt is excluded from the denominator — unit test in `bin/lib/model-bench-score.test.ts`.
- [ ] Given a case dispatched at its production limit, when a slot times out or is quota-refused, then the transport retry does not re-fire it — unit test with a fake fanout counting dispatches.

### Story 4: The two unmeasured steps get fixtures

- [ ] Given the fixtures dir, when cases load, then `c11-research-gather` and `c12-blind-survey` validate and their prompts contain the production prompt text verbatim — drift tests fail if the production prompts change; `c12` passes its context directory as read access.

### Story 5: The report cannot silently clear a model

- [ ] Given a case/arm where the incumbent has no rows, when a verdict is computed with no ground-truth floor, then it is `inconclusive` naming the missing baseline — unit test.
- [ ] Given `--ground-truth-floor 0.8`, when a no-baseline case or a case every model aces is scored, then the candidate passes it only at recall ≥ 0.8 with no forbidden claim and no vacuous field, and the reason names "ground truth only" or "at ceiling" — unit tests for pass and fail.
- [ ] Given `--no-latency-gate`, when a candidate is slower than the incumbent, then no verdict cites latency — unit test.
- [ ] Given cases with `productionTimeout`, when the report renders, then it contains a `## Production timeout fit` section with one row per (step, model) — unit test; a drift test asserts each case's value equals the production constant.

### Story 6: Evidence and recommendations land, with no routing change

- [ ] Given the run, when the PR is ready, then `docs/model-bench/argon-4-2026-10/` holds results, the blinded judge packet and key, and verdicts; and `docs/eval/argon-4-routing-2026-10.md` holds a recommendation per step — `test -f` checks.
- [ ] Given the PR diff, when the delegate defaults are read, then every value equals its pre-PR value — a `bun -e` + `jq -e` check.
- [ ] Given git history, when the rule and the results are compared, then the commit adding the pre-registered rule is an ancestor of the commit adding the results — `git merge-base --is-ancestor`.
- [ ] Given judged lens cells, when the arm aggregate is computed with an 8-minute production limit, then a cell slower than the limit counts as zero recall in the production-limit column and is untouched in the full-length column — unit test in `docs/eval/review-model-recall/score.test.ts`.
- [ ] Given Stage 0 marks a step "stalls" on Argon High and "fits" on Argon Medium, when the PR body is finalized, then its Test Steps carry a `DECISION:` item naming that step, Medium's limit and the one-line `delegate.models.<surface>` override — `grep -q` on the PR body.

## Architecture Decisions

| Aspect                     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layers touched             | Five delegate helpers' time limits and the delegate-timeout config resolver (runtime); the skill docs that call them; a generic file waiter and the fanout's result write; the maintainer-only bench, its fixtures and the recall harness; evidence docs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Domain modules             | Delegate helpers (`flow-plan-review`, `flow-blind-survey`, `flow-research-run`, `flow-gemini-lens`, `flow-gemini-intent-guess`), `delegate-timeouts`, `flow-plan-review-wait`, `flow-delegate-fanout`, `flow-model-bench` (+ new `model-bench-resume` lib), `review-model-recall` harness, a new `argon-latency-probe` harness, `delegate-models` (comments only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Data flow                  | Stage 0: production prompt builders → agy (20-minute cap, repo read access) → probe records → per-step limits → constants. Bench: fixture → composed prompt → agy at the production limit → results.json (per chunk) → scorer (+ committed baseline rows) → report / verdicts → recommendation doc.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Waiting past 10 minutes    | Detach-and-wait: `flow-spawn --detach` launches the helper with its stdout captured to an envelope file and prints the child pid; the caller re-runs a ≤9-minute bounded waiter (`--complete-line --pid <pid>`) until the envelope holds a complete line, the helper has exited, or a give-up time computed from the helper's own limits passes. Forced research waits on its status file, which every exit path writes. Same pattern as the plan review's detached worker.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Pattern                    | Follows the pre-registered-rule measurement in `docs/eval/agy-delegation-recall-2026-10.md`, the per-run evidence directory in `docs/model-bench/`, and the detached worker in `flow-plan-review --start`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Binary-framing check       | "10 minutes? More?" is not binary: the plan sets a 10-minute floor and raises a step above it only where Stage 0 measures a slow median (3× rule), with a 20-minute ceiling past which a step is reported as a limit mismatch instead of being given more time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Baselines                  | Primary: fixture ground truth plus the committed rows of Sonnet 4.6 (the bench's former reference, all 12 cases) and the retired pins (3.1 Pro, 3.7 Flash), at zero quota. Secondary: Opus 5.5 through agy on five cases after the Claude pool resets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Failure modes (automation) | (1) quota refusal mid-run → halt, exit 3, `--resume`; (2) crash mid-run → per-chunk writes lose at most one chunk; (3) Gemini weekly cap reached → tranche cap, screen-first elimination, production probe between tranches; (4) fixture drift from production prompts → drift tests; (5) a detached helper wedges → the give-up time kills its process group and reports a named timeout; (6) a waiter reads a half-written result → atomic writes plus a complete-line check; (7) a helper exits without printing (forced research skips on an agy outage, or a crash) → the waiter's `--pid` wake returns at once and the caller takes the existing skip path; a recycled pid can at worst hold the wait to the give-up time; (8) a slot times out at its production limit → recorded as the production outcome, never re-fired by the transport retry. None adds a user prompt. |

## Technical Constraints

- `flow-model-bench` stays maintainer-only and off PATH (`bin/lib/sources.ts` `MAINTAINER_ONLY`).
- No change to any value in `DELEGATE_MODEL_DEFAULTS` (interview Q1).
- No headless Claude run of Opus 5.5 (user redirect); the only headless Claude call left is the recall harness's existing Sonnet judge (`docs/eval/review-model-recall/run.ts:404`).
- The host kills a foreground tool call at 10 minutes, and the waiter's own header records a ~600 s ceiling on background calls (`bin/flow-plan-review-wait.ts:8`); no call site may hold a ≥10-minute agy call inside one tool call. The waiter's `--max-sec 540` therefore stays as is — it is a re-armed wake, not the give-up time.
- Cross-vendor holds stay out of the candidate set: plan reviewer #2, survey judge #2 and research fact-check must stay a different family from their Gemini partner (`bin/lib/delegate-models.test.ts:188`).
- Entries with `skipPermissions` must pass no `addDirs`, so the auto-approving agy process reaches no workspace (`bin/flow-research-run.ts:40`); the probe and the bench keep each step's production posture.
- Survey judges stay serial (two concurrent repo-reading agy sessions lost 3/3 reviewers; `bin/flow-blind-survey.ts:414`), so the survey's worst case becomes judge A's new limit + 6 minutes.
- Production time limits today: plan reviewer #1 3m (`bin/flow-plan-review.ts:163`), survey judge A 3m (`bin/flow-blind-survey.ts:69`), research gather and fact-check 3m (`bin/flow-research-run.ts:63`, `research.timeout`), intent guess 5m and Gemini lens 8m (`bin/lib/delegate-timeouts.ts:31`), 9-minute clamp (`bin/lib/delegate-timeouts.ts:37`); unchanged: plan reviewer #2 15m, survey judge B 6m, delegated lenses / scout 8m (`bin/lib/delegate-models.ts:213`).
- **Latency:** a pipeline whose Argon calls run long waits up to each step's new limit instead of 3 minutes — worst case ~+7 minutes per lifted step at a 10-minute limit (the survey's worst case grows from 9 to 16 minutes). At the 20-minute ceiling the sizing rule allows, the worst cases are a ~26-minute method survey, a 20-minute research step, and a ~40-minute deep plan review (35 standard) before the give-up time fires; Stage 0 records which steps actually need more than 10 minutes, and the PR states each step's resulting worst case. Across steps, survey, research and plan review run one after another, so if all three hit the 20-minute ceiling the wait before implementation can reach ~76–86 minutes (~35 at the 10-minute floor); the PR states the measured total. The user accepted slower pipelines.
- **Cost (one-off measurement):** ~26 Argon calls for Stage 0; Stage 1 at most ~146 (a 54-call screen on each step's production arm only — intent guess and lens on the schema arm, plan review and research on free-form — then top-ups only for survivors); Stage 2 48; 18 Argon High lens cells (unconditional) plus 18 Argon Medium cells only if High clears the lens bar; no Opus calls in this PR (the 24-call agy tranche moves to the ticked follow-up); Claude spend ~$1–2 per 18 judged lens cells (the recall harness's Sonnet judge, measured ≈ $1 per 18 cells in `docs/eval/agy-delegation-recall-2026-10.md`, $3 cap per cell). **Ongoing:** no Claude change; an Argon call that used to be cut at 3 minutes can now run longer and spend more Google quota per call (Google publishes no per-call cost).

## Open Questions

- [x] Which Opus 5.5 route is the reference arm? (Changes: a new Claude Code dispatch path and up to $84 of Claude spend vs a ~92h wait.)
  - **Stakes:** both — UX (priority 1): waiting blocks this pipeline ~4 days and the run would re-drain the weekly Claude pool that plan reviewer #2, survey judge #2 and research fact-check depend on; Cost (priority 2): the Claude Code arm spends real dollars.
  - **Recommended:** Claude Code Opus (High) arm now, free-form only, 3 repeats, no warm-up, $2 cap per call (42 calls, $84 ceiling, ~$20–45 expected); an agy Opus re-check after the reset only if a step's verdict turns on scaffold — the agy pool is locked and draining it again silently removes three second-opinion steps from every pipeline [confidence: medium] [anchor: weighing: reversibility — the Claude Code arm costs bounded dollars once, a re-drained weekly pool costs days of missing second reviews]
  - **Resolved (revision 1):** the user excluded the Claude Code arm ("exclude claude code opus 5.5. Part of the goal of this is to offload tokens to agy instead of claude"); replaced by the capped agy tranche below.
- [ ] Interview Q3 says compare against "whatever it runs today" — for five steps that is Argon High itself. What is the second baseline there? (Changes: one extra zero-quota report.)
  - **Stakes:** system — without it the five already-swapped steps get no answer to "did the forced swap regress?" (Product quality, priority 4).
  - **Recommended:** reuse the committed rows of the last measured pins (Gemini 3.1 Pro / 3.7 Flash) and of Sonnet 4.6 (the bench's former reference, all 12 cases, both arms) as the primary comparison, labelled with the agy-version skew; the Opus tranche re-runs research fact-check at its production Medium setting [confidence: high] [anchor: docs/eval/agy-delegation-recall-2026-10.md]
  - **Updated (revision 1):** promoted from the second baseline to the primary one, because the Opus reference now covers only five cases.
- [ ] Does the bench's latency gate decide this run? (Changes: what a "reject" means in the recommendation table.)
  - **Stakes:** system — keeping it would mark Argon "reject" on any step where it is merely not 40% faster than the reference, which is not the question here (Architecture, priority 3).
  - **Recommended:** no — a latency-only reject reads as quality parity; the scorer gains a `--no-latency-gate` switch so the committed verdicts match the pre-registered rule, which gates on recall, defect regressions, reliability and the Stage 0 time-limit verdict instead [confidence: high] [anchor: docs/eval/agy-delegation-recall-2026-10.md]
- [ ] How is the Gemini weekly cap protected? (Changes: dispatch order and whether Stage 2 runs at all.)
  - **Stakes:** user — draining it would make the five Argon-routed steps skip in every pipeline until the weekly reset (UX, priority 1).
  - **Recommended:** screen first: every Stage 1 (step, model) pair at 3 repeats, High across all cases before Medium, no warm-ups; top up only the pairs that survive to their committed repeat tier; Stage 2 (commit message, log triage, gatekeeper, pushback) at 3 repeats only if no quota refusal occurred; at most 60 Argon calls per five-hour window with a live production probe between tranches [confidence: medium] [anchor: weighing: risk — the observed Claude-side lockout lasted ~92h]
- [ ] The production survey judge reads repo files; the bench passes no repo access. How does `c12-blind-survey` supply context? (Changes: fixture shape and what it measures.)
  - **Stakes:** system — a pre-inlined bundle measures reasoning on given context, not the judge's own file selection or its agentic answer time (Product quality, priority 4).
  - **Recommended:** give the fixture a small context directory passed as read access, the way production passes the worktree, and keep the production framing and output contract verbatim; production-realistic answer time comes from Stage 0, not this fixture [confidence: medium] [anchor: adjacent: bin/flow-blind-survey.ts:395]
- [x] The recall check's Opus lens cells from 2026-10-06 were not retained (no data dir in the canonical checkout). Re-run them? (Changes: ~$18 of Claude spend vs no lens measurement.)
  - **Stakes:** both — without it the delegated Claude lenses get no Argon evidence (interview Q4 named them); with it, ~$18 (Cost, priority 2).
  - **Recommended:** re-run the Opus arm once at `--effort high`, same PRs, lenses and runs as the precedent [confidence: high] [anchor: docs/eval/agy-delegation-recall-2026-10.md]
  - **Resolved (revision 1):** dropped — that arm runs Opus through Claude Code, which the user excluded; see the lens-harness question below.
- [ ] Should source comments on each delegate pin change when no value changes? (Changes: one file's comments.)
  - **Stakes:** system — "unbenchmarked on this surface" becomes false once the run lands (truthfulness precondition).
  - **Recommended:** yes — add a dated "MEASURED" line per pin pointing at the evidence doc, same as the 2026-09-05 no-flip comments [confidence: high] [anchor: bin/lib/delegate-models.ts:66]
- [ ] How long is each lifted limit? (Changes: five constants and how long a slow Argon call can hold a pipeline step.)
  - **Stakes:** both — too short repeats the empty answers (Product quality, priority 4); too long makes every pipeline wait longer on a stuck call (UX, priority 1) and spend more quota per call (Cost, priority 2).
  - **Recommended:** the larger of 10 minutes and 3× the Stage 0 median Argon High answer time for that step, rounded up to the minute, capped at 20 minutes; a step that needs more is reported as a limit mismatch, and a step whose Argon High calls are still mostly empty at 20 minutes gets no lift and is reported as "stalls" [confidence: high] [anchor: bin/flow-plan-review.ts:147]
  - **Updated (revision 2):** Stage 0 now sizes a limit per model, so Argon Medium's number is on record too; production limits still come from Argon High (today's model for all five steps). A step that stalls on High but fits on Medium gets a `DECISION:` item at this PR's gate naming the one-line `delegate.models.<surface>` override and Medium's limit — the user decides there, per interview Q1, instead of the step waiting for the later discussion.
- [ ] How do callers wait past the host's 10-minute tool-call limit? (Changes: four skill call sites, discovery's research step and two small helper changes.)
  - **Stakes:** system — without it a 10-minute agy call is killed by its own wrapper and the caller gets no result at all, worse than today's timeout (Architecture, priority 3).
  - **Recommended:** detach-and-wait (Decision C): launch with `flow-spawn --detach`, re-run the bounded waiter until the result is non-empty or the step's give-up time passes — the pattern the plan review already uses [confidence: high] [anchor: skills/pipeline/flow-pipeline/references/step3-threading.md:431]
- [x] Lift the two opt-in review steps too — the intent guess and the Gemini review lens, which run only when `review.gemini` is on (it is off in your config)? (Changes: two defaults, the 9-minute clamp, and two review-skill call sites.)
  - **Stakes:** system — if the routing discussion turns the Gemini review on to move review work off Claude, a 5- or 8-minute limit would cut Argon the same way (Cost, priority 2).
  - **Recommended:** yes — same root cause and same fix; deferrable on its own with `defer task #4` and `defer task #7` if you want a smaller PR [confidence: medium] [anchor: weighing: symmetry — the same Argon model behind a lower limit fails the same way]
  - **Resolved (revision 2):** accepted as-is by the user — Tasks 4 and 7 stay in.
- [ ] Raise the plan-review waiter's `--max-sec 540` with the limits? (Changes: one number in the supervisor skill.)
  - **Stakes:** system — raising it past ~600 s would get the waiter killed by the background-call ceiling instead of waking the supervisor.
  - **Recommended:** no — it is a re-armed wake; the give-up time the supervisor applies is computed from the reviewer limits and grows by itself (15 minutes standard, 30 deep at a 10-minute reviewer #1) [confidence: high] [anchor: bin/flow-plan-review-wait.ts:8]
- [x] How does the Opus 5.5 baseline run, now that Claude Code is excluded? (Changes: whether and when 24 calls hit the Google plan's Claude pool.)
  - **Stakes:** both — bench calls on the agy Claude pool compete with production second opinions (plan reviewer #2, survey judge #2, research fact-check) in the same windows (UX, priority 1); interview Q3 asked for the Opus comparison.
  - **Recommended:** through agy only, after the pool resets (~2026-10-18 evening): the steps whose production model is Opus — plan reviewer #2 (c6), survey judge #2 (c12), research fact-check (c8, at Medium) — plus two anchors (c2b real defect, c7 review lens); 3 repeats, no warm-ups, at most 20 calls per five-hour window (24 calls, two windows); Argon is gated on ground truth and the committed rows, so Opus is a reference column, not a gate [confidence: medium] [anchor: weighing: risk — the 2026-10 recall check emptied the pool after ~23 Opus-High runs in one window]
  - **Resolved (revision 2):** accepted as-is by the user — the agy Opus tranche stays ticked candidate follow-up #2.
- [x] Does this PR wait for the Opus tranche? (Changes: when the time-limit fix reaches your pipelines.)
  - **Stakes:** user — waiting delays the lifted limits by ~2 days; not waiting needs a second pipeline approval later (UX, priority 1).
  - **Recommended:** do not wait (Decision D2) — the PR ships after the Argon run (~2026-10-17) with the Opus column marked "pending follow-up"; the agy Opus tranche runs in the ticked follow-up after the pool resets [confidence: medium] [anchor: weighing: risk — ~2 extra days of 3-minute cuts in every pipeline outweigh one extra approval]
  - **Updated (product critique P1):** flipped from D1 (wait) to D2.
  - **Resolved (revision 2):** accepted as-is by the user (D2).
- [x] Research fact-check (Claude Opus via agy) shares the research time limit with the Argon gather. Lift both? (Changes: whether the fact-check gets its own setting.)
  - **Stakes:** system — a separate key adds a setting nobody asked for; a shared one lets a stuck fact-check hold the research step longer.
  - **Recommended:** lift both through the one existing `research.timeout` setting; the fact-check finished in ~2 minutes on its last live probe, so the higher cap costs nothing unless it stalls [confidence: medium] [anchor: adjacent: bin/flow-research-run.ts:200]
  - **Resolved (revision 2):** accepted as-is by the user; the cross-model review's case for splitting it is answered under R2-4 below.
- [ ] Product critique P2 was overridden because "this PR stays off every runtime path"; it no longer does. Should the Claude-lockout notice ship here? (Changes: three helpers' skip reasons and the plan-summary wording.)
  - **Stakes:** user — during a lockout the three Claude second opinions are skipped and the user may not notice (UX, priority 1).
  - **Recommended:** keep it in the ticked follow-up — it shares no cause with the Argon limits (Claude-pool quota, not Argon latency), the chat summary already lists each skipped reviewer with its skip reason, and the fallback it belongs with needs its own design session [confidence: medium] [anchor: adjacent: skills/pipeline/flow-pipeline/SKILL.md:1024]
- [ ] How are the delegated Claude lenses measured without an Opus arm? (Changes: whether the 18 Argon lens cells run, and against what.)
  - **Stakes:** both — the Claude review lenses are the largest Claude cost a pipeline can move to agy (Cost, priority 2); without an Opus arm the lens result has no head-to-head comparison.
  - **Recommended:** Argon High only, run unconditionally and first in Stage 1 (before any Medium top-up on steps already on Argon); score recall against the harness's reference findings; keep its existing Sonnet judge (~$3); report the Opus comparison as "not measured" [confidence: medium] [anchor: adjacent: docs/eval/review-model-recall/run.ts:404]
  - **Updated (product critique P2):** the c7 gate is dropped — the Claude lenses are the main offload target, so their evidence must not hinge on a different step's screen.
  - **Updated (revision 2):** Argon Medium lens cells (18) follow when Argon High clears the lens bar and no quota refusal has occurred — Medium only matters for the routing question if High is good enough; cells keep their 15-minute cap (so the routing follow-up learns how long Argon needs) and the report adds recall at today's 8-minute delegated-lens limit, counting slower cells as timed out, at zero extra calls. The Sonnet judge stays (R2-6).
- [ ] Which inputs make Stage 0 "production-realistic"? (Changes: the probe's inputs, sample size and quota.)
  - **Stakes:** system — synthetic short prompts would understate answer time and set limits too low (Product quality, priority 4).
  - **Recommended:** this pipeline's own three timed-out calls (its research question, this plan as the review input, its survey brief) committed as probe inputs, plus PR #941's diff for the two review steps; production builders and read access; 3 repeats per step for High and Medium (2 for the opt-in steps), one call at a time, 20-minute cap — ~26 Argon calls, inside the first window [confidence: medium] [anchor: weighing: footprint — reuses real inputs already on hand and the production prompt builders, no new fixture authoring]
- [x] How does this revision handle the partial cross-model review (Argon reviewer #1, cut off at 3 minutes)?
  - **Resolved (revision 1):** R1 schema-arm gate bypass when the baseline lacks an arm — accepted: a missing baseline is now `inconclusive` (Task 9); partly moot, since the Claude Code arm is gone and the committed baseline has both arms. R2 latency gate still in the scorer — accepted (Task 9, `--no-latency-gate`). R3 default-reference naming conflict — moot: the Claude Code arm is gone and the default reference stays the committed Sonnet 4.6 rows. R4 static prompts cannot measure timeout risk — accepted: Stage 0 owns answer time with production prompts and read access (Tasks 1–2); the bench's time section is labelled as fixture time. R5 `--max-calls` + `--resume` deadlock and interleaved models — accepted (Task 10). R6 blinded ids shifting on resume — accepted (Task 10). R7 lens harness burning quota on refusal — accepted (Task 15); the c7 gate first added here was later dropped (product critique P2). R8 tool-denied empty answers counted as model failures — accepted as a separate reported class that still counts against reliability, because it is production behaviour (Task 9). R9 screen at 3 repeats before topping up — accepted (Task 17).
- [x] Do the product-critique items below still hold after the redirect? (Their task numbers refer to the first draft.)
  - **Resolved (revision 1):** P1 still holds — the screen-first Stage 1 replaces the 1-repeat proving pass, with the same 60-call window cap, probe and hard stop (Task 17). P2 revisited above; the notice stays with the ticked follow-up. P3 updated — the duration now includes Stage 0 and the Opus tranche (Plan risks). P4 superseded — the bench now dispatches each case at exactly its production limit (Task 11), so no fixture call runs longer than production would.
- [x] How does revision 2 handle the second partial cross-model review (Argon 4 High reviewer on revision 1, cut off at its 3-minute limit after the failure-modes battery; only written points handled)?
  - **Resolved (revision 2):** each point verified against the code at `6acd8ee`.
    - **R2-1** c11/c12 can never get a verdict (no baseline rows, and Task 9 made a missing baseline `inconclusive`) — accepted, verified (`bin/lib/model-bench-score.ts:466`, no c11/c12 rows in `docs/model-bench/results.json`): Task 9 adds `--ground-truth-floor`; at 0.8 a no-baseline case passes only at recall ≥ 0.8 with no forbidden claim and no vacuous field, reason "ground truth only". Without the flag the R1 behaviour stands. The Medium-vs-High report also compares c11/c12 directly.
    - **R2-2** Stage 0 sizing reads Argon High only — accepted: limits are sized per model (Tasks 1–2); production limits still follow High.
    - **R2-3** lens arm omits Medium and runs at 15 minutes vs production's 8 — accepted in both halves: conditional Medium cells and an 8-minute recall column (Tasks 15, 17; lens question above).
    - **R2-4** shared `research.timeout` inflates the fact-check wait — overridden: gather and fact-check run concurrently in one wave (`bin/flow-research-run.ts:616`), so the step's worst case is the same with or without a split; the user accepted the shared limit in this redirect.
    - **R2-5** a step that stalls on High stays broken under Q1 — partly accepted: no code flip (Q1), but per-model Stage 0 data plus a `DECISION:` item at this PR's gate bring the one-line Medium override to the user at the earliest point (Task 3). This narrows product critique P3's override.
    - **R2-6** keep the headless Sonnet judge despite the offload goal — overridden: the judge must be a different family from the Argon candidates it grades and the same judge as the committed lens results to stay comparable; judging in the supervisor session also spends Claude tokens and grows its context by 18–36 judging passes; the measured judge cost is ≈ $1 per 18 cells (`docs/eval/agy-delegation-recall-2026-10.md`).
    - **R2-7** alternative: progress watchdog plus a ~50-call one-window bench — split: the watchdog is rejected (Alternatives considered). The production-arm-only screen is adopted, cutting the screen from 78 to 54 calls (Task 17). Dropping cases that did not discriminate between the retired models is rejected: that says nothing about Argon, and the ceiling rule (R2-12) now gives those cases adequacy value. The one-window claim does not hold either: Stage 0 + screen + High lens cells is ~98 calls against the 60-call window cap.
    - **R2-8** alternative: race High then Medium inside the helper — rejected: Medium answering a High-routed step is a production routing change (Q1) that blurs which model produced a result, and a 5 + 4-minute race cannot reach the 10-minute floor; Stage 0's per-model data lets the discussion weigh it.
    - **R2-9** alternative: launch research and survey at pipeline start — rejected: both already run before discovery in step 3, after a short triage and worktree step, so little wait would overlap, and it reorders the supervisor's steps — out of scope.
    - **R2-10** waiter hangs on forced research's empty stdout — accepted, verified (`bin/flow-research-run.ts:572` prints only on the ran path; the status file is written on every path): the waiter gains `--pid` (wake on helper exit) and `--complete-line` (replaces `--non-empty`); research waits on its status file, now written atomically (Tasks 5–8).
    - **R2-11** transport retry re-fires quota refusals — not reproduced as stated: quota refusals arrive as `agy-error`, which `isTransportSkip` deliberately never retries (`bin/lib/model-bench-manifest.ts:144`). An adjacent real defect is accepted: `agy-timeout` is retried twice, which at production limits triples a stalling case's quota and wait time and hides the production timeout. Task 10 stops retrying timeouts on production-limit cases and any quota-exhausted entry, and Task 5 carries the delegate's failure class through the fanout.
    - **R2-12** ties at 100% recall read as "test too easy" — accepted, verified (`bin/lib/model-bench-score.ts:356`, `:509`): under `--ground-truth-floor`, a case every model aces counts as "at ceiling" and passes on ground truth; below the floor it stays inconclusive (Task 9).

### Cross-model review (AGY)

Depth: deep. Reviewer 1 Gemini 4 Argon (High): ran, 7/7 lenses. Reviewer 2 Claude Opus 5.5 (High): skipped (agy-error: Claude pool quota). Single-reviewer input, no convergence rule.

- **Stall carve-out leaves a known-broken step at 3 minutes** [accepted] — a step that stalls on High but fits on Medium now gets Medium's limit so the gate's one-line model override works; only a step stalling on both tiers keeps its old limit (Task 3).
- **Discovery research waits 10–20 minutes inside a ~10-minute sub-agent** [overridden] — this session's two discovery sub-agents ran 16.5 and 9.6 minutes to completion, so the documented ceiling is not a hard kill; Task 8 updates that rationale with the evidence. Hoisting all research into the supervisor (the review's alternative 1) would drop discovery's relevance gate; kept as an option for the routing discussion.
- **`--ground-truth-floor` masks a misspelled incumbent** [accepted, narrower] — the cited "typo" does not hold (the committed results do carry `gemini-3.7-flash-high` rows), but the guard is cheap: the floor applies only to cases with no baseline rows, and a zero-row incumbent fails the report (Task 9).
- **Stale watched file satisfies the waiter instantly** [accepted] — `rm -f` before every detached launch (Tasks 6, 8).
- **Recall harness treats a refused agy cell as completed on resume** [accepted] — verified in the harness's completion check (Task 15).
- **Waiter exit-check race with the final rename** [accepted] — re-check the file after the child's exit (Task 5).
- **Split the research limit (cap fact-check at 5 minutes)** [overridden] — you accepted the shared limit at the last review; the two calls run concurrently, so the split only helps when the fact-check alone wedges.
- **Cut Stage 2 outright** [overridden] — those steps run on Claude today, so their Argon evidence serves the offload goal; Stage 2 still runs last and drops on any quota refusal.
- **Cut the retired-model reports** [overridden] — they are the "whatever it runs today" baseline from interview Q3, at zero quota.
- **Unbounded search in the research prompt; cumulative serial latency** [accepted] — Stage 0 adds a 3-call capped-budget gather variant and ships the cap if it wins (Tasks 2, 3); Technical Constraints and Request vetting now state the ~76–86-minute serial worst case.
- **Two-tier adaptive timeout** [overridden] — needs streaming progress that the JSON-envelope helpers do not expose; the capped-budget variant tests the cheaper half of the idea.
<!-- flow-plan-review-hash: e667605e7393b19e16578f2f58b2a305261846bc9a1fe4cd7fc470a658c0f756 -->

### Product critique (blind)

- **P1** [accepted] "At least 10 minutes for every step" conflicted with the stall rule, under which a step that stalls keeps its old limit. Revision: the TLDR, System changes, System flow and Story 2 now carve out a step Stage 0 marks "stalls" and name it in the PR; the limit Test Step drops a stalled step's constant.
- **P2** [accepted] The only route from this evidence to Claude savings, the routing follow-up, was unfiled. Revision: the follow-up is now ticked and files post-merge as "hold the discussion, then apply what it settles", recording no outcome in advance.
- Prior pass (revision 1): P1–P4 reconciled as recorded at that time (D2 ships without the Opus tranche, unconditional Argon High lens cells, stall named-skip override, worst-case delays stated); archived in .flow-tmp/product-critique.prev.md.

## Decision analysis

**Decision A — How does the Opus 5.5 reference run?** Mutually exclusive as the reference design (the Claude Code route is foreclosed by the user).

| Branch                                    | What the user sees, types, waits for                                                                                                                                       | Interruptions       | Cost                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------- |
| A1 Capped agy tranche after the reset     | Nothing to type; the run waits for the Claude pool (~2026-10-18 evening), then 24 Opus calls over two windows on the five cases tied to Opus-run steps or decisive anchors | 0 — fully automated | Google plan's Claude pool, two windows of reduced second-opinion headroom |
| A2 Full agy Opus coverage after the reset | Same wait; ~56+ Opus calls re-drain the pool, so plan reviewer #2 / survey judge #2 / research fact-check go missing again for days                                        | 0                   | Claude pool drained again                                                 |
| A3 No Opus run                            | Nothing; the table has no Opus column, contradicting interview Q3                                                                                                          | 0                   | none                                                                      |

Ranked: A1 > A3 > A2. Verdict: **A1** — honours interview Q3 at a size the pool absorbs, while ground truth and the committed rows carry the gate [confidence: medium] [anchor: weighing: risk — ~23 Opus-High runs emptied the pool in one window on 2026-10-06]

**Decision B — What happens when quota runs out mid-run?** Mutually exclusive.

| Branch                          | Flow                                                                                                                                               | Interruptions                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| B1 halt + exit 3 + `--resume`   | Bench stops, writes results, prints remaining slots and the reset; the implementer schedules `--resume` after the named reset in a background wait | 0 for a five-hour reset; 1 pause note if the reset exceeds 6h |
| B2 sleep in-process until reset | One process runs for hours; a crash or laptop sleep loses the waiting state                                                                        | 0, but fragile                                                |
| B3 keep firing                  | Every remaining slot is refused in ~2 s and recorded as a failure, poisoning reliability scores                                                    | 0, wrong results                                              |

Verdict: **B1** — state lives on disk, so a crash or a multi-window run costs nothing but time [confidence: high] [anchor: bin/lib/agy-cooldown.ts]

**Decision C — How do callers wait for an agy call longer than the host's 10-minute tool-call limit?** Mutually exclusive per call site.

| Branch                                         | What the user sees, types, waits for                                                                                                                                | Interruptions       | Cost                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------- |
| C1 Stay inside one tool call, cap at 9 minutes | Limits rise to 9 minutes at most; the survey's two judges must still share one call, so judge A stays near 3 minutes; misses the ≥10-minute floor                   | 0                   | none                                        |
| C2 Detach-and-wait (recommended)               | Nothing new to type; a slow Argon call finishes instead of being cut; the step takes as long as Argon needs, up to its limit, then reports a named timeout as today | 0 — fully automated | one waiter call per ≤9 minutes of waiting   |
| C3 A start/check spine per helper              | Same as C2                                                                                                                                                          | 0                   | four more stateful spines to build and test |

A background tool call is not a fourth branch: the waiter's header records a ~600 s ceiling on background calls, so it fails the same way as C1. Ranked: C2 > C3 > C1. Verdict: **C2** — the plan review already runs this way in production, and the recipe needs only two waiter flags (complete line, wake on helper exit) and two atomic writes [confidence: high] [anchor: skills/pipeline/flow-pipeline/references/step3-threading.md:431]

**Decision D — Does this PR wait for the Opus tranche?** Mutually exclusive.

| Branch                                                       | What the user sees, types, waits for                                                                          | Interruptions                | Cost                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------- |
| D1 One PR, waits                                             | Approve once; the PR arrives ~2026-10-19 with every column filled; the lifted limits reach pipelines at merge | 0                            | ~2 extra days of 3-minute cuts in other pipelines |
| D2 Ship now, Opus tranche in a second pipeline (recommended) | PR ~2026-10-17 with the Opus column "pending"; a second plan to approve after the reset                       | 1 (the follow-up's approval) | none extra                                        |
| D3 Drop the Opus tranche                                     | PR ~2026-10-17; no Opus column, contradicting interview Q3                                                    | 0                            | none                                              |

Ranked: D2 > D1 > D3. Verdict: **D2** — the lifted limits are the user's visible win and the Opus column is a reference, not a gate, so holding the limits ~2 more days for it costs every pipeline its first reviewer, first judge and research gather in the meantime; one extra approval is the price (product critique P1) [confidence: medium] [anchor: weighing: risk — ~2 days of empty reviews against one follow-up approval]

## Alternatives considered

- **Flip a routing default in this PR, or run the Opus 5.5 reference through Claude Code** — rejected: user-foreclosed — interview Q1 "discuss first", and "exclude claude code opus 5.5"; results land here, model changes ship after the discussion.
- **Judge Argon from live production runs instead of a bench** — rejected: a timed-out delegated call returns only a skip reason and no output (`bin/flow-blind-survey.ts` maps it to `judge-timeout`), so production runs carry no quality signal and no same-input baseline.
- **A time-to-first-output watchdog in place of lifted static limits** — rejected: the research gather spent 163 s searching with no output before its cut, and its gather and fact-check entries return one JSON envelope at the end (`outputFormat: "json"` in `bin/flow-research-run.ts`), so a no-output watchdog would kill the search phase that is the step's work.

## Recommendation

**Reconsider scope** — per the Premise check, the swap already shipped unmeasured, so the work becomes: lift every Argon-routed limit from measured data with a coherent detach-and-wait for the callers, plus retroactive evidence for the five Argon steps scored against ground truth and the committed rows, with a small agy Opus tranche; simplify the bench CLI's stale defaults and its timeout retry, the scorer's silent-pass and hardcoded baseline line, the 9-minute delegate clamp and the Gemini lens retry budget on the way [confidence: high] [anchor: bin/lib/delegate-models.ts:74]

**Redundancy:** `bin/flow-model-bench.ts`, `docs/eval/review-model-recall/` and the plan review's detached worker already provide the measurement and the waiting pattern; this plan extends and reuses them rather than building new ones.

## Plan risks

The weakest assumption is that more time turns Argon's empty answers into answers. If Argon High's research gather stalls without answering at any length (163 s of exploring, no answer), the lift only makes pipelines wait longer and spend more quota for the same empty result. Stage 0 decides this before any limit ships: a step whose Argon High calls are still mostly empty at 20 minutes gets no lift and is reported as "stalls" for the routing discussion. The run itself could also exhaust the Google plan's weekly Gemini cap, making all five Argon steps skip until reset; guards, in order: Stage 0 sized at ~26 calls; the screen-first Stage 1; at most 60 Argon calls per five-hour window with one live production-shaped probe (one intent-guess call) between tranches; and the hard stop at the first quota refusal as the last line.

**Duration:** Stage 0 takes about one window (~1–2 hours of calls). The Argon run then needs about four to five five-hour windows at 60 calls each (~1 day; the production-arm-only screen saves 24 calls). Expect the PR around 2026-10-17, mostly background waiting, with no prompts during the run; the Opus tranche follows in its own pipeline after the Claude pool resets (~2026-10-18 evening, two windows).

## Cut list

- Stage 2 (commit message, log triage, gatekeeper, pushback) — none is wired to agy, so it is evidence-only; run it last at 3 repeats and drop it on any quota refusal.
- The two opt-in review steps (intent guess, Gemini lens) — off in your config today; their lift (Tasks 4 and 7) is cohesive but deferrable without weakening the three steps that actually timed out.

# Candidate follow-up issues

| Candidate                                                           | Value  | Complexity | Rationale                                                                                                                                                                                                                                                                                                                       | Relation to current request                                     | Pull into this pipeline? |
| ------------------------------------------------------------------- | ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------ |
| Fallback for Claude-via-agy steps during a weekly lockout           | High   | Medium     | needs its own design/decision session: the open decision is which route (GPT-OSS on agy, Claude Code, or skip-with-notice) replaces plan reviewer #2, survey judge #2 and research fact-check while the agy Claude pool is locked, without collapsing cross-vendor diversity                                                    | found while measuring; affects the same delegated steps         | No                       |
| Opus 5.5 reference tranche through agy after the Claude pool resets | Medium | Small      | needs its own decision session once results land: the open decision is whether the Opus column is still worth 24 calls on the Claude pool production's second opinions share, after Argon's ground-truth results are in; product critique P1: the lifted limits should not wait ~2 days (pool locked until ~2026-10-18 evening) | completes interview Q3's Opus comparison for this run's results | No                       |
| Apply the routing changes agreed after discussion                   | Medium | Small      | user-foreclosed: "we might change models depending on the results but discuss first"                                                                                                                                                                                                                                            | the direct next step once results are discussed                 | No                       |
| Delegation seams for write-capable phases                           | Medium | Large      | user-foreclosed: "New delegation seams for write-capable phases (coder, fix-applier, discovery, merge-resolver) are OUT of scope and are a follow-up candidate"                                                                                                                                                                 | extends "any flow phase via agy" beyond read-only steps         | No                       |

- [x] Fallback for Claude-via-agy steps during a weekly lockout — the Google plan's weekly Claude pool locks for days and three second-opinion steps silently vanish; design a fallback route, and in the meantime show a plan-summary notice naming each skipped second opinion and why.
  - **UX:** every pipeline during a lockout runs without plan reviewer #2, survey judge #2 and the research fact-check, with no warning in the plan summary [anchor: flow-delegate-fanout refute entry on Claude Opus 5.5 (Medium) → "Individual quota reached … Resets in 92h31m22s"]
  - **Problem:** the three Claude-family second opinions exist for cross-vendor diversity, and the weekly cap removes them for days at a time [anchor: bin/lib/delegate-models.ts:146]
  - **Stability/efficiency:** none
  - **Value rank:** 4 — a user-visible loss of review coverage recurring on the plan's weekly cap [anchor: flow-delegate-fanout refute entry → "Resets in 92h31m22s"]
  - **Complexity:** Medium — three delegate call sites plus the cooldown marker
  - **Risk:** Medium — must not let two same-family reviewers pass as independent
  - **If never done:** second reviews silently disappear for multiple days every time the weekly pool is exhausted
  - **Verdict:** clears bar — a recurring, invisible loss of the diversity check outweighs a Medium change
- [x] Opus 5.5 reference tranche through agy after the Claude pool resets — run the 24-call agy Opus tranche (plan reviewer #2 and survey judge #2 cases on Opus High, research fact-check on Opus Medium, plus the real-defect and review-lens anchors; 3 repeats, ≤20 calls per five-hour window) into the same results directory and fill the routing table's Opus column.
  - **UX:** the routing discussion gets the Opus 5.5 column interview Q3 asked for [anchor: user: "opus 5.5 and whatever it runs today"]
  - **Problem:** this PR ships without the Opus column so the lifted limits are not held ~2 days for the Claude pool reset [anchor: agy refute entry → "Resets in 92h31m22s"]
  - **Stability/efficiency:** none
  - **Value rank:** 3 — completes a comparison the user explicitly asked for, though Argon is gated on ground truth [anchor: user: "opus 5.5 and whatever it runs today"]
  - **Complexity:** Small — the bench already resumes into an existing results directory
  - **Risk:** Medium — the calls draw on the same Claude pool production's second opinions use
  - **If never done:** the routing table keeps an empty Opus column and the user's Q3 comparison is never made
  - **Verdict:** clears bar — an explicit user ask, deferred only for timing
- [x] Apply the routing changes agreed after discussion — after merge, hold the routing discussion over this PR's recommendation table, then change only the per-step defaults it settles, including the delegated lens / scout limits if any of them moves to Argon. Filed now so the discussion is not forgotten; the issue records no outcome in advance.
  - **UX:** whichever steps change get the measured-best model [anchor: user: "we might change models depending on the results but discuss first"]
  - **Problem:** none
  - **Stability/efficiency:** none
  - **Value rank:** 2 — the value depends on an outcome not yet decided [anchor: user: "we might change models depending on the results but discuss first"]
  - **Complexity:** Small — `bin/lib/delegate-models.ts` values plus their pins
  - **Risk:** Low
  - **If never done:** the defaults stay where the forced retirement left them
  - **Verdict:** clears bar — it is the only route from this evidence to the Claude savings the user asked for; filing the discussion, not its outcome, presumes nothing (product critique P2)
- [ ] Delegation seams for write-capable phases — add agy routing for the coder, fix-applier, discovery and merge-resolver.
  - **UX:** none
  - **Problem:** none
  - **Stability/efficiency:** shifts write-capable phases' Claude spend onto Google quota [anchor: user: "New delegation seams for write-capable phases (coder, fix-applier, discovery, merge-resolver) are OUT of scope and are a follow-up candidate"]
  - **Value rank:** 2 — an unmeasured cost opportunity [anchor: user: "New delegation seams for write-capable phases (coder, fix-applier, discovery, merge-resolver) are OUT of scope and are a follow-up candidate"]
  - **Complexity:** Large — four multi-turn, tool-using phases the single-shot bench cannot measure
  - **Risk:** High — write access through an auto-approving agy process
  - **If never done:** those phases keep spending Claude tokens
  - **Verdict:** below bar — this run's quality and quota evidence decides whether it is worth a design session

# Task breakdown

### Task 1: Stage 0 latency probe harness

- **Skill:** `flow-new-feature`
- **Description:** A maintainer-only harness that re-runs production Argon calls under production conditions and records answer time, so the new limits come from data. Each call is built by the step's own production prompt builder with the production read-access / web-search posture, dispatched one at a time through `flow-delegate-fanout` with a 20-minute cap; inputs are committed copies of this pipeline's three timed-out calls (research question, this plan as review input, the survey brief) plus PR #941's diff for the two opt-in review steps. The sizing rule is committed here, before any probe call runs.
- **Inputs:** none
- **Outputs:** `docs/eval/argon-latency-probe/` runnable.
- **Contract:**
  - **Files:** `docs/eval/argon-latency-probe/run.ts` (create), `docs/eval/argon-latency-probe/run.test.ts` (create), `docs/eval/argon-latency-probe/README.md` (create), `docs/eval/argon-latency-probe/inputs/{research-question.md,plan.md,survey-brief.md,pr-941.diff}` (create)
  - **Interfaces:** `export type ProbeSurface = "research-gather" | "plan-review" | "blind-survey" | "intent-guess" | "review-lens"`; `export function buildProbeManifest(opts: { models: string[]; repeats: Record<ProbeSurface, number>; worktree: string; inputsDir: string; timeout: string }): FanoutManifestEntry[]` — gather via `buildManifest` (`bin/flow-research-run.ts`, `skipPermissions`, no `addDirs`), plan review via `buildBatteryPrompt` (`bin/lib/plan-review-prompt.ts`, `addDirs: [worktree]`), survey via `buildSurveyPrompt` (`bin/lib/blind-survey-prompt.ts`, `addDirs: [worktree]`), intent guess and lens via each helper's exported `buildPrompt`; `export type ProbeRecord = { surface: ProbeSurface; model: string; repeat: number; wallSec: number; ran: boolean; empty: boolean; timedOut: boolean; outputBytes: number; deniedActions: string[] }`; `export function toProbeRecord(entry: FanoutManifestEntry, result: FanoutEntryResult): ProbeRecord` (wall time from the pool's `durationMs`); `export type SizedLimit = { limit: string; verdict: "fits" | "limit-mismatch" | "stalls"; medianSec: number }`; `export function sizeLimit(records: ProbeRecord[], model: string): SizedLimit` — over one surface's records for `model`: limit = ⌈max(600, 3 × median wallSec)/60⌉ minutes, capped at 20m (`limit-mismatch` above), `stalls` when ≥ 2/3 of that model's calls are empty; `export function sizeLimits(records: ProbeRecord[]): Record<ProbeSurface, Record<string, SizedLimit>>` (per surface, per model); CLI `bun docs/eval/argon-latency-probe/run.ts --worktree <dir> --out <dir> [--models <csv>] [--timeout 20m]`, writing `<out>/records.json` atomically once at the end and stopping at the first quota refusal
  - **Call-site edits:** none
- **Acceptance criteria:** `npm run test -- docs/eval/argon-latency-probe/run.test.ts`

### Task 2: Run Stage 0 and record the limits

- **Skill:** `flow-verify`
- **Description:** Run the probe on Gemini 4 Argon (High) and (Medium) — 3 repeats for research gather, plan review and survey, 2 for intent guess and lens (~26 calls, the first quota tranche). Launch it with `flow-spawn --detach` and wait with `flow-plan-review-wait <out>/records.json --pid <pid> --max-sec 540`, re-armed, since it can exceed a tool call's 10 minutes. Stop at the first quota refusal. Commit the records and a short table: per step and model, median and slowest answer time, empty rate, timeout rate, and the `sizeLimit` result for each model; list every step that stalls on High but fits on Medium. Also run one capped-budget research-gather variant (the production prompt plus a cap of at most 3 searches and 8 pages before answering) on Argon High, 3 calls; record it beside the uncapped gather (cross-model review, adversarial premise).
- **Inputs:** Task 1
- **Outputs:** `docs/eval/argon-latency-probe-2026-10.json`, `docs/eval/argon-latency-probe-2026-10.md`
- **Contract:**
  - **Files:** the two outputs above (create)
  - **Interfaces:** JSON shape `{ measuredAt: string; records: ProbeRecord[]; limits: Record<ProbeSurface, Record<string, SizedLimit>> }` (inner key = agy model display name)
  - **Call-site edits:** none
- **Acceptance criteria:** `jq -e '([.records[] | select(.model=="Gemini 4 Argon (High)")] | length >= 13) and ([.limits["plan-review","blind-survey","research-gather"] | has("Gemini 4 Argon (High)") and has("Gemini 4 Argon (Medium)")] | all)' docs/eval/argon-latency-probe-2026-10.json`

### Task 3: Lift the three limits that cut Argon at 3 minutes

- **Skill:** `flow-new-feature`
- **Description:** Set plan reviewer #1, survey judge A and the research limit (gather and fact-check share it) to Task 2's Argon High `sizeLimit` values (10 minutes when the measured median is ≤ 200 s; unchanged for a step whose Argon High verdict is "stalls"). For a step that stalls on High but fits on Medium, change no model (interview Q1) and append a `- [ ] DECISION:` item to the PR's Test Steps naming the step, Medium's limit and the one-line `delegate.models.<surface>` override, so the user decides at this PR's gate. Export the constants so the bench can drift-test against them. Rewrite the rationale comments: the survey no longer has to fit one 10-minute tool call (its caller detaches, Task 6), and the plan review's give-up time follows from `maxElapsedSec`. Update the research default everywhere it is restated. A step whose Argon High calls stall but whose Argon Medium calls fit gets Medium's sized limit, so the one-line `delegate.models.<surface>` override offered at the gate works without a second timeout override; only a step that stalls on both tiers keeps its old limit and is named in the PR (cross-model review, goal verdict 1). If the capped-budget gather variant answers where the uncapped one stalls or is ≥ 2× faster at equal recall, ship the cap in the production gather prompt.
- **Inputs:** Task 2
- **Outputs:** lifted limits with their pinned tests.
- **Contract:**
  - **Files:** `bin/flow-plan-review.ts` (edit), `bin/flow-blind-survey.ts` (edit), `bin/flow-research-run.ts` (edit), `bin/lib/config-settings.ts` (edit), `skills/pipeline/flow-product-planning/references/discovery-research.md` (edit: the `read_budget timeout` default and its prose restatements), `docs/configuration.md` (edit: `research.timeout` row), and their pinned tests `bin/flow-plan-review.test.ts`, `bin/flow-blind-survey.test.ts`, `bin/flow-research-run.test.ts`, `bin/flow-research-budget-lint.test.ts`, `bin/lib/config-default-parity.test.ts` (edit)
  - **Interfaces:** `export const REVIEWER_1_TIMEOUT: string` (from `"3m"`), `export const JUDGE_A_TIMEOUT: string` (from `"3m"`), `export const DEFAULT_TIMEOUT: string` in `bin/flow-research-run.ts` (from `"3m"`), `research.timeout` built-in default = the same value; tests assert against the exported constants, not literals
  - **Call-site edits:** none (callers read the constants); `maxElapsedSec` unchanged
- **Acceptance criteria:** `npm run test -- bin/flow-plan-review.test.ts bin/flow-blind-survey.test.ts bin/flow-research-run.test.ts bin/flow-research-budget-lint.test.ts bin/lib/config-default-parity.test.ts && bun -e 'import {REVIEWER_1_TIMEOUT as a} from "./bin/flow-plan-review.ts"; import {JUDGE_A_TIMEOUT as b} from "./bin/flow-blind-survey.ts"; import {DEFAULT_TIMEOUT as c} from "./bin/flow-research-run.ts"; import {godurToSec as s} from "./bin/lib/delegate-timeouts.ts"; process.exit([a,b,c].every(v=>s(v)>=600)?0:1)'`

### Task 4: Lift the two opt-in review steps and retire the 9-minute clamp

- **Skill:** `flow-new-feature`
- **Description:** Set the intent guess and Gemini lens defaults to Task 2's values; replace the 9-minute sync ceiling with a 20-minute sanity bound whose warning no longer cites a 10-minute tool call; fix the lens's diff-only retry at 2 minutes instead of deriving it from the old ceiling. Update the configuration doc's "Delegate timeouts" section.
- **Inputs:** Task 2
- **Outputs:** both opt-in steps at the lifted limits.
- **Contract:**
  - **Files:** `bin/lib/delegate-timeouts.ts` (edit), `bin/lib/delegate-timeouts.test.ts` (edit), `bin/flow-gemini-lens.ts` (edit), `bin/flow-gemini-lens.test.ts` (edit), `bin/flow-gemini-intent-guess.test.ts` (edit), `docs/configuration.md` (edit: "Delegate timeouts" table and the "9-minute sync ceiling" paragraph)
  - **Interfaces:** `DELEGATE_TIMEOUT_DEFAULTS = { reviewLens: <Task 2 limit, ≥ "10m">, intentGuess: <Task 2 limit, ≥ "10m"> }`; `export const DELEGATE_TIMEOUT_CEILING = "20m"` replacing `SYNC_DELEGATE_CEILING`; `resolveDelegateTimeout` / `clampDelegateTimeout` clamp to it; lens `retryTimeoutArg = "2m"`
  - **Call-site edits:** `bin/flow-gemini-lens.ts` and `bin/flow-gemini-intent-guess.ts` import the renamed ceiling where they used the old one
- **Acceptance criteria:** `npm run test -- bin/lib/delegate-timeouts.test.ts bin/flow-gemini-lens.test.ts bin/flow-gemini-intent-guess.test.ts`

### Task 5: Detach-and-wait building blocks

- **Skill:** `flow-new-feature`
- **Bundled:** the fanout's non-atomic result write and dropped failure class, and the research helper's non-atomic status write — prerequisites for waiting on them from another process (cross-model review R2-10, R2-11).
- **Description:** Give the bounded file waiter a complete-line mode (a detached helper's stdout file exists from launch but stays empty until it prints its one-line result) and a `--pid` wake (a helper that exits without printing, or crashes, ends the wait at once); make `flow-delegate-fanout` write `--out` through a temp file and rename, and copy each delegate envelope's `failureClass` into its entry; make `flow-research-run`'s status file a temp-file-and-rename write. The waiter must re-check the watched file after detecting the child's exit, before reporting an empty result (closes the race between the final atomic rename and the exit check).
- **Inputs:** none
- **Outputs:** the pieces the call sites' recipe and the bench's quota halt need.
- **Contract:**
  - **Files:** `bin/flow-plan-review-wait.ts` (edit), `bin/flow-plan-review-wait.test.ts` (edit), `bin/flow-delegate-fanout.ts` (edit), `bin/flow-delegate-fanout.test.ts` (edit), `bin/flow-research-run.ts` (edit: `writeStatus`), `bin/flow-research-run.test.ts` (edit)
  - **Interfaces:** `WaitArgs.completeLine: boolean` from `--complete-line`, `WaitArgs.pid?: number` from `--pid <n>`; done when `exists(p) && (!completeLine || (statSize(p) > 0 && lastByte(p) === "\n"))`, or when `pid` is set and `process.kill(pid, 0)` throws `ESRCH`; `--max-sec` default 540 unchanged; fanout persists via `${outPath}.tmp` + `renameSync`; `EntryResult.failureClass?: AgyFailureClass` copied from the envelope; `writeStatus` writes `${path}.tmp` then renames
  - **Call-site edits:** header comment of `flow-plan-review-wait` names its second caller (the long-delegate-call recipe); the fanout's record builder copies `envelope.failureClass`
- **Acceptance criteria:** `npm run test -- bin/flow-plan-review-wait.test.ts bin/flow-delegate-fanout.test.ts bin/flow-research-run.test.ts`

### Task 6: Supervisor call sites wait through a detached run (survey, forced research)

- **Skill:** `flow-new-feature`
- **Description:** Replace the survey's single 10-minute tool call and the forced research call (which names no tool time limit at all today) with the recipe: record a start time; launch with `PID=$(flow-spawn --detach --stdout <envelope> --stderr <log> -- …)`; run `flow-plan-review-wait <watched> --complete-line --pid "$PID" --max-sec 540` (tool timeout 600000) until it returns with the file complete or the helper gone, re-arming until the give-up time passes (survey: judge A + judge B + 5 minutes; research: limit + 5 minutes). The survey watches its stdout envelope; forced research watches its `--status-file`, because its stdout stays empty on every skip path. On give-up, kill the recorded process group and print the existing skip line with reason `survey-timeout` / `research-timeout`; when the helper exited with an empty envelope, take the existing skip path; otherwise branch on the envelope / status file exactly as today. Add a table-driven doc lint covering these two sites. Each call site removes the watched file (`rm -f`) before `flow-spawn --detach`, so a stale file from an earlier pass never satisfies the waiter instantly.
- **Inputs:** Tasks 3, 5
- **Outputs:** the two step-3 call sites no longer bounded by one tool call.
- **Contract:**
  - **Files:** `skills/pipeline/flow-pipeline/references/blind-survey.md` (edit), `skills/pipeline/flow-pipeline/SKILL.md` (edit), `skills/pipeline/flow-pipeline/references/step3-threading.md` (edit), `bin/long-delegate-calls-lint.test.ts` (create)
  - **Interfaces:** docs/prose — at `blind-survey.md` "Run this as a Bash tool call with `timeout: 600000`" replace the paragraph with the recipe; at `SKILL.md` "Blind method survey" paragraph replace "as a Bash call with `timeout: 600000`" with a pointer to it; at `step3-threading.md` the `flow-research-run` bash block gains the launch/wait lines; lint table `SITES: Array<{ file: string; helper: string }>` asserting each file contains `flow-spawn --detach` near `<helper>`, `--complete-line` and `--pid`, and no longer contains the "sum to 9 minutes" wording
  - **Call-site edits:** none beyond the docs
- **Acceptance criteria:** `npm run test -- bin/long-delegate-calls-lint.test.ts`

### Task 7: Review call sites wait through a detached run (Gemini lens, intent guess)

- **Skill:** `flow-new-feature`
- **Description:** In `/flow-pr-review` Step 3, launch both opt-in helpers detached before the Task lens fan-out message, and wait for both envelopes (same recipe; give-up = lens limit + 2-minute retry + 5 minutes, intent limit + 5 minutes) before Step 3.5 consolidation. Replace the "MUST pass an explicit `timeout: 600000` … clamped to a 9m sync ceiling" prose.
- **Inputs:** Tasks 4, 5, 6
- **Outputs:** the two review call sites no longer bounded by one tool call.
- **Contract:**
  - **Files:** `skills/pipeline/flow-pr-review/SKILL.md` (edit), `skills/pipeline/flow-pr-review/references/intent-mismatch-resolution.md` (edit), `bin/long-delegate-calls-lint.test.ts` (edit: two more `SITES` rows)
  - **Interfaces:** docs/prose — insertion anchors: "**Run the lens** via the PATH helper" step and "The Bash tool call MUST pass an explicit `timeout: 600000`" paragraph
  - **Call-site edits:** none beyond the docs
- **Acceptance criteria:** `npm run test -- bin/long-delegate-calls-lint.test.ts`

### Task 8: Discovery's inline research waits through a detached fan-out

- **Skill:** `flow-new-feature`
- **Description:** Discovery's Step 1.5 (on for every pipeline in your config) runs the fan-out in one tool call and budgets "~10 minutes synchronous". Switch it to launching the fan-out detached and re-running the waiter on its `--out` file with `--pid` of the launched fan-out, so a crashed fan-out ends the wait at once (a sub-agent gets no wake-up notifications, so it waits in the foreground, ≤9 minutes per call); rewrite the runtime-ceiling paragraph as "one wave × the research limit, waited in ≤9-minute steps". Update the `/flow-research` skill's description of that budget. Delete the fan-out's `--out` before launch, as in Task 6. Update the discovery-research doc's "~10-minute sub-agent wall-clock" rationale with this session's evidence: two discovery sub-agents ran 16.5 and 9.6 minutes to completion.
- **Inputs:** Tasks 3, 5, 6
- **Outputs:** discovery research survives a ≥10-minute research limit.
- **Contract:**
  - **Files:** `skills/pipeline/flow-product-planning/references/discovery-research.md` (edit: (c) step 2 run line and "_Runtime-ceiling rationale._" paragraph), `skills/universal/flow-research/SKILL.md` (edit: the "tightened budget … 3-minute per-entry" sentence), `bin/long-delegate-calls-lint.test.ts` (edit: one more `SITES` row)
  - **Interfaces:** docs/prose — anchors named above
  - **Call-site edits:** none beyond the docs
- **Acceptance criteria:** `npm run test -- bin/long-delegate-calls-lint.test.ts bin/flow-research-budget-lint.test.ts bin/flow-research-skill-lint.test.ts`

### Task 9: Bench roster, failure classes, and a scorer that cannot silently clear

- **Skill:** `flow-new-feature`
- **Bundled:** the scorer's hardcoded "claude-sonnet-4-6" Limitations line, plus five cross-model review findings (missing-baseline pass-through, latency gate, tool-denied empty answers, never-gradable no-baseline fixtures R2-1, ties at 100% recall R2-12).
- **Description:** Point the bench at today's agy roster; record each failed slot's failure class and denied actions; keep quota and rate-limit refusals out of the reliability gate; report tool-denied empty answers as their own class (still counted, since they are production behaviour); return `inconclusive` instead of skipping a case/arm the incumbent has no rows on; add `--ground-truth-floor <recall>`, under which a no-baseline case ("ground truth only") or a non-discriminating case ("at ceiling") passes on recall ≥ floor, no forbidden claim and no vacuous field, and fails the parity gate below it; add `--no-latency-gate`; merge another results file's rows for the incumbent at report time; make the Limitations text name the actual baseline. `--ground-truth-floor` applies only to cases with no rows for any model in `--baseline-results` (today c11, c12); the report fails with a named error when `--incumbent` has zero rows across the whole loaded dataset, so a misspelled incumbent can never clear a candidate on ground truth alone.
- **Inputs:** Task 5 (fanout entries carry `failureClass`)
- **Outputs:** a bench that defaults to Argon High + Medium and a scorer whose verdicts match the pre-registered rule.
- **Contract:**
  - **Files:** `bin/flow-model-bench.ts` (edit), `bin/lib/model-bench-schema.ts` (edit), `bin/lib/model-bench-score.ts` (edit), `bin/flow-model-bench.test.ts` (edit), `bin/lib/model-bench-score.test.ts` (edit)
  - **Interfaces:** `DEFAULT_MODELS = ["gemini-4-argon-high", "gemini-4-argon-medium"]`; `DEFAULT_INCUMBENT` stays `"claude-sonnet-4-6"` (served from committed rows); `BenchResult.failureClass?: AgyFailureClass | "tool-denied-empty"`; `BenchResult.resetsIn?: string`; `BenchResult.deniedActions?: string[]`; `evaluateCandidate(caseScores, incumbent, candidate, opts: { latencyGate: boolean; groundTruthFloor?: number })`; `verdict(scores, opts)` gains the same two options; report flags `--no-latency-gate`, `--ground-truth-floor <0..1>`, `--baseline-results <path>`; `sectionLimitations(scores, incumbent)`
  - **Call-site edits:** `runBench` result mapping takes `e.failureClass ?? classifyAgyFailure({skipReason, stderrTail, agyError, agyStatus})` on every `ran:false` envelope; the reliability gate excludes `quota-exhausted` / `rate-limited` attempts from `totalAttempts`; both `if (!inc || !cand) continue` sites return `inconclusive` when only `inc` is missing; `runReport` merges `--baseline-results` rows and passes `meta.incumbent`
- **Acceptance criteria:** `npm run test -- bin/flow-model-bench.test.ts bin/lib/model-bench-score.test.ts bin/lib/model-bench-schema.test.ts`

### Task 10: Finish a run across quota windows

- **Skill:** `flow-new-feature`
- **Bundled:** three cross-model review findings — the `--max-calls` + `--resume` deadlock with model-interleaved ordering, blinded ids shifting on resume, and the transport retry re-firing slots that should stand (R2-11).
- **Description:** Dispatch in chunks, write results after every chunk, stop after the first quota refusal and exit 3 with the remaining-slot count and reset; never re-fire a quota-exhausted slot, end the retry round as soon as one appears, and never re-fire an `agy-timeout` on a case that carries a `productionTimeout` (that timeout is the production outcome the timeout-fit section counts); `--resume` dispatches only slots with no successful row, selecting pending slots before applying `--max-calls`; order the manifest model-major (every case for the first model before the second); append fresh rows after prior rows so earlier blinded ids never move; build the blinded packet once, from the final merged file; `--no-warmup` skips warm-up slots.
- **Inputs:** Task 9
- **Outputs:** crash-safe, resumable bench runs.
- **Contract:**
  - **Files:** `bin/lib/model-bench-resume.ts` (create), `bin/lib/model-bench-resume.test.ts` (create), `bin/lib/model-bench-manifest.ts` (edit: model-major order, warm-up skip), `bin/flow-model-bench.ts` (edit)
  - **Interfaces:** `export function slotKey(e: {caseId; arm; model; repeat; warmup; size?}): string`; `export function pendingSlots(manifest: ManifestEntry[], prior: BenchResult[]): ManifestEntry[]`; `export function mergeResults(prior: BenchResult[], fresh: BenchResult[]): BenchResult[]` (prior rows kept in place, fresh successes appended, a fresh success supersedes a same-key prior failure without moving earlier rows); `export function quotaHalt(chunk: BenchResult[]): { halted: boolean; resetsIn?: string }`; `buildManifest(cases, models, repeatsOverride?, opts?: { warmup: boolean })`; flags `--resume` (a missing results file reads as no prior rows, so per-arm-group invocations can share one file), `--chunk-size <n>` (default 16), `--no-warmup`; exit 3 = halted with pending slots
  - **Call-site edits:** `runBench` applies `pendingSlots` then `resolveMaxCalls`, replaces its single `dispatchWithRetries` call with a chunk loop writing `results.json` after each chunk; `dispatchWithRetries`'s retry predicate becomes `export function shouldRetry(e: EntryResult, entry: FanoutManifestEntry & { productionTimeout?: string }): boolean` — `isTransportSkip(e.skipReason)`, minus `failureClass` `quota-exhausted`, minus `agy-timeout` when `entry.productionTimeout` is set
- **Acceptance criteria:** `npm run test -- bin/lib/model-bench-resume.test.ts bin/flow-model-bench.test.ts`

### Task 11: Fixtures carry the production posture and the lifted limits

- **Skill:** `flow-new-feature`
- **Bundled:** research fact-check fixture moves to the web-search permission posture production adopted on 2026-09-10.
- **Description:** Add optional `skipPermissions`, `addDir` and `productionTimeout` case fields; pass them through to the fanout entry; dispatch each case at exactly its `productionTimeout` (production-identical cut) instead of a flat 15 minutes; set the values from the exported constants and drift-test them.
- **Inputs:** Tasks 3, 4, 9
- **Outputs:** fixtures that carry their real deployment limits and posture.
- **Contract:**
  - **Files:** `bin/lib/model-bench-schema.ts` (edit), `bin/lib/model-bench-manifest.ts` (edit), `bin/fixtures/model-bench/{c1-multifile-contract,c2-planted-defects,c2b-real-defect,c4-intent-json,c6-plan-review,c7-review-lens,c8-research-refute}/case.json` (edit), `bin/flow-model-bench.test.ts` (edit: drift test)
  - **Interfaces:** `BenchCase.skipPermissions?: boolean`; `BenchCase.addDir?: string` (fixture-relative; a validation error alongside `skipPermissions`); `BenchCase.productionTimeout?: string` validated with `isGoDuration`; values: c1/c2/c2b = `DELEGATED_SCOUT_TIMEOUT`, c4 = `DELEGATE_TIMEOUT_DEFAULTS.intentGuess`, c6 = `REVIEWER_1_TIMEOUT`, c7 = `DELEGATE_TIMEOUT_DEFAULTS.reviewLens`, c8 = research `DEFAULT_TIMEOUT` + `skipPermissions: true`
  - **Call-site edits:** `toFanoutEntries` sets `entry.timeout = c.productionTimeout ?? "15m"`, `entry.skipPermissions` from the case, `entry.addDirs = [resolve(caseDir, c.addDir)]` when set, and never `addDirs` on a `skipPermissions` entry
- **Acceptance criteria:** `npm run test -- bin/lib/model-bench-schema.test.ts bin/flow-model-bench.test.ts`

### Task 12: Production time-limit fit section

- **Skill:** `flow-testing`
- **Description:** Render a `## Production timeout fit` section: per (step, model), attempts that timed out at the production limit and the share whose model time exceeded it, labelled "single-shot fixture time — production-realistic answer times are in the Stage 0 probe".
- **Inputs:** Task 11
- **Outputs:** the report states which steps fit their lifted limits on fixtures.
- **Contract:**
  - **Files:** `bin/lib/model-bench-score.ts` (edit), `bin/lib/model-bench-report.ts` (edit), `bin/lib/model-bench-score.test.ts` (edit), `bin/flow-model-bench.test.ts` (edit)
  - **Interfaces:** `export function timeoutFit(results: BenchResult[], cases: BenchCase[]): Array<{ surface: string; model: string; limit: string; overLimit: number; timedOut: number; attempts: number }>`; `renderReport` meta gains `timeoutFit`
  - **Call-site edits:** `runReport` computes `timeoutFit` from the loaded cases and passes it to `renderReport`
- **Acceptance criteria:** `npm run test -- bin/lib/model-bench-score.test.ts bin/flow-model-bench.test.ts`

### Task 13: Research-gather fixture

- **Skill:** `flow-new-feature`
- **Description:** Add `research-gather` to the step list and a `c11-research-gather` case: the production gather prompt with a fixed, stable spec question (CSV quoting/escaping and line terminators per RFC 4180), `skipPermissions: true`, the research limit, 5 repeats, truth = required facts (anyOf) + a cited authoritative URL + a per-claim confidence label; a forbidden backslash-escaping claim.
- **Inputs:** Task 11
- **Outputs:** the first measurement of research gathering.
- **Contract:**
  - **Files:** `bin/lib/model-bench-schema.ts` (edit: `BenchSurface` + `BENCH_SURFACES` gain `"research-gather"`), `bin/fixtures/model-bench/c11-research-gather/{case.json,prompt.md,truth.json}` (create), `bin/flow-model-bench.test.ts` (edit: drift test that `prompt.md` contains the gather prompt `buildManifest` in `bin/flow-research-run.ts` emits for the fixture task)
  - **Interfaces:** case `{ "id": "c11-research-gather", "surface": "research-gather", "kind": "free-text", "skipPermissions": true, "productionTimeout": <research DEFAULT_TIMEOUT>, "repeats": 5, "routable": true }`
  - **Call-site edits:** none
- **Acceptance criteria:** `npm run test -- bin/flow-model-bench.test.ts bin/lib/model-bench-schema.test.ts`

### Task 14: Method-survey judge fixture

- **Skill:** `flow-new-feature`
- **Description:** Add `blind-survey` and a `c12-blind-survey` case: the production prompt built by `buildSurveyPrompt` over a goal-only brief drawn from a settled flow decision (forced research made reliable by moving it into deterministic supervisor-called helpers instead of stronger prompt wording), with a small `context/` directory passed as read access in place of the repository; truth = the four headings, a required "deterministic / code-enforced step" method (anyOf), and a forbidden "strengthen the prompt" method.
- **Inputs:** Task 11
- **Outputs:** the first measurement of the survey judge.
- **Contract:**
  - **Files:** `bin/lib/model-bench-schema.ts` (edit: `"blind-survey"`), `bin/fixtures/model-bench/c12-blind-survey/{case.json,prompt.md,truth.json,context/}` (create), `bin/flow-model-bench.test.ts` (edit: drift test that `prompt.md` contains `BLIND_FRAMING` and each output heading from `bin/lib/blind-survey-prompt.ts`)
  - **Interfaces:** case `{ "id": "c12-blind-survey", "surface": "blind-survey", "kind": "free-text", "addDir": "context", "productionTimeout": <JUDGE_A_TIMEOUT>, "repeats": 5, "routable": true }`
  - **Call-site edits:** none
- **Acceptance criteria:** `npm run test -- bin/flow-model-bench.test.ts bin/lib/model-bench-schema.test.ts`

### Task 15: Argon arms on the lens recall harness

- **Skill:** `flow-testing`
- **Bundled:** cross-model review findings — the harness counts quota refusals as unusable cells and keeps firing after one; and its 15-minute cells overstate recall at the production 8-minute lens limit (R2-3).
- **Description:** Add Argon High and Medium agy arms; classify each failed agy cell, keep quota refusals out of `unusable_attempts`, stop launching cells after the first quota refusal, and default agy concurrency to 2. Keep the 15-minute cell cap and add a production-limit view to the arm aggregate: recall with every cell slower than `DELEGATED_LENS_TIMEOUT` counted as zero, reported beside full-length recall. `isCompletedCellOutput` returns false for a delegate envelope with `ran: false`, and a quota-halted cell writes no final output file, so resume re-runs refused cells instead of skipping them.
- **Inputs:** none
- **Outputs:** `--arms agy-argon-high` runnable without poisoning its own first-attempt rule, with recall at both lengths.
- **Contract:**
  - **Files:** `docs/eval/review-model-recall/run.ts` (edit), `docs/eval/review-model-recall/run.test.ts` (edit), `docs/eval/review-model-recall/score-arms.ts` (edit), `docs/eval/review-model-recall/score.test.ts` (edit), `docs/eval/review-model-recall/README.md` (edit)
  - **Interfaces:** `AGY_ARMS` gains `"agy-argon-high": "Gemini 4 Argon (High)"` and `"agy-argon-medium": "Gemini 4 Argon (Medium)"`; `runAgyMatrixCell` returns `{ quotaHalt: boolean }`; `AGY_DEFAULT_CONCURRENCY = 2`; `aggregateArms(cells: CellStat[], opts?: { productionLimitMs?: number })` adds `recall_at_production_limit` per arm (cells with `duration > productionLimitMs` count as recall 0)
  - **Call-site edits:** the matrix pool stops dequeuing agy cells once any cell reports `quotaHalt`; `score.ts aggregate` passes `productionLimitMs` = `godurToSec(DELEGATED_LENS_TIMEOUT) * 1000`
- **Acceptance criteria:** `npm run test -- docs/eval/review-model-recall/run.test.ts docs/eval/review-model-recall/score.test.ts`

### Task 16: Pre-register the decision rule (commit before any bench dispatch)

- **Skill:** `flow-new-feature`
- **Description:** Write the routing rule before any bench measurement, in the shape of the 2026-10 recall check: arms, repeat tiers, the screen-then-top-up staging and its elimination rule (a (step, model) pair with recall 0 on every screen repeat, a c2b real-defect miss on all three, or ≥ 2 of 3 empty is dropped), stop conditions, baselines, and the per-step outcome — **keep Argon High** (recall ≥ the committed reference − 0.05 on every backing case, no defect regression, ≥ 80% non-empty, Stage 0 verdict "fits"); **consider Argon Medium** (same gates; presumed cheaper per call, which Google does not publish); **consider Claude** (High fails a quality gate; subject to cross-vendor holds and Claude-pool capacity); **limit mismatch** / **stalls** (from Stage 0; a step that stalls on High and fits on Medium is raised as a `DECISION:` at this PR's gate); **insufficient evidence** (reliability < 80%). A case with no baseline rows (c11, c12) or one every model aces is gated on fixture ground truth instead (`--ground-truth-floor 0.8`: recall ≥ 0.8, no forbidden claim, no vacuous field), and labelled "ground truth only" / "at ceiling" in the table. The screen runs each step's production arm only (schema for intent guess and lens, free-form for plan review and research). Argon Medium lens cells run only if Argon High clears the lens bar (recall ≥ the committed reference − 0.05) with no quota refusal; lens recall is reported at full length and at the 8-minute production limit. The Opus tranche is a reference column: it can move a "keep" to "discuss" only when Argon trails Opus by more than 0.05 on an Opus-run step's case. A latency-only gap never rejects. Structural holds are reported, never re-routed.
- **Inputs:** Tasks 1–15 merged into the branch
- **Outputs:** `docs/eval/argon-4-routing-2026-10.md` with `## Pre-registered rule` (results sections empty).
- **Contract:**
  - **Files:** `docs/eval/argon-4-routing-2026-10.md` (create)
  - **Interfaces:** insertion anchors `## Pre-registered rule`, `## Time limits (Stage 0)`, `## Results`, `## Recommendations (for discussion)`
  - **Call-site edits:** none
- **Acceptance criteria:** `grep -q '^## Pre-registered rule' docs/eval/argon-4-routing-2026-10.md && git log -1 --format=%H -- docs/eval/argon-4-routing-2026-10.md`

### Task 17: Run the measurement

- **Skill:** `flow-verify`
- **Description:** Stage 1 screen: the wired cases (c1, c2, c2b, c4, c6, c7, c8, c11, c12) at 3 repeats on each step's production arm only (c4/c7 `--arms schema`, c6/c8 `--arms free-form`, the rest single-arm — 54 calls instead of 78), Argon High then Medium, `--no-warmup`, in tranches of at most 60 Argon calls per five-hour window (`--max-calls 60 --resume`) with one live production-shaped intent-guess probe between tranches that stops the run if refused; top up surviving pairs to their committed repeat tiers; Stage 2 (c3, c5, c9a, c9b, c10) at 3 repeats only if no quota refusal occurred. Run the lens harness on Argon High in the first tranche, before any Medium top-up; run its Argon Medium cells in a later tranche only if High clears the lens bar and no quota refusal occurred. No Opus calls in this PR (the agy tranche is the ticked follow-up). Launch each long bench call detached and wait with the re-armed waiter (`--pid`). On exit 3, wait for the named reset and `--resume`. Blind-judge the new c1 entries once, from the final merged file (key unread until verdicts are written). Render three reports with `--no-latency-gate --ground-truth-floor 0.8`: vs the committed reference (`--baseline-results docs/model-bench/results.json --incumbent claude-sonnet-4-6`), Medium vs High, and vs the retired pins (`--incumbent gemini-3.1-pro-high`, then `gemini-3.7-flash-high`).
- **Inputs:** Task 16 committed
- **Outputs:** `docs/model-bench/argon-4-2026-10/` (`results.json`, `judge-packet.json`, `judge-key.json`, `judged.json`, `report.md`, `verdicts.json`, `vs-medium/`, `vs-retired/`), `docs/eval/argon-4-routing-2026-10.json`
- **Contract:**
  - **Files:** the outputs above (create)
  - **Interfaces:** commands — `bun bin/flow-model-bench.ts --models gemini-4-argon-high,gemini-4-argon-medium --cases <case group> [--arms schema|free-form] --repeats 3 --no-warmup --max-calls 60 --resume --out docs/model-bench/argon-4-2026-10`, one invocation per arm group (`c4,c7` schema; `c6,c8` free-form; `c1,c2,c2b,c11,c12`), all resuming into the same results file
  - **Call-site edits:** none
- **Acceptance criteria:** `jq -e '[.[] | select(.model=="gemini-4-argon-high" and .ran)] | length >= 30' docs/model-bench/argon-4-2026-10/results.json && test -f docs/model-bench/argon-4-2026-10/verdicts.json`

### Task 18: Results, recommendations, and truthful pin comments

- **Skill:** `flow-new-feature`
- **Description:** Fill `## Time limits (Stage 0)`, `## Results` and `## Recommendations (for discussion)` — one row per step: today's model, its new limit and the Stage 0 verdict, Argon High / Medium recall vs the committed reference and the retired pins, the Opus column marked "pending follow-up", reliability, the rule's outcome, quota observed per window, and a one-line recommendation; flag the Claude-pool lockout. Add a dated `MEASURED (2026-10-xx, docs/eval/argon-4-routing-2026-10.md): <outcome>` comment line to every pin in `bin/lib/delegate-models.ts`; values unchanged.
- **Inputs:** Task 17
- **Outputs:** the discussion document.
- **Contract:**
  - **Files:** `docs/eval/argon-4-routing-2026-10.md` (edit), `bin/lib/delegate-models.ts` (edit, comments only)
  - **Interfaces:** none — docs/prose: insertion anchors `## Time limits (Stage 0)`, `## Results`, `## Recommendations (for discussion)`, and one comment line directly above each `DELEGATE_MODEL_DEFAULTS` key
  - **Call-site edits:** none
- **Acceptance criteria:** `npm run test -- bin/lib/delegate-models.test.ts && grep -c 'MEASURED (2026-10' bin/lib/delegate-models.ts | grep -qx 10`

| Task | Depends on |
| ---- | ---------- |
| 1    | —          |
| 2    | 1          |
| 3    | 2          |
| 4    | 2          |
| 5    | —          |
| 6    | 3, 5       |
| 7    | 4, 5, 6    |
| 8    | 3, 5, 6    |
| 9    | 5          |
| 10   | 9          |
| 11   | 3, 4, 9    |
| 12   | 11         |
| 13   | 11         |
| 14   | 11         |
| 15   | —          |
| 16   | 1–15       |
| 17   | 16         |
| 18   | 17         |

| Skill            | Recommended?                        | Reason                                                                                             |
| ---------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| flow-new-feature | Yes (Tasks 1, 3–11, 13, 14, 16, 18) | probe harness, limit changes, call-site recipe, bench code, fixtures and evidence docs             |
| flow-testing     | Yes (Tasks 12, 15)                  | scorer section + drift tests; harness arm and quota tests                                          |
| flow-verify      | Yes (Tasks 2, 17)                   | long-running maintainer runs with detach, resume and checks                                        |
| flow-research    | No                                  | the bench's research fixture and the probe measure the gather step; no research report is produced |
| flow-deliberate  | No                                  | the decision rule and the sizing rule are pre-registered, not judged per case                      |

# PR description draft

## TLDR

Argon-routed flow steps get at least 10 minutes (sized from measured Argon times) instead of being cut at 3, plus per-step Argon High/Medium evidence for the routing discussion. Any step the probe marks as stalling (no answer even at 20 minutes) keeps its old limit and is named here.

## User-facing changes

- Before → After: plan reviewer #1, the first method-survey judge and the research gather were cut at 3 minutes (this pipeline lost all three) → each gets at least 10 minutes, sized from measured Argon answer times, so a slow answer arrives instead of a "timed out" line.
- Before → After: the intent guess (5 minutes) and the Gemini review (8 minutes) → at least 10 minutes when `review.gemini` is on; `delegate.timeouts.*` now accepts up to 20 minutes instead of being clamped at 9.
- Changed behaviour: the method survey, forced research, discovery's research step and the two Gemini review steps run detached and are waited on in short steps, so a long call is never killed by the 10-minute tool limit; a call that exceeds its own limit still ends in the same named timeout, and a step that skips early (for example forced research when agy is down) moves on at once instead of waiting out its limit.
- Pipelines can take longer when Argon is slow: up to ~7 extra minutes per affected step at a 10-minute limit (the method survey's worst case grows from 9 to 16 minutes); at the 20-minute ceiling, a ~26-minute survey and a ~40-minute deep plan review in the worst case. The table below states each step's actual limit.
- New document: a per-step Argon 4 routing table (today's model, new time limit, Argon High / Medium quality against the last measured models or, for research gathering and the survey judge, against the fixture's ground truth; Argon High on the Claude review lenses, plus Medium if High holds up, at full length and at today's 8-minute lens limit; reliability; recommendation; the Opus 5.5 column follows in a later PR) ready for the routing discussion.
- New document: measured Argon High and Medium answer times on production prompts for the five Argon steps, with the time limit each model would need.
- Before → After: the model bench's default roster (three models agy no longer offers, so every slot failed) → Gemini 4 Argon High + Medium, compared against the committed results of the last measured models.
- New flags on the model bench: `--resume` finishes a run that stopped at a quota limit; `--no-warmup` skips warm-up calls; `--no-latency-gate`, `--ground-truth-floor` and `--baseline-results` shape the report.
- Changed behaviour: the model bench stops at the first quota refusal, exits 3, and prints how many slots remain and when quota resets, instead of recording refusals as model failures; a case that times out at its real time limit is recorded once instead of being re-run twice.
- New report section: "Production timeout fit" shows, per step and model, how many fixture runs hit that step's real time limit.
- Research gathering and the method-survey judge are measured for the first time (two new fixtures).
- The review-lens recall harness gains Gemini 4 Argon High and Medium arms and stops at the first quota refusal.

## System changes

- Before → After: five Argon-routed limits of 3–8 minutes behind a 9-minute clamp → every one at least 10 minutes (20-minute ceiling), set from a production-realistic probe, except any step the probe marks as stalling, which keeps its old limit and is named.
- Before → After: four helpers ran inside one host tool call bounded at 10 minutes → they launch detached through the process registry and are waited on in ≤9-minute steps, the pattern the plan review already used; the plan review's own give-up time grows with its reviewer limit (15 minutes standard, 30 deep).
- Before → After: the bench dispatched every case at 15 minutes and wrote results once at the end → each case runs at its step's production limit and results are written after every chunk.
- Ongoing cost: no Claude change. An Argon call that used to be cut at 3 minutes can now run to its new limit and spend more Google AI Ultra quota per call (Google publishes no per-call cost).
- One-off cost of this PR's measurement: roughly 250 Argon calls on Google AI Ultra quota (the screen runs each step's production format only), no Opus calls, and about $1–4 of Claude spend for the recall harness's existing judge.

## Why

Five Google-plan steps were moved to Gemini 4 Argon High on 2026-10-13 only because agy retired the models they used, with no measurement behind the move. Live runs then showed Argon High cut at the 3-minute limit on three of them — research, the first plan reviewer and the first survey judge — returning nothing or a half-written review, while several of those steps could not be given more time because they were held inside a 10-minute tool call. Without evidence there is no basis for deciding which steps should use Argon High, Argon Medium, or Claude, and moving more work off Claude depends on that answer.

## Key decisions

- **Limits come from data:** each lifted limit is the larger of 10 minutes and 3× the median Argon High answer time on production prompts (20-minute ceiling); a step that still returns nothing at 20 minutes gets no lift and is reported as stalling.
- **Detach-and-wait, not a longer tool call:** the host ends a tool call at 10 minutes and background calls at about the same point, so callers launch the helper detached and wait in short re-armed steps; the waiter's 9-minute wake stays as is.
- **No Opus through Claude Code:** per the user, the Opus 5.5 reference runs only through agy, in a 24-call tranche after the Google plan's Claude pool resets, filed as a follow-up; Argon is gated on fixture ground truth and the committed results of the last measured models, so the Opus column is a reference, not a gate.
- **Ship without waiting for the Opus tranche:** the lifted limits reach pipelines about two days sooner; the Opus reference column needs one follow-up approval.
- **Decision rule written before measuring:** gates are quality, defect regressions, reliability and the measured time-limit verdict; the bench's latency gate is switched off for this run.
- **Screen first:** every step and model runs at 3 repeats, on the output format production uses, before any top-up, to protect the weekly Gemini cap production depends on.
- **Ground truth where no baseline exists:** research gathering and the survey judge were never measured before, and some cases every model aces; those are judged against the fixture's known answers (80% floor) instead of being written off as inconclusive.
- **A step that stalls on Argon High but finishes on Medium** keeps its model; it is raised as a decision at this PR's gate with the one-line override, rather than waiting for the later discussion.
- **No routing changes:** per the user, results are discussed before any model moves; source comments on each step's model gain a dated evidence pointer only.
- **Out of scope:** delegation for write-capable phases, the supervisor, and the delegated Claude lens / scout limits (they run Claude, not Argon).
- Bundled: the bench report's Limitations line hardcoded the retired Sonnet 4.6 as the baseline on every run.
- Bundled: the research fact-check fixture now uses the web-search permission posture production adopted in September.
- Bundled: the fanout's result write is now atomic, so a waiter never reads half a file.
- Bundled: findings from this plan's two partial cross-model reviews — a missing baseline no longer passes silently, the latency gate is switchable, resumed runs no longer stall or renumber blinded results, the recall harness stops at the first quota refusal, a skipped helper no longer holds its waiter, and a production-limit timeout is no longer retried.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `npm run test -- docs/eval/argon-latency-probe/run.test.ts` — the probe builds production prompts and sizes limits by the stated rule.
- [ ] Run `jq -e '([.records[] | select(.model=="Gemini 4 Argon (High)")] | length >= 13) and ([.limits["plan-review","blind-survey","research-gather"] | has("Gemini 4 Argon (High)") and has("Gemini 4 Argon (Medium)")] | all)' docs/eval/argon-latency-probe-2026-10.json` — Stage 0 sized all three timed-out steps for both models.
- [ ] Run `bun -e 'import {REVIEWER_1_TIMEOUT as a} from "./bin/flow-plan-review.ts"; import {JUDGE_A_TIMEOUT as b} from "./bin/flow-blind-survey.ts"; import {DEFAULT_TIMEOUT as c} from "./bin/flow-research-run.ts"; import {DELEGATE_TIMEOUT_DEFAULTS as d, godurToSec as s} from "./bin/lib/delegate-timeouts.ts"; process.exit([a,b,c,d.intentGuess,d.reviewLens].every(v=>s(v)>=600)?0:1)'` — every Argon-routed limit is at least 10 minutes; if Stage 0 marked a step "stalls", drop that step's constant from this check (the PR's TLDR names it).
- [ ] Run `npm run test -- bin/flow-plan-review.test.ts bin/flow-blind-survey.test.ts bin/flow-research-run.test.ts bin/flow-research-budget-lint.test.ts bin/lib/config-default-parity.test.ts bin/lib/delegate-timeouts.test.ts bin/flow-gemini-lens.test.ts bin/flow-gemini-intent-guess.test.ts` — lifted limits, derived give-up time and the 20-minute ceiling hold.
- [ ] Run `npm run test -- bin/flow-plan-review-wait.test.ts bin/flow-delegate-fanout.test.ts bin/long-delegate-calls-lint.test.ts` — the waiter's complete-line and exit-wake modes, the atomic result write, and all five call sites using detach-and-wait.
- [ ] Run `npm run test -- bin/flow-model-bench.test.ts bin/lib/model-bench-score.test.ts bin/lib/model-bench-schema.test.ts bin/lib/model-bench-resume.test.ts` — roster, quota halt, resume without deadlock or renumbering, no silent clears, time-limit fit and fixture drift specs all pass.
- [ ] Run `npm run test -- docs/eval/review-model-recall/run.test.ts docs/eval/review-model-recall/score.test.ts` — the Argon lens arms resolve, stop at the first quota refusal, and report recall at the 8-minute production limit.
- [ ] Run `bun -e 'import {DELEGATE_MODEL_DEFAULTS as d} from "./bin/lib/delegate-models.ts"; console.log(JSON.stringify(d))' | jq -e '.intentGuess=="Gemini 4 Argon (High)" and .reviewLens=="Gemini 4 Argon (High)" and .researchGather=="Gemini 4 Argon (High)" and .planReview=="Gemini 4 Argon (High)" and .blindSurvey=="Gemini 4 Argon (High)" and .researchRefute=="Claude Opus 5.5 (Medium)" and .planReviewSecond=="Claude Opus 5.5 (High)" and .blindSurveySecond=="Claude Opus 5.5 (High)" and .scout==null and .claudeLenses==null'` — no routing default changed.
- [ ] Run `jq -e '[.[] | select(.model=="gemini-4-argon-high" and .ran)] | length >= 30' docs/model-bench/argon-4-2026-10/results.json` — the Argon High arm completed its screen.
- [ ] Run `bun bin/flow-model-bench.ts --report --out docs/model-bench/argon-4-2026-10 --judged docs/model-bench/argon-4-2026-10/judged.json --baseline-results docs/model-bench/results.json --incumbent claude-sonnet-4-6 --no-latency-gate --ground-truth-floor 0.8 && git diff --exit-code docs/model-bench/argon-4-2026-10/verdicts.json` — the committed verdicts re-render byte-identically.
- [ ] Run `R=$(git log --diff-filter=A --format=%H -- docs/eval/argon-4-routing-2026-10.md | tail -1); X=$(git log --diff-filter=A --format=%H -- docs/model-bench/argon-4-2026-10/results.json | tail -1); [ "$R" != "$X" ] && git merge-base --is-ancestor "$R" "$X"` — the decision rule was committed strictly before the results.
- [ ] DECISION: you accept merging the lifted time limits and the evidence with every routing default unchanged, taking each step's recommendation to the follow-up discussion.
