# flow-eval — haiku-gatekeeper

Candidate: `haiku-gatekeeper` · Tree: `9a1a8e21deb2` · Model: `n/a` · Effort: `n/a`

| Scenario | Status | Score | Runs | finalContextTokens | costUsd | numTurns | subagentsSpawned | durationMs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s1-merged-skip | pass | 1 | 3 | 68495 | 0.225 | n/a | 1 | 65757 |
| s2-trivial-skip | fail | 0.833 | 3 | 68416 | 0.190 | n/a | 1 | 78582 |
| s3-small-but-proceed | pass | 1 | 3 | 67906 | 0.193 | n/a | 1 | 89606 |
| s4-closed-first-match | pass | 1 | 3 | 69031 | 0.206 | n/a | 1 | 87406 |
| s5-proceed-normal | pass | 1 | 3 | 64073 | 0.186 | n/a | 1 | 46847 |
| s6-no-new-commits-skip | fail | 0.667 | 3 | 68379 | 0.208 | n/a | 1 | 107025 |

Suite score: **0.917** (4/6 passed, 2 failed, 0 errored, $3.621)
