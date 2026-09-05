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

pending — maintainer-run. Decision E in the plan:

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

| Suite | Score before | Score after | finalContextTokens | total_cost_usd | Verdict |
| ----- | ------------ | ----------- | ------------------ | -------------- | ------- |

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
