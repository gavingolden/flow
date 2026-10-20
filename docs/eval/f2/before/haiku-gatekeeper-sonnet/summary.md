# flow-eval — haiku-gatekeeper

Candidate: `haiku-gatekeeper` · Tree: `9a1a8e21deb2` · Model: `sonnet` · Effort: `n/a`

| Scenario | Status | Score | Runs | finalContextTokens | costUsd | numTurns | subagentsSpawned | durationMs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s1-merged-skip | pass | 1 | 3 | 93966 | 0.570 | n/a | 1 | 79451 |
| s2-trivial-skip | pass | 1 | 3 | 93569 | 0.471 | n/a | 1 | 80622 |
| s3-small-but-proceed | fail | 0.889 | 3 | 92332 | 0.562 | n/a | 1 | 91321 |
| s4-closed-first-match | pass | 1 | 3 | 94018 | 0.463 | n/a | 1 | 75673 |
| s5-proceed-normal | pass | 1 | 3 | 92671 | 0.438 | n/a | 1 | 75216 |
| s6-no-new-commits-skip | fail | 0.500 | 3 | 92700 | 0.540 | n/a | 1 | 93221 |

Suite score: **0.898** (4/6 passed, 2 failed, 0 errored, $9.132)
