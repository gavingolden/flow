# Supervisor turn-composition baseline (2026-10)

The dated before-state for issue #835's question: where do the
supervisor's turns go, per pipeline phase, and which review steps are
mechanical enough to fold into helpers. Re-measured **2026-10-05** on this
host's local transcripts, the same way [token-spend-baseline-2026-09.md](token-spend-baseline-2026-09.md)
was recorded. A later window compares against these numbers instead of a guess.

## Method

```sh
bun docs/eval/token-spend-audit.ts --since 2026-09-10
bun docs/eval/supervisor-turns.ts --since 2026-09-10
```

Both outputs below are pasted verbatim from one run on 2026-10-05; a re-run
differs slightly because the window grows and old days are garbage-collected
(the session that wrote this file is itself in the window).

- `supervisor-turns.ts` reads only main transcripts that loaded the
  `flow-pipeline` skill, so its supervisor spend is a subset of the audit's
  (which counts every main transcript in the three repos).
- Phase boundaries: review starts at the `flow-pr-review` skill load or
  `flow-state-update --phase reviewing`; `--phase ci-wait` and
  `--phase implementing` reset; `flow-gate-decide` starts gate and
  `flow-merge-guard` starts merge. A turn carrying a boundary belongs to the
  phase it starts. Turns are de-duplicated by message id (last line wins).
- A review turn's cluster comes from its Bash/Monitor commands (highest
  priority wins when a turn mixes them). `rest` holds everything the seven
  named heuristics do not claim, notably agent-spawn turns, metadata
  fetches, intent resolution and review-summary writing.

Window caveat: PRs #894, #895, #898 and #900 merged 2026-10-04/05, so the
window barely reflects them. All four changed sub-agents (lens model pins,
cache lifetimes), not supervisor steps, so they do not move the supervisor
numbers measured here.

## token-spend-audit.ts (headline, `--since 2026-09-10`)

```text
- Run date: 2026-10-05 (--since 2026-09-10, UTC)
- Pricing table last verified: 2026-09-30
- Sessions covered: 186 (2026-09-10 to 2026-10-05); repos: flow, pokemon, econ-data
- Sessions from worktree cwds: 2
- Telemetry join rate: 164/186 (88.2%)
- Parse errors (whole files, not window-filtered): 0
- Assistant rows with no usage: 0
- Unknown models: 0
- Spend (list price): supervisor $2712, sub-agents $2130, total $4842
- Cache writes: 5m 98.52M tokens, 1h 121.56M tokens (55.2% are 1h)
- Cache-write spend (list price): 5m $546, 1h $1338; the 1h premium over the 5m rate is $502
```

```text
## By project

| key | turns | input | cache-write 5m | cache-write 1h | cache-read | output | $ | % of $ |
|---|---|---|---|---|---|---|---|---|
| econ-data | 27436 | 0.11M | 61.53M | 70.18M | 4337.45M | 13.19M | $2891 | 59.7% |
| flow | 16107 | 0.06M | 30.44M | 42.58M | 2508.86M | 8.36M | $1551 | 32.0% |
| pokemon | 3778 | 0.01M | 6.55M | 8.80M | 655.16M | 2.36M | $400 | 8.3% |
| **TOTAL** | 47321 | 0.18M | 98.52M | 121.56M | 7501.47M | 23.91M | $4842 | 100.0% |
```

