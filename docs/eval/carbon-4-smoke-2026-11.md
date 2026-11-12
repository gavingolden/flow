# Gemini 4 Carbon (Medium) smoke record, 2026-11-12

This record decides which Google-plan steps default to Gemini 4 Carbon
(Medium) and which keep their previous Argon default. The machine-readable
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

| Step                                                      | Wall seconds | Production limit | Verdict                                |
| --------------------------------------------------------- | ------------ | ---------------- | -------------------------------------- |
| Research gather                                           | 250.6        | 1200 s           | pass                                   |
| Survey judge A (blind survey)                             | 188.1        | 600 s            | pass                                   |
| PR intent guess                                           | 79.7         | 600 s            | pass                                   |
| Plan reviewer 1                                           | 284.8        | 900 s            | pass (3 x 284.8 = 854 s, within 900 s) |
| Gemini review lens                                        | 595.0        | 600 s            | fail (no headroom)                     |
| Refused-review re-run (proxy: review call vs 180 s floor) | 595.0        | 180 s floor      | fail                                   |

The first review-lens attempt timed out after 1235 s on a DNS error
(`no such host`, skip reason `agy-timeout`). It is kept under
`discardedAttempts` in the JSON and was re-run once; the table uses the re-run.

## Outcome

- Carbon Medium: research gather, survey judge A, PR intent guess, and plan
  reviewer 1. Reviewer 1 passes against its production limit raised from 13m
  (780 s) to 15m (900 s): 3 x 285 s = 854 s <= 900 s.
- Gemini review lens fails and keeps its previous default, Argon High (not
  Argon Medium). The owner prioritises review quality, and Argon's tiers tie on
  flow's fixtures, so dropping a tier was an unmeasured quality risk.
- Refused-review re-run fails and keeps Argon Medium.
- Research fact-check fallback stays GPT-OSS 120B (Medium).

## Limits of this evidence

This measures time and non-emptiness only, not answer quality, and n=1 per
step. A full Carbon evaluation (quality, both tiers) is planned as a separate pipeline. Argon
evidence stays in `argon-4-routing-2026-10.md`.
