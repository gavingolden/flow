# ui-smoke-isolation — recorded before/after measurement

Measures what moving the UI-smoke browser drive out of the supervisor and
into the pinned `flow-ui-driver` sub-agent actually costs and saves.

## How these two reports were produced

Both arms ran the **same eval harness** — the harness is not the thing
under measurement, the flow content tree is. `materializeFixture` sources
that tree from the checkout that owns `bin/lib/eval-fixture.ts`
(`ownCheckoutRoot()`), so the arms differ only in which tree that is:

- **before** — run from the `main` checkout (no `flow-ui-driver` agent, no
  `flow-ui-driver-instructions` skill), with this branch's eval-harness
  files staged in uncommitted and `--evals-dir` pointed at this branch's
  `evals/`. The branch harness is required in both arms: `main` has
  neither the `transcript.topLevelToolCalls` metric nor the
  `--mcp-config` wiring, without which the suite cannot grade at all.
- **after** — run from this branch's worktree, unmodified.

```sh
# before (from the main checkout, branch eval harness staged in)
bun bin/flow-eval.ts run --suite ui-smoke-isolation --runs 3 --concurrency 1 \
  --evals-dir <branch-worktree>/evals --out /tmp/ui-smoke-before-n3

# after (from this branch's worktree)
bun bin/flow-eval.ts run --suite ui-smoke-isolation --runs 3 --concurrency 1 \
  --out /tmp/ui-smoke-after-n3

bun bin/flow-eval.ts compare \
  --base /tmp/ui-smoke-before-n3/ui-smoke-isolation/report.json \
  --candidate /tmp/ui-smoke-after-n3/ui-smoke-isolation/report.json \
  --tolerance 0.10
```

`--runs 3` is not optional. A first pass at `--runs 1` produced a
`result.total_cost_usd` verdict of `worse` (+73%) that reversed on the
n=3 means — two before-arm runs alone differed by 85% ($0.82 vs $1.52),
a spread wider than the effect being measured. One run of this suite
cannot resolve the difference it exists to measure.

## `compare` output, verbatim

```
# flow-eval compare — ui-smoke-isolation

Base: `b30638ddd19c` (n/a/n/a) vs Candidate: `d7a97cbece12` (n/a/n/a)

## s1-static-header-diff (score 0.778 -> 0.833, delta 0.056)

| Metric | Base | Candidate | Delta | % | Verdict |
| --- | --- | --- | --- | --- | --- |
| transcript.finalContextTokens | 164514 | 149036 | -15478 | -9.4% | same |
| result.total_cost_usd | 1.700 | 1.586 | -0.114 | -6.7% | same |
| result.num_turns | 41 | 20 | -21 | -51.2% | better |
| supervisor-mcp-calls | 8 | 0 | -8 | -100.0% | better |

## Regressions (0)
None.

## Warnings (0)
None.
```

## Per-run detail (n=3 each)

| Arm    | Run | Status   | Cost (USD) | Turns | Final context tokens | Supervisor MCP calls |
| ------ | --- | -------- | ---------- | ----- | -------------------- | -------------------- |
| before | 1   | fail     | 1.700      | 41    | 164514               | 8                    |
| before | 2   | fail     | 1.377      | 34    | 147096               | 5                    |
| before | 3   | fail     | 2.223      | 55    | 178977               | 9                    |
| after  | 1   | fail     | 1.890      | 26    | 157643               | 0                    |
| after  | 2   | **pass** | 1.586      | 20    | 149036               | 0                    |
| after  | 3   | fail     | 0.766      | 18    | 130269               | 4                    |

Means — before: $1.767 / 43.3 turns / 163,529 tokens.
After: $1.414 / 21.3 turns / 145,649 tokens.

Every before-arm run is _expected_ to fail: `drive-not-inline` and
`captures-written` are precisely the two gates the driver exists to flip,
so the before arm failing them is the ablation working, not a broken run.

## What the measurement does and does not establish

**Established — the isolation itself.** Supervisor-visible chrome-devtools
calls go 5–9 → 0 on every after-arm run that spawned the driver. That is
the mechanism working exactly as designed, and it is the one claim this
suite proves outright.

**Established — turn count.** 43.3 → 21.3 turns, a −51% shift far outside
the run-to-run spread.

**Directional only — cost and context.** Context −10.9% and cost −20% on
the means, but `compare` scores both `same` at a 0.10 tolerance and the
per-run spread overlaps between arms. Treat these as encouraging, not
proven. `result.total_cost_usd` counts the driver sub-agent's own tokens,
so it was never expected to fall much; `finalContextTokens` is the metric
the design actually targets.

**Not established — spawn reliability. This is the open defect.** After-arm
run 3 never spawned the driver at all: it loaded the chrome-devtools tools
directly via `ToolSearch` and drove the browser inline from the supervisor,
failing `drive-not-inline` and `captures-written`. Runs 1 and 2 spawned
`flow-module-core:flow-ui-driver` correctly. Two of three is not a
contract. After-arm run 1 separately failed `verify-status-pass` while
spawning the driver correctly, so exactly **one of three** after-arm runs
passed every gate.

The isolation is real when it fires. How often it fires is the thing this
measurement leaves open.
