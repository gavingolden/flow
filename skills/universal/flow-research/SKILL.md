---
name: flow-research
description: >-
  Deep, multi-source, fact-checked research that fans the expensive
  web-grounded gathering and adversarial refutation out to the user's Google
  AI Ultra quota (via flow-delegate / agy), then has Claude synthesize a
  confidence-ranked cited report. Use when the user wants a deep-research
  report, a multi-source fact-check, an adversarially-verified answer, or a
  literature-style sweep on a question — "research X", "fact-check this
  claim", "what does the evidence say about Y". Orchestration is
  Claude-only; every token-spending model call is delegated to agy, never a
  nested Claude sub-agent.
---

# Goal

Produce a rigorous, cited research report on a question — decompose it, gather
web-grounded evidence, adversarially verify the load-bearing claims on a
_different_ model, and synthesize confidence-ranked findings — while routing
every token-spending model call through `flow-delegate` / `agy` on the user's
mostly-idle Ultra quota instead of burning Claude credits. Claude keeps only
the cheap judgment (decompose) and the bounded synthesis; the expensive
gathering and refutation run as `agy` subprocesses, fanned out concurrently by
`flow-delegate-fanout`.

This is roadmap item **F1** for `flow-delegate`. Wiring it into
`/product-planning` discovery (roadmap **F2** / issue #338) is **now done**:
the discovery sub-agent gathers web-grounded evidence before planning by driving
`flow-delegate-fanout` **directly via Bash** — a spawned Task sub-agent does **not**
have the `Skill` tool, so it cannot load this skill in-process; it `Read`s this
skill's procedure and runs the fan-out itself. That F2 use is a **Bash fan-out**
(`flow-delegate-fanout`), **not a nested Task** — the discovery sub-agent
itself is this pipeline's orchestrating "Claude", so the no-nested-LLM
invariant and the nine-exemption count are preserved (no new exemption). The
F2 caller runs a **tightened budget** (`--max-calls 12` plus a 3-minute
per-entry `timeout: "3m"`) per the "Tighten for the #338 supervisor context"
guidance in Constraints below, because a one-shot sub-agent has no
yield/resume and its synchronous run must stay under the observed-safe
~10-min ceiling. This skill's own research procedure (Instructions, report
template, fan-out logic) is unchanged by that wiring.

# When to Use

- The user asks for deep research, a multi-source fact-check, or an
  adversarially-verified answer on a question: "research X", "what does the
  evidence say about Y", "fact-check this".
- A question is broad enough to warrant decomposition into several angles and
  cross-checking of its claims, not a single lookup.
- You want the expensive web-grounded gathering + refutation to land on idle
  Ultra quota rather than Claude credits.

# When NOT to Use

- A single, narrow factual lookup that one `WebSearch` / `WebFetch` (or one
  `flow-delegate` call) answers — the fan-out overhead is not worth it.
- The question is underspecified (e.g. "what car should I buy" with no budget,
  use-case, or region). Ask 2–3 clarifying questions to narrow scope first,
  then research the refined question.
- Writing code, planning a feature, or reviewing a PR — those are other skills.

# Context

- **Delegation primitive:** `flow-delegate` runs one prompt on Ultra quota via
  the headless `agy` CLI (native Google web search, model-variant selection,
  graceful skip when `agy` is absent). It emits a one-line JSON envelope
  (`{ran, task, model, artifactPath?, skipReason?, durationMs?}`) and exits 0
  on success OR a graceful skip — callers branch on the `ran` field, never the
  exit code. There is NO deep-research / deep-think mode and NO
  `--effort` / `--thinking` flag on `agy`; **the fan-out _is_ the
  deep-research mechanism.**