```text
## By in-process segment

| key | turns | input | cache-write 5m | cache-write 1h | cache-read | output | $ | % of $ | cache-churn |
|---|---|---|---|---|---|---|---|---|---|
| flow-pr-review | 3540 | 0.02M | 0.00M | 19.00M | 1456.82M | 2.39M | $820 | 30.2% | 0.013 |
| flow-pipeline | 2724 | 0.01M | 0.00M | 22.34M | 451.65M | 1.27M | $471 | 17.4% | 0.049 |
| flow-coder | 2429 | 0.01M | 0.00M | 8.71M | 660.19M | 1.67M | $401 | 14.8% | 0.013 |
| flow-product-planning | 2435 | 0.01M | 0.00M | 9.76M | 496.11M | 1.72M | $335 | 12.3% | 0.020 |
| supervisor-base | 597 | 0.01M | 0.00M | 8.13M | 57.74M | 0.35M | $138 | 5.1% | 0.141 |
| flow-verify | 937 | 0.00M | 0.00M | 1.81M | 278.79M | 0.35M | $138 | 5.1% | 0.007 |
| flow-new-feature | 628 | 0.00M | 0.00M | 2.93M | 139.69M | 0.63M | $101 | 3.7% | 0.021 |
| flow-backlog-triage | 252 | 0.00M | 0.00M | 2.90M | 71.17M | 0.26M | $82.95 | 3.1% | 0.041 |
| flow-research | 282 | 0.00M | 0.00M | 1.87M | 86.31M | 0.21M | $69.43 | 2.6% | 0.022 |
| artifact-design | 98 | 0.00M | 0.00M | 1.81M | 17.65M | 0.14M | $47.64 | 1.8% | 0.102 |
| workflow-authoring | 67 | 0.00M | 0.00M | 1.58M | 21.98M | 0.10M | $42.08 | 1.6% | 0.072 |
| claude-api | 109 | 0.00M | 0.00M | 1.08M | 30.80M | 0.11M | $35.02 | 1.3% | 0.035 |
| flow-checkpoint | 8 | 0.00M | 0.00M | 0.31M | 2.38M | 0.00M | $7.06 | 0.3% | 0.132 |
| prompt-improve-loop | 41 | 0.00M | 0.00M | 0.08M | 11.88M | 0.04M | $6.51 | 0.2% | 0.007 |
| flow-ui-ux | 42 | 0.00M | 0.00M | 0.09M | 8.09M | 0.03M | $5.74 | 0.2% | 0.011 |
| flow-testing-svelte | 36 | 0.00M | 0.00M | 0.06M | 8.00M | 0.03M | $4.41 | 0.2% | 0.008 |
| flow-testing | 16 | 0.00M | 0.00M | 0.05M | 3.82M | 0.03M | $2.01 | 0.1% | 0.013 |
| flow-svelte | 9 | 0.00M | 0.00M | 0.04M | 2.07M | 0.01M | $1.58 | 0.1% | 0.018 |
| flow-file-issue | 10 | 0.00M | 0.00M | 0.01M | 2.39M | 0.00M | $1.42 | 0.1% | 0.004 |
| flow-supabase-project | 14 | 0.00M | 0.00M | 0.03M | 3.31M | 0.00M | $1.02 | 0.0% | 0.010 |
| flow-epic-run | 14 | 0.00M | 0.00M | 0.03M | 0.88M | 0.00M | $0.82 | 0.0% | 0.032 |
| supabase:supabase | 4 | 0.00M | 0.00M | 0.01M | 0.99M | 0.01M | $0.41 | 0.0% | 0.013 |
| overlay-probe | 3 | 0.00M | 0.00M | 0.00M | 0.14M | 0.00M | $0.02 | 0.0% | 0.028 |
| **TOTAL** | 14295 | 0.09M | 0.00M | 82.65M | 3812.87M | 9.36M | $2712 | 100.0% | 0.022 |
```

## supervisor-turns.ts (`--since 2026-09-10`)

