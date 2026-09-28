# The pipeline's private skill copy (step 5.5)

Long-form detail for `/flow-pipeline` step 5.5. The step itself only runs
`flow-skill-overlay sync`; everything about what that does and does not
reach lives here.

## What the copy is

A flow-self pipeline (one launched in flow's own checkout) or a pipeline
launched with `flow feature create --skills-from <checkout> "<desc>"` runs
its supervisor on a **private, real-file copy** of flow's plugin roots at
`~/.flow/overlays/<slug>/.claude/skills/flow-module-<id>/`, not on the shared
install other pipelines read live. The copy is automatic for flow-self
launches (content from the canonical checkout); `--skills-from` names any
other source. It is unrelated to the `--slug` state overlays. Copies are
real files, never links: a running Claude Code session serves the pre-re-point
text of a re-pointed link, but re-reads a file rewritten in place. Only
`~/.flow/overlays/<slug>` is granted via `--add-dir`, never `~/.flow`.

Step 5.5 rewrites the copy in place from `$WORKTREE` after implement
(`flow-skill-overlay sync --slug "$FLOW_SLUG" --from "$WORKTREE"`): it writes
only files whose bytes differ, deletes files absent from the worktree, and
prints `{"ran":true,"written":[…],"removed":[…],"notExercised":[…]}`. Nothing
prunes the copy at pipeline end (the supervisor keeps loading skills from it
through steps 10-11); the next `flow feature create` launch prunes copies
whose pipeline is finished and not alive, never one modified in the last 30
minutes.

## What a running session does NOT pick up

Verified behavior of a session already running when the sync lands:

- **Edited skills first loaded after the sync run the branch's text.** Verify
  and review load their sub-skills after step 5.5, so an edit to an existing
  skill reaches them.
- **Brand-new skills, agent definitions, and skills already loaded do not
  change mid-session** — `flow-pipeline`, `flow-product-planning` and
  `flow-new-feature` are already loaded by the time step 5.5 runs. To
  exercise those, launch a fresh pipeline with
  `flow feature create --skills-from "$WORKTREE" "<desc>"`.
- Agent-presence probes inside skills still check the shared install path
  (known limit): under `--skills-from`, a branch-new agent falls back to
  `general-purpose`, and a branch-deleted agent passes the probe but fails
  Task resolution against the copy.

**Ordering constraint.** Nothing may verify or review between implement and
the sync: step 5.5 must run before `/flow-verify` loads any edited skill.

## Fix loops

Step 5.5 runs once, so skill edits made later (step-6 fixes, the step-7
`step-5-fix` loop, fix-applier commits) would miss the copy. Step 7 re-runs
the same idempotent sync near its head whenever a copy exists, so the
re-verify and re-review after a fix see the fixed text.

## Recovery: a self-broken review

If the branch's own edit broke verify or review, point the copy back at the
canonical checkout and continue:

```bash
flow-skill-overlay sync --slug "$FLOW_SLUG" --from "<canonical flow checkout>"
```

When you use it, upsert a `> [!CAUTION]` note in the PR body's `## Test Steps`
section: `> [!CAUTION] Review ran on main's skills (private copy reset to the
canonical checkout).` The review no longer exercised the branch's own text
and the reader must know.

## PR-body NOTE for what could not be exercised

When the sync's `notExercised` is non-empty, or the diff edits a skill the
supervisor had already loaded (at least `flow-pipeline`,
`flow-product-planning`, `flow-new-feature`), upsert ONE idempotent
`> [!NOTE]` block (edit in place, never stack) listing those paths and
pointing at `--skills-from`:

```bash
gh pr view "$PR" --json body --jq '.body' > "$WORKTREE/.flow-tmp/body.md"
jq -r '.notExercised[]' "$WORKTREE/.flow-tmp/skill-overlay-sync.json"
# upsert "> [!NOTE] Not exercised by this pipeline's own review: <paths>.
# Run flow feature create --skills-from <worktree> to exercise them." under
# ## Test Steps, then
flow-md-validate --fix-pr-body "$WORKTREE/.flow-tmp/body.md" && gh pr edit "$PR" --body-file "$WORKTREE/.flow-tmp/body.md"
```

Do not derive checkout paths by climbing out of `$SKILL_DIR` in examples or
prose: a copy has no `bin/`, so use PATH helpers.
