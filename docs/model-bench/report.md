## Per-surface verdicts

- **commit-msg** / gemini-3.1-pro-high: reject — mechanical parity failed on c5-commit-msg: recall 0.22 < incumbent 0.32 - 0.05
- **commit-msg** / gemini-3.6-flash-high: reject — latency payoff insufficient: gemini-3.6-flash-high median 4.54s is not <= 60% of incumbent's 6.45s
- **commit-msg** / gemini-3.7-flash-high: reject — latency payoff insufficient: gemini-3.7-flash-high median 15.48s is not <= 60% of incumbent's 6.45s
- **commit-msg** / gemini-3.8-flash-high: reject — mechanical parity failed on c5-commit-msg: recall 0.18 < incumbent 0.32 - 0.05
- **critique** / gemini-3.1-pro-high: reject — mechanical parity failed on c9a-pushback-wrong: recall 0.00 < incumbent 0.70 - 0.05
- **critique** / gemini-3.6-flash-high: reject — mechanical parity failed on c9a-pushback-wrong: recall 0.00 < incumbent 0.70 - 0.05
- **critique** / gemini-3.7-flash-high: reject — mechanical parity failed on c9b-pushback-control: recall 0.90 < incumbent 1.00 - 0.05
- **critique** / gemini-3.8-flash-high: reject — mechanical parity failed on c9b-pushback-control: recall 0.20 < incumbent 1.00 - 0.05
- **gatekeeper** / gemini-3.1-pro-high: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable, and a real latency payoff
- **gatekeeper** / gemini-3.6-flash-high: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable, and a real latency payoff
- **gatekeeper** / gemini-3.7-flash-high: inconclusive — mechanical parity borderline on c10-gatekeeper — re-run when models update
- **gatekeeper** / gemini-3.8-flash-high: reject — mechanical parity failed on c10-gatekeeper: recall 0.49 < incumbent 0.98 - 0.05
- **intent-guess** / gemini-3.1-pro-high: reject — mechanical parity failed on c4-intent-json: recall 0.92 < incumbent 1.00 - 0.05
- **intent-guess** / gemini-3.6-flash-high: reject — mechanical parity failed on c4-intent-json: recall 0.90 < incumbent 1.00 - 0.05
- **intent-guess** / gemini-3.7-flash-high: reject — mechanical parity failed on c4-intent-json: recall 0.91 < incumbent 1.00 - 0.05
- **intent-guess** / gemini-3.8-flash-high: reject — mechanical parity failed on c4-intent-json: recall 0.44 < incumbent 1.00 - 0.05
- **log-triage** / gemini-3.1-pro-high: reject — mechanical parity failed on c3-log-triage: recall 0.00 < incumbent 0.67 - 0.05
- **log-triage** / gemini-3.6-flash-high: reject — mechanical parity failed on c3-log-triage: recall 0.11 < incumbent 0.67 - 0.05
- **log-triage** / gemini-3.7-flash-high: reject — mechanical parity failed on c3-log-triage: recall 0.00 < incumbent 0.67 - 0.05
- **log-triage** / gemini-3.8-flash-high: reject — mechanical parity failed on c3-log-triage: recall 0.00 < incumbent 0.67 - 0.05
- **plan-review** / gemini-3.1-pro-high: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable, and a real latency payoff
- **plan-review** / gemini-3.6-flash-high: reject — mechanical parity failed on c6-plan-review: recall 0.88 < incumbent 1.00 - 0.05
- **plan-review** / gemini-3.7-flash-high: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable, and a real latency payoff
- **plan-review** / gemini-3.8-flash-high: reject — mechanical parity failed on c6-plan-review: recall 0.75 < incumbent 1.00 - 0.05
- **research-refute** / gemini-3.1-pro-high: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable, and a real latency payoff
- **research-refute** / gemini-3.6-flash-high: clear — cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable, and a real latency payoff
- **research-refute** / gemini-3.7-flash-high: reject — latency payoff insufficient: gemini-3.7-flash-high median 25.30s is not <= 60% of incumbent's 40.53s
- **research-refute** / gemini-3.8-flash-high: reject — mechanical parity failed on c8-research-refute: recall 0.11 < incumbent 0.90 - 0.05
- **review-lens** / gemini-3.1-pro-high: reject — mechanical parity failed on c7-review-lens: recall 0.75 < incumbent 0.83 - 0.05
- **review-lens** / gemini-3.6-flash-high: reject — mechanical parity failed on c7-review-lens: recall 0.75 < incumbent 0.83 - 0.05
- **review-lens** / gemini-3.7-flash-high: reject — mechanical parity failed on c7-review-lens: recall 0.00 < incumbent 0.83 - 0.05
- **review-lens** / gemini-3.8-flash-high: reject — mechanical parity failed on c7-review-lens: recall 0.00 < incumbent 0.83 - 0.05
- **scout** / gemini-3.1-pro-high: reject — defect regression on c2b-real-defect: gemini-3.1-pro-high missed "src/pipeline-summary-sources.ts.txt:237:real-defect", which claude-sonnet-4-6 caught
- **scout** / gemini-3.6-flash-high: reject — defect regression on c2b-real-defect: gemini-3.6-flash-high missed "src/pipeline-summary-sources.ts.txt:237:real-defect", which claude-sonnet-4-6 caught
- **scout** / gemini-3.7-flash-high: reject — defect regression on c2b-real-defect: gemini-3.7-flash-high missed "src/pipeline-summary-sources.ts.txt:237:real-defect", which claude-sonnet-4-6 caught
- **scout** / gemini-3.8-flash-high: reject — defect regression on c2b-real-defect: gemini-3.8-flash-high missed "src/pipeline-summary-sources.ts.txt:237:real-defect", which claude-sonnet-4-6 caught

