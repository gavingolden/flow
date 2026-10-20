# Gemini 4 Argon: time limits and routing evidence for every agy-delegated step

Evidence for a discussion, not a routing change. This PR changes no value in
`DELEGATE_MODEL_DEFAULTS` (`bin/lib/delegate-models.ts`): any model change
ships after the maintainer has read this record. Harnesses:
[`argon-latency-probe/`](argon-latency-probe/) (Stage 0, time limits),
`bin/flow-model-bench.ts` with its fixtures (quality per step),
[`review-model-recall/`](review-model-recall/) (the delegated Claude lenses).

The swap itself already shipped: on 2026-10-13 agy retired Gemini 3.1 Pro and
3.7 Flash, and the five Google-plan steps below moved to `Gemini 4 Argon (High)`
with no measurement. What was missing is evidence.

## Pre-registered rule

Written and committed before any routing measurement, so the verdicts cannot be
fitted to the numbers. The commit that adds this section is an ancestor of the
commit that adds `## Results`.

### Arms and baselines

|            | Values                                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidates | Argon High (`gemini-4-argon-high`, agy `Gemini 4 Argon (High)`) and Argon Medium (`gemini-4-argon-medium`, agy `Gemini 4 Argon (Medium)`). Argon Low and Gemini 3.8 Flash are out of scope.                                                 |
| Baselines  | The fixture's own ground truth, plus the committed rows in `docs/model-bench/results.json` (12 cases): `claude-sonnet-4-6` (the committed reference) and the retired pins `gemini-3.1-pro-high` and `gemini-3.7-flash-high`, at zero quota. |
| Opus 5.5   | A reference column only, run through agy after the Google plan's Claude pool resets. Pending follow-up: no Opus call is made in this PR, and none runs through Claude Code.                                                                 |
| Name join  | Bench rows use the slug (`gemini-4-argon-high`); the latency probe and the harnesses use the agy display name (`Gemini 4 Argon (High)`). The two name the same model.                                                                       |

### Steps and their backing measures

| Step (`delegate.models.<surface>`)       | Backing case or measure                         | Screen arm         |
| ---------------------------------------- | ----------------------------------------------- | ------------------ |
| Plan reviewer #1 (`planReview`)          | `c6-plan-review`                                | free-form          |
| Method-survey judge A (`blindSurvey`)    | `c12-blind-survey`                              | single (free text) |
| Research gather (`researchGather`)       | `c11-research-gather`                           | single (free text) |
| PR intent guess (`intentGuess`)          | `c4-intent-json`                                | schema             |
| Gemini review lens (`reviewLens`)        | `c7-review-lens`                                | schema             |
| Scout (`scout`, not Argon today)         | `c1`, `c2`, `c2b`                               | single             |
| Research fact-check (`researchRefute`)   | `c8-research-refute`                            | free-form          |
| Delegated Claude lenses (`claudeLenses`) | the lens recall harness (`review-model-recall`) | agy arms           |

The lens recall harness measures the delegated **Claude** lens (`claudeLenses`,
run through `flow-agy-lenses`), so its production-limit column is the
8-minute `DELEGATED_LENS_TIMEOUT` of that surface. The recommendation for the
Gemini review lens (`reviewLens`) comes from bench case c7, never from the
harness.

### Stages, repeats and elimination

- **Stage 0 (time limits).** The latency probe runs each step's production call
  on both Argon tiers: 3 repeats for research gather, plan review and survey, 2
  for intent guess and lens (about 26 calls), plus 3 capped-budget gather calls
  on High. Each limit is sized by the rule in the probe's README (at least 10
  minutes, 3 x the median answer time, a 20-minute cap).
- **Stage 1 screen.** The wired cases (c1, c2, c2b, c4, c6, c7, c8, c11, c12) at 3
  repeats on each step's production arm only (54 calls), Argon High first, then
  Medium, with `--no-warmup`.
- **Top-up.** A surviving (step, model) pair is topped up to the committed repeat
  tier of its cases (c1, c2, c2b, c4, c6, c8: 10; c7: 3; c11, c12: 5).
- **Elimination.** A (step, model) pair is dropped after the screen when its recall
  is 0 on every screen repeat, when it misses the c2b real defect on all three
  repeats, or when at least 2 of its 3 attempts are empty.
- **Stage 2.** c3, c5, c9a, c9b and c10 at 3 repeats, only if no quota refusal
  occurred.
