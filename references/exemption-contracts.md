# Task-tool exemption contracts

Per-exemption contract bodies offloaded from `AGENTS.md` `## Don'ts` (PR
addressing #220) to keep that file under its char budget. Each section
below carries the unique contract for one of the eight named Task-tool
exemptions: spawn site / triggering step, artifact path, typed artifact
fields, and any model override.

This file is one half of a bidirectional contract. The other anchors are:

- `AGENTS.md` `## Don'ts` — the trimmed opener + one-line summary for each
  exemption, each pointing here.
- `skills/pipeline/flow-pipeline/SKILL.md` "Hard rules" — the canonical
  `**Task-tool exemption #N: ...**` blocks the AGENTS.md bullets are
  symmetric with (enforced by `bin/skill-md-lint.test.ts`).

The **shared rationale** for all eight (why a top-level supervisor may
call Task at these sites) stays in `AGENTS.md` `## Don'ts` alongside the
openers — it is not duplicated here.

## `/pr-review` Independent Multi-Agent Review

`/flow-pipeline` step 8 loads `/pr-review`; at the "Independent
Multi-Agent Review" step, six review agents are spawned in parallel via
the Task tool. The fan-out itself emits no consolidated artifact — each
agent persists its own `$WORKTREE/.flow-tmp/agent-output-<lens>.json`;
the downstream Consolidator-Validator step (a separate exemption)
produces `consolidator-result.json`. The six agents run inside the
supervisor's own in-process Skill load (`/pr-review` has no
`context: fork` directive).

## `/product-planning` Independent Discovery Subagent

`/flow-pipeline` step 3 loads `/product-planning`, which spawns one
discovery agent via the Task tool. Artifacts: `.flow-tmp/plan.md` and
`.flow-tmp/pr-description-draft.md`. Post-merge-fix invariants: absolute
SKILL_DIR + WORKTREE paths, exactly one Task call per invocation,
wrapper-owned `mkdir -p .flow-tmp/`, single side-effect attribution
site, main-session reads each artifact once and never re-reads.

## `/new-feature` Independent Scout Subagent

`/flow-pipeline` step 5 loads `/new-feature`, which spawns one scout
agent via the Task tool — but only on the wider-scope path of its hybrid
threshold (≤3 affected files skips the scout). Artifact:
`.flow-tmp/scout.md`. The scout adopts the Discovery Subagent's
invariants verbatim, plus one addition: its return summary must surface
both sides — at least one positive finding and at least one negative
finding (off-limits surfaces, rejected approaches, foreclosed shortcuts).

## `/pr-review` Fix-Applier Subagent

`/flow-pipeline` step 8 loads `/pr-review`; at the "Independent
Fix-Applier Subagent" step, one fix-applier agent is spawned via the
Task tool to handle the per-finding address loop plus pre-commit /
commit / push. Artifact: `.flow-tmp/fix-applier-result.json` (typed
fields `commits`, `deferred`, `rejected_alternatives`,
`anti_patterns_found`, `summary`). The subagent invokes `/verify`
against the post-fix worktree *before returning*, so a fix's CI breakage
surfaces in-context while the fix rationale is still live.

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

## `/coder` Independent Edit-Applier Subagent

When a pipeline skill reaches its hybrid-threshold wider-scope path —
`/new-feature` step 5, `/verify` step 3, or `/refactoring` step 3 — or
when the `/flow-pipeline` supervisor's interactive code-change redirect
path fires (a non-trivial code-change redirect at a worktree-existing
phase), the wrapper invokes `/coder` in-process, and `/coder` spawns one
edit-applier agent via the Task tool to apply the edit-set and run
`flow-pre-commit --json` against the post-edit worktree. Artifact:
`<worktree>/.flow-tmp/coder-result.json` (typed fields `edits`,
`verify_status`, `rejected_alternatives`, `anti_patterns_found`,
`summary`). The subagent runs the verify re-run *before returning* so an
edit's type/lint/test breakage surfaces in-context. Trivially scoped
edits skip the subagent via each caller's own hybrid threshold (see each
caller's "Spawn procedure (wider-scope path only)" for the canonical
bar). The full contract is in `skills/pipeline/coder/SKILL.md`'s
"Independent Edit-Applier Subagent" section.

## `/pr-review` Independent Gatekeeper Subagent

`/flow-pipeline` step 8 loads `/pr-review`; at the "Independent
Gatekeeper Subagent" step (Step 1.5), one gatekeeper agent is spawned
via the Task tool with a per-spawn `model: "haiku"` override — justified
primarily by **cost-routing** rather than context isolation. It
short-circuits the four-agent Sonnet fan-out on
closed/merged/trivial/no-new-commits PRs from a single `gh pr view`
metadata fetch. Artifact: `<worktree>/.flow-tmp/gatekeeper-result.json`
(typed fields `decision`, `reason`, `skip_kind?`, `summary`). The
wrapper branches on it: `"skip"` writes a `pr-review-result.json` with
`status: "clean"` and `completed_steps: ["1", "1.5"]` so Step 8 proceeds
to the auto-merge gate; `"proceed"` continues to Step 2 unchanged.

## `/pr-review` Independent Consolidator-Validator Subagent

`/flow-pipeline` step 8 loads `/pr-review`; at the "Independent
Consolidator-Validator Subagent" step (Step 3.5), one
consolidator-validator agent is spawned via the Task tool. Unlike the
Gatekeeper there is **no** `model: "haiku"` override — default Sonnet is
used because the second-opinion pass needs the larger model's judgment.
Artifact: `<worktree>/.flow-tmp/consolidator-result.json` (typed fields
`consolidated_findings`, `dropped_by_validation`, `rejected_alternatives`,
`anti_patterns_found`, `summary`); the wrapper reads it once at Step 4
and reuses the parsed object across Steps 4–7. Also documented in
`skills/pipeline/pr-review/references/consolidator-instructions.md`.