## Where each candidate was worse

- **commit-msg** / gemini-3.1-pro-high: mechanical parity failed on c5-commit-msg: recall 0.22 < incumbent 0.32 - 0.05
- **commit-msg** / gemini-3.6-flash-high: latency payoff insufficient: gemini-3.6-flash-high median 4.54s is not <= 60% of incumbent's 6.45s
- **commit-msg** / gemini-3.7-flash-high: latency payoff insufficient: gemini-3.7-flash-high median 15.48s is not <= 60% of incumbent's 6.45s
- **commit-msg** / gemini-3.8-flash-high: mechanical parity failed on c5-commit-msg: recall 0.18 < incumbent 0.32 - 0.05
- **critique** / gemini-3.1-pro-high: mechanical parity failed on c9a-pushback-wrong: recall 0.00 < incumbent 0.70 - 0.05
- **critique** / gemini-3.6-flash-high: mechanical parity failed on c9a-pushback-wrong: recall 0.00 < incumbent 0.70 - 0.05
- **critique** / gemini-3.7-flash-high: mechanical parity failed on c9b-pushback-control: recall 0.90 < incumbent 1.00 - 0.05
- **critique** / gemini-3.8-flash-high: mechanical parity failed on c9b-pushback-control: recall 0.20 < incumbent 1.00 - 0.05
- **gatekeeper** / gemini-3.8-flash-high: mechanical parity failed on c10-gatekeeper: recall 0.49 < incumbent 0.98 - 0.05
- **intent-guess** / gemini-3.1-pro-high: mechanical parity failed on c4-intent-json: recall 0.92 < incumbent 1.00 - 0.05
- **intent-guess** / gemini-3.6-flash-high: mechanical parity failed on c4-intent-json: recall 0.90 < incumbent 1.00 - 0.05
- **intent-guess** / gemini-3.7-flash-high: mechanical parity failed on c4-intent-json: recall 0.91 < incumbent 1.00 - 0.05
- **intent-guess** / gemini-3.8-flash-high: mechanical parity failed on c4-intent-json: recall 0.44 < incumbent 1.00 - 0.05
- **log-triage** / gemini-3.1-pro-high: mechanical parity failed on c3-log-triage: recall 0.00 < incumbent 0.67 - 0.05
- **log-triage** / gemini-3.6-flash-high: mechanical parity failed on c3-log-triage: recall 0.11 < incumbent 0.67 - 0.05
- **log-triage** / gemini-3.7-flash-high: mechanical parity failed on c3-log-triage: recall 0.00 < incumbent 0.67 - 0.05
- **log-triage** / gemini-3.8-flash-high: mechanical parity failed on c3-log-triage: recall 0.00 < incumbent 0.67 - 0.05
- **plan-review** / gemini-3.6-flash-high: mechanical parity failed on c6-plan-review: recall 0.88 < incumbent 1.00 - 0.05
- **plan-review** / gemini-3.8-flash-high: mechanical parity failed on c6-plan-review: recall 0.75 < incumbent 1.00 - 0.05
- **research-refute** / gemini-3.7-flash-high: latency payoff insufficient: gemini-3.7-flash-high median 25.30s is not <= 60% of incumbent's 40.53s
- **research-refute** / gemini-3.8-flash-high: mechanical parity failed on c8-research-refute: recall 0.11 < incumbent 0.90 - 0.05
- **review-lens** / gemini-3.1-pro-high: mechanical parity failed on c7-review-lens: recall 0.75 < incumbent 0.83 - 0.05
- **review-lens** / gemini-3.6-flash-high: mechanical parity failed on c7-review-lens: recall 0.75 < incumbent 0.83 - 0.05
- **review-lens** / gemini-3.7-flash-high: mechanical parity failed on c7-review-lens: recall 0.00 < incumbent 0.83 - 0.05
- **review-lens** / gemini-3.8-flash-high: mechanical parity failed on c7-review-lens: recall 0.00 < incumbent 0.83 - 0.05
- **scout** / gemini-3.1-pro-high: defect regression on c2b-real-defect: gemini-3.1-pro-high missed "src/pipeline-summary-sources.ts.txt:237:real-defect", which claude-sonnet-4-6 caught
- **scout** / gemini-3.6-flash-high: defect regression on c2b-real-defect: gemini-3.6-flash-high missed "src/pipeline-summary-sources.ts.txt:237:real-defect", which claude-sonnet-4-6 caught
- **scout** / gemini-3.7-flash-high: defect regression on c2b-real-defect: gemini-3.7-flash-high missed "src/pipeline-summary-sources.ts.txt:237:real-defect", which claude-sonnet-4-6 caught
- **scout** / gemini-3.8-flash-high: defect regression on c2b-real-defect: gemini-3.8-flash-high missed "src/pipeline-summary-sources.ts.txt:237:real-defect", which claude-sonnet-4-6 caught

