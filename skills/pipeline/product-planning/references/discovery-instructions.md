# Discovery instructions

These instructions are read by the discovery subagent that `/product-planning`'s
SKILL.md spawns via the Task tool. The subagent runs in an isolated context — its
file reads, codebase scans, reference loads, and PRD drafting prose stay inside its
own session and are never returned to the caller. The only outputs it produces are
the two artifacts it writes to disk (`.flow-tmp/plan.md` and
`.flow-tmp/pr-description-draft.md`) and a brief one-paragraph summary it returns
on completion.

The wrapper passes you these inputs in its spawn prompt:

- The verbatim user feature description.
- The absolute worktree path (your working directory).
- The absolute skill base directory (`SKILL_DIR`). Resolve every sibling
  template/reference path under it — e.g. `<SKILL_DIR>/templates/prd-template.md`,
  `<SKILL_DIR>/references/architecture-patterns.md`,
  `<SKILL_DIR>/references/discovery-playbook.md`,
  `<SKILL_DIR>/references/example-prd.md`. Those files do not exist
  relative to the worktree you `cd`'d into — they live in the skill
  directory, which is somewhere else on disk (typically
  `~/.claude/skills/product-planning/` or
  `<flow-checkout>/skills/pipeline/product-planning/`).
- The absolute path to write `plan.md`.
- The absolute path to write `pr-description-draft.md`.

Follow the steps below in order.

## 1. Load Project Context

Before forming an opinion, load background context so your scoping is informed:

