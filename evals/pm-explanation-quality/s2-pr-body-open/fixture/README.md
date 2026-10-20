# fixture

A minimal checkout used to materialize `pm-explanation-quality`'s
`s2-pr-body-open` scenario. Two of its four files are load-bearing:
`flow-tmp/pr-description-draft.md` (the draft the supervisor composes the PR
body from) and `.flow/product.md` (the product brief the judge's prompt
weighs the body against) are both read by the pipeline supervisor during the
run, not just checked out as inert scaffolding.
