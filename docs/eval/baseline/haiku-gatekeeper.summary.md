# flow-eval — haiku-gatekeeper

Candidate: `haiku-gatekeeper` · Tree: `98bba534b2a0` · Model: `n/a` · Effort: `n/a`

| Scenario | Status | Score | Runs | finalContextTokens | costUsd | numTurns | subagentsSpawned | durationMs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s1-merged-skip | pass | 1 | 2 | 65799 | 0.223 | n/a | 1 | 80595.500 |
| s2-trivial-skip | pass | 1 | 2 | 66295.500 | 0.199 | n/a | 1 | 86068 |
| s3-small-but-proceed | fail | 0.833 | 2 | 66271.500 | 0.196 | n/a | 1 | 83093 |
| s4-closed-first-match | pass | 1 | 2 | 66900 | 0.191 | n/a | 1 | 74868.500 |
| s5-proceed-normal | pass | 1 | 2 | 65366 | 0.180 | n/a | 1 | 71829.500 |
| s6-no-new-commits-skip | pass | 1 | 2 | 65490 | 0.186 | n/a | 1 | 80626.500 |

Suite score: **0.972** (5/6 passed, 1 failed, 0 errored, $2.349)
