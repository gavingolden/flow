# Task-tool exemption contracts

Per-exemption contract bodies offloaded from `AGENTS.md` `## Don'ts` (PR
addressing #220) to keep that file under its char budget. Each section
below carries the unique contract for one of the nine named Task-tool
exemptions: spawn site / triggering step, artifact path, typed artifact
fields, and any model override.

This file is one half of a bidirectional contract. The other anchors are:

- `AGENTS.md` `## Don'ts` — the trimmed opener + one-line summary for each
  exemption, each pointing here.
- `skills/pipeline/flow-pipeline/SKILL.md` "Hard rules" — the canonical
  `**Task-tool exemption #N: ...**` blocks the AGENTS.md bullets are
  symmetric with (enforced by `bin/skill-md-lint.test.ts`).

The **shared rationale** for all nine (why a top-level supervisor may
call Task at these sites) stays in `AGENTS.md` `## Don'ts` alongside the
openers — it is not duplicated here.

## `/flow-pr-review` Independent Multi-Agent Review

`/flow-pipeline` step 8 loads `/flow-pr-review`; at the "Independent
Multi-Agent Review" step, six review agents PLUS one diff-only
intent-guess agent are spawned in parallel, in the same fan-out message,
via the Task tool. Each of the six lens spawns names
`subagent_type: flow-review-<lens>` (the `agents/flow-review-<lens>.md`
definitions with a Read/Grep/Glob/Write `tools:` allowlist and no
`effort:`/`model:` pins), resolved via the
`[ -f ~/.claude/agents/flow-review-<lens>.md ]` file-exists guard that
falls back to `general-purpose` with the loud `NOTICE — agent-fallback:`
line; the intent-guess spawn names `subagent_type:
flow-review-intent-guess` (`agents/flow-review-intent-guess.md`, same
tools allowlist plus the blindness contract — no PR title/body/plan/
commit messages in its context, diff + file list only), resolved via
the same file-exists-guard-with-fallback pattern. The fan-out itself
emits no consolidated artifact — each of the six lens agents persists
its own `$WORKTREE/.flow-tmp/agent-output-<lens>.json`, and the
intent-guess agent persists `$WORKTREE/.flow-tmp/intent-guess.json`
(NOT a Consolidator-Validator input); the downstream
Consolidator-Validator step (a separate exemption) produces
`consolidator-result.json` from the six lens outputs only. All seven
agents run inside the supervisor's own in-process Skill load
(`/flow-pr-review` has no `context: fork` directive).

## `/flow-product-planning` Independent Discovery Subagent

`/flow-pipeline` step 3 loads `/flow-product-planning`, which spawns one
discovery agent via the Task tool. Artifacts: `.flow-tmp/plan.md` and
`.flow-tmp/pr-description-draft.md`. Post-merge-fix invariants: absolute
SKILL_DIR + WORKTREE paths, exactly one Task call per invocation,
wrapper-owned `mkdir -p .flow-tmp/`, single side-effect attribution
site, main-session reads each artifact once and never re-reads.
Spawned as the named `agents/flow-discovery.md` definition (judgment
role: no frontmatter `effort`/`model`; per-spawn `model:` threading
unchanged), with the
`[ -f ~/.claude/agents/flow-discovery.md ] || general-purpose` fallback
guard emitting the `NOTICE — agent-fallback:` line. The definition
deliberately carries no `tools:` allowlist — discovery's research and
design-artifact passes span Bash, `WebFetch`, MCP, and multimodal `Read`
surfaces a fixed allowlist would silently break — so it inherits every
tool the session has.

## `/flow-new-feature` Independent Scout Subagent

`/flow-pipeline` step 5 loads `/flow-new-feature`, which spawns one scout
agent via the Task tool — but only on the wider-scope path of its hybrid
threshold (≤3 affected files skips the scout). Artifact:
`.flow-tmp/scout.md`. The scout adopts the Discovery Subagent's
invariants verbatim, plus one addition: its return summary must surface
both sides — at least one positive finding and at least one negative
finding (off-limits surfaces, rejected approaches, foreclosed shortcuts).
Spawned as the named `agents/flow-scout.md` definition (judgment role: no
frontmatter `effort`/`model`; per-spawn `model:` threading unchanged),
with the `[ -f ~/.claude/agents/flow-scout.md ] || general-purpose`
fallback guard emitting the `NOTICE — agent-fallback:` line.

## `/flow-pr-review` Fix-Applier Subagent

`/flow-pipeline` step 8 loads `/flow-pr-review`; at the "Independent
Fix-Applier Subagent" step, one fix-applier agent is spawned via the
Task tool to handle the per-finding address loop plus pre-commit /
commit / push. Artifact: `.flow-tmp/fix-applier-result.json` (typed
fields `commits`, `deferred`, `rejected_alternatives`,
`anti_patterns_found`, `summary`, `ui_screenshots?` — optional array of
absolute screenshot paths captured by the browser pass, for supervisor
session surfacing; typically populated by `/flow-pr-review` Step 8c's
post-spawn merge-back rather than by the subagent itself). The subagent invokes `/flow-verify`
against the post-fix worktree _before returning_, so a fix's CI breakage
surfaces in-context while the fix rationale is still live. Spawned as
the named `agents/flow-fix-applier.md` definition (judgment role: no
frontmatter `effort`/`model`; per-spawn `model:` threading unchanged),
with the `[ -f ~/.claude/agents/flow-fix-applier.md ] || general-purpose`
fallback guard emitting the `NOTICE — agent-fallback:` line.

## Merge-Conflict Resolver Subagent

When `/flow-pipeline` step 10's `gh pr merge --squash` returns a
conflict-class failure (stderr matching the detection patterns in
`skills/pipeline/flow-pipeline/references/merge-resolver-instructions.md`),
the supervisor spawns one resolver subagent via the Task tool for the
rebase + per-file resolution + force-push. Artifact:
`.flow-tmp/merge-resolver-result.json` (typed fields `resolved_files`,
`ambiguous_resolutions`, `rejected_strategies`, `commits`,
`force_push_status`, `summary`). After it returns the supervisor retries
`gh pr merge --squash` exactly once; on second failure it escalates
`NEEDS HUMAN: merge-failed` with the resolver's summary first sentence
appended. **Force-push is permitted** here because the resolver runs
inside `/flow-pipeline`'s auto-merge umbrella and is scoped to the
per-pipeline branch only — never `main`, `master`, or the base branch.
Spawned as the named `agents/flow-merge-resolver.md` definition (judgment
role: no frontmatter `effort`/`model`; per-spawn `model:` threading
unchanged), with the
`[ -f ~/.claude/agents/flow-merge-resolver.md ] || general-purpose`
fallback guard emitting the `NOTICE — agent-fallback:` line.

## `/flow-coder` Independent Edit-Applier Subagent

When a pipeline skill reaches its hybrid-threshold wider-scope path —
`/flow-new-feature` step 5, `/flow-verify` step 3, or `/flow-refactoring` step 3 — or
when the `/flow-pipeline` supervisor's interactive code-change redirect
path fires (a non-trivial code-change redirect at a worktree-existing
phase), the wrapper invokes `/flow-coder` in-process, and `/flow-coder` spawns one
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
`effort`/`model`; per-spawn `model:` threading unchanged), with the
`[ -f ~/.claude/agents/flow-edit-applier.md ] || general-purpose`
fallback guard emitting the `NOTICE — agent-fallback:` line. A second,
nested spawn site exists — the Verify-Retry-Loop's wider-scope path
spawns the same definition directly at depth 3, writing
`verify-coder-result.json` with no `general-purpose` fallback; see the
Verify-Retry-Loop section below.

