# Applier turn baseline (2026-10)

Where the edit-applier and fix-applier spend their turns, measured on 2026-10-05 from the local Claude Code transcript store, before the verify-call instruction changes in this PR. The replay record in [applier-replay.md](applier-replay.md) and the analysis in [../token-spend-analysis.md](../token-spend-analysis.md) cite this file as the before-state.

## Method

- Command: `bun docs/eval/applier-turns.ts --since 2026-09-05` for the whole window, and the same with `--model claude-sonnet-5-5` for the split below. The tool's output follows verbatim; only the heading levels in the Sonnet 5.5 split are demoted.
- Window actually held at run time: the earliest applier transcript in the store starts 2026-09-05T16:53Z, the latest 2026-10-05T23:41Z. 231 applier transcripts across flow, econ-data and pokemon matched; the totals are in the sections below.
- A turn is one unique assistant `message.id` with usage. A turn with several tool calls splits evenly across their categories. Turn identity is checked against `walkFile` from `docs/eval/token-spend-audit.ts`; the last line of the output reports how many spawns disagree (none).
- Discovery's two same-day readings of the same `--since 2026-09-05` window, taken minutes apart while the store was being garbage-collected: 145 edit-applier spawns and 13,979 turns, then 128 spawns and 11,683 turns (fix-applier 95 / 8,430, then 87 / 7,521). This run reads 139 edit-applier spawns and 12,093 turns (fix-applier 92 / 7,616): the old end of the window keeps shrinking while new spawns land, so no later run will reproduce these totals.
- Failed-verify classes and the verify-round accounting port `verify-loop-anatomy.py` from discovery. A verify is a `flow-pre-commit` or `npm run verify` Bash call; `which`, `pgrep`, `cat`, quoted mentions and heredoc bodies are not.
- Discovery's correlation reading (2026-10-05, its 128 edit-applier spawn snapshot, `--since 2026-09-05`; edit-set size recoverable for 102 of them): per-spawn turns against edit-set size r = 0.55, about 3.2 turns per edit on a 47-turn base; per-spawn turns against full-verify count r = 0.02. Turn count tracks how much the edit-set asks for, not how often the spawn verifies. Figures are from discovery's `turn-attribution.md`, not recomputed by `applier-turns.ts`.

## Where edit-applier turns go

139 spawns, 12,093 turns, $490.40 list price. Turns per spawn: p50 73, p90 160, max 413.

| Category                          | Turns   | Share |
| --------------------------------- | ------- | ----- |
| edit                              | 2,307.1 | 19.1% |
| bash-search                       | 1,907.4 | 15.8% |
| bash-read                         | 1,895.3 | 15.7% |
| test:targeted                     | 890.2   | 7.4%  |
| read:first                        | 735.6   | 6.1%  |
| bash-mutate-or-script             | 523.5   | 4.3%  |
| artifact                          | 469.5   | 3.9%  |
| typecheck-lint-format             | 454.7   | 3.8%  |
| read:after-own-edit               | 422     | 3.5%  |
| bash-other                        | 416     | 3.4%  |
| git-inspect                       | 328.1   | 2.7%  |
| read:re-read-unchanged            | 293.8   | 2.4%  |
| read:after-tool-error             | 260.2   | 2.2%  |
| edit:refused                      | 225.6   | 1.9%  |
| verify:flow-pre-commit            | 220.5   | 1.8%  |
| verify:wait-poll                  | 143.5   | 1.2%  |
| text-only                         | 118     | 1.0%  |
| test:full                         | 114     | 0.9%  |
| git-gh-write                      | 99.5    | 0.8%  |
| handback                          | 84      | 0.7%  |
| verify:npm-verify                 | 45      | 0.4%  |
| tool-error:read:first             | 28      | 0.2%  |
| tool-error:bash-read              | 22.5    | 0.2%  |
| edit:failed                       | 18      | 0.1%  |
| tool-error:typecheck-lint-format  | 13.3    | 0.1%  |
| tool-error:bash-other             | 12.3    | 0.1%  |
| tool-error:bash-search            | 12      | 0.1%  |
| tool-error:bash-mutate-or-script  | 9       | 0.1%  |
| tool-error:read:re-read-unchanged | 9       | 0.1%  |
| tool-error:artifact               | 4.3     | 0.0%  |
| tool-error:git-inspect            | 3       | 0.0%  |
| tool-error:Monitor                | 2       | 0.0%  |
| tool-error:bash                   | 2       | 0.0%  |
| tool-error:git-gh-write           | 2       | 0.0%  |
| tool-error:read:after-tool-error  | 1       | 0.0%  |
| tool-error:read:after-own-edit    | 1       | 0.0%  |

