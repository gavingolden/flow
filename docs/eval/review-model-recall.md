# Review-model recall measurement (sonnet vs opus)

Measured 2026-09-09. Raw numbers: [`review-model-recall.json`](review-model-recall.json).
Harness: [`review-model-recall/`](review-model-recall/).

This is a **one-off measurement**, not a committed eval suite. It exists to
answer one question with evidence rather than assumption: _does running a
review lens on sonnet instead of opus lose real findings?_ It is the
prerequisite the token-lean routing work was gated on — the request's
standing constraint was that every model choice be confirmed effective, not
assumed.

## What was measured

|               |                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Lenses        | `bug-detection`, `pattern-consistency`, `test-coverage`                                                                                     |
| Arms          | `sonnet`, `opus` — both at `effort: medium`                                                                                                 |
| PRs           | flow #812, #756, #802 (merged; full-scope reviews)                                                                                          |
| Runs per cell | 2 (3 lenses × 2 arms × 3 PRs × 2 = 36 review runs)                                                                                          |
| Reference set | 134 findings that survived the original reviews and were posted as inline comments                                                          |
| Scoring       | one blinded fixed-model (sonnet) judge per cell, classifying each reference finding as `same-text`, `semantically-equivalent`, or unmatched |
| Cost          | $48.27 total ($43.37 review runs, $4.90 judging)                                                                                            |

Two runs per cell is the load-bearing design choice: a single sample cannot
tell a model effect from ordinary run-to-run variance in an LLM reviewer.
Every recall figure below is reported with its spread.

## Results

Recall = reference findings re-found ÷ 134. Mean over 6 runs per lens-arm
(3 PRs × 2 runs).

| Lens                  | sonnet | opus  | Δ      | within-arm sd | exact permutation _p_ | Verdict          |
| --------------------- | ------ | ----- | ------ | ------------- | --------------------- | ---------------- |
| `bug-detection`       | 0.006  | 0.048 | +0.041 | 0.030         | 0.030                 | opus better      |
| `pattern-consistency` | 0.000  | 0.060 | +0.060 | 0.027         | 0.008                 | opus better      |
| `test-coverage`       | 0.016  | 0.060 | +0.044 | 0.046         | 0.108                 | **inconclusive** |

**The arms separate beyond within-cell variance for two of the three lenses.**
`bug-detection` and `pattern-consistency` clear a one-sided exact permutation
test at _p_ < 0.05 (924 permutations, n = 6 per arm); `test-coverage` does not,
and its within-arm spread is as large as the gap. Both the conservative
heuristic (|Δ| > pooled within-arm sd) and the permutation test agree on all
three.

Raw output volume tells the same story more bluntly: across all 18 runs per
arm, sonnet raised 28 distinct concerns to opus's 102.

| Lens                  | sonnet matched / raised | opus matched / raised |
| --------------------- | ----------------------- | --------------------- |
| `bug-detection`       | 1 / 5                   | 6 / 38                |
| `pattern-consistency` | 0 / 11                  | 8 / 27                |
| `test-coverage`       | 2 / 12                  | 7 / 37                |

Two of the 36 runs (both sonnet) returned prose instead of the required JSON
finding format. They were scored on their prose rather than discarded, so the
instruction-following gap counts against sonnet's recall rather than vanishing
from the sample.

## What was deliberately not measured

`security`, `performance`, and `supply-chain` were excluded **before** spending
anything. Across the 9 comparable reviews in
`~/.flow/telemetry/review-lenses.jsonl` they have 3, 4, and 0 acted findings
respectively — too few to separate two models across three PRs. Measuring them
would have consumed roughly two-thirds of the budget to return a
pre-destined "inconclusive". They keep their current model, recorded here
rather than left unexamined.

## What was and was not changed

**No model pin ships from this measurement.** Every
`models.reviewLenses.<lens>` key is absent by default, so no lens's model
changes.

That is a deliberate call, and it is worth being explicit about the tension:

- The evidence supports running `bug-detection` and `pattern-consistency` on
  opus rather than sonnet.
- The accepted routing decision (D2, capped inheritance) is that a _deliberate_
  cheap session keeps cheap reviewers — flow caps inheritance from above
  (`fable` → `opus`) but never raises a model the user chose.

Pinning those two lenses to opus would override that stated preference. On
evidence this thin — 7 and 8 matched findings out of 134, three PRs, one
commit, one model generation — that override was not taken unilaterally. The
recommendation is surfaced instead, as one config line:

```json
{
  "models": {
    "reviewLenses": { "bug-detection": "opus", "pattern-consistency": "opus" }
  }
}
```

Adopt it if you run cheap sessions and want those two lenses protected. The
measured cost of _not_ adopting it, on a sonnet session, is roughly the gap in
the table above.

So the token reduction in this change comes entirely from the risk tier and the
`fable` cap — **not** from moving lenses to a cheaper model. The measurement
found the opposite of the direction the original framing assumed, which is the
honest outcome rather than a failed run.

## Limits — read these before citing the numbers

1. **Absolute recall is very low (0–17%) and that is expected.** The denominator
   is the full 134-finding reference set from a six-lens review, while each cell
   is a _single_ lens. A lens cannot re-find what another lens owns. The
   denominator is identical across arms, so it cancels for the sonnet-vs-opus
   comparison — but these figures are **not** a lens's true recall and must not
   be quoted as one.
2. **The reference set is _survived_ findings, not _acted_ findings.** Per-finding
   lens attribution for past reviews is not recoverable — it lived in each
   pipeline's `pr-review-result.json`, inside worktrees deleted at merge. What
   survives is the posted inline comments. Acted ⊂ survived, so the reference
   set is a superset of what the original review actually acted on.
3. **The harness gives each lens less context than a real review does.** No
   static-analysis facts, no commit messages, no existing intent annotations —
   these are not recoverable per-PR after the fact. Identical across arms.
4. **Reads resolve against current `main`, not the PR's tree.** All three PRs are
   ancestors of `main`, so file reads see post-merge content. Identical across
   arms.
5. **Three PRs, one commit, one model generation.** The pins this would justify
   are measured once and nothing detects when they stop being true. A durable,
   defect-seeded eval suite is filed as a follow-up candidate for exactly this
   reason.
6. **`intent-guess` and the consolidator are unmeasured and unattributed.** Issue
   #780 means neither is attributed in telemetry, so no claim is made about
   either — their spend change is asserted as _unmeasured_, not as zero.
7. **A judge scored the matches.** A blinded fixed-model judge is more consistent
   than a human across 36 cells but is not ground truth; `same-text` matches are
   far more reliable than `semantically-equivalent` ones.
