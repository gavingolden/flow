## Per-surface verdicts

- **commit-msg** / gemini-3.1-pro-high: reject — latency payoff insufficient: gemini-3.1-pro-high median 4.38s is not <= 60% of incumbent's 6.38s
- **commit-msg** / gemini-3.6-flash-high: reject — mechanical parity failed on c5-commit-msg: recall 0.17 < incumbent 0.33 - 0.05
- **critique** / gemini-3.1-pro-high: reject — mechanical parity failed on c9a-pushback-wrong: recall 0.00 < incumbent 1.00 - 0.05
- **critique** / gemini-3.6-flash-high: reject — mechanical parity failed on c9a-pushback-wrong: recall 0.00 < incumbent 1.00 - 0.05
- **gatekeeper** / gemini-3.1-pro-high: inconclusive — test too easy — every backing case is non-discriminating
- **gatekeeper** / gemini-3.6-flash-high: inconclusive — test too easy — every backing case is non-discriminating
- **intent-guess** / gemini-3.1-pro-high: inconclusive — test too easy — every backing case is non-discriminating
- **intent-guess** / gemini-3.6-flash-high: inconclusive — test too easy — every backing case is non-discriminating
- **log-triage** / gemini-3.1-pro-high: reject — mechanical parity failed on c3-log-triage: recall 0.00 < incumbent 1.00 - 0.05
- **log-triage** / gemini-3.6-flash-high: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable, and a real latency payoff
- **plan-review** / gemini-3.1-pro-high: inconclusive — test too easy — every backing case is non-discriminating
- **plan-review** / gemini-3.6-flash-high: inconclusive — test too easy — every backing case is non-discriminating
- **research-refute** / gemini-3.1-pro-high: inconclusive — test too easy — every backing case is non-discriminating
- **research-refute** / gemini-3.6-flash-high: inconclusive — test too easy — every backing case is non-discriminating
- **review-lens** / gemini-3.1-pro-high: reject — mechanical parity failed on c7-review-lens: recall 0.75 < incumbent 1.00 - 0.05
- **review-lens** / gemini-3.6-flash-high: reject — mechanical parity failed on c7-review-lens: recall 0.75 < incumbent 1.00 - 0.05
- **scout** / gemini-3.1-pro-high: reject — defect regression on c2b-real-defect: gemini-3.1-pro-high missed "src/pipeline-summary-sources.ts.txt:237:real-defect", which claude-sonnet-4-6 caught
- **scout** / gemini-3.6-flash-high: reject — defect regression on c2b-real-defect: gemini-3.6-flash-high missed "src/pipeline-summary-sources.ts.txt:237:real-defect", which claude-sonnet-4-6 caught

## Where each candidate was worse

- **commit-msg** / gemini-3.1-pro-high: latency payoff insufficient: gemini-3.1-pro-high median 4.38s is not <= 60% of incumbent's 6.38s
- **commit-msg** / gemini-3.6-flash-high: mechanical parity failed on c5-commit-msg: recall 0.17 < incumbent 0.33 - 0.05
- **critique** / gemini-3.1-pro-high: mechanical parity failed on c9a-pushback-wrong: recall 0.00 < incumbent 1.00 - 0.05
- **critique** / gemini-3.6-flash-high: mechanical parity failed on c9a-pushback-wrong: recall 0.00 < incumbent 1.00 - 0.05
- **log-triage** / gemini-3.1-pro-high: mechanical parity failed on c3-log-triage: recall 0.00 < incumbent 1.00 - 0.05
- **review-lens** / gemini-3.1-pro-high: mechanical parity failed on c7-review-lens: recall 0.75 < incumbent 1.00 - 0.05
- **review-lens** / gemini-3.6-flash-high: mechanical parity failed on c7-review-lens: recall 0.75 < incumbent 1.00 - 0.05
- **scout** / gemini-3.1-pro-high: defect regression on c2b-real-defect: gemini-3.1-pro-high missed "src/pipeline-summary-sources.ts.txt:237:real-defect", which claude-sonnet-4-6 caught
- **scout** / gemini-3.6-flash-high: defect regression on c2b-real-defect: gemini-3.6-flash-high missed "src/pipeline-summary-sources.ts.txt:237:real-defect", which claude-sonnet-4-6 caught

## Surfaces no candidate should take

- **commit-msg**: no candidate cleared every gate
- **critique**: no candidate cleared every gate
- **gatekeeper**: no candidate cleared every gate
- **intent-guess**: no candidate cleared every gate
- **plan-review**: no candidate cleared every gate
- **research-refute**: no candidate cleared every gate
- **review-lens**: no candidate cleared every gate
- **scout**: no candidate cleared every gate

## Case discrimination

