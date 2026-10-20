# flow-eval — haiku-gatekeeper

Candidate: `haiku-gatekeeper` · Tree: `f10038148a7d` · Model: `n/a` · Effort: `n/a`

| Scenario | Status | Score | Runs | finalContextTokens | costUsd | numTurns | subagentsSpawned | durationMs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s1-merged-skip | pass | 1 | 2 | 60199.500 | 0.123 | n/a | 0 | 28437 |
| s2-trivial-skip | pass | 1 | 2 | 62946.500 | 0.140 | n/a | 0 | 48411.500 |
| s3-small-but-proceed | pass | 1 | 2 | 64792 | 0.167 | n/a | 0 | 66607 |
| s4-closed-first-match | pass | 1 | 2 | 61983 | 0.145 | n/a | 0 | 42932.500 |
| s5-proceed-normal | pass | 1 | 2 | 62411.500 | 0.151 | n/a | 0 | 48469.500 |
| s6-no-new-commits-skip | fail | 0.500 | 2 | 62091.500 | 0.148 | n/a | 0 | 43706 |

Suite score: **0.917** (5/6 passed, 1 failed, 0 errored, $1.750)
