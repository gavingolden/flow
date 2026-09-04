# Test-quality methodology

flow's own suite is large enough (223 test files, 8,315 tests) that "run
everything, every time, locally" has a real dollar cost in wall-clock and
CPU-seconds. This document is the durable rubric behind `flow-test-audit`
and the `.flow/test-tiers.json` manifest `flow-pre-commit` reads: what each
axis measures, which axes actually drive the v1 tier decision, and what the
measured baseline looked like the day this was written.

## Why cost, not count

Test _count_ is a vanity metric — a file with 40 trivial assertions and a
file with 4 expensive ones both count as "one file" in a naive audit, but
they cost wildly different amounts of wall-clock and CPU time and carry
wildly different amounts of regression-catching value per millisecond. The
rubric below scores **cost per assertion** (how expensive is each unit of
verification this file buys) crossed with **necessity** (is that cost
intrinsic to what's under test, or infrastructure overhead this test
happens to pay). A file only becomes a rewrite candidate when it is both
expensive AND avoidable — cheap files and expensive-but-irreplaceable files
are left alone regardless of raw count.

## Axes

The full rubric ships here even though v1's scorer (`flow-test-audit.ts`)
computes only a subset of it — this document IS the deliverable, not a
changelog of what got automated first.

- **A1 — cost per assertion (ms/assert).** Wall-time for the file (from
  `vitest run --reporter=json`) divided by its assertion count. Repo median:
  1.1 ms/assert. Drives the v1 tier decision.
- **A2 — subprocess spawning.** A static scan of the file's source for
  `execFileSync`, `spawnSync`, `execSync`, `Bun.spawn`, `execa`, or
  `child_process`. A spawning file pays real process-start and I/O latency
  that no amount of code cleanliness removes. Drives the v1 tier decision.
- **A3 — repo-tree scanning.** Whether the file reads other repo files
  (markdown docs, skill frontmatter, other source files) at module scope —
  i.e. the check IS "does the committed tree look right," not "does this
  function behave right." This axis seeds the `alwaysRun` tier: a file that
  scans the repo tree is validating structural/documentation invariants that
  a `.md`-only or config-only diff can silently violate, so it must run
  regardless of which source files changed.
- **A4 — necessity / irreplaceability.** The one genuinely judged axis, not
  mechanically derived: is the slowness intrinsic to the subject under test
  (a git worktree helper that must actually shell out to `git`), or is it
  infrastructure built around logic that is pure given its inputs (a scoring
  function that could run against an in-memory fixture instead of a live
  subprocess)? This axis is what separates "expensive but keep it" from
  "expensive, and it shouldn't be."
- **A5 — churn (diagnostic only, NOT computed in v1).** How often the file
  has changed recently. A high-churn expensive file is a better rewrite
  candidate than a stable one — the cost gets paid repeatedly as the file
  keeps changing.
- **A6 — fan-in (diagnostic only, NOT computed in v1).** How many other test
  files exercise overlapping code paths. High fan-in with high per-file cost
  suggests redundant coverage that a shared, cheaper fixture could replace.
- **A7 — assertion density.** Assertions per test / per file. A file with
  many assertions per test is extracting more verification value from each
  setup/teardown cycle it pays for.
- **A8 — colocation with its subject.** Whether the test file sits next to
  the module it exercises (`bin/lib/foo.ts` / `bin/lib/foo.test.ts`) versus
  living apart from it. Colocated tests are easier to keep honest as the
  subject changes; this is contextual signal for a human reviewing a
  rewrite candidate, not a scored input.

Only **A1** and **A2** drive the v1 tier decision (`alwaysRun` /
`deferToCi` / default). **A3** seeds `alwaysRun` independently of cost. The
rest — A4 through A8 — are diagnostic metadata surfaced for a human
triaging rewrite candidates; they are not (yet) computed by
`flow-test-audit.ts`.

## Verdict quadrants

Every scored file lands in exactly one quadrant, crossing cost (A1) against
necessity (A4):

- **cheap-valuable** — low ms/assert, high assertion density. Leave alone;
  this is the suite doing its job efficiently.
- **expensive-irreplaceable** — high ms/assert, but the cost is intrinsic to
  what's under test (e.g. a git worktree helper's `spawnSync git`). Leave
  alone; a rewrite would either lose coverage or just move the cost
  elsewhere.
- **expensive-avoidable** — high ms/assert, and the cost is infrastructure
  overhead a pure-function rewrite could shed. **Only this quadrant becomes
  a rewrite candidate.**
