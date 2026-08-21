# flow-eval — recorded baselines

This directory holds the committed, before/after comparison surface for
flow's three supervisor context-isolation scaffolds. Each suite under
`evals/` gets two committed files here once a maintainer records it:

- `<suite>.report.json` — the full `EvalReport` (schemaVersion 1, see
  `bin/lib/eval-report.ts`) from the most recently recorded run.
- `<suite>.summary.md` — the same report rendered to markdown
  (`renderSummary`), for a human skim without parsing JSON.

Do not hand-author or fabricate these two files per suite — they are
written verbatim by `bun bin/flow-eval.ts run --all --out .flow-tmp/eval --record-baseline`
(see `docs/eval/README.md`). Recording a baseline is a maintainer gate
step, not something a pipeline or an eval-harness feature PR does on its
own behalf.

## How f2 consumes this

A scaffold-removal candidate PR runs the same suite against its own tree
and calls `bun bin/flow-eval.ts compare --base
docs/eval/baseline/<suite>.report.json --candidate
<candidate-run>/<suite>/report.json --fail-on-regression` — the
before/after delta this directory anchors is the evidence a removal PR's
description points to.

## Recorded-at table

The table below is refreshed automatically by the baseline writer between
the two HTML-comment markers on every `--record-baseline` run — do not
hand-edit inside the markers.

<!-- flow-eval-baseline:start -->

_No baseline has been recorded yet. Run `bun bin/flow-eval.ts run --all
--out .flow-tmp/eval --record-baseline` from a plain shell to populate this table._

<!-- flow-eval-baseline:end -->
