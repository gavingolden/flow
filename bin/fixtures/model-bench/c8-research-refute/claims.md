# Claims: evaluating four models on an internal coding benchmark

All model names below are fictional/synthetic, invented for this exercise. Do not draw on any outside knowledge about real model providers, real benchmark leaderboards, or real-world latency/cost figures — every claim below must be checked strictly against the evidence in this file.

## Evidence

### Table 1 — benchmark results (n=40 runs per model, single JSON-schema arm)

| Model | Mean score (0-100) | Median latency (s) | p95 latency (s) | Timeout rate | Cost per run ($) |
| --- | --- | --- | --- | --- | --- |
| Aurora-3 Flash | 71.2 | 4.1 | 9.8 | 0% | 0.004 |
| Aurora-3 Pro | 84.6 | 11.7 | 24.3 | 2.5% | 0.031 |
| Kestrel-2 Thinking | 88.9 | 26.4 | 58.1 | 0% | 0.112 |
| Kestrel-2 Instant | 66.0 | 2.9 | 6.2 | 0% | 0.002 |

### Table 2 — mean score by case difficulty (n=10 runs per model per bucket)

| Model | Easy-bucket mean | Hard-bucket mean |
| --- | --- | --- |
| Aurora-3 Flash | 89.1 | 53.3 |
| Aurora-3 Pro | 92.0 | 77.2 |
| Kestrel-2 Thinking | 93.5 | 84.3 |
| Kestrel-2 Instant | 85.0 | 47.0 |

### Note on the timeout figure

Aurora-3 Pro's 2.5% timeout rate (1 run out of 40) occurred entirely on the `c3-log-triage` case's 500KB size bucket; every other case/size combination for Aurora-3 Pro completed within the 120-second budget. No other model in Table 1 recorded a timeout on any case.

## Claims

For each claim below, the author's stated confidence label and cited source are noted in brackets.

1. **[High confidence, cites Table 1]** Kestrel-2 Thinking has the highest mean score of the four models (88.9).
2. **[High confidence, cites Table 1]** Aurora-3 Flash's median latency (4.1s) is lower than Aurora-3 Pro's median latency (11.7s).
3. **[Medium confidence, cites Table 1]** Kestrel-2 Instant is the cheapest of the four models to run per request, at $0.002 per run.
4. **[High confidence, cites Table 1]** Aurora-3 Pro's p95 latency is 28.4 seconds.
5. **[High confidence, cites Table 1 and Table 2]** Kestrel-2 Thinking has both the highest mean score in Table 1 and the smallest easy-to-hard score drop in Table 2 (93.5 → 84.3, a 9.2-point gap, versus Aurora-3 Flash's 35.8-point gap). Therefore, a small easy-to-hard score drop causes a higher mean score.
6. **[High confidence, cites the timeout note]** Aurora-3 Pro's only recorded timeout happened during the largest size bucket of the log-triage case.
7. **[High confidence, cites Table 1]** Aurora-3 Flash and Kestrel-2 Instant both have a 0% timeout rate.
8. **[High confidence, cites the timeout note]** No model in Table 1 ever timed out on any case.
9. **[Medium confidence, cites Table 2]** Every model's hard-bucket mean is lower than its easy-bucket mean.
10. **[High confidence, cites Table 2]** Aurora-3 Flash's easy-to-hard score drop (89.1 → 53.3, a 35.8-point gap) is the largest drop of any model in Table 2.
11. **[Medium confidence, cites Table 2]** Kestrel-2 Instant's hard-bucket mean (47.0) is the lowest hard-bucket mean of the four models, even though its easy-bucket mean (85.0) is only 8.5 points below Kestrel-2 Thinking's (93.5).
12. **[High confidence, cites Table 1]** Aurora-3 Pro costs less than 8 times as much per run as Kestrel-2 Instant.
