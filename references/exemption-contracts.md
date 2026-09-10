# Task-tool exemption contracts

Per-exemption contract bodies offloaded from `.claude/rules/flow-supervisor-contracts.md` `## Don'ts` (PR
addressing #220) to keep that file under its char budget. Each section
below carries the unique contract for one of the eight named Task-tool
exemptions: spawn site / triggering step, artifact path, typed artifact
fields, and any model override.

This file is one half of a bidirectional contract. The other anchors are:

- `.claude/rules/flow-supervisor-contracts.md` `## Don'ts` — the trimmed opener + one-line summary for each
  exemption, each pointing here.
- `skills/pipeline/flow-pipeline/SKILL.md` "Hard rules" — the canonical
  `**Task-tool exemption #N: ...**` blocks the .claude/rules/flow-supervisor-contracts.md bullets are
  symmetric with (enforced by `bin/skill-md-lint.test.ts`).

The **shared rationale** for all eight (why a top-level supervisor may
call Task at these sites) stays in `.claude/rules/flow-supervisor-contracts.md` `## Don'ts` alongside the
openers — it is not duplicated here.

## `/flow-pr-review` Independent Multi-Agent Review

`/flow-pipeline` step 8 loads `/flow-pr-review`; at the "Independent
Multi-Agent Review" step, up to seven review agents — six content-gated by
`flow-review-scope` against the changed-file set and static-analysis
signals (see `flow-pr-review` `references/review-scope.md`), the seventh
(`product`) gated on a product brief resolving and tolerated-absent
downstream — PLUS one
diff-only intent-guess agent (skipped on a delta re-entry with a prior
`intent-resolution.json`) are spawned in parallel, in the same fan-out
message, via the Task tool; the fan-out is re-fanned at most once per
invocation when the Consolidator-Validator's `scope_verdict.widen`
requests a widen to the full PR diff, inside this same exemption (no new
Task-tool exemption; the count stays eight). Each spawned lens names
`subagent_type: $LENS_AGENT` (resolved per-lens against the
`agents/flow-review-<lens>.md` definitions with a Read/Grep/Glob/Write
`tools:` allowlist and no `effort:`/`model:` pins), resolved via a
single plugin-root probe using the
`[ -f ~/.flow/claude-home/.claude/skills/flow-module-core/agents/flow-review-<lens>.md ]` file-exists guard:
the plugin-qualified `flow-module-core:flow-review-<lens>` name when
present (a bare `flow-review-<lens>` subagent_type fails Task-tool
resolution outright — measured: "Agent type 'flow-scout' not found"),
else `general-purpose` with the loud `NOTICE — agent-fallback:`
line (no bare-name legacy-install tier); the intent-guess spawn names `subagent_type:
flow-module-core:flow-review-intent-guess` (`agents/flow-review-intent-guess.md`, same
tools allowlist plus the blindness contract — no PR title/body/plan/
commit messages in its context, diff + file list only), resolved via
the same two-tier file-exists-guard-with-fallback pattern. The fan-out itself
emits no consolidated artifact — each lens agent persists
its own `$WORKTREE/.flow-tmp/agent-output-<lens>.json`, typed fields
`findings`, `rejected_alternatives`, `anti_patterns_found`, and the
intent-guess agent persists `$WORKTREE/.flow-tmp/intent-guess.json`
(NOT a Consolidator-Validator input); the downstream
Consolidator-Validator step (a separate exemption) produces
`consolidator-result.json` from the six lens outputs plus the optional
cross-model (Gemini) lens output when `review.gemini` is enabled. All
seven lens/intent-guess agents run inside the supervisor's own in-process Skill load
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

**Blind product critic (brief-gated, same exemption).** When a product
brief resolves (`flow-product-brief`'s `.found`) and `.flow-tmp/product-critique.md`
is absent or stale, `/flow-pipeline` step 3's supervisor spawns one
`agents/flow-product-critic.md` agent via the Task tool AFTER the
`/flow-product-planning` wrapper returns — not from inside the wrapper, so
the wrapper's exactly-one-Task-call invariant above is untouched. Tools:
Read, Write only — it is blind to repository code, arguing the plan
against the brief alone. Artifact: `.flow-tmp/product-critique.md`,
reconciled in place by the supervisor into plan.md's `### Product critique
(blind)` subsection under `## Open Questions`. Same exemption as the
Discovery Subagent above, no nesting, no new Task-tool exemption.

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
resolved via a single plugin-root probe using the `[ -f ~/.flow/claude-home/.claude/skills/flow-module-core/agents/flow-scout.md ]`
file-exists guard: the plugin-qualified `flow-module-core:flow-scout`
name when present (a bare `flow-scout` subagent_type fails Task-tool
resolution outright — measured: "Agent type 'flow-scout' not found"),
else `general-purpose` fallback emitting the `NOTICE — agent-fallback:` line
(no bare-name legacy-install tier).

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
surfaces in-context while the fix rationale is still live. **Pushes are
scoped to the PR's own branch only — never `main`, `master`, or the base
branch.** A PR that merges mid-review routes its unaddressed findings
through the deferral path (one consolidated `flow-create-issue` per PR)
instead of committing anywhere, per `AGENTS.md`'s no-auto-push-on-base
default and the `bin/lib/base-branch-guard.ts` pre-commit hook that
enforces the same invariant mechanically. Spawned as
the named `agents/flow-fix-applier.md` definition (judgment role: no
frontmatter `effort`/`model`; per-spawn `model:` threading unchanged),
resolved via a single plugin-root probe using the `[ -f ~/.flow/claude-home/.claude/skills/flow-module-core/agents/flow-fix-applier.md ]`
file-exists guard: the plugin-qualified `flow-module-core:flow-fix-applier`
name when present (a bare `flow-fix-applier` subagent_type fails
Task-tool resolution outright), else `general-purpose` fallback emitting the
`NOTICE — agent-fallback:` line (no bare-name legacy-install tier). The
agent's `maxTurns: 120` budget means a `SendMessage` continuation of its
own partial result (`skills/pipeline/flow-pipeline/references/partial-result-continuation.md`) stays
inside this exemption — not an eighth site.

## Merge-Conflict Resolver Subagent

When `/flow-pipeline` step 10's `gh pr merge --squash` returns a
conflict-class failure (stderr matching the detection patterns in
`skills/pipeline/flow-merge-resolver-instructions/SKILL.md`),
the supervisor spawns one resolver subagent via the Task tool for the
base-branch merge + per-file resolution + push. Artifact:
`.flow-tmp/merge-resolver-result.json` (typed fields `resolved_files`,
`ambiguous_resolutions`, `rejected_strategies`, `commits`,
`push_status`, `summary`). After it returns the supervisor retries
`gh pr merge --squash` exactly once; on second failure it escalates
`NEEDS HUMAN: merge-failed` with the resolver's summary first sentence
appended. **No force-push.** The resolver merges the base branch into
the pipeline branch and pushes normally, so nothing irreversible is
delegated to a subagent spawn (an autonomous force-push is gated by the
permission classifier under auto permission mode, and `AGENTS.md`
forbids force-push without an explicit user request). Pushes are still
scoped to the per-pipeline branch only — never `main`, `master`, or the
base branch.
Spawned as the named `agents/flow-merge-resolver.md` definition (judgment
role: no frontmatter `effort`/`model`; per-spawn `model:` threading
unchanged), resolved via a single plugin-root probe using the
`[ -f ~/.flow/claude-home/.claude/skills/flow-module-core/agents/flow-merge-resolver.md ]`
file-exists guard: the plugin-qualified `flow-module-core:flow-merge-resolver`
name when present (a bare `flow-merge-resolver` subagent_type fails
Task-tool resolution outright), else `general-purpose` fallback emitting the
`NOTICE — agent-fallback:` line (no bare-name legacy-install tier).

On a spawn-denial (the Task call itself refused, no artifact written),
the supervisor escalates `NEEDS HUMAN: merge-resolver-spawn-denied` and
does **not** resolve the conflict inline: doing so would re-run a denied
operation under the supervisor's broader permission umbrella, inverting
the context-isolation this exemption exists to provide, and would also
re-spawn beyond the one-Task-call-per-run limit exemption #5 grants. The
agent's `maxTurns: 80` budget means a `SendMessage` continuation of its
own partial result (`skills/pipeline/flow-pipeline/references/partial-result-continuation.md`) stays
inside this exemption — not an eighth site.

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
exemption — not an eighth site.

## `/flow-pr-review` Independent Consolidator-Validator Subagent

`/flow-pipeline` step 8 loads `/flow-pr-review`; at the "Independent
Consolidator-Validator Subagent" step (Step 3.5), one
consolidator-validator agent is spawned via the Task tool as
`subagent_type: $CONSOLIDATOR_SUBAGENT` (the `agents/flow-consolidator.md`
definition — Bash/Read/Grep/Write allowlist, no `effort:`/`model:`
pins), resolved via a single plugin-root probe using the file-exists guard: the
plugin-qualified `flow-module-core:flow-consolidator` name when present
(a bare `flow-consolidator` subagent_type fails Task-tool resolution
outright), else falling back to
`general-purpose` with the loud `NOTICE — agent-fallback:` line
(no bare-name legacy-install tier). This spawn carries **no** `model: "haiku"` override — default
Sonnet is used because the second-opinion pass needs the larger model's
judgment.
Artifact: `<worktree>/.flow-tmp/consolidator-result.json` (typed fields
`consolidated_findings`, `dropped_by_validation`, `rejected_alternatives`,
`anti_patterns_found`, `summary`); the wrapper reads it once at Step 4
and reuses the parsed object across Steps 4–7. Also documented in
`skills/pipeline/flow-consolidator-instructions/SKILL.md`.

## `/flow-verify` Independent UI-Driver Subagent

**Two callers, one exemption.** Like the Edit-Applier, this exemption is
shared by more than one spawn site: `/flow-verify`'s UI-smoke pass (the
`/flow-pipeline` step-6 path described below) and `/flow-pr-review` step
8c.iii's visual-appearance capture, which passes `MODE: visual-appearance`
plus the enumerated item list so the driver captures per verification item
rather than per manifest route. Both write the same
`.flow-tmp/ui-driver-result.json` artifact and use the same guarded
subagent-type resolution, so the exemption count stays eight.

`/flow-pipeline` step 6 loads `/flow-verify`'s "Optional UI-smoke pass";
when the probe (`flow-ui-validate`) returns a `ran:true` ready envelope OR
a `bootstrap` envelope — never on an `mcp-not-available` or
`browser-profile-busy` skip, which stay quiet `ran:false` degrades and
never reach a Task call at all — the wrapper spawns exactly one
`flow-ui-driver` agent via the Task tool to launch the app, drive
`chrome-devtools` per route and viewport, and write the result artifact.
Resolved via a single plugin-root probe using the
`[ -f ~/.flow/claude-home/.claude/skills/flow-module-core/agents/flow-ui-driver.md ]`
file-exists guard: the plugin-qualified `flow-module-core:flow-ui-driver`
name when present (a bare `flow-ui-driver` subagent_type fails Task-tool
resolution outright — measured: "Agent type 'flow-scout' not found"),
else `general-purpose` fallback emitting the `NOTICE — agent-fallback:`
line (no bare-name legacy-install tier). Artifact:
`<worktree>/.flow-tmp/ui-driver-result.json` (typed fields per
`bin/lib/ui-driver-schema.ts`'s `UiDriverResult`: `ran`, `ok`,
`skipped_reason?`, `captures_path`, `ui_screenshots`, `fix_context`,
`rejected_alternatives`, `summary`).

**Model.** This spawn site resolves `config.models.uiDriver // "sonnet"`
— config-only, no CLI flag, and deliberately **not** inherited from the
session model or any `state.json` field (`bin/lib/model-routing-table.ts`'s
`ui-driver` row: `fallback: "builtin-sonnet"`). A manifest-driven browser
drive is template execution that must not silently inherit Opus/Fable.
Effort is a separate axis: this row does NOT pin `effort` — the Task tool
has no per-spawn effort argument, so a frontmatter effort pin would be
unoverridable even though `model` here is only a configurable default;
effort follows the session's `state.effort` like every other routed site.

**The `UI_SMOKE_DRIVER: inline` marker.** Two callers of the shared
`ui-smoke-pass.md` procedure exist: `/flow-verify`'s own Step 6/Optional
UI-smoke pass (spawns this exemption) and `/flow-fix-applier-instructions`'s
"Re-run /flow-verify" step, which has no Task tool of its own and instead
invokes `/flow-verify` with the literal marker line `UI_SMOKE_DRIVER:
inline` in its invocation — that marker tells `/flow-verify` to drive the
procedure in its OWN context rather than spawning this exemption. Absent
the marker, `/flow-verify` spawns the exemption as described above. This
is the one sanctioned inline path; it does not create a second exemption
because it never calls Task at all.

**Degrade, never escalate (D-o).** When
`test -s "$WORKTREE/.flow-tmp/ui-driver-result.json"` fails after the one
permitted Task call returns for this outer `/flow-verify` attempt,
`/flow-verify` treats it as `{ran: false, ok: false, skipped_reason:
"driver-no-artifact"}` and emits the existing `> [!NOTE] UI changed;
browser validation did not run — <reason>` line. It does **not** escalate
`NEEDS HUMAN`, does **not** re-spawn within the same outer attempt (one
Task call per outer attempt), and does **not** fail verify — the next
outer `/flow-verify` attempt re-spawns naturally. The `SendMessage`
partial-result continuation route
(`skills/pipeline/flow-pipeline/references/partial-result-continuation.md`)
stays available in principle but is **deliberately not wired here** —
unlike the Merge-Conflict Resolver and Edit-Applier exemptions above, a
missing/partial UI-driver artifact degrades to the named skip reason
above rather than triggering a continuation message. This omission is
intentional, not an oversight: the optional, gracefully-degrading nature
of the UI-smoke pass means a clean degrade is preferable to spending a
second Task call chasing a partial browser-drive artifact.
