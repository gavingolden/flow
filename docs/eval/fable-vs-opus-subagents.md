# Bug-detection recall: Fable vs Opus (issue #890)

Raw numbers: [`fable-vs-opus-subagents.json`](fable-vs-opus-subagents.json).
Harness: [`review-model-recall/`](review-model-recall/).

A one-off measurement, not a committed eval suite. It answers one question:
_does the Opus cap bug-detection already runs under on Fable sessions (#830)
lose findings Fable would have caught?_ Whatever the answer, the lens cap is
left unchanged — a Fable advantage is reported with its numbers, not acted on.

## Pre-registered rule

Written before any cell ran, so the verdict cannot be fitted to the numbers.

|               |                                                                                      |
| ------------- | ------------------------------------------------------------------------------------ |
| Lens          | `bug-detection` only                                                                 |
| Arms          | `fable` (Fable 5.1), `opus` (the `opus` alias, Opus 5.5) — both at `effort: medium`  |
| PRs           | flow #812, #756, #802 — the same set and reference findings as the 2026-09-09 study  |
| Runs per cell | 2 (2 arms × 3 PRs × 2 = 12 review runs, 12 judge runs)                               |
| Budget        | ~$20–25 total; per-cell caps Fable $20, Opus $14                                     |
| Model check   | every review envelope's resolved model id is `claude-fable-5-1` or `claude-opus-5-5` |

Verdict, applied to mean recall per arm:

- **`Fable materially better`** — Fable's mean recall exceeds Opus's by more
  than the pooled within-arm spread **and** the one-sided exact permutation
  test gives _p_ < 0.05.
- **`cap validated`** — Opus's mean recall is at or above Fable's minus 0.05
  on every PR.
- **`inconclusive`** — neither threshold is met: 3 PRs × 2 runs cannot tell
  the arms apart. The cap is then unproven rather than backed, and a larger
  PR set is the way to settle it.

Planning (discovery) is not benchmarked: planning keeps inheriting the
session model by the user's deliberate choice.

## Results

Measured 2026-10-04. Recall = reference findings re-found ÷ that PR's
reference set (23 / 26 / 18 labelled review findings — the same sets as the
2026-09-09 study). Every review cell finished with `subtype: success`; the
resolved model ids, read from each run's `modelUsage` keys rather than the
alias passed in, were `claude-fable-5-1` and `claude-opus-5-5` throughout.

| PR      | Fable runs        | Fable mean | Opus runs        | Opus mean |
| ------- | ----------------- | ---------- | ---------------- | --------- |
| #812    | 0.130, 0.087      | 0.109      | 0.000, 0.043     | 0.022     |
| #756    | 0.077, 0.115      | 0.096      | 0.038, 0.038     | 0.038     |
| #802    | 0.056, 0.056      | 0.056      | 0.056, 0.056     | 0.056     |
| **All** | 12 of 134 matched | **0.087**  | 5 of 134 matched | **0.039** |

| Separation (Fable − Opus)                     |        |
| --------------------------------------------- | ------ |
| Δ mean recall                                 | +0.048 |
| Pooled within-arm sd                          | 0.024  |
| Exact permutation _p_ (one-sided, 924 splits) | 0.0065 |

Fable also raised more candidates (median 7.5 against 4 per run), took more
turns (median 6.5 against 3.5) and ran longer (median 95 s against 46 s).
Opus 5.5's 3.9% sits close to Opus 5's 4.8% in the 2026-09-09 study.

### Cost

| Arm   | Per review (mean / median) | 6 reviews | Per matched finding |
| ----- | -------------------------- | --------- | ------------------- |
| Fable | $2.50 / $2.26              | $15.00    | $1.25               |
| Opus  | $0.71 / $0.77              | $4.26     | $0.85               |

Total spend: $20.30 ($19.25 review cells, $1.05 for the 12 blinded Sonnet
judge cells).

## Verdict: `Fable materially better`

Fable's mean recall beats Opus's by +0.048, twice the pooled within-arm spread,
at _p_ = 0.0065 — both halves of the pre-registered rule hold. (`cap
validated` fails on its own terms too: on #756 Opus trails Fable by 0.058.)
Per the request, **routing is unchanged**: bug-detection keeps its Opus cap on
Fable sessions. What the cap costs: on these PRs Fable re-found 2.4 times
the reference findings at about 3.5 times the price per review, so a matched
finding cost $1.25 on Fable against $0.85 on Opus.

Read it with its limits. Recall is low on both arms, so one matched finding
moves a PR's recall by 0.04–0.056; the whole gap is 7 findings across 12 runs
on 3 PRs, scored by a single fixed-model judge.

## Context: cost per finished helper run

From `bun docs/eval/token-spend-audit.ts --since 2026-09-11` (local
transcripts, list price), the per-spawn table the request's question (b) asked
for:

| Helper @ model                         | Runs | Median turns | Mean $ | $/turn |
| -------------------------------------- | ---- | ------------ | ------ | ------ |
| `flow-discovery` @ Fable 5.1           | 16   | 18.0         | $5.34  | 0.271  |
| `flow-discovery` @ Opus 5              | 37   | 44.0         | $5.57  | 0.134  |
| `flow-discovery` @ Opus 5.5            | 24   | 48.5         | $3.85  | 0.073  |
| `flow-review-product` @ Fable 5.1      | 13   | 6.0          | $1.10  | 0.187  |
| `flow-review-product` @ Opus 5         | 35   | 10.0         | $0.82  | 0.075  |
| `flow-review-product` @ Opus 5.5       | 19   | 10.0         | $0.55  | 0.051  |
| `flow-review-bug-detection` @ Opus 5.5 | 21   | 16.0         | $0.99  | 0.050  |

The issue's 2.4–3.8x per-turn gap is mostly price and turn count, not a
per-task premium. Fable lists at 2x Opus 5's input and output price and 2.5x Opus
5.5's; its discovery runs cost 2.0x and 3.7x as much per turn, but finish in
41% and 37% of the turns. Per finished planning run, Fable costs 4% less than
Opus 5 and $1.49 (39%) more than Opus 5.5. No bug-detection run in the window (from 2026-09-11) used
Fable, so the lens cap (#830) is live.

Planning was not benchmarked: it keeps inheriting the session model by the
user's deliberate choice. The product review lens moves to Opus at medium
effort in the same change; on the figures above that is about $0.55 a review
against Fable's $1.10.
