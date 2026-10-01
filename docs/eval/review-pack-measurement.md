# Review lens brief: packed vs pointer measurement

Whether a pre-rendered per-lens brief (`review.lensPack`, built by
`bin/lib/review-pack.ts`) makes a review lens cheaper than today's pointer
prompt, where the lens reads its inputs file by file. The brief ships off;
this file records the in-pipeline smoke and the commands that turn it on.

## What was measured

Two ways of handing a review lens the same content, per lens and PR:

- `packed`: the lens is told to Read one rendered brief (shared context
  block with every variable filled, lens checklist, conventional-comments,
  lens section last) and to Read further only when a finding needs it.
- `pointer`: today's fallback, the shared block and lens section with the
  variables filled and absolute paths to the checklist files.

Each cell is one headless Claude run (`flow-claude-headless`, `--model
opus --effort medium`, Read/Grep/Glob only, 40 turns) through the harness in
`docs/eval/review-model-recall/`, scored by the blinded fixed-model judge
against the PR's posted inline review comments. The ship rule (one rule,
used at every site) is: packed median cost at most 0.85x pointer, packed
median wall-clock at most 1.1x pointer, per-lens recall on the acted
comments and distinct findings each no worse than one pooled within-arm
standard deviation below pointer. `score.ts aggregate` prints it as
`ship_rule`.

## Smoke (in-pipeline, 6 cells)

3 lenses (bug-detection, pattern-consistency, test-coverage) x 1 PR x 2
arms x 1 run, about $5.0 including judging. Run on **PR #880**, not the
planned #812: all three planned PRs (#812, #756, #802) have diffs alone of
104-200 KB (after the per-file cap) and final bodies that carry
post-review evidence, so even the production 80 KB cap would have fallen back to the pointer
prompt on every one; #880 is the smallest merged PR with a usable review
set (22 inline comments, 18 acted by the proxy below). The harness raised
the brief cap to 200 KB (`--max-bytes`) so both arms see identical
content; the real briefs were about 115-122 KB, around 1,600 lines.

| Arm     | Cells | Median cost (USD) | Median turns | Median wall-clock (s) | Recall (all) | Recall (acted) | Median findings/run |
| ------- | ----- | ----------------- | ------------ | --------------------- | ------------ | -------------- | ------------------- |
| packed  | 3     | 0.772             | 8            | 71.1                  | 0.091        | 0.093          | 6                   |
| pointer | 3     | 0.688             | 7            | 50.5                  | 0.045        | 0.037          | 5                   |

`ship_rule`: `cost_ok: false` (packed is 1.12x pointer, the bar is 0.85x),
`wallclock_ok: false` (1.41x, the bar is 1.1x), `recall_acted_ok: true`,
`findings_ok: true`, `pass: "insufficient"`.

Power note: one run per cell means no within-arm standard deviation, so
the recall and findings components carry no weight, and recall (2 and 1
matches of a 22-comment set) cannot separate
the arms at this size. Cost and wall-clock are single draws too, but both
point the same way on all three lenses: packed was slower and dearer.

Cause not isolated. A likely contributor is that the brief is large
(about 117 KB), so a lens that Reads it pays to carry it across turns and
may need chunked Reads, where the pointer prompt carries the same text
inline in one request.

Acted proxy: a reference comment counts as acted when its path is touched
by a later fix-applier commit on the PR (a commit subject carrying
`(pr-review #<pr>)`). PRs #812 and #756 have no such commits, so they have
no acted set and the decision run's acted recall rests on #802.

## Decision run (36 cells, outside the pipeline)

From a plain shell in a clean checkout of this branch (about $50, about 40
minutes, needs `gh` auth and a Claude login). It does not gate the merge.

1. `cd docs/eval/review-model-recall && D=$PWD/data && mkdir -p "$D"`
2. `for pr in 812 756 802; do bun build-prompt.ts materialize $pr --data-dir "$D"; done`
3. `for lens in bug-detection pattern-consistency test-coverage; do for pr in 812 756 802; do bun build-prompt.ts $lens $pr --mode packed --max-bytes 300000 --data-dir "$D" > "$D/prompt-$lens-$pr-packed.txt"; bun build-prompt.ts $lens $pr --mode pointer --data-dir "$D" > "$D/prompt-$lens-$pr-pointer.txt"; done; done`
4. `bun run.ts matrix --arms packed,pointer --lenses bug-detection,pattern-consistency,test-coverage --prs 812,756,802 --runs 2 --model opus --data-dir "$D" --concurrency 6`
5. `bun run.ts judge --arms packed,pointer --lenses bug-detection,pattern-consistency,test-coverage --prs 812,756,802 --runs 2 --data-dir "$D" --concurrency 6`
6. `bun score.ts aggregate "$D" | tee "$D/scores.json" | jq '{arms, ship_rule}'`

Pass rule: `ship_rule.pass == true` (cost_ok, recall_acted_ok, findings_ok and
wallclock_ok all true; `insufficient` is not a pass). A pass is necessary
but not sufficient: the decision run renders briefs at `--max-bytes 300000`,
while production's fixed 80 KB cap (`BRIEF_MAX_BYTES`) makes most real PRs
(this PR ~170 KB per lens, #880 ~117 KB) fall back to the pointer prompt. So
before the key is useful, the production cap must be raised or the brief
shrunk; that work is untracked. Only then, on pass, turn the brief on with
one config change in `~/.flow/config.json`:

```json
{ "review": { "lensPack": true } }
```

On fail, leave it off. Paste the table into this section.

| Arm     | Cells | Median cost (USD) | Median turns | Median wall-clock (s) | Recall (all) | Recall (acted) | Median findings/run |
| ------- | ----- | ----------------- | ------------ | --------------------- | ------------ | -------------- | ------------------- |
| packed  |       |                   |              |                       |              |                |                     |
| pointer |       |                   |              |                       |              |                |                     |

## Live after-arm

Once `review.lensPack` is on, real reviews write telemetry rows with
`version: 2` and `pack: true`; compare them with `pack: false` rows. Never
mix `version: 1` rows (per-line token sums, 2-3x inflated) into either
side:

```sh
jq -s '[.[] | select(.version==2)] | group_by(.pack)
  | map({pack: .[0].pack, runs: length,
         lens_tokens_median: ([.[].lenses[] | select(.ran and .tokens != null) | .tokens.total] | sort | .[length/2|floor]),
         findings_acted: ([.[].lenses[].findings_acted] | add)})' \
  ~/.flow/telemetry/review-lenses.jsonl
```

Apply the same thresholds: packed lens tokens at most 0.85x the unpacked
median, acted findings per run not lower than unpacked by more than one
pooled sd. Telemetry rows record no wall-clock, so the 1.1x wall-clock
bar can only be checked in the decision run.

## Verdict

pack ships off — NO-CHANGE (smoke)
