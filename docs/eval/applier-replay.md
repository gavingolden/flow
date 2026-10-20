# Applier replay

Does telling the edit-applier to run its verify with an explicit 10-minute timeout, and to format its changed files in the same Bash call as the first verify, cost anything on real edit-sets? This file records the replay that decides it. The rule below was written before any run, so the verdict cannot be fitted to the results. The before-state it is measured against is [applier-turn-baseline-2026-10.md](applier-turn-baseline-2026-10.md).

## Method

- **Cases.** Four recorded flow-repo edit-applier spawns, snapshotted into `docs/eval/applier-replay/cases/` before their transcripts age out of the local store: PR #900 (9 entries), #898 (21), #895 (15, one parked verify) and #885 (8). Each case holds the spawn prompt, the edit-set, any `.flow-tmp/` file the recorded run read, the base commit and the recorded run's waste counts. PR #885 stands in for the originally planned #887: #887's edit-set touches no file with a test at its base, so it would fail rule (b) by construction.
- **Base commit.** The latest PR commit at or before the spawn, else the parent of the PR's first commit. Each run checks that commit out in a fresh detached worktree, replaces any tracked `node_modules` entry with a link to the canonical checkout's `node_modules`, and restores the `.flow-tmp/` files the recorded run read.
- **Arms.** Same prompt, same base commit, only the instruction file differs. Before is `skills/pipeline/flow-coder-instructions/SKILL.md` as of commit `428642c`; after is `flow-coder-instructions/SKILL.md` as of commit `19c2228`, the tested instructions, which `run` reads with `git show` so a later revert on the branch cannot change the arm. The prompt's worktree, instruction, skill-base and artifact paths are rewritten to the run's worktree and arm file.
- **Driver.** `bin/lib/eval-runner.ts` (`runScenarioOnce`), model `sonnet` (Sonnet 5.5), effort `medium`, tools Bash, Read, Edit, Write, Grep and Glob, budget $20 per run, 2,700 s timeout, concurrency 2. It runs with `--output-format stream-json`, so the child's tool calls stay observable; `flow-claude-headless` fixes `--output-format json` and would hide them, and a raw `claude -p` is forbidden by `bin/headless-claude-lint.test.ts`.
- **What a run measures.** Turns, waste events and verify calls come from the child's stream through `attributeSpawn` in `docs/eval/applier-turns.ts`. Cost is the result event's total. A run that stopped on budget, turn cap, timeout or any error is recorded with `error` set and counts as failed, never as a short run.
- **Tests.** After the agent finishes, `npx vitest run --reporter=json` runs the changed test files plus each changed file's colocated `<name>.test.ts`; the count is `numTotalTests`, and zero when no file is selected.
- **Final verify.** After the agent finishes, `env -u FLOW_SLUG flow-pre-commit --json` runs in the worktree, outside the agent, and records `allPassed`.
- **How to run.**
  1. `bun docs/eval/applier-replay.ts run --arm before --case docs/eval/applier-replay/cases/pr-900.json --out <dir>`, then the same with `--arm after`, for each of the four cases. A second `run` of the same case and arm into the same `--out` keeps the earlier stream and result as `<case>-<arm>-run1` (then `-run2`, ...); `report` takes the latest run per case and arm.
  2. `bun docs/eval/applier-replay.ts report --results <dir> --write-json docs/eval/applier-replay.json --check` prints the table and the verdict.
  3. `bun docs/eval/applier-replay.ts rescore --dir <dir>` recomputes the stream-derived fields from each saved `stream.jsonl` with the current classifier, leaving cost, final verify, tests and error as recorded. It costs nothing.
- **Limits.** The replayed child is a plain session that reads the instruction file, not the plugin agent with the instructions preloaded, so each arm pays one extra Read turn; the arms are compared with each other, never with the recorded turn counts. Only the edit-applier is replayed. The fix-applier and `/flow-verify` carried the same two sentences (now reverted) with no replay evidence of their own.

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

The verdict uses the last run of each case and arm. pr-898 was re-run once in both arms under the rule's re-run clause; its first-run rows (after 44 turns, 913 tests; before 47 turns, 916 tests) stay in `applier-replay.json`.