## `/flow-pr-review` Independent Gatekeeper Subagent

`/flow-pipeline` step 8 loads `/flow-pr-review`; at the "Independent
Gatekeeper Subagent" step (Step 1.5), one gatekeeper agent is spawned
via the Task tool as `subagent_type: flow-gatekeeper` (resolved via the
file-exists guard, falling back to `general-purpose` with the loud
`NOTICE — agent-fallback:` line) with a per-spawn `model: "haiku"`
override — justified primarily by **cost-routing** rather than context
isolation. The haiku pin is paired: `agents/flow-gatekeeper.md`
frontmatter declares `model: haiku` as the declarative record, and the
spawn site keeps the identical per-spawn `model: "haiku"` so the
fallback path stays haiku (per-spawn wins; the values never conflict).
It short-circuits the six-agent Sonnet fan-out on
closed/merged/trivial/no-new-commits PRs from a single `gh pr view`
metadata fetch. Artifact: `<worktree>/.flow-tmp/gatekeeper-result.json`
(typed fields `decision`, `reason`, `skip_kind?`, `summary`). The
wrapper branches on it: `"skip"` writes a `pr-review-result.json` with
`status: "clean"` and `completed_steps: ["1", "1.5"]` so Step 8 proceeds
to the auto-merge gate; `"proceed"` continues to Step 2 unchanged.