- **Lens harness.** Argon High cells run in the first tranche, before any Medium
  top-up. Argon Medium lens cells run only if Argon High clears the lens bar
  (recall at least the committed reference minus 0.05) with no quota refusal.
  Lens recall is reported at full length and at the 8-minute production limit.

### Stop conditions

1. Stop at the first quota refusal (the bench exits 3 and names the reset;
   `--resume` finishes later). A quota refusal is never a model failure and never
   re-fired.
2. At most 60 Argon calls per five-hour window (`--max-calls 60 --resume`).
3. One live, production-shaped intent-guess probe runs between tranches; if it is
   refused, the run stops.

### Per-step outcomes

Each step gets exactly one outcome, from the first row whose gate it meets, read
top to bottom for each candidate tier.

| Outcome                   | Gate                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **keep Argon High**       | Recall at least the committed reference minus 0.05 on every backing case, no defect regression, at least 80% non-empty attempts, and Stage 0 verdict `fits`.                                |
| **consider Argon Medium** | The same gates, on Argon Medium. Presumed cheaper per call; Google publishes no per-call figure, so cost is not claimed.                                                                    |
| **consider Claude**       | Argon High fails a quality gate. Subject to the cross-vendor holds below and to Claude-pool capacity.                                                                                       |
| **limit mismatch**        | Stage 0 says the step would need more than the 20-minute cap. Reported; the step keeps its limit.                                                                                           |
| **stalls**                | Stage 0 says at least two thirds of the model's calls came back empty. A step that stalls on High and fits on Medium is raised as a `DECISION:` item at this PR's gate, never flipped here. |
| **insufficient evidence** | Reliability below 80% non-empty attempts (quota and rate-limit refusals are excluded from that denominator).                                                                                |

### Ground truth, ties and holds

- A case with no baseline rows for any model in the baseline set (c11 and c12), or
  one every model aces, is gated on fixture ground truth with
  `--ground-truth-floor 0.8`: recall at least 0.8, no forbidden claim, no vacuous
  field. Below that it fails the parity gate. These cases are labelled
  "ground truth only" / "at ceiling" in the table.
- Reports run with `--no-latency-gate`: bench latency is single-shot fixture time,
  so **latency never rejects a candidate**; answer times come from Stage 0.
- Opus is a reference column: it can move a "keep" to "discuss" only when Argon
  trails Opus by more than 0.05 on an Opus-run step's case.
- **Structural holds are reported, never re-routed.** Plan reviewer #2, survey
  judge #2 and the research fact-check must stay a different model family from
  their Gemini partner (`bin/lib/delegate-models.test.ts`), so they are not
  candidates for Argon whatever the recall says.
- No routing default changes in this PR. Where the rule says "consider", the
  outcome is a recommendation for discussion.

### Reports

Three reports, each with `--no-latency-gate --ground-truth-floor 0.8`: against the
committed reference (`--baseline-results docs/model-bench/results.json --incumbent
claude-sonnet-4-6`), Medium against High, and against the retired pins
(`--incumbent gemini-3.1-pro-high`, then `gemini-3.7-flash-high`). A misspelled
`--incumbent` fails with a named error instead of clearing a candidate on ground
truth alone.

## Time limits (Stage 0)

Sized from 29 timed calls on 2026-10-19; every step runs on `Gemini 4 Argon
(High)` today, except the research fact-check, which is Claude. Method, medians
and the capped-search variant are in
[`argon-latency-probe-2026-10.md`](argon-latency-probe-2026-10.md). No step
stalls on High, so no step is raised as a `DECISION:` item.

| Step                                                                   | Model today                                       | Old limit | New limit | Argon High                                              | Argon Medium | Evidence                                |
| ---------------------------------------------------------------------- | ------------------------------------------------- | --------- | --------- | ------------------------------------------------------- | ------------ | --------------------------------------- |
| Research gather and fact-check (`researchGather`; the limit is shared) | Argon High (gather), Claude Opus 5.5 (fact-check) | 3m        | 20m       | limit-mismatch (3x median over the cap, shipped at 20m) | fits         | [probe](argon-latency-probe-2026-10.md) |
| Plan reviewer #1 (`planReview`)                                        | Argon High                                        | 3m        | 13m       | fits                                                    | fits (10m)   | [probe](argon-latency-probe-2026-10.md) |
| Method-survey judge A (`blindSurvey`)                                  | Argon High                                        | 3m        | 10m       | fits                                                    | fits         | [probe](argon-latency-probe-2026-10.md) |
| PR intent guess (`intentGuess`)                                        | Argon High                                        | 5m        | 10m       | fits                                                    | fits         | [probe](argon-latency-probe-2026-10.md) |
| Gemini review lens (`reviewLens`)                                      | Argon High                                        | 8m        | 10m       | fits                                                    | fits         | [probe](argon-latency-probe-2026-10.md) |

