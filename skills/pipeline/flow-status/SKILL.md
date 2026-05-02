---
name: flow-status
description: >-
  Show the current state of every flow pipeline in this repo — what tasks are
  running, where each is stuck, and how much each has cost. Use when the user
  says "flow status", "what tasks are running", "pipeline status", "task cost",
  "what's stuck", or asks how a specific pipeline is doing.
argument-hint: "[<task-id>]"
---

# Goal

Show the user the current state of their flow pipelines. In the
tmux-driven design each pipeline is one tmux window; `flow ls` reads
`tmux list-windows` and the per-pipeline state files at
`~/.flow/state/<slug>.json`. This skill is a thin shell over `flow ls`
that adds an anomaly callout for pipelines that need human attention.

# When to Use

- "flow status", "what tasks are running", "what's stuck", "pipeline status"
- "how much did <task> cost", "task cost", "cost-to-date"
- The user just kicked off `flow new` and wants to know where the pipeline is now
- Any time the user references a task by id and wants a current snapshot

# When NOT to Use

- The user wants live-tailing of the pipeline's current activity → that's `/flow-watch`, not this
- The user wants to *change* state (approve a plan, redirect, abort) → those happen by typing into the supervisor's tmux window. See `/flow-approve` and `/flow-revise`.

# Context

- `flow ls` lists active pipelines as a table: `NAME PHASE PR LAST ACTIVITY`. It reads tmux directly, so a pipeline only shows up while its window exists.
- `flow ls --cost` adds a `$` column summed across the supervisor session and any spawned subskills. `flow ls --cost --detail` breaks the cost down per model.
- Per-pipeline state lives at `~/.flow/state/<slug>.json` — written by the supervisor via `flow-state-update` on each phase transition.
- This skill is read-only. Never invoke it as part of a chain that mutates pipeline state.

# Instructions

## 1. Run the CLI for the table

For the roster view:

```bash
flow ls
```

If the user asked about cost, add `--cost` (and `--detail` if they asked for the per-model breakdown):

```bash
flow ls --cost
flow ls --cost --detail
```

If the user asked about a specific id, run `flow ls` plus print that pipeline's state file so they see the absolute paths:

```bash
flow ls
cat ~/.flow/state/<id>.json
```

Insert the CLI's output verbatim into chat as a fenced code block. Do not re-format or trim columns.

## 2. Anomaly callouts

Walk the `flow ls` output. For each pipeline whose `PHASE` is one of `plan-pending-review`, `gated`, or `needs-human`, add a one-line callout below the table:

- **`plan-pending-review`** — the supervisor finished the plan and is waiting on the user. Print:

  ```
  ⏸ <id> waiting on plan review — `flow attach <id>` and type approval, or run `/flow-approve <id>`
  ```

- **`gated`** — the PR is open and waiting on review approval. Print:

  ```
  ⏸ <id> gated (PR open, waiting on review)
  ```

- **`needs-human`** — the supervisor escalated. Print:

  ```
  ⚠️ <id> needs human — `flow attach <id>` to read the escalation
  ```

If there are no anomalies, omit this section entirely — don't print "no anomalies" boilerplate.

# Verification

- The CLI output is reproduced exactly, with no truncation or column reflow.
- Every `plan-pending-review`/`gated`/`needs-human` row in the table has a corresponding callout below it.

# Constraints

- NEVER edit pipeline state, kick off phases, or invoke any other `flow` subcommand from this skill — it is strictly read-only.
- NEVER hand-parse `tmux list-windows` directly. Use `flow ls` so the renderer stays consistent.
- NEVER invent activity for a pipeline whose window is gone — `flow ls` is the authoritative roster.
