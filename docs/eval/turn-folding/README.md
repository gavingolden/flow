# Review turn folding — verdict

**What changed for you:** one of the two ideas shipped, and its payoff is
small. Running a review's runnable Test Steps and pushing the PR body once now
takes one or two fewer supervisor turns in the measured scenario (7 turns down
to 5 or 6, about 12% cheaper in that scenario). Over a four-week window the
cluster it acts on cost $31 of $2,712 supervisor spend, so expect a saving of
at most that, most likely about one turn (around $0.22) per review. The other
idea, waiting for and reading the review agents' results in one call, did not
pass its pre-registered test and was reverted. Nothing here lowered
correctness: the phase-write fidelity suite scores 25/25 before and 25/25 on
its rerun.

This is the recorded answer to issue #835: can the supervisor spend fewer
turns on mechanical review steps by folding them into helpers? Only the
supervisor's turn count was tested. Shrinking the context window each turn
re-reads is a different lever, excluded here (the 150k cap is recorded in
[../review-cost-baseline.md](../review-cost-baseline.md)).

## Protocol

- Suites: `phase-write-fidelity` (does the supervisor still write the right
  phase at Steps 7-10; the no-regression guard) and `review-turn-folding`
  (five scenarios, each bounded to one `/flow-pr-review` step with
  pre-written artifacts; it measures turns for the folded steps).
- Every arm: `bun bin/flow-eval.ts run --suite phase-write-fidelity --suite review-turn-folding --runs 5 --concurrency 3`, Claude Code 2.1.289 (pinned in
  [claude-version.txt](claude-version.txt)), Sonnet at medium effort, on a
  clean tree.
- The before arm was recorded on the unchanged skills before any skill edit
  landed; the folds came after it.
- Arms and the commit each was recorded at (`gitHead` in each `report.json`):

| Arm directory      | Tree      | What it measures                                     |
| ------------------ | --------- | ---------------------------------------------------- |
| `before`           | `154cdc2` | Unchanged skills                                     |
| `after-both-folds` | `8682859` | Fold A (collection) and Fold B (Test Steps)          |
| `after`            | `851bab2` | The shipped tree: Fold B only, Fold A reverted       |
| `after-rerun`      | `851bab2` | `phase-write-fidelity` again, after the flake below  |

Total eval spend was about $75.

## Pre-registered ship rule

Fixed before the after arms were recorded (plan Open Questions): per fold,
every gate grader in its own `review-turn-folding` scenarios passes in at
least as many runs as the before arm, its scenarios' median `result.num_turns`
is strictly lower, and `phase-write-fidelity` shows no scenario with fewer
passing runs than before. Cost is recorded but not decisional, because the f6
arms failed `compare` on cost and duration noise alone at two runs per
scenario.

## Results

Gate passes are runs passing out of 5. Medians are over 5 runs; cost is the
median per run.

`review-turn-folding`, turns are `before → after-both-folds → after`:

| Scenario                         | Fold | Gate (before / both / after) | Median turns | Median cost (before → after) |
| -------------------------------- | ---- | ---------------------------- | ------------ | ---------------------------- |
| s1-consolidator-collect          | A    | 5 / 5 / 5                    | 6 → 6 → 6    | $0.334 → $0.290              |
| s2-consolidator-schema-failure   | A    | 5 / 5 / 5                    | 6 → 7 → 7    | $0.304 → $0.329              |
| s3-fix-applier-collect           | A    | 5 / 5 / 5                    | 6 → 6 → 7    | $0.287 → $0.303              |
| s5-fix-applier-missing-artifact  | A    | 5 / 5 / 5                    | 6 → 7 → 6    | $0.305 → $0.303              |
| s4-step8c-run-items              | B    | 5 / 5 / 5                    | 7 → 5 → 6    | $0.319 → $0.281 (-12%)       |

`s4-step8c-run-items` raw turns per run: before `[7,7,6,7,10]`,
after-both-folds `[5,5,6,6,5]`, after `[6,6,6,6,5]`.

`phase-write-fidelity`, median turns `before → after-both-folds → after`:

