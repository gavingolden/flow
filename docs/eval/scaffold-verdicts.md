# Scaffold keep/remove verdicts

This file is the committed keep/remove verdict record for the three
scaffold-removal candidates under evaluation in this feature. It is
consumed by `bin/lib/scaffold-verdicts.ts` (`parseVerdictTable` /
`lintVerdicts`), by `bin/scaffold-verdicts.test.ts` (a hard CI gate once
every row is filled), and by the epic
`modernize-flow-s-supervisor-architecture`'s feature `f2` as the
authoritative record of which scaffolds were removed, kept, or reverted.

## Verdicts

| Candidate                        | Outcome | Scope | Decision metric                                                          | Before report                                            | After report                                            | Note                                                                     |
| -------------------------------- | ------- | ----- | ------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `verify-loop-subagent-isolation` | TBD     | TBD   | transcript.finalContextTokens + result.total_cost_usd + suite gate score | docs/eval/f2/before/verify-loop-isolation/report.json    | docs/eval/f2/after/verify-loop-isolation/report.json    |                                                                          |
| `haiku-gatekeeper`               | TBD     | TBD   | transcript.finalContextTokens + result.total_cost_usd + suite gate score | docs/eval/f2/before/haiku-gatekeeper/report.json         | docs/eval/f2/after/haiku-gatekeeper/report.json         | Sonnet-parent sibling arm recorded alongside at haiku-gatekeeper-sonnet/ |
| `checkpoint-pending-clear`       | TBD     | TBD   | transcript.finalContextTokens + result.total_cost_usd + suite gate score | docs/eval/f2/before/checkpoint-pending-clear/report.json | docs/eval/f2/after/checkpoint-pending-clear/report.json |                                                                          |

## Scope of each removal

- **`verify-loop-subagent-isolation`**: removing this candidate means
  deleting the step-6 spawn site and its exemption row,
  `agents/core/flow-verify.md`,
  `skills/pipeline/flow-verify-loop-instructions/`,
  `bin/flow-verify-prep.ts`, its module registrations, and the lint
  assertions that reference it. Step 6 instead runs the
  `flow-pre-commit` retry loop inline in the supervisor session.
- **`haiku-gatekeeper`**: removing this candidate means deleting the
  `/flow-pr-review` Step 1.5 spawn site and its exemption row,
  `agents/core/flow-gatekeeper.md`, `gatekeeper-spawn-prompt.md`, and
  the model-routing-table row for it. Triage is instead done inline by
  the reviewing session.
- **`checkpoint-pending-clear`**: removing this candidate means
  removing ONLY the step-4 approval→implement auto-checkpoint — the
  `flow-checkpoint --site plan-approval` arm, the
  `checkpoint-pending-clear` phase write, its `PENDING_PHASES` entry,
  and its `POST_APPROVAL_PHASES` resume row. The `/flow-checkpoint`
  skill itself and its gate/terminal checkpoint sites are untouched.

## Measurement protocol

Arms are recorded by running `bun bin/flow-eval.ts run` FROM THIS
WORKTREE — the harness materializes the plugin root from the invoking
checkout (`bin/lib/eval-fixture.ts`'s `ownCheckoutRoot()`), so no
global-install repointing is needed or performed.

Preconditions: `[ -d ~/.flow/claude-home/.claude/skills/flow-module-core/agents ]`
resolves; the tree is clean (`git status --porcelain` is empty); `claude`
is authenticated. The before arm is recorded at the HEAD carrying Tasks
1–3 (not the merge-base with `main`), and its `tree.gitHead` is cited
here: `<sha>` (placeholder — filled when the arm is recorded).
`claude --version` is pinned to `docs/eval/f2/claude-version.txt` and
every arm must match it.

Runs use `--runs 3` and `--out .flow-tmp/eval/<arm>`; only `report.json`
and `summary.md` are then copied into `docs/eval/f2/<arm>/<suite>/` —
the `run-*/` stream logs are never committed. The `haiku-gatekeeper`
suite is run twice per arm: once as pinned, and once with
`--model sonnet` (copied to `docs/eval/f2/<arm>/haiku-gatekeeper-sonnet/`)
so the cost-routing saving is visible.

Decision metrics are `transcript.finalContextTokens` and
`result.total_cost_usd`, plus the suite gate score.
`result.num_turns` and `result.duration_ms` are recorded but
non-decisional (baseline 2-run spread up to ~69% exceeds `compare`'s
0.10 tolerance).

Compare via `bun bin/flow-eval.ts compare --base <before> --candidate
<after> --tolerance 0.10 --json`. A candidate is removed only when every
decision metric reads same/better and the gate score is not lower;
otherwise the removal commit is reverted and the row records `keep`.

Chained arms: one shared before arm, then one after arm per candidate on
its own commit.

REVERT RULE: if a candidate is reverted after a later candidate's after
arm was recorded on top of its removal, every such later after arm is
re-recorded before its row is final.

Candidate C (`checkpoint-pending-clear`) is keep-biased: removal only on
a clean delta across BOTH candidate-covering scenarios (s1, s4), with
controls (s2, s3) unmoved.

## Evidence

### verify-loop-subagent-isolation

TBD — filled when the arm is recorded.

### haiku-gatekeeper

TBD — filled when the arm is recorded.

### checkpoint-pending-clear

TBD — filled when the arm is recorded.