## Results

Measured 2026-10-19 to 2026-10-20 on agy 1.4.2. Screen: 3 repeats per (case,
model) on each step's production arm, no warm-up
([`../model-bench/argon-4-2026-10/`](../model-bench/argon-4-2026-10/): results,
three reports and their verdicts). Recall is the mean over the screen repeats;
"ref" is the committed `claude-sonnet-4-6` row in
`docs/model-bench/results.json`, and the retired pins are the committed
`gemini-3.1-pro-high` / `gemini-3.7-flash-high` rows. Reliability is non-empty
attempts over attempts. Verdicts stand on n=3 (see the Amendment below), so a
difference under about 0.1 is within run-to-run noise.

### Bench steps

| Step                                   | Model today              | Limit (Stage 0 High / Medium) | Case                  | Argon High         | Argon Medium       | Ref (Sonnet 4.6)   | 3.1 Pro / 3.7 Flash          | Opus 5.5          | Reliability (High / Medium) |
| -------------------------------------- | ------------------------ | ----------------------------- | --------------------- | ------------------ | ------------------ | ------------------ | ---------------------------- | ----------------- | --------------------------- |
| Plan reviewer #1 (`planReview`)        | Argon High               | 13m (fits / fits)             | c6, at ceiling        | 1.00               | 1.00               | 1.00               | 0.98 / 1.00                  | pending follow-up | 3/3 / 3/3                   |
| Method-survey judge A (`blindSurvey`)  | Argon High               | 10m (fits / fits)             | c12, ground truth     | 1.00               | 1.00               | none               | none                         | pending follow-up | 3/3 / 3/3                   |
| Research gather (`researchGather`)     | Argon High               | 20m (limit-mismatch / fits)   | c11, ground truth     | 0.93               | 0.93               | none               | none                         | pending follow-up | 3/3 / 3/3                   |
| PR intent guess (`intentGuess`)        | Argon High               | 10m (fits / fits)             | c4 schema, at ceiling | 1.00               | 1.00               | 1.00               | 0.92 / 1.00                  | pending follow-up | 3/3 / 3/3                   |
| Gemini review lens (`reviewLens`)      | Argon High               | 10m (fits / fits)             | c7 schema             | 1.00               | 1.00               | 0.83               | 0.75 / 0.00                  | pending follow-up | 3/3 / 3/3                   |
| Research fact-check (`researchRefute`) | Claude Opus 5.5 (Medium) | 20m (shared, not timed)       | c8 free-form          | 0.87               | 1.00               | 1.00               | 1.00 / 1.00                  | pending follow-up | 3/3 / 3/3                   |
| Scout (`scout`)                        | Claude (in-session)      | 8m (not probed)               | c1 / c2 / c2b         | 1.00 / 1.00 / 0.44 | 1.00 / 0.96 / 0.17 | 0.72 / 0.63 / 0.09 | 0.97 / 0.89 / 0.11 (3.1 Pro) | pending follow-up | c2b: 1/3 / 2/3              |

- **Scout.** Both tiers miss a c2b real defect that Sonnet 4.6 caught (a
  defect regression), and the c2b runs mostly did not finish inside the
  scout's 8-minute limit: Argon High timed out on 2 of 3, Medium on 1 of 3. On
  the planted-defect cases (c1, c2) both tiers score above every committed
  model.
- **Research fact-check on Argon High** scored 0.87 against the reference's
  1.00, below the 0.95 bar. Argon Medium scored 1.00.
- **Ceilings.** c4 and c6 are aced by every model in the run and c11/c12 have no
  baseline rows, so those four steps are gated on fixture ground truth
  (`--ground-truth-floor 0.8`). They show Argon is not worse; they cannot show
  it is better.

### Delegated Claude review lenses (`claudeLenses`)

Recall harness ([`review-model-recall/`](review-model-recall/)): three lenses
re-run over the diffs of PRs #812, #756 and #802 and scored by a blinded judge
against each PR's reference findings. The Opus column is the committed
Claude Task-tool reference in
[`review-model-recall.json`](review-model-recall.json) (2 runs per cell).
"At 8m" counts only findings from cells that finished inside the 8-minute
delegated-lens limit (`DELEGATED_LENS_TIMEOUT`).

