# flow-eval — haiku-gatekeeper

Candidate: `haiku-gatekeeper` · Tree: `befd0d54a63d` · Model: `sonnet` · Effort: `n/a`

| Scenario | Status | Score | Runs | finalContextTokens | costUsd | numTurns | subagentsSpawned | durationMs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s1-merged-skip | pass | 1 | 2 | 81766.500 | 0.403 | n/a | 0 | 22190.500 |
| s2-trivial-skip | pass | 1 | 2 | 82359.500 | 0.371 | n/a | 0 | 25946.500 |
| s3-small-but-proceed | pass | 1 | 2 | 82437.500 | 0.332 | n/a | 0 | 29157 |
| s4-closed-first-match | pass | 1 | 2 | 82298 | 0.338 | n/a | 0 | 25874.500 |
| s5-proceed-normal | pass | 1 | 2 | 82252.500 | 0.328 | n/a | 0 | 29940.500 |
| s6-no-new-commits-skip | fail | 0.500 | 2 | 83881 | 0.352 | n/a | 0 | 41871 |

Suite score: **0.917** (5/6 passed, 1 failed, 0 errored, $4.249)
