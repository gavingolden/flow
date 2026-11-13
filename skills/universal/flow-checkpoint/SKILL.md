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
conversational residue to `~/.flow/state/checkpoints/<slug>/checkpoint.md`
so it is re-injected after a `/clear`. Depending on the pipeline kind, the resumed
session may be `/flow-pipeline`, `/flow-epic-create`, or the
`/flow-epic-run` playbook — the resumed skill is picked by the window's
kind, not always `/flow-pipeline`.

# Pipeline history (always carried)

Every note this skill saves is also appended to the slug's history log, and
a rendered view of that log is written to
`~/.flow/state/checkpoints/<slug>/history.md`. The history is **never
retired and never trimmed**: it holds `## Active instructions` (the
standing decisions nobody has revoked, plus the live note's one-time items,
while the pipeline is still running) and `## Record` (everything else in
full — every note with its phase and time, gate outcomes, the supervisor's
journal, what was asked, decided, shipped and deferred, and the run's
timeline). The journal is the supervisor's own account of why; a sourced fact
in the Record wins over it.

Every `/clear` in a flow window carries a brief of that history (at most
9,500 characters, with a line-numbered index into the full file) as passive
context — with or without a checkpoint. A checkpointed `/clear` in a tmux
window also starts a turn that Reads the whole `history.md`: a resume at a
resumable phase, else a short "where we are" at a finished one. Run
`flow-checkpoint --history` to re-render the file and print its path. When
the worktree is removed, the plan, review and CI results are snapshotted
under `~/.flow/state/checkpoints/<slug>/snapshot/` until `flow done`
deletes the folder.

# When to use

- The user types `/flow-checkpoint`, or says a natural-language `checkpoint
this` / `checkpoint` inside a flow pipeline window.
- The user wants to reset the supervisor's context mid-pipeline (drop a
  bloated transcript) without losing an in-chat instruction.
- Epic-design windows (`flow epic create`) are a supported context too —
  phases `epic-designing`, `epic-validating`, `epic-pr-open`, and
  `epic-design-pending-review` all checkpoint and auto-resume like a
  feature pipeline. `epic-approved` is terminal for the design supervisor,
  so `/clear` there carries the notes over and (in tmux) opens with a
  short orientation turn, but does not auto-resume the pipeline (an
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
`SessionStart:clear` hook retires the note (its one-time items stop acting
as instructions; the note itself stays in the history) and injects the
pipeline-history brief, which shows that note as the newest retired one.
What it does not do there is _resume the pipeline_ — a terminal pipeline
has nothing left to resume (`gated` and an `epic-run` window are the
exceptions that do auto-resume). In a tmux window the hook also fires a
short **orientation turn** into the pane: it Reads the whole `history.md`,
posts a short "where we are", and then waits for your questions — it never
drives a pipeline or re-renders a gate block. A plain-shell session has no
send-keys surface, so there the brief stays passive-only. So your notes
always survive the clear; only the auto-resume is phase-dependent.
Step 2 below surfaces a warning when the pipeline will not auto-resume,
so you know which of the two you are getting.

# The global manager window

The `flow manage` window has no slug and no pipeline state, so
`flow-checkpoint` there (the pane kind reads `manager`) keeps its files under
`~/.flow/manager/checkpoint/` instead: `--path`, the bare arm, `--probe` and
`--consume` work as above, and `--history` / `--journal` do not apply. It is
tmux-only, like the rest of the manager: after a `/clear` the
`SessionStart:clear` hook re-injects the body, retires it, and sends
`/flow-manage --resume` into the pane.

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

**Tag each saved decision.** Write every decision as its own line item:

- `- [one-time] <decision>` — the default. It is honored by the next resume
  and then retires to the record. An untagged line counts as one `one-time`
  item, so a note without tags behaves exactly as it always did.
- `- [standing] <decision>` — when the user says "standing:" or the decision
  should hold for the rest of the run (for example "wait for Copilot before
  review"). It stays under `## Active instructions` on every later resume
  until a later note revokes it or the pipeline ends. Indent continuation
  lines under their item.

**Plain-words revoke.** When the user asks to drop, stop or forget a
standing rule in their own words ("drop the Copilot-wait rule"), run
`flow-checkpoint --history`, Read its `## Active instructions`, and write
`- [revoke S<n>] <the user's words>` for the one standing item that matches
(`S<n>` is the id shown next to it) — never ask the user for an id. When no
standing item matches, or several do, revoke nothing: save the user's words
as a `- [one-time]` item and list the active standing items in your closing
message so they can restate the request.

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

On **both** the `ready` and `needs` verdicts, extract step 2's helper's
`checkpointed: ` line from its stderr and echo it **verbatim** as the last
line of the turn — per the pipeline SKILL.md's [Checkpoint arm signal
(echo-verbatim)](../../pipeline/flow-pipeline/references/phases/shared-gate-contracts.md#checkpoint-arm-signal-echo-verbatim)
subsection: never restate it from memory, paraphrase it, reorder it, or
drop it. Every branch in `flow-checkpoint.ts` prints this line on stderr,
including the `needs` failure branches — scoping the echo to `ready` only
loses the one line that stops a destructive `/clear`, exactly at the site
the user explicitly invoked this skill for.

When step 2's JSON carried a non-empty `.warning`, echo it verbatim
alongside that line, so the user knows the notes will carry over but the
pipeline will not pick back up:

```
⚠️ <warning text from step 2>
```

Then stop. The marker is one-shot: on the next resume, Resume mode Reads
the history (its `## Active instructions` include this note's one-time items
and every unrevoked standing item), folds them into the re-entered step, and
calls `flow-checkpoint --consume`. `--consume` retires the note's one-time
items, not the history: it logs the body, archives `checkpoint.md` to
`checkpoint.consumed.md` beside it (recoverable, never silently deleted),
clears the freshness record, and deletes the `checkpoint.pending` marker so a
later unrelated `/clear` in the same window does not re-fire the auto-resume.
Standing items stay active. At a terminal phase there is no resume to
re-enter, so the `SessionStart:clear` hook retires the note the same way
before rendering the brief, then (tmux only) dispatches the orientation turn
described above. Nothing about the brief is one-shot: a second `/clear` at the
same phase carries the same brief again, and only a checkpointed `/clear` on
tmux starts a turn.
