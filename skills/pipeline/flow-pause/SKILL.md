---
name: flow-pause
description: >-
  Halt a running flow pipeline cleanly at the next phase boundary. Use ONLY
  when the user explicitly invokes `/flow-pause <id>` or says "pause the
  pipeline for `<id>`" / "stop `<id>` for now" with a task-id present. Do
  NOT auto-trigger on broad pause phrasing ("pause", "hold on", "stop")
  without a task-id — that hijacks unrelated chats.
argument-hint: '<task-id>'
---

# Goal

Drop a per-task `.pause` flag so the runner exits at the next phase
boundary with status `needs-human`, reason `user-paused`. The user
typically wants to refine `task.md`, switch machines, or take a break
without burning more implement / verify / CI tokens. This skill is a
thin shell over `flow pause <id>`; the CLI does the work.

# When to Use

- The user explicitly invokes `/flow-pause <id>`.
- The user says "pause the pipeline for `<id>`", "stop `<id>` for now",
  "hold `<id>` while I look at it" — anything that names a specific
  task and signals "stop work cleanly."

# When NOT to Use

- The user said "pause" / "stop" / "hold on" *without* a task id.
  Those phrases are common in non-flow contexts; ask which task before
  invoking.
- The user wants to *kill* a runaway runner immediately → that's an
  abort (`/flow-abort`) or a manual `kill <pid>`. Pause only fires at
  phase boundaries — worst-case latency is one phase's duration
  (notably `ci-wait`'s 20-min cap).
- The task is at `merged` / `aborted` / `needs-human` / or
  `plan-pending-review`. The CLI rejects each with a distinct error —
  surface the error verbatim instead of guessing at a recovery.

# Constraints / What NOT to do

- NEVER invoke this skill without a concrete task-id reference. If the
  user's message lacks one, ask which task before shelling out.
- NEVER call `Edit`, `Write`, or any task-file mutation directly from
  this skill. The CLI is the single writer for the pause flag and any
  Phase-log entries; bypassing it skips the runner's clean-exit
  guarantee.
- NEVER kill the runner pid as a "fast path" pause. SIGTERM records
  reason `signaled`, which conflates "user paused" with "process was
  killed." Use `flow abort` for the destructive path.

# Instructions

## 1. Confirm the task-id

The skill argument is `<task-id>`. If the user's message includes a
task-id (e.g. `2026-04-30-my-feature`), use it. If not, ask once:
"Which task would you like to pause?" — do not guess from the most
recent `/flow-status` output.

## 2. Shell out to the CLI

Invoke via `Bash`:

```bash
flow pause <id>
```

Forward the CLI's stdout verbatim into chat — it includes the pause
flag path and a one-line hint about whether the runner is currently
active. Do not paraphrase, summarise, or truncate.

## 3. Add a one-line follow-up

After the CLI output, print one short line pointing the user at the
next-step affordances:

```
Watch progress with `/flow-status <id>`; resume with `/flow-resume <id>`
when ready.
```

# Verification

- The CLI exited 0.
- The chat received the `paused <id>: pause flag dropped at <path>`
  line and the runner-active / no-runner hint.
- The follow-up sentence names `/flow-status` and `/flow-resume`.

# Constraints (repeat for emphasis)

- **You do not edit `task.md` from this skill.** The runner records the
  status transition itself when it sees the flag at the next phase
  boundary; pre-mutating the file breaks the worst-case-one-phase
  latency contract.
- **You do not bypass the CLI.** A hand-`touch`ed `.pause` works (the
  runner only checks existence) but skips the runner-active hint and
  the terminal-status / plan-pending-review refusals — the user loses
  the affordance.
