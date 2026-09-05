# flow-eval — recorded baselines

This directory holds the committed, before/after comparison surface for
flow's `flow-eval` suites — three supervisor context-isolation scaffolds
plus `phase-write-fidelity` (a correctness suite; see `docs/eval/README.md`
for the split). Each suite under `evals/` gets two committed files here
once a maintainer records it:

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

f2 does NOT diff against the reports in this directory — they were
recorded 15 commits behind f2's HEAD on an older `claude` minor, so a
`compare` against them would additionally raise `environmentMismatch`.
Instead f2 re-records its own before arm under `docs/eval/f2/before/`
(at the HEAD carrying its scaffold-inventory tasks) and compares each
candidate's after arm against that same-tree, same-`claude`-version
before arm. The committed baselines in this directory stay the
historical record, not f2's comparison surface. See
`docs/eval/scaffold-verdicts.md` for f2's keep/remove verdicts and full
measurement protocol.

## Recorded-at table

The table below is refreshed automatically by the baseline writer between
the two HTML-comment markers on every `--record-baseline` run — do not
hand-edit inside the markers.

<!-- flow-eval-baseline:start -->
| Suite | Candidate | Score | Git Head | Recorded At |
| --- | --- | --- | --- | --- |
| checkpoint-pending-clear | checkpoint-pending-clear | 0.967 | 98bba534b2a0 | 2026-09-01T04:11:01.424Z |
| haiku-gatekeeper | haiku-gatekeeper | 0.972 | 98bba534b2a0 | 2026-09-01T04:03:42.838Z |
| phase-write-fidelity | phase-write-side-effect | 1.000 | 98bba534b2a0 | 2026-09-01T04:19:50.146Z |
| verify-loop-isolation | verify-loop-subagent-isolation | 1.000 | 98bba534b2a0 | 2026-09-01T04:09:14.219Z |
<!-- flow-eval-baseline:end -->
