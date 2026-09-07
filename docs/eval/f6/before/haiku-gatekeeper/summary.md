# flow-eval — haiku-gatekeeper

Candidate: `haiku-gatekeeper` · Tree: `3e62f2efc64f` (dirty) · Model: `n/a` · Effort: `n/a`

| Scenario | Status | Score | Runs | finalContextTokens | costUsd | numTurns | subagentsSpawned | durationMs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s1-merged-skip | fail | 0.875 | 2 | 59908 | 0.150 | n/a | 0 | 30287.500 |
| s2-trivial-skip | pass | 1 | 2 | 62653.500 | 0.169 | n/a | 0 | 54593 |
| s3-small-but-proceed | pass | 1 | 2 | 63821 | 0.167 | n/a | 0 | 62915.500 |
| s4-closed-first-match | fail | 0.875 | 2 | 60508.500 | 0.127 | n/a | 0 | 35413.500 |
| s5-proceed-normal | pass | 1 | 2 | 60576.500 | 0.133 | n/a | 0 | 36738.500 |
| s6-no-new-commits-skip | fail | 0.500 | 2 | 62969 | 0.155 | n/a | 0 | 52113 |

Suite score: **0.875** (3/6 passed, 3 failed, 0 errored, $1.803)
