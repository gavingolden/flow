# Supervisor spend by pipeline phase (2026-10)

The dated production before-state for how the supervisor's own turns split
across pipeline phases, so the change that trims supervisor turns carries a
recorded before/after delta instead of a prose argument.

## Method

Reproduce with:

```sh
bun docs/eval/token-spend-audit.ts --since 2026-09-10
```

Recorded **2026-10-05**. The table below is the script's output pasted
verbatim from one run; a later re-run over the same `--since` will differ
slightly (the window keeps growing and old transcripts are garbage-collected).
Dollars are list-price equivalents priced from the script's dated inline
table, not a bill.

Each main-session turn of a slugged session is attributed to the
`phase.transition` event active at its timestamp (latest transition at or
before the turn; turns before the first transition are `before-first-phase`).
This is a different cut from the `$1,914 review phase` figure in
[token-spend-analysis.md](../token-spend-analysis.md), which sums turns by the
in-process Skill segment they ran under; the two will not match. Pipelines are
slugs with at least one attributed turn in the phase, and "largest phase in N
pipelines" counts the slugs for which that phase had the largest dollars.

The window includes this pipeline's own in-flight session, so its partial
turns are in the numbers. Aggregates only: no prompt text and no session ids.

## Coverage

- Run date: 2026-10-05 (--since 2026-09-10, UTC)
- Pricing table last verified: 2026-09-30
- Sessions covered: 186 (2026-09-10 to 2026-10-05); repos: flow, pokemon, econ-data
- Sessions from worktree cwds: 2
- Telemetry join rate: 164/186 (88.2%)
- Parse errors (whole files, not window-filtered): 0
- Assistant rows with no usage: 0
- Unknown models: 0
- Spend (list price): supervisor $2718, sub-agents $2134, total $4852
- Cache writes: 5m 98.98M tokens, 1h 121.78M tokens (55.2% are 1h)
- Cache-write spend (list price): 5m $548, 1h $1340; the 1h premium over the 5m rate is $502

## Supervisor spend by pipeline phase

Every main-session turn of a slugged session, attributed to the phase.transition active at its timestamp. Pipelines are slugs with at least one attributed turn in the phase, so eval-harness slugs whose transcripts are filtered out do not inflate the denominators.

| phase                        | pipelines | turns | turns per pipeline | mean context per turn | $      | % of $ | mean $ per pipeline | largest phase in N pipelines |
| ---------------------------- | --------- | ----- | ------------------ | --------------------- | ------ | ------ | ------------------- | ---------------------------- |
| reviewing                    | 73        | 2570  | 35.2               | 0.41M                 | $542   | 27.3%  | $7.43               | 53                           |
| implementing                 | 77        | 2522  | 32.8               | 0.26M                 | $395   | 19.9%  | $5.13               | 9                            |
| planning                     | 82        | 2354  | 28.7               | 0.20M                 | $280   | 14.1%  | $3.42               | 11                           |
| before-first-phase           | 88        | 663   | 7.5                | 0.15M                 | $237   | 12.0%  | $2.70               | 8                            |
| ci-wait                      | 76        | 631   | 8.3                | 0.36M                 | $97.50 | 4.9%   | $1.28               | 0                            |
| verifying                    | 72        | 470   | 6.5                | 0.31M                 | $74.42 | 3.8%   | $1.03               | 0                            |
| merged                       | 46        | 200   | 4.3                | 0.45M                 | $73.80 | 3.7%   | $1.60               | 3                            |
| gated                        | 29        | 83    | 2.9                | 0.46M                 | $55.06 | 2.8%   | $1.90               | 3                            |
| plan-pending-review          | 39        | 138   | 3.5                | 0.24M                 | $42.23 | 2.1%   | $1.08               | 1                            |
| merging                      | 45        | 206   | 4.6                | 0.44M                 | $39.45 | 2.0%   | $0.88               | 0                            |
| triaging                     | 86        | 451   | 5.2                | 0.16M                 | $38.70 | 2.0%   | $0.45               | 0                            |
| gating                       | 71        | 157   | 2.2                | 0.44M                 | $36.37 | 1.8%   | $0.51               | 0                            |
| triage-pending-interview     | 18        | 49    | 2.7                | 0.17M                 | $17.41 | 0.9%   | $0.97               | 0                            |
| worktree-create              | 82        | 144   | 1.8                | 0.16M                 | $11.43 | 0.6%   | $0.14               | 0                            |
| ci-wait-pending              | 11        | 54    | 4.9                | 0.37M                 | $10.94 | 0.6%   | $0.99               | 0                            |
| triaged-no-change            | 2         | 16    | 8.0                | 0.20M                 | $10.62 | 0.5%   | $5.31               | 1                            |
| needs-human                  | 6         | 15    | 2.5                | 0.30M                 | $6.52  | 0.3%   | $1.09               | 0                            |
| installing-skills            | 19        | 43    | 2.3                | 0.30M                 | $5.33  | 0.3%   | $0.28               | 0                            |
| triage-pending-clarification | 4         | 30    | 7.5                | 0.18M                 | $3.61  | 0.2%   | $0.90               | 0                            |
| plan-pending-interview       | 1         | 2     | 2.0                | 0.28M                 | $2.10  | 0.1%   | $2.10               | 0                            |
| checkpoint-pending-clear     | 15        | 18    | 1.2                | 0.23M                 | $1.45  | 0.1%   | $0.10               | 0                            |
| plan-review-pending          | 2         | 12    | 6.0                | 0.20M                 | $1.11  | 0.1%   | $0.55               | 0                            |
| cancelled                    | 2         | 3     | 1.5                | 0.22M                 | $0.21  | 0.0%   | $0.10               | 0                            |
