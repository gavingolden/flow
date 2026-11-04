# system-design-references — eval result (PR #998)

Recorded 2026-11-04, `opus` / effort `high`, `--runs 2 --concurrency 3`, fresh `FLOW_RESEARCH_CACHE_DIR` per arm.

Measures whether each of the eight reference files added in 6d5acba changes what `/flow-product-planning` discovery puts in the plan's Task breakdown. One planning scenario per reference; command graders regex the Task breakdown.

| Arm       | Tree                                                                                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no-refs   | 6d5acba with the eight new reference files deleted and their Context-list lines removed. Rules and the decision-table fixes stay, so the arms differ only in the references. |
| with-refs | 6d5acba                                                                                                                                                                      |

The baseline was clean: when a no-refs run tried to read a deleted file, `flow-module-status` returned `skill-path-not-found`.

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
