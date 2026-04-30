---
name: flow-resume
description: >-
  Resume a paused flow pipeline by clearing the `.pause` flag, restoring
  the task to its pre-pause status, and re-spawning `flow run --detach`.
  Use ONLY when the user explicitly invokes `/flow-resume <id>` or says
  "resume the pipeline for `<id>`" / "continue `<id>`" with a task-id
  present. Do NOT auto-trigger on broad resume phrasing ("resume",
  "continue", "go") without a task-id — that hijacks unrelated chats.
argument-hint: '<task-id> [--no-resume]'
---

# Goal

Pick a paused task back up. Clears `.orchestrator/tasks/<id>/.pause`,
restores status from the `paused_from` frontmatter field, clears
`paused_from`, and re-spawns the pipeline detached so the runner picks
up at the right next phase. This skill is a thin shell over `flow
resume <id>`; the CLI does the work.

# When to Use

- The user explicitly invokes `/flow-resume <id>`.
- The user says "resume `<id>`", "continue `<id>`", "let `<id>` keep
  going" — anything that names a specific task and signals "pick this
  back up."

# When NOT to Use

- The user said "resume" / "continue" / "go" *without* a task id.
  Those phrases occur constantly in non-flow contexts; ask which task
  before invoking.
- The task is at `plan-pending-review` — that's a checkpoint paused by
  the pipeline itself, not by `flow pause`. Use `/flow-approve` or
  `/flow-revise`. The CLI rejects with the explicit redirect message.
- The task is at `needs-human` for a reason other than user-pause
  (e.g. CI exhaustion, gh-error, review-cycles-exhausted). The CLI
  rejects with `task is at needs-human but not paused via flow pause`.
  Surface the error verbatim and let the user fix the underlying issue.
- The task is already running (status not `needs-human`). The CLI
  rejects with `task is not paused (current status: <status>)`.

# Constraints / What NOT to do

- NEVER invoke this skill without a concrete task-id reference. If the
  user's message lacks one, ask which task before shelling out.
- NEVER hand-edit `task.md` to clear `paused_from` or change status.
  The CLI is the single writer; bypassing it skips the Phase-log
  entry, the notification dispatch, and the detached re-spawn.
- NEVER call `flow run <id>` directly as a "fast path" resume. Without
  the status restore step, the runner sees `needs-human` and bails
  immediately.

# Instructions

## 1. Confirm the task-id

The skill argument is `<task-id> [--no-resume]`. If the user's message
includes a task-id (e.g. `2026-04-30-my-feature`), use it. If not,
ask once: "Which task would you like to resume?" — do not guess from
the most recent `/flow-status` output.

If the user explicitly said "resume but don't spawn yet" (rare —
mostly for staged debugging), pass `--no-resume`.

## 2. Shell out to the CLI

Invoke via `Bash`:

```bash
flow resume <id>
# or, with --no-resume:
flow resume <id> --no-resume
```

Forward the CLI's stdout verbatim into chat — it includes the
`resumed <id>: status now <restored-status>` line and the
detached-spawn lines (`flow run <id> detached as pid <N>` + `log →
<path>`). Do not paraphrase, summarise, or truncate.

## 3. Add a one-line follow-up

After the CLI output, print one short line pointing the user at the
watch / status affordances:

```
Pipeline resuming. Track progress with `/flow-status <id>` or
live-tail with `/flow-watch <id>`.
```

For `--no-resume`, point the user at `flow run <id>` instead:

```
Status restored. Run `flow run <id>` (or detach with `flow run <id>
--detach`) when you're ready to start the pipeline.
```

# Verification

- The CLI exited 0.
- The chat received the `resumed <id>: status now <status>` line and
  (without `--no-resume`) the detached-spawn lines.
- The follow-up sentence names `/flow-status` and `/flow-watch` (or
  `flow run` for the `--no-resume` path).

# Constraints (repeat for emphasis)

- **You do not write code in this skill.** Resume is a one-line CLI
  call; the pipeline is about to do the work.
- **You do not bypass the CLI.** The Phase-log entry, the
  paused_from clear, and the detached re-spawn all happen inside
  `flow resume`; hand-editing `task.md` produces a half-recorded
  transition and the runner may pick the wrong next phase.