## Where fix-applier turns go

92 spawns, 7,616 turns, $260.96 list price. Turns per spawn: p50 68, p90 154, max 221.

| Category                          | Turns   | Share |
| --------------------------------- | ------- | ----- |
| edit                              | 1,134.2 | 14.9% |
| bash-read                         | 1,087.5 | 14.3% |
| bash-search                       | 1,087.3 | 14.3% |
| bash-other                        | 462.5   | 6.1%  |
| bash-mutate-or-script             | 442     | 5.8%  |
| test:targeted                     | 435     | 5.7%  |
| git-inspect                       | 416.3   | 5.5%  |
| git-gh-write                      | 379.5   | 5.0%  |
| read:first                        | 320.3   | 4.2%  |
| read:after-own-edit               | 235     | 3.1%  |
| read:after-tool-error             | 200     | 2.6%  |
| edit:refused                      | 195.5   | 2.6%  |
| verify:flow-pre-commit            | 184     | 2.4%  |
| artifact                          | 167.3   | 2.2%  |
| verify:wait-poll                  | 149     | 2.0%  |
| typecheck-lint-format             | 141     | 1.9%  |
| toolsearch                        | 106     | 1.4%  |
| read:re-read-unchanged            | 98.5    | 1.3%  |
| text-only                         | 92      | 1.2%  |
| handback                          | 63.5    | 0.8%  |
| test:full                         | 51      | 0.7%  |
| verify:npm-verify                 | 45      | 0.6%  |
| tool-error:read:first             | 17      | 0.2%  |
| skill:flow-verify                 | 17      | 0.2%  |
| edit:failed                       | 14      | 0.2%  |
| tool-error:bash-search            | 13      | 0.2%  |
| tool-error:bash-other             | 11      | 0.1%  |
| tool-error:bash-mutate-or-script  | 9       | 0.1%  |
| tool-error:git-gh-write           | 8       | 0.1%  |
| tool-error:bash-read              | 7.5     | 0.1%  |
| tool-error:git-inspect            | 6       | 0.1%  |
| tool-error:read:re-read-unchanged | 6       | 0.1%  |
| mcp                               | 4       | 0.1%  |
| tool-error:artifact               | 4       | 0.1%  |
| tool-error:bash                   | 2.5     | 0.0%  |
| tool-error:typecheck-lint-format  | 2       | 0.0%  |
| tool-error:skill:flow-verify      | 1.5     | 0.0%  |
| tool-error:read:after-tool-error  | 1       | 0.0%  |

## Verify rounds

### edit-applier

Full verify runs per spawn: total 266, p50 2, p90 3, max 7. Last verify outcome: pass 67, fail 16, unparsed 56 of 139 spawns.

| Failed-verify class      | Rounds | Turns until next verify | Next verify                                     |
| ------------------------ | ------ | ----------------------- | ----------------------------------------------- |
| lint-only (prettier)     | 28     | 86                      | pass 14, unknown 7, no further verify 5, fail 2 |
| unparsed-fail            | 23     | 97                      | pass 12, unknown 5, fail 2, no further verify 4 |
| tests                    | 2      | 11                      | no further verify 1, pass 1                     |
| typecheck                | 1      | 21                      | fail 1                                          |
| lint-only (eslint/other) | 1      | 13                      | pass 1                                          |

### fix-applier

Full verify runs per spawn: total 229, p50 2, p90 5, max 11. Last verify outcome: pass 58, fail 6, unparsed 28 of 92 spawns.

| Failed-verify class      | Rounds | Turns until next verify | Next verify                         |
| ------------------------ | ------ | ----------------------- | ----------------------------------- |
| lint-only (prettier)     | 19     | 37                      | pass 15, fail 1, unknown 3          |
| tests                    | 3      | 23                      | pass 1, no further verify 2         |
| lint-only (eslint/other) | 3      | 36                      | fail 1, no further verify 1, pass 1 |
| unparsed-fail            | 2      | 10                      | unknown 1, pass 1                   |
| typecheck                | 1      | 4                       | unknown 1                           |

## Mechanical waste