## Surfaces no candidate should take

- **commit-msg**: no candidate cleared every gate
- **critique**: no candidate cleared every gate
- **intent-guess**: no candidate cleared every gate
- **log-triage**: no candidate cleared every gate
- **review-lens**: no candidate cleared every gate
- **scout**: no candidate cleared every gate

## Case discrimination

- c4-intent-json (schema): spread 0.556
- c4-intent-json (free-form): spread 0.111
- c2b-real-defect (n/a): spread 0.122
- c6-plan-review (schema): spread 0.250
- c6-plan-review (free-form): spread 0.120
- c3-log-triage (n/a): spread 0.667
- c5-commit-msg (n/a): spread 0.217
- c9b-pushback-control (schema): spread 0.800
- c9b-pushback-control (free-form): spread 0.600
- c2-planted-defects (n/a): spread 0.287
- c10-gatekeeper (schema): spread 0.491
- c10-gatekeeper (free-form): spread 0.118
- c7-review-lens (schema): spread 0.833
- c7-review-lens (free-form): spread 0.500
- c9a-pushback-wrong (schema): spread 0.700
- c9a-pushback-wrong (free-form): spread 0.700
- c1-multifile-contract (n/a): spread 0.275
- c8-research-refute (schema): spread 0.889
- c8-research-refute (free-form): spread 0.300

## Schema tax

