# Review-lens effort baseline (2026-10)

The dated measurement of what flow's review lenses cost, and what they found,
split by the reasoning effort each sub-agent transcript recorded, across the
`flow`, `pokemon` and `econ-data` repos. It sits behind issue #832's
not-planned verdict on pinning the six unpinned review lenses to medium
effort. The interpretation lives in
[token-spend-analysis.md](../token-spend-analysis.md); this file is only the
measured numbers, so a later window compares against them instead of a guess.
The spend baseline it extends is
[token-spend-baseline-2026-09.md](token-spend-baseline-2026-09.md).

## Method

Reproduce with:

```sh
bun docs/eval/token-spend-audit.ts --since 2026-09-05
```

Recorded **2026-10-05**, run once from the worktree after the audit gained its
effort tables and before that edit was committed, so no commit names the exact
script. The two tables below are pasted verbatim from that single run, not
re-run while writing, so a later re-run over the same `--since` will differ
slightly (the window keeps growing and old days are garbage-collected).
Dollars are list-price equivalents priced from the script's dated inline
table, not a bill.

The effort table reads the `effort` field of each sub-agent transcript's
assistant rows (first row of each request) and splits the existing per-spawn
records by it. The yield table joins each telemetry lens run (session id plus
lens name) to the sub-agent transcript of that lens in the same session; a
lens whose transcript recorded exactly one effort uses it, and one that
recorded several or none lands in `mixed/unjoined`.

Privacy: aggregates only. No prompt text and no session ids.

## Coverage

- Run date: 2026-10-05 (--since 2026-09-05, UTC)
- Pricing table last verified: 2026-09-30
- Sessions covered: 259 (2026-09-05 to 2026-10-05); repos: flow, pokemon, econ-data
- Sessions from worktree cwds: 9
- Telemetry join rate: 225/259 (86.9%)
- Parse errors (whole files, not window-filtered): 0
- Assistant rows with no usage: 0
- Unknown models: 0
- Spend (list price): supervisor $4032, sub-agents $2790, total $6822
- Cache writes: 5m 122.60M tokens, 1h 165.23M tokens (57.4% are 1h)
- Cache-write spend (list price): 5m $697, 1h $1887; the 1h premium over the 5m rate is $708

## Sub-agent spawn cost by type @ model @ effort

The review-lens and consolidator rows only, in the run's own order (by total
spend). Every `flow-review-*` and `flow-consolidator` row the run printed is
here.