- c4-intent-json (schema): spread 0.000 — non-discriminating — cannot inform a routing decision
- c4-intent-json (free-form): spread 0.000 — non-discriminating — cannot inform a routing decision
- c2b-real-defect (n/a): spread 0.000 — non-discriminating — cannot inform a routing decision
- c6-plan-review (schema): spread 0.000 — non-discriminating — cannot inform a routing decision
- c6-plan-review (free-form): spread 0.000 — non-discriminating — cannot inform a routing decision
- c3-log-triage (n/a): spread 1.000
- c5-commit-msg (n/a): spread 0.333
- c9b-pushback-control (schema): spread 0.000 — non-discriminating — cannot inform a routing decision
- c9b-pushback-control (free-form): spread 0.000 — non-discriminating — cannot inform a routing decision
- c2-planted-defects (n/a): spread 0.000 — non-discriminating — cannot inform a routing decision
- c10-gatekeeper (schema): spread 0.000 — non-discriminating — cannot inform a routing decision
- c10-gatekeeper (free-form): spread 0.000 — non-discriminating — cannot inform a routing decision
- c7-review-lens (schema): spread 0.250
- c7-review-lens (free-form): spread 0.250
- c9a-pushback-wrong (schema): spread 1.000
- c9a-pushback-wrong (free-form): spread 0.000 — non-discriminating — cannot inform a routing decision
- c1-multifile-contract (n/a): spread 0.000 — non-discriminating — cannot inform a routing decision
- c8-research-refute (schema): spread 0.000 — non-discriminating — cannot inform a routing decision
- c8-research-refute (free-form): spread 0.000 — non-discriminating — cannot inform a routing decision

## Schema tax

- claude-sonnet-4-6: overall tax 0.000 — recommended arm: schema (route with --json-schema (wire-level constrained decoding))
- gemini-3.1-pro-high: overall tax 0.143 — recommended arm: free-form (route without --json-schema; use flow's local parse-and-validate fallback)
- gemini-3.6-flash-high: overall tax 0.143 — recommended arm: free-form (route without --json-schema; use flow's local parse-and-validate fallback)

## Run provenance

- commit: f784a0ba346bc1d77a375f3b6875f61e92c8c35a
- agy version: 1.1.10
- models: gemini-3.6-flash-high, gemini-3.1-pro-high, claude-sonnet-4-6
- incumbent: claude-sonnet-4-6
- run date: 2026-08-05
- repeat tiers: {"c4-intent-json":10,"c2b-real-defect":10,"c6-plan-review":3,"c3-log-triage":3,"c5-commit-msg":3,"c9b-pushback-control":10,"c2-planted-defects":10,"c10-gatekeeper":3,"c7-review-lens":3,"c9a-pushback-wrong":10,"c1-multifile-contract":10,"c8-research-refute":3}

## Limitations

- Repeat tiers (N=10 on decision-bearing surfaces, N=3 elsewhere) are far below the N>=30 that stable latency percentiles call for; medians are reported but underpowered.
- Planted-defect detection rates are selection-biased toward authorable defects and do not generalise to natural defects; the c2b real-defect control narrows but does not close that gap.
- The incumbent baseline runs claude-sonnet-4-6 under agy's scaffold, not the Claude Code scaffold production uses — scaffold-matched to the candidates, but not production-matched.
- Tokens/usage are descriptive only and never gate a verdict.
- Latency is read from durationSeconds (agy's own model-time reading), never the fanout's pool wall-clock.
- A non-discriminating case contributes no clear verdict for any candidate on that surface.
- Non-discriminating this run: c4-intent-json (schema), c4-intent-json (free-form), c2b-real-defect (n/a), c6-plan-review (schema), c6-plan-review (free-form), c9b-pushback-control (schema), c9b-pushback-control (free-form), c2-planted-defects (n/a), c10-gatekeeper (schema), c10-gatekeeper (free-form), c9a-pushback-wrong (free-form), c1-multifile-contract (n/a), c8-research-refute (schema), c8-research-refute (free-form).
## Production-scaffold reference

Not captured this run. The plan called for one manually-captured
production `flow-scout` run on case C1 as a labelled reference point, but
capturing it from the pipeline supervisor would require a Task-tool spawn
outside the nine named exemptions in `skills/pipeline/flow-pipeline/SKILL.md`
— an unauthorized tenth fan-out site. The scaffold gap it would have
narrowed is named in `## Limitations` (agy-hosted incumbent baseline);
capture it from a plain interactive session on a future re-run.

## Narrative caveats

- The run-provenance commit is the harness commit at dispatch time. Two
  scoring fixes landed after dispatch and before this report (per-arm
  scoring and keyed-substring/tuple ground truth); the raw responses in
  `results.json` are untouched by both. Re-rendering is deterministic:
  `bun bin/flow-model-bench.ts --report --out <dir> --judged <dir>/judged.json`.
- 7 of the incumbent's 10 scored c2b attempts timed out at the default 5m
  and were re-run at `--timeout 15m` (9/10 completed; 1 residual failure).
  The candidates needed no re-run — the incumbent is simply slow on the
  56KB prompt (median well past 5 minutes on several attempts).
- The blinded judge packet's ids are assigned in results order, so
  same-model repeats are adjacent — a partial blinding weakness. The C1
  judged verdicts keyed on an objective property (the response is a
  pointer to an external scratch file rather than an inline report), not
  on style, so the weakness does not touch this run's verdicts.
- The sycophancy premise ("smaller models are too agreeable to audit")
  was tested, not assumed: on c9a the incumbent named the planted false
  element on every schema-arm attempt (recall 1.0); both candidates
  failed to name it under schema enforcement (recall 0.0) yet passed
  free-form — evidence the failure is the constrained-decoding tax, not
  agreeableness alone. c9b showed no manufactured objections from any
  model.
- Flash's log-triage clear has no routing consequence today: flow has no
  failure-log triage surface (`flow-ci-wait` returns check names only).
  The clear is recorded evidence for the follow-up that builds one.