- claude-sonnet-4-6: overall tax 0.027 — recommended arm: schema (route with --json-schema (wire-level constrained decoding))
- gemini-3.1-pro-high: overall tax 0.007 — recommended arm: schema (route with --json-schema (wire-level constrained decoding))
- gemini-3.6-flash-high: overall tax -0.003 — recommended arm: schema (route with --json-schema (wire-level constrained decoding))
- gemini-3.7-flash-high: overall tax 0.066 — recommended arm: free-form (route without --json-schema; use flow's local parse-and-validate fallback)
- gemini-3.8-flash-high: overall tax 0.362 — recommended arm: free-form (route without --json-schema; use flow's local parse-and-validate fallback)

## Run provenance

- commit: d4c891b30bd17cabce0d83f60560c0b579d776ec
- agy version: 1.1.27
- models: gemini-3.6-flash-high, gemini-3.1-pro-high, claude-sonnet-4-6, gemini-3.7-flash-high, gemini-3.8-flash-high
- incumbent: claude-sonnet-4-6
- run date: 2026-09-05
- repeat tiers: {"c4-intent-json":10,"c2b-real-defect":10,"c6-plan-review":10,"c3-log-triage":3,"c5-commit-msg":10,"c9b-pushback-control":10,"c2-planted-defects":10,"c10-gatekeeper":10,"c7-review-lens":3,"c9a-pushback-wrong":10,"c1-multifile-contract":10,"c8-research-refute":10}

## Limitations

- Repeat tiers (N=10 on decision-bearing surfaces, N=3 elsewhere) are far below the N>=30 that stable latency percentiles call for; medians are reported but underpowered.
- Planted-defect detection rates are selection-biased toward authorable defects and do not generalise to natural defects; the c2b real-defect control narrows but does not close that gap.
- The incumbent baseline runs claude-sonnet-4-6 under agy's scaffold, not the Claude Code scaffold production uses — scaffold-matched to the candidates, but not production-matched.
- Tokens/usage are descriptive only and never gate a verdict.
- Latency is read from durationSeconds (agy's own model-time reading), never the fanout's pool wall-clock.
- A non-discriminating case contributes no clear verdict for any candidate on that surface.
- Non-discriminating this run: none.

## Production-scaffold reference

Not captured this run. The plan called for one manually-captured
production `flow-scout` run on case C1 as a labelled reference point, but
capturing it from the pipeline supervisor would require a Task-tool spawn
outside the nine named exemptions in `skills/pipeline/flow-pipeline/SKILL.md`
— an unauthorized tenth fan-out site. The scaffold gap it would have
narrowed is named in `## Limitations` (agy-hosted incumbent baseline);
capture it from a plain interactive session on a future re-run.

## Narrative caveats

- **Two provenance generations, one merged evidence set (as of the
  2026-08-17 render — see the third-generation bullet below for this run's
  784+196 merge).** The incumbent (claude-sonnet-4-6) and prior-candidate
  (gemini-3.1-pro-high, gemini-3.6-flash-high) entries were reused verbatim
  from the 2026-08-05 run (agy 1.1.10 — itself three dispatch waves: the
  original commit f784a0b dispatch, a hardened-fixture re-run of
  c4/c6/c8/c10, and an N=10 repeat-tier re-run of c5/c6/c8/c10), merged with
  the 2026-08-17 gemini-3.7-flash-high dispatch (agy 1.1.13, 196 entries).
  At that render, order was committed-first: the 588 committed entries
  preceded the 196 new ones, load-bearing for recommend()'s appearance-order
  tie-break. The `## Run provenance` commit is the harness commit at
  final-render time; per-entry provenance is the entry itself.
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
- **First-wave free-form entries carry `parseRetries: 1`** — an inherited
  artifact of a `flow-delegate --structured-fallback` bug (fixed in
  4f9ab92, before the 2026-08-05 waves 2–3) where json-mode fed the raw
  agy envelope to the local parser, so every first-wave free-form call ran
  agy twice and its `durationSeconds` reflects the retry attempt — the
  reused first-wave entries still carry that latency inflation. The
  2026-08-17 gemini-3.7-flash-high entries are unaffected. Quality
  scoring was never affected — the runner has always unwrapped the
  envelope itself before scoring.
- **No parse-integrity gated metric this run.** The enforce-json-schema
  plan proposed filing a candidate issue for a parse-integrity gate, but
  the issue was never filed (issue sweep + repo grep both empty,
  2026-08-17), so this run measures the existing rubric only and records
  `parseRetries` descriptively — it gates no verdict.
- **The D2 judged carry-over sanity check FAILED, so all 40 c1 entries
  were fresh blind-judged.** The committed 33-id judged.json could not be
  mapped onto a reconstruction of the committed packet: its ids r374–r406
  land on c5/c6 entries in the reconstruction, and 33 judged ids exceed
  the 30 committed c1 entries — the original packet covered
  superseded-wave entries that were never committed. All 40
  c1-multifile-contract entries (r216–r245, r670–r679) were therefore
  re-judged blind on the same objective property (report delivered inline
  vs a pointer to an external scratch file), key unread until verdicts
  were written. The packet and key are now committed
  (docs/model-bench/judge-packet.json, judge-key.json) so no future run
  needs to reconstruct the blinding.
- **The earlier log-triage "clear" for gemini-3.6-flash-high was a
  union-scoring artifact.** Per-attempt, flash names the required
  failure-triage facts in ~1 of 9 attempts (recall 0.11 vs the
  incumbent's 0.67) — now a reject. The previously-noted "flow has no
  failure-log triage surface" follow-up note is moot: there is no clear to
  wire.
- **The sycophancy interpretation changed with scoring granularity — and
  3.7 Flash partially breaks the pattern.** On c9a the incumbent names
  the planted false element at 0.70 (schema) / 0.80 (free-form)
  per-attempt; both 2026-08-05 candidates score 0.00 (schema) / 0.10
  (free-form) — consistent with a genuine pushback deficit.
  gemini-3.7-flash-high held c9a parity; its critique reject moved to the
  c9b control (recall 0.90 vs the incumbent's 1.00), so critique-shaped
  surfaces stay rejected for all three candidates, but the
  every-Gemini-fails-pushback premise no longer holds.
- **c9b's near-zero spread is designed, not a defect.** It is the
  over-objection control: models correctly decline to manufacture an
  objection, so tightly-clustered scores are the expected pass (3.7
  Flash's 0.90 schema-arm miss is the one exception this run, and it is
  the decisive critique gate). It contributes no clear on its own.
- **c2b's required-criteria floor (~0.1 for all models) is deliberate
  headroom.** Its verdict weight rides on the defect-regression gate: the
  incumbent caught the real historical defect
  (`pipeline-summary-sources.ts:237`) that every candidate — including
  gemini-3.7-flash-high — missed in every attempt, the decisive scout
  reject.
- **One routing default flipped: `planReview` → Gemini 3.7 Flash (High).**
  Per surface, the 2026-08-17 evidence showed: **plan-review** —
  3.7-flash-high cleared every gate on c6 at N=10 and recommend()'s
  quality-gated tie-break nominated it over 3.1 Pro's standing clear, so
  `planReview` flipped (decisive gate: full clear + nomination).
  **research-refute** — no flip: 3.7-flash-high was rejected on the
  latency-payoff gate (median 25.30s, not <= 60% of the incumbent's
  40.53s) even though it reached c9a pushback parity, and the nominated
  3.1 Pro remains undeployable — a refute default string-identical to
  researchGather's trips `flow-research-run.ts`' cross-model diversity
  guard, silently downgrading the refuter to the unbenched GPT-OSS
  fallback. So `researchRefute` stays on the incumbent; a maintainer can
  set `delegate.models.researchRefute` with no code change.
  **planReviewSecond** — structural no-flip: the deep-tier second
  reviewer exists for cross-model diversity against the Gemini first
  reviewer and never flips on candidate quality. **scout** — no flip:
  3.7-flash-high hit the same c2b real-defect regression as both prior
  candidates, so `scout: null` (Claude Task subagent) stands.
  **intent-guess / review-lens** — no flip: c4/c7 mechanical-parity
  rejects. **gatekeeper** (3.7: inconclusive on c10, borderline),
  **commit-msg**, **log-triage**, and **critique** have no delegate
  wiring — evidence recorded here only.
- **7 of the incumbent's 10 first-wave c2b attempts timed out at the
  default 5m** and were re-run at `--timeout 15m` (9/10 completed; 1
  residual failure). The candidates needed no re-run — the incumbent is
  simply slow on the 56KB prompt.
- **The blinded judge packet's ids are assigned in results order**, so
  same-model repeats are adjacent — a partial blinding weakness. The C1
  judged verdicts keyed on an objective property (external scratch-file
  pointer vs inline report), not style, so the weakness does not touch
  this run's verdicts.

- **A third provenance generation, and the newest arm is the reason to read
  this section first.** The `gemini-3.8-flash-high` entries were dispatched
  2026-09-05 under agy 1.1.27, merged (committed-first) over the 2026-08-05
  arms (agy 1.1.10) and the 2026-08-17 `gemini-3.7-flash-high` arm (agy
  1.1.13). The blind-judge carry-over check PASSED this time — all 699
  pre-existing ids kept their exact `(id -> model)` mapping across the merge,
  so only the 10 new `c1-multifile-contract` entries (r840-r849) were judged
  fresh, and every committed verdict is byte-unchanged. This is the check
  that failed in the 2026-08-17 run and forced a full re-judge.
- **`gemini-3.8-flash-high` returned an EMPTY response on 83 of 196 committed
  entries (42.3%) — two counting frames, stated separately.** The
  **committed-artifact frame** (`(.response // "") == ""` over
  `docs/model-bench/results.json`, the reproducible-from-the-repo number) is
  83/196 (42.3%). Comparison arms in this bullet all use this same frame:
  0.5% for `claude-sonnet-4-6` (1/196), 5.6% for `gemini-3.1-pro-high`
  (11/196), 5.1% for `gemini-3.6-flash-high` (10/196), and 11.2% for
  `gemini-3.7-flash-high` (22/196) — 3.8 is roughly 3.8x the worst prior arm
  and a categorical break in the trend. Separately, the **raw-envelope
  frame** (the 196 pre-serialization dispatch envelopes in
  `.flow-tmp/model-bench-38/raw/`, uncommitted — a 2-3 entry redacted sample
  is committed at `docs/model-bench/denied-actions-sample.json` for
  auditability) counts 81 empty responses, and 80 of those 81 are exactly the
  envelopes where agy recorded `denied_actions: [RunCommand]`. The two
  frames differ (83 vs 81) because the committed serializer drops the
  `response` key entirely on the 6 `ran: false` rows, which the
  committed-artifact frame's `(.response // "")` rule also counts as empty —
  a distinct failure mode from a denied action, and not reconciled 1:1
  against the raw-envelope count above. Every single denied-action envelope
  came back empty; none recovered. The mechanism: 3.8 attempts a shell tool
  call, `flow-delegate`'s default `--sandbox` posture denies it, and the
  model returns `status: SUCCESS` with `response: ""` after spending its
  output budget on thinking tokens (a representative envelope: 1228 output
  tokens, 1159 of them thinking, 5.36s, empty body — see the committed
  sample file).
- **That empty-response behaviour is a DEPLOYMENT-VALID signal, not a harness
  artifact.** `flow-delegate` passes `--sandbox` and does NOT pass
  `--skip-permissions` (it is opt-in), and no production delegate surface —
  `flow-plan-review`, `flow-gemini-lens`, `flow-gemini-intent-guess`,
  `flow-blind-survey` — opts in. The bench therefore ran
  3.8 under exactly the permission posture flow uses in production, so the
  42.3% committed-artifact empty rate is what flow would actually get from
  this model today. A
  separate `--skip-permissions` run would measure 3.8's ceiling rather than its
  deployed behaviour; that is a different question and is not what gates a
  routing default.
- **2026-09-10 addendum:** `flow-research-run`'s gather/refute manifest
  entries opted into `--skip-permissions` after this bench ran (research
  §Task 1/2/4b, no `--add-dir` granted), so a future re-bench of this
  surface must exclude it from the "no production delegate surface opts in"
  posture claim above — the historical measurement and its numbers here are
  unchanged.
- **Result: `gemini-3.8-flash-high` is rejected on all nine surfaces, so the
  strict flip rule produced ZERO flips.** Every reject is a mechanical-parity
  or defect-regression failure; not one is a latency reject. Recall collapses
  track the empty responses directly — `review-lens` 0.00, `log-triage` 0.00,
  `research-refute` 0.11, `commit-msg` 0.18, `critique` 0.20, `intent-guess`
  0.44, `gatekeeper` 0.49, `plan-review` 0.75, plus a `c2b-real-defect` miss
  on `scout`.
- **The planned incumbent calibration subset was deliberately NOT dispatched.**
  It existed to size the agy-1.1.27-vs-1.1.13 latency skew so a latency-gate
  verdict could be read honestly. No 3.8 verdict this run turned on a latency
  gate, so the subset would have informed nothing and its ~20 metered calls
  were not spent. Re-instate it the moment a future arm produces a latency
  reject.
- **Per-surface routing decisions from this run (all non-flips).** `planReview`
  holds `Gemini 3.7 Flash (High)` — `plan-review`'s recommendation is still
  `gemini-3.7-flash-high`, re-confirmed against the new arm. `intentGuess`,
  `reviewLens`, `researchGather`, `blindSurvey` hold `Gemini 3.1 Pro (High)`.
  `researchRefute`, `planReviewSecond`, `blindSurveySecond` hold
  `Claude Opus 4.6 (Thinking)` — structural cross-vendor holds, and 3.8's
  `research-refute` reject means the D1 question did not even arise this run.
  `scout` holds `null`.
- **`researchGather` and `blindSurvey` remain unbenchable.** `bin/fixtures/
  model-bench/` contains no `research-gather` and no `blind-survey` case, so
  this run produced no evidence for either surface and no future run will
  until those fixtures exist. Their defaults are unchanged and the source now
  says so explicitly rather than leaving silence to read as a clear.
