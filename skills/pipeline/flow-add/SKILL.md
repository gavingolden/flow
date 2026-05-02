---
name: flow-add
description: >-
  Triage a new flow task in chat — classify the request, ask up to a few
  pressure-testing questions, then start the pipeline in a new tmux window
  with a fleshed-out description. Use ONLY when the user explicitly invokes
  `/flow-add` or says "kick off a flow task" / "create a flow pipeline
  task" / equivalent. Do NOT auto-trigger on broad feature-request
  phrasing like "add X" / "implement Y" — that hijacks unrelated chats.
argument-hint: '"<prompt>"'
---

# Goal

In-chat triage front door for `flow`. The user is already in a Claude
Code session — instead of asking them to context-switch to a terminal
and run `flow new`, this skill conducts triage in the same chat,
folds the clarifications into a detailed description, and spawns the
pipeline via `flow new`. The supervisor session runs detached in its
own tmux window from there.

# When to Use

- The user explicitly invokes `/flow-add "<prompt>"`.
- The user says "kick off a flow task", "create a flow pipeline task",
  "start a flow run for X", or unambiguous direct synonyms.

# When NOT to Use

- The user said "add X" / "implement Y" / "build Z" *without* the word
  "flow" or `/flow-add`. Those phrases occur constantly in non-flow
  contexts. Hijacking them would be worse than missing an offer.
- The user wants to skip triage and just launch directly — that's
  `flow new "<description>"` from a terminal. The supervisor will do
  its own triage step in the new window.
- The user wants to *resume* a crashed pipeline — that's
  `flow new --resume <name>` from a terminal, not this skill.

# Constraints / What NOT to do

> **You do not write code in this skill.** You converse to refine the
> spec, then spawn the pipeline. If the user says "let's just
> implement it now," "skip triage," "do the work directly," or
> anything equivalent: **refuse politely and steer back to triage.**
> Triage's whole job is to *not* skip the spec — the implement phase
> runs later in a separate detached supervisor session.

Refusal copy to use verbatim when the user pivots:

> I can't skip triage from the `/flow-add` skill — my job is to fold
> the spec into the launch description so the supervisor (which runs
> detached, in its own tmux window) has clear context. Let me get the
> one or two pieces I actually need, then we'll kick the pipeline off.

Hard rules:

- NEVER call `Edit`, `MultiEdit`, or `NotebookEdit` from this skill —
  triage produces a description, not a code change.
- NEVER use the `Write` tool to create task files yourself. The
  supervisor writes any per-pipeline scratch in its own tmux window;
  you do not write to disk here.
- NEVER paste the user's prompt into a `Bash` tool that runs `git
  commit`, `gh pr create`, or any state-mutating git/gh command.
- NEVER invent a slug or write under `~/.flow/state/` yourself.
  `flow new` derives the slug and writes the initial state.

<!-- include: triage-contract.md -->

# Instructions

## 1. Classify the request

Apply the classification heuristics from the contract above.

- **no-change** (Q&A, brainstorm, explanation): answer inline and
  stop. Do NOT call `flow new`.
- **change** (feature, bug, refactor, docs edit): continue to step 2.

If you're not sure, ASK ONE clarifying question first.

## 2. Pressure-test the request

Ask 1–3 questions only — the ones that genuinely change downstream
work. Don't pad. Stop asking the moment you have:

- The intent (`feature` / `bug` / `refactor` / `docs` / `infra` /
  `chore`).
- A one-sentence summary the implementer can read first.
- The clarifications, constraints, and open questions the planning
  phase will need.

If the user pushes back ("just go ahead and implement it" / "skip
triage"), respond with the verbatim refusal copy above and re-ask the
remaining question.

## 3. Build the launch description

Fold the triage results into a single description string. The
supervisor reads it as the pipeline's seed prompt — the more concrete
it is, the less back-and-forth the planner needs. A good shape:

```
<intent>: <one-sentence summary>

Clarifications:
- <bullet 1>
- <bullet 2>

Constraints:
- <constraint or "none flagged">

Open questions:
- <question or "none">
```

Pass the user's verbatim prompt as the lead line if it reads as a
one-liner; otherwise summarise it into the first sentence.

## 4. Spawn the pipeline

```bash
flow new "<the fleshed-out description from step 3>"
```

`flow new` derives the slug from the description, creates the tmux
window, writes the initial state at `~/.flow/state/<slug>.json`, and
starts the supervisor session. The slug appears in the command's
output and in `flow ls`.

> **Heads-up for `feature`-intent tasks.** The pipeline pauses for
> review after the plan phase at `phase: plan-pending-review` —
> implement does NOT auto-run. The user resumes by running
> `/flow-approve <id>` (continue with the plan as-is) or
> `/flow-revise <id> "<message>"` (re-plan with a redirection). Both
> skills inject into the supervisor's tmux window via `tmux
> send-keys`. This pause does not happen for `bug`, `refactor`,
> `docs`, `infra`, or `chore` intents — those flow straight through
> to implement.

## 5. Forward `flow new`'s output and point at the next moves

Print `flow new`'s stdout into chat verbatim. Then add a one-line
follow-up:

```
Pipeline started in tmux window `flow:<slug>`.
Live-tail with `/flow-watch <slug>`, attach with `flow attach <slug>`,
or check status with `/flow-status`.
```

If `flow new` exits non-zero, surface stderr verbatim and stop. Common
failure modes:

- `flow: unknown verb 'new'` — `flow setup` hasn't been run on this
  machine. Tell the user to run it once.
- `not inside a git repository` — open Claude in a git repo and retry.
- `window 'flow:<slug>' already exists` — a prior pipeline used the
  same slug. Suggest `flow attach <slug>` or rephrase the prompt to
  produce a different slug.

# Verification

- `flow new` exited 0.
- The chat received the success block and the follow-up sentence
  naming `/flow-watch`, `flow attach`, and `/flow-status`.
- The chat session is responsive for the next message immediately —
  the supervisor runs detached in its tmux window, so this skill
  returns once `flow new` completes.

# Constraints (repeat for emphasis)

- **You do not write code in this skill.** Refuse politely if the
  user pivots to "just implement it now" — the implement phase runs
  later, detached, with the spec from the launch description.
- **You do not bypass `flow new`.** Never `Write` state files
  yourself, never invoke `tmux new-window` directly. `flow new`
  canonicalises the slug, writes the initial state file, and starts
  the supervisor; bypassing it produces orphaned windows or stale
  state.
