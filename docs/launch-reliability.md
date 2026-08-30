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

| PR      | Commit  | Date       | Change                                                                                                                                                                                                                       |
| ------- | ------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #347    | c7a3cbc | 2026-06-23 | Verified liveness before persisting state + bounded retry                                                                                                                                                                    |
| #355    | 7a10e05 | 2026-06-24 | send-keys seed delivery + consumption verification                                                                                                                                                                           |
| #363    | 077f50c | 2026-06-26 | Early-exit ready/consume polls                                                                                                                                                                                               |
| #364    | 0fbe422 | 2026-06-26 | State-phase consumption signal + persist-then-delete-on-failure                                                                                                                                                              |
| #386    | 8114015 | 2026-06-28 | Wide readiness budget, increasing backoff, launch semaphore, non-destructive timeout                                                                                                                                         |
| #425    | 8af4894 | 2026-07-12 | Self-verifying seed delivery                                                                                                                                                                                                 |
| #457    | 4f467c9 | 2026-07-17 | Plain-shell default backend (tmux opt-in)                                                                                                                                                                                    |
| #477    | 3b64e79 | 2026-07-22 | Durable launch breadcrumb + install-time `claude --version` runnable check + `--tmux` launcher docs                                                                                                                          |
| #686    | ae7fbaa | 2026-08-28 | Paced remainder delivery + UserPromptSubmit seed-integrity check + reshaped epic-create leading line                                                                                                                         |
| this PR | —       | —          | Pointer seed (`REQUEST_FILE`) for the two free-form-text seeds, single-line reshape of all five supervisor seeds, fail-fast retry on deterministic corruption, and a reap-orphans skip for a `corrupt` seed-integrity record |

## Seed integrity

The leading-line handshake (`bin/lib/seed-delivery.ts`) only ever verifies the
FIRST line of a seed in-pane — a long paste collapses into
`[Pasted text #N +M lines]` chips, so the remainder can never be
capture-verified once the body is present. The 2026-08-28 incident (a
3-byte in-pane transposition — `"agent to"` mangled to `"ageno"` plus a
trailing `"t t"` — not whitespace) proved this gap is real for
free-form user text riding the unverified remainder. Three changes close
it:

