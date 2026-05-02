---
name: flow-watch
description: >-
  Tail the active phase of a flow task in chat with output bounded so the
  assistant can spot-check progress without burning the chat-session token
  budget. Use when the user says "what's it doing?", "watch this task",
  "check on the run", "tail the phase", or invokes `/flow-watch`.
argument-hint: "[<task-id>] [--lines <n>]"
---

# Goal

Surface a bounded snapshot of a running flow pipeline's tmux pane in
chat. In the tmux-driven design the pipeline lives entirely in a tmux
window's scrollback; `tmux capture-pane` is the read-only surface for
spot-checking from outside the window.

The default bound is the last 200 lines of scrollback — enough to see
recent activity, small enough not to overrun the chat-session token
window.

# When to Use

- User asks "what's it doing right now?", "watch the implement phase",
  "tail the run", "check on task X".
- User explicitly invokes `/flow-watch` (with or without an id).
- A previous `/flow-watch` returned and the user asks to keep
  watching — re-invoke; do not raise the bound.

# When NOT to Use

- Use `flow attach <id>` from a terminal when you want a live,
  unbounded view of the supervisor's chat — `/flow-watch` is bounded
  for chat-token safety.
- Do not use this skill to write to or modify pipeline state — it is
  read-only.

# Context

- One tmux window per pipeline; the target is `flow:<slug>` in tmux
  syntax. The slug matches the pipeline name in `flow ls`.
- `tmux capture-pane -t flow:<slug> -p -S -<n>` prints the last `n`
  lines of the pane's scrollback to stdout. `-p` writes to stdout
  instead of a buffer; `-S -<n>` sets the start line `n` lines back
  from the bottom.
- Default-id resolution rules: if the user didn't pass an id, run
  `flow ls` and pick the most-recently-active pipeline. If multiple
  are tied, list them and ask the user to specify.

# Instructions

## 1. Resolve the id

- If `$ARGUMENTS` includes an id, use it.
- Otherwise run `flow ls` and pick the row with the smallest `LAST
  ACTIVITY` (most recent). If no pipelines are listed, tell the user
  there's nothing to watch and stop.

## 2. Capture the pane

```bash
tmux capture-pane -t flow:<id> -p -S -200
```

If the user passed `--lines <n>`, substitute that for `200`. Don't
raise above 500 lines from chat — re-invoke if they want more.

If the tmux target doesn't exist (`can't find window: <id>`), tell the
user the pipeline's window is gone (likely closed via `flow done`)
and surface `flow ls` so they can pick a live one.

## 3. Forward the output verbatim

Print the captured scrollback into chat as a fenced code block. Do
not truncate, re-summarise, or pretty-print — the bound is the
budget, not your editorial judgment.

If the scrollback shows the supervisor sitting at an empty input
prompt with no recent activity, note that the pipeline appears idle
and suggest the relevant next step (`/flow-status <id>` to confirm
the phase, or `flow attach <id>` to interact directly).

# Verification

- `tmux capture-pane` exited 0.
- The chat received the captured scrollback verbatim.
- No bound flag was raised above 500 lines from chat.

# Constraints

- NEVER raise the line bound above 500 from chat — re-invoke the
  command instead if the user wants more output.
- NEVER modify pipeline state, the state file, or the tmux window
  itself from this skill — it is strictly read-only.
- NEVER substitute `tmux attach` for `tmux capture-pane` from chat;
  attach is interactive and won't return.
- NEVER invent a task id when default-id resolution is ambiguous —
  surface `flow ls` to the user and ask them to pick.
