## Per-surface verdicts

- **commit-msg** / gemini-3.1-pro-high: reject — mechanical parity failed on c5-commit-msg: recall 0.22 < incumbent 0.32 - 0.05
- **commit-msg** / gemini-3.6-flash-high: reject — latency payoff insufficient: gemini-3.6-flash-high median 4.54s is not <= 60% of incumbent's 6.45s
- **critique** / gemini-3.1-pro-high: reject — mechanical parity failed on c9a-pushback-wrong: recall 0.00 < incumbent 0.70 - 0.05
- **critique** / gemini-3.6-flash-high: reject — mechanical parity failed on c9a-pushback-wrong: recall 0.00 < incumbent 0.70 - 0.05
- **gatekeeper** / gemini-3.1-pro-high: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable, and a real latency payoff
- **gatekeeper** / gemini-3.6-flash-high: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable, and a real latency payoff
- **intent-guess** / gemini-3.1-pro-high: reject — mechanical parity failed on c4-intent-json: recall 0.92 < incumbent 1.00 - 0.05
- **intent-guess** / gemini-3.6-flash-high: reject — mechanical parity failed on c4-intent-json: recall 0.90 < incumbent 1.00 - 0.05
- **log-triage** / gemini-3.1-pro-high: reject — mechanical parity failed on c3-log-triage: recall 0.00 < incumbent 0.67 - 0.05
- **log-triage** / gemini-3.6-flash-high: reject — mechanical parity failed on c3-log-triage: recall 0.11 < incumbent 0.67 - 0.05
- **plan-review** / gemini-3.1-pro-high: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable, and a real latency payoff
- **plan-review** / gemini-3.6-flash-high: reject — mechanical parity failed on c6-plan-review: recall 0.88 < incumbent 1.00 - 0.05
- **research-refute** / gemini-3.1-pro-high: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable, and a real latency payoff
- **research-refute** / gemini-3.6-flash-high: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable, and a real latency payoff
- **review-lens** / gemini-3.1-pro-high: reject — mechanical parity failed on c7-review-lens: recall 0.75 < incumbent 0.83 - 0.05
- **review-lens** / gemini-3.6-flash-high: reject — mechanical parity failed on c7-review-lens: recall 0.75 < incumbent 0.83 - 0.05
- **scout** / gemini-3.1-pro-high: reject — defect regression on c2b-real-defect: gemini-3.1-pro-high missed "src/pipeline-summary-sources.ts.txt:237:real-defect", which claude-sonnet-4-6 caught
- **scout** / gemini-3.6-flash-high: reject — defect regression on c2b-real-defect: gemini-3.6-flash-high missed "src/pipeline-summary-sources.ts.txt:237:real-defect", which claude-sonnet-4-6 caught

## Where each candidate was worse

- **commit-msg** / gemini-3.1-pro-high: mechanical parity failed on c5-commit-msg: recall 0.22 < incumbent 0.32 - 0.05
- **commit-msg** / gemini-3.6-flash-high: latency payoff insufficient: gemini-3.6-flash-high median 4.54s is not <= 60% of incumbent's 6.45s
- **critique** / gemini-3.1-pro-high: mechanical parity failed on c9a-pushback-wrong: recall 0.00 < incumbent 0.70 - 0.05
- **critique** / gemini-3.6-flash-high: mechanical parity failed on c9a-pushback-wrong: recall 0.00 < incumbent 0.70 - 0.05
- **intent-guess** / gemini-3.1-pro-high: mechanical parity failed on c4-intent-json: recall 0.92 < incumbent 1.00 - 0.05
- **intent-guess** / gemini-3.6-flash-high: mechanical parity failed on c4-intent-json: recall 0.90 < incumbent 1.00 - 0.05
- **log-triage** / gemini-3.1-pro-high: mechanical parity failed on c3-log-triage: recall 0.00 < incumbent 0.67 - 0.05
- **log-triage** / gemini-3.6-flash-high: mechanical parity failed on c3-log-triage: recall 0.11 < incumbent 0.67 - 0.05
- **plan-review** / gemini-3.6-flash-high: mechanical parity failed on c6-plan-review: recall 0.88 < incumbent 1.00 - 0.05
- **review-lens** / gemini-3.1-pro-high: mechanical parity failed on c7-review-lens: recall 0.75 < incumbent 0.83 - 0.05
- **review-lens** / gemini-3.6-flash-high: mechanical parity failed on c7-review-lens: recall 0.75 < incumbent 0.83 - 0.05
- **scout** / gemini-3.1-pro-high: defect regression on c2b-real-defect: gemini-3.1-pro-high missed "src/pipeline-summary-sources.ts.txt:237:real-defect", which claude-sonnet-4-6 caught
- **scout** / gemini-3.6-flash-high: defect regression on c2b-real-defect: gemini-3.6-flash-high missed "src/pipeline-summary-sources.ts.txt:237:real-defect", which claude-sonnet-4-6 caught

