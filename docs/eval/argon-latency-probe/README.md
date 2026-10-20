# argon-latency-probe (Stage 0)

A maintainer-only, hand-run harness. It is not a flow helper: it is not on
PATH, not in `bin/lib/modules.ts`, and not wired into CI. It exists so the
time limits on every Argon-routed flow step come from measured answer time
under production conditions, not from a guess.

## Why it exists

Three Argon calls in the pipeline that produced this harness were cut at
their 3-minute limit with nothing to show for it: the research gather had
spent 163 s of model time, the first plan reviewer had written 24 KB of
findings, and the first method-survey judge returned nothing. A fixture
bench (`bin/flow-model-bench.ts`) measures single-shot fixture time, not
how long an agentic, repo-reading answer takes, so it cannot size these
limits. This probe re-runs the real calls.

## What it runs

Each call is built by the step's own production prompt builder with the
step's production read-access / web-search posture, and dispatched one at a
time through `flow-delegate-fanout` with a 20-minute cap:

| Surface           | Prompt builder                                          | Posture                            | Input                         |
| ----------------- | ------------------------------------------------------- | ---------------------------------- | ----------------------------- |
| `research-gather` | `buildManifest` in `bin/flow-research-run.ts`           | `skipPermissions`, no `addDirs`    | `inputs/research-question.md` |
| `plan-review`     | `buildBatteryPrompt` in `bin/lib/plan-review-prompt.ts` | `addDirs: [worktree]`              | `inputs/plan.md`              |
| `blind-survey`    | `buildSurveyPrompt` in `bin/lib/blind-survey-prompt.ts` | `addDirs: [worktree]`              | `inputs/survey-brief.md`      |
| `intent-guess`    | `buildPrompt` in `bin/flow-gemini-intent-guess.ts`      | `addDirs: [worktree]`, wire schema | `inputs/pr-941.diff`          |
| `review-lens`     | `buildPrompt` in `bin/flow-gemini-lens.ts`              | `addDirs: [worktree]`, wire schema | `inputs/pr-941.diff`          |

The inputs are committed copies of this pipeline's own timed-out calls (the
research question, the plan as review input, the survey brief) plus PR #941's
diff for the two opt-in review steps. Models are agy display names:
`Gemini 4 Argon (High)` and `Gemini 4 Argon (Medium)` by default.

`--capped-gather` adds one extra surface, `research-gather-capped`: the
production gather prompt plus "Use at most 3 searches and read at most 8 pages
before answering." (High only, 3 repeats). It is recorded beside the uncapped
gather, not sized as a production step.

## The sizing rule (committed before any probe call)

Per step and per model, over that model's records for the step:

- limit = ceil(max(600, 3 x median wall seconds) / 60) minutes;
- the limit is capped at 20 minutes; a step that would need more is marked
  `limit-mismatch` rather than given more time;
- a step is `stalls` for a model when at least two thirds of that model's calls
  came back empty (a timed-out call counts as empty);
- otherwise the verdict is `fits`.

So every limit is at least 10 minutes, and a step is raised above 10 minutes
only where the measured median is above 200 seconds. A step that `stalls` on
Argon High keeps its old limit and is named in the PR; a step that stalls on
High but `fits` on Medium becomes a `DECISION:` item for the maintainer. No
limit is changed by this harness: `sizeLimit` only reports.

## Run it

```sh
bun docs/eval/argon-latency-probe/run.ts --worktree <repo-dir> --out <out-dir> \
  [--models <csv>] [--timeout 20m] [--repeats research-gather=3,plan-review=3,...] \
  [--surfaces <csv>] [--capped-gather]
```

Default repeats: 3 each for `research-gather`, `plan-review`, `blind-survey`;
2 each for `intent-guess`, `review-lens`.

- Cost: about 26 Argon calls (13 per model), plus 3 for `--capped-gather`.
- Output: `<out-dir>/records.json` (`{ measuredAt, records, limits }`), rewritten
  atomically after every call, so a halt keeps the evidence so far. Prompts,
  schemas and raw answers sit beside it under `prompts/`, `raw/`, `results/`.
- Calls are ordered surface by surface (repeat, then model), so a partial run
  still has High and Medium side by side for the early surfaces.

### Quota stop

The probe stops at the first quota refusal (a delegate envelope whose
`failureClass` is `quota-exhausted`), writes what it has, prints how many
calls were not run, and exits 3. A refused call is not recorded: it carries no
latency signal. Wait for the quota window to reset (five hours on the Google
AI Ultra plan) and re-run only the missing surfaces with `--surfaces` and
`--repeats`, into the same `--out` directory. The re-run loads the earlier
`records.json`, keeps the records of every surface it does not re-measure, and
replaces the records of a surface it does, so limits are sized over the merged
set. A call that never reached the model (agy missing or logged out) is left
out of the sizing: it carries no answer time.

### Detach-and-wait launch

A full run exceeds one tool call's 10 minutes. Launch it detached and re-arm
the bounded waiter on its stdout log, which stays empty until the run prints
its one-line summary (`{"code":0,"recorded":26,"planned":26}`):

```sh
mkdir -p <out-dir>
rm -f <out-dir>/probe.log
PID=$(flow-spawn --detach --stdout <out-dir>/probe.log --stderr <out-dir>/probe.err \
  -- bun docs/eval/argon-latency-probe/run.ts --worktree <repo-dir> --out <out-dir>)
flow-plan-review-wait <out-dir>/probe.log --complete-line --pid "$PID" --max-sec 540
```

Re-run the `flow-plan-review-wait` line (Bash `timeout: 600000`) until it
prints `"outcome":"complete"` (the summary line is there) or
`"outcome":"process-exited-without-result"` (the run died; the records so far
are still in `<out-dir>/records.json`). `records.json` appears after the first
call, so it is not the done signal. The summary's `code` is the exit code
(3 = quota stop); `<out-dir>/probe.err` carries the quota line.
