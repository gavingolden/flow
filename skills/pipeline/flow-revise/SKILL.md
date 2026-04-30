---
name: flow-revise
description: >-
  Record a redirection for a flow task paused at plan-pending-review and
  trigger a re-plan. Use ONLY when the user explicitly invokes
  `/flow-revise <id>` or says "redo the plan for `<id>` with X" /
  "rewrite the plan for `<id>`" with a task-id present. Do NOT
  auto-trigger on broad rewrite phrasing without a task-id.
argument-hint: '<task-id> [--message "<redirection>"] [--no-resume]'
---

# Goal

The user reviewed a paused plan and wants to redirect the planner. This
skill captures the redirection in chat (asking for it if the user didn't
include one), shells out to `flow revise <id> --message "<text>"`, and
re-spawns the pipeline so the plan phase re-runs with the redirection
threaded into the prompt under a dedicated `REVISION NOTES:` block. The
existing failure-log slot is untouched — revision and failure are
distinct semantics.

# When to Use

- The user explicitly invokes `/flow-revise <id>`.
- The user says "redo the plan for `<id>` with X", "rewrite the plan for
  `<id>`, focus on Y instead", "the plan for `<id>` missed Z, please
  revise" — anything that names a specific task and signals "the plan
  needs to change before I'll let it implement."

# When NOT to Use

- The user said "revise" / "rewrite" / "redo" *without* a task id.
- The user is happy with the plan and just wants to continue → that's
  `/flow-approve`, not this skill.
- The user wants to abort the task entirely → `/flow-abort` (PR 16,
  when shipped). Do not implement abort behaviour here.
- The task is not at `plan-pending-review`. The CLI rejects with a
  non-zero exit; surface the error verbatim.

# Constraints / What NOT to do

- NEVER invoke without a concrete task-id. Ask once if missing.
- NEVER call `Edit`, `MultiEdit`, `NotebookEdit`, or `Write` against
  `task.md` from this skill. The CLI is the single writer; it owns the
  `## Revision notes` append, the status transition, the Phase-log
  entry, and the detached re-spawn.
- NEVER paraphrase or summarise the user's redirection before passing
  it to `--message`. The planner will read what you pass — verbatim
  beats helpful.
- NEVER retry with a different `--message` if the CLI rejects the
  invocation. Surface the stderr and stop.

# Instructions

## 1. Confirm the task-id and the redirection text

The skill argument is `<task-id> [--message "<redirection>"]
[--no-resume]`.

- If the user's message includes both a task-id and the redirection
  ("revise `<id>`: use the FRED quarterly endpoint"), proceed to
  step 2.
- If the message includes the task-id but not the redirection, ask: "What
  should the planner change? 1–3 sentences are enough." Use the
  user's reply verbatim as `--message`.
- If the message includes neither, ask which task first, then the
  redirection.

If the user explicitly said "revise but don't resume yet" (rare —
mostly for staged debugging), pass `--no-resume`.

## 2. Shell out to the CLI

Invoke via `Bash`. Pass the redirection verbatim — do not rewrite,
shorten, or "improve" it:

```bash
flow revise <id> --message "<the user's redirection, verbatim>"
# or, with --no-resume:
flow revise <id> --message "<text>" --no-resume
```

Forward the CLI's stdout verbatim into chat. The CLI prints a
confirmation line, then (default) the detached-spawn lines (`flow run
<id> detached as pid <N>` + `log → <path>`).

## 3. Add a one-line follow-up

After the CLI output, print one short line confirming the plan phase
will re-run with the new notes and pointing the user at the watch
affordance:

```
Re-planning with the new redirection. Live-tail with `/flow-watch <id>`
— the next plan-pending-review checkpoint will fire when the new plan
is ready.
```

For `--no-resume`, point the user at `flow run <id>` instead:

```
Revision recorded. Run `flow run <id>` (or detach with `flow run <id>
--detach`) when you're ready to re-plan.
```

# Verification

- The CLI exited 0.
- The chat received the CLI's confirmation line (`revised <id>: …`) and
  (unless `--no-resume`) the detached-spawn lines.
- The follow-up sentence names `/flow-watch` (or `flow run` for the
  `--no-resume` path).

# Constraints (repeat for emphasis)

- **You do not write the redirection for the user.** If they didn't
  give one, ask once and pass their reply verbatim.
- **You do not bypass the CLI.** The `## Revision notes` append, the
  status transition, the Phase-log entry, and the detached re-spawn all
  happen inside `flow revise`; hand-editing `task.md` produces a
  half-recorded transition and the planner never re-runs.
