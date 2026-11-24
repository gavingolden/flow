# Background Gemini checks — wait and branch (Step 3)

Two `review.gemini`-gated helpers run in the background for every open-PR
review: the cross-model (Gemini) lens, `flow-gemini-lens`, and the cross-model
intent guess, `flow-gemini-intent-guess` (see
[intent-mismatch-resolution.md](intent-mismatch-resolution.md)). Each makes an
agy call longer than one tool call lasts (`delegate.timeouts.reviewLens` /
`intentGuess`, default 10m, 20m sanity bound — see `docs/configuration.md`'s
"Delegate timeouts" section; the lens adds one fixed 2-minute diff-only retry
on a `gemini-tools-denied` or `gemini-token-exhausted` skip).

You launch nothing and kill nothing. Setup (`flow-review-prep`) already ran
`flow-review-bg start`, which gates on `review.gemini` (strictly `true`; the
helpers re-gate internally) and starts both helpers on a diff snapshot, and a
background watchdog enforces each give-up (17 minutes for the lens, 15 for the
guess, at the default limits; derived from `delegate.timeouts`). Neither helper
is one of the six mandatory Claude lenses, so a missing result never escalates
`consolidator-missing-artifact`; a failure is a graceful skip and the review
proceeds with the Claude lenses unchanged.

Stale results are cleared by exact name only — `flow-review-scope` and
`flow-review-prep` for the reviewers, `flow-review-bg start` for these two.
Never glob-delete in `.flow-tmp/` while a review runs: the background helpers
keep live working files under `.flow-tmp/scratch/`.

## Wait (after the Task lens fan-out returns, before Step 3.5)

Send the Step 3 Task lens fan-out message first, then run this once per Bash
call, with the Bash tool's `timeout` set to `600000`, and re-run it while
`.done` is `false`:

```bash
flow-review-bg wait --worktree "$WORKTREE"
```

It prints one JSON line `{done, elapsedSec, helpers: {"gemini-lens": …,
"gemini-intent-guess": …}}`, never launches anything, and exits 0 on every
outcome. Each helper entry carries `outcome`, `ran`, the helper's own envelope
fields, and `skipReason` / `skipClass` when it did not run.

Skipping the wait means Gemini's findings are not guaranteed to reach Step 3.5,
and Step 12's lens table shows `gemini-not-awaited` whether or not the lens
finished on its own later (the first `wait` call stamps the run as awaited).

## Branch per helper

Branch on `ran`, never the exit code:

- **`ran: true`** — the lens's `agent-output-gemini.json` (or the guess's
  `intent-guess-gemini.json`) is schema-valid; proceed as `SKILL.md` Step 3
  and the intent page describe.
- **`ran: false`** — record `skipReason` and `skipClass`, reported distinctly
  per `SKILL.md`, and proceed without that helper. The reasons you will see
  beyond the helpers' own: `gemini-lens-disabled` /
  `gemini-intent-guess-disabled` (gate off), `agy-cooldown`,
  `gemini-intent-guess-delta-reentry` (a delta pass reuses the prior intent
  resolution), `gemini-not-launched` / `gemini-helper-missing` (setup did not
  start the helpers), and — `ran-unusable` — `lens-timeout` /
  `intent-guess-timeout` (the watchdog gave up and stopped the helper) and
  `helper-exited-without-envelope`.
