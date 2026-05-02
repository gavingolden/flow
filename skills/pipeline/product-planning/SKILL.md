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

Act as a Product Manager who deeply understands this project's architecture, domain model
patterns, and available skills. Distill a user's idea into a structured PRD and an ordered
task breakdown where each task maps to a specific skill and has clear acceptance criteria.

# When to Use

- User has a vague or high-level feature idea that needs scoping
- User wants to plan a multi-step feature before implementation
- User wants architecture recommendations before writing code
- User asks "how should I approach this?" about a new capability
- User describes something complex that spans multiple domain modules or skills

# When NOT to Use

- User is asking for a direct code change or bug fix (just do it)
- The task is already well-defined and implementation-ready (just do it)
- User is asking for a refactor or optimization (defer to `refactoring`)
- User wants to add a new data provider (defer to `data-provider`)

# Context

- **Project architecture:** Read `README.md` if present for the tech stack, architecture,
  and project structure. If no README exists, note missing architecture docs as a PRD
  constraint.
- **Coding standards:** `AGENTS.md` contains project-wide rules (never restate them)
- **Available skills:** `.claude/skills/` — list the directory to discover current skills
  before making recommendations
- **Domain models:** locate business logic in the project's source tree (e.g., `src/lib/`,
  `src/domain/`, or wherever the project organizes entity + service code)
- **Database schema:** if a schema exists (e.g., `supabase/migrations/`, `prisma/schema.prisma`,
  or equivalent), reference it when a feature involves persistence
- **Architecture patterns:** if `references/architecture-patterns.md` exists, load it to
  verify which pattern applies. Otherwise derive patterns from the codebase as you discover them.
- **Discovery techniques:** `references/discovery-playbook.md` — load when you need to go
  deeper on a vague or complex idea
- **Example PRD:** if `references/example-prd.md` exists, load it to see what "good" looks
  like for this project. Save your first strong PRD as this reference for future plans.

# Instructions

## 1. Load Project Context

Before asking questions, load background context so your questions are informed:

- Read `README.md` (if present) for architecture, tech stack, and existing capabilities
- Scan the project's source tree to understand existing modules and domain models
- Check the database schema location (if one exists) when the feature involves persistence

Do this silently — do not dump file contents to the user.

## 2. Scope Check

After loading context, assess whether this idea is large enough to warrant a full PRD. Not every
feature needs one — a full PRD is overhead that slows down small changes.

**Use the full PRD flow (steps 3-8)** when:

- The feature spans 3+ domain layers (DB, backend, domain model, UI)
- It introduces a new domain module or database table
- There are meaningful architectural decisions to make
- The user explicitly asks for a PRD or detailed plan

**Skip to a lightweight task breakdown** when:

- The feature is contained within a single domain area (e.g., adding a method to an existing
  repository, adding a button that calls existing logic)
- It can be expressed in 1-3 tasks
- The architecture is obvious from existing patterns

For lightweight features: ask 2-3 clarifying questions, then go directly to a concise task
breakdown (step 6). No PRD, no architecture checkpoint — just the tasks with skill assignments.
Tell the user: "This looks small enough that we can skip the full PRD. Here are a few questions,
then I'll give you a task list."

## 3. Inquisitive Discovery

Ask targeted questions to understand what the user actually needs. The goal is to reach a point
where you can write a complete PRD without placeholders — so keep asking until you get there,
but don't ask more than you need.

**Question categories:**

| Category              | Example Questions                                                               |
| --------------------- | ------------------------------------------------------------------------------- |
| **User intent**       | "What problem does this solve?", "Who is the primary user?"                     |
| **Scope**             | "Is this a new page, a modification, or a backend-only change?"                 |
| **UI/UX**             | "What should the user see/interact with?", "Any existing UI to reference?"      |
| **Data**              | "What data does this need?", "New DB tables or existing ones?", "External API?" |
| **Architecture**      | "What layer does this touch?", "New module or extend an existing one?"          |
| **Edge cases**        | "What happens when X is empty?", "How should errors display?"                   |
| **Trade-offs**        | "Would Y be an acceptable simplification for v1?"                               |
| **Existing patterns** | "This is similar to [existing feature] — should it follow the same pattern?"    |

**Which categories to start with depends on the feature type:**