| Event                                                          | edit-applier                       | fix-applier                        |
| -------------------------------------------------------------- | ---------------------------------- | ---------------------------------- |
| Verify moved to background (Bash 120 s default)                | 33 runs in 30 spawns               | 35 runs in 31 spawns               |
| Verify started with run_in_background (agent's own workaround) | 17 runs in 13 spawns               | 10 runs in 8 spawns                |
| Polling calls (sleep loops, output reads)                      | 144                                | 149                                |
| Prettier-only lint failure, extra verify round                 | 28 rounds, 86 turns to next verify | 19 rounds, 37 turns to next verify |
| Edit refused: file not opened with Read                        | 243 errors in 95 spawns            | 201 errors in 61 spawns            |
| Verify calls with timeout >= 600000 / all verify calls         | 79 / 266                           | 33 / 229                           |

Turn-identity check against token-spend-audit walkFile: 0 of 231 spawns differ.

## Sonnet 5.5 only

`--model claude-sonnet-5-5`: the coder alias `sonnet` resolves to Sonnet 5.5 from 2026-09-28, so this is the closest read of current behaviour. The sample is small and the task mix differs from the Sonnet 5 majority; read direction only.

### Where edit-applier turns go

29 spawns, 1,374 turns, $44.89 list price. Turns per spawn: p50 40, p90 88, max 121.

| Category                         | Turns | Share |
| -------------------------------- | ----- | ----- |
| bash-read                        | 331   | 24.1% |
| bash-search                      | 167.5 | 12.2% |
| test:targeted                    | 165.5 | 12.0% |
| bash-mutate-or-script            | 151   | 11.0% |
| typecheck-lint-format            | 108   | 7.9%  |
| bash-other                       | 91    | 6.6%  |
| git-inspect                      | 73.1  | 5.3%  |
| artifact                         | 49    | 3.6%  |
| verify:flow-pre-commit           | 47.5  | 3.5%  |
| git-gh-write                     | 38    | 2.8%  |
| handback                         | 27    | 2.0%  |
| verify:wait-poll                 | 24.5  | 1.8%  |
| edit                             | 18    | 1.3%  |
| test:full                        | 13    | 0.9%  |
| verify:npm-verify                | 12    | 0.9%  |
| read:first                       | 9.2   | 0.7%  |
| tool-error:bash-read             | 8     | 0.6%  |
| tool-error:typecheck-lint-format | 8     | 0.6%  |
| text-only                        | 8     | 0.6%  |
| tool-error:bash-other            | 6     | 0.4%  |
| tool-error:bash-mutate-or-script | 4     | 0.3%  |
| tool-error:bash-search           | 3     | 0.2%  |
| edit:refused                     | 2.8   | 0.2%  |
| tool-error:Monitor               | 2     | 0.1%  |
| tool-error:bash                  | 2     | 0.1%  |
| read:after-tool-error            | 1.5   | 0.1%  |
| tool-error:artifact              | 1     | 0.1%  |
| tool-error:git-inspect           | 1     | 0.1%  |
| tool-error:git-gh-write          | 1     | 0.1%  |
| read:re-read-unchanged           | 0.5   | 0.0%  |

### Where fix-applier turns go

22 spawns, 614 turns, $19.65 list price. Turns per spawn: p50 20, p90 46, max 90.

| Category                     | Turns | Share |
| ---------------------------- | ----- | ----- |
| bash-read                    | 96    | 15.6% |
| bash-mutate-or-script        | 78    | 12.7% |
| test:targeted                | 68    | 11.1% |
| git-inspect                  | 60.7  | 9.9%  |
| verify:flow-pre-commit       | 51    | 8.3%  |
| bash-search                  | 46.5  | 7.6%  |
| git-gh-write                 | 35    | 5.7%  |
| bash-other                   | 31.5  | 5.1%  |
| verify:wait-poll             | 23    | 3.7%  |
| handback                     | 21.5  | 3.5%  |
| artifact                     | 20    | 3.3%  |
| skill:flow-verify            | 15    | 2.4%  |
| typecheck-lint-format        | 15    | 2.4%  |
| verify:npm-verify            | 13    | 2.1%  |
| test:full                    | 10    | 1.6%  |
| text-only                    | 8     | 1.3%  |
| read:first                   | 3.2   | 0.5%  |
| tool-error:artifact          | 3     | 0.5%  |
| read:after-tool-error        | 3     | 0.5%  |
| toolsearch                   | 3     | 0.5%  |
| tool-error:bash              | 2.5   | 0.4%  |
| tool-error:bash-read         | 2.5   | 0.4%  |
| tool-error:skill:flow-verify | 1.5   | 0.2%  |
| edit:refused                 | 1     | 0.2%  |
| tool-error:bash-other        | 1     | 0.2%  |
| edit                         | 0.7   | 0.1%  |
| read:re-read-unchanged       | 0.5   | 0.1%  |

### Verify rounds

#### edit-applier

Full verify runs per spawn: total 60, p50 2, p90 4, max 6. Last verify outcome: pass 14, fail 4, unparsed 11 of 29 spawns.

| Failed-verify class  | Rounds | Turns until next verify | Next verify                            |
| -------------------- | ------ | ----------------------- | -------------------------------------- |
| lint-only (prettier) | 6      | 12                      | unknown 3, pass 2, no further verify 1 |
| unparsed-fail        | 3      | 4                       | pass 2, unknown 1                      |

#### fix-applier

Full verify runs per spawn: total 64, p50 3, p90 4, max 5. Last verify outcome: pass 15, fail 2, unparsed 5 of 22 spawns.

| Failed-verify class  | Rounds | Turns until next verify | Next verify         |
| -------------------- | ------ | ----------------------- | ------------------- |
| lint-only (prettier) | 3      | 3                       | pass 3              |
| unparsed-fail        | 1      | 1                       | unknown 1           |
| tests                | 1      | 4                       | no further verify 1 |

### Mechanical waste

| Event                                                          | edit-applier                      | fix-applier                      |
| -------------------------------------------------------------- | --------------------------------- | -------------------------------- |
| Verify moved to background (Bash 120 s default)                | 5 runs in 5 spawns                | 8 runs in 7 spawns               |
| Verify started with run_in_background (agent's own workaround) | 2 runs in 2 spawns                | 3 runs in 2 spawns               |
| Polling calls (sleep loops, output reads)                      | 25                                | 23                               |
| Prettier-only lint failure, extra verify round                 | 6 rounds, 12 turns to next verify | 3 rounds, 3 turns to next verify |
| Edit refused: file not opened with Read                        | 6 errors in 3 spawns              | 2 errors in 2 spawns             |
| Verify calls with timeout >= 600000 / all verify calls         | 29 / 60                           | 26 / 64                          |

Turn-identity check against token-spend-audit walkFile: 0 of 51 spawns differ.

## Caveats

- The transcript store garbage-collects at about 30 days, so the oldest part of the window is disappearing between runs. This file is the durable copy of a reading that cannot be repeated.
- The totals include the edit-applier spawn that implemented this PR (still running when the tool ran), and the fix-applier and edit-applier spawns of pipelines that were mid-flight. Their share of the window is small.
- Windows are cut on each spawn's first record timestamp, while `token-spend-audit.ts` cuts per turn. Totals can differ from the audit's by a few turns at the window edge.
- The tool tags a verify as parked only on the Bash tool's `moved to the background` result. A verify the agent started itself with `run_in_background` is counted on its own row, with its polling. A longer `timeout` does not fully prevent parking: of 68 parked verify runs across both appliers, 13 carried a `timeout` of 300000 or more and parked anyway (econ-data runs that outlast the cap).
- Verify outcomes are read from the result text. Spawns that pipe the report through `tail` or `jq` can leave the last outcome unparsed; the tool reports that count instead of guessing.
- Refused edits ("file has not been read yet") fell from 424 on Sonnet 5 to 5 in 35 Sonnet 5.5 spawns in discovery's split; the Sonnet 5.5 section above shows the same pattern on today's store.
- Classifier fix after this run. The tool first matched `npm run verify` against the raw command, so a heredoc that wrote a file mentioning it counted as a verify call. The fix matches it on the same stripped text as `flow-pre-commit`. The store aged between the two readings, so the figures below come from one same-moment run of the old and the fixed code (`--since 2026-09-05`, 140 edit-applier and 93 fix-applier spawns; the verbatim tables above are the earlier reading and are unchanged). Total full verify calls: edit-applier 269 to 254, fix-applier 231 to 217. `verify:npm-verify` turns: edit-applier 47 to 32 (0.4% to 0.3% of 12,162), fix-applier 45 to 31 (0.6% to 0.4% of 7,632). `verify:flow-pre-commit` turns are unchanged at 221.5 and 186. With the fix, full verify calls are 2.1% of edit-applier turns (221.5 + 32 of 12,162) and 2.8% of fix-applier turns.
- The `Verify moved to background (Bash 120 s default)` row label in the table above names the Bash default, but a parked verify parks at whatever timeout its call carried: a separate scan during implementation (applier transcripts modified since 2026-09-05, a looser match than this tool's, 78 parked verify results) found every one of the 20 calls with an explicit timeout parked at exactly that timeout, 11 of them at 600 s and 4 at 300 s. It is not this tool's count, so it need not match the 13 in the caveat above. The row counts every parked run, not only the 120 s default.
- Fixes after this reading, tables above left verbatim. (1) The tool now reads the verify verdict from the last `allPassed` match, not the first, which could come from a quoted failure excerpt. (2) A backgrounded verify that later reports a failure now opens a failed round, so its Prettier or other-failure round counts in `Mechanical waste` (this reading omitted those). (3) The row above is renamed `Verify parked in background (at the call's timeout)` in the tool's output. (4) `--since` now rejects an impossible calendar date instead of reporting all history. Re-running the tool on a later window can therefore differ from these tables in rounds and labels.