- Read `README.md` (if present) for architecture, tech stack, and existing capabilities.
- Scan the project's source tree to understand existing modules and domain models.
- Check the database schema location (if one exists) when the feature involves persistence.
- List `.claude/skills/` (or the project's skill directory) to see the current skill set —
  do not hardcode a static list when assigning skills in step 6.
- If `<SKILL_DIR>/references/architecture-patterns.md` exists, load it to verify which
  pattern applies. Otherwise derive patterns from the codebase as you discover them.
- If `<SKILL_DIR>/references/example-prd.md` exists, load it to see what "good" looks
  like for this project.

This is read-only background — these reads stay in your context and don't propagate.

## 2. Scope Check

After loading context, decide whether the idea warrants a full PRD. Not every feature
needs one — a full PRD is overhead that slows down small changes.

**Use the full PRD flow (steps 3–8)** when:

- The feature spans 3+ domain layers (DB, backend, domain model, UI).
- It introduces a new domain module or database table.
- There are meaningful architectural decisions to make.
- The user explicitly asks for a PRD or detailed plan.

**Use a lightweight task breakdown** (skip directly to step 6 with a 2–3-sentence
problem statement instead of a full PRD) when:

- The feature is contained within a single domain area (e.g., adding a method to an
  existing repository, adding a button that calls existing logic).
- It can be expressed in 1–3 tasks.
- The architecture is obvious from existing patterns.

Either path still produces the same `.flow-tmp/plan.md` artifact — the difference is
the depth of the PRD section.

## 3. Discovery — make informed assumptions, surface ambiguity

You are a one-shot subagent. You cannot ask the user clarifying questions; the Task
tool returns one result and exits. When the user's description leaves something
unspecified:

- **Make a defensible assumption** based on the codebase, the project's existing
  patterns, and reasonable defaults for this kind of feature.
- **Surface every assumption you made** in the PRD's "Open Questions" section, written
  as one bullet per assumption: what you assumed, why, and what the user should
  confirm or redirect.

The user iterates by either redirecting at `plan-pending-review` (when invoked from
`/flow-pipeline`) or re-invoking `/product-planning` with refinements (manual mode).
Your job is not to ask — it's to produce a plan grounded enough that the user can
either approve it or redirect with a single message.

When forming assumptions, lean on these signals:

- **Existing code patterns.** If the codebase already does something analogous, follow
  that pattern unless there's a stated reason to deviate. Reference the pattern by
  file path in the PRD.
- **AGENTS.md / CLAUDE.md.** Project-level rules constrain valid approaches. Re-read
  them before finalizing — a plan that conflicts with documented constraints is a
  rework risk.
- **Verbatim user description.** Quote the user's words back when they're load-bearing
  ("the user said 'each row gets a `$` column'") so the assumption is anchored on
  what they actually wrote, not on your paraphrase.

Categories worth examining (use them as a checklist, not a question list):

| Category              | What to determine                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| **User intent**       | What problem does this solve? Who is the primary user? What is the success criterion?                    |
| **Scope**             | New page, modification, or backend-only change? Boundaries — what is explicitly out?                     |
| **UI/UX**             | What does the user see and interact with? Existing UI to reference?                                      |
| **Data**              | What data does this need? New tables or existing ones? External API?                                     |
| **Architecture**      | What layers does this touch? New module or extend an existing one?                                       |
| **Edge cases**        | What happens when X is empty? How should errors display?                                                 |
| **Trade-offs**        | Would a simplification be acceptable for v1?                                                             |
| **Existing patterns** | Is this similar to an existing feature? Follow the same pattern unless there's a reason to deviate.      |

For deeper techniques, load `<SKILL_DIR>/references/discovery-playbook.md`.

## 4. Architecture Checkpoint

Before drafting the PRD, capture these decisions explicitly (one line each). They
become the "Architecture Decisions" section verbatim:

- **Layers touched:** Which layers does this feature span? (data / domain / UI / integration — adapt to your stack)
- **Domain modules:** Which existing modules are involved? Any new ones needed?
- **Data flow:** Where does data originate, how does it transform, where does it render?
- **New patterns vs. existing:** Does this follow an existing pattern (name it) or
  introduce a new one (justify it)?

Load `<SKILL_DIR>/references/architecture-patterns.md` if you need to verify which
pattern applies.

## 5. Draft the PRD

Synthesize into a structured PRD using `<SKILL_DIR>/templates/prd-template.md` as the
format. Sections:

- **Problem Statement** — what problem this solves and why it matters (not solution language).
- **Scope Boundary** — what's in and what's explicitly out.
- **User Stories / Acceptance Criteria** — testable criteria as "Given/When/Then".
- **Architecture Decisions** — from the checkpoint above.
- **Technical Constraints** — framework, security, performance needs.
- **Open Questions** — every assumption you made plus anything still unresolved.

Load `<SKILL_DIR>/references/example-prd.md` (if present) to match the project's
PRD style.

## 6. Task Breakdown

Break the PRD into logical, atomic tasks. Each task tagged with the recommended skill.

**Task sizing:** A task is the right size if it touches 1–3 files in one domain area
and can be verified with a single check. Split a task if:

- It spans multiple languages or runtimes (e.g., backend service + frontend client).
- It creates a new DB table AND uses it in domain logic — migration is one task,
  domain model is another.
- It involves both creating a component and writing its tests.

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

List the skill directory before recommending — do not hardcode a static list.

After the task list, include a **Skills Summary** table showing which skills were
considered and why each was or wasn't recommended:

| Skill    | Recommended? | Reason                              |
| -------- | ------------ | ----------------------------------- |
| database | Yes (Task 1) | New table needed for feature        |
| svelte   | Yes (Task 3) | New page component                  |
| ui       | No           | Existing layout patterns sufficient |
| ...      | ...          | ...                                 |

Include all skills that were plausible candidates — no need to explain why an
obviously irrelevant skill wasn't recommended.

## 7. Draft PR Description

Distill a PR description draft from the PRD. This draft will be used by
implementation skills (like `new-feature`) and validated by `pr-review` — seeding
the description early means the PR tells a coherent story from the start.

**Extract from the PRD into this format:**

```markdown
## Why

<Distill the Problem Statement into 1–3 sentences. Keep the user's pain point and
why it matters — strip solution language. This should read as motivation, not a
feature spec.>

## What

<Convert the Scope Boundary's "In scope" items into a bulleted list of deliverables,
phrased as capabilities or behaviors rather than files or modules. Each bullet
should be verifiable.>

## Key decisions

<Pull from Architecture Decisions and Scope Boundary's "Out of scope". Each bullet:
the decision + a brief rationale. Include scope exclusions that a reviewer might
wonder about.>

## User-facing changes

<Concrete user-observable deltas — phrase in user terms ("you can now run
`flow ls --cost`"), not implementation terms ("added cost column to the ls
renderer"). Each user story's externally observable change becomes a bullet here:
walk the Stories section and, for every story whose acceptance criteria assert
something a user sees or does differently, emit a bullet. Categories to consider:
new CLI commands or subcommands, new flags or changed defaults, renamed/removed
commands, changed prompts or output formats, new env vars, and changed file
locations users interact with.

Format: freeform bullets. For renames or removals, use a `Before → After` bullet so
the delta reads at a glance. Example:

- New flag: `flow ls --cost` adds a `$` column summed across the supervisor session.
- Before → After: `flow install` (removed) → `flow setup` (global install via symlink).

If the PRD describes a pure-internal change (refactor, infra, no user-observable
delta), write the literal word `none` under the heading. Never delete the heading —
`none` is an explicit author affirmation, while a missing heading is ambiguous
between "no change" and "author forgot".>

## Test Steps

<Verification steps for this PR — both automated and manual smoke. The heading is
also the auto-merge gate signal — see
`skills/pipeline/flow-pipeline/references/auto-merge-rubric.md` for the full
contract. The short version: zero unchecked `- [ ]` items ⇒ auto-merge; one or
more ⇒ gated.

Always emit the heading. Decide the body based on the PRD:

- If the PRD describes a pure-internal change (refactor, infra, doc fix,
  generated-code regen) with no user-observable delta — leave the section empty
  under just the placeholder HTML comment. The rubric strips HTML comments before
  counting, so zero unchecked items ⇒ auto-merge.
- Otherwise — populate with `- [ ]` items derived from the acceptance criteria in
  User Stories. Each item is something a reviewer must run, click, or read to
  confirm the change is safe. Prefer manual steps over "run the tests" — but
  include the test command as one of the items if tests exist. The pr-review
  skill will run any item that's a deterministic shell command and tick the box;
  remaining `- [ ]` items are what gates the merge. Use as many items as the
  change warrants — don't pad to look thorough and don't truncate to look concise.

Example (auto-merge — empty section):

<!-- No human verification needed — pure-internal change. -->

Example (gated — non-empty section):

- [ ] Run `npm run test -- <test-file>` — all specs pass.
- [ ] Open /portfolio with the seeded user — allocation chart renders.
- [ ] Switch the time range to 1y — chart updates without a full reload.>
```

**Rules:**

- The PR description is a **distillation**, not a copy. Do not paste PRD sections
  verbatim.
- "Why" must not contain solution language. If you catch yourself writing
  "by adding X" or "through implementing Y", rewrite to focus on the problem.
- "What" bullets should each be testable against the implementation. Avoid vague
  bullets like "improve the user experience".
- "Key decisions" should only include decisions where a reasonable alternative
  existed. Don't list obvious choices.
- "User-facing changes" must be phrased in user terms (what someone running the
  tool will see or do differently), not implementation terms. If the PRD has no
  user-observable delta, write `none` under the heading — never omit the heading
  itself.
- Always emit the `## Test Steps` heading, even for refactors. The auto-merge gate
  treats a missing heading as an upstream regression and escalates `NEEDS HUMAN`.
  Zero unchecked items under the heading is the auto-merge state; one or more
  unchecked `- [ ]` items is the gate state.
- Render every "Test Steps" entry as a `- [ ]` markdown checkbox so reviewers can
  tick items off as they verify and the auto-merge gate can count them.
- Do not hard-wrap prose at a fixed column width. Write each paragraph as a single
  line and let the renderer wrap it. Hard wraps go ragged the moment a sentence
  is edited and add no value on GitHub, which renders one long line as one
  flowing paragraph.
- Save the draft to the `pr-description-draft.md` absolute path the wrapper passed
  you. Create the parent `.flow-tmp/` directory first with `mkdir -p` if it
  doesn't already exist — `/flow-pipeline` worktrees pre-register the path in
  `.git/info/exclude` so it stays untracked, and a stray write at the worktree
  root would block the post-merge `git worktree remove` in `/flow-pipeline`
  step 10.

## 8. Persist the consolidated plan

Write the full PRD + task breakdown + PR-description draft to the `plan.md`
absolute path the wrapper passed you. Create the parent `.flow-tmp/` directory
first with `mkdir -p` if it doesn't already exist. Single artifact, three sections
in this order:

```markdown
# PRD

<the structured PRD from step 5>

# Task breakdown

<the ordered tasks + Skills Summary from step 6>

# PR description draft

<the Why / What / Key decisions / User-facing changes / Test Steps from step 7>
```

This file is the predictable handoff for the `/flow-pipeline` supervisor — it
reads `.flow-tmp/plan.md` after the wrapper returns to drive the implement phase.
When `/product-planning` is run manually (no supervisor), the same file is still
useful as a single artifact the user can share or iterate on. Overwrite any prior
`.flow-tmp/plan.md`; do not append.

The path lives under `.flow-tmp/` (rather than the worktree root) so the
post-merge `git worktree remove` in `/flow-pipeline` step 10 doesn't choke on a
stray untracked file. `flow-new-worktree` registers the path in
`.git/info/exclude`, and `flow-remove-worktree` cleans the directory before
removing the worktree.

The `pr-description-draft.md` write from step 7 is independent and stays — it's
the artifact `pr-review` consumes. Both files should land.

## 9. Return a brief summary

Your final message back to the wrapper should be one short paragraph (3–5
sentences max): the problem statement in one line, the number of tasks, and the
top one or two open questions or assumptions the user should pay attention to.
Do not paste the PRD or task list back — the wrapper only forwards your summary
to the caller, and the artifacts on disk are the durable record. Keeping the
return value short is the whole point of the subagent fan-out.

# Troubleshooting

Common failure modes during planning:

| Problem                | Symptom                                             | Fix                                                                              |
| ---------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| Scope creep            | Tasks keep growing; PRD has 20+ acceptance criteria | Split into v1/v2 milestones; ask "Is this essential for launch?"                 |
| Ambiguous requirements | Multiple valid interpretations of a user story      | Pick the most defensible interpretation; surface the alternative in Open Questions |
| Missing constraints    | Plan proposes patterns that conflict with AGENTS.md | Re-read `AGENTS.md` before finalizing; cross-reference security and style rules  |
| Stale skill references | Recommended skill doesn't exist                     | Always list the skill directory before recommending — never assume               |
| Over-planning          | Trivial change forced through full PRD              | Re-check the Scope Check (step 2) — if ≤ 3 tasks, use the lightweight flow       |
| Skill mismatch         | Task recommends a skill that doesn't fit the work   | Re-read the skill's "When to Use" / "When NOT to Use" before assigning           |

# Verification

- PRD contains all sections (Problem, Scope Boundary, Stories, Architecture,
  Constraints, Open Questions).
- Every user story has testable acceptance criteria (not vague "works correctly").
- Architecture Decisions section names specific layers, domain modules, and data
  flow pattern.
- Every assumption you made under ambiguity appears as an Open Question.
- Task breakdown covers all PRD requirements with no gaps.
- Each task has a recommended skill, inputs, outputs, and acceptance criteria.
- Tasks are ordered by dependency (no task references an output that hasn't been
  produced yet).
- No task is too large for a single focused session (if it seems large, split it).
- Skill recommendations reference skills that actually exist in the project's
  skill directory.
- PR description draft follows the standardized format (Why / What / Key
  decisions / User-facing changes / Test Steps).
- Both `.flow-tmp/plan.md` and `.flow-tmp/pr-description-draft.md` were written
  at the absolute paths the wrapper passed you, with parent directory created on
  demand.

# Constraints

- NEVER write application code — your sole output is strategy, the two artifact
  files, and a brief return summary.
- NEVER ask the user clarifying questions — the Task tool is one-shot. Make
  informed assumptions and surface them as Open Questions.
- NEVER hardcode the skill list — always read the skill directory to get the
  current set.
- NEVER skip loading `README.md` (or the project's primary architecture doc) —
  your assumptions must be informed by existing architecture.
- NEVER dump the full PRD into the PR description — distill problem, scope, and
  decisions only.
- NEVER paste the PRD or task list back to the wrapper as your return value —
  the artifacts on disk are the record, the return summary is one short
  paragraph.
