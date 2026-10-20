# flow-eval — haiku-gatekeeper

Candidate: `haiku-gatekeeper` · Tree: `befd0d54a63d` · Model: `n/a` · Effort: `n/a`

| Scenario | Status | Score | Runs | finalContextTokens | costUsd | numTurns | subagentsSpawned | durationMs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s1-merged-skip | pass | 1 | 2 | 61067.500 | 0.135 | n/a | 0 | 37429.500 |
| s2-trivial-skip | pass | 1 | 2 | 62235.500 | 0.157 | n/a | 0 | 53834 |
| s3-small-but-proceed | pass | 1 | 2 | 59975 | 0.131 | n/a | 0 | 35595.500 |
| s4-closed-first-match | pass | 1 | 2 | 61918 | 0.151 | n/a | 0 | 49694.500 |
| s5-proceed-normal | pass | 1 | 2 | 60061 | 0.126 | n/a | 0 | 37222 |
| s6-no-new-commits-skip | fail | 0.500 | 2 | 62067.500 | 0.159 | n/a | 0 | 44123.500 |

Suite score: **0.917** (5/6 passed, 1 failed, 0 errored, $1.716)