| key                                                         | spawns | median turns | median min | mean $ | median $ | $/turn |
| ----------------------------------------------------------- | ------ | ------------ | ---------- | ------ | -------- | ------ |
| flow-review-pattern-consistency @ claude-opus-5 @ high      | 29     | 23.0         | 5.8        | $2.60  | $2.56    | 0.1181 |
| flow-review-bug-detection @ claude-opus-5 @ high            | 28     | 20.5         | 6.0        | $2.56  | $2.36    | 0.1135 |
| flow-review-test-coverage @ claude-opus-5 @ high            | 28     | 17.0         | 5.0        | $2.18  | $2.02    | 0.1116 |
| flow-consolidator @ claude-opus-5 @ high                    | 28     | 16.0         | 4.7        | $1.67  | $1.71    | 0.0972 |
| flow-review-performance @ claude-opus-5 @ high              | 28     | 12.0         | 3.1        | $1.39  | $1.21    | 0.1033 |
| flow-review-security @ claude-opus-5 @ high                 | 28     | 12.5         | 3.7        | $1.37  | $1.40    | 0.0991 |
| flow-review-bug-detection @ claude-opus-5 @ medium          | 20     | 14.0         | 2.5        | $1.33  | $1.25    | 0.0893 |
| flow-review-product @ claude-opus-5 @ high                  | 19     | 12.0         | 3.8        | $1.35  | $1.32    | 0.1068 |
| flow-review-bug-detection @ claude-opus-5-5 @ high          | 18     | 20.0         | 3.5        | $1.36  | $1.28    | 0.0616 |
| flow-review-pattern-consistency @ claude-opus-5 @ medium    | 20     | 12.0         | 1.8        | $1.18  | $1.27    | 0.0927 |
| flow-review-pattern-consistency @ claude-opus-5-5 @ high    | 18     | 19.5         | 2.9        | $1.24  | $1.20    | 0.0588 |
| flow-review-test-coverage @ claude-opus-5 @ medium          | 20     | 10.5         | 2.2        | $1.05  | $1.03    | 0.0972 |
| flow-review-intent-guess @ claude-opus-5 @ high             | 28     | 6.0          | 1.2        | $0.66  | $0.63    | 0.0985 |
| flow-review-supply-chain @ claude-opus-5 @ high             | 20     | 12.0         | 2.0        | $0.92  | $0.87    | 0.0719 |
| flow-consolidator @ claude-opus-5 @ medium                  | 19     | 11.0         | 1.9        | $0.95  | $0.99    | 0.0843 |
| flow-review-test-coverage @ claude-opus-5-5 @ high          | 18     | 12.0         | 2.3        | $0.93  | $0.84    | 0.0624 |
| flow-review-pattern-consistency @ claude-opus-5 @ low       | 13     | 11.0         | 2.1        | $1.28  | $0.91    | 0.0975 |
| flow-review-bug-detection @ claude-opus-5 @ low             | 13     | 11.0         | 2.9        | $1.24  | $1.26    | 0.1030 |
| flow-review-security @ claude-opus-5 @ medium               | 20     | 8.5          | 0.9        | $0.79  | $0.61    | 0.0831 |
| flow-review-product @ claude-opus-5 @ medium                | 17     | 9.0          | 1.4        | $0.83  | $0.79    | 0.0795 |
| flow-review-performance @ claude-opus-5 @ medium            | 20     | 7.0          | 0.9        | $0.63  | $0.60    | 0.0876 |
| flow-review-test-coverage @ claude-opus-5 @ low             | 12     | 9.5          | 2.2        | $1.04  | $0.80    | 0.0907 |
| flow-review-security @ claude-opus-5-5 @ high               | 17     | 11.0         | 1.4        | $0.68  | $0.59    | 0.0638 |
| flow-review-product @ claude-opus-5-5 @ high                | 16     | 11.0         | 2.0        | $0.71  | $0.71    | 0.0611 |
| flow-review-product @ claude-fable-5-1 @ low                | 10     | 6.0          | 1.4        | $1.12  | $1.07    | 0.1998 |
| flow-consolidator @ claude-opus-5 @ low                     | 14     | 9.0          | 2.0        | $0.75  | $0.70    | 0.0745 |
| flow-consolidator @ claude-opus-5-5 @ high                  | 17     | 12.0         | 1.9        | $0.60  | $0.59    | 0.0466 |
| flow-review-security @ claude-opus-5 @ low                  | 11     | 9.0          | 1.2        | $0.80  | $0.74    | 0.0933 |
| flow-review-performance @ claude-opus-5-5 @ high            | 17     | 8.0          | 0.9        | $0.50  | $0.50    | 0.0621 |
| flow-review-performance @ claude-opus-5 @ low               | 11     | 9.0          | 1.4        | $0.76  | $0.65    | 0.0911 |
| flow-review-intent-guess @ claude-opus-5 @ medium           | 19     | 4.0          | 0.7        | $0.41  | $0.40    | 0.0895 |
| flow-review-product @ claude-fable-5-1 @ medium             | 3      | 7.0          | 3.1        | $2.29  | $2.45    | 0.3278 |
| flow-review-intent-guess @ claude-opus-5-5 @ high           | 18     | 4.0          | 0.6        | $0.30  | $0.25    | 0.0559 |
| flow-review-supply-chain @ claude-opus-5 @ medium           | 14     | 7.0          | 0.5        | $0.37  | $0.36    | 0.0530 |
| flow-review-bug-detection @ claude-opus-5-5 @ medium        | 6      | 13.5         | 2.0        | $0.86  | $0.83    | 0.0691 |
| flow-review-pattern-consistency @ claude-fable-5-1 @ low    | 3      | 6.0          | 2.0        | $1.68  | $1.55    | 0.2654 |
| flow-consolidator @ claude-fable-5-1 @ low                  | 3      | 7.0          | 1.6        | $1.63  | $1.51    | 0.2225 |
| flow-review-bug-detection @ claude-fable-5-1 @ low          | 3      | 5.0          | 1.3        | $1.53  | $1.05    | 0.2419 |
| flow-review-pattern-consistency @ claude-opus-5-5 @ medium  | 6      | 12.0         | 1.7        | $0.76  | $0.70    | 0.0566 |
| flow-review-supply-chain @ claude-opus-5 @ low              | 7      | 8.0          | 0.9        | $0.62  | $0.52    | 0.0725 |
| flow-review-test-coverage @ claude-fable-5-1 @ low          | 3      | 5.0          | 1.8        | $1.41  | $1.47    | 0.2651 |
| flow-review-intent-guess @ claude-opus-5 @ low              | 12     | 4.0          | 0.5        | $0.35  | $0.31    | 0.0710 |
| flow-review-supply-chain @ claude-opus-5-5 @ high           | 9      | 7.0          | 0.6        | $0.41  | $0.40    | 0.0516 |
| flow-review-pattern-consistency @ claude-fable-5-1 @ medium | 1      | 12.0         | 7.2        | $3.59  | $3.59    | 0.2996 |
| flow-review-test-coverage @ claude-opus-5-5 @ medium        | 5      | 13.0         | 2.0        | $0.71  | $0.67    | 0.0500 |
| flow-review-security @ claude-fable-5-1 @ medium            | 1      | 7.0          | 3.6        | $3.51  | $3.51    | 0.5017 |
| flow-consolidator @ claude-fable-5-1 @ high                 | 1      | 20.0         | 7.1        | $3.32  | $3.32    | 0.1660 |
| flow-review-security @ claude-fable-5-1 @ low               | 3      | 4.0          | 1.2        | $1.10  | $1.02    | 0.2545 |
| flow-review-test-coverage @ claude-fable-5-1 @ high         | 1      | 11.0         | 5.6        | $3.12  | $3.12    | 0.2838 |
| flow-review-bug-detection @ claude-fable-5-1 @ medium       | 1      | 9.0          | 6.2        | $3.08  | $3.08    | 0.3427 |
| flow-review-bug-detection @ claude-fable-5-1 @ high         | 1      | 12.0         | 5.8        | $2.98  | $2.98    | 0.2487 |
| flow-review-test-coverage @ claude-fable-5-1 @ medium       | 1      | 10.0         | 4.8        | $2.98  | $2.98    | 0.2981 |
| flow-review-performance @ claude-fable-5-1 @ low            | 3      | 4.0          | 0.5        | $0.99  | $0.76    | 0.2275 |
| flow-consolidator @ claude-opus-5-5 @ medium                | 6      | 11.0         | 1.5        | $0.48  | $0.48    | 0.0432 |
| flow-review-pattern-consistency @ claude-fable-5-1 @ high   | 1      | 11.0         | 5.6        | $2.86  | $2.86    | 0.2597 |
| flow-review-performance @ claude-fable-5-1 @ medium         | 1      | 9.0          | 3.5        | $2.79  | $2.79    | 0.3095 |
| flow-review-security @ claude-opus-5-5 @ medium             | 5      | 8.0          | 1.1        | $0.52  | $0.46    | 0.0593 |
| flow-review-product @ claude-opus-5-5 @ medium              | 6      | 7.0          | 0.9        | $0.43  | $0.42    | 0.0567 |
| flow-review-performance @ claude-opus-5-5 @ medium          | 5      | 7.0          | 0.7        | $0.48  | $0.41    | 0.0653 |
| flow-review-intent-guess @ claude-fable-5-1 @ low           | 3      | 3.0          | 0.6        | $0.76  | $0.67    | 0.1909 |
| flow-review-security @ claude-fable-5-1 @ high              | 1      | 9.0          | 3.9        | $2.15  | $2.15    | 0.2393 |
| flow-consolidator @ claude-fable-5-1 @ medium               | 1      | 13.0         | 4.1        | $2.14  | $2.14    | 0.1647 |
| flow-review-intent-guess @ claude-fable-5-1 @ medium        | 1      | 7.0          | 1.9        | $2.09  | $2.09    | 0.2985 |
| flow-review-performance @ claude-fable-5-1 @ high           | 1      | 9.0          | 3.3        | $1.96  | $1.96    | 0.2177 |
| flow-review-intent-guess @ claude-fable-5-1 @ high          | 1      | 8.0          | 2.5        | $1.58  | $1.58    | 0.1969 |
| flow-review-intent-guess @ claude-opus-5-5 @ medium         | 6      | 4.0          | 0.6        | $0.26  | $0.24    | 0.0577 |
| flow-review-supply-chain @ claude-fable-5-1 @ high          | 1      | 8.0          | 2.8        | $1.33  | $1.33    | 0.1657 |
| flow-review-product @ claude-opus-5 @ low                   | 2      | 7.5          | 1.5        | $0.64  | $0.64    | 0.0851 |
| flow-review-supply-chain @ claude-fable-5-1 @ medium        | 1      | 6.0          | 2.2        | $1.09  | $1.09    | 0.1819 |
| flow-review-supply-chain @ claude-fable-5-1 @ low           | 1      | 5.0          | 0.8        | $1.08  | $1.08    | 0.2151 |
| flow-review-supply-chain @ claude-opus-5-5 @ medium         | 3      | 8.0          | 0.5        | $0.27  | $0.29    | 0.0391 |

