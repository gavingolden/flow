# Workflow-spawned agent sites

`/flow-pipeline` steps 5–10 run as two fixed-shape `Workflow`-tool
scripts — `workflows/core/flow-stage-a.workflow.js` (implement → verify →
CI wait → review → gate read) and `workflows/core/flow-stage-b.workflow.js`
(merge guard → squash merge → conflict resolve → post-merge sweep). Every
`agent()` call inside those scripts is a code-level fan-out, not a
Task-tool exemption — the supervisor's own Task-tool budget is the two
named exemptions in `AGENTS.md` `## Don'ts` (Discovery,
`/flow-coder` Edit-Applier). This table enumerates every `agent()` site
in both scripts by label so a reviewer can audit the full agent surface
without diffing the scripts line by line. `bin/workflow-script-lint.test.ts`
asserts this table's `{Label, agentType}` set is exactly the set the two
scripts declare (order-insensitive) — add or remove an `agent()` call and
this table must move with it in the same commit.

"Model key" is the `args.models` field the call threads through
`modelArg()`, or `inherit` when the call omits `modelArg` (the agent
inherits the session default). "May nest" marks the two sites that spawn
a Task-tool subagent one level deeper — `implement` may run
`/flow-new-feature`'s scout or `/flow-coder`'s edit-applier; `verify` may
run `/flow-coder`'s edit-applier — under the flat one-shot-per-site
policy `docs/nested-subagents-assessment.md` documents. Every other site
is a single-turn `general-purpose` (or named `agents/core/*.md`) helper
that spawns nothing further.

## `flow-stage-a.workflow.js`

| Label                        | agentType                                          | Model key    | Effort      | Artifact                                          | May nest            |
| ---------------------------- | -------------------------------------------------- | ------------ | ----------- | ------------------------------------------------- | ------------------- |
| `read-state`                 | `general-purpose`                                  | inherit      | low         | —                                                 | —                   |
| `implement`                  | `general-purpose`                                  | implement    | args.effort | commit+push                                       | scout, edit-applier |
| `implement-retry`            | `general-purpose`                                  | implement    | args.effort | commit+push                                       | scout, edit-applier |
| `open-pr`                    | `general-purpose`                                  | inherit      | low         | `.flow-tmp/pr-body.md`                            | —                   |
| `verify-phase-write`         | `general-purpose`                                  | inherit      | low         | —                                                 | —                   |
| `verify`                     | `general-purpose`                                  | implement    | args.effort | UI-smoke excerpt/screenshots                      | edit-applier        |
| `copilot-precheck`           | `general-purpose`                                  | inherit      | low         | —                                                 | —                   |
| `ci-copilot-request`         | `general-purpose`                                  | inherit      | low         | —                                                 | —                   |
| `ci-check`                   | `general-purpose`                                  | inherit      | low         | `.flow-tmp/ci-wait-result.json`                   | —                   |
| `ci-wait-sleep`              | `general-purpose`                                  | inherit      | low         | —                                                 | —                   |
| `loop-prep-ci`               | `general-purpose`                                  | inherit      | low         | state.json `loops.ciFix`                          | —                   |
| `implement-ci-fix`           | `general-purpose`                                  | implement    | args.effort | commit+push                                       | scout, edit-applier |
| `ci-wait-sleep-review`       | `general-purpose`                                  | inherit      | low         | —                                                 | —                   |
| `review-prep`                | `general-purpose`                                  | review       | args.effort | `.flow-tmp/lens-prompt-*.md`                      | —                   |
| `review:bug-detection`       | `flow-module-core:flow-review-bug-detection`       | review       | args.effort | `.flow-tmp/agent-output-bug-detection.json`       | —                   |
| `review:security`            | `flow-module-core:flow-review-security`            | review       | args.effort | `.flow-tmp/agent-output-security.json`            | —                   |
| `review:pattern-consistency` | `flow-module-core:flow-review-pattern-consistency` | review       | args.effort | `.flow-tmp/agent-output-pattern-consistency.json` | —                   |
| `review:performance`         | `flow-module-core:flow-review-performance`         | review       | args.effort | `.flow-tmp/agent-output-performance.json`         | —                   |
| `review:supply-chain`        | `flow-module-core:flow-review-supply-chain`        | review       | args.effort | `.flow-tmp/agent-output-supply-chain.json`        | —                   |
| `review:test-coverage`       | `flow-module-core:flow-review-test-coverage`       | review       | args.effort | `.flow-tmp/agent-output-test-coverage.json`       | —                   |
| `review:intent-guess`        | `flow-module-core:flow-review-intent-guess`        | review       | args.effort | `.flow-tmp/intent-guess.json`                     | —                   |
| `consolidator`               | `flow-module-core:flow-consolidator`               | consolidator | args.effort | `.flow-tmp/consolidator-result.json`              | —                   |
| `consolidator-widen`         | `flow-module-core:flow-consolidator`               | consolidator | args.effort | `.flow-tmp/consolidator-result.json`              | —                   |
| `review-tail-1`              | `general-purpose`                                  | review       | args.effort | —                                                 | —                   |
| `fix-applier`                | `flow-module-core:flow-fix-applier`                | fixApplier   | low         | `.flow-tmp/fix-applier-result.json`               | —                   |
| `review-tail-2`              | `general-purpose`                                  | review       | args.effort | `.flow-tmp/pr-review-result.json`                 | —                   |
| `validate-review`            | `general-purpose`                                  | inherit      | low         | —                                                 | —                   |
| `read-review-result`         | `general-purpose`                                  | inherit      | low         | —                                                 | —                   |
| `review-partial-retry`       | `general-purpose`                                  | review       | args.effort | —                                                 | —                   |
| `loop-prep-review`           | `general-purpose`                                  | inherit      | low         | state.json `loops.reviewFix`                      | —                   |
| `gate-read`                  | `general-purpose`                                  | inherit      | low         | —                                                 | —                   |
| `write-result`               | `general-purpose`                                  | inherit      | low         | `.flow-tmp/stage-a-result.json`                   | —                   |

