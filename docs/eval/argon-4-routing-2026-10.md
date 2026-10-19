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

_Filled after Stage 0 runs._

## Results

_Filled after the measurement runs._

## Recommendations (for discussion)

_Filled after the results are in._
