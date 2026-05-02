---
name: flow-approve
description: >-
  Clear a flow plan-pending-review checkpoint and resume the pipeline. Use
  ONLY when the user explicitly invokes `/flow-approve <id>` or says
  "approve the plan for `<id>`" / "looks good for `<id>`, go ahead" with
  a task-id present. Do NOT auto-trigger on broad approval phrasing
  ("approve", "looks good", "ship it") without a task-id — that hijacks
  unrelated chats.
argument-hint: '<task-id>'
---

# Goal

Resume a `feature`-intent flow pipeline that paused at the
`plan-pending-review` checkpoint. The user has already read the plan
(via `/flow-status <id>` or by attaching to the supervisor's tmux
window) and wants the pipeline to continue into the implement phase.

In the tmux-driven design the supervisor is a Claude Code session
inside a tmux window — the way to "approve" is to type a message into
that window's input prompt. This skill confirms the pipeline is at the
checkpoint, then injects the approval into the supervisor's pane via
`tmux send-keys` so the user doesn't have to attach manually.

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
- The user wants to abort the task entirely → tell them to attach with
  `flow attach <id>` and type "cancel" / "abort" into the supervisor's
  chat. The supervisor handles the worktree teardown.
- The pipeline is not at `plan-pending-review` — confirm via
  `~/.flow/state/<id>.json` before injecting anything. If the phase is
  anything else, surface the actual phase to the user and stop.

# Constraints / What NOT to do

- NEVER invoke this skill without a concrete task-id reference. If the
  user's message lacks one, ask which task before injecting.
- NEVER edit `~/.flow/state/<id>.json` from this skill. The state file
  is the supervisor's writer; any out-of-band write produces a stale
  phase that the supervisor will fight.
- NEVER inject when the phase is anything other than
  `plan-pending-review`. The supervisor is in the middle of work and
  the keystrokes will land in the wrong context.

# Instructions

## 1. Confirm the task-id and check the phase

If the user's message includes a task-id, use it. If not, ask once:
"Which task would you like to approve?"

Read the state file to confirm the pipeline is at the checkpoint:

```bash
cat ~/.flow/state/<id>.json
```

If `phase` is not `plan-pending-review`, tell the user the actual phase
and stop — do not inject. Common cases:

- `phase: implementing` — the user already approved (probably by
  attaching directly). Tell them the pipeline is past the checkpoint.
- `phase: planning` — the supervisor is still writing the plan. Tell
  them to wait for `plan-pending-review`.

## 2. Inject the approval into the supervisor's tmux pane

```bash
tmux send-keys -t flow:<id> "approved" Enter
```

The tmux target is `flow:<slug>` — `<session>:<window>` syntax, where
the slug is the pipeline name from `flow ls`.

## 3. Print a one-line confirmation

```
Approved. Pipeline resuming at implement.
Live-tail with `/flow-watch <id>` or attach with `flow attach <id>`.
```

# Verification

- The state file showed `phase: plan-pending-review` before injection.
- `tmux send-keys` exited 0.
- The follow-up sentence names `/flow-watch` and `flow attach`.

# Constraints (repeat for emphasis)

- **You do not write code in this skill.** Approve is a one-line
  injection; if the user wants implementation help, route them back to
  the pipeline (it's about to run) or to a separate session.
- **You do not bypass the supervisor.** The supervisor owns the
  phase-log entry, the notification dispatch, and the implement
  hand-off; injecting into its chat is the supported approval path.
  Hand-editing state files produces a half-recorded transition and the
  supervisor never picks the task up.
