# Cross-model (Gemini) lens — launch and wait (Step 3)

The `review.gemini`-gated `flow-gemini-lens` helper makes one primary agy call
(`delegate.timeouts.reviewLens`, default 10m, 20m sanity bound — see
`docs/configuration.md`'s "Delegate timeouts" section) plus, on a
`gemini-tools-denied` or `gemini-token-exhausted` skip, one fixed 2-minute
diff-only retry. That is longer than one tool call lasts, so Step 3 runs it
detached: launch before the Task lens fan-out message, wait after it, and have
the envelope in hand before Step 3.5. The Gemini lens and the cross-model
intent guess (see
[intent-mismatch-resolution.md](intent-mismatch-resolution.md)) are
independent — launch both, in the same message, before the fan-out.

Shell variables do not survive between Bash calls, so the recipe persists the
pid and start time under `.flow-tmp/`.

## Launch (before the Task lens fan-out message)

Gate on the `review.gemini` jq read from `SKILL.md` first. Write
`$WORKTREE/.flow-tmp/diff.txt` with `flow-pr-diff "$PR_NUMBER"` if Step 3 prep
hasn't. The `rm -f` is load-bearing: a stale envelope or output from an
earlier pass would satisfy the waiter instantly.

```bash
LENS_ENV="$WORKTREE/.flow-tmp/gemini-lens-envelope.json"
rm -f "$LENS_ENV" "$WORKTREE/.flow-tmp/agent-output-gemini.json"
date +%s > "$WORKTREE/.flow-tmp/gemini-lens.start"
PID=$(flow-spawn --detach --stdout "$LENS_ENV" \
  --stderr "$WORKTREE/.flow-tmp/gemini-lens.log" -- \
  flow-gemini-lens --worktree "$WORKTREE" \
  --diff-file "$WORKTREE/.flow-tmp/diff.txt" \
  --out "$WORKTREE/.flow-tmp/agent-output-gemini.json")
echo "$PID" > "$WORKTREE/.flow-tmp/gemini-lens.pid"
```

Then send the Step 3 Task lens fan-out message as usual.

## Wait (after the fan-out returns, before Step 3.5)

Re-run this Bash call (with the Bash tool's `timeout` set to `600000`) until
it ends the wait. `flow-gemini-lens` prints its envelope as one JSON line plus
a newline, so `--complete-line` means "the envelope is whole":

```bash
LENS_ENV="$WORKTREE/.flow-tmp/gemini-lens-envelope.json"
PID=$(cat "$WORKTREE/.flow-tmp/gemini-lens.pid")
flow-plan-review-wait "$LENS_ENV" --complete-line --pid "$PID" --max-sec 540
echo "elapsed: $(( $(date +%s) - $(cat "$WORKTREE/.flow-tmp/gemini-lens.start") ))s"
```

The waiter prints one `{"outcome": …}` line:

- **`complete`** — read the envelope (`cat "$WORKTREE/.flow-tmp/gemini-lens-envelope.json"`) and branch on its
  `{ran}` field as `SKILL.md` describes, never the exit code.
- **`process-exited-without-result`** — the helper exited without printing an
  envelope. Record `ran: false` with `skipReason`
  `helper-exited-without-envelope` and proceed without the lens.
- **`timeout`** (the 540 s step ran out) — re-run the wait until the
  **give-up time**: the lens limit + the 2-minute retry + 5 minutes since the
  start time (17 minutes at the default 10m). Past it, kill the helper's
  process group (`kill -- -"$(cat "$WORKTREE/.flow-tmp/gemini-lens.pid")"`;
  `$PID` is unset in a later Bash call), record `ran: false` with `skipReason`
  `lens-timeout` (`skipClass: ran-unusable`) and proceed without the lens.

Wait for the lens envelope and, when it was launched, the intent-guess
envelope. The two helpers run concurrently, so waiting on them one after the
other costs only the slower one. Neither is one of the six mandatory Claude
lenses, so a missing result never escalates `consolidator-missing-artifact`.
