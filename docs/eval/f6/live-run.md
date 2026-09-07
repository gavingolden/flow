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

## Gate-override merge path (Test Steps item 4)

Driven 2026-09-07 from the `f6-workflow-port` supervisor window on the
user's instruction, since the fixture window's own session cannot receive
typed input from another session. All six Test Steps boxes on #793 were
already ticked; `flow-gate-decide 793` still returned `gated`
(`autoMerge:false`), so the override path fired.

| Check                  | Observed                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AskUserQuestion` form | fired exactly once (naming PR #793 and the 0-unchecked count); answered affirmatively                                                                                                            |
| Override token         | `flow-merge-guard 793 --record-override` → `{"recorded":true,"pr":793,"confirmedAt":"2026-09-07T00:08:28.472Z"}`                                                                                 |
| Workflow dispatch      | `name: "flow-module-core:flow-stage-b"` was NOT resolvable in the driving session (its plugin root was materialized after session start); the documented `scriptPath` fallback ran the same file |
| Stage-B agents         | 5 × `general-purpose` (precheck, guard, merge, sweep, write-result); guard `rc=0`, merge `rc=0`, sweep empty                                                                                     |
| Result                 | `{"stage":"B","outcome":"merged","pr":"793",…}`; `gh pr view 793` → `MERGED`, `mergedAt: 2026-09-07T00:09:28Z`; 118 s, 5 agents, 243k subagent tokens                                            |
| `phaseLog`             | `…,"gating","gated","merged"` after the step-11 `flow-gate-summary --status merged` render; `jq -r .phase` reads `merged`                                                                        |

## Defects surfaced by the merge path (fixed on this branch)

- **`validated:false` on every stage-B exit.** SKILL.md's stage-B args
  block built `pr` with `jq --arg` (a string); the result envelope requires
  a number, so `flow-workflow-result-schema --validate` returned
  `{"ok":false,"reason":"'pr' must be a number"}`. Fixed by `--argjson pr`
  in SKILL.md and a defensive `args.pr = Number(args.pr)` in the script.
- **`merging` never recorded on the override path.** `advancePhase` refused
  every write out of a terminal phase, so `flow-merge-guard`'s `merging`
  emission was a no-op from `gated` and phaseLog jumped `gated → merged`.
  `advancePhase` now honours `TERMINAL_EXIT_TRANSITIONS` (`gated →
verifying/gating/merging`), and `flow-merge-guard` writes `merging` out
  of `gated` only when the guard clears.