- **Fan-out primitive:** `flow-delegate-fanout --manifest <file>
[--concurrency <K>] [--max-calls <B>] [--out <path>]` runs a manifest of
  `flow-delegate` calls concurrently (bounded pool, default K=4), enforces a
  generous per-run total-call budget (default B=40, counted as dispatch
  attempts), and aggregates one JSON
  `{ entries:[{task,model,ran,artifactPath?,skipReason?,durationMs?}], anyRan,
allSkipped, calls:{attempted,ran,skipped,budget} }` to stdout AND `--out`. A
  manifest entry is `{ task, model, prompt|promptFile, timeout?, addDirs?,
out? }`. It backgrounds + persists to `--out` like `flow-ci-wait`, so a deep
  run can outlive the harness foreground budget and a resumed turn reads the
  result file.
- **Exact agy model variants** (live `agy models`, do not paraphrase): gather
  runs on `Gemini 3.1 Pro (High)`; refutation runs on a DIFFERENT variant from
  {`Claude Opus 4.6 (Thinking)`, `GPT-OSS 120B (Medium)`}.
- **Coding / output standards:** `AGENTS.md`. The no-nested-LLM rule is
  load-bearing here — see Constraints.
- [report template](references/report-template.md) — the cited-report
  structure the synthesis step fills in (confidence-ranked findings,
  refuted-claims transparency block, caveats, degraded/partial-run flag).

# Instructions

The pipeline is **Claude-orchestrated, agy-delegated**: Claude decomposes and
synthesizes; the expensive gathering and refutation are `agy` subprocesses
fanned out by `flow-delegate-fanout`. Pick a short `<run-id>` (e.g. a slug of
the question + a timestamp) and keep all artifacts under
`.flow-tmp/research/<run-id>/`.

## 1. Scope / decompose (Claude — cheap, no delegation)

Decompose the question into 3–6 orthogonal angles that together cover it, plus
**one explicit contrarian angle** (a framing that actively looks for evidence
the likely answer is wrong). This is cheap reasoning — do it in Claude, do not
delegate it. Write the angles down; they become the gather manifest.

## 2. Gather (agy fan-out via `flow-delegate-fanout`)

Build a gather manifest — one entry per angle — and write it to
`.flow-tmp/research/<run-id>/gather-manifest.json`. **Every gather entry uses
`"model": "Gemini 3.1 Pro (High)"`.** This GATHER step is a single-model
monoculture (agy's native Google grounding is the point); cross-model
diversity lives only in the refute step (Step 3). Do not claim pervasive
diversity — the diverse signal is adversarial, in the refute step.

Each gather prompt instructs the model to, for its angle, return **falsifiable
claims, each WITH a supporting verbatim quote and a source-quality grade** from
{`primary`, `secondary`, `blog`, `forum`, `unreliable`}, and to keep full
source fidelity (URLs, titles) in its artifact. Extracting claims-with-quotes
on agy is what lets Claude later ingest condensed claims rather than raw pages.

Pass a longer `--timeout` per entry than agy's `5m` default (deep web-grounded
Gemini runs — e.g. `8m`–`10m`). Then invoke the fan-out via Bash:

```bash
flow-delegate-fanout \
  --manifest .flow-tmp/research/<run-id>/gather-manifest.json \
  --out .flow-tmp/research/<run-id>/gather-result.json
```

Read the aggregate. If `allSkipped` is true, take the agy-absent fallback
(below). Otherwise read each ran entry's `artifactPath` to collect the
extracted claims-with-quotes-and-grades.

## 3. Adversarial verify (agy fan-out, model-DIVERSE)

In Claude, **rank the gathered claims by importance × source-quality** and
select the top-N to verify (N is a generous default, ~40, tunable — see
Constraints). For each selected claim, build a refute manifest entry that runs
on a **DIFFERENT model from the gatherer** — a variant from
{`Claude Opus 4.6 (Thinking)`, `GPT-OSS 120B (Medium)`} — so the adversarial
signal is genuinely cross-model rather than one model checking itself. Write it
to `.flow-tmp/research/<run-id>/refute-manifest.json`.

Each refute prompt is a skeptic checklist: **attempt to refute the claim WITH
sources** (not bare assertion), **rate confidence** from {`high`, `medium`,
`low`}, and **name the weakest assumption** the claim rests on. Run the fan-out:

```bash
flow-delegate-fanout \
  --manifest .flow-tmp/research/<run-id>/refute-manifest.json \
  --out .flow-tmp/research/<run-id>/refute-result.json
```

Apply the **diversity-adjusted voting rule**: 1 diverse-model refutation vote
**FLAGS / CONTESTS** a claim (surface it with reduced confidence), 2 diverse
votes **KILL** it (move it to the refuted block). This is deliberately NOT
"1 vote + default-to-refuted" — each agy vote is a heavier cross-model
subprocess and a single shaky cross-model refutation is too trigger-happy to
nuke a claim. A claim with no valid refutation vote survives at its gathered
confidence; an abstain (null / unparsable refute envelope) is not a vote.

## 4. Synthesize (Claude — BOUNDED input)

Synthesize in Claude, but **bound the ingest**: read at most the top-N
importance×quality-ranked claims, and truncate each supporting quote to a
documented cap (~75 words). The cap drops only the low-value tail; when it
truncates, **FLAG the truncation** in the report rather than silently dropping
material. Write the report to the [report template](references/report-template.md)
shape: confidence-ranked findings (each finding = claim + confidence
high/medium/low + supporting sources/quotes + weakest assumption), a
**refuted-claims transparency block** (every contested/killed claim with its
refuting source + vote outcome), caveats, and open questions.

**Return the cited report in chat AND write it to
`.flow-tmp/research/<run-id>/report.md`** so a resumed turn or a downstream
consumer can read the file.

## 5. Partial-exhaustion rule

If the fan-out reports `budget-exhausted` or `agy-error` skips MID-RUN (some
gather/refute calls ran, then later ones were truncated or errored), **proceed
with what gathered and FLAG the report as degraded / partial confidence** —
name which sub-questions went un-gathered and which claims went un-refuted, in
the degraded/partial-run flag section of the template. Never present a
half-researched report as a complete research result. A budget-truncated run is
detectable from the aggregate's `calls` counts and the per-entry
`skipReason:"budget-exhausted"`.

## 6. Graceful agy-absent fallback (honestly degraded, three-tier)

When agy is available, **Tier 1** is always preferred: the agy fan-out via
steps 1–5 above — the Ultra-quota cost-arbitrage path (cross-model adversarial
signal, no Claude credits spent). The two tiers below are the degradation chain
that fires only when the first fan-out's aggregate has `allSkipped:true` (or the
first `flow-delegate` envelope is `ran:false` with `agy-not-found` /
`agy-not-authenticated`) — i.e. `agy` is unavailable.

### Tier 2 — `claude -p /deep-research` (stronger fallback, STANDALONE-ONLY)

When agy is absent **and ALL of the guard conditions below hold**, run Claude's
own deep-research workflow (decompose → search → fetch → verify → synthesize) as
a one-shot Bash subprocess on Claude credits, and surface its cited report body
**verbatim**:

```bash
claude -p "/deep-research <question>" --output-format text --permission-mode bypassPermissions
```

Label the result plainly as a **Claude-credits fallback** that **spent the
credits agy was meant to save** — it is NOT parity with the agy path (no Ultra
cost-arbitrage; it is a single Claude session doing the research, not a
cross-model fan-out). It is, however, materially stronger than the Tier-3
sequential degrade because it runs the full decompose/verify/synthesize loop.

Tier 2 fires **only when ALL three hold**:

- **(a) Context-boundary guard** (standalone leaf invocation — never inside the
  `/flow-pipeline` supervisor or the #354 discovery sub-agent):

  ```bash
  [ -z "$CLAUDE_CODE_CHILD_SESSION" ] && [ -z "$FLOW_PIPELINE" ]
  ```

  **Detection mechanism + its known limitation, inline:** `CLAUDE_CODE_CHILD_SESSION`
  is set in spawned Claude sub-agents, so it reliably guards the #354 discovery
  sub-agent (a spawned sub-agent firing `claude -p` would be a nested LLM, which
  is forbidden). But `CLAUDE_CODE_CHILD_SESSION` **cannot** distinguish the
  `/flow-pipeline` supervisor — itself a top-level tmux `claude`, where the var
  is unset — from a genuine standalone run. That is why the supervisor now
  exports a belt-and-suspenders `FLOW_PIPELINE=1` marker (an `env FLOW_PIPELINE=1`
  argv prefix on its launch command); the guard checks BOTH so a Tier-2
  subprocess never fires inside the supervisor.

- **(b) Config gate ON — DEFAULT ON** via a tolerant `jq -e` read of the global
  `~/.flow/config.json` key `research.deepResearchFallback`. A sub-agent / skill
  cannot import flow's `bin/lib` (it is not on PATH in a consumer worktree — see
  the F2 idiom at
  `skills/pipeline/product-planning/references/discovery-instructions.md:53-59`),
  so read the always-present global config via `jq`. **This INVERTS the F2
  default-OFF `== true` predicate — do NOT copy `== true`.** Absent file,
  malformed JSON, an absent/non-object `research`, or a missing
  `deepResearchFallback` key all mean ON; only an explicit boolean `false`
  disables:

  ```bash
  jq -e '(.research.deepResearchFallback) == false' ~/.flow/config.json >/dev/null 2>&1 \
    && DEEP_RESEARCH_FALLBACK=off || DEEP_RESEARCH_FALLBACK=on
  ```

  The `jq -e` exits 0 (truthy) ONLY when the key is explicitly `false`, so the
  `||` branch (default ON) covers every tolerant case — missing file, parse
  error, absent/non-object `research`, or absent key.

- **(c) The `claude` binary is on PATH** (`command -v claude`).

