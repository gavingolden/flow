---
name: product-planning
description: >-
  Plan and scope new features before jumping into implementation. Use BEFORE
  implementation skills (like database, svelte, ui) when a user describes a
  feature idea that hasn't been broken into concrete tasks yet. Signals: user
  describes something they want to add or build, asks about architecture or
  approach, wants to understand scope or what's involved, asks what to build
  next, or evaluates a proposed change ("what do you think", "am I missing
  anything"). The key test: if the user is exploring WHAT to build or HOW to
  structure it rather than ready to write specific code, use this skill. Do NOT
  use when the task is already specific and actionable (e.g., "add a column to
  X", "write tests for Y", "fix the colors on Z").
---

# Goal

Distill a user's feature idea into a structured PRD + ordered task breakdown +
PR-description draft, written to `.flow-tmp/plan.md` and
`.flow-tmp/pr-description-draft.md` for downstream consumers (`/new-feature`,
`/pr-review`, `/flow-pipeline`).

# When to Use

- User has a vague or high-level feature idea that needs scoping.
- User wants to plan a multi-step feature before implementation.
- User wants architecture recommendations before writing code.
- User asks "how should I approach this?" about a new capability.
- User describes something complex that spans multiple domain modules or skills.

# When NOT to Use

- User is asking for a direct code change or bug fix (just do it).
- The task is already well-defined and implementation-ready (just do it).
- User is asking for a refactor or optimization (defer to `refactoring`).

# How it works

This skill is a thin wrapper around a one-shot **Independent Discovery
Subagent**. The wrapper itself does no discovery — it spawns one Task-tool
subagent (`subagent_type: general-purpose`), passes the user's verbatim
description plus the absolute paths to write, and waits for the subagent to
return a brief summary. The subagent does all the heavy lifting in its own
isolated context: reading the codebase, scanning the skill directory,
examining domain models, drafting the PRD, generating the task breakdown, and
writing both artifacts to disk.

The supervisor session that loads this skill (typically `/flow-pipeline` step
3, but also any direct caller) only ever sees:

1. The prose of this SKILL.md (the wrapper).
2. The Task-tool call's prompt and brief result envelope.
3. The one-paragraph summary the subagent returns.

It never sees the discovery transcript — the file reads, the codebase scans,
the PRD drafting prose. Those stay inside the subagent's context. This is the
single largest context-cost win for `/flow-pipeline` runs and applies to
manual users equally.

The trade-off is intentional: the supervisor cannot refer back to the
discovery exploration in later steps. The contract that absorbs the trade-off
is `.flow-tmp/plan.md` itself — that file is already the only handoff the
supervisor reads downstream, so losing the transcript costs nothing
practical.

## Independent Discovery Subagent

**Task-tool fan-out is intentional.** This step ("Independent Discovery
Subagent") spawns one discovery agent via the Task tool. When `/product-planning`
is loaded in-process by `/flow-pipeline` (the supervisor's step 3), this
fan-out is permitted by the named Task-tool exception in
`skills/pipeline/flow-pipeline/SKILL.md`'s "Hard rules" section (itself
anchored on this step's heading name, not its number, so it survives future
renumbering). Outside the supervisor context (e.g. invoked directly from a
user session), the Task tool is unrestricted, so the spawn runs identically.
Either path: one subagent, returns artifacts on disk + a brief summary.

# Spawn procedure

1. Resolve the working directory absolutely. If the caller passed a `WORKTREE`
   value (typical when invoked from `/flow-pipeline`), use it. Otherwise use
   `pwd`. Define:
   - `PLAN_PATH = <workdir>/.flow-tmp/plan.md`
   - `DRAFT_PATH = <workdir>/.flow-tmp/pr-description-draft.md`
2. Resolve the discovery instructions path absolutely:
   `<this-skill-dir>/references/discovery-instructions.md`. The skill base
   directory is printed at the top of this file when the Skill tool loads it.
3. Make exactly **one** Task-tool call:

   ```
   subagent_type: general-purpose
   description:   Discovery for /product-planning
   prompt:        <the prompt template below, with variables filled in>
   ```

4. When the subagent returns, read `.flow-tmp/plan.md` from disk and print a
   3–5 line summary to chat (problem statement + task count + top assumption
   or open question). Do not paste the subagent's full return value — the
   artifact on disk is the record.
5. Suggest the next handoff. If the caller is `/flow-pipeline`, the
   supervisor takes over (it knows what to do based on intent). Otherwise,
   suggest `/new-feature <verbatim user description>` for feature-level work,
   or invoking the per-task skill for fine-grained work.

## Spawn prompt template

Fill in the four `{{...}}` placeholders before passing to the Task tool:

```
You are the Independent Discovery Subagent for `/product-planning`. You run
in an isolated context and return artifacts on disk plus a brief summary.

Read the full instructions at:
  {{INSTRUCTIONS_PATH}}

User feature description (verbatim):
  {{USER_DESCRIPTION}}

Working directory (cd here before reading any project files):
  {{WORKTREE}}

Write the consolidated plan to (absolute path):
  {{PLAN_PATH}}

Write the PR description draft to (absolute path):
  {{DRAFT_PATH}}

Follow the discovery-instructions.md steps in order. You are one-shot — do
not ask the user clarifying questions. When the user description leaves
something unspecified, make a defensible assumption based on the codebase and
project conventions, and surface every assumption you made in the PRD's "Open
Questions" section.

Return a one-paragraph summary (3–5 sentences) — the problem statement in
one line, the number of tasks, and the top one or two assumptions the user
should pay attention to. Do not paste the PRD or task list back; the
artifacts on disk are the record.
```

# Constraints

- NEVER do discovery in the wrapper's context — always spawn the subagent.
  The wrapper's job is to compose the prompt, make one Task-tool call, and
  print the resulting summary. Loading reference docs, reading the codebase,
  or drafting the PRD inline defeats the entire point of the refactor.
- NEVER make more than one Task-tool call per invocation. The single fan-out
  is the named exemption; multi-call fan-out is not authorised.
- NEVER skip writing both artifacts. If the subagent returns without writing
  `.flow-tmp/plan.md`, re-spawn it once with an explicit instruction to write
  the artifact. If the second attempt also fails, surface the error to the
  caller — do not paper over a missing artifact.

# Verification

- Exactly one Task-tool call was made with `subagent_type: general-purpose`.
- `.flow-tmp/plan.md` exists at the resolved absolute path with the three
  expected sections (`# PRD`, `# Task breakdown`, `# PR description draft`).
- `.flow-tmp/pr-description-draft.md` exists at the resolved absolute path.
- The wrapper's chat output is a 3–5 line summary, not the full PRD.
- The supervisor session's transcript contains no file-read tool calls or
  PRD-drafting prose attributable to this skill — those stayed inside the
  subagent.
