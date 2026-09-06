# f6 live fixture run — `docs-touch-the-getting-started-note`

Recorded 2026-09-06 from a plain shell on the flow repo with this branch
installed (canonical checkout detached at the branch tip, then
`bun bin/flow install --upgrade`, because `flow install` always links global
content against the canonical checkout — see `bin/lib/setup.ts`'s
install-root guard). Launched with:

```sh
flow feature create --tmux --no-auto-merge --slug docs-touch-the-getting-started-note "docs: touch the getting-started note"
```

`--no-auto-merge` is deliberate: a docs-only PR ticks every Test Step, so
without it the gate would auto-merge and the override-form check (Test Steps
item 4) would have nothing to exercise.

## Result

| Check                         | Observed                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workflow dispatch             | one `Workflow` call, `name: "flow-module-core:flow-stage-a"` (plugin-qualified name resolved; no `scriptPath` fallback needed)                                                                   |
| Supervisor-side `Agent` calls | exactly one: `flow-module-core:flow-discovery` (the retained planning exemption)                                                                                                                 |
| `phaseLog`                    | `triaging, worktree-create, planning, implementing, verifying, ci-wait, reviewing, gating, gated`                                                                                                |
| PR                            | [#793](https://github.com/gavingolden/flow/pull/793) — `OPEN`, `mergedAt: null` while gated; CI `verify` pass                                                                                    |
| Stage-A agents                | 22 spawned: `flow-module-core:flow-consolidator` 1, `flow-fix-applier` 1, `flow-review-bug-detection` 1, `flow-review-pattern-consistency` 1, `flow-review-intent-guess` 2, `general-purpose` 16 |
| Gate byte-identity            | `flow-gate-decide 793` returned `gated` (autoMerge:false); the supervisor rendered the GATED block and stopped — no merge attempted                                                              |

Per-agent `.meta.json` `agentType` lines live under the fixture session's
`subagents/workflows/wf_410156f6-760/` transcript dir.

## Defect surfaced (fixed on this branch)

Stage A did not finish cleanly: three review-tail agents
(`review-tail-1`, `review-tail-2`, `review-partial-retry`) were terminated
by the harness — `blocked by safety classifier: Blocked by classifier`, the
same auto-mode permission classifier that gates Bash in the supervisor
session — and the Workflow runtime resolves such an agent to `null` rather
than throwing. The script then crashed with
`TypeError: null is not an object (evaluating 'retry.status')` and wrote no
`stage-a-result.json`; the supervisor recovered by running the gate read
itself, which is why the phaseLog and PR state above are still intact.

The block is not deterministic on the prompt text (a headless probe re-ran
the same review-tail prompt four ways, all four agents returned), so the
fix is defensive: every agent call in both stage scripts now passes through
a `guard()` that turns a null into a typed `AgentUnavailable`, caught once
into a validated `needs-human` (stage A) / `merge-failed` (stage B)
envelope written through the normal `write-result` path; a null lens inside
the review fan-out is dropped with a log line. Pinned by
`bin/workflow-script-guard.test.ts`, which executes both scripts under a
stubbed runtime.

## Not measured here

Test Steps item 4 (tick every box, reply `merge`, confirm the
`AskUserQuestion` form fires exactly once, phase reads `merged`) needs a
human at the fixture window: the supervisor session that drives this record
cannot type into another Claude session (its `tmux send-keys` was refused
by the same classifier). The window `flow:docs-touch-the-getting-started-note`
is left open at `gated` for that step.
