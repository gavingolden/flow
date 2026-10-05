# Step 8c batched runner — eval result (issue #835, review-phase slice)

Recorded 2026-10-05. **Verdict: ship rule failed — no change ships; #835 closed not planned.**

## Production re-measure (`bun docs/eval/token-spend-audit.ts --since 2026-09-10`)

Supervisor is 56.3% of spend ($2,673 of $4,752) in the window. The costliest
supervisor phase is `reviewing`: $542 (27.3%), 73 pipelines, 35.2 turns per
pipeline at ~0.41M context per turn, largest phase in 53 pipelines. Full table:
[supervisor-phase-baseline-2026-10.md](supervisor-phase-baseline-2026-10.md).

## Pre-registered ship rule

Median `result.total_cost_usd` on review-tail ≥15% lower AND median
`result.num_turns` ≥3 lower, every review-tail gate 5/5, and no
phase-write-fidelity score regression against a fresh before arm.

## Result (sonnet, effort medium, 5 runs per scenario)

| Suite / scenario                        | Before (42914eb) | After (c738831) | Δ                                                                                                              |
| --------------------------------------- | ---------------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| review-tail s1 — median cost            | $0.324           | $0.325          | +0.3%                                                                                                          |
| review-tail s1 — median turns           | 6                | 6               | 0                                                                                                              |
| review-tail s1 — score                  | 1                | 1               | —                                                                                                              |
| phase-write-fidelity s1 ci-wait — score | 1                | 0.867           | regression (harness: seeded state file missing at first call in 2/5 runs; scenario never loads flow-pr-review) |
| phase-write-fidelity s2–s5 — score      | 1                | 1               | —                                                                                                              |

Eval spend: $14.57 before + $14.58 after + $0.32 smoke.

## Why it missed

The before-arm child did not hand-run items one shell call at a time: it ran
all items in one loop and injected all evidence in a second loop (Skill, read,
run-loop, inject-loop, reply). The after-arm child replaced those two calls
with one runner call but added a validation call (Skill, read, runner,
validate, reply). Turns did not move, so cost did not either. The ~4.5-turn
Test Steps cluster seen in production is mostly the body fetch, the body
write-back and per-item fixes, which the runner does not remove.

## What stays tracked

Inherited context (~338K median at review entry, 72% of review cost in cache
re-reads) is the dominant review-phase cost; a fresh-context review and the
wait/instruction-read clusters are the remaining levers. See #835's closing
comment.

Reports: [before/](supervisor-turn-cost/before), [after/](supervisor-turn-cost/after),
compares: [review-tail](supervisor-turn-cost/review-tail.compare.json),
[phase-write-fidelity](supervisor-turn-cost/phase-write-fidelity.compare.json).