```text
Run date: 2026-10-05 (--since 2026-09-10, UTC); repos: flow, pokemon, econ-data
Sessions: 164; supervisor turns: 13171; supervisor spend (list price): $2367

### Supervisor turns by phase

| phase     | sessions | turns | $    | % of $ | median turns/session | p75 turns/session | median context |
| --------- | -------- | ----- | ---- | ------ | -------------------- | ----------------- | -------------- |
| pre       | 159      | 4760  | $782 | 33.0%  | 28                   | 44                | 182K           |
| implement | 92       | 3377  | $540 | 22.8%  | 34                   | 44                | 267K           |
| ci-wait   | 90       | 947   | $154 | 6.5%   | 8                    | 12                | 327K           |
| review    | 73       | 2641  | $554 | 23.4%  | 34                   | 40                | 404K           |
| gate      | 112      | 476   | $145 | 6.1%   | 2                    | 6                 | 405K           |
| merge     | 76       | 970   | $193 | 8.2%   | 8                    | 15                | 314K           |

### Review phase (73 sessions, 2641 turns, $554)

Per review session (median / mean): 30 / 31 Bash/Monitor calls, 10 / 10 Agent calls, 34 / 36 turns.

| cluster              | turns | $      | % of review $ | median turns/session | median context |
| -------------------- | ----- | ------ | ------------- | -------------------- | -------------- |
| lens-collect         | 434   | $90.58 | 16.4%         | 6                    | 389K           |
| consolidator-collect | 163   | $31.05 | 5.6%          | 2                    | 413K           |
| fix-applier-collect  | 342   | $65.28 | 11.8%         | 4                    | 421K           |
| test-steps-run       | 156   | $31.46 | 5.7%          | 2                    | 435K           |
| findings-post        | 90    | $16.00 | 2.9%          | 1                    | 439K           |
| prep-finalize        | 143   | $45.30 | 8.2%          | 2                    | 399K           |
| rest                 | 1313  | $274   | 49.5%         | 16                   | 401K           |

Of the 1313 rest turns: 302 spawn an agent, 898 run Bash, 19 are text-only.

### Merge tail (76 sessions, 970 turns, $193), by first helper in the turn

| helper                | turns | $      | % of merge $ | median context |
| --------------------- | ----- | ------ | ------------ | -------------- |
| git                   | 36    | $30.21 | 15.7%        | 237K           |
| flow-untracked        | 59    | $20.94 | 10.8%        | 446K           |
| (no tool)             | 125   | $18.03 | 9.3%         | 368K           |
| flow-followups        | 105   | $16.20 | 8.4%         | 403K           |
| flow-merge-guard      | 30    | $10.90 | 5.6%         | 198K           |
| flow-candidate-issues | 65    | $10.36 | 5.4%         | 411K           |
| flow-pipeline-summary | 54    | $8.40  | 4.4%         | 253K           |
| gh                    | 43    | $7.48  | 3.9%         | 201K           |
| flow                  | 13    | $6.43  | 3.3%         | 187K           |
| flow-remove-worktree  | 31    | $5.11  | 2.6%         | 443K           |
| flow-gate-summary     | 25    | $4.77  | 2.5%         | 432K           |
| flow-checkpoint       | 27    | $3.95  | 2.0%         | 357K           |
```

## Claims vs re-measured

| claim (from the request / 2026-09 baseline)                               | re-measured 2026-10-05                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supervisor is 63.9% of spend, $5,975 (2026-08-31 window, 31 days)         | Supervisor $2712 of $4842 = 56.0% over a shorter window (2026-09-10 on). The share fell; the absolute dollars are not comparable because the windows differ.                                                                                                                                 |
| `flow-pr-review` segment is $1,914 (32.0% of supervisor spend)            | `flow-pr-review` segment $820 (30.2% of supervisor spend), the largest segment again. The review phase proper (this script) is $554 over 73 sessions; the segment figure is larger because it runs from the skill load to the next skill load and so also absorbs gate and merge-tail turns. |
| ~56 Bash and ~10 Agent calls per review session (2026-09-08 audit, means) | Review phase: 31 Bash/Monitor and 10 Agent calls per session (means; medians 30 and 10). Agent calls match; Bash is lower, but the 2026-09-08 segment definition (skill load to next skill load) is wider than this script's review phase, so the two Bash counts are not like for like.     |

What the phase table adds that the audit cannot: the median per-turn context
grows from 182K (pre) to 404K (review), so each review turn re-reads about
twice the context of a planning turn. The six mechanical collect clusters
(lens, consolidator, fix-applier, test-steps, findings, prep/finalize) are
about half of review dollars (the other half is the `rest` row's 1313 turns,
$274), so folding them is bounded by that half; the `rest` row is
orchestration the existing helpers do not cover.
