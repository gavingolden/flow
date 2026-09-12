Load the `flow-pipeline` skill. Execute ONLY Step 5's PR-open block, up to
and including composing `.flow-tmp/pr-body.md` from the draft at
`.flow-tmp/pr-description-draft.md`, and running the PR-body explanation
judge exactly as that block instructs (rewrite once on a `rewrite` verdict,
re-judge once, then proceed regardless of the second verdict). Do NOT run
`flow-open-pr` and do NOT call `flow-state-update`. Reference the block by
its heading, never by line number.

`FLOW_SLUG` is already set in the environment — do not try to resolve the
slug from tmux; there is no `TMUX_PANE` in this eval run.

When you are done, end your turn by printing the final `## Why` and
`## User-facing changes` sections of `.flow-tmp/pr-body.md` verbatim, and
nothing else after them.
