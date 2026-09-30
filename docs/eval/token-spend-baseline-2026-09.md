# Token-spend baseline (2026-09)

The dated before-state for where flow's Claude quota goes across the
`flow`, `pokemon` and `econ-data` repos. The interpretation lives in
[token-spend-analysis.md](../token-spend-analysis.md); this file is only the
measured numbers, so a later window compares against them instead of a guess.

## Method

Why it is committed: the transcripts are read from a rolling 30-day window on
the maintainer's machine, so the window that produced these numbers
disappears. A number nobody can re-derive is not a baseline.

Reproduce with:

```sh
bun docs/eval/token-spend-audit.ts --since 2026-08-31
```

Recorded **2026-09-30**. Every table below is the script's output pasted
verbatim; the run was captured once and is not re-run while writing, so a
later re-run over the same `--since` will differ slightly (the window keeps
growing and old days are garbage-collected). Dollars are list-price
equivalents priced from the script's dated inline table, not a bill.

Privacy: aggregates only. No prompt text, no per-session ids; pipelines are
keyed by flow slug for the `flow` repo only, and `pokemon` and `econ-data`
pipelines are keyed `<repo>-<n>`.

## Coverage

- Run date: 2026-09-30 (--since 2026-08-31, UTC)
- Pricing table last verified: 2026-09-30
- Sessions covered: 309 (2026-08-31 to 2026-09-30); repos: flow, pokemon, econ-data
- Sessions from worktree cwds: 17
- Telemetry join rate: 201/309 (65.0%)
- Parse errors: 0
- Assistant rows with no usage: 0
- Unknown models: 0
- Spend (list price): supervisor $5975, sub-agents $3370, total $9344
- Cache writes: 5m 169.12M tokens, 1h 202.07M tokens (54.4% are 1h)
- Cache-write spend (list price): 5m $1032, 1h $2400; the 1h premium over the 5m rate is $900

The join rate landed at 65.0%, above the 60% line, so the script printed no
caveat; the per-pipeline and outcome tables still describe only the 201
sessions that joined telemetry, out of 309.

## Spend by project / model / sub-agent / segment

### By project

| key       | turns | input | cache-write 5m | cache-write 1h | cache-read | output | $     | % of $ |
| --------- | ----- | ----- | -------------- | -------------- | ---------- | ------ | ----- | ------ |
| flow      | 43795 | 0.36M | 85.23M         | 99.30M         | 7633.26M   | 11.36M | $4859 | 52.0%  |
| econ-data | 34142 | 0.36M | 77.46M         | 93.33M         | 5843.26M   | 9.23M  | $3951 | 42.3%  |
| pokemon   | 5084  | 0.01M | 6.43M          | 9.44M          | 934.21M    | 1.28M  | $534  | 5.7%   |
| **TOTAL** | 83021 | 0.73M | 169.12M        | 202.07M        | 14410.73M  | 21.87M | $9344 | 100.0% |

### By model

| key                       | turns | input | cache-write 5m | cache-write 1h | cache-read | output | $      | % of $ |
| ------------------------- | ----- | ----- | -------------- | -------------- | ---------- | ------ | ------ | ------ |
| claude-opus-5             | 36738 | 0.07M | 73.55M         | 111.77M        | 7150.32M   | 12.49M | $5465  | 58.5%  |
| claude-fable-5-1          | 9075  | 0.46M | 25.70M         | 51.36M         | 2047.18M   | 5.48M  | $2139  | 22.9%  |
| claude-sonnet-5           | 30966 | 0.06M | 49.06M         | 23.24M         | 4186.80M   | 2.15M  | $1075  | 11.5%  |
| claude-opus-5-5           | 4728  | 0.01M | 14.58M         | 11.79M         | 797.17M    | 1.20M  | $351   | 3.8%   |
| claude-fable-5            | 658   | 0.13M | 4.08M          | 3.27M          | 148.43M    | 0.52M  | $292   | 3.1%   |
| claude-sonnet-5-5         | 679   | 0.00M | 1.30M          | 0.63M          | 77.00M     | 0.03M  | $21.44 | 0.2%   |
| claude-haiku-4-5-20251001 | 177   | 0.00M | 0.86M          | 0.02M          | 3.82M      | 0.00M  | $1.51  | 0.0%   |
| **TOTAL**                 | 83021 | 0.73M | 169.12M        | 202.07M        | 14410.73M  | 21.87M | $9344  | 100.0% |

### By sub-agent type

