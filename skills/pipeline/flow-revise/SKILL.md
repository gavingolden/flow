---
name: flow-revise
description: >-
  Record a redirection for a flow task paused at plan-pending-review and
  trigger a re-plan. Use ONLY when the user explicitly invokes
  `/flow-revise <id>` or says "redo the plan for `<id>` with X" /
  "rewrite the plan for `<id>`" with a task-id present. Do NOT
  auto-trigger on broad rewrite phrasing without a task-id.
argument-hint: '<task-id> [<redirection>]'
---

# Goal

The user reviewed a paused plan and wants to redirect the planner. In
the tmux-driven design the supervisor is a Claude Code session inside
a tmux window — the way to redirect is to type the redirection into
that window's input prompt. This skill captures the redirection in
chat (asking for it if the user didn't include one), confirms the
pipeline is at the checkpoint, and injects the redirection into the
supervisor's pane via `tmux send-keys`.

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
- The user wants to abort the task entirely → tell them to attach with
  `flow attach <id>` and type "cancel" / "abort" into the supervisor's
  chat. The supervisor handles the worktree teardown.
- The pipeline is not at `plan-pending-review` — confirm via
  `~/.flow/state/<id>.json` first. If the phase is anything else,
  surface the actual phase to the user and stop.

# Constraints / What NOT to do

- NEVER invoke without a concrete task-id. Ask once if missing.
- NEVER edit `~/.flow/state/<id>.json` from this skill — the state file
  is the supervisor's writer.
- NEVER paraphrase or summarise the user's redirection before
  injecting it. The planner reads what you send — verbatim beats
  helpful.
- NEVER inject when the phase is anything other than
  `plan-pending-review`. The keystrokes will land in the wrong context.

# Instructions

## 1. Confirm the task-id, the redirection text, and the phase

- If the user's message includes both a task-id and the redirection
  ("revise `<id>`: use the FRED quarterly endpoint"), proceed.
- If the message includes the task-id but not the redirection, ask:
  "What should the planner change? 1–3 sentences are enough." Use the
  user's reply verbatim.
- If the message includes neither, ask which task first, then the
  redirection.

Read the state file to confirm the pipeline is at the checkpoint:

```bash
cat ~/.flow/state/<id>.json
```

If `phase` is not `plan-pending-review`, tell the user the actual
phase and stop.

## 2. Inject the redirection into the supervisor's tmux pane

The tmux target is `flow:<slug>` — `<session>:<window>` syntax. Send
the redirection verbatim, then `Enter`:

```bash
tmux send-keys -t flow:<id> "<the user's redirection, verbatim>" Enter
```

If the redirection contains characters that need shell-quoting (double
quotes, backticks, dollar signs), pass it through as a single
argument with proper escaping — do not rewrite the prose itself.

## 3. Print a one-line confirmation

```
Redirection sent. Re-planning with the new notes.
Live-tail with `/flow-watch <id>` — the next plan-pending-review
checkpoint will fire when the new plan is ready.
```

# Verification

- The state file showed `phase: plan-pending-review` before injection.
- `tmux send-keys` exited 0.
- The redirection text passed to `send-keys` is verbatim user input,
  not a paraphrase.

# Constraints (repeat for emphasis)

- **You do not write the redirection for the user.** If they didn't
  give one, ask once and pass their reply verbatim.
- **You do not bypass the supervisor.** The supervisor owns the
  re-plan, the phase-log entry, and the next checkpoint; injecting into
  its chat is the supported revise path. Hand-editing state files
  produces a half-recorded transition and the planner never re-runs.
