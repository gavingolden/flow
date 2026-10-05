# review-model-recall harness

A one-off, hand-run harness. It is **not** a supported flow helper: it is
not on PATH, not in `bin/lib/modules.ts`'s helper registry, not covered by
`bin/*.test.ts`, and not wired into `npm run verify` or CI. It exists only
so the measurement recorded in
[`../review-model-recall.md`](../review-model-recall.md) /
[`../review-model-recall.json`](../review-model-recall.json) is
reproducible from source instead of trusted on faith. See that write-up
for what the numbers do and do not support — this file only covers how
to re-run the harness itself.

## Scripts

| Script            | Job                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build-prompt.ts` | Assembles one review-lens prompt: the shared context block plus the per-lens section, both extracted live from `skills/pipeline/flow-pr-review/references/agent-prompts.md`, substituted with a PR's metadata/diff.                                                                                                                                     |
| `build-judge.ts`  | Builds the blinded scoring-judge prompt for one cell — never names which model (sonnet/opus) produced the candidate output, only the lens.                                                                                                                                                                                                              |
| `score.ts`        | Two subcommands: `extract` (diagnostic — parses each cell's raw result into a findings list, tolerant of prose-only output) and `aggregate` (reads judge outputs, computes per-cell/per-lens-arm recall stats and the separation verdict, in the same JSON shape as `../review-model-recall.json`).                                                     |
| `run.ts`          | Two subcommands: `matrix` (runs every review cell through `flow-claude-headless`) and `judge` (runs every judge cell). Resume-safe (skips a cell only when its output file is a successful `claude -p` result; error and budget-killed cells are retried) and bounded-concurrency. Model arms: `sonnet`, `opus`, `fable` (per-cell cap $6 / $14 / $20). |

All four are directly runnable (`chmod +x`, `#!/usr/bin/env bun`); none
are symlinked onto PATH.

## Invocation order

