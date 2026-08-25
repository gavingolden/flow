# flow-eval — haiku-gatekeeper

Candidate: `haiku-gatekeeper` · Tree: `8afb9943bf93` · Model: `n/a` · Effort: `n/a`

| Scenario | Status | Score | Runs | finalContextTokens | costUsd | numTurns | subagentsSpawned | durationMs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s1-merged-skip | pass | 1 | 5 | 71688 | 0.202 | n/a | 1 | 81969 |
| s2-trivial-skip | fail | 0.900 | 5 | 66845 | 0.196 | n/a | 1 | 62819 |
| s3-small-but-proceed | fail | 0.933 | 5 | 69769 | 0.188 | n/a | 1 | 80977 |
| s4-closed-first-match | pass | 1 | 5 | 70293 | 0.195 | n/a | 1 | 84245 |
| s5-proceed-normal | fail | 0.933 | 5 | 71503 | 0.234 | n/a | 1 | 89654 |
| s6-no-new-commits-skip | pass | 1 | 5 | 71796 | 0.227 | n/a | 1 | 88661 |

Suite score: **0.961** (3/6 passed, 3 failed, 0 errored, $6.209)