## Review lenses: findings per run by lens effort

| key                                  | reviews | runs | emitted/run | survived/run | acted/run |
| ------------------------------------ | ------- | ---- | ----------- | ------------ | --------- |
| all @ high                           | 35      | 228  | 2.98        | 2.65         | 1.31      |
| all @ low                            | 15      | 93   | 2.30        | 1.92         | 0.96      |
| all @ medium                         | 25      | 159  | 2.01        | 1.79         | 0.81      |
| all @ mixed/unjoined                 | 11      | 62   | 4.08        | 3.11         | 1.32      |
| bug-detection @ high                 | 35      | 35   | 2.57        | 2.09         | 1.31      |
| bug-detection @ low                  | 15      | 15   | 2.20        | 1.47         | 0.80      |
| bug-detection @ medium               | 24      | 24   | 1.67        | 1.25         | 0.96      |
| bug-detection @ mixed/unjoined       | 11      | 11   | 4.45        | 2.55         | 1.27      |
| pattern-consistency @ high           | 35      | 35   | 5.11        | 4.54         | 2.71      |
| pattern-consistency @ low            | 15      | 15   | 3.07        | 2.40         | 1.53      |
| pattern-consistency @ medium         | 24      | 24   | 3.58        | 3.08         | 1.50      |
| pattern-consistency @ mixed/unjoined | 11      | 11   | 6.82        | 4.73         | 1.91      |
| performance @ high                   | 34      | 34   | 1.32        | 1.32         | 0.26      |
| performance @ low                    | 14      | 14   | 1.36        | 1.21         | 0.07      |
| performance @ medium                 | 23      | 23   | 0.78        | 0.65         | 0.13      |
| performance @ mixed/unjoined         | 11      | 11   | 2.27        | 1.91         | 0.18      |
| product @ high                       | 32      | 32   | 4.19        | 3.84         | 1.56      |
| product @ low                        | 12      | 12   | 3.42        | 3.17         | 1.58      |
| product @ medium                     | 24      | 24   | 2.46        | 2.17         | 0.92      |
| product @ mixed/unjoined             | 1       | 1    | 5.00        | 5.00         | 2.00      |
| security @ high                      | 34      | 34   | 1.94        | 1.65         | 0.59      |
| security @ low                       | 14      | 14   | 1.29        | 1.00         | 0.29      |
| security @ medium                    | 23      | 23   | 1.35        | 1.22         | 0.26      |
| security @ mixed/unjoined            | 11      | 11   | 2.91        | 2.55         | 1.18      |
| supply-chain @ high                  | 23      | 23   | 0.65        | 0.48         | 0.09      |
| supply-chain @ low                   | 8       | 8    | 1.00        | 0.88         | 0.25      |
| supply-chain @ medium                | 18      | 18   | 0.17        | 0.17         | 0.00      |
| supply-chain @ mixed/unjoined        | 6       | 6    | 1.33        | 1.00         | 0.17      |
| test-coverage @ high                 | 35      | 35   | 4.31        | 3.94         | 2.17      |
| test-coverage @ low                  | 15      | 15   | 3.27        | 3.00         | 1.87      |
| test-coverage @ medium               | 23      | 23   | 3.61        | 3.61         | 1.65      |
| test-coverage @ mixed/unjoined       | 11      | 11   | 5.36        | 4.82         | 2.64      |

