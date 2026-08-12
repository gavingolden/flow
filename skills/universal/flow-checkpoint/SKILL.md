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
effort: medium
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
re-injected after a `/clear`. Depending on the pipeline kind, the resumed
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
  so `/clear` there will not auto-resume (an `epic-run` window at the same
  phase is a separate case — see the gate note below).

The helper (`bin/flow-checkpoint.ts`) gates **only** on (`state.json`
present, `state.worktree` set, a non-empty `checkpoint.md`) and is
**phase-independent** — it writes the marker at any phase, including a
terminal one. It is the `SessionStart:clear` **hook** that declines to
auto-resume at a terminal phase (except `gated`, and except an
`epic-run` window, which resumes regardless of phase). Checkpointing a
terminal pipeline therefore still succeeds and still arms the marker, but
`/clear` there will not auto-resume — step 2 below surfaces a warning
when that is the case, so you can decide not to `/clear` instead of
finding out from a blank pane.

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

This skill's frontmatter pins `effort: medium` rather than inheriting the
session's depth. Step 1's work reads as a short summarization, but the
two judgment calls inside it are real: deciding what conversational
state is load-bearing enough to keep, and telling an implementation-nuance
addendum apart from a scope/plan change that must instead be routed to a
re-plan. Both failures are silent and unrecoverable once the transcript
is cleared, so `effort: low` is not safe here. The pin is also a
ceiling, not just a floor: on a session running deeper than medium
(high/xhigh/max), this turn is deliberately capped rather than
inheriting the session's depth. `docs/target-architecture.md`'s
named-agent frontmatter policy reserves an omitted `effort:` for
judgment roles precisely so they inherit session depth for open-ended
design work — this skill's two judgment calls are bounded and local
(classify conversational residue, distinguish an implementation nuance
from a scope change) rather than open-ended, so capping them at
`medium` is the deliberate trade-off, not an oversight. The frontmatter
deliberately does NOT pin `model:`, because prompt caches are
model-scoped — a model switch mid-turn would discard the supervisor's
warm cache and force it to re-read the whole transcript at full input
rate, the opposite of the intended saving in most cases (see
`../../pipeline/flow-pipeline/references/model-routing.md` "In-process
skills pin effort, not model" for the full routing rationale, including
where that comparison can flip). It also deliberately does NOT
set `disable-model-invocation:`, which would block the Skill-tool load
path `../../pipeline/flow-pipeline/references/redirect-handling.md`
documents for the supervisor's natural-language checkpoint redirect, nor
`context: fork` / `agent:`, since a forked context cannot see the
conversation — this skill's only input.

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

The bare call above keeps no `--site` flag, so it defaults to
`--site manual` — this is what makes the note you just wrote outrank
every pipeline auto-checkpoint (plan-review, plan-approval, gate) until
the pipeline itself changes phase: a manual note's freshness is judged
against `state.phaseLog`, and it reads as fresh for as long as no phase
transition has happened since you armed it. Once the pipeline advances,
the current phase's own auto-checkpoint takes back over — your
superseded note is never silently lost, it stays recoverable at
`.flow-tmp/checkpoint.consumed.md` after the next `--consume` (see step 3).

It confirms `state.json` is current and `checkpoint.md` is present +
non-empty, then emits one JSON object on stdout. Branch on `.status`:

- **`ready`** — the helper wrote the one-shot marker
  `<worktree>/.flow-tmp/checkpoint.pending` (the flag the
  `SessionStart:clear` auto-resume hook gates on) and recorded the
  freshness receipt (`site: manual`) that gives your note precedence
  over auto-checkpoints while it stays fresh. When the JSON also
  carries a non-empty `.warning` (a terminal phase that will not
  auto-resume — the `gated` and `epic-run` carve-outs never carry one),
  hold onto it for step 3: it does **not** change the branch, `ready` +
  `warning` is still `ready`. Proceed to step 3.
- **`needs`** — a precondition is unmet (`.reason` is `state-missing`,
  `no-worktree`, or `checkpoint-missing`). No marker was written. When
  the reason is `checkpoint-missing`, step 1 did not leave a non-empty
  `checkpoint.md` — re-do step 1, then re-run the helper. Otherwise the
  window is not a resumable flow pipeline; tell the user checkpointing
  is not available here and end.

This skill never probes (`--probe`) — that branch exists only for the
four pipeline auto-checkpoint sites deciding whether to overwrite an
existing note, so `.status` here only ever takes `ready` or `needs`.

## 3. Tell the user it is safe to `/clear`, then end the turn

On a `ready` verdict, surface a one-line nudge and end the turn:

```
✅ checkpointed — type /clear now to reset context (the pipeline auto-resumes and re-injects your notes), or keep going in this session.
```

When step 2's JSON carried a non-empty `.warning`, echo it verbatim
alongside that line, so the user can decide **not** to `/clear`:

```
⚠️ <warning text from step 2>
```

Then stop. The marker is one-shot: on the next resume, Resume mode reads
`checkpoint.md`, folds its addenda into the re-entered step, and calls
`flow-checkpoint --consume`. `--consume` now retires the body outright,
not just the marker: it archives `checkpoint.md` to
`.flow-tmp/checkpoint.consumed.md` (recoverable, never silently deleted)
and clears the freshness record, then deletes the `checkpoint.pending`
marker so a later unrelated `/clear` in the same window does not re-fire
the auto-resume.
