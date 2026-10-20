## Per-surface verdicts

- **blind-survey** / gemini-4-argon-high: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable; gated on fixture ground truth: c12-blind-survey (ground truth only)
- **blind-survey** / gemini-4-argon-medium: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable; gated on fixture ground truth: c12-blind-survey (ground truth only)
- **commit-msg** / gemini-4-argon-high: inconclusive — no gemini-4-argon-high rows on this surface — nothing to evaluate
- **commit-msg** / gemini-4-argon-medium: inconclusive — no gemini-4-argon-medium rows on this surface — nothing to evaluate
- **critique** / gemini-4-argon-high: inconclusive — no gemini-4-argon-high rows on this surface — nothing to evaluate
- **critique** / gemini-4-argon-medium: inconclusive — no gemini-4-argon-medium rows on this surface — nothing to evaluate
- **gatekeeper** / gemini-4-argon-high: inconclusive — no gemini-4-argon-high rows on this surface — nothing to evaluate
- **gatekeeper** / gemini-4-argon-medium: inconclusive — no gemini-4-argon-medium rows on this surface — nothing to evaluate
- **intent-guess** / gemini-4-argon-high: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable
- **intent-guess** / gemini-4-argon-medium: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable
- **log-triage** / gemini-4-argon-high: inconclusive — no gemini-4-argon-high rows on this surface — nothing to evaluate
- **log-triage** / gemini-4-argon-medium: inconclusive — no gemini-4-argon-medium rows on this surface — nothing to evaluate
- **plan-review** / gemini-4-argon-high: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable
- **plan-review** / gemini-4-argon-medium: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable
- **research-gather** / gemini-4-argon-high: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable; gated on fixture ground truth: c11-research-gather (ground truth only)
- **research-gather** / gemini-4-argon-medium: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable; gated on fixture ground truth: c11-research-gather (ground truth only)
- **research-refute** / gemini-4-argon-high: reject — mechanical parity failed on c8-research-refute: recall 0.87 < incumbent 1.00 - 0.05
- **research-refute** / gemini-4-argon-medium: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable
- **review-lens** / gemini-4-argon-high: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable
- **review-lens** / gemini-4-argon-medium: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable
- **scout** / gemini-4-argon-high: inconclusive — reliability: gemini-4-argon-high failed to run on 67% of attempts on c2b-real-defect
- **scout** / gemini-4-argon-medium: inconclusive — reliability: gemini-4-argon-medium failed to run on 33% of attempts on c2b-real-defect

## Where each candidate was worse

- **research-refute** / gemini-4-argon-high: mechanical parity failed on c8-research-refute: recall 0.87 < incumbent 1.00 - 0.05

## Surfaces no candidate should take

- **commit-msg**: no candidate cleared every gate
- **critique**: no candidate cleared every gate
- **gatekeeper**: no candidate cleared every gate
- **log-triage**: no candidate cleared every gate
- **scout**: no candidate cleared every gate

## Case discrimination

- c4-intent-json (schema): spread 0.078
- c4-intent-json (free-form): spread 0.000 — non-discriminating — cannot inform a routing decision
- c11-research-gather (n/a): spread 0.000 — non-discriminating — cannot inform a routing decision
- c2b-real-defect (n/a): spread 0.333
- c6-plan-review (free-form): spread 0.020
- c6-plan-review (schema): spread 0.000 — non-discriminating — cannot inform a routing decision
- c3-log-triage (n/a): spread 0.000 — non-discriminating — cannot inform a routing decision
- c5-commit-msg (n/a): spread 0.000 — non-discriminating — cannot inform a routing decision
- c9b-pushback-control (schema): spread 0.000 — non-discriminating — cannot inform a routing decision
- c9b-pushback-control (free-form): spread 0.000 — non-discriminating — cannot inform a routing decision
- c12-blind-survey (n/a): spread 0.000 — non-discriminating — cannot inform a routing decision
- c2-planted-defects (n/a): spread 0.113
- c10-gatekeeper (schema): spread 0.000 — non-discriminating — cannot inform a routing decision
- c10-gatekeeper (free-form): spread 0.000 — non-discriminating — cannot inform a routing decision
- c7-review-lens (schema): spread 0.250
- c7-review-lens (free-form): spread 0.000 — non-discriminating — cannot inform a routing decision
- c9a-pushback-wrong (schema): spread 0.000 — non-discriminating — cannot inform a routing decision
- c9a-pushback-wrong (free-form): spread 0.000 — non-discriminating — cannot inform a routing decision
- c1-multifile-contract (n/a): spread 0.025
- c8-research-refute (free-form): spread 0.133
- c8-research-refute (schema): spread 0.000 — non-discriminating — cannot inform a routing decision

## Schema tax