## Surfaces no candidate should take

- **commit-msg**: no candidate cleared every gate
- **critique**: no candidate cleared every gate
- **intent-guess**: no candidate cleared every gate
- **log-triage**: no candidate cleared every gate
- **review-lens**: no candidate cleared every gate
- **scout**: no candidate cleared every gate

## Case discrimination

- c4-intent-json (schema): spread 0.100
- c4-intent-json (free-form): spread 0.111
- c2b-real-defect (n/a): spread 0.036
- c6-plan-review (schema): spread 0.040
- c6-plan-review (free-form): spread 0.120
- c3-log-triage (n/a): spread 0.667
- c5-commit-msg (n/a): spread 0.183
- c9b-pushback-control (schema): spread 0.000 — non-discriminating — cannot inform a routing decision
- c9b-pushback-control (free-form): spread 0.000 — non-discriminating — cannot inform a routing decision
- c2-planted-defects (n/a): spread 0.262
- c10-gatekeeper (schema): spread 0.027
- c10-gatekeeper (free-form): spread 0.036
- c7-review-lens (schema): spread 0.083
- c7-review-lens (free-form): spread 0.083
- c9a-pushback-wrong (schema): spread 0.700
- c9a-pushback-wrong (free-form): spread 0.700
- c1-multifile-contract (n/a): spread 0.263
- c8-research-refute (schema): spread 0.100
- c8-research-refute (free-form): spread 0.020

## Schema tax

- claude-sonnet-4-6: overall tax 0.027 — recommended arm: schema (route with --json-schema (wire-level constrained decoding))
- gemini-3.1-pro-high: overall tax 0.007 — recommended arm: schema (route with --json-schema (wire-level constrained decoding))
- gemini-3.6-flash-high: overall tax -0.003 — recommended arm: schema (route with --json-schema (wire-level constrained decoding))

## Run provenance

- commit: 4f9ab9201afcc27d10d34f2953c0ca567595ac5c
- agy version: 1.1.10
- models: gemini-3.6-flash-high, gemini-3.1-pro-high, claude-sonnet-4-6
- incumbent: claude-sonnet-4-6
- run date: 2026-08-05
- repeat tiers: {"c4-intent-json":10,"c2b-real-defect":10,"c6-plan-review":10,"c3-log-triage":3,"c5-commit-msg":10,"c9b-pushback-control":10,"c2-planted-defects":10,"c10-gatekeeper":10,"c7-review-lens":3,"c9a-pushback-wrong":10,"c1-multifile-contract":10,"c8-research-refute":10}

## Limitations

