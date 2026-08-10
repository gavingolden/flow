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

Spawn verifier subagents in **waves of at most 6 Task calls per message**
(parallel fan-out within a wave, sequential across waves — a Task
fan-out has no separate "concurrent pool" primitive; concurrency IS the
count of Task calls in one message, so the wave size below is also the
in-flight cap). Use `subagent_type: $BACKLOG_VERIFIER_SUBAGENT` (resolved
below via a single plugin-root probe — the plugin-qualified
`flow-module-core:flow-backlog-verifier` name, or the inline-verification
degrade path when the probe misses; there is no bare-name fallback) for
every spawn.

**Batch, never one-subagent-per-item.** Group items into batches sized
`ceil(total_items / 6)`, clamped to 15–30 items per batch — e.g. a
~190-item backlog gives `ceil(190/6) = 32`, clamped down to 30, so 7
batches (six of 30 plus a remainder of 10), spawned as one wave of 6 plus
a second wave of 1. Both cross-model reviewers who checked this
design flagged one-subagent-per-item independently against a ~190-item
backlog — it would spawn far too many concurrent subagents for the item
count involved. Batching amortizes each subagent's fixed spawn/context
cost across many items while still giving each subagent a small enough
slice to verify carefully. Wait for a wave's batches to all return before
spawning the next wave.

Each subagent receives its batch's item refs plus the claim text for each
item, and returns the five-verdict envelope (CONFIRMED / ALREADY DONE /
STALE-PARTIAL / NOT REPRODUCIBLE IN CODE / UNVERIFIABLE) per item, each
citing `file:line`, a PR/commit, or a run id as evidence. It also reports
any shared root cause it noticed across items in its own batch — cross-
batch root-cause links are then reconciled by the parent session once all
batches return.

## Degrade path — inline sequential verification

Resolve `$BACKLOG_VERIFIER_SUBAGENT` via a single plugin-root probe (no
`general-purpose` tier at this site — see below). Plugin-hosted agents are
addressable ONLY by the plugin-qualified name
`<pluginRootName>:<agentBasename>` — a bare `flow-backlog-verifier`
subagent_type fails Task-tool resolution outright (measured: "Agent type
'flow-scout' not found"):

```bash
BACKLOG_VERIFIER_SUBAGENT=""
if [ -f ~/.flow/claude-home/.claude/skills/flow-module-core/agents/flow-backlog-verifier.md ]; then
  BACKLOG_VERIFIER_SUBAGENT=flow-module-core:flow-backlog-verifier
fi
```

The probe checks the **installed-agent path**, not a repo-relative
source path. This skill runs in arbitrary consumer repos whose cwd is
never the flow checkout, so a cwd-relative `agents/flow-backlog-verifier.md`
check is never true there and would degrade unconditionally; the
installed-agent probe is the same shape every other flow spawn site uses
to detect an optional module.

When the probe misses (empty `$BACKLOG_VERIFIER_SUBAGENT` — a bare
`flow install` without this module, or a stripped-down consumer
checkout), do **not** fall back to flow's usual
write-capable catch-all subagent type. That fallback is write-capable,
and falling back to it would silently violate the read-only constraint
at exactly the moment the constraint matters most — during unsupervised
verification of claims that will drive automated issue closures.
Instead, degrade to **inline sequential verification**: the skill itself
walks each batch's items directly (Bash/Read/Grep/Glob, same read-only
discipline), without spawning any subagent at all.

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
