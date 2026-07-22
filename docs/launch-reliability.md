# Launch reliability — findings

Closes out the intermittent `flow feature create` launch-failure
investigation: what was hardened, what was measured, and which hypotheses
were deliberately not pursued.

## Ongoing measurement

Every successful tmux-backed launch appends one JSON line to
`~/.flow/logs/launch.jsonl` (`bin/lib/launch-log.ts`): `{slug, at,
attempts, outcome, launcher}`. The running first-attempt rate:

```sh
jq -s 'if length == 0 then "no data yet" else {launches: length, first_attempt: (map(select(.attempts == 1)) | length), rate: ((map(select(.attempts == 1)) | length) / length)} end' ~/.flow/logs/launch.jsonl 2>/dev/null || echo "no data yet (log missing)"
```

This log is the primary — and only — measurement surface: the
point-in-time N-launch probe originally planned was cut by user redirect,
so there is no synthetic measurement, only the accumulating record of
real launches.

## Hardening timeline

| PR      | Commit  | Date       | Change                                                                                               |
| ------- | ------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| #347    | c7a3cbc | 2026-06-23 | Verified liveness before persisting state + bounded retry                                            |
| #355    | 7a10e05 | 2026-06-24 | send-keys seed delivery + consumption verification                                                   |
| #363    | 077f50c | 2026-06-26 | Early-exit ready/consume polls                                                                       |
| #364    | 0fbe422 | 2026-06-26 | State-phase consumption signal + persist-then-delete-on-failure                                      |
| #386    | 8114015 | 2026-06-28 | Wide readiness budget, increasing backoff, launch semaphore, non-destructive timeout                 |
| #425    | 8af4894 | 2026-07-12 | Self-verifying seed delivery                                                                         |
| #457    | 4f467c9 | 2026-07-17 | Plain-shell default backend (tmux opt-in)                                                            |
| this PR | —       | —          | Install-time `claude --version` runnable check (`flow install` warns, never fails) + this launch log |

## Why the TTY / trust-dialog hypothesis was not pursued

PR #425's live investigation did not reproduce the hypothesised readiness
race:

> Claude Code v2.1.205 puts the tty into raw mode at ~54 ms — roughly
> 550 ms _before_ its banner paints — and buffers stdin from process
> start, so ~14 launches, including sends at `t = 0 ms`, all arrived
> intact.

And there is no supported lever to pre-accept the workspace-trust dialog:
`claude --help` (v2.1.216) exposes no trust pre-acceptance flag. The only
implementable preflight would seed `~/.claude.json` — another tool's
undocumented internal state — which is a closed alternative.

## Verdict

The failure is already mitigated at the diagnosed source: seed delivery
is self-verifying, launches are liveness-verified with bounded retry and
delete-on-failure, and the plain-shell default removes tmux from the
common path entirely. The end-to-end rate is now instrumented via
`launch.jsonl`, so any residual flake shows up as `attempts > 1` (or a
missing line) in real data rather than anecdote. No preflight was built —
with the point-in-time probe cut there is no mechanism that could pin a
deterministic trigger, and the only implementable trust preflight would
couple to `~/.claude.json`, another tool's undocumented internal state.
