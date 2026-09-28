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
real files, never links, so nothing dangles once the worktree is removed. Only
`~/.flow/overlays/<slug>` is granted via `--add-dir`, never `~/.flow`.

Step 5.5 rewrites the copy in place from `$WORKTREE` after implement
(`flow-skill-overlay sync --slug "$FLOW_SLUG" --from "$WORKTREE"`): it writes
only files whose bytes differ, deletes files absent from the worktree, and
prints `{"ran":true,"written":[…],"removed":[…],"notExercised":[…]}`. Nothing
prunes the copy at pipeline end (the supervisor keeps loading skills from it
through steps 10-11); the next `flow feature create` launch prunes copies
whose pipeline is finished and not alive, never one modified in the last 30
minutes.

## What a running session picks up

Verified on Claude Code 2.1.284 and pinned by
`bin/lib/skill-overlay.live.test.ts` (`RUN_CLAUDE_LIVE=1`): a session
snapshots plugin-root skill text when it starts. A sync rewrites the copy on
disk, but the ALREADY-RUNNING supervisor keeps serving the text it started
with — including for a skill it has not loaded yet, and even ten seconds after
the rewrite. The synced copy reaches:

- **A session started after the sync** — a `flow feature resume` relaunch, or
  a fresh `flow feature create --skills-from "$WORKTREE" "<desc>"`. That fresh
  launch is how to exercise edited skills, brand-new skills, and agent
  definitions end to end.
- **The running session, once the user types `/reload-plugins` in its pane.**
  flow cannot inject it: it runs only when the user types it.

Until one of those happens, this pipeline's own verify and review run the
skill text the session started with (`main`'s, for a flow-self launch). The
already-loaded supervisor playbook (`flow-pipeline`, `flow-product-planning`,
`flow-new-feature`) is already in context and never changes mid-session on
any path.

Agent-presence probes inside skills still check the shared install path
(known limit): under `--skills-from`, a branch-new agent falls back to
`general-purpose`, and a branch-deleted agent passes the probe but fails Task
resolution against the copy.

**Ordering constraint.** Nothing may verify or review between implement and
the sync: step 5.5 must run before `/flow-verify` so a resume or reload right
after it already sees the branch's text.

## Fix loops

Step 5.5 runs once, so skill edits made later (step-6 fixes, the step-7
`step-5-fix` loop, fix-applier commits) would miss the copy. Step 7 re-runs
the same idempotent sync near its head whenever a copy exists, keeping the copy
current for a resume or a `/reload-plugins`.

## Recovery: a self-broken review

If a resumed or reloaded session loaded a branch skill edit that broke verify
or review, point the copy back at the canonical checkout and have the user
reload:

```bash
flow-skill-overlay sync --slug "$FLOW_SLUG" --from "<canonical flow checkout>"
```

then the user types `/reload-plugins` (or resumes). When you use it, upsert a
`> [!CAUTION]` note in the PR body's `## Test Steps` section: `> [!CAUTION]
Review ran on main's skills (private copy reset to the canonical checkout).`
The review no longer exercised the branch's own text and the reader must know.

## PR-body NOTE for what was not exercised

A running session serves its start-time text, so unless the user reloaded,
this pipeline's own review did not exercise what the sync wrote. When the
sync's `written` is non-empty (`notExercised` names the subset that can never
reach a running session: agent definitions and skill directories new to the
copy), upsert ONE idempotent `> [!NOTE]` block (edit in place, never stack)
listing those paths and pointing at `--skills-from`:

```bash
gh pr view "$PR" --json body --jq '.body' > "$WORKTREE/.flow-tmp/body.md"
jq -r '.written[], .notExercised[]' "$WORKTREE/.flow-tmp/skill-overlay-sync.json"
# upsert "> [!NOTE] Not exercised by this pipeline's own review: <paths>.
# Run flow feature create --skills-from <worktree> to exercise them." under
# ## Test Steps, then
flow-md-validate --fix-pr-body "$WORKTREE/.flow-tmp/body.md" && gh pr edit "$PR" --body-file "$WORKTREE/.flow-tmp/body.md"
```

Do not derive checkout paths by climbing out of `$SKILL_DIR` in examples or
prose: a copy has no `bin/`, so use PATH helpers.
