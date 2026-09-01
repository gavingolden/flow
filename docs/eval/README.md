# flow-eval — maintainer guide

`flow-eval` is a maintainer-only, locally-runnable headless eval harness
running four committed suites, split by what each measures:

- Three **supervisor context-isolation scaffolds** (`verify-loop`,
  `haiku-gatekeeper`, `checkpoint-pending-clear`) — cost/context/turn
  footprint, so a future scaffold-removal PR (epic
  `modernize-flow-s-supervisor-architecture`, feature
  `f2-scaffold-stress-test`) carries a recorded before/after delta
  instead of a prose argument.
- One **correctness suite** (`phase-write-fidelity`, issue #679) —
  whether the supervisor's end-state `state.phase` lands where the step
  it ran says it should, at Steps 7-10. It measures whether the
  supervisor _calls_ the value-returning helper that writes the phase;
  the helper _writing_ correctly is proved separately, by
  `bin/lib/phase-advance.test.ts` and each helper's own unit spec.

`bin/flow-eval.ts` is never installed onto a user's PATH (see
`bin/lib/sources.ts`'s `MAINTAINER_ONLY` set) — run it from a flow
checkout.

## Security note: the child runs with your real account

Every scenario's `claude -p` child is intentionally NOT sandboxed by a
fake `HOME` or a throwaway account: the child runs with your real
account, your real home directory, and (under `--permission-mode
dontAsk`) auto-approved shell access, so it can exercise a session the
way a real launched pipeline would. `buildChildArgv` bounds the highest-
harm actions with a fixed `--disallowedTools` deny-list (no `git push`,
no `gh pr merge/create/close`, no `gh release`, no `rm -rf
node_modules*`), but that is a floor, not a sandbox — only run scenarios
you trust, the same as you would `claude -p` directly.

## Precondition: `flow install`

`flow-eval` spawns a real `claude -p` child that loads the same
`flow-module-core` plugin root a real pipeline session loads, from the
global `~/.flow/claude-home/.claude/skills/flow-module-core/agents/`
location. Run `flow install` once before the first `flow-eval run` — a
missing install surfaces as the named `flow-not-installed` skip, not a
crash.

## Running a suite

```sh
bun bin/flow-eval.ts run --suite verify-loop-isolation --out .flow-tmp/eval
bun bin/flow-eval.ts run --all --out .flow-tmp/eval
```

Useful flags: `--dry-run` (materializes fixtures and renders prompts
without spawning `claude`), `--runs <n>` (override every scenario's
per-run count), `--concurrency <n>` (bounded worker pool across every
`(scenario, run)` pair in the suite; default 1), `--threshold <0..1>`
(exit 1 when a suite's score misses it), `--claude-bin <path>`.

Named skip reasons (exit 0, one-line stderr notice, a `skipped` report
still written): `claude-not-on-path`, `claude-not-authenticated`,
`flow-not-installed`. `--dry-run` writes a `skipped: {reason: "dry-run"}`
report for the same reason — vitest (`bin/evals-suites.test.ts`,
`bin/flow-eval.test.ts`) stays the CI gate; no vitest spec ever spawns
`claude`.

## Report schema (v1) and `compare`

`bin/lib/eval-report.ts`'s `EvalReport` (`schemaVersion: 1`) is the
deliberate stable seam — additive fields only once a baseline is
committed; bump `schemaVersion` for anything else. `bun bin/flow-eval.ts
report --in <report.json>` renders the markdown summary;

```sh
bun bin/flow-eval.ts compare --base docs/eval/baseline/verify-loop-isolation.report.json \
  --candidate .flow-tmp/eval/verify-loop-isolation/report.json \
  --tolerance 0.10 --fail-on-regression
```

diffs two reports scenario-by-scenario and metric-by-metric: `worse` /
`better` / `same` / `noisy` (base-spread-exceeds-tolerance) verdicts,
direction-aware (`lower`/`higher`-is-better), plus an
`environmentMismatch` warning when `runner.model`/`runner.effort`/
`runner.claudeVersion` differ between the two reports. `--fail-on-regression`
exits 1 on any regression; `--json` prints the raw `Comparison` object
instead of the markdown table.

## Recording a baseline

One command, from a **plain shell** — never inside a flow session window
(AGENTS.md forbids a nested `claude -p` from a supervisor; baseline
recording is a maintainer-initiated action, not a pipeline step):

Before recording, confirm
`~/.flow/claude-home/.claude/skills/flow-module-core/agents/` carries
every agent definition the suites you're about to run spawn (notably
`flow-verify.md`) — `probeFlowInstall` only stats the agents
**directory**, never individual definitions, so a partial install still
passes the precondition check and silently degrades to `general-purpose`
at run time (losing the agent's tool allowlist). This is worse than a
red, not better: the `no-agent-fallback` grader reads `notMatches` over
`$ASSISTANT_TEXT`, which excludes tool-result output, so the `echo`'d
`NOTICE — agent-fallback:` line only turns it red if the supervisor
happens to restate it in assistant-role prose — not guaranteed. Treat
this as a manual pre-flight check, not a grader-enforced one.

```sh
bun bin/flow-eval.ts run --all --out .flow-tmp/eval --record-baseline
git add docs/eval/baseline
git commit -m "chore: record flow-eval baseline"
git push
```

To re-record only a subset, repeat `--suite` (accepts multiple) instead
of `--all`:

```sh
bun bin/flow-eval.ts run --suite checkpoint-pending-clear \
  --suite verify-loop-isolation --runs 5 \
  --out .flow-tmp/eval --record-baseline
```

`bin/lib/eval-baseline.ts`'s README-table writer merges each unlisted
suite's existing row from `docs/eval/baseline/` alongside the freshly
recorded ones, so a subset run never drops another suite's baseline
from the table.

`--record-baseline` refuses (exit 2) on a dirty tree unless
`--allow-dirty` is also passed — a baseline is a measurement of a
specific committed tree, and an uncommitted diff makes that
correspondence a lie. It writes `<suite>.report.json` +
`<suite>.summary.md` per suite into `docs/eval/baseline/` and refreshes
the recorded-at table in `docs/eval/baseline/README.md` between the
`<!-- flow-eval-baseline:start -->` / `<!-- flow-eval-baseline:end -->`
markers.

**Measuring an unmerged branch.** The eval child loads the plugin root
from the GLOBAL install (`~/.flow/claude-home/.claude/skills/flow-module-core/`),
not the worktree you're standing in — a recording taken without first
pointing the global install at the branch under test measures the _old_
skills/helpers and is worthless. Before recording:

```sh
flow install --upgrade --source "$PWD"
flow install --upgrade --source "$PWD"   # twice — see below
command -v flow-gate-decide flow-merge-guard   # confirm the symlinks moved
```

Run the `--source` install **twice**: the first invocation's registry
fast-forward lands one invocation late, so a single run can leave a
helper still symlinked to the canonical checkout
(`project_flow_install_source_stale_registry`). After recording, restore
the global install from the canonical `main` checkout — never leave it
pointed at a worktree a merge is about to delete
(`project_flow_setup_source_dangling_symlinks`):

```sh
cd <canonical-main-checkout>
bun bin/flow.ts install --upgrade
```

## The `claude plugin eval` forward check

The installed CLI (2.1.239 at this writing) lists `claude plugin eval`
with `--json`/`--runs`/`--threshold`, but it is org-gated early access
(design.md verdict 4), and `.github/workflows/ci.yml` installs Node and
Bun only — no `claude` binary — so it can never be flow's CI gate
regardless of enablement. `EvalReport.runner.name` is the seam that
would let a future `claude-plugin-eval` runner backend emit the same
report shape (an adapter, not a rewrite) — revisit when the command is
GA for flow's org **and** CI installs `claude`. Not built now; tracked
as a candidate follow-up, not a task in this feature.

## Concurrency

`--concurrency <n>` bounds how many `(scenario, run)` pairs execute in
parallel across the WHOLE suite (not per-scenario) — each in-flight run
materializes its own hermetic fixture and spawns its own `claude`
child, so cost and local-machine load scale roughly linearly with `n`.
Default 1 (serial) is the safe default for a maintainer's laptop; raise
it deliberately when running the full `--all` suite set.

## `flow ls` during a run

`flow-eval` seeds real pipeline state under an `eval-<suite>-<scenario>-r<n>`
slug in the real `~/.flow/state/` — not an isolated test directory,
because the child session's own helpers (`flow-state-update`,
`flow-checkpoint`, `flow-resume-decide`) only ever read the real state
dir. `flow ls` therefore shows `eval-*` rows while a suite is running;
teardown removes them (state, checkpoints, turn tracking, proc registry)
whether the run passed, failed, or was interrupted (a `SIGINT` handler
in `bin/flow-eval.ts` sweeps every in-flight fixture before exiting).
See `evals/README.md` for the suite/scenario file format.
