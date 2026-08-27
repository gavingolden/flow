# Launch reliability — findings

Closes out the intermittent `flow feature create` launch-failure
investigation: what was hardened, what was measured, and which hypotheses
were deliberately not pursued.

## Ongoing measurement

Every successful tmux-backed launch through `flow feature create` /
`flow feature resume` appends one JSON line to `~/.flow/logs/launch.jsonl`
(`bin/lib/launch-log.ts`): `{slug, at, attempts, outcome, launcher}`.
`flow epic run`'s own retry path and the plain (non-tmux) launcher are not
instrumented yet (deliberate scope cut, tracked as follow-up work — see
issue #394). The running first-attempt rate:

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
| #477    | 3b64e79 | 2026-07-22 | Durable launch breadcrumb + install-time `claude --version` runnable check + `--tmux` launcher docs  |
| this PR | —       | —          | Paced remainder delivery + UserPromptSubmit seed-integrity check + reshaped epic-create leading line |

## Seed integrity

The leading-line handshake (`bin/lib/seed-delivery.ts`) only ever verifies the
FIRST line of a seed in-pane — a long paste collapses into
`[Pasted text #N +M lines]` chips, so the remainder can never be
capture-verified once the body is present. Two changes close that gap without
touching the capture-verify design:

- **Paced remainder.** The remainder is chunked to `REMAINDER_CHUNK_BYTES`
  (128 bytes) with a `REMAINDER_SETTLE_MS` (50 ms) sleep between consecutive
  chunks, rather than one large literal `send-keys` blast — reducing the odds
  of tmux/claude dropping bytes under load. This is still fire-and-trust, not
  a verification: pacing lowers the failure rate, it doesn't detect a failure.
- **Out-of-band integrity check.** Every tmux launch/resume path
  (`bin/lib/feature.ts`, `bin/lib/epic.ts`, `bin/flow-session-start-hook.ts`)
  records the exact seed it is about to deliver as `state.seed` before
  sending it. `bin/flow-seed-ingested-hook.ts` — a Claude Code
  UserPromptSubmit hook — compares the submitted prompt against `state.seed`
  (whitespace-squashed containment, not equality) the instant a prompt is
  accepted. A match stamps `seedIngestedAt` as before; a mismatch records
  `state.seedMismatch` instead and does NOT stamp `seedIngestedAt`, so
  `bin/lib/tmux.ts`'s `seedCorrupted()` predicate turns a recorded mismatch
  into a hard `failed` launch outcome — the existing kill + `launchWithRetry`
  re-launch apply for free.

A truncated or corrupted delivery is recoverable without retyping the
original request:

```sh
jq -r .seed ~/.flow/state/<slug>.json
```

The seed-corruption failure path deliberately skips the generic
persist-then-delete-on-failure cleanup so this file survives long enough to
recover from — `flow reap` / `flow done` remain the generic backstop for the
one abandoned `phase: starting` state file this leaves behind.

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
