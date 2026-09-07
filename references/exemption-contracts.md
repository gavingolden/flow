# Task-tool exemption contracts

Per-exemption contract bodies offloaded from `AGENTS.md` `## Don'ts` (PR
addressing #220) to keep that file under its char budget. Each section
below carries the unique contract for one of the two named Task-tool
exemptions: spawn site / triggering step, artifact path, typed artifact
fields, and any model override.

This file is one half of a bidirectional contract. The other anchors are:

- `AGENTS.md` `## Don'ts` — the trimmed opener + one-line summary for each
  exemption, each pointing here.
- `skills/pipeline/flow-pipeline/SKILL.md` "Hard rules" — the canonical
  `**Task-tool exemption #N: ...**` blocks the AGENTS.md bullets are
  symmetric with (enforced by `bin/skill-md-lint.test.ts`).

The **shared rationale** for both (why a top-level supervisor may
call Task at these sites) stays in `AGENTS.md` `## Don'ts` alongside the
openers — it is not duplicated here.

Steps 5–10's `agent()` sites (the five exemptions this port dissolved —
Multi-Agent Review, Scout, Fix-Applier, Merge-Conflict Resolver, and
Consolidator-Validator, now running inside the `flow-stage-a` /
`flow-stage-b` `Workflow` scripts) are enumerated in
[workflow-agent-sites.md](workflow-agent-sites.md), not here — they are
code, not a Task-tool exemption. Their artifact contracts are unchanged —
the resolver still reports `push_status`, and the lens fan-out is still
re-fanned at most once on a consolidator widen. `/flow-pr-review` run standalone (not
via `/flow-pipeline`) still spawns its own Multi-Agent Review,
Fix-Applier, and Consolidator-Validator agents directly; that contract
now lives in `skills/pipeline/flow-pr-review/SKILL.md` itself.

## `/flow-product-planning` Independent Discovery Subagent

`/flow-pipeline` step 3 loads `/flow-product-planning`, which spawns one
discovery agent via the Task tool. Artifacts: `.flow-tmp/plan.md` and
`.flow-tmp/pr-description-draft.md`. Post-merge-fix invariants: absolute
SKILL_DIR + WORKTREE paths, exactly one Task call per invocation,
wrapper-owned `mkdir -p .flow-tmp/`, single side-effect attribution
site, main-session reads each artifact once and never re-reads.
Spawned as the named `agents/flow-discovery.md` definition (judgment
role: no frontmatter `effort`/`model`; per-spawn `model:` threading
unchanged), resolved via a single plugin-root probe using the
`[ -f ~/.flow/claude-home/.claude/skills/flow-module-core/agents/flow-discovery.md ]`
file-exists guard: the plugin-qualified `flow-module-core:flow-discovery`
name when present (a bare `flow-discovery` subagent_type fails
Task-tool resolution outright), else `general-purpose` fallback
(no bare-name legacy-install tier),
emitting the `NOTICE — agent-fallback:` line only on the fallback. The definition
deliberately carries no `tools:` allowlist — discovery's research and
design-artifact passes span Bash, `WebFetch`, MCP, and multimodal `Read`
surfaces a fixed allowlist would silently break — so it inherits every
tool the session has.

## `/flow-coder` Independent Edit-Applier Subagent

When the `/flow-pipeline` supervisor's interactive code-change redirect
path fires (a non-trivial code-change redirect at a worktree-existing
phase), or the `gated`-feedback loop composes an edit-set at the gate,
the wrapper invokes `/flow-coder` in-process, and `/flow-coder` spawns one
edit-applier agent via the Task tool to apply the edit-set and run
`flow-pre-commit --json` against the post-edit worktree. Artifact:
`<worktree>/.flow-tmp/coder-result.json` (typed fields `edits`,
`verify_status`, `rejected_alternatives`, `anti_patterns_found`,
`summary`). The subagent runs the verify re-run _before returning_ so an
edit's type/lint/test breakage surfaces in-context. Trivially scoped
edits skip the subagent via each caller's own hybrid threshold (see each
caller's "Spawn procedure (wider-scope path only)" for the canonical
bar). The full contract is in `skills/pipeline/flow-coder/SKILL.md`'s
"Independent Edit-Applier Subagent" section. Spawned as the named
`agents/flow-edit-applier.md` definition (judgment role: no frontmatter
`effort`/`model`; per-spawn `model:` threading unchanged), resolved via a
single plugin-root probe using the
`[ -f ~/.flow/claude-home/.claude/skills/flow-module-core/agents/flow-edit-applier.md ]`
file-exists guard: the plugin-qualified `flow-module-core:flow-edit-applier`
name when present (a bare `flow-edit-applier` subagent_type fails
Task-tool resolution outright — measured: "Agent type 'flow-scout' not
found"), else `general-purpose` fallback emitting the `NOTICE — agent-fallback:` line
(no bare-name legacy-install tier). The agent's `maxTurns: 80` budget
means a `SendMessage` continuation of its own partial result
(`skills/pipeline/flow-pipeline/references/partial-result-continuation.md`) stays inside this
exemption — not a third site. `/flow-new-feature` step 5, `/flow-verify`
step 3, and `/flow-refactoring` step 3's own wider-scope `/flow-coder`
spawns now run inside stage A's `implement`/`verify` `Workflow` agents
(depth 2) rather than as this supervisor's own Task call — see
[workflow-agent-sites.md](workflow-agent-sites.md).
