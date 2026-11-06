Load the `flow-product-planning` skill with the Skill tool and run it with `WORKTREE=$REPO`. Write `.flow-tmp/plan.md` and `.flow-tmp/pr-description-draft.md`, then stop: do not implement anything and do not start any later pipeline phase.

User feature description (verbatim):
`GET /reports/:id/summary` calls the model every time someone opens a report, and popular reports are opened hundreds of times a day. Make it cheaper.
