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

| Script            | Job                                                                                                                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build-prompt.ts` | Assembles one review-lens prompt: the shared context block plus the per-lens section, both extracted live from `skills/pipeline/flow-pr-review/references/agent-prompts.md`, substituted with a PR's metadata/diff.                                                                                 |
| `build-judge.ts`  | Builds the blinded scoring-judge prompt for one cell — never names which model (sonnet/opus) produced the candidate output, only the lens.                                                                                                                                                          |
| `score.ts`        | Two subcommands: `extract` (diagnostic — parses each cell's raw result into a findings list, tolerant of prose-only output) and `aggregate` (reads judge outputs, computes per-cell/per-lens-arm recall stats and the separation verdict, in the same JSON shape as `../review-model-recall.json`). |
| `run.ts`          | Two subcommands: `matrix` (runs every review cell through `flow-claude-headless`) and `judge` (runs every judge cell). Resume-safe (skips a cell whose output file already exists) and bounded-concurrency.                                                                                         |

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