## Derived figures

Every figure in this section is **derived** from the pasted tables (mean $
times spawns, summed), so each carries the cents rounding of the printed mean.
It is arithmetic on the tables above, not a separate measurement.

- Six unpinned reviewers (bug-detection, security, pattern-consistency,
  performance, supply-chain, test-coverage), 30-day total across all efforts:
  about $634 (derived), which is 9.3% of the run's $6822 total. By model:
  claude-opus-5 about $475, claude-opus-5-5 about $106, claude-fable-5-1 about
  $53.
- claude-opus-5: 161 high-effort runs cost about $304 (derived), a mean of
  $1.89 a run; 114 medium-effort runs cost about $105 (derived), a mean of
  $0.92 a run; medium/high ratio 0.49 (derived).
- claude-opus-5-5: 97 high-effort runs cost about $87 (derived), a mean of
  $0.90 a run; 30 medium-effort runs cost about $19 (derived), a mean of
  $0.64 a run; medium/high ratio 0.71 (derived).
- Projected 30-day saving of a medium pin, high-effort run spend times
  (1 - medium/high ratio) (derived): claude-opus-5-5 about $26, the
  current-model saving, 0.4% of $6822; claude-opus-5 about $156, the older
  model the issue's larger number rests on, 2.3% of $6822. Low-effort runs
  (67 on claude-opus-5, about $67) are left out: a medium pin would raise
  their cost, not cut it.
