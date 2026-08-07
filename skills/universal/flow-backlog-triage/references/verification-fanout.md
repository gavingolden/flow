# Phase-1 verification fan-out

The Phase-1 verification step of `/flow-backlog-triage` fans out parallel
**read-only** subagents to check backlog claims against code, merged PRs,
CI/workflow runs, and live state. This document is the spawn contract.

## Load the Task tool first

Before spawning, load the Task tool's schema:

```
ToolSearch query="select:Task"
```

## Spawn shape

Spawn all verifier subagents **in one message** (parallel fan-out, not a
sequential loop). Use `subagent_type: flow-backlog-verifier` for every
spawn.

**Batch, never one-subagent-per-item.** Group items into batches of
roughly 15–20 items per subagent, with a bounded concurrent pool (default
6 in flight). Both cross-model reviewers who checked this design flagged
one-subagent-per-item independently against a ~190-item backlog — it
would spawn far too many concurrent subagents for the item count involved.
Batching amortizes each subagent's fixed spawn/context cost across many
items while still giving each subagent a small enough slice to verify
carefully.

Each subagent receives its batch's item refs plus the claim text for each
item, and returns the five-verdict envelope (CONFIRMED / ALREADY DONE /
STALE-PARTIAL / NOT REPRODUCIBLE IN CODE / UNVERIFIABLE) per item, each
citing `file:line`, a PR/commit, or a run id as evidence. It also reports
any shared root cause it noticed across items in its own batch — cross-
batch root-cause links are then reconciled by the parent session once all
batches return.

## Degrade path — inline sequential verification

When `agents/flow-backlog-verifier.md` is not installed (a bare `flow
install` without this module, or a stripped-down consumer checkout), do
**not** fall back to flow's usual write-capable catch-all subagent type.
That fallback is write-capable, and falling back to it would silently
violate the read-only constraint at exactly the moment the constraint
matters most — during unsupervised verification of claims that will
drive automated issue closures. Instead, degrade to **inline sequential
verification**: the skill itself walks each batch's items directly
(Bash/Read/Grep/Glob, same read-only discipline), without spawning any
subagent at all.

## Read-only contract

Verifier subagents are read-only. They never run `gh issue close`, `gh
issue comment`, `gh issue edit`, `git commit`, `git push`, `rm`, or any
other mutating command, and they never write files. The **parent
session** — never a verifier subagent — performs any issue mutation
(evidence comments, rescope comments, close calls) in Phase 4.

## Invoke helpers by bare PATH name

Every helper this fan-out or its degrade path shells out to is invoked by
its bare PATH name (e.g. `gh`, `git`) — never a repo-relative `bun
bin/...` path. This skill runs in arbitrary consumer repos whose cwd is
never the flow checkout.