| key                             | turns | input | cache-write 5m | cache-write 1h | cache-read | output | $      | % of $ | cache-churn |
| ------------------------------- | ----- | ----- | -------------- | -------------- | ---------- | ------ | ------ | ------ | ----------- |
| flow-discovery                  | 5453  | 0.09M | 5.18M          | 28.26M         | 888.03M    | 0.47M  | $787   | 23.3%  | 0.038       |
| flow-edit-applier               | 18867 | 0.10M | 46.01M         | 0.00M          | 2892.66M   | 1.25M  | $739   | 21.9%  | 0.016       |
| flow-fix-applier                | 10263 | 0.04M | 4.06M          | 14.25M         | 1119.89M   | 0.82M  | $307   | 9.1%   | 0.016       |
| flow-scout                      | 3135  | 0.04M | 12.04M         | 0.00M          | 244.82M    | 0.14M  | $200   | 5.9%   | 0.049       |
| flow-review-bug-detection       | 2059  | 0.01M | 14.74M         | 0.00M          | 182.90M    | 0.16M  | $194   | 5.7%   | 0.081       |
| flow-review-pattern-consistency | 2047  | 0.01M | 15.01M         | 0.00M          | 180.45M    | 0.14M  | $194   | 5.7%   | 0.083       |
| flow-review-test-coverage       | 1722  | 0.01M | 12.78M         | 0.00M          | 136.12M    | 0.14M  | $160   | 4.7%   | 0.094       |
| flow-consolidator               | 1600  | 0.02M | 1.70M          | 6.14M          | 82.01M     | 0.11M  | $122   | 3.6%   | 0.096       |
| flow-review-security            | 1318  | 0.01M | 10.19M         | 0.00M          | 84.12M     | 0.10M  | $117   | 3.5%   | 0.121       |
| general-purpose                 | 991   | 0.02M | 11.19M         | 0.00M          | 131.10M    | 0.06M  | $108   | 3.2%   | 0.085       |
| flow-review-performance         | 1132  | 0.01M | 9.48M          | 0.00M          | 67.49M     | 0.09M  | $104   | 3.1%   | 0.141       |
| flow-ui-driver                  | 2486  | 0.00M | 0.00M          | 4.31M          | 250.29M    | 0.10M  | $68.36 | 2.0%   | 0.017       |
| flow-review-intent-guess        | 649   | 0.01M | 6.37M          | 0.00M          | 26.52M     | 0.10M  | $61.89 | 1.8%   | 0.240       |
| flow-review-supply-chain        | 789   | 0.01M | 4.84M          | 0.00M          | 36.27M     | 0.06M  | $54.79 | 1.6%   | 0.133       |
| flow-review-product             | 620   | 0.00M | 4.64M          | 0.00M          | 33.30M     | 0.10M  | $49.13 | 1.5%   | 0.139       |
| flow-merge-resolver             | 773   | 0.01M | 2.23M          | 0.00M          | 39.50M     | 0.05M  | $35.02 | 1.0%   | 0.056       |
| flow-backlog-verifier           | 318   | 0.01M | 1.93M          | 0.00M          | 15.88M     | 0.05M  | $30.44 | 0.9%   | 0.121       |
| flow-product-critic             | 256   | 0.00M | 2.44M          | 0.00M          | 5.58M      | 0.06M  | $21.81 | 0.6%   | 0.438       |
| Explore                         | 160   | 0.00M | 0.60M          | 0.00M          | 7.58M      | 0.00M  | $7.48  | 0.2%   | 0.080       |
| flow-verify                     | 173   | 0.00M | 0.75M          | 0.39M          | 7.85M      | 0.00M  | $5.02  | 0.1%   | 0.145       |
| fork                            | 11    | 0.00M | 0.03M          | 0.00M          | 2.86M      | 0.00M  | $1.72  | 0.1%   | 0.012       |
| flow-gatekeeper                 | 171   | 0.00M | 0.86M          | 0.00M          | 3.57M      | 0.00M  | $1.44  | 0.0%   | 0.240       |
| flow-probe-cachettl-agent       | 3     | 0.00M | 0.00M          | 0.05M          | 0.03M      | 0.00M  | $0.55  | 0.0%   | 2.006       |
| probe-maxturns-agent            | 3     | 0.00M | 0.07M          | 0.00M          | 0.01M      | 0.00M  | $0.48  | 0.0%   | 12.603      |
| **TOTAL**                       | 54999 | 0.41M | 167.16M        | 53.40M         | 6438.83M   | 4.00M  | $3370  | 100.0% | 0.034       |

### By in-process segment

| key                      | turns | input | cache-write 5m | cache-write 1h | cache-read | output | $      | % of $ | cache-churn |
| ------------------------ | ----- | ----- | -------------- | -------------- | ---------- | ------ | ------ | ------ | ----------- |
| flow-pr-review           | 6691  | 0.08M | 0.00M          | 37.34M         | 2990.31M   | 4.41M  | $1914  | 32.0%  | 0.012       |
| flow-coder               | 4998  | 0.06M | 0.00M          | 18.49M         | 1578.79M   | 3.50M  | $1029  | 17.2%  | 0.012       |
| flow-pipeline            | 5512  | 0.05M | 0.16M          | 40.27M         | 928.28M    | 2.80M  | $1004  | 16.8%  | 0.044       |
| flow-product-planning    | 5736  | 0.06M | 1.28M          | 16.61M         | 1224.83M   | 3.14M  | $863   | 14.4%  | 0.015       |
| flow-new-feature         | 1549  | 0.01M | 0.00M          | 6.53M          | 429.21M    | 1.60M  | $313   | 5.2%   | 0.015       |
| supervisor-base          | 1168  | 0.03M | 0.00M          | 15.01M         | 137.46M    | 0.68M  | $277   | 4.6%   | 0.109       |
| flow-verify              | 1010  | 0.01M | 0.00M          | 1.85M          | 342.75M    | 0.40M  | $164   | 2.7%   | 0.005       |
| artifact-design          | 201   | 0.01M | 0.00M          | 2.28M          | 51.88M     | 0.30M  | $99.15 | 1.7%   | 0.044       |
| flow-backlog-triage      | 252   | 0.00M | 0.00M          | 2.90M          | 71.17M     | 0.26M  | $82.95 | 1.4%   | 0.041       |
| flow-research            | 282   | 0.00M | 0.00M          | 1.87M          | 86.31M     | 0.21M  | $69.43 | 1.2%   | 0.022       |
| workflow-authoring       | 119   | 0.00M | 0.00M          | 1.72M          | 37.20M     | 0.17M  | $52.23 | 0.9%   | 0.046       |
| flow-checkpoint          | 46    | 0.00M | 0.52M          | 1.61M          | 12.48M     | 0.03M  | $37.16 | 0.6%   | 0.171       |
| flow-epic-run            | 161   | 0.00M | 0.00M          | 1.38M          | 18.70M     | 0.07M  | $24.99 | 0.4%   | 0.074       |
| claude-api               | 69    | 0.01M | 0.00M          | 0.35M          | 16.27M     | 0.10M  | $15.75 | 0.3%   | 0.022       |
| prompt-improve-loop      | 41    | 0.00M | 0.00M          | 0.08M          | 11.88M     | 0.04M  | $6.51  | 0.1%   | 0.007       |
| flow-ui-ux               | 42    | 0.00M | 0.00M          | 0.09M          | 8.09M      | 0.03M  | $5.74  | 0.1%   | 0.011       |
| flow-testing-svelte      | 36    | 0.00M | 0.00M          | 0.06M          | 8.00M      | 0.03M  | $4.41  | 0.1%   | 0.008       |
| flow-epic-create         | 50    | 0.00M | 0.00M          | 0.08M          | 5.17M      | 0.03M  | $4.01  | 0.1%   | 0.015       |
| flow-testing             | 22    | 0.00M | 0.00M          | 0.07M          | 5.91M      | 0.04M  | $3.93  | 0.1%   | 0.012       |
| flow-file-issue          | 16    | 0.00M | 0.00M          | 0.02M          | 3.36M      | 0.01M  | $1.67  | 0.0%   | 0.005       |
| flow-svelte              | 9     | 0.00M | 0.00M          | 0.04M          | 2.07M      | 0.01M  | $1.58  | 0.0%   | 0.018       |
| flow-supabase-project    | 8     | 0.00M | 0.00M          | 0.01M          | 1.62M      | 0.00M  | $0.49  | 0.0%   | 0.009       |
| overlay-probe            | 3     | 0.00M | 0.00M          | 0.00M          | 0.14M      | 0.00M  | $0.02  | 0.0%   | 0.028       |
| flow-probe-preload-skill | 1     | 0.00M | 0.00M          | 0.00M          | 0.03M      | 0.00M  | $0.02  | 0.0%   | 0.014       |
| **TOTAL**                | 28022 | 0.32M | 1.96M          | 148.67M        | 7971.90M   | 17.88M | $5975  | 100.0% | 0.019       |