| Case   | Arm    | Turns | Cost  | Full verifies | Parked verifies | Prettier-only rounds | Verify calls with timeout / total | Final verify | Tests | Error |
| ------ | ------ | ----- | ----- | ------------- | --------------- | -------------------- | --------------------------------- | ------------ | ----- | ----- |
| pr-885 | after  | 19    | $0.78 | 1             | 0               | 0                    | 1 / 1                             | pass         | 144   |       |
| pr-885 | before | 16    | $0.75 | 1             | 0               | 0                    | 0 / 1                             | pass         | 144   |       |
| pr-895 | after  | 42    | $1.75 | 1             | 0               | 0                    | 1 / 1                             | fail         | 933   |       |
| pr-895 | before | 44    | $1.87 | 1             | 0               | 0                    | 0 / 1                             | fail         | 933   |       |
| pr-898 | after  | 46    | $1.81 | 1             | 0               | 1                    | 1 / 1                             | fail         | 915   |       |
| pr-898 | before | 47    | $1.89 | 1             | 0               | 1                    | 1 / 1                             | fail         | 919   |       |
| pr-900 | after  | 21    | $0.59 | 1             | 0               | 0                    | 1 / 1                             | pass         | 77    |       |
| pr-900 | before | 16    | $0.52 | 1             | 0               | 0                    | 0 / 1                             | pass         | 77    |       |

**Verdict:** no-ship

## Reading the results

**The two verify-call fixes do not ship.** The added `timeout: 600000` and format-first sentences are reverted; only the corrected "does not format" wording stays. One case missed the pre-registered test-count rule twice.

1. **Rule (b) missed on pr-898, twice.** The after arm counted 913 tests against 916 on the first run, and 915 against 919 on the re-run the rule allows. Both arms add tests while applying the same edit-set; the after arm added three or four fewer each time. Two runs cannot tell instruction effect from noise, but the rule asks for no loss in coverage and a repeat miss is no-ship by its own terms.
2. **Rule (e) holds in all four cases.** Every after-arm run made exactly one verify call and it carried `timeout: 600000` (4 of 4). Before-arm runs mostly made the call without a timeout (pr-898's re-run set one unprompted). Seeing this took a rescore: the first classifier counted pr-895's heredocs that mention `npm run verify` as verify calls, which made the rule look broken there (see correction ii).
3. **What held.** Final verify is identical in all 4 cases: pr-885 and pr-900 pass in both arms, pr-895 and pr-898 fail in both arms, so (a) holds (pr-898's failure is a lint error already present at the base, on `docs/eval/fable-vs-opus-subagents.md`, a file neither arm touched). Summed turns are 128 after against 123 before (+4.1%, inside the 10% band); cost $4.94 against $5.03 (the raw per-run costs summed, then rounded once). Prettier-only rounds plus parked verifies are 1 against 1.
4. **The parked-verify stall cannot be observed on flow cases.** No verify parked in any arm, as the plan's risks predicted: flow's verify finishes well inside the Bash default, so the proxy for the stall fix was instruction compliance (rule e), not a prevented stall. The econ-data stall the fix targets was not replayed.
5. **Measurement corrections made during the run, each disclosed.**
   - (i) Test counts were first taken from the diff against HEAD, so cases whose prompts tell the agent to commit (pr-895, pr-898) counted 0 tests. The zero-test guard caught it. The harness now diffs against the base commit (commit `e5401f8`), and the three affected runs (pr-895 both arms, pr-898 before) were re-run, replacing the invalid rows; those re-runs fixed a harness bug and are not the rule's re-run.
   - (ii) The verify classifier matched `npm run verify` against the raw command, so a heredoc whose body mentions it counted as a verify call. It now matches on the same stripped text as `flow-pre-commit`. All rows were rescored from their saved stream traces with `rescore`; the changed fields were pr-895 after `fullVerifies` 2 to 1 and `verifyCalls` 2 to 1, and pr-895 before `fullVerifies` 4 to 1 and `verifyCalls` 4 to 1. The other rows were unchanged. The remaining call in each pr-895 arm is a real `npm run verify` that follows a heredoc in the same Bash command.
6. **Consequence applied.** The added timeout and format-first sentences are reverted in `flow-coder-instructions`, `flow-fix-applier-instructions` and `flow-verify`; the corrected "does not format" wording stays, and `bin/applier-verify-contract-lint.test.ts` now pins that wording instead of the timeout.
