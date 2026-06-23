# Research report template

The structure the `flow-research` synthesis step fills in. Each report is
returned in chat AND written to `.flow-tmp/research/<run-id>/report.md`. Drop
any section that genuinely does not apply, but never drop the refuted-claims
block or the degraded/partial-run flag when the run hit refutation or
exhaustion — those are the transparency contract.

---

## Question & scope

State the exact question researched (the refined version, after any clarifying
narrowing). Name the angles it was decomposed into, including the explicit
contrarian angle. Note the date the research ran (sources rot).

## Executive summary

Two to four sentences: the best-supported answer and its overall confidence.
Lead with the conclusion, then the single biggest caveat.

## Confidence-ranked findings

Order by confidence, highest first. For each finding:

- **Claim** — one falsifiable sentence.
- **Confidence** — `high` / `medium` / `low`.
- **Supporting sources** — the verbatim supporting quote(s) and their source
  (URL / title) and source-quality grade (`primary` / `secondary` / `blog` /
  `forum` / `unreliable`). Quotes are truncated to the documented cap; a
  truncated quote is marked `[…truncated]`.
- **Weakest assumption** — the assumption the claim most depends on (surfaced
  by the adversarial-verify step).

## Refuted-claims transparency block

Every claim that the adversarial-verify step CONTESTED or KILLED, with:

- **Claim** — the original claim.
- **Outcome** — `flagged` (1 diverse-model refutation vote — surfaced with
  reduced confidence) or `killed` (2 diverse votes — removed from findings).
- **Refuting source** — the verbatim counter-evidence quote + its source and
  grade, and which model voted.

A claim that survived with no refutation vote does NOT appear here; it appears
in the findings at its gathered confidence.

## Caveats & open questions

- Known limitations of the evidence base (single-model gather monoculture, thin
  primary sources, recency gaps).
- Questions the research could not resolve and what evidence would resolve them.

## Degraded / partial-run flag

Populate ONLY when the run hit the agy-absent fallback or budget / quota
exhaustion. Name explicitly:

- Whether the run used the **degraded, sequential Claude-only fallback** (agy
  absent / logged out) rather than the parallel agy path.
- Which sub-questions went **un-gathered** and which claims went
  **un-refuted** because the per-run `--max-calls` budget was exhausted or an
  `agy-error` skip hit mid-run.
- The resulting **reduced overall confidence**, so the reader treats this as a
  partial result, not a complete one.

When this section is empty, the run completed on the full agy path within
budget.
