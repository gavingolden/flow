---
name: flow-checkpoint
description: >-
  Flush load-bearing conversational state — pending approval conditions or
  addenda, unmaterialized redirects, explicit in-chat decisions ("skip review",
  "ignore flake X") — to a durable on-disk artifact before a context clear, so
  it survives `/clear` and is re-injected on resume. Use when the user says
  "/flow-checkpoint", "flow-checkpoint this", or "save state before I clear"
  inside any flow supervisor window — a feature pipeline (`flow feature
  create`), an epic-design window (`flow epic create`), or an epic-run
  window (`flow epic run`).
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
conversational residue to `~/.flow/state/checkpoints/<slug>/checkpoint.md`
so it is re-injected after a `/clear`. Depending on the pipeline kind, the resumed
session may be `/flow-pipeline`, `/flow-epic-create`, or the
`/flow-epic-run` playbook — the resumed skill is picked by the window's
kind, not always `/flow-pipeline`.

# When to use

- The user types `/flow-checkpoint`, or says a natural-language `checkpoint
this` / `checkpoint` inside a flow pipeline window.
- The user wants to reset the supervisor's context mid-pipeline (drop a
  bloated transcript) without losing an in-chat instruction.
- Epic-design windows (`flow epic create`) are a supported context too —
  phases `epic-designing`, `epic-validating`, `epic-pr-open`, and
  `epic-design-pending-review` all checkpoint and auto-resume like a
  feature pipeline. `epic-approved` is terminal for the design supervisor,
  so `/clear` there carries the notes over but does not auto-resume (an
  `epic-run` window at the same phase is a separate case — see the gate
  note below).

The helper (`bin/flow-checkpoint.ts`) gates **only** on (`state.json`
present, a non-empty body at the resolved location) and is
**phase-independent** — it writes the marker at any phase, including a
terminal one. There is no worktree precondition: the checkpoint lives at
`~/.flow/state/checkpoints/<slug>/`, keyed by slug alone, so it neither
needs a worktree nor dies with one. That also means `/flow-checkpoint`
works at `starting` / `triaging`, before a worktree exists, and at
`merged` / `cancelled`, after the worktree is gone.

At a terminal phase, a `/clear` **carries the checkpoint over**: the
`SessionStart:clear` hook emits the body as passive context in the fresh
session and retires it one-shot. What it does not do there is _resume the
pipeline_ — a terminal pipeline has nothing left to resume (`gated` and
an `epic-run` window are the exceptions that do auto-resume). So your
notes always survive the clear; only the auto-resume is phase-dependent.
Step 2 below surfaces a warning when the pipeline will not auto-resume,
so you know which of the two you are getting.

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

Resolve the write target with `CHECKPOINT_PATH=$(flow-checkpoint --path)`
— it derives the slug-keyed location, prints it, and does nothing else
(no marker is armed, so it is safe to call at any time). Write a concise
summary to `$CHECKPOINT_PATH`.

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

The file lives under `~/.flow/state/checkpoints/<slug>/`, outside any git
worktree, so it is never a tracked file and never dies with a worktree —
no ignore wiring needed.

## 2. Validate + write the one-shot marker

Run the LLM-free helper (the slug auto-resolves from the pane):

```bash
flow-checkpoint
```

The bare call above keeps no `--site` flag, so it defaults to
`--site manual` — this is what makes the note you just wrote outrank
every pipeline auto-checkpoint (plan-review, plan-approval, gate) until
the pipeline itself changes phase: a manual note's freshness is judged
against `state.phaseLog`, and it reads as fresh for as long as no phase
transition has happened since you armed it. Once the pipeline advances,
the current phase's own auto-checkpoint takes back over — your
superseded note is never silently lost, it stays recoverable as
`checkpoint.consumed.md` beside the body after the next `--consume`
(see step 3).

It confirms `state.json` is current and the body is present +
non-empty, then emits one JSON object on stdout. Branch on `.status`:

- **`ready`** — the helper wrote the one-shot marker
  `checkpoint.pending` beside the body (the flag the
  `SessionStart:clear` auto-resume hook gates on) and recorded the
  freshness receipt (`site: manual`) that gives your note precedence
  over auto-checkpoints while it stays fresh. When the JSON also
  carries a non-empty `.warning` (a terminal phase that will not
  auto-resume — the `gated` and `epic-run` carve-outs never carry one),
  hold onto it for step 3: it does **not** change the branch, `ready` +
  `warning` is still `ready`. Proceed to step 3.
- **`needs`** — a precondition is unmet (`.reason` is `state-missing`
  or `checkpoint-missing`). No marker was written. When
  the reason is `checkpoint-missing`, step 1 did not leave a non-empty
  body at `flow-checkpoint --path`'s target — re-do step 1, then re-run
  the helper. Otherwise the
  window is not a resumable flow pipeline; tell the user checkpointing
  is not available here and end.

This skill never probes (`--probe`) — that branch exists only for the
pipeline auto-checkpoint sites (`plan-review`, `plan-approval`, `gate`,
`terminal`) deciding whether to overwrite an existing note, so `.status`
here only ever takes `ready` or `needs`.

## 3. Tell the user it is safe to `/clear`, then end the turn

On a `ready` verdict, surface a one-line nudge and end the turn:

```
✅ checkpointed — type /clear now to reset context (the pipeline auto-resumes and re-injects your notes), or keep going in this session.
```

When step 2's JSON carried a non-empty `.warning`, echo it verbatim
alongside that line, so the user knows the notes will carry over but the
pipeline will not pick back up:

```
⚠️ <warning text from step 2>
```

Then stop. The marker is one-shot: on the next resume, Resume mode reads
the body, folds its addenda into the re-entered step, and calls
`flow-checkpoint --consume`. `--consume` now retires the body outright,
not just the marker: it archives `checkpoint.md` to
`checkpoint.consumed.md` beside it (recoverable, never silently deleted)
and clears the freshness record, then deletes the `checkpoint.pending`
marker so a later unrelated `/clear` in the same window does not re-fire
the auto-resume. At a terminal phase there is no resume to re-enter, so
the `SessionStart:clear` hook does the equivalent itself — it emits the
body as context and retires it the same one-shot way.
