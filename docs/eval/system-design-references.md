# system-design-references — eval result (PR #998)

Recorded 2026-11-04, `opus` / effort `high`, `--runs 2 --concurrency 3`, fresh `FLOW_RESEARCH_CACHE_DIR` per arm.

Measures whether each of the eight reference files added in 6d5acba changes what `/flow-product-planning` discovery puts in the plan's Task breakdown. One planning scenario per reference; command graders regex the Task breakdown.

| Arm       | Tree                                                                                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no-refs   | 6d5acba with the eight new reference files deleted and their Context-list lines removed. Rules and the decision-table fixes stay, so the arms differ only in the references. |
| with-refs | 6d5acba                                                                                                                                                                      |

The baseline was clean: when a no-refs run tried to read a deleted file, `flow-module-status` returned `skill-path-not-found`.

## with-refs-v2: plan-lint checks and kept plans (8b16e32)

After the result below, 8b16e32 added advisory plan-lint checks (queue must-set settings, a `**Recovery:**` line with backup and restore tasks) and fixed two grader false negatives: r3 now accepts fingerprint-keyed reuse, which both with-refs runs had planned, and r5 accepts polling a durable status. Each run's `plan.md` is now kept. Recorded 2026-11-05 with the same flags.

Reading the kept plans found two more grader false negatives: r5 run 2 titled its task "Pollable report read", and r8 run 1 set `VisibilityTimeout: 180`. The next commit widens both graders. The Regraded column re-runs the current graders on the kept plans.

| Scenario        | with-refs misses | v2 misses (recorded) | v2 misses (regraded) | Score with-refs → v2 (regraded) |
| --------------- | ---------------- | -------------------- | -------------------- | ------------------------------- |
| r1 (workflows)  | 1                | 0                    | 0                    | 0.917 → 1.0                     |
| r2 (rollout)    | 2                | 2                    | 2                    | 0.833 → 0.833                   |
| r3 (caching)    | 2                | 0                    | 0                    | 0.800 → 1.0                     |
| r4 (recovery)   | 4                | 1                    | 1                    | 0.667 → 0.917                   |
| r5 (realtime)   | 2                | 1                    | 0                    | 0.833 → 1.0                     |
| r6 (api)        | 0                | 0                    | 0                    | 1.0 → 1.0                       |
| r7 (cloudflare) | 2                | 0                    | 0                    | 0.857 → 1.0                     |
| r8 (aws)        | 2                | 1                    | 0                    | 0.857 → 1.0                     |
| Total           | 15               | 5                    | 3                    | suite 0.846 → 0.969             |
| Cost            |                  | $42.54               |                      | $38.72 → $42.54                 |

- `flow-eval compare --fail-on-regression` (with-refs → with-refs-v2, as recorded): exit 0, no regressions.
- The r3 and r5 gains cannot be split between the grader fixes and planner behaviour, because the earlier arm's plans were not kept. The r4, r7 and r8 gates were not changed by 8b16e32. They fell from 8 misses to 2 as recorded (1 regraded) as the planner was told to put the settings in the tasks.
- Remaining misses:
  - **r2, both runs:** expand/contract makes the rollback safe, but no task names a rollback step or a rollback check.
  - **r4, run 1:** the plan versioned the bucket and moved database backups to an Open Question, because the instance's backup settings are not in the repo.
- False positives in the new checks, across all 22 kept plans: the queue and recovery checks flag none. The inline-budget check flags s1 run 1 (the miss above) and both r3 plans, which keep a 15 s summary model call inline on a cache miss. That breaches the 10 s budget too, so those flags are treated as true positives.
- Outputs, including each run's `plan.md`: [`system-design-references/with-refs-v2/`](system-design-references/with-refs-v2/).

## Results

Gate misses per arm (lower is better), over 2 runs:

| Scenario (reference) | Graded for                                               | no-refs misses | with-refs misses | Score no-refs → with-refs | Reference read (with-refs) |
| -------------------- | -------------------------------------------------------- | -------------- | ---------------- | ------------------------- | -------------------------- |
| r1 (workflows)       | one task per step, fan-in, partial failure               | 3              | 1                | 0.750 → 0.917             | 2/2                        |
| r2 (rollout)         | expand/contract, in-flight payloads, rollback            | 3              | 2                | 0.750 → 0.833             | 2/2                        |
| r3 (caching)         | invalidation, stampede protection                        | 2              | 2                | 0.800 → 0.800             | 2/2                        |
| r4 (recovery)        | backups/PITR, restore, object versioning                 | 6              | 4                | 0.500 → 0.667             | 2/2                        |
| r5 (realtime)        | channel, reconnect, generation stays queued              | 2              | 2                | 0.833 → 0.833             | 2/2                        |
| r6 (api)             | 202 + status, idempotency key, rate limit, pagination    | 0              | 0                | 1.0 → 1.0                 | 2/2                        |
| r7 (cloudflare)      | cron, Queues, dead-letter queue, no `waitUntil` for work | 4              | 2                | 0.714 → 0.857             | 2/2                        |
| r8 (aws)             | SQS, dead-letter, visibility timeout, concurrency cap    | 2              | 2                | 0.857 → 0.857             | 2/2                        |
| Total                |                                                          | 22             | 15               | suite 0.776 → 0.846       |                            |
| Cost                 |                                                          |                |                  | $37.46 → $38.72           |                            |

`flow-eval compare --fail-on-regression` (no-refs → with-refs): exit 0, no score regressions.

## Reading the result

- The references cut gate misses by about a third (22 → 15) at about 3% more cost, with gains on r1, r2, r4 and r7 and no scenario worse.
- Misses that survive in both arms: cache invalidation (r3, 4/4 runs), reconnect handling for live progress (r5, 4/4), SQS visibility timeout (r8, 4/4), and backups plus a restore test for irreplaceable uploads (r4, 4/4). The agent read the matching reference each time and still left these out of the Task breakdown; they may land in the plan's prose rather than a task, which these graders do not see.
- Only r6 passes every gate, in both arms: the planner already designs partner APIs well without help.
- Two runs per arm per scenario; a single run flipping moves a scenario score by up to 0.25.

Outputs: [`system-design-references/`](system-design-references/) (per-arm `report.json`, `summary.md`, per-run `grades.json` and `assistant-text.txt`; raw streams not kept).
