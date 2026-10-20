# PRD

**Goal:** add an optional `--tools` passthrough to the sanctioned headless
library so a caller can run its child with no tools at all.

## Tasks

1. `bin/lib/claude-headless.ts` — add `tools?: string` to `Args`, a
   `--tools` case to `parseArgs`, and a conditional append in
   `buildChildArgv`.