### Sub-agent type @ model

| key                                                | turns | input | cache-write 5m | cache-write 1h | cache-read | output | $      | % of $ |
| -------------------------------------------------- | ----- | ----- | -------------- | -------------- | ---------- | ------ | ------ | ------ |
| flow-edit-applier @ claude-sonnet-5                | 17740 | 0.04M | 42.24M         | 0.00M          | 2754.32M   | 1.16M  | $668   | 19.8%  |
| flow-discovery @ claude-opus-5                     | 3782  | 0.01M | 2.82M          | 16.20M         | 587.12M    | 0.33M  | $481   | 14.3%  |
| flow-fix-applier @ claude-sonnet-5                 | 9938  | 0.02M | 3.73M          | 13.46M         | 1082.90M   | 0.79M  | $288   | 8.5%   |
| flow-discovery @ claude-fable-5-1                  | 749   | 0.05M | 1.28M          | 8.18M          | 136.22M    | 0.09M  | $219   | 6.5%   |
| flow-review-bug-detection @ claude-opus-5          | 1647  | 0.00M | 10.35M         | 0.00M          | 146.51M    | 0.13M  | $141   | 4.2%   |
| flow-review-pattern-consistency @ claude-opus-5    | 1635  | 0.00M | 10.64M         | 0.00M          | 143.22M    | 0.11M  | $141   | 4.2%   |
| flow-scout @ claude-opus-5                         | 2076  | 0.00M | 7.42M          | 0.00M          | 159.12M    | 0.09M  | $128   | 3.8%   |
| flow-review-test-coverage @ claude-opus-5          | 1401  | 0.00M | 8.87M          | 0.00M          | 110.49M    | 0.12M  | $114   | 3.4%   |
| flow-consolidator @ claude-opus-5                  | 1261  | 0.00M | 0.74M          | 4.96M          | 65.10M     | 0.09M  | $88.91 | 2.6%   |
| flow-review-security @ claude-opus-5               | 1075  | 0.00M | 7.16M          | 0.00M          | 68.54M     | 0.08M  | $81.10 | 2.4%   |
| flow-review-performance @ claude-opus-5            | 931   | 0.00M | 6.78M          | 0.00M          | 55.76M     | 0.08M  | $72.20 | 2.1%   |
| flow-ui-driver @ claude-sonnet-5                   | 2486  | 0.00M | 0.00M          | 4.31M          | 250.29M    | 0.10M  | $68.36 | 2.0%   |
| flow-discovery @ claude-opus-5-5                   | 811   | 0.00M | 0.00M          | 3.53M          | 148.12M    | 0.03M  | $58.41 | 1.7%   |
| flow-scout @ claude-fable-5-1                      | 542   | 0.03M | 3.19M          | 0.00M          | 43.58M     | 0.03M  | $52.76 | 1.6%   |
| general-purpose @ claude-opus-5-5                  | 519   | 0.00M | 5.72M          | 0.00M          | 94.11M     | 0.03M  | $47.92 | 1.4%   |
| general-purpose @ claude-fable-5-1                 | 227   | 0.02M | 2.82M          | 0.00M          | 18.58M     | 0.03M  | $41.49 | 1.2%   |
| flow-review-intent-guess @ claude-opus-5           | 512   | 0.00M | 4.53M          | 0.00M          | 20.95M     | 0.08M  | $40.89 | 1.2%   |
| flow-review-supply-chain @ claude-opus-5           | 668   | 0.00M | 3.46M          | 0.00M          | 30.36M     | 0.05M  | $38.05 | 1.1%   |
| flow-review-bug-detection @ claude-fable-5-1       | 114   | 0.01M | 2.36M          | 0.00M          | 10.27M     | 0.01M  | $32.56 | 1.0%   |
| flow-review-pattern-consistency @ claude-fable-5-1 | 119   | 0.01M | 2.33M          | 0.00M          | 11.16M     | 0.01M  | $32.38 | 1.0%   |
| flow-review-product @ claude-opus-5                | 433   | 0.00M | 2.98M          | 0.00M          | 23.55M     | 0.06M  | $31.84 | 0.9%   |
| flow-review-test-coverage @ claude-fable-5-1       | 103   | 0.01M | 2.23M          | 0.00M          | 9.23M      | 0.01M  | $30.62 | 0.9%   |
| flow-backlog-verifier @ claude-fable-5-1           | 318   | 0.01M | 1.93M          | 0.00M          | 15.88M     | 0.05M  | $30.44 | 0.9%   |
| flow-edit-applier @ claude-opus-5                  | 378   | 0.00M | 1.31M          | 0.00M          | 38.53M     | 0.04M  | $28.58 | 0.8%   |
| flow-edit-applier @ claude-fable-5-1               | 282   | 0.07M | 1.16M          | 0.00M          | 40.92M     | 0.04M  | $27.24 | 0.8%   |
| flow-merge-resolver @ claude-opus-5                | 616   | 0.00M | 1.65M          | 0.00M          | 31.51M     | 0.04M  | $26.93 | 0.8%   |
| flow-discovery @ claude-fable-5                    | 60    | 0.03M | 1.09M          | 0.00M          | 10.62M     | 0.01M  | $25.18 | 0.7%   |
| flow-review-security @ claude-fable-5-1            | 93    | 0.01M | 1.76M          | 0.00M          | 6.62M      | 0.01M  | $24.06 | 0.7%   |
| flow-review-performance @ claude-fable-5-1         | 86    | 0.01M | 1.61M          | 0.00M          | 5.91M      | 0.01M  | $21.90 | 0.6%   |
| flow-consolidator @ claude-fable-5-1               | 144   | 0.01M | 0.57M          | 0.61M          | 7.37M      | 0.01M  | $21.74 | 0.6%   |
| flow-review-intent-guess @ claude-fable-5-1        | 65    | 0.00M | 1.15M          | 0.00M          | 3.27M      | 0.01M  | $15.72 | 0.5%   |
| flow-edit-applier @ claude-sonnet-5-5              | 467   | 0.00M | 1.30M          | 0.00M          | 58.90M     | 0.01M  | $15.14 | 0.4%   |
| flow-scout @ claude-opus-5-5                       | 496   | 0.00M | 1.16M          | 0.00M          | 40.40M     | 0.01M  | $14.10 | 0.4%   |
| general-purpose @ claude-opus-5                    | 119   | 0.00M | 1.41M          | 0.00M          | 9.75M      | 0.00M  | $13.78 | 0.4%   |
| flow-review-pattern-consistency @ claude-opus-5-5  | 230   | 0.00M | 1.37M          | 0.00M          | 21.23M     | 0.02M  | $11.48 | 0.3%   |
| flow-review-bug-detection @ claude-opus-5-5        | 238   | 0.00M | 1.35M          | 0.00M          | 21.02M     | 0.02M  | $11.39 | 0.3%   |
| flow-product-critic @ claude-opus-5                | 140   | 0.00M | 1.34M          | 0.00M          | 3.11M      | 0.04M  | $10.94 | 0.3%   |
| flow-review-product @ claude-fable-5-1             | 63    | 0.00M | 0.78M          | 0.00M          | 2.76M      | 0.01M  | $10.91 | 0.3%   |
| flow-review-supply-chain @ claude-fable-5-1        | 51    | 0.00M | 0.69M          | 0.00M          | 2.74M      | 0.00M  | $9.56  | 0.3%   |
| flow-review-test-coverage @ claude-opus-5-5        | 169   | 0.00M | 1.10M          | 0.00M          | 13.03M     | 0.01M  | $8.34  | 0.2%   |
| flow-product-critic @ claude-fable-5-1             | 57    | 0.00M | 0.57M          | 0.00M          | 1.23M      | 0.01M  | $7.84  | 0.2%   |
| flow-review-pattern-consistency @ claude-fable-5   | 20    | 0.00M | 0.47M          | 0.00M          | 1.68M      | 0.00M  | $7.59  | 0.2%   |
| Explore @ claude-opus-5                            | 153   | 0.00M | 0.58M          | 0.00M          | 7.45M      | 0.00M  | $7.39  | 0.2%   |
| flow-review-bug-detection @ claude-fable-5         | 19    | 0.00M | 0.44M          | 0.00M          | 1.60M      | 0.00M  | $7.22  | 0.2%   |
| flow-fix-applier @ claude-fable-5-1                | 42    | 0.02M | 0.34M          | 0.00M          | 10.52M     | 0.00M  | $7.05  | 0.2%   |
| flow-merge-resolver @ claude-fable-5-1             | 101   | 0.00M | 0.40M          | 0.00M          | 4.89M      | 0.01M  | $6.78  | 0.2%   |
| flow-review-test-coverage @ claude-fable-5         | 17    | 0.00M | 0.42M          | 0.00M          | 1.24M      | 0.00M  | $6.61  | 0.2%   |
| flow-review-product @ claude-opus-5-5              | 124   | 0.00M | 0.88M          | 0.00M          | 6.99M      | 0.03M  | $6.38  | 0.2%   |
| flow-fix-applier @ claude-sonnet-5-5               | 212   | 0.00M | 0.00M          | 0.63M          | 18.10M     | 0.02M  | $6.30  | 0.2%   |
| flow-fix-applier @ claude-opus-5                   | 71    | 0.00M | 0.00M          | 0.16M          | 8.37M      | 0.02M  | $6.19  | 0.2%   |
| flow-review-security @ claude-opus-5-5             | 117   | 0.00M | 0.84M          | 0.00M          | 6.87M      | 0.01M  | $5.86  | 0.2%   |
| flow-consolidator @ claude-opus-5-5                | 136   | 0.00M | 0.00M          | 0.57M          | 5.26M      | 0.01M  | $5.79  | 0.2%   |
| flow-review-security @ claude-fable-5              | 19    | 0.00M | 0.35M          | 0.00M          | 1.34M      | 0.00M  | $5.72  | 0.2%   |
| flow-review-performance @ claude-fable-5           | 18    | 0.00M | 0.34M          | 0.00M          | 1.19M      | 0.00M  | $5.58  | 0.2%   |
| flow-scout @ claude-fable-5                        | 21    | 0.00M | 0.27M          | 0.00M          | 1.72M      | 0.00M  | $5.19  | 0.2%   |
| flow-verify @ claude-sonnet-5                      | 173   | 0.00M | 0.75M          | 0.39M          | 7.85M      | 0.00M  | $5.02  | 0.1%   |
| general-purpose @ claude-sonnet-5                  | 126   | 0.00M | 1.25M          | 0.00M          | 8.65M      | 0.00M  | $4.87  | 0.1%   |
| flow-review-supply-chain @ claude-fable-5          | 16    | 0.00M | 0.30M          | 0.00M          | 0.87M      | 0.00M  | $4.75  | 0.1%   |
| flow-consolidator @ claude-fable-5                 | 25    | 0.01M | 0.25M          | 0.00M          | 1.14M      | 0.00M  | $4.45  | 0.1%   |
| flow-review-performance @ claude-opus-5-5          | 90    | 0.00M | 0.68M          | 0.00M          | 4.29M      | 0.01M  | $4.39  | 0.1%   |
| flow-review-intent-guess @ claude-opus-5-5         | 59    | 0.00M | 0.51M          | 0.00M          | 1.88M      | 0.01M  | $3.11  | 0.1%   |
| flow-product-critic @ claude-opus-5-5              | 56    | 0.00M | 0.50M          | 0.00M          | 1.20M      | 0.01M  | $2.93  | 0.1%   |
| flow-discovery @ claude-sonnet-5                   | 51    | 0.00M | 0.00M          | 0.35M          | 5.96M      | 0.00M  | $2.61  | 0.1%   |
| flow-review-supply-chain @ claude-opus-5-5         | 54    | 0.00M | 0.38M          | 0.00M          | 2.30M      | 0.00M  | $2.44  | 0.1%   |
| flow-review-intent-guess @ claude-fable-5          | 8     | 0.00M | 0.14M          | 0.00M          | 0.28M      | 0.00M  | $2.05  | 0.1%   |
| fork @ claude-opus-5                               | 11    | 0.00M | 0.03M          | 0.00M          | 2.86M      | 0.00M  | $1.72  | 0.1%   |
| flow-gatekeeper @ claude-haiku-4-5-20251001        | 171   | 0.00M | 0.86M          | 0.00M          | 3.57M      | 0.00M  | $1.44  | 0.0%   |
| flow-review-bug-detection @ claude-sonnet-5        | 41    | 0.00M | 0.24M          | 0.00M          | 3.49M      | 0.00M  | $1.30  | 0.0%   |
| flow-review-pattern-consistency @ claude-sonnet-5  | 43    | 0.00M | 0.20M          | 0.00M          | 3.16M      | 0.00M  | $1.14  | 0.0%   |
| flow-consolidator @ claude-sonnet-5                | 34    | 0.00M | 0.14M          | 0.00M          | 3.13M      | 0.00M  | $0.97  | 0.0%   |
| flow-review-test-coverage @ claude-sonnet-5        | 32    | 0.00M | 0.15M          | 0.00M          | 2.14M      | 0.00M  | $0.82  | 0.0%   |
| flow-merge-resolver @ claude-sonnet-5              | 30    | 0.00M | 0.10M          | 0.00M          | 2.25M      | 0.00M  | $0.70  | 0.0%   |
| flow-merge-resolver @ claude-opus-5-5              | 26    | 0.00M | 0.08M          | 0.00M          | 0.85M      | 0.00M  | $0.61  | 0.0%   |
| flow-probe-cachettl-agent @ claude-opus-5          | 3     | 0.00M | 0.00M          | 0.05M          | 0.03M      | 0.00M  | $0.55  | 0.0%   |
| probe-maxturns-agent @ claude-opus-5               | 3     | 0.00M | 0.07M          | 0.00M          | 0.01M      | 0.00M  | $0.48  | 0.0%   |
| flow-review-security @ claude-sonnet-5             | 14    | 0.00M | 0.08M          | 0.00M          | 0.76M      | 0.00M  | $0.36  | 0.0%   |
| flow-review-performance @ claude-sonnet-5          | 7     | 0.00M | 0.07M          | 0.00M          | 0.35M      | 0.00M  | $0.25  | 0.0%   |
| flow-review-intent-guess @ claude-sonnet-5         | 5     | 0.00M | 0.04M          | 0.00M          | 0.14M      | 0.00M  | $0.12  | 0.0%   |
| flow-product-critic @ claude-sonnet-5              | 3     | 0.00M | 0.03M          | 0.00M          | 0.05M      | 0.00M  | $0.10  | 0.0%   |
| Explore @ claude-sonnet-5                          | 7     | 0.00M | 0.02M          | 0.00M          | 0.13M      | 0.00M  | $0.09  | 0.0%   |
| **TOTAL**                                          | 54999 | 0.41M | 167.16M        | 53.40M         | 6438.83M   | 4.00M  | $3370  | 100.0% |

