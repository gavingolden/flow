---
name: flow-watch
description: >-
  Tail the active phase of a flow task in chat with output bounded to ~30s or
  ~50 events so the assistant can spot-check progress without burning the
  chat-session token budget. Use when the user says "what's it doing?",
  "watch this task", "check on the run", "tail the phase", or invokes
  `/flow-watch`.
argument-hint: "[id] [--phase <name>] [--seconds <n>] [--events <n>]"
---

# Goal

Surface a bounded snapshot of a running flow task's active phase in chat. The
wrapper enforces a wall-clock budget (default 30s) and an event cap (default
50) so output never overruns the chat-session token window.

# When to Use

- User asks "what's it doing right now?", "watch the implement phase",
  "tail the run", "check on task X".
- User explicitly invokes `/flow-watch` (with or without an id).
- A previous `/flow-watch` returned a `(stopped after …)` footer and the user
  asks to keep watching — re-invoke; do not raise the bounds.

# When NOT to Use

- Use `flow log <id> --follow` from a terminal when you want unbounded
  tailing — `/flow-watch` is bounded for chat-token safety.
- Use `flow log <id>` (no `--follow`) when you want the full historical log
  of a finished phase rendered in one go from the terminal.
- Do not use this skill to write to or modify task state — it is read-only.

# Context

- The skill shells out to `./scripts/flow-watch.ts`, a Bun wrapper around
  `flow log` (PR 6) installed by `flow install`.
- All bound logic lives in the script. Treat the SKILL.md as a thin shell.
- Default-id resolution rules:
  - exactly one non-terminal task → the wrapper picks it and prints
    `(resolved id: <id>)`.
  - multiple non-terminal tasks → the wrapper lists them and exits non-zero;
    re-prompt the user to specify an id.
  - zero non-terminal tasks → the wrapper falls back to the most-recently
    updated task and tails its last events without `--follow`.
- Terminal-status tasks (`merged`, `aborted`, `needs-human`) are tailed
  finitely without `--follow`; the wrapper exits cleanly.
- Unknown ids → the wrapper prints available ids and exits non-zero.
- **Runtime:** if the project ships `scripts/` with `#!/usr/bin/env bun`, the
  wrapper runs under Bun. Do not substitute `node`, `npx tsx`, or other Node
  runtimes.

# Instructions

## 1. Run the watch wrapper

```bash
./scripts/flow-watch.ts $ARGUMENTS
```

If `$ARGUMENTS` is empty the wrapper auto-resolves the id (see Context). Pass
`--phase <name>` to spot-check a non-active phase; pass `--seconds <n>` or
`--events <n>` only when the user explicitly asks for a different bound.

## 2. Forward the wrapper's output verbatim

- Print the wrapper's stdout into the chat as-is, including the leading
  `Tailing …` banner and any resolution notices (`(resolved id: …)`,
  `(no active task — …)`, `(task <id> is <status> — …)`).
- The trailing `(stopped after …)` or `(log stream ended)` footer is the
  signal to the user that output ended; surface it visibly.
- Do **not** truncate, re-summarise, or pretty-print the events — the wrapper
  has already bounded the output for chat-token safety.

## 3. Interpret the exit code

- `0` — the wrapper streamed within bounds. Done.
- non-zero — usually means an unknown id, ambiguous default-id resolution,
  or a usage error on the bound flags. The stderr message names the cause:
  ask the user to specify the right id (or fix the flag) and re-invoke.

## 4. Handle the `(stopped after …)` footer

- If the user wants more output, re-invoke the same command. **Do not** bump
  `--seconds` or `--events` past the defaults from chat — re-invoking is the
  intended UX and avoids one-shot context overflows.

# Verification

- The wrapper exited 0.
- The chat received the wrapper's full stdout, including the trailing footer.
- No bound flags were raised above the script's defaults from chat.

# Constraints

- NEVER raise the bound past the script's defaults in chat — re-invoke the
  command instead if the user wants more output.
- NEVER modify the task file, jsonl logs, or any other on-disk state from
  this skill — it is strictly read-only.
- NEVER substitute `flow log <id> --follow` directly when running from chat;
  the unbounded variant defeats the purpose of this skill.
- NEVER invent a task id when default-id resolution is ambiguous — surface
  the wrapper's list to the user and ask them to pick.
