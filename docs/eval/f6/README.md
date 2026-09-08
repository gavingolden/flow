# f6-workflow-port — eval gate record

This directory is the no-regression record for `f6-workflow-port` (the
steps-5–10 port to the `flow-stage-a` / `flow-stage-b` Workflow scripts),
mirroring `docs/eval/scaffold-verdicts.md`'s protocol. Arms are
maintainer-run with real spend; nothing here is recorded from inside the
pipeline that shipped the port.

## Probes

See [probes.md](probes.md) for the two live probes
(`workflow-headless-await`, `workflow-plugin-command`) and their recorded
verdicts. Run from a plain shell:

```sh
bun bin/flow-plugin-probe.ts --live --json --probe workflow-headless-await --probe workflow-plugin-command
```

## Gate applied

**Path (i) was attempted on 2026-09-06 and did NOT pass.** Both probes
recorded `confirmed` (probes.md), so every suite was recorded before/after
(`--runs 2`, claude 2.1.263, `claude-version.txt`), and
`compare --tolerance 0.10 --fail-on-regression` exits **1 for all four
suites** (table below). The stage-A scenarios are not a port regression the
compare can see — they are unmeasurable under `claude -p` as the harness
runs it: the supervisor launches `flow-module-core:flow-stage-a` in the
background, then ends its turn with the eval's structured verdict "pending
the completion notification", and the print-mode session's turn-end stops
the background workflow (`task_notification status: stopped` ~90s in), so
`stage-a-result.json` never lands (`stage-result-written` null in every
stage-A run; the stage-B scenario `s4-step10-merging`, whose workflow is
short enough to finish inside the turn, passed 2/2). `haiku-gatekeeper` and
`checkpoint-pending-clear` do not touch the port; their compare failures
are per-run `total_cost_usd`/`duration_ms` beyond the 10% tolerance at
n=2 plus one flaky `s2-resume-gated-feedback` run. So **the workflow path
was not measured by `flow-eval`**; the stage-A evidence is the live fixture
run in [live-run.md](live-run.md) (path (ii)'s artifact), which also
surfaced and fixed a null-deref crash in the stage-A script. Whether that
substitutes for the (i) gate, or the harness should learn to hold the turn
open until the stage result lands (a Monitor `until [ -s stage-a-result.json ]`
in the scenario prompt, plus a longer `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`),
is a maintainer decision recorded on PR #789.

**Path (ii)'s artifact is complete.** The live fixture run in
[live-run.md](live-run.md) now also covers the gate-override merge path
(Test Steps item 4: one `AskUserQuestion` form, override token, stage B
squash merge, `phase: merged`), and surfaced two further defects fixed on
this branch (string `pr` in the stage-B args; `merging` refused out of
`gated`). Path (i) stays unmet: making the stage-A scenarios measurable
needs the harness to hold the print-mode turn open until
`stage-a-result.json` lands AND the `state-phase-*` graders re-authored
against `phaseLog[]` (a whole-stage run advances `phase` past the step
under test), which is scoped as a follow-up rather than this port.

Decision E in the plan, as written before the arms ran:

- (i) when `workflow-headless-await` is `confirmed`: record every suite
  before/after (`phase-write-fidelity`, `verify-loop-isolation`,
  `checkpoint-pending-clear`, `haiku-gatekeeper`) and require
  `compare --tolerance 0.10 --fail-on-regression` to exit 0 per suite.
- (ii) when it is `refuted`: record `checkpoint-pending-clear` (the
  retained-phase control) before/after, run one live fixture pipeline on
  a docs-only change, and write `live-run.md` with the `phaseLog`
  sequence, per-agent `.meta.json` `agentType` lines, and the gate
  byte-identity check. The README must then say plainly that the
  workflow path was not measured by `flow-eval`.

## Verdicts

| Suite                    | Score before | Score after | finalContextTokens | total_cost_usd | Verdict                                             |
| ------------------------ | ------------ | ----------- | ------------------ | -------------- | --------------------------------------------------- |
| phase-write-fidelity     | 0.980 (4/5)  | 0.633 (1/5) | 128k → 127k        | $5.61 → $20.86 | fail (unmeasured: stage A stopped at turn-end)      |
| verify-loop-isolation    | 0.964 (1/2)  | 0.700 (0/2) | 145k → 148k        | $3.44 → $6.62  | fail (unmeasured: stage A stopped at turn-end)      |
| checkpoint-pending-clear | 1.000 (4/4)  | 0.950 (3/4) | 87k → 75k          | $7.65 → $6.36  | fail (cost/duration noise at n=2; not port-related) |
| haiku-gatekeeper         | 0.875 (3/6)  | 0.917 (5/6) | 62k → 62k          | $1.80 → $1.75  | fail (cost/duration noise at n=2; not port-related) |

## Measurement protocol

- Before arm: from the canonical `main` checkout at the branch's merge-base
  tree, `bun bin/flow-eval.ts run --all --out .flow-tmp/eval/f6-before --runs 2`.
- After arm: from the `f6-workflow-port` worktree,
  `bun bin/flow-eval.ts run --all --out .flow-tmp/eval/f6-after --runs 2`.
- Copy only `report.json` + `summary.md` per suite into
  `before/<suite>/` and `after/<suite>/`; never commit `run-*/` stream logs.
- Compare per suite: `bun bin/flow-eval.ts compare --base before/<suite>/report.json --candidate after/<suite>/report.json --tolerance 0.10 --fail-on-regression --json`.
- Decision metrics: `transcript.finalContextTokens`, `result.total_cost_usd`,
  and the suite gate score; `num_turns`/`duration_ms` are recorded but
  non-decisional.
- Pin `claude --version` to `claude-version.txt`; every arm must match it.
- Expect `environmentMismatch` between arms: the after arm's harness allows
  the `Workflow` tool, which changes every scenario's argv digest.