## Per-pipeline spend, latency, and outcome

### Per-pipeline

Pipelines with spend joined: 149; median $27.49, p75 $51.31, max $151

| pipeline                               | $      | turns | phase median min | verify ok/fail | outcome                                           |
| -------------------------------------- | ------ | ----- | ---------------- | -------------- | ------------------------------------------------- |
| econ-data-36                           | $151   | 1082  | 1.7              | 0/0            | gated                                             |
| f6-workflow-port                       | $131   | 1310  | 4.4              | 5/8            | gated                                             |
| econ-data-38                           | $114   | 1283  | 11.4             | 3/2            | gated                                             |
| pokemon-2                              | $108   | 851   | 0.7              | 0/0            | (no terminal)                                     |
| pokemon-8                              | $91.35 | 957   | 2.3              | 8/2            | gated                                             |
| econ-data-44                           | $87.61 | 659   | 37.0             | 3/1            | gated                                             |
| token-lean-flow-pr-review              | $83.91 | 898   | 3.8              | 2/3            | gated                                             |
| econ-data-9                            | $80.16 | 917   | 0.9              | 2/3            | gated                                             |
| make-skill-sub-agent-conducting        | $77.46 | 509   | 1.1              | 1/0            | merged                                            |
| token-lean-flow-pr-review-2            | $76.26 | 858   | 1.9              | 4/2            | merged                                            |
| right-now-root-supervisor-one          | $75.17 | 854   | 4.1              | 0/0            | gated                                             |
| f2-explanation-judge                   | $71.67 | 667   | 7.2              | 1/0            | gated                                             |
| pokemon-7                              | $71.45 | 693   | 9.7              | 9/2            | gated                                             |
| flow-epic-ls-currently-doesn           | $66.55 | 709   | 1.8              | 2/2            | merged                                            |
| gemini-lens-permissions                | $64.14 | 547   | 4.3              | 0/1            | merged                                            |
| econ-data-49                           | $64.03 | 564   | 1.0              | 4/1            | merged                                            |
| econ-data-61                           | $63.58 | 460   | 0.5              | 0/0            | gated                                             |
| econ-data-51                           | $62.99 | 945   | 0.4              | 4/0            | gated                                             |
| fix-872-needs-human-clear-seed         | $62.41 | 856   | 0.9              | 14/4           | merged                                            |
| pokemon-3                              | $61.15 | 720   | 19.5             | 10/1           | gated                                             |
| f3-product-critic                      | $60.93 | 670   | 3.7              | 2/1            | gated                                             |
| make-flow-config-tell-truth            | $60.88 | 688   | 6.0              | 1/1            | merged                                            |
| econ-data-21                           | $60.56 | 491   | 1.5              | 8/0            | merged                                            |
| econ-data-23                           | $60.52 | 643   | 13.2             | 5/1            | gated                                             |
| gemini-3-8-flash-released              | $59.94 | 509   | 0.9              | 1/1            | merged                                            |
| context-diet-template-skills           | $59.60 | 669   | 41.8             | 3/1            | gated                                             |
| econ-data-27                           | $59.44 | 423   | 13.4             | 2/4            | merged                                            |
| econ-data-32                           | $59.39 | 480   | 6.7              | 4/0            | gated                                             |
| econ-data-54                           | $56.69 | 692   | 29.3             | 2/3            | gated                                             |
| econ-data-50                           | $56.25 | 576   | 3.6              | 3/1            | merged                                            |
| econ-data-45                           | $55.58 | 908   | 10.6             | 5/3            | gated                                             |
| econ-data-37                           | $54.88 | 674   | 1.7              | 3/2            | merged                                            |
| econ-data-16                           | $53.62 | 439   | 2.8              | 3/3            | merged                                            |
| econ-data-48                           | $52.91 | 465   | 1.4              | 4/1            | gated                                             |
| flow-delegate-fanout-has-no            | $52.86 | 542   | 0.6              | 0/0            | gated                                             |
| econ-data-42                           | $52.07 | 703   | 4.7              | 5/3            | gated                                             |
| econ-data-52                           | $51.65 | 363   | 119.6            | 0/1            | needs-human:eval-baseline-regen-blocked-api-limit |
| make-launch-time-behaviour-flags       | $51.31 | 679   | 1.8              | 3/2            | merged                                            |
| seems-like-pipeline-statuses-tmux      | $51.19 | 517   | 1.4              | 1/1            | merged                                            |
| econ-data-8                            | $51.17 | 529   | 0.6              | 4/2            | merged                                            |
| econ-data-5                            | $50.09 | 634   | 18.9             | 5/2            | gated                                             |
| agents-md-context-budget               | $49.52 | 454   | 1.1              | 5/3            | gated                                             |
| econ-data-12                           | $49.09 | 432   | 0.5              | 6/0            | merged                                            |
| pokemon-4                              | $49.03 | 456   | 5.5              | 4/1            | merged                                            |
| econ-data-31                           | $48.76 | 446   | 3.2              | 3/0            | merged                                            |
| implement-github-issue-805-full        | $47.88 | 109   | 644.8            | 0/0            | merged                                            |
| implement-github-issue-805-full        | $47.84 | 534   | 1.1              | 8/3            | gated                                             |
| econ-data-60                           | $47.58 | 527   | 0.4              | 4/3            | gated                                             |
| harden-explain-judge-fence             | $47.11 | 419   | 0.6              | 3/1            | merged                                            |
| econ-data-57                           | $47.08 | 569   | 0.8              | 3/2            | merged                                            |
| econ-data-43                           | $46.42 | 454   | 6.9              | 5/2            | merged                                            |
| econ-data-17                           | $45.90 | 609   | 1.1              | 3/2            | merged                                            |
| investigate-whether-fixed-per-subagent | $45.17 | 484   | 0.6              | 3/3            | merged                                            |
| right-now-pr-template-puts             | $44.12 | 392   | 0.7              | 2/0            | merged                                            |
| epic-dependency-writeback              | $43.93 | 272   | 0.5              | 3/2            | merged                                            |
| stop-flow-subagents-from-leaking       | $43.80 | 607   | 0.8              | 4/2            | gated                                             |
| econ-data-10                           | $41.94 | 446   | 4.5              | 2/1            | gated                                             |
| epic-resume-continuity                 | $41.61 | 654   | 1.3              | 4/1            | merged                                            |
| econ-data-7                            | $40.93 | 483   | 2.5              | 2/3            | gated                                             |
| econ-data-53                           | $40.85 | 409   | 2.6              | 4/1            | merged                                            |
| econ-data-39                           | $40.13 | 309   | 3.3              | 3/0            | merged                                            |
| econ-data-40                           | $39.94 | 377   | 9.6              | 2/2            | merged                                            |
| econ-data-56                           | $38.65 | 259   | 25.8             | 0/0            | (no terminal)                                     |
| econ-data-46                           | $38.47 | 426   | 0.4              | 3/0            | merged                                            |
| pokemon-1                              | $37.69 | 319   | 2.9              | 5/1            | gated                                             |
| review-sample-set-recent-prs           | $35.71 | 369   | 0.5              | 3/1            | merged                                            |
| econ-data-19                           | $35.46 | 502   | 1.1              | 3/2            | merged                                            |
| econ-data-41                           | $35.13 | 568   | 1.7              | 1/3            | (no terminal)                                     |
| econ-data-33                           | $33.11 | 502   | 13.0             | 3/3            | merged                                            |
| implement-github-issue-795-full        | $31.06 | 179   | 2.0              | 0/0            | (no terminal)                                     |
| epic-dag-producer-overfire             | $29.75 | 252   | 0.5              | 3/2            | merged                                            |
| i-want-make-flow-fully                 | $28.17 | 73    | 1.9              | 0/0            | (no terminal)                                     |
| econ-data-18                           | $27.99 | 242   | 230.6            | 0/0            | needs-human:implement-failed                      |
| implement-github-issue-798-full        | $27.66 | 169   | 2.9              | 5/3            | gated                                             |
| right-now-flow-feature-create          | $27.49 | 368   | 1.9              | 2/2            | gated                                             |
| token-lean-flow-pr-review-2            | $27.44 | 196   | 19.9             | 0/0            | (no terminal)                                     |
| fix-872-needs-human-clear-seed         | $26.82 | 169   | 19.8             | 0/0            | (no terminal)                                     |
| revert-smoke-docs-note                 | $26.71 | 233   | 0.6              | 3/0            | cancelled                                         |
| econ-data-14                           | $26.70 | 340   | 8.4              | 4/0            | merged                                            |
| f1-product-brief                       | $26.22 | 183   | 16.4             | 0/0            | (no terminal)                                     |
| econ-data-11                           | $25.66 | 447   | 2.4              | 6/2            | merged                                            |
| econ-data-35                           | $24.29 | 97    | 1.4              | 0/0            | (no terminal)                                     |
| i-want-do-deep-dive                    | $24.17 | 162   | 1.0              | 0/0            | (no terminal)                                     |
| install-source-dogfood                 | $24.10 | 425   | 1.4              | 4/0            | gated                                             |
| flow-doctor                            | $24.01 | 498   | 2.7              | 5/0            | gated                                             |
| econ-data-1                            | $21.58 | 56    | 0.5              | 0/0            | (no terminal)                                     |
| econ-data-29                           | $20.85 | 225   | 10.3             | 5/2            | merged                                            |
| subagent-contract-fixes                | $20.74 | 370   | 0.5              | 3/2            | merged                                            |
| econ-data-4                            | $20.56 | 313   | 6.9              | 4/0            | gated                                             |
| next-action-is-an-action               | $20.44 | 322   | 1.5              | 3/1            | needs-human:verify-exhausted                      |
| econ-data-25                           | $20.19 | 127   | 1.2              | 0/0            | (no terminal)                                     |
| evidence-redact                        | $19.64 | 302   | 0.9              | 4/4            | merged                                            |
| pokemon-6                              | $19.63 | 293   | 2.6              | 2/0            | merged                                            |
| implement-github-issue-797-full        | $19.14 | 140   | 2.2              | 2/1            | merged                                            |
| econ-data-6                            | $19.08 | 242   | 10.5             | 0/2            | needs-human:loop-reanchor-pending                 |
| token-lean-flow-pr-review              | $18.57 | 119   | 0.7              | 0/0            | (no terminal)                                     |
| close-out-context-budget-follow        | $18.54 | 200   | 0.8              | 3/2            | merged                                            |
| reap-output-signal                     | $18.07 | 272   | 0.4              | 6/1            | merged                                            |
| revert-f6-workflow-port                | $17.40 | 115   | 2.3              | 3/1            | gated                                             |
| should-i-redesign-flow-sub             | $17.25 | 57    | 1182.5           | 0/0            | (no terminal)                                     |
| econ-data-3                            | $17.03 | 113   | 3.3              | 0/0            | (no terminal)                                     |
| f3-product-critic                      | $17.00 | 77    | 0.4              | 0/0            | (no terminal)                                     |
| review-sample-set-recent-prs           | $16.85 | 88    | 20.5             | 0/0            | (no terminal)                                     |
| f2-explanation-judge                   | $16.33 | 56    | 1.1              | 0/0            | (no terminal)                                     |
| econ-data-34                           | $15.95 | 104   | 13.6             | 0/0            | (no terminal)                                     |
| context-diet-template-skills           | $15.54 | 113   | 0.9              | 0/0            | (no terminal)                                     |
| pokemon-5                              | $15.23 | 97    | 0.4              | 0/0            | (no terminal)                                     |
| econ-data-58                           | $15.15 | 51    | 0.4              | 0/0            | (no terminal)                                     |
| reduce-review-phase-token-cost         | $14.88 | 53    | 0.3              | 0/0            | (no terminal)                                     |
| close-out-context-budget-follow        | $14.65 | 100   | 1.3              | 0/0            | (no terminal)                                     |
| close-out-context-budget-follow        | $14.55 | 59    | 4016.9           | 0/0            | (no terminal)                                     |
| econ-data-13                           | $14.11 | 92    | 0.7              | 0/0            | (no terminal)                                     |
| make-skill-sub-agent-conducting        | $14.07 | 57    | 1.1              | 0/0            | (no terminal)                                     |
| make-launch-time-behaviour-flags       | $14.01 | 101   | 0.6              | 0/0            | (no terminal)                                     |
| implement-github-issue-796-full        | $13.95 | 85    | 3.3              | 0/0            | (no terminal)                                     |
| implement-github-issue-805-full        | $13.91 | 59    | 0.2              | 0/0            | (no terminal)                                     |
| econ-data-59                           | $13.84 | 76    | 0.9              | 0/0            | (no terminal)                                     |
| econ-data-30                           | $13.83 | 258   | 11.5             | 1/1            | needs-human:ci-external-failure                   |
| econ-data-28                           | $13.43 | 93    | 0.6              | 0/0            | (no terminal)                                     |
| make-flow-config-tell-truth            | $13.32 | 94    | 0.6              | 0/0            | (no terminal)                                     |
| flow-automode-repo-rules               | $13.15 | 161   | 10.1             | 0/0            | cancelled                                         |
| pokemon-9                              | $13.12 | 95    | 0.8              | 0/0            | (no terminal)                                     |
| econ-data-55                           | $12.78 | 86    | 1.1              | 0/0            | (no terminal)                                     |
| right-now-root-supervisor-one          | $12.55 | 52    | 1.3              | 0/0            | (no terminal)                                     |
| econ-data-24                           | $12.30 | 149   | 0.7              | 0/0            | (no terminal)                                     |
| econ-data-26                           | $12.23 | 56    | 0.8              | 0/0            | (no terminal)                                     |
| docs-touch-the-getting-started-note    | $12.03 | 114   | 0.8              | 3/1            | gated                                             |
| flow-doctor                            | $11.83 | 128   | 0.7              | 0/0            | (no terminal)                                     |
| i-think-pr-review-skill-2              | $11.54 | 45    | 6.8              | 0/0            | (no terminal)                                     |
| stop-flow-subagents-from-leaking       | $11.28 | 83    | 0.3              | 0/0            | (no terminal)                                     |
| implement-github-issue-799-full        | $10.85 | 86    | 0.4              | 0/0            | (no terminal)                                     |
| right-now-flow-feature-create          | $9.97  | 78    | 1.1              | 0/0            | (no terminal)                                     |
| econ-data-2                            | $9.75  | 32    | 0.4              | 0/0            | cancelled                                         |
| next-action-is-an-action               | $9.57  | 124   | 0.2              | 0/0            | needs-human:verify-exhausted                      |
| econ-data-47                           | $9.05  | 94    | 0.9              | 0/0            | (no terminal)                                     |
| make-flow-reason-from-explain          | $8.64  | 88    | 6.8              | 0/0            | (no terminal)                                     |
| install-source-dogfood                 | $8.52  | 125   | 0.4              | 0/0            | (no terminal)                                     |
| f1-product-brief                       | $8.44  | 36    | 16.0             | 7/2            | gated                                             |
| validate-product-critic                | $7.40  | 46    | 0.4              | 0/0            | (no terminal)                                     |
| econ-data-20                           | $7.27  | 49    | 0.5              | 0/0            | cancelled                                         |
| validate-critic-2                      | $6.63  | 91    | 1.1              | 0/0            | (no terminal)                                     |
| analyze-optimize-unused-skills-plugins | $5.50  | 22    | 1.7              | 3/2            | (no terminal)                                     |
| i-recently-listened-podcast-chroma     | $4.75  | 15    | 5.3              | 0/0            | (no terminal)                                     |
| i-believe-jev-recently-released        | $4.67  | 19    | 3.9              | 0/0            | (no terminal)                                     |
| econ-data-22                           | $4.35  | 34    | 13.5             | 2/1            | gated                                             |
| implement-github-issue-799-full        | $4.34  | 27    | 1021.7           | 1/0            | (no terminal)                                     |
| implement-github-issue-805-full        | $2.79  | 7     | n/a              | 0/0            | (no terminal)                                     |
| econ-data-15                           | $2.76  | 5     | 0.2              | 0/0            | cancelled                                         |
| implement-github-issue-800-full        | $2.45  | 15    | 2.2              | 0/0            | (no terminal)                                     |

