# Discovery revision-pass procedure (read only when the spawn prompt carries `REVISION: <n>`)

## Revision pass mode

When the invocation carries a `REVISION: <n>` marker (threaded by `/flow-pipeline`
step 3 through the same append channel as `RESEARCH:` / `MODEL_PLANNING:`, and forwarded
by the `{{REVISION_OVERRIDE}}` block in `flow-product-planning/SKILL.md`), you are **revising an
existing `plan.md` in place**, not drafting a fresh one. A `plan-pending-review` redirect
looped back to step 3: the user approved neither a blank slate nor a full re-plan — they
asked for a targeted change. Regenerating the whole document drifts every section the
redirect did not touch and destroys embedded markers. Follow this contract:

1. **Read the existing `plan.md` first** (at the plan path the wrapper passed) before
   writing anything. It is the base you edit, not a reference you replace.
2. **Update in place.** Change only the sections the redirect actually affects (scope,
   a task, a decision, an acceptance criterion). Leave every untouched section
   **byte-for-byte as it was** — do not re-word, re-order, or re-flow prose the redirect
   did not ask you to change.
3. **Preserve embedded markers verbatim.** The `### Cross-model review (AGY)` subsection
   under `## Decision analysis` AND its `<!-- flow-plan-review-hash: <sha> -->` marker are
   **MUST-NOT-REGENERATE**: leave them exactly as written unless the redirect materially
   changes one of the FOUR hashed inputs — the `**Goal:**` line, `## Decision analysis`,
   `## Cut list`, or `## Request vetting`. (If it does, edit the affected body and leave the stale marker — after
   the re-review the supervisor recomputes the hash over the final revised plan via
   `flow-plan-review --print-hash` and re-embeds it; the tolerant hash-read self-heals a
   lost marker, but needlessly rewriting it forces a wasteful re-review.) The
   `### Product critique (blind)` subsection under `## Open Questions` (written by
   `/flow-pipeline` step 3's supervisor after the blind product critic runs) is
   likewise MUST-NOT-REGENERATE: keep it verbatim and keep it the last subsection
   of `## Open Questions`; item 6's "extend, don't replace" rule appends new
   entries ABOVE it.
4. **Do NOT re-run Step 1.5 research** when web-grounded research findings already exist in
   the plan (or in `.flow-tmp/research-findings.md`). The redirect is a scope/decision
   change, not a new research question — re-running the fan-out double-spends agy quota for
   no new signal. Reuse the prior findings as-is.
5. **Do NOT re-run the Step 1.8 blind survey.** Reuse the file the `SURVEY:` marker names
   (the survey ran once, before the first discovery pass; a revision pass never re-fires
   it). Update `## Method selection` only when the redirect changes the chosen method —
   otherwise leave the section byte-for-byte as it was, same discipline as the embedded
   markers above.
6. **Extend, don't replace, `## Open Questions`.** Append the redirect's new questions;
   mark any prior question the redirect resolves with a short decision note (the same
   "mark resolved with a decision note" convention the section already uses) rather than
   deleting it, so the Q&A record of the plan's evolution stays intact across revisions.
   Redirect-added questions also carry the resolution markers where answerable — a
   `**Recommended:**` answer or a `**Needs user input:**` escape per the "Open
   Questions (resolution-first)" contract.

The `<n>` is a simple pass counter the supervisor tracks in-context (pass 2, 3, …); it
carries no payload beyond "this is a revision" — the redirect text itself arrives through
the normal `USER REDIRECT` channel. Absent the marker, ignore this section entirely and
draft fresh per steps 1–9.
