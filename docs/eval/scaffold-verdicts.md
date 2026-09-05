# Scaffold keep/remove verdicts

This file is the committed keep/remove verdict record for the three
scaffold-removal candidates under evaluation in this feature. It is
consumed by `bin/lib/scaffold-verdicts.ts` (`parseVerdictTable` /
`lintVerdicts`), by `bin/scaffold-verdicts.test.ts` (a hard CI gate once
every row is filled), and by the epic
`modernize-flow-s-supervisor-architecture`'s feature `f2` as the
authoritative record of which scaffolds were removed, kept, or reverted.

## Verdicts

| Candidate                        | Outcome | Scope | Decision metric                                                          | Before report                                            | After report                                            | Note                                                                                                                         |
| -------------------------------- | ------- | ----- | ------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `verify-loop-subagent-isolation` | remove  | full  | transcript.finalContextTokens + result.total_cost_usd + suite gate score | docs/eval/f2/before/verify-loop-isolation/report.json    | docs/eval/f2/after/verify-loop-isolation/report.json    | Removed on 8c6b8c4; delta clean (see Evidence)                                                                               |
| `haiku-gatekeeper`               | remove  | full  | transcript.finalContextTokens + result.total_cost_usd + suite gate score | docs/eval/f2/before/haiku-gatekeeper/report.json         | docs/eval/f2/after/haiku-gatekeeper/report.json         | Removed on 2b7fb49; delta better at both parent models (see Evidence); sonnet-parent sibling arm at haiku-gatekeeper-sonnet/ |
| `checkpoint-pending-clear`       | TBD     | TBD   | transcript.finalContextTokens + result.total_cost_usd + suite gate score | docs/eval/f2/before/checkpoint-pending-clear/report.json | docs/eval/f2/after/checkpoint-pending-clear/report.json |                                                                                                                              |

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
here: `9a1a8e21deb27fc5e7744854414cc878ee144f45` (claude 2.1.261, `--runs 3`). After arms are recorded at `--runs 2` — the before arm's measured spend (~$29.5 across the four passes) exceeded the plan's whole-feature estimate, so the plan's Q7 fallback (drop candidate arms to two runs before dropping any candidate) was applied; `compare` reads medians, so the run-count difference does not change the verdict rule.
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

- **Outcome:** remove. Removal commit `8c6b8c4` (+ `bec403e`, which drops the two non-gating graders that asserted the subagent's artifact). After arm recorded at tree `bec403e3aaa9a16487e322cbc84fa50c34c2b4f5`, `--runs 2`.
- **Gate score:** 1.000 → 1.000 (2/2 scenarios pass on both arms).
- **Decision metrics** (`flow-eval compare --tolerance 0.10`, medians): `transcript.finalContextTokens` s1 142,096 → 148,353 (+4.4%, `same`), s2 143,030 → 147,763 (+3.3%, `same`); `result.total_cost_usd` s1 $0.942 → $0.945 (+0.3%, `same`), s2 $0.891 → $0.897 (+0.6%, `same`).
- **Scaffold-absent check:** `transcript.subagentsSpawned` 1 → 0 on both scenarios (the inverted `scaffold-absent` grader was red on the before arm and green on the after arm, so the delta measures an actual removal, not a failed spawn).
- **Non-decisional:** `result.num_turns` 10 → 16.5 / 12 → 19 (`noisy` — the inline loop's Bash calls now count as supervisor turns); `result.duration_ms` 63.2s → 55.3s / 87.6s → 53.1s (`better`).
- **Reading:** the isolation bought no measurable context or cost headroom at this fixture scale; the +3–4% context is the verify transcript that used to live in the subagent, well inside tolerance.

### haiku-gatekeeper

- **Outcome:** remove. Removal commits `2b7fb49` + `befd0d5`. After arms recorded at tree `befd0d54a63d1b03edfc52bc6e2316e05a57606f`, `--runs 2`, at BOTH parent models (Fork A option (c)): as pinned (haiku child) and `--model sonnet`.
- **Gate score:** as pinned 0.917 → 0.917 (5/6 both arms); sonnet-parent 0.898 → 0.917.
- **Decision metrics** (medians, `compare --tolerance 0.10`): as pinned — `result.total_cost_usd` summed over the six scenarios $1.202 → $0.858 (−29%, every scenario `better`), `transcript.finalContextTokens` mean 67,717 → 61,221 (−10%; four scenarios `better`, two `same`). Sonnet-parent — cost $2.899 → $2.124 (−27%, every scenario `better`), context 93,209 → 82,499 (−11%; five `better`, one `same`).
- **Scaffold-absent check:** `transcript.subagentsSpawned` 1 → 0 on every scenario at both models.
- **The routing-saving question, measured:** with a supervisor-class (sonnet) parent, spawning a haiku gatekeeper cost MORE than doing the triage inline — the subagent's own bootstrap and result round-trip outweighed the cheaper model's per-token price at this triage size. The scaffold's stated purpose (routing triage off an expensive parent) does not hold at this fixture scale.
- **`compare` flagged one regression, not attributable to the removal:** `s6-no-new-commits-skip` scored 0.667 → 0.5 as pinned (0.5 → 0.5 sonnet-parent). Its failing graders (`decision-matches-truth`, `skip-kind-matches-truth`, `gatekeeper-result-decision`) fail on 2/3 before-arm runs and 3/3 sonnet before-arm runs too — the no-new-commits skip rule is mis-applied with or without the subagent (the f1 baseline at tree `98bba534` had it passing, so this is drift since then, worth its own look). The inline triage inherits the rule text verbatim.
- **Non-decisional:** `result.num_turns` n/a for this suite; `result.duration_ms` `noisy`.

### checkpoint-pending-clear

TBD — filled when the arm is recorded.