| Feature Type             | Start With                            | Then Explore            |
| ------------------------ | ------------------------------------- | ----------------------- |
| New page / major feature | User intent, Scope, UI/UX             | Data, Existing patterns |
| Data pipeline / backend  | Data, Architecture, Existing patterns | Scope, Edge cases       |
| Modification to existing | Existing patterns, Scope              | Edge cases, Trade-offs  |
| Cross-cutting concern    | Scope, Architecture, Trade-offs       | Existing patterns, Data |

**Rules:**

- Ask at most 5-7 questions per round
- Reference specific project features when asking (e.g., "similar to how expressions work")
- Challenge assumptions — suggest alternatives the user may not have considered
- Stop asking when you can fill all PRD sections without placeholders

**Follow-up triggers** — these signals mean you need to probe deeper:

- User says "it should just work like X" → ask what specifically about X they want to
  replicate vs. what should differ
- User gives a single-sentence answer about data → ask about volume, freshness, and error states
- User says "whatever you think is best" → offer two concrete options with trade-offs and
  ask them to pick
- Answer implies a new DB table → ask about ownership (user_id scope), relationships to
  existing tables, and whether RLS is needed
- Answer implies a new external API → ask whether it needs a backend proxy (for auth/secrets)

For deeper techniques, load `references/discovery-playbook.md`.

## 4. Architecture Checkpoint

Before writing the PRD, state these decisions (one line each). This forces intentional choices
about structure before getting into details:

- **Layers touched:** Which layers does this feature span? (data / domain / UI / integration — adapt to your stack)
- **Domain modules:** Which existing modules are involved? Any new ones needed?
- **Data flow:** Where does data originate, how does it transform, where does it render?
- **New patterns vs. existing:** Does this follow an existing pattern (name it) or introduce
  a new one (justify it)?

Load `references/architecture-patterns.md` if you need to verify which pattern applies.
Share the checkpoint with the user before proceeding — it's a quick alignment step that
prevents rework later.

## 5. Draft the PRD

Synthesize answers into a structured PRD. Use the template in `templates/prd-template.md`
as the output format, and load `references/example-prd.md` to see what a well-done PRD
looks like for this project. The PRD sections:

- **Problem Statement** — what problem this solves and why it matters (not solution language)
- **Scope Boundary** — what's in and what's explicitly out
- **User Stories / Acceptance Criteria** — testable criteria as "Given/When/Then"
- **Architecture Decisions** — from the checkpoint above
- **Technical Constraints** — framework, security, performance needs
- **Open Questions** — anything still unresolved

Present the PRD to the user for review before proceeding to the task breakdown.

## 6. Task Breakdown

Break the PRD into logical, atomic tasks. Each task should be tagged with the recommended skill.

**Task sizing:** A task is the right size if it touches 1-3 files in one domain area and can
be verified with a single check. Split a task if:

- It spans multiple languages or runtimes (e.g., backend service + frontend client)
- It creates a new DB table AND uses it in domain logic — migration is one task, domain model
  is another
- It involves both creating a component and writing its tests

**Dependency ordering** — follow the layer order:

1. Database migration (schema, RLS, triggers, RPCs)
2. Generated DB types
3. Backend proxy handler (if external API)
4. Domain model (entity, DTO, repository)
5. Domain store (reactive state)
6. UI components (pages, components, layouts)
7. Integration wiring (connecting layers, route setup)
8. Tests (unit + integration per layer)

**Format each task as:**

```markdown
### Task N: [Short Title]

- **Skill:** `skill-name`
- **Description:** What to implement
- **Inputs:** What must exist before this task starts
- **Outputs:** What this task produces
- **Acceptance criteria:** How to verify it's done
```

List the skill directory (`ls .claude/skills/`) to ensure recommendations reference
actual, current skills — do not hardcode a static list.

After the task list, include a **Skills Summary** table showing which skills were
considered and why each was or wasn't recommended:

| Skill    | Recommended? | Reason                              |
| -------- | ------------ | ----------------------------------- |
| database | Yes (Task 1) | New table needed for feature        |
| svelte   | Yes (Task 3) | New page component                  |
| ui       | No           | Existing layout patterns sufficient |
| ...      | ...          | ...                                 |

Include all skills that were considered during task assignment. Only list skills that
were plausible candidates — no need to explain why an obviously irrelevant skill wasn't
recommended for a UI-only feature.

## 7. Draft PR Description

Distill a PR description draft from the PRD. This draft will be used by implementation
skills (like `new-feature`) and validated by `pr-review` — seeding the description early
means the PR tells a coherent story from the start.

