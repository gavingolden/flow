# Task-tool Exemption Preamble

This file carries the canonical "Load the Task tool before spawning"
preamble once. It is consulted on demand from each Task-tool exemption
spawn site that links here — `/flow-pr-review`'s Multi-Agent Review and
Fix-Applier spawn sites, and `/flow-pipeline`'s Merge-Conflict Resolver
spawn site. Read this file when the per-site one-line summary in
SKILL.md points you here for the full rationale and alias-tolerance
contract.

## Load the Task tool before spawning

**Load the Task tool before spawning.** In Claude Code sessions where
neither `Task` nor its alias `Agent` is surfaced top-level by the
harness (both are aliases of the same one-shot subagent-spawn
primitive: identical `subagent_type` / `prompt` / `description`
schema), the spawn will silently fall through to in-line execution
unless the schema is loaded first. Before the Task call at the spawn
site, run `ToolSearch query="select:Task"` and confirm the response
contains either a `<function>{"name": "Task", ...}</function>` or a
`<function>{"name": "Agent", ...}</function>` line. If it does not,
**do not fall back to in-line execution** — escalate
`NEEDS HUMAN: task-tool-unavailable: <exemption-name>` and exit. Each
spawn site supplies its own `<exemption-name>` token verbatim (see
`references/escalation-recipes.md` for the per-tag result-artifact
recipe the supervisor writes before exiting).

## Why the in-line fallback is forbidden

The fan-out's value is its context isolation; an in-line fallback
breaks the contract that this exemption is justified by. The per-site
preambles enumerate context-cost rationale (per-finding fix prose,
per-comment file reads, `flow-pre-commit` transcript, `/flow-verify`
re-run) — all of those would land in the supervisor's transcript if
the spawn silently degraded to in-line execution, eroding the
context-cost win the exemption was authored to capture.

PR #124 was the inaugural silent-fallback regression: in a Claude Code
session where `Task` was a deferred capability, an unguarded Task call
silently fell through to in-line execution and the supervisor never
realised the fan-out hadn't actually happened. The `ToolSearch`
load-first + literal-check + escalate-on-miss sequence above is the
contract that prevents the regression recurring.

## Cross-references

The bidirectional-contract source of truth for all six Task-tool
exemptions lives in `AGENTS.md` under the `## Don'ts` section — every
exemption is named there, scoped, and rationale'd. The supervisor-side
canonical preamble lives in `skills/pipeline/flow-pipeline/SKILL.md`
under `# Hard rules` (the centralized "Load the Task tool at each
spawn site" block, which is what `bin/skill-md-lint.test.ts` anchors
on for symmetry assertions between AGENTS.md and the SKILL.md). This
reference file is downstream of both — it carries the per-site
rationale that the spawn-site one-liner abbreviates, not the
contract itself.