When all three hold, run the subprocess, surface the report verbatim, and set
the report's degraded/partial-run flag to name **tier-2 (`claude -p
/deep-research`)** as the producer.

### Tier 3 — sequential WebSearch / WebFetch (last resort)

This is the **only** tier available in a guarded / nested context (when guard
(a) is false — inside the supervisor or the #354 discovery sub-agent — or when
gate (b) is off or `claude` is off PATH). Fall back to Claude's own `WebSearch` /
`WebFetch`, and state plainly in a one-line notice that this fallback is
**degraded** and **sequential** — Claude doing the research itself, materially
weaker than the parallel agy path (no cross-model adversarial signal, no cost
arbitrage). In the #338 / #354 supervisor + discovery-sub-agent context the
caller cannot fan out at all, so there the fallback is strictly sequential. Do
not imply parity with the agy path. Set the report's degraded/partial-run flag to
name **tier-3 (sequential WebSearch)** as the producer.

Every fallback report's degraded/partial-run flag MUST name **which tier**
produced it (tier-2 `claude -p` vs tier-3 sequential).

# Anti-Patterns

- **A nested Claude sub-agent anywhere in the pipeline.** Every token-spending
  model call is a `flow-delegate` / `flow-delegate-fanout` Bash call. Spawning
  a Claude sub-agent here would violate the load-bearing no-nested-LLM rule and
  cannot run inside the `/flow-pipeline` supervisor at all.
- **Conflating a sub-agent with the Tier-2 leaf subprocess.** Two distinct
  cases: (i) a nested Claude _sub-agent_ (a `Task` / `Agent` spawn) is **always**
  banned, with **no carve-out** — that ban is what the structural lint enforces;
  (ii) the Tier-2 `claude -p /deep-research` Bash subprocess is **permitted but
  ONLY in a standalone context**. It is **forbidden** inside the `/flow-pipeline`
  supervisor or the #354 discovery sub-agent — there the context-boundary guard
  (`CLAUDE_CODE_CHILD_SESSION` / `FLOW_PIPELINE`) makes it skip straight to
  Tier 3. An unguarded `claude -p` (one not co-located with the guard tokens) is
  the anti-pattern; the lint goes red on it.
- **A single-model "self-check".** Refuting a Gemini-gathered claim on Gemini
  is one model checking itself, not an adversarial signal. The refute step MUST
  run on a different variant.
- **Unbounded synthesis ingest.** Reading every raw page or every claim with
  full-length quotes into Claude's context defeats the cost-bound; ingest the
  ranked top-N with capped quotes and flag on truncate.
- **Shipping a partial run as complete.** A budget-exhausted or agy-error
  mid-run must degrade the report's confidence and name the gaps, not be
  silently presented as a finished result.
- **Paraphrasing the agy model-variant strings.** A wrong / renamed variant
  silently forces a skip. Keep `Gemini 3.1 Pro (High)`,
  `Claude Opus 4.6 (Thinking)`, `GPT-OSS 120B (Medium)` byte-exact.

# Verification

- The gather manifest pins `Gemini 3.1 Pro (High)`; the refute manifest pins a
  different variant from {`Claude Opus 4.6 (Thinking)`, `GPT-OSS 120B (Medium)`}.
- The report has confidence-ranked findings (high/medium/low), a refuted-claims
  transparency block, caveats, and open questions; it is both returned in chat
  and written to `.flow-tmp/research/<run-id>/report.md`.
- Any cap-truncation, budget-exhaustion, or agy-absent fallback is FLAGGED in
  the report (degraded/partial-run section), never silent — and the flag names
  WHICH tier produced a fallback report (tier-2 `claude -p` vs tier-3 sequential).
- No nested Claude sub-agent was spawned; the fan-out ran via
  `flow-delegate-fanout`.
- Any `claude -p` mention is **guard-co-located** — it appears in the same
  section as the context-boundary guard tokens (`CLAUDE_CODE_CHILD_SESSION` /
  `FLOW_PIPELINE`), so the Tier-2 leaf subprocess can never fire inside the
  supervisor or the discovery sub-agent (mirrors the "No nested Claude
  sub-agent was spawned" line above; enforced by the structural lint).

# Constraints

- **No nested LLM sub-agent.** Claude orchestrates only; the fan-out is `agy`
  subprocesses via the `flow-delegate` binary. NO Claude fan-out tool (the
  `Task` / `Agent` spawn and its agent-type field) anywhere in this procedure —
  this is the load-bearing `AGENTS.md` constraint, enforced by a structural lint
  (`bin/flow-research-skill-lint.test.ts`) asserting this file carries no Claude
  sub-agent fan-out tokens (the lint's regex pins the exact spawn-call and
  agent-type identifiers). The **Tier-2 `claude -p` leaf subprocess** (Section 6)
  is the single named exception and is NOT a sub-agent: it is a standalone-only
  Bash subprocess, permitted only when the context-boundary guard
  (`CLAUDE_CODE_CHILD_SESSION` / `FLOW_PIPELINE`) confirms this is not the
  supervisor or the discovery sub-agent. Every `claude -p` mention must be
  guard-co-located; the same lint goes red on an unguarded one.
- **Caps are generous-and-tunable, never silently lossy.** Synthesis top-N
  claims (~40), supporting-quote length (~75 words), `flow-delegate-fanout`
  `--max-calls` budget (default 40), `--concurrency` (default 4) — every cap
  is importance×quality-ranked so it bounds only the pathological case, is
  overridable via flag / manifest, and FLAGS reduced confidence rather than
  dropping material findings. Tighten for the #338 supervisor context (where
  Claude's window is most load-bearing); loosen for standalone deep dives.
- **agy contract fidelity:** the prompt is the final token; detect skip on the
  `ran` field, not the exit code; agy reads cwd by default; pass a longer
  `--timeout` for deep gather passes than the `5m` default. There is no
  deep-research mode — the fan-out is the mechanism.
- **Quota is a real ceiling.** Ultra quota refreshes on a ~5h window and a full
  run is ~30 agy calls, so concurrent pipelines can exhaust it. The per-run
  `--max-calls` budget bounds a single run; cross-run accounting is a deferred
  follow-up. Honor the partial-exhaustion rule when it hits.
