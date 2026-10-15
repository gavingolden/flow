Load the `flow-pipeline` skill and run it as a hand-run `/flow-pipeline` invocation: there is no `REQUEST_FILE`, and the inline description below IS the request.

Request: "How does `parseDuration` in `src/duration.ts` work?"

`FLOW_SLUG` is already set in your environment — use it as the pipeline slug (this run has no tmux). Drive the pipeline from its first step until it ends on its own; this request changes nothing, so there is no worktree, plan or PR to create. When it ends, emit the structured verdict with the `phase` you wrote and end the turn.
