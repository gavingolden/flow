# Bug-detection recall: Fable vs Opus (issue #890)

Raw numbers: [`fable-vs-opus-subagents.json`](fable-vs-opus-subagents.json).
Harness: [`review-model-recall/`](review-model-recall/).

A one-off measurement, not a committed eval suite. It answers one question:
_does the Opus cap bug-detection already runs under on Fable sessions (#830)
lose findings Fable would have caught?_ Whatever the answer, the lens cap is
left unchanged — a Fable advantage is reported with its numbers, not acted on.

## Pre-registered rule

Written before any cell ran, so the verdict cannot be fitted to the numbers.

|               |                                                                                    |
| ------------- | ---------------------------------------------------------------------------------- |
| Lens          | `bug-detection` only                                                               |
| Arms          | `fable` (Fable 5.1), `opus` (the `opus` alias, Opus 5.5) — both at `effort: medium` |
| PRs           | flow #812, #756, #802 — the same set and reference findings as the 2026-09-09 study |
| Runs per cell | 2 (2 arms × 3 PRs × 2 = 12 review runs, 12 judge runs)                             |
| Budget        | ~$20–25 total; per-cell caps Fable $20, Opus $14                                   |
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

<!-- results below are appended after the run -->