- Median bug-detection run time, high vs medium (read from the effort table):
  claude-opus-5 6.0 vs 2.5 minutes, claude-opus-5-5 3.5 vs 2.0 minutes.
- Observational findings per run, high vs medium (read from the yield table):
  all lenses acted 1.31 vs 0.81, bug-detection 1.31 vs 0.96,
  pattern-consistency 2.71 vs 1.50.

## Limitations

- Session effort is confounded with which tasks the user launched at which
  effort, so a cost or yield gap between effort buckets is not an effect of
  effort alone.
- "Acted" is decided by the supervisor at that same session effort, so a lower
  acted-per-run at medium may reflect a medium-effort supervisor, not a
  weaker lens.
- The verdict rests on the projected saving's size against the recall drops
  in [review-model-recall.md](review-model-recall.md), not on the
  observational gap between buckets.
- The post-#898 product-at-medium sample is tiny, so the product rows mostly
  reflect pre-#898 behaviour, when the lens followed the launching session's
  effort.
- About 10 runs per lens are unjoined (transcripts aged out of the ~30-day
  retention, or the review began before `--since`) and sit in the
  `mixed/unjoined` rows.
- Intent-guess yield is not measured: it is absent from lens telemetry. Its
  spawn cost is in the effort table.
- A transcript that changed effort mid-run appears once per effort in the
  effort spawn table, so the spawn count there can exceed the transcript
  count.
- Fable reviewer runs (about $53 in the window) count toward the $634 total
  but get no saving estimate; the projections model Opus runs only.
- Transcripts age out after about 30 days, so the pasted tables are the
  record; a re-run later will not reproduce them.

## Verdict inputs

The figures the decision reads, copied from the sections above.

| input                                                     | value        |
| --------------------------------------------------------- | ------------ |
| Projected 30-day saving, claude-opus-5-5 (derived)        | about $26    |
| Projected 30-day saving, claude-opus-5 (derived)          | about $156   |
| Run total spend                                           | $6822        |
| Medium/high mean cost ratio, claude-opus-5-5 (derived)    | 0.71         |
| Medium/high mean cost ratio, claude-opus-5 (derived)      | 0.49         |
| Acted per run, high vs medium, all lenses (observational) | 1.31 vs 0.81 |
