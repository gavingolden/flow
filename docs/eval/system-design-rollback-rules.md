# Plan-time rollback, backup and inline-budget rules: targeted eval

Three advisory `flow-plan-lint` rules, measured on the four scenarios they target:

- **Rollback task required**: a schema change, backfill, expand/contract, dual-write or queue payload change needs a `**Rollback:**` line naming a task whose body carries the rollback step or check.
- **Database backups required**: a database store needs a backup or PITR task. Bucket versioning no longer counts for a database.
- **In-request time limit, now strict**: a missing column or an unreadable in-request p99 is a miss, and Proportionality cannot waive the 10 s budget.

Candidate tree `5492fd077d8b`. Opus/high, same suite defaults as the recorded baselines. Kept outputs:

- [`system-design-references/rules-v1/`](system-design-references/rules-v1/) (r2, r4)
- [`system-design-defaults/rules-v1/s1/`](system-design-defaults/rules-v1/s1/)
- [`system-design-defaults/rules-v1/s3/`](system-design-defaults/rules-v1/s3/)

## Free pre-sweep over the 22 kept plans

Before any paid run, the three rules ran over the 16 with-refs-v2 and 6 after-v3 plans.

| Rule          | Fired on              | Verdict                                                                                                                                                 |
| ------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rollback      | r2 runs 1–2           | true positive (the recorded r2 miss)                                                                                                                    |
| Rollback      | r5 run 1, r6 runs 1–2 | true positive: each alters tables and backfills with no rollback task                                                                                   |
| Rollback      | r8 run 2              | false positive: it defines a new versioned payload rather than changing one. Fixed by requiring a change verb near `payload`, with a unit-test negative |
| Backups       | r4 run 1              | true positive (the recorded r4 miss)                                                                                                                    |
| Inline budget | s1 run 1, r3 runs 1–2 | already flagged by the existing over-budget check; no new firing                                                                                        |

"drop the cache", "dropdown" and "alter the copy" do not trigger the rollback rule; each is a unit-test negative.

## Results

Per-run miss rate on the rule's own gate. The baseline is with-refs-v2 (regraded) for r2 and r4, and after-v3 for s1 and s3.

| Scenario             | Gate                    | Baseline misses | rules-v1 misses | Other gates                                           |
| -------------------- | ----------------------- | --------------- | --------------- | ----------------------------------------------------- |
| r2-rollout           | rollback                | 2/2             | 0/4             | `payload-compat` 1/4 (run 4, see below), baseline 0/2 |
| r4-recovery          | backup                  | 1/2             | 0/4             | all pass                                              |
| s1-report-endpoint   | queue                   | 1/2             | 0/4             | all pass                                              |
| s3-fast-paid-control | no-queue (stays inline) | 0/2             | 0/2             | all pass                                              |

The r2 run 4 `payload-compat` fail is a grader wording false negative. The plan's Task 3 output is "the generate-section consumer accepting both shapes", and its Task 2 keeps the title "so a rolled-back consumer can still read the task". The gate's regex expects a payload word between "both" and "accept". Regraded, it passes. The plan also carries `**Rollback:** Task 1`.

The in-request time check was never measured on its own before this run, so the report-endpoint (s1) improvement may come from the stricter check, from the planner guidance that now says the 10 s limit cannot be waived, or from both.

No kept plan still argues past its own Runtime design table, so the paid-critic follow-up has no trigger.

Plan-lint called: 14/14 runs called `flow-plan-lint` at least once (3–5 calls each), against 16/22 in the recorded baselines.

Cost: $35.26 total. r2 + r4 cost $20.29 (8 runs), s1 $11.04 (4 runs) and s3 $3.93 (2 runs). The rules add no per-plan cost.

s3 inline: 2 of 2 runs kept the fast paid call inline (the control; nothing to improve).

Ship decision: ship all three rules. Rollback (r2) went from 2/2 to 0/4 misses, backups (r4) from 1/2 to 0/4, and inline budget (s1) from 1/2 to 0/4. The control (s3) stayed clean, and no target scenario is worse after regrading.

Implementation: `bin/lib/plan-runtime-rollback.ts`, `checkRecovery` in `bin/lib/plan-runtime-companions.ts`, `checkInlineBudget` in `bin/lib/plan-runtime-budget.ts`.