- **Pointer seed, not payload — for the two seeds that carried free-form
  text.** The `flow feature create` fresh-launch seed and the
  `flow epic create` seed no longer put the verbatim request/prompt on
  the seed at all. The launcher writes it to `~/.flow/state/<slug>.request.md`
  (`bin/lib/state.ts`'s `writeRequestFile`, mode `0600`) BEFORE dispatch,
  and the seed becomes a single control-char-free line ending
  `REQUEST_FILE: <path>` (`sanitizeSeedLine` strips any stray control byte
  defensively, even though free-form text no longer reaches the seed).
  The other three supervisor seeds — `flow feature resume`'s,
  `flow epic create --resume`'s, and `flow epic run`'s — never carried
  free-form text (only the slug and CLI-resolved paths), but are reshaped
  to a single line too, for a uniform contract across all five. `splitSeed`'s
  remainder is empty for every one of these five seeds, so each goes
  through the capture-verified, `C-u`-retried leading-line handshake in
  full — the unverified-remainder path this section used to describe no
  longer carries any of them. `flow-session-start-hook.ts` delivers the
  same three reshaped resume seeds (`flowPipelineResumeSeed`,
  `epicResumeSeed`, `epicRunSeed`), so they are single-line too; only
  `terminalContinueSeed` (genuine multi-line prose, no free-form user text)
  still carries a remainder.
- **Paced remainder (unchanged, now only for `terminalContinueSeed`).**
  Still chunked to `REMAINDER_CHUNK_BYTES` (128 bytes) with a
  `REMAINDER_SETTLE_MS` (50 ms) sleep between consecutive chunks, rather
  than one large literal `send-keys` blast.
- **Out-of-band integrity check.** Every tmux launch/resume path
  (`bin/lib/feature.ts`, `bin/lib/epic.ts`, `bin/flow-session-start-hook.ts`)
  records the exact seed it is about to deliver as `state.seed` before
  sending it. `bin/flow-seed-ingested-hook.ts` — a Claude Code
  UserPromptSubmit hook — compares the submitted prompt against `state.seed`
  (whitespace-squashed containment, not equality) the instant a prompt is
  accepted, and writes ONE self-describing `state.seedIngest` record
  (`bin/lib/seed-ingest.ts`) saying what it could actually establish:

  | `seedIngest.outcome` | Means                                                                                                                       | Launcher effect                                                                                                    |
  | -------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
  | `verified`           | The prompt contained the recorded seed intact                                                                               | `consumed()` latches success at launch time                                                                        |
  | `unverified`         | A prompt arrived but the comparison could not run (`stdin-timeout`, `stdin-error`, `payload-unparsable`, `no-prompt-field`) | NOT a pass — falls through to the phase/`updatedAt` signal, plus a loud stderr warning                             |
  | `not-applicable`     | No seed was recorded (`no-seed-recorded`) — the plain backend, or a legacy state file                                       | Neither a pass nor a failure; the record's presence alone is what stops the plain backend's dead-on-arrival delete |
  | `corrupt`            | The prompt carried the seed's leading-line marker but not the seed intact, with both byte counts                            | `seedCorrupted()` reports a hard `failed` launch — the existing kill + `launchWithRetry` re-launch apply for free  |
  | ABSENT (no record)   | Not yet ingested                                                                                                            | Same as before the hook ever ran                                                                                   |

  **Delivery-marker discriminator.** A prompt that does not even contain the
  seed's leading line (the one `deliverSeed` types alone and capture-verifies
  first) is FOREIGN — the human typed it — so the hook writes nothing at all
  rather than recording a false `corrupt`, which separates a truncated
  delivery from a user-typed prompt and stops later unrelated chatter from
  rewriting a standing record.

  **Monotone latch.** Within one epoch, `unverified` may be replaced by
  `corrupt` or `verified`, `corrupt` may be replaced ONLY by `verified` (so a
  corrupted attempt followed by an intact one is cleared, not stuck failed),
  and `verified`/`not-applicable` are terminal; a resume path clearing
  `seedIngest` starts a new epoch.

  **Unverified warning.** `flow feature create`, `flow feature resume`,
  `flow epic create`, and `flow epic create --resume` print one dim
  `seed integrity NOT verified (<reason>)` line on stderr after an otherwise
  successful launch — a warning only, never a change to the exit code.

  **Fail-fast retry.** `launchWithRetry` (`bin/lib/feature.ts`,
  `bin/lib/epic.ts`) stops on `SEED_CORRUPTED_STDERR` after ONE attempt
  rather than spending the full retry budget, since a deterministic
  corruption just resends the same bytes through the same broken path.

  `seedCorrupted()` is wired on the paths where a corrupted delivery must
  fail the command: `flow feature create` (fresh + resume) and
  `flow epic create` (fresh + `--resume`). The `flow epic run` playbook
  window (`spawnEpicRunSupervisor`) deliberately does NOT wire it — that
  window is human-in-the-loop (the user attaches directly), so enforcement
  is not yet universal across all six seed-recording sites, only these
  four; the pointer-seed migration above covers five of the six (every
  seed except `terminalContinueSeed`, which never carried free-form text).

A truncated or corrupted delivery is recoverable without retyping the
original request: on the wired paths, a `seedCorrupted()` failure now names
`~/.flow/state/<slug>.request.md` — the file `writeRequestFile` wrote
before dispatch — as the recovery source, rather than printing the seed
text (which, post-migration, is only a pointer line and would print
nothing useful). This file DOES survive `flow ls`'s lazy reap
(`REAP_GRACE_MS`, ~60s): `reapableStartingOrphans`
(`bin/lib/reap-orphans.ts`) now skips any `phase: starting` slug with a
`corrupt` `seedIngest` record, and `deleteState` unlinks the request file only
alongside its state file — so the corrupted state (and its sibling request
file) both survive until the operator recovers or explicitly `flow done`s
the slug. `flow reap` / `flow done` remain the generic backstop once
recovery is complete.

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
