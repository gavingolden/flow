# Gemini 4 Carbon (Medium) smoke record, 2026-11-12

This record decides which Google-plan steps default to Gemini 4 Carbon
(Medium) and which stay on Gemini 4 Argon (Medium). The machine-readable
twin is `carbon-4-smoke-2026-11.json`; a parity test in
`bin/lib/delegate-models.test.ts` keeps the code defaults in line with its
verdicts.

## What ran

One production-shaped call per Google-plan step, through
`docs/eval/argon-latency-probe/run.ts`, on Gemini 4 Carbon (Medium). Each
call used the step's real prompt shape. The probe ran under its own per-step
timeout cap (one review-lens attempt ran 1235 s, see below), not the
production limit; the verdicts below are judged
against `productionLimitsSec` in the JSON twin.

## Gate rule (fixed before the run)

A step passes when its call ran, returned a non-empty answer, had no denied
tool action, did not time out, and 3 x the answer time fits inside the
step's production limit. The refused-review re-run is judged from the Gemini
review call against its 180 s floor. That is a proxy, not the same thing:
the re-run uses the Claude-lens checklist prompt.

## Results

| Step                                                      | Wall seconds | Production limit | Verdict                              |
| --------------------------------------------------------- | ------------ | ---------------- | ------------------------------------ |
| Research gather                                           | 250.6        | 1200 s           | pass                                 |
| Survey judge A (blind survey)                             | 188.1        | 600 s            | pass                                 |
| PR intent guess                                           | 79.7         | 600 s            | pass                                 |
| Plan reviewer 1                                           | 284.8        | 780 s            | fail (3 x 284.8 = 854 s, over 780 s) |
| Gemini review lens                                        | 595.0        | 600 s            | fail (no headroom)                   |
| Refused-review re-run (proxy: review call vs 180 s floor) | 595.0        | 180 s floor      | fail                                 |

The first review-lens attempt timed out after 1235 s on a DNS error
(`no such host`, skip reason `agy-timeout`). It is kept under
`discardedAttempts` in the JSON and was re-run once; the table uses the re-run.

## Outcome

- Carbon Medium: research gather, survey judge A, PR intent guess.
- Argon Medium kept: plan reviewer 1, Gemini review lens, refused-review re-run.
- Research fact-check fallback stays GPT-OSS 120B (Medium).

## Limits of this evidence

This measures time and non-emptiness only, not answer quality, and n=1 per
step. A quality screen on the three Carbon steps is a follow-up. Argon
evidence stays in `argon-4-routing-2026-10.md`.
