---
name: flow-status
description: >-
  Show the current state of every flow pipeline in this repo — what tasks are
  running, where each is stuck, and how much each has cost. Use when the user
  says "flow status", "what tasks are running", "pipeline status", "task cost",
  "what's stuck", or asks how a specific pipeline is doing.
argument-hint: "[<task-id>] [--all]"
---

# Goal

Show the user the current state of their flow pipelines — which tasks are active, where each is in the pipeline, whether any are stuck, and how much each has cost so far. Render the CLI's table inline in chat, then add a one-line quantitative summary plus an anomaly callout for any task that needs human attention.

# When to Use

- "flow status", "what tasks are running", "what's stuck", "pipeline status"
- "how much did <task> cost", "task cost", "cost-to-date"
- The user just kicked off `flow run --detach` and wants to know where the headless pipeline is now
- Any time the user references a task by id and wants a current snapshot

# When NOT to Use

- The user wants live-tailing or `--follow`-style streaming → that's `/flow watch` (PR 11), not this
- The user wants to read raw jsonl logs → that's `flow log --raw`
- The user wants to *change* state (approve, abort, retry) → those are the dedicated mutation skills

# Context

- The CLI lives at `flow status` — installed on `PATH` via `npm link` or a release install.
- Default scope is **active** tasks only (`.orchestrator/tasks/*.md`). Pass `--all` to also include archived tasks under `.orchestrator/tasks/archive/`.
- `flow status <id>` drills into one task — frontmatter pointers, phase log, per-phase cost block. The `<id>` lookup resolves in both the active and archive directories, so this still works after a task is archived.
- Cost is summed from each task's `<taskDir>/logs/*.jsonl`. Phases that ran more than once (verify retries, review→implement loop-backs) sum across all attempts; the drill-down annotates `(N attempts)` when N > 1.
- This skill is read-only. Never invoke it as part of a chain that mutates task state.

# Instructions

## 1. Run the CLI for the table

If the user asked about a specific task id:

```bash
flow status <id>
```

Otherwise (the default — roster view):

```bash
flow status
```

If the user asked about archived/merged tasks too, add `--all`:

```bash
flow status --all
```

Insert the CLI's output verbatim into the chat as a fenced code block. Do not re-format or trim columns — the renderer already aligns them.

## 2. Pull structured data for the narrative summary

Run the same command with `--json` (passing the same `<id>` and/or `--all` if used above) and parse the output. Use it to compute:

- **N active**: number of tasks in the result whose status is not in `{merged, aborted}`.
- **M need-human**: number of tasks whose status is `needs-human`.
- **K gated**: number of tasks whose status is `gated`.

Print one line:

```
Summary: N active, M need-human, K gated
```

## 3. Anomaly callouts

For each task whose status is `needs-human` or `gated`, print one line:

```
⚠️ <id> needs human: <reason>
```

The `<reason>` comes from the most recent line in the task's `## Phase log` that mentions the transition into `needs-human` (e.g. `verifying → needs-human (timed out)` → reason is `timed out`). If no parenthesized reason is present, omit the colon and trailing reason.

If there are no anomalies, omit this section entirely — don't print "no anomalies" boilerplate.

## 4. For the `<id>` form

Skip step 2 and step 3 — the drill-down already shows the per-task detail. Just print the CLI output verbatim.

# Verification

- The CLI output is reproduced exactly, with no truncation or column reflow.
- The summary line matches the `--json` output's task counts.
- Every `needs-human`/`gated` task in the table has a corresponding `⚠️` line below the summary.

# Constraints

- NEVER edit task files, kick off phases, or invoke any other `flow` subcommand from this skill — it is strictly read-only.
- NEVER re-parse `.orchestrator/tasks/*.md` directly. Use `flow status --json` so the cost computation and phase-label derivation stay consistent with the CLI.
- NEVER fall back to `cat`-ing log files when `flow status` itself fails — surface the error to the user instead.
