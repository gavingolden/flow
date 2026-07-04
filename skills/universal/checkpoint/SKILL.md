---
name: checkpoint
description: >-
  Flush load-bearing conversational state — pending approval conditions or
  addenda, unmaterialized redirects, explicit in-chat decisions ("skip review",
  "ignore flake X") — to a durable on-disk artifact before a context clear, so
  it survives `/clear` and is re-injected on resume. Use when the user says
  "/checkpoint", "checkpoint this", "checkpoint", or "save state before I clear"
  inside a flow pipeline window.
---

# Goal

Preserve the small slice of pipeline state that lives **only in the
conversation** before the context is cleared. A `flow feature resume`
respawns a fresh (cleared) Claude Code process that reconstructs the
pipeline _step_ entirely from disk (`state.json`, `.flow-tmp/plan.md`,
the PR) — but it silently drops any instruction the supervisor was
holding only in chat: an "approved with condition X" addendum, a
mid-flight redirect ("ignore the flake on test Y", "skip the review,
ship it"), an explicit in-chat decision. This skill writes that
conversational residue to `<worktree>/.flow-tmp/checkpoint.md` so it is
re-injected after a `/clear`.

# When to use

- The user types `/checkpoint`, or says a natural-language `checkpoint
this` / `checkpoint` inside a flow pipeline window.
- The user wants to reset the supervisor's context mid-pipeline (drop a
  bloated transcript) without losing an in-chat instruction.

Do **not** use it outside a flow pipeline window, or on a terminal
pipeline — there is no in-flight work to resume, so `flow-checkpoint`
returns a `needs`/`noop` verdict and no marker is written.

# How it runs

This skill runs **in-process** via the `Skill` tool — the summarization
in step 1 is the supervisor's own LLM turn. It spawns **no** `Task` /
`Agent` sub-agent and **no** `claude -p` subprocess, and introduces **no**
new Task-tool exemption. The only non-LLM work is the `flow-checkpoint`
Bash helper, which validates and writes the marker.

It does **NOT** auto-run `/clear`. `/clear` is a user-typed harness
command with no tool/hook/SDK equivalent — Claude cannot invoke it. The
skill's job ends by telling the user it is safe to type `/clear`
themselves; a `SessionStart:clear` hook then auto-resumes the pipeline.

# Procedure

## 1. Summarize load-bearing conversational state to disk

Resolve the pipeline's worktree path (the `worktree` field of
`~/.flow/state/<slug>.json`; the slug comes from `$TMUX_PANE`'s
`@flow-slug` window option — in a live supervisor this is `$WORKTREE`).
Write a concise summary to `<worktree>/.flow-tmp/checkpoint.md`.

Capture **only** the load-bearing conversational state, NOT the full
transcript:

- Pending approval conditions / addenda — e.g. "approved, but also
  rename the flag to `--csv`".
- Unmaterialized redirects the supervisor has not yet acted on — e.g.
  "ignore the flake on `src/util/race.test.ts`", "skip the review".
- Explicit in-chat decisions that alter how a later step must behave.

Over-capturing defeats the token goal; under-capturing loses intent.
When an addendum is a **scope/plan change** (not an implementation
nuance), route it to a `plan.md` re-plan through the existing redirect
path instead — see `../../pipeline/flow-pipeline/references/redirect-handling.md`.
Only implementation-nuance addenda belong in `checkpoint.md`.

The file lives under `.flow-tmp/`, which `flow-new-worktree` already
excludes from the worktree, so it stays untracked — no ignore wiring
needed.

## 2. Validate + write the one-shot marker

Run the LLM-free helper (the slug auto-resolves from the pane):

```bash
flow-checkpoint
```

It confirms `state.json` is current and `checkpoint.md` is present +
non-empty, then emits one JSON object on stdout. Branch on `.status`:

- **`ready`** — the helper wrote the one-shot marker
  `<worktree>/.flow-tmp/checkpoint.pending` (the flag the
  `SessionStart:clear` auto-resume hook gates on). Proceed to step 3.
- **`needs`** — a precondition is unmet (`.reason` is `state-missing`,
  `no-worktree`, or `checkpoint-missing`). No marker was written. When
  the reason is `checkpoint-missing`, step 1 did not leave a non-empty
  `checkpoint.md` — re-do step 1, then re-run the helper. Otherwise the
  window is not a resumable flow pipeline; tell the user checkpointing
  is not available here and end.

## 3. Tell the user it is safe to `/clear`, then end the turn

On a `ready` verdict, surface a one-line nudge and end the turn:

```
✅ checkpointed — type /clear now to reset context (the pipeline auto-resumes and re-injects your notes), or keep going in this session.
```

Then stop. The marker is one-shot: on the next resume, Resume mode reads
`checkpoint.md`, folds its addenda into the re-entered step, and calls
`flow-checkpoint --consume` to delete the marker so a later unrelated
`/clear` in the same window does not re-fire the auto-resume.