### Outcome distribution

The slugged runs below are the real pipelines. The slug-less bucket is the flow-eval harness's child runs; they are listed separately and never counted as pipelines.

Slugged runs (one terminal per session, the last): 95

| status      | runs |
| ----------- | ---- |
| merged      | 45   |
| gated       | 39   |
| needs-human | 6    |
| cancelled   | 5    |

Slug-less terminals (flow-eval harness children, never counted as pipelines): 50

| status      | runs |
| ----------- | ---- |
| merged      | 35   |
| gated       | 13   |
| needs-human | 2    |

### Outcome by last phase

| status      | reason                                | phase the run ended in   | runs |
| ----------- | ------------------------------------- | ------------------------ | ---- |
| merged      | -                                     | merging                  | 43   |
| gated       | -                                     | gating                   | 39   |
| needs-human | eval-baseline-regen-blocked-api-limit | implementing             | 1    |
| merged      | -                                     | gated                    | 1    |
| cancelled   | -                                     | gated                    | 1    |
| cancelled   | -                                     | needs-human              | 1    |
| cancelled   | -                                     | planning                 | 1    |
| needs-human | implement-failed                      | implementing             | 1    |
| needs-human | loop-reanchor-pending                 | implementing             | 1    |
| merged      | -                                     | gating                   | 1    |
| cancelled   | -                                     | triaging                 | 1    |
| needs-human | ci-external-failure                   | implementing             | 1    |
| cancelled   | -                                     | plan-pending-review      | 1    |
| needs-human | verify-exhausted                      | checkpoint-pending-clear | 1    |
| needs-human | verify-exhausted                      | merging                  | 1    |