The six `review:<lens>` labels enumerate `AGENT_LENS_MAP`'s keys
(`bin/flow-pr-agent-lens.ts`); every `flow-review-<lens>.md` +
`flow-review-intent-guess.md` exists under `agents/core/`.

## `flow-stage-b.workflow.js`

| Label                       | agentType                              | Model key     | Effort      | Artifact                                               | May nest |
| --------------------------- | -------------------------------------- | ------------- | ----------- | ------------------------------------------------------ | -------- |
| `precheck`                  | `general-purpose`                      | inherit       | low         | —                                                      | —        |
| `guard`                     | `general-purpose`                      | inherit       | low         | —                                                      | —        |
| `merge`                     | `general-purpose`                      | inherit       | low         | —                                                      | —        |
| `merge-retry-after-resolve` | `general-purpose`                      | inherit       | low         | —                                                      | —        |
| `merge-retry-non-conflict`  | `general-purpose`                      | inherit       | low         | —                                                      | —        |
| `resolver-inputs`           | `general-purpose`                      | inherit       | low         | —                                                      | —        |
| `resolver`                  | `flow-module-core:flow-merge-resolver` | mergeResolver | args.effort | `.flow-tmp/merge-resolver-result.json` (`push_status`) | —        |
| `resolver-read`             | `general-purpose`                      | inherit       | low         | —                                                      | —        |
| `sweep`                     | `general-purpose`                      | inherit       | low         | —                                                      | —        |
| `write-result`              | `general-purpose`                      | inherit       | low         | `.flow-tmp/stage-b-result.json`                        | —        |

`write-result` is the same `{label, agentType}` pair in both scripts
(each script's own `helperAgent` wrapper); it is not a shared call site.
`models.fixApplier` has no consumer in stage B's args — it is not
threaded to any `agent()` call.
