# flow-eval — phase-write-fidelity

Candidate: `phase-write-side-effect` · Tree: `97d25e777a89` (dirty) · Model: `n/a` · Effort: `n/a`

| Scenario | Status | Score | Runs | finalContextTokens | costUsd | numTurns | subagentsSpawned | durationMs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s1-step7-ci-wait | fail | 0.500 | 2 | 123288 | 2.826 | 16.500 | 0 | 79295.500 |
| s2-step8-reviewing | fail | 0.500 | 2 | 161976.500 | 0.841 | 15.500 | 0 | 140594.500 |
| s3-step9-gating | fail | 0.500 | 2 | 118753 | 3.200 | 10.500 | 0 | 47486.500 |
| s4-step10-merging | pass | 1 | 2 | 114262 | 0.835 | 3 | 0 | 10690.500 |
| s5-open-pr-implementing | error | 0.667 | 2 | 115773 | 2.726 | 4 | 0 | 13711 |

Suite score: **0.633** (1/5 passed, 3 failed, 1 errored, $20.858)
