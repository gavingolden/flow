# flow-eval — phase-write-fidelity

Candidate: `phase-write-side-effect` · Tree: `3e62f2efc64f` (dirty) · Model: `n/a` · Effort: `n/a`

| Scenario | Status | Score | Runs | finalContextTokens | costUsd | numTurns | subagentsSpawned | durationMs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s1-step7-ci-wait | pass | 1 | 2 | 119746.500 | 0.560 | 6.500 | 0 | 22995.500 |
| s2-step8-reviewing | pass | 1 | 2 | 165978.500 | 0.825 | 10.500 | 0 | 32394.500 |
| s3-step9-gating | pass | 1 | 2 | 118589.500 | 0.484 | 5.500 | 0 | 10998.500 |
| s4-step10-merging | pass | 1 | 2 | 118913 | 0.460 | 6 | 0 | 10857.500 |
| s5-open-pr-implementing | fail | 0.900 | 2 | 118958.500 | 0.475 | 5 | 0 | 11669.500 |

Suite score: **0.980** (4/5 passed, 1 failed, 0 errored, $5.608)