- gemini-3.1-pro-high: overall tax 0.007 — recommended arm: schema (route with --json-schema (wire-level constrained decoding))
- gemini-4-argon-high: overall tax 0.000 — recommended arm: schema (route with --json-schema (wire-level constrained decoding))
- gemini-4-argon-medium: overall tax 0.000 — recommended arm: schema (route with --json-schema (wire-level constrained decoding))

## Production timeout fit

_single-shot fixture time — production-realistic answer times are in the Stage 0 probe_

- **blind-survey** / gemini-4-argon-high: 0/3 timed out at the 10m production limit; 0/3 answered over it
- **blind-survey** / gemini-4-argon-medium: 0/3 timed out at the 10m production limit; 0/3 answered over it
- **intent-guess** / gemini-3.1-pro-high: 0/20 timed out at the 10m production limit; 0/20 answered over it
- **intent-guess** / gemini-4-argon-high: 0/3 timed out at the 10m production limit; 0/3 answered over it
- **intent-guess** / gemini-4-argon-medium: 0/3 timed out at the 10m production limit; 0/3 answered over it
- **plan-review** / gemini-3.1-pro-high: 0/20 timed out at the 13m production limit; 0/20 answered over it
- **plan-review** / gemini-4-argon-high: 0/3 timed out at the 13m production limit; 0/3 answered over it
- **plan-review** / gemini-4-argon-medium: 0/3 timed out at the 13m production limit; 0/3 answered over it
- **research-gather** / gemini-4-argon-high: 0/3 timed out at the 20m production limit; 0/3 answered over it
- **research-gather** / gemini-4-argon-medium: 0/3 timed out at the 20m production limit; 0/3 answered over it
- **research-refute** / gemini-3.1-pro-high: 0/20 timed out at the 20m production limit; 0/20 answered over it
- **research-refute** / gemini-4-argon-high: 0/3 timed out at the 20m production limit; 0/3 answered over it
- **research-refute** / gemini-4-argon-medium: 0/3 timed out at the 20m production limit; 0/3 answered over it
- **review-lens** / gemini-3.1-pro-high: 0/6 timed out at the 10m production limit; 0/6 answered over it
- **review-lens** / gemini-4-argon-high: 0/3 timed out at the 10m production limit; 0/3 answered over it
- **review-lens** / gemini-4-argon-medium: 0/3 timed out at the 10m production limit; 0/3 answered over it
- **scout** / gemini-3.1-pro-high: 0/30 timed out at the 8m production limit; 0/30 answered over it
- **scout** / gemini-4-argon-high: 2/9 timed out at the 8m production limit; 0/9 answered over it
- **scout** / gemini-4-argon-medium: 1/9 timed out at the 8m production limit; 0/9 answered over it

## Run provenance

- commit: b02793ef329e711d9f7cf6ba8e3daae28e066f90
- agy version: 1.4.2
- models: gemini-4-argon-high, gemini-4-argon-medium, gemini-3.1-pro-high
- incumbent: gemini-3.1-pro-high
- run date: 2026-10-20
- repeat tiers: {"c4-intent-json":10,"c11-research-gather":5,"c2b-real-defect":10,"c6-plan-review":10,"c3-log-triage":3,"c5-commit-msg":10,"c9b-pushback-control":10,"c12-blind-survey":5,"c2-planted-defects":10,"c10-gatekeeper":10,"c7-review-lens":3,"c9a-pushback-wrong":10,"c1-multifile-contract":10,"c8-research-refute":10}

## Limitations

- Repeat tiers (N=10 on decision-bearing surfaces, N=3 elsewhere) are far below the N>=30 that stable latency percentiles call for; medians are reported but underpowered.
- Planted-defect detection rates are selection-biased toward authorable defects and do not generalise to natural defects; the c2b real-defect control narrows but does not close that gap.
- The incumbent baseline (gemini-3.1-pro-high) ran under agy's scaffold, not necessarily the scaffold production uses; rows merged from a committed --baseline-results file were measured earlier, on that run's agy version and roster.
- Tokens/usage are descriptive only and never gate a verdict.
- Latency is read from durationSeconds (agy's own model-time reading), never the fanout's pool wall-clock.
- A non-discriminating case contributes no clear verdict for any candidate on that surface.
- Non-discriminating this run: c4-intent-json (free-form), c11-research-gather (n/a), c6-plan-review (schema), c3-log-triage (n/a), c5-commit-msg (n/a), c9b-pushback-control (schema), c9b-pushback-control (free-form), c12-blind-survey (n/a), c10-gatekeeper (schema), c10-gatekeeper (free-form), c7-review-lens (free-form), c9a-pushback-wrong (schema), c9a-pushback-wrong (free-form), c8-research-refute (schema).