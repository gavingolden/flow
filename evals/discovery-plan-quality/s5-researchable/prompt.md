Load the `flow-product-planning` skill with the Skill tool and run it with `WORKTREE=$REPO`. Write `.flow-tmp/plan.md` and `.flow-tmp/pr-description-draft.md`, then stop: do not implement anything and do not start any later pipeline phase.

User feature description (verbatim):
add a `todo sync` command that mirrors each todo to a GitHub issue through the REST API in `src/github.ts`, and make it survive GitHub's secondary rate limits. Check GitHub's current documentation for how secondary limits are signalled and what retry and backoff behavior they require, rather than guessing.