| Scenario               | Gate (before / both / after / rerun) | Median turns          | Median cost (before → after) |
| ---------------------- | ------------------------------------ | --------------------- | ---------------------------- |
| s1-step7-ci-wait       | 5 / 5 / 3 / 5                        | 6 → 5 → 6 (rerun 6)   | $0.478 → $0.476              |
| s2-step8-reviewing     | 5 / 5 / 5 / 5                        | 9 → 10 → 9 (rerun 10) | $0.731 → $0.729 (rerun $0.764) |
| s3-step9-gating        | 5 / 5 / 5 / 5                        | 6 → 6 → 6 (rerun 6)   | $0.472 → $0.471              |
| s4-step10-merging      | 5 / 5 / 5 / 5                        | 6 → 6 → 6 (rerun 6)   | $0.472 → $0.471              |
| s5-open-pr-implementing | 5 / 5 / 5 / 5                       | 5 → 5 → 5 (rerun 5)   | $0.450 → $0.450              |

Suite totals (gate passes, spend): `phase-write-fidelity` before 25/25 $13.18,
after-both-folds 25/25 $13.00, after 23/25 $13.01, after-rerun 25/25 $13.00;
`review-turn-folding` before 25/25 $7.85, after-both-folds 25/25 $7.39, after
25/25 $7.50.

## Decision per fold

**Fold A: reverted (commit `f49d804`).** Folding the wait, validation and read
of review-agent results into one helper call failed the turn rule: no
scenario got cheaper in turns, and two rose from 6 to 7, because one helper
call replaced the read but the escalation write still follows. Its main projected saving, the hand-written wait loops the supervisor runs
while agents are still working, cannot be tested here at all: eval
fixtures pre-write the artifacts, so no loop ever runs. That saving is
**unmeasured, not disproven.**

**Fold B: shipped, and the PR is gated on a DECISION item.** Running every
runnable Test Steps item, injecting the evidence, and pushing the PR body once
met the rule: 7 → 5 turns with both folds and 7 → 6 on the shipped tree, 25/25
gates, and fidelity neutral after the rerun. The production measurement says
its ceiling is small, though: the Test Steps cluster is 156 turns over the
2026-09-10 to 2026-10-05 window, median 2 turns per review, $31.46 in total
([../supervisor-turns-baseline-2026-10.md](../supervisor-turns-baseline-2026-10.md)).
The plan's cut list said to drop Fold B if that cluster came in under 3
calls per review, which it did. The fold was kept because it meets the ship
rule the user set, and the PR carries a DECISION item so the user chooses.

Expected saving: at most the cluster's $31 per four-week window, likely about
one turn (around $0.22) per review. The next audit confirms it.

## Caveats

- **A grader-state-file flake, not a regression.** In the `after` arm,
  `phase-write-fidelity` scored 23/25: `s1-step7-ci-wait` lost two runs to
  "file not found" on the grader's state file, while those runs behaved turn
  for turn like the passing ones (6 turns, $0.48 each). The rerun on the same
  tree scored 25/25, which is what the fidelity condition of the ship rule
  rests on.
- **Noise floor.** Scenarios nobody touched drift by one median turn between
  arms (`s3-fix-applier-collect` moved 6 → 7 with its step text unchanged), so
  a one-turn difference at five runs is close to noise. Fold B's 7 → 5/6 is
  larger than that and appears in both arms that contain it; Fold A's 6 → 7
  rises are within it.
- **The two folds were recorded together** in `after-both-folds`, so that arm
  cannot attribute a change to one fold. The `after` arm (Fold B only) is the
  clean read for Fold B.

## Re-check

The next `bun docs/eval/supervisor-turns.ts --since <date>` run compares two
figures against this record: the `test-steps-run` cluster (156 turns, median 2
per review) should fall, and the review-phase median (34 turns per review)
should not rise. Larger remaining candidates, from the same baseline: the
review phase's `rest` cluster (1,313 turns, $274) and the merge phase's tail
(970 turns, $193, median 8 turns per merge).
