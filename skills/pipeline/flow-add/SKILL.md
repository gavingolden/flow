---
name: flow-add
description: >-
  Triage a new flow task in chat — classify the request, ask up to a few
  pressure-testing questions, then write .orchestrator/tasks/<id>.md and
  start the detached pipeline. Use ONLY when the user explicitly invokes
  `/flow-add` or says "kick off a flow task" / "create a flow pipeline
  task" / equivalent. Do NOT auto-trigger on broad feature-request
  phrasing like "add X" / "implement Y" — that hijacks unrelated chats.
argument-hint: '"<prompt>"'
---

# Goal

In-chat triage front door for `flow`. The user is already in a Claude
Code session — instead of asking them to context-switch to a terminal
and run `flow start`, this skill conducts triage in the same chat,
records `.orchestrator/tasks/<id>.md`, and shells out to
`./scripts/flow-add.ts` which spawns `flow run <id> --detach`. The chat
is freed immediately; the pipeline runs as a detached process tree.

# When to Use

- The user explicitly invokes `/flow-add "<prompt>"`.
- The user says "kick off a flow task", "create a flow pipeline task",
  "start a flow run for X", or unambiguous direct synonyms.

# When NOT to Use

- The user said "add X" / "implement Y" / "build Z" *without* the word
  "flow" or `/flow-add`. Those phrases occur constantly in non-flow
  contexts. Hijacking them would be worse than missing an offer.
- The user wants the pipeline to run in the foreground (no detach) or
  wants to step through phases manually — that's `flow start` from a
  terminal.
- The user wants to *resume* an existing task — that's `flow run <id>`
  from a terminal, not this skill.

# Constraints / What NOT to do

> **You do not write code in this skill.** You converse to refine the
> spec, then record task.md and spawn the pipeline. If the user says
> "let's just implement it now," "skip triage," "do the work directly,"
> or anything equivalent: **refuse politely and steer back to writing
> task.md.** Triage's whole job is to *not* skip the spec — the
> implement phase runs later in a separate detached process.

Refusal copy to use verbatim when the user pivots:

> I can't skip triage from the `/flow-add` skill — my job is to record
> task.md so the implement phase (which runs later, in a detached
> process) has a spec to work from. Let me get the one or two pieces I
> actually need, then we'll kick the pipeline off.

Hard rules:

- NEVER call `Edit`, `MultiEdit`, or `NotebookEdit` from this skill —
  triage produces a spec, not a code change.
- NEVER use the `Write` tool against any path. The helper writes
  task.md; you do not. Bypassing the helper skips canonical-root
  resolution and id-collision handling.
- NEVER paste the user's prompt into a `Bash` tool that runs `git
  commit`, `gh pr create`, or any state-mutating git/gh command.
- NEVER raise the helper's argv into `flow run` directly — always go
  through `./scripts/flow-add.ts`. The skill is a thin shell over the
  helper.
- NEVER invent a task id or write under `.orchestrator/tasks/`
  yourself. The helper does that.

<!-- include: triage-contract.md -->

# Instructions

## 1. Classify the request

Apply the classification heuristics from the contract above.

- **no-change** (Q&A, brainstorm, explanation): answer inline and
  stop. Do NOT call the helper. Do NOT record a task file.
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

## 3. Build the helper invocation

Convert the triage results into argv. Each clarification, constraint,
and open question becomes a separate `--clarification`, `--constraint`,
or `--open-question` flag — the helper joins them into the markdown
bullets.

```bash
./scripts/flow-add.ts "<the user's verbatim prompt>" \
  --intent <feature|bug|refactor|docs|infra|chore> \
  --summary "<one-sentence summary>" \
  --slug "<3-5-word-kebab-slug>" \
  --clarification "<bullet 1>" \
  --clarification "<bullet 2>" \
  --constraint "<constraint or 'nothing flagged'>" \
  --open-question "<question or 'none'>"
```

Notes:

- The prompt is positional and quoted. Pass the user's verbatim text —
  don't rewrite it.
- `--slug` is optional. Pass it when you have a clear 3–5 word name in
  mind; otherwise the helper derives it from the prompt.
- Repeat each multi-bullet flag for each bullet — the helper aggregates.
- Omit `--clarification` entirely if the user's request was
  unambiguous; do not pass an empty value.

## 4. Run the helper and forward its output verbatim

Invoke the command via the `Bash` tool. The helper prints a
copy-pasteable success block to stdout — print it verbatim into chat,
including the lines starting with `task:`, `task-md:`, `logs:`, and
the `Pipeline started (detached). Next:` block. Do not paraphrase, do
not summarise, do not pretty-print.

If the helper exits non-zero, its stderr names the failure mode (one
error per line). Print stderr verbatim and stop. Common failure modes:

- exit 2 — `flow` not on PATH. Tell the user to run `flow install` (or
  add `flow` to their PATH) and try again.
- exit 3 — not inside a git repository. Tell the user to open Claude
  in a flow-installed repo.
- exit 4 — id collision exhausted. Ask the user to rephrase the
  prompt to produce a different slug.
- exit 5 — argv parsing failed. Re-read the helper's stderr and fix
  the invocation.

# Verification

- The helper exited 0.
- The chat received the success block, including `task:`, `task-md:`,
  `logs:`, and the `/flow-status` / `/flow-watch` lines.
- The path printed in `task-md:` is an absolute path under the user's
  primary worktree's `.orchestrator/tasks/` (not a child worktree's
  path).
- The chat session is responsive for the next message immediately —
  the pipeline runs detached, so this skill returns once the spawn
  completes.

# Constraints (repeat for emphasis)

- **You do not write code in this skill.** Refuse politely if the user
  pivots to "just implement it now" — the implement phase runs later,
  detached, with a spec from task.md.
- **You do not bypass the helper.** Never `Write` task.md yourself,
  never invoke `flow run` directly. The helper canonicalises the repo
  root and handles id collisions; bypassing it produces tasks under the
  wrong path or under colliding ids.
- **You do not raise the helper's bounds.** If the helper exits
  non-zero, surface the error verbatim — don't retry with different
  flags hoping a different code path succeeds.