### Per-phase minutes and verify pass rate

since_prev_ms measures time spent in the PREVIOUS phase, so each row is keyed by the phase the run was leaving.

| phase                          | transitions | median min | p75 min |
| ------------------------------ | ----------- | ---------- | ------- |
| plan-pending-interview         | 2           | 1517.0     | 1517.0  |
| triaged-no-change              | 4           | 1182.5     | 1187.8  |
| gated                          | 14          | 432.9      | 644.8   |
| triage-pending-interview       | 28          | 39.4       | 298.1   |
| plan-pending-review            | 52          | 32.9       | 552.0   |
| triage-pending-clarification   | 3           | 29.7       | 1766.9  |
| reviewing                      | 99          | 28.9       | 45.7    |
| implementing                   | 103         | 27.3       | 47.2    |
| planning                       | 110         | 18.2       | 22.6    |
| epic-designing                 | 1           | 11.1       | 11.1    |
| ci-wait-pending                | 24          | 9.0        | 11.5    |
| epic-validating                | 1           | 6.8        | 6.8     |
| approval-pending-clarification | 1           | 6.2        | 6.2     |
| needs-human                    | 8           | 4.4        | 505.4   |
| epic-design-pending-review     | 1           | 3.8        | 3.8     |
| checkpoint-pending-clear       | 23          | 2.7        | 23.8    |
| verifying                      | 84          | 2.4        | 8.9     |
| ci-wait                        | 205         | 1.3        | 7.7     |
| plan-review-pending            | 1           | 1.1        | 1.1     |
| epic-pr-open                   | 1           | 0.7        | 0.7     |
| merging                        | 51          | 0.7        | 1.0     |
| triaging                       | 115         | 0.4        | 0.8     |
| gating                         | 97          | 0.4        | 0.6     |
| worktree-create                | 187         | 0.2        | 0.3     |
| installing-skills              | 43          | 0.1        | 0.1     |