| Lens                | Opus (Task, reference) | Argon High (18 cells) | Argon Medium (9 cells) |
| ------------------- | ---------------------- | --------------------- | ---------------------- |
| bug-detection       | 0.048                  | 0.057                 | 0.076                  |
| pattern-consistency | 0.060                  | 0.066                 | 0.075                  |
| test-coverage       | 0.060                  | 0.082                 | 0.092                  |
| All lenses          | —                      | 0.068                 | 0.081                  |
| All lenses, at 8m   | —                      | 0.050                 | 0.081                  |
| Median cell time    | —                      | 347 s                 | 249 s                  |

Both tiers clear the lens bar (at least the reference minus 0.05) on every
lens, at full length and at the 8-minute limit. Argon High loses about a
quarter of its recall at the limit because some cells run past 8 minutes;
every Argon Medium cell finished inside it. Absolute recall is low for every
model, Opus included: the reference sets are large, and a single run finds a
small share of them.

### Quota

About 112 Argon calls in total: 29 in Stage 0, 54 in the screen, 1 live
intent-guess probe between tranches, and 28 lens cells (18 High, 9 Medium, and
1 Medium cell re-run after the machine restarted mid-run). No window exceeded
60 calls; the last one used about 57. No call was refused for quota at any
point.

**Claude-pool lockout.** Before this run the Google plan's Claude pool was
locked out until the evening of 2026-10-18. While it is locked, every
Claude-pinned agy step skips: the research fact-check, plan reviewer #2 and
method-survey judge B. That is why no Opus 5.5 column ran here (ticked
follow-up: a fallback for that lockout).

## Recommendations (for discussion)

Outcomes follow the pre-registered rule, read top to bottom for each tier. No
value changes in this PR.

| Step                                     | Outcome                        | Recommendation                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan reviewer #1 (`planReview`)          | keep Argon High                | Keep. Medium also clears and answers in half the time (130 s vs 256 s median); worth a switch only if quota gets tight.                                                                                 |
| Method-survey judge A (`blindSurvey`)    | keep Argon High                | Keep. Medium also clears.                                                                                                                                                                               |
| Research gather (`researchGather`)       | consider Argon Medium          | Discuss moving to Medium: same recall (0.93). High's answers finish in time (slowest 9 minutes), but 3x its median answer time is over the 20-minute cap (limit mismatch); Medium fits the sizing rule. |
| PR intent guess (`intentGuess`)          | keep Argon High                | Keep. The case is at ceiling, so Medium (also 1.00) is a quota option, not a quality one.                                                                                                               |
| Gemini review lens (`reviewLens`)        | keep Argon High                | Keep. Both tiers beat every committed model on c7 (1.00 vs 0.83 reference).                                                                                                                             |
| Research fact-check (`researchRefute`)   | structural hold (Claude)       | No change: it must stay a different family from the Gemini gather. Argon High would have failed anyway (0.87).                                                                                          |
| Plan reviewer #2, survey judge B         | structural hold (Claude)       | No change, same cross-vendor rule. Opus via agy is the pending follow-up.                                                                                                                               |
| Scout (`scout`)                          | consider Claude (stays Claude) | No change. Argon misses the real defect and does not finish inside 8 minutes.                                                                                                                           |
| Delegated Claude lenses (`claudeLenses`) | both tiers clear the lens bar  | Discuss routing to Argon Medium: highest recall here and every cell inside the 8-minute limit, at no Claude cost. Confidence is low (9 cells, n=1 per PR): rerun before switching.                      |

## Amendment (2026-10-20, user-directed, after the screen)

Made after the screen results were in, on the maintainer's instruction to trim
the measurement. The pre-registered rule above is unchanged.

- **No top-up.** No (step, model) pair was topped up past the 3-repeat screen,
  so every verdict above stands on n=3 rather than the committed repeat tiers.
- **Stage 2 cut.** c3, c5, c9a, c9b and c10 were not run; the commit-message,
  log-triage, critique and gatekeeper rows of the bench reports are
  "inconclusive: no rows" for that reason.
- **Argon Medium lens cells at 1 run per (lens, PR)**: 9 cells, not 18.
- **Time limits unchanged after the screen.** Every new limit is already at
  least 2.2 times the slowest measured answer on either tier: research 20m vs
  9.0 minutes, plan review 13m vs 5.1, review lens 10m vs 2.9, survey 10m vs
  1.7, intent guess 10m vs 0.6.