**Extract from the PRD into this format:**

```markdown
## Why

<Distill the Problem Statement into 1-3 sentences. Keep the user's pain point and why it
matters — strip solution language. This should read as motivation, not a feature spec.>

## What

<Convert the Scope Boundary's "In scope" items into a bulleted list of deliverables, phrased
as capabilities or behaviors rather than files or modules. Each bullet should be verifiable.>

## Key decisions

<Pull from Architecture Decisions and Scope Boundary's "Out of scope". Each bullet: the
decision + a brief rationale. Include scope exclusions that a reviewer might wonder about.>

## User-facing changes

<Concrete user-observable deltas — phrase in user terms ("you can now run `flow ls --cost`"),
not implementation terms ("added cost column to the ls renderer"). Each user story's
externally observable change becomes a bullet here: walk the Stories section and, for every
story whose acceptance criteria assert something a user sees or does differently, emit a
bullet. Categories to consider: new CLI commands or subcommands, new flags or changed
defaults, renamed/removed commands, changed prompts or output formats, new env vars, and
changed file locations users interact with.

Format: freeform bullets. For renames or removals, use a `Before → After` bullet so the
delta reads at a glance. Example:

- New flag: `flow ls --cost` adds a `$` column summed across the supervisor session.
- Before → After: `flow install` (removed) → `flow setup` (global install via symlink).

If the PRD describes a pure-internal change (refactor, infra, no user-observable delta),
write the literal word `none` under the heading. Never delete the heading — `none` is an
explicit author affirmation, while a missing heading is ambiguous between "no change" and
"author forgot".>

## Test Steps

<Verification steps for this PR — both automated and manual smoke. The heading is also
the auto-merge gate signal — see
`skills/pipeline/flow-pipeline/references/auto-merge-rubric.md` for the full contract.
The short version: zero unchecked `- [ ]` items ⇒ auto-merge; one or more ⇒ gated.

Always emit the heading. Decide the body based on the PRD:

- If the PRD describes a pure-internal change (refactor, infra, doc fix, generated-code regen)
  with no user-observable delta — leave the section empty under just the placeholder HTML
  comment. The rubric strips HTML comments before counting, so zero unchecked items
  ⇒ auto-merge.
- Otherwise — populate with `- [ ]` items derived from the acceptance criteria in User
  Stories. Each item is something a reviewer must run, click, or read to confirm the change
  is safe. Prefer manual steps over "run the tests" — but include the test command as one
  of the items if tests exist. The pr-review skill will run any item that's a deterministic
  shell command and tick the box; remaining `- [ ]` items are what gates the merge. Use as
  many items as the change warrants — don't pad to look thorough and don't truncate to look
  concise.

Example (auto-merge — empty section):

<!-- No human verification needed — pure-internal change. -->

Example (gated — non-empty section):

- [ ] Run `npm run test -- <test-file>` — all specs pass.
- [ ] Open /portfolio with the seeded user — allocation chart renders.
- [ ] Switch the time range to 1y — chart updates without a full reload.>
```

**Rules:**

- The PR description is a **distillation**, not a copy. Do not paste PRD sections verbatim.
- "Why" must not contain solution language. If you catch yourself writing "by adding X" or
  "through implementing Y", rewrite to focus on the problem.
- "What" bullets should each be testable against the implementation. Avoid vague bullets like
  "improve the user experience".
- "Key decisions" should only include decisions where a reasonable alternative existed. Don't
  list obvious choices.
- "User-facing changes" must be phrased in user terms (what someone running the tool will
  see or do differently), not implementation terms. If the PRD has no user-observable
  delta, write `none` under the heading — never omit the heading itself.
- Always emit the `## Test Steps` heading, even for refactors. The auto-merge gate
  treats a missing heading as an upstream regression and escalates `NEEDS HUMAN`. Zero
  unchecked items under the heading is the auto-merge state; one or more unchecked
  `- [ ]` items is the gate state.
- Render every "Test Steps" entry as a `- [ ]` markdown checkbox so reviewers can tick
  items off as they verify and the auto-merge gate can count them.
- Do not hard-wrap prose at a fixed column width. Write each paragraph as a single line
  and let the renderer wrap it. Hard wraps go ragged the moment a sentence is edited and
  add no value on GitHub, which renders one long line as one flowing paragraph.