## `/flow-pr-review` Independent Consolidator-Validator Subagent

`/flow-pipeline` step 8 loads `/flow-pr-review`; at the "Independent
Consolidator-Validator Subagent" step (Step 3.5), one
consolidator-validator agent is spawned via the Task tool as
`subagent_type: flow-consolidator` (the `agents/flow-consolidator.md`
definition — Bash/Read/Grep/Write allowlist, no `effort:`/`model:`
pins), resolved via the file-exists guard that falls back to
`general-purpose` with the loud `NOTICE — agent-fallback:` line. Unlike
the Gatekeeper there is **no** `model: "haiku"` override — default
Sonnet is used because the second-opinion pass needs the larger model's
judgment.
Artifact: `<worktree>/.flow-tmp/consolidator-result.json` (typed fields
`consolidated_findings`, `dropped_by_validation`, `rejected_alternatives`,
`anti_patterns_found`, `summary`); the wrapper reads it once at Step 4
and reuses the parsed object across Steps 4–7. Also documented in
`skills/pipeline/flow-pr-review/references/consolidator-instructions.md`.

## Verify-Retry-Loop Subagent

`/flow-pipeline` step 6 (`Local verify`) spawns one verify-retry-loop agent via
the Task tool to own the 3-outer-attempt `/flow-verify` loop in an isolated context:
each retry re-invokes `/flow-verify` and re-pastes the prior attempt's
`flow-pre-commit --json` `failure` object, and the loop also owns the Layer-3
`.flow/pre-commit.json` config-authoring branch (which commits to the feature
branch) and the UI-smoke pass. Artifact:
`<worktree>/.flow-tmp/verify-loop-result.json` (typed fields `verify_status`
(`pass` | `exhausted`), `attempts`, `config_authored`, `ui_smoke`,
`ui_smoke_reason?`, `ui_screenshots?` — optional array of absolute
screenshot paths captured by the browser pass, for supervisor session
surfacing — `final_failure_excerpt?`, `rejected_alternatives`, `anti_patterns_found`,
`summary`). The supervisor reads it once and branches: `pass` continues to step
7; `exhausted` escalates `verify-exhausted` and writes the `> [!CAUTION]` PR-body
block from `final_failure_excerpt`. A committing subagent is consistent with the
Fix-Applier (#4) and Merge-Conflict Resolver (#5) precedents. Spawned as
the named `agents/flow-verify.md` definition (mechanical role: pins
`effort: low`, no `model:` pin; per-spawn `model:` threading unchanged),
with the `[ -f ~/.claude/agents/flow-verify.md ] || general-purpose`
fallback guard emitting the `NOTICE — agent-fallback:` line. The
subagent's full instructions are at
`skills/pipeline/flow-pipeline/references/verify-loop-instructions.md`.

**Nested site.** On the wider-scope path, the verify-loop subagent
spawns ONE flow-edit-applier subagent at depth 3, with NO
`general-purpose` fallback (unlike the nine top-level exemptions, this
site has a known-good inline fallback and does not hand a Task-capable
toolset to a definition that isn't lint-pinned to exclude `Task`),
passing a JSON edit-set per
`skills/pipeline/flow-coder/references/coder-instructions.md` (its
`INSTRUCTIONS_PATH`, threaded alongside `SKILL_DIR =
skills/pipeline/flow-coder/`) and the absolute artifact path
`<worktree>/.flow-tmp/verify-coder-result.json` (distinct from the
supervisor-path `coder-result.json` so a stale parent artifact can never
mask a child miss); failure enum recorded in `verify-loop-result.json`'s
`coder_spawn`: `ok`|`not-attempted`|`task-tool-unavailable`|
`agent-unavailable`|`artifact-missing`|`invalid`. On any miss the loop
applies that fix inline once and stays inline for the remainder of the
run. This is a sanctioned nested site inside this exemption, not a
tenth top-level exemption; its failure action is inverted from the nine
top-level sites — record and degrade inline, never escalate.