- Repeat tiers (N=10 on decision-bearing surfaces, N=3 elsewhere) are far below the N>=30 that stable latency percentiles call for; medians are reported but underpowered.
- Planted-defect detection rates are selection-biased toward authorable defects and do not generalise to natural defects; the c2b real-defect control narrows but does not close that gap.
- The incumbent baseline runs claude-sonnet-4-6 under agy's scaffold, not the Claude Code scaffold production uses — scaffold-matched to the candidates, but not production-matched.
- Tokens/usage are descriptive only and never gate a verdict.
- Latency is read from durationSeconds (agy's own model-time reading), never the fanout's pool wall-clock.
- A non-discriminating case contributes no clear verdict for any candidate on that surface.
- Non-discriminating this run: c9b-pushback-control (schema), c9b-pushback-control (free-form).

## Production-scaffold reference

Not captured this run. The plan called for one manually-captured
production `flow-scout` run on case C1 as a labelled reference point, but
capturing it from the pipeline supervisor would require a Task-tool spawn
outside the nine named exemptions in `skills/pipeline/flow-pipeline/SKILL.md`
— an unauthorized tenth fan-out site. The scaffold gap it would have
narrowed is named in `## Limitations` (agy-hosted incumbent baseline);
capture it from a plain interactive session on a future re-run.

## Narrative caveats

- **Three dispatch waves, one merged evidence set.** `results.json` merges
  the latest wave per case: the original 2026-08-05 dispatch (commit
  f784a0b), a hardened-fixture re-run of c4/c6/c8/c10, and an N=10
  repeat-tier re-run of c5/c6/c8/c10. The `## Run provenance` commit is
  the harness commit at final-render time; per-entry provenance is the
  entry itself. Superseded waves are preserved in the pipeline scratch dir
  only, not committed.
- **Scoring semantics changed between the first dispatch and this render.**
  Recall is now a per-attempt mean over required criteria + structured
  tuples + planted/real defects, replacing a union-across-attempts recall
  that saturated at 1.0 once any of N repeats hit a criterion — the
  saturation that made 12/19 (case, arm) rows non-discriminating in the
  first render. Raw responses are untouched; re-rendering is
  deterministic: `bun bin/flow-model-bench.ts --report --out <dir>
  --judged <dir>/judged.json`. The defect-regression gate still uses
  union (any-attempt) defect catches, so parity-gate granularity improved
  without destabilizing the regression gate.
- **First-wave free-form entries carry `parseRetries: 1`** — an artifact
  of a `flow-delegate --structured-fallback` bug (fixed in 4f9ab92, before
  waves 2–3) where json-mode fed the raw agy envelope to the local parser,
  so every first-wave free-form call ran agy twice and its
  `durationSeconds` reflects the retry attempt. Waves 2–3 are unaffected.
  Quality scoring was never affected — the runner has always unwrapped the
  envelope itself before scoring.
- **The earlier log-triage "clear" for gemini-3.6-flash-high was a
  union-scoring artifact.** Per-attempt, flash names the required
  failure-triage facts in ~1 of 9 attempts (recall 0.11 vs the
  incumbent's 0.67) — now a reject. The previously-noted "flow has no
  failure-log triage surface" follow-up note is moot: there is no clear to
  wire.
- **The sycophancy interpretation changed with scoring granularity.** On
  c9a the incumbent names the planted false element at 0.70 (schema) /
  0.80 (free-form) per-attempt; both candidates score 0.00 (schema) /
  0.10 (free-form). The first render's "the failure is the
  constrained-decoding tax, not agreeableness" reading rested on
  union-scored free-form passes; per-attempt, the candidates fail both
  arms — consistent with a genuine pushback deficit, which is why every
  critique-shaped surface stays rejected. c9b showed no manufactured
  objections from any model in any wave.
- **c9b's zero spread is designed, not a defect.** It is the
  over-objection control: every model correctly declines to manufacture an
  objection, so equal scores are the expected pass. It is excluded from
  "discriminating cases available" consideration by construction and no
  verdict rests on it alone.
- **c2b's required-criteria floor (~0.1 for all models) is deliberate
  headroom.** Its verdict weight rides on the defect-regression gate: the
  incumbent caught the real historical defect
  (`pipeline-summary-sources.ts:237`) that both candidates missed in
  every attempt — the decisive scout reject.
- **The one routing flip is `researchRefute` → Gemini 3.6 Flash (High).**
  Both candidates cleared research-refute at N=10; the recommendation
  tie-break nominally preferred 3.1 Pro, but researchGather's default is
  already 3.1 Pro and a string-identical refute default trips
  `flow-research-run.ts`' cross-model diversity guard (silently
  downgrading the runtime refuter to the unbenched GPT-OSS fallback), so
  the cleared Flash variant is deployed instead. `planReviewSecond` does
  NOT flip despite plan-review's 3.1 Pro clear — the deep-tier second
  reviewer exists for cross-model diversity against the Gemini first
  reviewer. The gatekeeper clear (both candidates) has no wiring surface:
  the gatekeeper is a Claude Task subagent (pinned haiku) and the Task
  tool cannot spawn Gemini — recorded evidence for any future
  agy-delegated gatekeeper.
- **7 of the incumbent's 10 first-wave c2b attempts timed out at the
  default 5m** and were re-run at `--timeout 15m` (9/10 completed; 1
  residual failure). The candidates needed no re-run — the incumbent is
  simply slow on the 56KB prompt.
- **The blinded judge packet's ids are assigned in results order**, so
  same-model repeats are adjacent — a partial blinding weakness. The C1
  judged verdicts keyed on an objective property (external scratch-file
  pointer vs inline report), not style, so the weakness does not touch
  this run's verdicts.
