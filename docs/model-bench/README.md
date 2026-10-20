# Evaluating a new model for an agy-delegated step

When agy ships a new model, pick the smallest tier below that matches the
kind of move. Each tier names its call budget so it fits the Google AI Ultra
quota: at most 60 agy calls per five-hour window, and stop at the first quota
refusal (every harness here exits 3 on one; `--resume` finishes after the
reset).

"Newer is better" is enough reason for a smoke test, and only for a same-tier
successor. It is not enough for a cheaper tier, a new model family, or a
high-stakes step: Gemini 4 Argon scored at or above the retired pins on every
fixture yet broke every 3-minute time limit flow had in production
([argon-latency-probe-2026-10.md](../eval/argon-latency-probe-2026-10.md)).

Run results and reports from the last full evaluation:
[`argon-4-2026-10/`](argon-4-2026-10/) and
[`../eval/argon-4-routing-2026-10.md`](../eval/argon-4-routing-2026-10.md).

## Pick a tier

| Tier | Use it when                                                                                                    | Budget                     | Wall time        |
| ---- | -------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------- |
| 1    | Same-tier successor: the new model replaces a retired one at the same price tier (3.1 Pro → Argon High)       | about 15 calls             | under 1 hour     |
| 2    | A cheaper or faster tier of a measured family (Argon High → Argon Medium)                                      | 30–50 calls                | one quota window |
| 3    | A new model family, or a high-stakes step (the delegated Claude review lenses, the scout)                      | about 110 calls, 2 windows | about a day      |

Top up a step's repeats only when its result lands within 0.05 of a bar.
Raising the per-window cap to go faster is not an option: it drains the
weekly quota the pipelines themselves need.

## Tier 1 — same-tier successor (about 15 calls)

1. Latency spot-check, one call per step, on the new model:

   ```sh
   bun docs/eval/argon-latency-probe/run.ts --worktree "$PWD" --out <out-dir> \
     --models "<agy display name>" \
     --repeats research-gather=1,plan-review=1,blind-survey=1,intent-guess=1,review-lens=1
   ```

   A full run exceeds one 10-minute tool call — launch it detached as in
   [the probe README](../eval/argon-latency-probe/README.md#detach-and-wait-launch).
   Compare each answer time against the step's current limit in
   `<out-dir>/records.json`; any answer over half its limit is a Tier 2 run.

2. One repeat on the decisive bench cases:

   ```sh
   bun bin/flow-model-bench.ts --models <slug> --repeats 1 --no-warmup \
     --max-calls 60 --resume --concurrency 2 --out <out-dir> \
     --cases c2b-real-defect,c4-intent-json,c6-plan-review,c7-review-lens,c11-research-gather
   bun bin/flow-model-bench.ts --report --out <out-dir> --no-latency-gate \
     --ground-truth-floor 0.8 --baseline-results docs/model-bench/results.json \
     --incumbent <retired slug>
   ```

3. Swap the pin in `bin/lib/delegate-models.ts` unless a step hard-fails: an
   empty answer, a time-out, or a `reject` verdict in the report.

## Tier 2 — cheaper or faster tier (30–50 calls)

1. The Tier 1 latency spot-check, on the cheaper tier.
2. A 3-repeat screen on the steps the cheaper tier would take, each on its
   production arm:

   ```sh
   run() { bun bin/flow-model-bench.ts --models <slug> --repeats 3 --no-warmup \
     --max-calls 60 --resume --concurrency 2 --out <out-dir> "$@"; }
   run --cases c4-intent-json,c7-review-lens --arms schema
   run --cases c6-plan-review,c8-research-refute --arms free-form
   run --cases c1-multifile-contract,c2-planted-defects,c2b-real-defect,c11-research-gather,c12-blind-survey
   ```

   Drop the cases for steps not in play. Report once against the committed
   reference and once against the measured tier above it (`--incumbent
   <higher tier slug>`).

3. When a delegated Claude review lens is in play, add the 9 lens cells (3
   lenses × 3 PRs × 1 run) — see Tier 3 step 3, with `--runs 1`.

## Tier 3 — new family or high-stakes step (about 110 calls)

The full protocol from the October 2026 run. Write the decision rule into the
routing doc and commit it before the first measurement call.

1. Stage 0, all five Argon-routed steps at production prompts and posture
   (about 26 calls; detached launch as above):

   ```sh
   bun docs/eval/argon-latency-probe/run.ts --worktree "$PWD" --out <out-dir> \
     --models "<agy display name>,<second tier display name>"
   ```

   Size each limit with the probe's rule (at least 10 minutes, 3 × the median,
   20-minute cap) before running any quality measurement.

2. The Tier 2 screen at 3 repeats, every wired case, one model per tranche (54
   calls for two models). Between tranches, run one live intent-guess call; if
   it is refused, stop:

   ```sh
   bun bin/flow-gemini-intent-guess.ts --worktree "$PWD" \
     --diff-file docs/eval/argon-latency-probe/inputs/pr-941.diff --out <out-dir>/probe.json
   ```

3. The lens recall harness (18 cells per model at 2 runs; run the cheaper tier
   only if the first clears the lens bar):

   ```sh
   cd docs/eval/review-model-recall
   bun run.ts matrix --arms <agy arm> --lenses bug-detection,pattern-consistency,test-coverage \
     --prs 812,756,802 --runs 2 --data-dir <abs data-dir> --concurrency 2
   env -u FLOW_SLUG -u TMUX_PANE bun run.ts judge --arms <agy arm> \
     --lenses bug-detection,pattern-consistency,test-coverage --prs 812,756,802 \
     --runs 2 --data-dir <abs data-dir> --concurrency 3
   bun score.ts aggregate <abs data-dir>
   ```

   Launch the matrix detached with `flow-spawn --detach`: one cell takes about
   6 minutes. The judge runs on Claude, so strip `FLOW_SLUG` and `TMUX_PANE`
   when running it from a pipeline window.

4. Write the results and a per-step recommendation into the routing doc, and
   a dated `MEASURED (...)` comment above each pin in
   `bin/lib/delegate-models.ts`. Changing a pin is a separate, discussed PR.