- Save the draft to `.flow-tmp/pr-description-draft.md` in the working
  directory. Create the directory first with `mkdir -p .flow-tmp` if it
  doesn't already exist — `/flow-pipeline` worktrees pre-register the
  path in `.git/info/exclude` so it stays untracked, and a stray write
  at the worktree root would block the post-merge `git worktree remove`
  in `/flow-pipeline` step 10.

## 8. Persist the consolidated plan

Before sharing with the user, write the full PRD + task breakdown + PR-description draft
to `.flow-tmp/plan.md` in the working directory. Create the directory first with
`mkdir -p .flow-tmp` if it doesn't already exist. Single artifact, three sections in
this order:

```markdown
# PRD

<the structured PRD from step 5>

# Task breakdown

<the ordered tasks + Skills Summary from step 6>

# PR description draft

<the Why / What / Key decisions / User-facing changes / Test Steps from step 7>
```

This file is the predictable handoff for the `/flow-pipeline` supervisor — it reads
`.flow-tmp/plan.md` after this skill returns to drive the implement phase. When this
skill is run manually (no supervisor), the same file is still useful as a single
artifact the user can share or iterate on. Overwrite any prior
`.flow-tmp/plan.md`; do not append.

The path lives under `.flow-tmp/` (rather than the worktree root) so the post-merge
`git worktree remove` in `/flow-pipeline` step 10 doesn't choke on a stray untracked
file. `flow-new-worktree` registers the path in `.git/info/exclude`, and
`flow-remove-worktree` cleans the directory before removing the worktree.

The `.flow-tmp/pr-description-draft.md` write from step 7 is independent and stays —
it's the artifact `pr-review` consumes. Both files should land.

## 9. Present and Iterate

Share the full PRD + task breakdown + PR description draft with the user. Iterate based on
feedback until the user confirms the plan is ready for implementation. The user approves
the PRD and description together.

Once confirmed, suggest kicking off implementation with `/new-feature` and pass the feature
description as `$ARGUMENTS` (for example, `/new-feature add a portfolio allocation chart`).
This is the default handoff for feature-level work. When the user begins executing individual
tasks from the breakdown, each task's assigned skill (e.g., `supabase`, `svelte`) takes
precedence over `/new-feature`.

# Troubleshooting

Common failure modes during planning:

| Problem                | Symptom                                             | Fix                                                                               |
| ---------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Scope creep            | Tasks keep growing; PRD has 20+ acceptance criteria | Split into v1/v2 milestones; ask "Is this essential for launch?"                  |
| Ambiguous requirements | Multiple valid interpretations of a user story      | Surface the ambiguity explicitly; offer concrete options A/B for the user to pick |
| Missing constraints    | Plan proposes patterns that conflict with AGENTS.md | Re-read `AGENTS.md` before finalizing; cross-reference security and style rules   |
| Stale skill references | Recommended skill doesn't exist                     | Always list the skill directory before recommending — never assume                |
| Over-planning          | User just wants a quick answer, not a full PRD      | Re-check the Scope Check (step 2) — if ≤3 tasks, use the lightweight flow         |
| Skill mismatch         | Task recommends a skill that doesn't fit the work   | Re-read the skill's "When to Use" / "When NOT to Use" before assigning            |

# Verification

- PRD contains all sections (Problem, Scope Boundary, Stories, Architecture, Constraints, Open Questions)
- Every user story has testable acceptance criteria (not vague "works correctly")
- Architecture Decisions section names specific layers, domain modules, and data flow pattern
- Task breakdown covers all PRD requirements with no gaps
- Each task has a recommended skill, inputs, outputs, and acceptance criteria
- Tasks are ordered by dependency (no task references an output that hasn't been produced yet)
- No task is too large for a single focused session (if it seems large, split it)
- Skill recommendations reference skills that actually exist in `.claude/skills/`
- PR description draft follows the standardized format (Why / What / Key decisions / User-facing changes / Test Steps)
- `.flow-tmp/plan.md` was written (with the directory created on demand) with PRD + Task breakdown + PR description draft sections in that order

# Constraints

- NEVER write application code — your sole output is strategy, PRDs, and task lists
- NEVER make assumptions about ambiguous requirements — surface them as open questions
- NEVER hardcode the skill list — always read `.claude/skills/` to get the current set
- NEVER skip loading `README.md` — your questions must be informed by existing architecture
- NEVER dump the full PRD into the PR description — distill problem, scope, and decisions only
- Keep discovery conversational — do NOT dump a wall of 15+ questions in one message
