# Applier replay

Does telling the edit-applier to run its verify with an explicit 10-minute timeout, and to format its changed files in the same Bash call as the first verify, cost anything on real edit-sets? This file records the replay that decides it. The rule below was written before any run, so the verdict cannot be fitted to the results. The before-state it is measured against is [applier-turn-baseline-2026-10.md](applier-turn-baseline-2026-10.md).

## Method

- **Cases.** Four recorded flow-repo edit-applier spawns, snapshotted into `docs/eval/applier-replay/cases/` before their transcripts age out of the local store: PR #900 (9 entries), #898 (21), #895 (15, one parked verify) and #885 (8). Each case holds the spawn prompt, the edit-set, any `.flow-tmp/` file the recorded run read, the base commit and the recorded run's waste counts. PR #885 stands in for the originally planned #887: #887's edit-set touches no file with a test at its base, so it would fail rule (b) by construction.
- **Base commit.** The latest PR commit at or before the spawn, else the parent of the PR's first commit. Each run checks that commit out in a fresh detached worktree, replaces any tracked `node_modules` entry with a link to the canonical checkout's `node_modules`, and restores the `.flow-tmp/` files the recorded run read.
- **Arms.** Same prompt, same base commit, only the instruction file differs. Before is `skills/pipeline/flow-coder-instructions/SKILL.md` as of commit `428642c`; after is this branch's copy. The prompt's worktree, instruction, skill-base and artifact paths are rewritten to the run's worktree and arm file.
- **Driver.** `bin/lib/eval-runner.ts` (`runScenarioOnce`), model `sonnet` (Sonnet 5.5), effort `medium`, tools Bash, Read, Edit, Write, Grep and Glob, budget $20 per run, 2,700 s timeout, concurrency 2. It runs with `--output-format stream-json`, so the child's tool calls stay observable; `flow-claude-headless` fixes `--output-format json` and would hide them, and a raw `claude -p` is forbidden by `bin/headless-claude-lint.test.ts`.
- **What a run measures.** Turns, waste events and verify calls come from the child's stream through `attributeSpawn` in `docs/eval/applier-turns.ts`. Cost is the result event's total. A run that stopped on budget, turn cap, timeout or any error is recorded with `error` set and counts as failed, never as a short run.
- **Tests.** After the agent finishes, `npx vitest run --reporter=json` runs the changed test files plus each changed file's colocated `<name>.test.ts`; the count is `numTotalTests`, and zero when no file is selected.
- **Final verify.** After the agent finishes, `env -u FLOW_SLUG flow-pre-commit --json` runs in the worktree, outside the agent, and records `allPassed`.
- **How to run.**
  1. `bun docs/eval/applier-replay.ts run --arm before --case docs/eval/applier-replay/cases/pr-900.json --out <dir>`, then the same with `--arm after`, for each of the four cases.
  2. `bun docs/eval/applier-replay.ts report --results <dir> --write-json docs/eval/applier-replay.json --check` prints the table and the verdict.
- **Limits.** The replayed child is a plain session that reads the instruction file, not the plugin agent with the instructions preloaded, so each arm pays one extra Read turn; the arms are compared with each other, never with the recorded turn counts. Only the edit-applier is replayed. The fix-applier and `/flow-verify` carry the same two sentences with no replay evidence of their own.

## Pre-registered rule

Ship only if, for every case:

- (a) after.finalVerify matches before.finalVerify: a before-pass must be an after-pass. The harness also fails the rule when either arm has no final verify outcome; a before-fail that becomes an after-pass is accepted.
- (b) after.tests >= before.tests, and both are above zero.

And, summed over the cases:

- (c) after (prettierRounds + parkedVerifies) <= before.
- (d) after turns <= 1.10 × before turns. The 10% absorbs run-to-run noise; a change sold as a turn cut must not raise spend.
- (e) every after-arm run has verifyCallsWithTimeout == verifyCalls and verifyCalls > 0. The flow cases verify too fast to park, so instruction compliance is the observable proxy for the stall fix.

A case failing (a) or (b) gets one re-run of both arms; the re-run's rows replace the first run's in the verdict and both stay in the results file. A repeat miss means no-ship.

On no-ship, revert the added timeout and format-first sentences but keep the corrected "does not format" wording, and adjust the first assertion of `bin/applier-verify-contract-lint.test.ts` to match.

## Results

Pending — not yet run.