- **cheap-low-value** — low ms/assert, but very few assertions for the setup
  paid. Not urgent, but a candidate for consolidation into a neighboring
  file rather than a standalone rewrite.

## Measured baseline (HEAD 1a910a0)

Measured against `1a910a0` (`feat: subagent memory, preload, maxTurns, 1h
TTL (#756)`):

- **223 test files / 8,315 tests / 27.4s wall / 190.2s CPU** (95.4s user +
  94.8s sys).
- Cost concentration: the top 5 files account for **47.1%** of total
  file-wall-time, the top 10 for **67.4%**, the top 20 for **83.6%** of
  281,430 ms aggregate file-wall-time.
- Median cost: **1.1 ms/assertion** across the suite.
- Worst single file: `bin/evals-suites.test.ts` at **1,012 ms/assertion**
  (~920x the median) for 22 structural smoke assertions.
- Subprocess spawning: **69 of 223 files (31%)** spawn subprocesses,
  accounting for **35% of tests** but **77% of CPU** and **91% of sys
  time**. The remaining 154 files run 5,416 tests in 47.8s CPU when
  isolated, and 15.7s with `--no-isolate`.

Irreplaceable-vs-avoidable worked table:

| File                                | ms/assert | Verdict                                             |
| ----------------------------------- | --------- | --------------------------------------------------- |
| `bin/evals-suites.test.ts`          | 1,012     | expensive-avoidable                                 |
| `bin/lib/setup.test.ts`             | 299       | mixed                                               |
| `bin/lib/feature.test.ts`           | 127       | expensive-irreplaceable (101 `spawnSync git` sites) |
| `bin/flow-new-worktree.test.ts`     | 566       | expensive-irreplaceable                             |
| `bin/flow-remove-worktree.test.ts`  | 293       | expensive-irreplaceable                             |
| `bin/lib/base-branch-guard.test.ts` | 165       | expensive-irreplaceable                             |
| `bin/lib/epic-guard-parity.test.ts` | 907       | expensive-avoidable                                 |
| `bin/flow-pre-commit.test.ts`       | 20        | cheap-and-high-value, keep local                    |

## Reproducing the numbers

```sh
env -u FLOW_SLUG -u TMUX_PANE npx vitest run --reporter=json --outputFile .flow-tmp/vitest-report.json
bun bin/flow-test-audit.ts --from-json .flow-tmp/vitest-report.json --markdown
```

The `-u FLOW_SLUG -u TMUX_PANE` unset avoids tripping the pipeline
stop-guard when this is run from inside a flow window (see
`project_flow_slug_leak_nested_claude_session` in local agent memory).

## Scaling

- **Raise the host-wide concurrency cap once per-run CPU falls.** Tiering
  cuts local per-invocation CPU; `resolveTestConcurrency`'s
  `max(1, ceil(cores / 9))` divisor was tuned against the old always-full-suite
  load. Once tiered runs are the common case, the divisor can likely shrink
  — but only after measuring actual host contention under the new profile,
  not by guessing a new constant.
- **A tree-hash-keyed verify-result cache.** A `flow-pre-commit` run against
  a tree hash it has already verified clean could skip re-running unchanged
  scopes entirely, complementing tiering (which narrows _which_ tests run)
  with a cache (which skips runs whose inputs haven't moved at all).
- **Per-invocation overhead is a real chunk of the aggregate.** Of the 227s
  aggregate vitest spends outside actual test execution: transform 10.1s,
  collect 22.5s, setup 3.7s, prepare 13.3s. Tiering shrinks the _test_
  portion; this fixed overhead doesn't shrink with it, so it becomes a
  larger share of total time as tiering succeeds — a future target once test
  execution itself stops dominating.
- **A cost ratchet via a future `--check` mode.** `flow-test-audit` could
  gain a `--check` mode that fails CI when a file's measured `ms/assert`
  regresses past a committed threshold, catching newly-added expensive
  tests before they get baked into `alwaysRun` by inertia. Deliberately cut
  from v1 (see `bin/flow-test-audit.ts`'s cut-list) pending real usage data
  on the manifest itself.
- **Push subprocess tests toward in-process invocation.** The single
  biggest lever left on the table: 69 files spawning real subprocesses for
  91% of sys time. Where the subject under test is flow's own helper
  scripts, invoking their exported functions in-process (bypassing the
  `spawnSync` layer for the parts that don't need a real subprocess
  boundary) would move files from expensive-irreplaceable toward
  cheap-valuable without losing coverage — but each one needs the A4
  necessity judgment call made explicitly, file by file, not batch-applied.