Everything below reads/writes a `<data-dir>` (default: this directory's `data/` subdirectory)
holding the per-PR inputs and the `runs/` / `judge/` cell outputs — see
"Inputs this harness needs" below for what has to exist in it before you
start.

```sh
# 1. Build one prompt per (lens, PR) pair — 9 prompts for the committed matrix.
for lens in bug-detection pattern-consistency test-coverage; do
  for pr in 812 756 802; do
    bun build-prompt.ts "$lens" "$pr" --data-dir <data-dir> \
      > "<data-dir>/prompt-$lens-$pr.txt"
  done
done

# 2. Run every review cell (3 lenses x 3 PRs x 2 arms x 2 runs = 36 cells).
bun run.ts matrix --data-dir <data-dir> --concurrency 6

# 3. Score each cell against its reference set with a blinded judge.
bun run.ts judge --data-dir <data-dir> --concurrency 6

# 4. (optional, diagnostic) Sanity-check how each cell's raw output parsed.
bun score.ts extract <data-dir>

# 5. Aggregate the judge outputs into the committed JSON shape.
bun score.ts aggregate <data-dir> > <data-dir>/scores.json
```

`run.ts`'s two subcommands are the only sanctioned spawn site for
headless Claude here — both shell out to `flow-claude-headless`
(`skills/pipeline/flow-pipeline/references/headless-claude.md`), the
repo's one sanctioned raw `claude -p` call site, with `env -u FLOW_SLUG
-u TMUX_PANE` so a nested run from inside a flow pipeline session cannot
trip the parent's stop guard or overwrite its state.

Run from a clean checkout of the default branch, same as the committed
measurement — a dirty worktree or a feature branch changes what the
review lenses see.

## Arbitrary arms (lens A/B on real PRs)

The harness is not limited to the sonnet/opus pair. The model-alias arms are
`sonnet`, `opus` and `fable` (e.g. `--arms fable,opus`; the default stays
`sonnet,opus`). Any other arm name runs `--model` (default `opus`) with the prompt file
`prompt-<lens>-<pr>-<arm>.txt` you place in the data dir, so two spawn
shapes, two prompt variants, or two config settings can be compared on the
same lenses and PRs:

```sh
D=<data-dir>
bun build-prompt.ts materialize <pr> --data-dir $D   # per-PR .flow-tmp-shaped inputs + ref files
# write $D/prompt-<lens>-<pr>-<armA>.txt and $D/prompt-<lens>-<pr>-<armB>.txt yourself
bun run.ts matrix --arms <armA>,<armB> --lenses bug-detection,pattern-consistency,test-coverage \
  --prs <pr>[,<pr>...] --runs 2 --model opus --data-dir $D --concurrency 6
bun run.ts judge  --arms <armA>,<armB> --lenses ... --prs ... --runs 2 --data-dir $D
bun score.ts aggregate $D
```

Flags: `--arms <csv>` (default `sonnet,opus`), `--lenses`, `--prs`, `--runs`,
`--model`. `materialize` writes `<D>/pr-<pr>/.flow-tmp/*` (fetch, commits,
capped diff via the production `capDiff`, intent comments, static-analysis
and review-scope stubs), `ref-<pr>.json` (all inline review comments) and
`ref-acted-<pr>.json` (the subset whose path a later `(pr-review #<pr>)`
fix-applier commit touched — the acted proxy, since resolved-thread state is
empty on flow PRs).

`score.ts aggregate` switches shape by arm set. For `sonnet,opus` it
prints the committed `../review-model-recall.json` shape unchanged. For any
other arms it prints `arms.<arm>` with `cost_usd {median, mean}`,
`num_turns {median}`, `duration_ms {median}`, `recall_all` and
`recall_acted`, plus `resolved_model_ids` (the dominant non-haiku
`modelUsage` key of each review cell, since the envelope only echoes the
alias). When exactly two arms were judged it also emits, per arm, per-PR
`{runs, mean_recall, variance}` and a per-lens `separation` block
(`baseline` is `opus` when present, `candidate`, `delta_mean_recall`,
`pooled_within_arm_sd`, `exact_permutation_p_one_sided` testing that the
candidate exceeds the baseline); deciding what counts as a pass is the
experiment's job.

Cost, turns and wall-clock are read from each cell's claude JSON
(`runs/<cell>.json`), falling back to its `.envelope.json`. Re-running
`matrix` or `judge` retries any cell whose out file is not a successful
result (`is_error` true, a non-`success` `subtype`, or unparseable).

**Acted proxy.** Resolved-thread state is 0/0 on the committed PRs, so
`materialize` marks a reference comment acted when its `path` is touched by
a later fix-applier commit on that PR (a commit subject carrying
`(pr-review #<pr>)`, `FIX_APPLIER_COMMIT_MARKER` in `bin/lib/ci-decision.ts`),
written as 1-based indices into `ref-<pr>.json` to `ref-acted-<pr>.json`.
PRs whose review fixes were not committed with that marker (812 and 756)
get an empty acted set, so `recall_acted` is `null` for them.
`ref-<pr>.json` holds top-level inline review comments only (replies are
discussion, not findings).

## Inputs this harness needs that are NOT committed

`<data-dir>` needs, per PR (`812`, `756`, `802` for the committed run):

- `meta-<pr>.json` — `{"title": ..., "body": ...}`. Regenerate with:
  ```sh
  gh pr view <pr> --json title,body > meta-<pr>.json
  ```
- `diff-<pr>.patch` — the full PR diff. Regenerate with:
  ```sh
  gh pr diff <pr> > diff-<pr>.patch
  ```
- `ref-<pr>.json` — the reference finding set: the inline review comments
  that survived the PR's real review, as a JSON array of
  `{"path": ..., "line": ..., "body": ...}`. Regenerate from the PR's
  posted review comments, e.g.:
  ```sh
  gh api "repos/<owner>/<repo>/pulls/<pr>/comments" \
    --jq '[.[] | {path, line, body}]' > ref-<pr>.json
  ```

None of these are checked in — they're per-measurement fetches, not
harness source. `data-dir` (default: this directory's `data/` subdirectory) is gitignored
(`docs/eval/review-model-recall/data/`) so a re-run's scratch inputs and
`runs/`/`judge/` cell outputs never land in a commit by accident; point
`--data-dir` wherever you like if you don't want the default.

## Cost

The committed run spent **$48.27** ($43.37 review runs, $4.90 judging)
across 36 review cells + 36 judge cells. Re-running the full matrix
costs roughly the same — this is why the harness is run by hand, never
from CI or `npm run verify`.