Verify attempts (slugged runs): 314 ok, 139 failed (69.3% pass)

### First-turn cache-write per sub-agent type

Cache-creation tokens on each sub-agent transcript's first assistant turn: the instruction payload the agent is born with.

| sub-agent type                  | transcripts | median tokens | mean tokens |
| ------------------------------- | ----------- | ------------- | ----------- |
| flow-discovery                  | 151         | 43445         | 42077       |
| general-purpose                 | 72          | 38039         | 38881       |
| flow-fix-applier                | 111         | 37822         | 37021       |
| flow-edit-applier               | 175         | 30780         | 30562       |
| flow-verify                     | 22          | 28299         | 30897       |
| flow-merge-resolver             | 35          | 27236         | 27561       |
| flow-scout                      | 106         | 27102         | 26992       |
| probe-maxturns-agent            | 3           | 26953         | 24967       |
| flow-probe-cachettl-agent       | 3           | 26782         | 17911       |
| flow-consolidator               | 111         | 26039         | 26393       |
| flow-review-bug-detection       | 116         | 20287         | 19375       |
| flow-ui-driver                  | 29          | 19718         | 22100       |
| flow-review-intent-guess        | 108         | 18365         | 17264       |
| flow-review-test-coverage       | 114         | 18279         | 17542       |
| flow-gatekeeper                 | 30          | 18231         | 18339       |
| flow-review-performance         | 110         | 18131         | 17337       |
| flow-review-security            | 111         | 18124         | 17369       |
| flow-review-pattern-consistency | 116         | 18107         | 17597       |
| flow-review-supply-chain        | 75          | 17942         | 17102       |
| flow-review-product             | 60          | 15082         | 15912       |
| flow-product-critic             | 66          | 14747         | 15125       |
| flow-backlog-verifier           | 23          | 14707         | 16038       |
| Explore                         | 9           | 14469         | 14696       |
| fork                            | 1           | 523           | 523         |

