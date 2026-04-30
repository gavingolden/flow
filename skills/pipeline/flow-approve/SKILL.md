---
name: flow-approve
description: >-
  Clear a flow plan-pending-review checkpoint and resume the pipeline. Use
  ONLY when the user explicitly invokes `/flow-approve <id>` or says
  "approve the plan for `<id>`" / "looks good for `<id>`, go ahead" with
  a task-id present. Do NOT auto-trigger on broad approval phrasing
  ("approve", "looks good", "ship it") without a task-id — that hijacks
  unrelated chats.
argument-hint: '<task-id> [--no-resume]'
---

# Goal

Resume a `feature`-intent flow pipeline that paused at the
`plan-pending-review` checkpoint. The user has already read the PRD (via
`/flow-status <id>` or by opening the plan dir) and wants the pipeline
to continue into the implement phase. This skill is a thin shell over
`flow approve <id>`; the CLI does the file mutation, prints a compact
PRD summary as positive confirmation, and re-spawns the pipeline as a
detached process tree.

# When to Use

- The user explicitly invokes `/flow-approve <id>`.
- The user says "approve the plan for `<id>`", "looks good for `<id>`,
  go ahead", "ship the plan for `<id>`" — anything that names a specific
  task and signals "I've read the plan, continue."

# When NOT to Use

- The user said "approve" / "looks good" / "ship it" *without* a task
  id. Those phrases occur constantly in non-flow contexts (PR reviews,
  design discussions). Hijacking them would be worse than missing an
  offer — ask which task before invoking.
- The user wants to *change* the plan before resuming → that's
  `/flow-revise`, not this skill.
- The user wants to abort the task entirely → that's `/flow-abort`
  (PR 16, when shipped); for now, suggest the user edit `task.md`
  manually or wait for that skill.
- The task is not at `plan-pending-review`. The CLI rejects the call
  with a non-zero exit — surface the error verbatim instead of guessing
  at a recovery.

# Constraints / What NOT to do

- NEVER invoke this skill without a concrete task-id reference. If the
  user's message lacks one, ask which task before shelling out.
- NEVER call `Edit`, `MultiEdit`, `NotebookEdit`, or `Write` against
  `task.md` from this skill. The CLI is the single writer; bypassing it
  skips the Phase-log entry, the notification dispatch, and the
  detached re-spawn.
- NEVER second-guess the CLI's exit code. If `flow approve` exits
  non-zero, print stderr verbatim and stop — don't retry with different
  flags.

# Instructions

## 1. Confirm the task-id

The skill argument is `<task-id> [--no-resume]`. If the user's message
includes a task-id (e.g. `2026-04-30-portfolio-chart`), use it. If not,
ask once: "Which task would you like to approve?" — do not guess from
the most recent `/flow-status` output.

If the user explicitly said "approve but don't resume yet" (rare —
mostly for staged debugging), pass `--no-resume`.

## 2. Shell out to the CLI

Invoke via `Bash`:

```bash
flow approve <id>
# or, with --no-resume:
flow approve <id> --no-resume
```

Forward the CLI's stdout verbatim into chat — it includes the compact
PRD summary (first ~10 lines of `prd.md`) and the detached-spawn lines
(`flow run <id> detached as pid <N>` + `log → <path>`). Do not
paraphrase, summarise, or truncate.

## 3. Add a one-line follow-up

After the CLI output, print one short line confirming the pipeline is
resuming and pointing the user at the watch / status affordances:

```
Pipeline resuming at implement. Track progress with `/flow-status <id>`
or live-tail with `/flow-watch <id>`.
```

For `--no-resume`, point the user at `flow run <id>` instead:

```
Pipeline transition recorded. Run `flow run <id>` (or detach with
`flow run <id> --detach`) when you're ready to start implement.
```

# Verification

- The CLI exited 0.
- The chat received the PRD summary block (or the generic "approved"
  fallback if `prd.md` was missing) and the detached-spawn lines.
- The follow-up sentence names `/flow-status` and `/flow-watch` (or
  `flow run` for the `--no-resume` path).

# Constraints (repeat for emphasis)

- **You do not write code in this skill.** Approve is a one-line CLI
  call; if the user wants implementation help, route them back to the
  pipeline (it's about to run) or to a separate session.
- **You do not bypass the CLI.** The Phase-log entry, notification
  dispatch, and detached re-spawn all happen inside `flow approve`;
  hand-editing `task.md` produces a half-recorded transition and the
  pipeline never picks the task up.
