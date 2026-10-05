Load the `flow-product-planning` skill with the Skill tool and run it with `WORKTREE=$REPO`. A plan-pending-review redirect has arrived and a plan already exists at `.flow-tmp/plan.md`. The invocation carries these marker lines, exactly as `/flow-pipeline` threads them:

REVISION: 2
USER REDIRECT (received during plan-pending-review): also add a `--json` flag to `todo list` that prints the list, and any corruption error, as JSON

Update `.flow-tmp/plan.md` and `.flow-tmp/pr-description-draft.md` in place, then stop: do not implement anything and do not start any later pipeline phase.

User feature description (verbatim):
`todo list` shows an empty list when the todo file is corrupt instead of telling the user, and the next `todo add` overwrites the damaged file. Report the corruption and stop the overwrite.