### Review lenses: tokens per acted finding

Review runs in window: 81. Tokens are raw totals across all token classes (not dollars) and come from mixed accounting sources, shown per lens; runs with no token figure contribute findings but no tokens.

| lens                | runs | tokens  | emitted | survived | acted | tokens per acted | token sources (transcript/notification/none) |
| ------------------- | ---- | ------- | ------- | -------- | ----- | ---------------- | -------------------------------------------- |
| bug-detection       | 78   | 176.92M | 215     | 156      | 95    | 1.86M            | 52/20/9                                      |
| pattern-consistency | 78   | 176.86M | 373     | 310      | 162   | 1.09M            | 52/20/9                                      |
| test-coverage       | 78   | 133.25M | 328     | 307      | 158   | 0.84M            | 52/20/9                                      |
| security            | 76   | 78.64M  | 144     | 121      | 40    | 1.97M            | 51/22/8                                      |
| performance         | 76   | 69.82M  | 113     | 103      | 17    | 4.11M            | 51/19/11                                     |
| product             | 56   | 63.44M  | 202     | 185      | 81    | 0.78M            | 48/8/1                                       |
| supply-chain        | 51   | 29.82M  | 39      | 30       | 5     | 5.96M            | 34/11/36                                     |
| gemini              | 63   | 0.00M   | 182     | 119      | 53    | 0.00M            | 0/1/80                                       |

## Limitations

- **The review phase changed mid-window.** PRs #829 and #830 changed the
  review phase on 2026-09-09 and 2026-09-10, so this window mixes before and
  after. The clean-window path is a `--since 2026-09-10` re-run.
- **Not comparable to the 2026-09-08 numbers.** The earlier machine-local
  audit never deduplicated by message id and priced every cache write at the
  5-minute rate (1.25x). This script dedups within each file and prices the
  5-minute and 1-hour cache writes separately, so totals differ for method
  reasons, not because spend moved.
- **Background sub-agents are invisible to their parent.** Sub-agents launched
  asynchronously show up as their own transcripts but the parent never sees
  their result turns; attribution relies on each transcript's own metadata.
- **Dollars are a proxy.** The subscription quota is model-weighted and its
  weights are unpublished, so list-price dollars rank spend but do not
  predict when the quota runs out.
- **30-day garbage-collection window.** Transcripts older than about 30 days
  are deleted locally, so the earliest days in any window are partial.
- **Join coverage.** Only sessions whose id appears in the telemetry log join
  to outcomes and phase timings; the rest contribute spend but no outcome.
- **Mixed token accounting for review lenses.** The lens table mixes three
  token sources, and one lens (gemini) has almost no token data, so tokens per
  acted finding compares lenses only roughly.
- **Pricing is hand-maintained.** The script prints a warning when its table
  is more than 90 days old; unknown models price at $0 and are marked.
