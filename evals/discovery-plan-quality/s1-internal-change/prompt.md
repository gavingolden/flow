Load the `flow-product-planning` skill with the Skill tool and run it with `WORKTREE=$REPO`. Write `.flow-tmp/plan.md` and `.flow-tmp/pr-description-draft.md`, then stop: do not implement anything and do not start any later pipeline phase.

User feature description (verbatim):
make the overdue check in todo-cli one shared helper: `list --overdue`, the `summary` command and the startup banner in `src/index.ts` each spell the same condition out by hand, so they can drift apart. Make them share a single definition and keep the behavior identical.
