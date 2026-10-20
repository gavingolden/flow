# Applier batching

Can one instruction paragraph make the edit-applier issue its independent lookups and edits together, and can one sentence stop its verify stalling on econ-data, without losing a passing final verify? This file records the replay that decides it. The rules below were written, and committed with the scorer in `docs/eval/applier-batching.ts`, before any paid run, so a verdict cannot be fitted to the results. The before-state is [applier-turn-baseline-2026-10.md](applier-turn-baseline-2026-10.md); the replay it extends, and the two verify-call fixes it declined, are [applier-replay.md](applier-replay.md).

## Method

- **Production fidelity figures.** Measured now with `bun docs/eval/applier-turns.ts --since 2026-09-28 --model claude-sonnet-5-5`, which prints for the edit-applier's 34 Sonnet 5.5 spawns (1,569 turns): Bash share 93.3%, shell operations per turn 3.7 (1,315 of 1,513 Bash calls chained), 1.1 tool calls per turn, 373 shell edit scripts (268 with a match guard, 2 failed with a traceback), and the Bash-first auto-mode reminder delivered in 34 of 34 spawns (32 relaxed wording, 2 strict). The scorer's fidelity gates read these as `{"bashShare": 0.933, "shellOpsPerTurn": 3.7}`. Shell operations per turn is every command in a Bash call (split on `&&`, `||`, `;` and newlines, heredoc bodies and a leading `cd` removed) summed over the spawn's turns.
- **Case selection.** From the recorded edit-applier spawns, keep implement-step spawns (an inline edit-set whose entries carry a `contract` field) whose recorded final verify passed, whose PR resolves from the worktree named in the spawn prompt, whose files the run read whole show no drift at the base commit, whose lockfile is unchanged since the base, and for which at least one vitest file is selected for the edit-set files (a changed test file, or the file's colocated `.test` or `.spec` sibling, including `.svelte.test.ts`, in any js/ts extension). Prefer Sonnet 5.5 recordings, then the most recent. The batching arm takes the four flow cases already snapshotted (PR #900, #898, #895, #885) plus four econ-data cases. The verify-timeout arm takes the four econ-data cases, at least two of them recorded with a verify that parked or ran in the background, when that many qualify. econ-data is a private repo: its case files live in `~/.flow/audits/applier-batching-2026-10/cases/`, are never committed, and only aggregate rows keyed `econ-data-<n>` reach this repo.
- **Base commit and tree.** The latest PR commit at or before the spawn, else the parent of the PR's first commit, as in the earlier replay. Each run checks it out in a fresh detached worktree of the case's own repo clone. `node_modules` is linked from that clone, and only the two files production symlinks into every worktree (`SYMLINK_FILES` in `bin/lib/worktree-fs.ts`: `.env` and `.claude/settings.local.json`) are linked; the clone's other `.env*` files, which include production-operations credentials, never reach the unattended child.
- **Arms.** Same prompt, same base commit, only the instruction file differs. `before` is `skills/pipeline/flow-coder-instructions/SKILL.md` as of commit `c51c3cc`. `batching` and `verify-timeout` are the committed files `docs/eval/applier-batching/arms/batching.md` and `docs/eval/applier-batching/arms/verify-timeout.md`: each is that same file with exactly one change (a rewritten read bullet in step 1 for batching; one prose paragraph after the verify command in step 3 for verify-timeout). The live skill is edited only on a `ship` verdict, and `report --check` fails when a shipped arm's marker is missing from it or a non-shipped arm's marker is present.
- **Driver.** `bin/lib/eval-runner.ts` (`runScenarioOnce`), model `sonnet` (Sonnet 5.5), effort `medium`, tools Bash, Read, Edit, Write, Grep and Glob, stream-json so the tool calls stay observable. The per-run timeout is `--timeout-sec`, default 2,700.
- **Reminder injection.** Every run's prompt gets the relaxed Bash-first auto-mode reminder appended, in `<system-reminder>` tags, so both arms see the habit-steering text production runs get. Production delivers it as a system attachment after the first tool call; the replay appends it to the user prompt because the eval runner's argv is shared by every flow-eval suite. That position difference is a disclosed limit, and the fidelity gates below are the check that the replayed habit still matches production's.
- **Instructions preloaded, with proof.** Each run copies its arm file into the run directory, inserts `<!-- replay-arm-token: <arm>-<uuid> -->` directly after the file's `flow-instructions-sentinel` line, and puts the whole file ahead of the spawn prompt, as production preloads it into the helper's context. The first smoke run left the instructions to a voluntary read: the child grepped the file for two fragments, never read step 1 or step 3, and recorded `instructionsRead: false`, so an arm's text could not have reached it. `instructionsRead` is true when the run's token is in the delivered prompt or appears in any tool result. A run without it cannot be scored. That smoke run is kept out of the results and re-run under the preload.
- **Artifact check.** `artifactValid` is true when the `coder-result.json` the prompt names parses, carries the six schema keys, accounts for every edit-set entry, and lists as `applied: true` only files present in the diff against the base. It catches an applier that reports an edit it never made.
- **What a run measures.** Turns, tool calls, Bash calls, shell operations, waste events and verify calls come from the child's stream through `attributeSpawn`. Cost is the result event's total. Tests are `numTotalTests` from `npx vitest run --reporter=json` over the selected files. The final verify is `flow-pre-commit --json` run outside the agent with `FLOW_SLUG` and `TMUX_PANE` removed. A run stopped by an error or timeout is recorded with `error` set and counts as failed.
- **Rate limits.** A run that stops on a usage or rate limit is recorded with `rateLimited: true`, is excluded from scoring, and is re-run after a backoff; it is never scored as a short run.
- **Past the 600 s ceiling.** The Bash tool's timeout caps at 600,000 ms. Per run the record keeps the verifies parked at that ceiling (`parkedVerifies`), the verifies started in the background (`backgroundedVerifies`), the polling calls after them (`pollCalls`) and the verify calls and full verifies, so a stalled verify and its re-launches are counted, not just its outcome.
- **How to run.** `bun docs/eval/applier-replay.ts map --since <date>` writes the spawn-to-PR map; `snapshot --pr <n> --repo <name> --repo-dir <clone> --out <dir>` writes a case (`--out` is required for any repo but flow, and must be outside this repo, because the case file carries the private repo's prompts and plan text); `run --arm <name> --instructions <ref>:<path>|<file> --case <file> --repo-dir <clone> --out <dir>` replays one arm. `bun docs/eval/applier-batching.ts report --results <dir|json> --production-json <file> --write-json docs/eval/applier-batching.json --check` prints both verdicts and writes the record.
- **Expected outcome.** `bun docs/eval/applier-turns.ts --since 2026-09-12 --repo <repo>` counts the edit-applier's lookup-only turns that directly follow another (the turns a batching rule can merge) at 430 of 2,380 flow turns (18.1%) and 1,002 of 4,684 econ-data turns (21.4%), all models. The planning estimate of 7.7% and 5.6% counted only chained shell lookups and missed Read, Grep, Glob and git inspection turns; the counter's figure is the reproducible one. A later fix to the lookup test (a `>` inside a quoted search pattern is not a redirect) moves a recount by at most 0.2 points and leaves shell operations per turn unchanged. So a batching `ship` is plausible but not expected: the ceiling assumes every adjacent lookup merges. The pre-registered 10% bar was set before this recount and does not depend on either figure.
- **Reminder text.** Transcripts record only the reminder's flag (`bashFirstSteer`), not its rendered text: `bun docs/eval/applier-batching.ts steer --since 2026-09-28` counts 33 `relaxed`, 2 `strict` and no no-reminder spawns over the 35 Sonnet 5.5 spawns in the map since 2026-09-28, using the same `attributeSpawn` rule as the figures above. Those were taken when 34 spawns had finished (32 relaxed, 2 strict), so the two counts differ by one later spawn, not by logic; an earlier run of this count also matched Opus 5.5 spawns, whose one no-reminder spawn is not a Sonnet 5.5 miss. The injected text is the relaxed wording as Claude Code rendered it into a live auto-mode session on 2026-10-06; it cannot be byte-checked against the recorded runs.
- **Limits.** The replayed child is a plain print-mode session with the arm's instructions preloaded into its prompt rather than the plugin agent's system context, so an arm's text sits in a different position than in production; arms are compared with each other, never with recorded turn counts. Only the edit-applier is replayed. Four-to-eight cases cannot separate a small effect from run-to-run noise (the earlier replay saw +4.1% turns on unchanged behaviour), which is why the turn bar is stated per arm and a miss reads as `not worth it`, not as proof of no effect.

## Pre-registered rule

An arm's verdict is computed by `armVerdict` in `docs/eval/applier-batching.ts` from the last result row of each case and arm; this section states exactly what it implements. In it, `before` is the arm named `before`, and `after` is the arm under test.

Which runs count:

- Runs with `rateLimited` are excluded and re-run.
- Later rows for a case and arm replace earlier ones; the earlier rows stay in the results file.
- Scope: the batching arm scores all cases; the verify-timeout arm scores the econ-data cases (case ids starting `econ-data-`).

Validity: every scored run has `steerInjected` and `instructionsRead` true. Otherwise the arm is `inconclusive`, naming the run.

Gates, checked first, each yielding `inconclusive` and naming the failed gate:

- (g1) The before arm's pooled Bash share (Bash calls over tool calls) is within 0.10 of production's.
- (g2) The before arm's pooled shell operations per turn is within 25% of production's.
- (g3) The before arm has at least `minBeforePasses` final-verify passes over the arm's scope: 3 for batching, 2 for verify-timeout.
- (g4, verify-timeout only) At least one parked or backgrounded verify across the before-arm runs.

Conditions, per case and summed over the cases with both arms:

- (a) A before-arm final-verify pass must be an after-arm pass, neither arm may be missing a final-verify outcome or a row, and neither arm's run may have stopped on an error or timeout. A case failing (a) gets one re-run of both arms; the re-run's rows replace the first run's, and a repeat miss fails.
- (b) Every run counts more than zero tests, and the summed after tests are at least the summed before tests.
- (e) Every after-arm run has `artifactValid` wherever its before-arm run does.
- (c) Batching: summed after turns are at most 0.90 of summed before turns, and summed after cost is at most summed before cost. Verify-timeout: summed after turns are at most summed before turns, and summed after cost is at most summed before cost.
- (d) Batching only: the pooled after shell operations per turn exceed the pooled before figure.
- (f) Verify-timeout only: the summed after (`parkedVerifies` + `backgroundedVerifies` + `pollCalls`) is below the summed before figure.

An arm is `ship` iff its gates pass and all its conditions hold; otherwise `no-change`. The verdict maps to the record's wording as `ship` to worth it, `no-change` to not worth it, and `inconclusive` to unmeasured, naming the failed gate or validity run. Each arm ships on its own verdict, and a `ship` edits the live `skills/pipeline/flow-coder-instructions/SKILL.md` with that arm's change only; otherwise the live file stays as it is and the result is recorded.

## Results

Both arms are `no-change`: neither rule ships, and `skills/pipeline/flow-coder-instructions/SKILL.md` is unchanged. The verdicts re-derive from [applier-batching.json](applier-batching.json) with `bun docs/eval/applier-batching.ts report --results docs/eval/applier-batching.json --check`.

- **Batching: no-change.** Summed turns 164 before and 165 after against a limit of 147.6 (c), and the habit did not move: 3.54 shell operations per turn before and 3.53 after (d). Pooled tests 2,480 against 2,479 (b). After the re-runs no final-verify pass was lost, but econ-data-4's batching run timed out and an errored run counts as failed under (a), so (a) fails as well; every run proved its instructions were delivered.
- **Verify timeout: no-change.** Summed turns 59 before and 55 after, and waits fell (parked, backgrounded and polling calls 11 against 5), but the after runs counted 410 tests against 415 (b). Its fidelity gates passed after the re-runs; before them, the econ-data before arm's Bash share was 0.81 against production's 0.933 and the arm read `inconclusive`.
- **Re-runs.** econ-data-2 (batching lost a pass: before passed, after failed) and econ-data-3 (two arms recorded no final-verify outcome) were re-run once in all three arms under the re-run clause; the later rows replace the earlier ones, and both stay in the JSON. The re-run of econ-data-2 passed in every arm.
- **Cost.** 27 scored runs recorded $16.93 at list price, plus three invalid smoke runs kept out of the results. econ-data-4's batching run hit the 5,400 s timeout after its edits and recorded no cost, so the batching total is a floor; the scorer treats that run as failed (a), and the verdict was already `no-change` on turns.
- **Machine load.** The replay ran beside other live pipelines at a load average of about 110 to 155. Each case's arms ran together so they shared the load, but econ-data verifies parked at the 600 s ceiling more than in production, which weakens the timeout arm's wait signal more than its turn and test counts.

The last run per case and arm:

<!-- prettier-ignore -->
| Case | Arm | Turns | Cost | Final verify | Tests | Shell ops per turn | Parked | Backgrounded | Polls |
|---|---|---|---|---|---|---|---|---|---|
| econ-data-1 | before | 13 | $0.46 | pass | 244 | 4.2 | 1 | 0 | 2 |
| econ-data-1 | batching | 14 | $0.48 | pass | 240 | 5.1 | 1 | 0 | 1 |
| econ-data-1 | verify-timeout | 17 | $0.55 | pass | 240 | 4.8 | 1 | 0 | 1 |
| econ-data-2 | before | 11 | $0.48 | pass | 19 | 3.7 | 1 | 0 | 1 |
| econ-data-2 | batching | 19 | $0.64 | pass | 19 | 2.1 | 1 | 0 | 3 |
| econ-data-2 | verify-timeout | 9 | $0.44 | pass | 19 | 3.4 | 0 | 0 | 1 |
| econ-data-3 | before | 13 | $0.40 | pass | 107 | 2.8 | 1 | 0 | 1 |
| econ-data-3 | batching | 15 | $0.46 | pass | 107 | 3.1 | 1 | 1 | 2 |
| econ-data-3 | verify-timeout | 10 | $0.43 | pass | 107 | 3.1 | 0 | 0 | 0 |
| econ-data-4 | before | 22 | $0.71 | fail | 45 | 2.3 | 1 | 1 | 2 |
| econ-data-4 | batching | 12 | timeout | pass | 46 | 3.2 | 1 | 0 | 2 |
| econ-data-4 | verify-timeout | 19 | $0.60 | fail | 44 | 1.6 | 1 | 0 | 1 |
| pr-885 | before | 15 | $0.63 | pass | 144 | 2.7 | 0 | 0 | 0 |
| pr-885 | batching | 15 | $0.65 | pass | 143 | 2.7 | 0 | 0 | 0 |
| pr-895 | before | 28 | $1.30 | fail | 933 | 4.9 | 0 | 0 | 0 |
| pr-895 | batching | 33 | $1.35 | fail | 933 | 4.4 | 0 | 0 | 0 |
| pr-898 | before | 37 | $1.39 | fail | 910 | 3.9 | 0 | 0 | 0 |
| pr-898 | batching | 38 | $1.43 | fail | 914 | 3.9 | 0 | 0 | 1 |
| pr-900 | before | 25 | $0.63 | pass | 78 | 3.1 | 0 | 0 | 0 |
| pr-900 | batching | 19 | $0.53 | pass | 77 | 2.8 | 0 | 0 | 0 |

pr-895 and pr-898 fail their final verify in both arms here, as they did in both arms of #910's replay, so they add no pass to lose.

## Also checked

- **Instructions were not reaching the replay child.** The first smoke run asked to read its instruction file grepped two fragments and never saw steps 1 or 3, so no instruction arm could have reached it; #910's replay used the same read-on-request delivery. The harness now preloads the arm text into the prompt, as production preloads it.
- **A backgrounded verify ends a print-mode run early.** econ-data-3's first batching run started its verify in the background, said it was waiting, and ended its turn, which ends a print-mode session: the verify was killed and the result file never finalised. The re-run did not repeat it.
- **Verify-fix cap.** No edit-applier spawn since 2026-09-12 went past the five-round cap: edit-separated fix rounds per spawn p50 0, max 3, none over 5 (`applier-turns.ts`). The "round 6" reading counted verify mentions.
- **Turn cap.** The 240-turn cap stays above the 2026-10 baseline's p90 of 160 (max 413); the edit-applier definition now cites both readings.
- **Shell-first habit.** 82 of 98 edit-applier spawns since 2026-09-12 received the auto-mode Bash-first reminder (65 relaxed, 17 strict); its 550 python edit scripts carried a match guard in 399 and failed with a visible traceback 3 times.
- **Next structural lever.** If turns still matter, pre-fetching each edit-set entry's file region in `/flow-coder` and passing it in the spawn prompt removes lookup turns without asking the model to batch; it changes the spawn template, so it needs its own replay.
