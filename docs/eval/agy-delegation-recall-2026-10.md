# Review-lens and scout recall: agy Opus 5.5 vs the Claude Task agents

Raw numbers: [`agy-delegation-recall-2026-10.json`](agy-delegation-recall-2026-10.json).
Harness: [`review-model-recall/`](review-model-recall/) (agy arm added for this
measurement) and `bin/flow-model-bench.ts` (scout).

A one-off measurement, not a committed eval suite. It answers one question per
surface: _can this lens (or the scout) run on Google AI Ultra quota through agy
without losing findings the Claude Task agent catches today?_ Its verdicts set
`DEFAULT_DELEGATED_LENSES`, `DELEGATE_MODEL_DEFAULTS.claudeLenses` and
`DELEGATE_MODEL_DEFAULTS.scout` in `bin/lib/delegate-models.ts`, and
`bin/lib/delegate-models.test.ts` pins those constants to this record.

## Pre-registered rule

Written and committed before any cell ran, so the verdicts cannot be fitted to
the numbers.

### Lenses

|               |                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Lenses        | `bug-detection`, `pattern-consistency`, `test-coverage` (the only lenses with enough reference findings; see `review-model-recall.md`) |
| Arms          | `opus` (Claude Code, the `opus` alias, `--effort high`) and `agy-opus-5-5-high` (agy `Claude Opus 5.5 (High)`)                         |
| Agy prompt    | the harness prompt plus the production `agyLensOutputContract` (`bin/lib/lens-prompt.ts`), full-depth read rules                       |
| PRs           | flow #812, #756, #802 — the same set and reference findings as the 2026-09-09 and 2026-10-04 studies                                   |
| Runs per cell | 2 (3 lenses × 3 PRs × 2 arms × 2 = 36 review runs, 36 judge runs)                                                                      |
| Judge         | the harness's blinded Sonnet judge, unchanged                                                                                          |

A lens gets verdict **`delegate`** only if all four hold; otherwise **`keep Task`**:

1. agy mean recall ≥ opus mean recall − the pooled within-arm sd;
2. the one-sided exact permutation p for "opus exceeds agy" is ≥ 0.05;
3. all six agy cells were schema-valid on the first attempt (no retried cell);
4. agy raised ≥ 0.5× the opus arm's candidate findings (total across the six cells).

`DEFAULT_DELEGATED_LENSES` is the set of `delegate` lenses.
`DELEGATE_MODEL_DEFAULTS.claudeLenses` becomes `"Claude Opus 5.5 (High)"` if at
least one lens clears, else stays `null`. Security, performance, supply-chain
and product are not measured and stay opt-in (`delegate.lenses`). On Fable
sessions bug-detection stays on Claude regardless (`fable-session-keeps-task`;
see `fable-vs-opus-subagents.md`).

### Scout

|           |                                                                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bench     | `bin/flow-model-bench.ts`, cases `c1-multifile-contract`, `c2-planted-defects`, `c2b-real-defect`                                                                            |
| Candidate | `claude-opus-5-5-high` (agy)                                                                                                                                                 |
| Incumbent | the committed 2026-09-05 `claude-sonnet-4-6` rows in `docs/model-bench/results.json` (no longer offered by agy; the fixtures are static, so the stored rows stay comparable) |

Verdict **`delegate`** only if both hold; otherwise **`keep Task`**:

1. no defect regression: the c2b real defect is caught in at least the incumbent's share of repeats;
2. mechanical recall ≥ incumbent − 0.05 on each case.

The latency gate is ignored: the point is quota, not speed.
`DELEGATE_MODEL_DEFAULTS.scout` becomes `"Claude Opus 5.5 (High)"` only on
`delegate`.

**Unmeasured cost:** a delegated scout reads the scout's saved per-repo notes
but never adds to them. The bench uses fixed cases with no history, so it cannot
measure this loss.

## Results

Pending — filled in after the runs.
