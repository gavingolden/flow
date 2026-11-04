# system-design-defaults — eval result (PR #998)

Recorded 2026-11-04, `opus` / effort `high`, `--runs 2 --concurrency 3`, fresh `FLOW_RESEARCH_CACHE_DIR` per arm.

Condition met: no (after-v2: strict 2/2 bar missed on s2 only; suite score matches rules-only)

The first after arm beat the before arm on s1 and s2 and kept s3 inline, but passed s1 in 0/2 runs and lost to the five-line rules-only snippet on both slow-work scenarios. That led to after-v2 below.

## after-v2: rules on the planning path (6d5acba)

After the first result, the five rules moved to the top of `discovery-runtime-design.md` (read on every plan), the skill's table pinned the interactive budget to 10 s instead of the platform timeout, and persisted generation and multi-section work were sent to the queue. Recorded 2026-11-04 with the same flags.

| Scenario             | before      | rules-only  | after (v1)  | after-v2    |
| -------------------- | ----------- | ----------- | ----------- | ----------- |
| s1-report-endpoint   | 0/2 (0.571) | 1/2 (0.929) | 0/2 (0.714) | 2/2 (1.0)   |
| s2-nightly-refresh   | 0/2 (0.563) | 1/2 (0.938) | 1/2 (0.875) | 1/2 (0.875) |
| s3-fast-paid-control | 2/2 (1.0)   | 2/2 (1.0)   | 2/2 (1.0)   | 2/2 (1.0)   |
| Suite score          | 0.711       | 0.955       | 0.863       | 0.958       |
| Cost                 | $13.59      | $11.89      | $12.63      | $14.44      |

- s1 now queues in both runs: the fix to the budget wording closed the escape hatch.
- The s2 miss (run 1) planned one capped nightly Cloud Run Job instead of a scheduler enqueuing one task per report, flagged by the agent itself as a medium-confidence choice, and required a durable store first because the fixture keeps reports in memory.
- `compare --fail-on-regression` against rules-only exits 1 on one regression: s2 (−0.063, one run). s1 gains +0.071. Against before it has no regressions. Cost per run is about 20% higher than rules-only, because the skill and its references are read.
- Outputs: [`system-design-defaults/after-v2/`](system-design-defaults/after-v2/).

## Arms

| Arm        | Plugin tree             | Fixture `AGENTS.md`                                              |
| ---------- | ----------------------- | ---------------------------------------------------------------- |
| before     | `31b49d8`               | as committed                                                     |
| rules-only | `31b49d8`               | plus `evals/system-design-defaults/rules-only-agents-snippet.md` |
| after      | `2193d8c` (this branch) | as committed                                                     |

All three arms ran with this branch's `evals/system-design-defaults/` (graders and `case.json`). The graders were tightened after `31b49d8` (the cost-bound regex and the `no-agent-fallback` gate), so running the base commit's own copy would have graded the arms differently. The before and rules-only trees were therefore dirty by that overlay; their skills and agents match `31b49d8` exactly.

## Results

Runs passing every gate, out of 2:

| Scenario                                          | before            | rules-only  | after       |
| ------------------------------------------------- | ----------------- | ----------- | ----------- |
| s1-report-endpoint (five paid sections)           | 0/2 (score 0.571) | 1/2 (0.929) | 0/2 (0.714) |
| s2-nightly-refresh (every saved report)           | 0/2 (0.563)       | 1/2 (0.938) | 1/2 (0.875) |
| s3-fast-paid-control (one fast call stays inline) | 2/2 (1.0)         | 2/2 (1.0)   | 2/2 (1.0)   |
| Suite score                                       | 0.711             | 0.955       | 0.863       |
| Cost                                              | $13.59            | $11.89      | $12.63      |

Failing gates per run:

| Run   | before                                             | rules-only  | after                     |
| ----- | -------------------------------------------------- | ----------- | ------------------------- |
| s1 r1 | queue, idempotency, cost-bound                     | idempotency | queue, idempotency        |
| s1 r2 | queue, idempotency, cost-bound                     | —           | queue, cost-bound         |
| s2 r1 | queue, idempotency, cost-bound, scheduler-enqueues | idempotency | queue, scheduler-enqueues |
| s2 r2 | queue, idempotency, scheduler-enqueues             | —           | —                         |

## What the failures were

- **after s1 (both runs):** the agent read `flow-system-design/SKILL.md` and still ran the five section calls concurrently inside the request (worst case 182 s in run 1, 95 s in run 2), treating Cloud Run's 300 s request timeout as the budget instead of the skill's 10 s interactive budget, and deferred the durable queue and store to a follow-up issue because the fixture keeps reports in memory. The skill's "bounded set of paid calls, aggregate p99 under the budget" inline row was the escape hatch it used.
- **after s2 r1:** the agent pushed back (the fixture keeps reports in memory, so there is nothing durable to refresh) and planned a capped nightly batch job rather than a scheduler that enqueues one task per report. Defensible on the fixture, but it misses the graded shape.
- **rules-only:** the only misses are idempotency keys, in one run of each slow scenario.

Every after run read the new skill; no before run did.

## Compare output

`flow-eval compare --fail-on-regression` against before: exit 0, no regressions; s1 +0.143, s2 +0.313, s3 unchanged.

`flow-eval compare --fail-on-regression` against rules-only: exit 1, two regressions (s1 −0.214, s2 −0.063); s2 cost +15.4%.

Per-arm `report.json`, `summary.md` and per-run `grades.json` / `assistant-text.txt` are in [`system-design-defaults/`](system-design-defaults/). Raw streams were not kept.

## Caveats

- Two runs per arm per scenario; one run flipping changes a pass rate by 50 points.
- A first attempt at all three arms hit the account's 5-hour usage limit within three minutes and was discarded.
