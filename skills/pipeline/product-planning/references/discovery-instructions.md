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
| **Trade-offs**        | Would a simplification be acceptable for v1? If the request is framed as a binary A-or-B choice, is there a middle-ground option? |
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
- **Binary-framing check:** If the user described the feature as an either/or choice
  (A or B), name at least one intermediate option (a hybrid, a phased rollout, a
  config-gated default) and record the A / middle / B trade-off in the PRD's
  Architecture Decisions or Open Questions section — silently picking a pole violates
  the flow `AGENTS.md` `## Output style` rule **Consider the middle ground when a
  request is framed as a binary choice.** When the choice is genuinely binary, say so
  explicitly.

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
- **Prompt interpretation** (conditional) — when the prompt names BOTH prescribed
  methods AND a quantitative target; see the "Prompt interpretation (conditional)"
  sub-section below for the full contract.

Load `<SKILL_DIR>/references/example-prd.md` (if present) to match the project's
PRD style.

### Candidate follow-up issues (optional)

If discovery surfaces orthogonal ideas the user did **not** ask for but that the codebase or
the user's verbatim description suggests are worth tracking, capture them as a separate
section that the supervisor will route through `flow-create-issue` post-merge. This is
distinct from "Open Questions": Open Questions are assumptions about *this* feature that
the user should confirm; candidate follow-up issues are *next-time* work the user can
opt into.

When (and only when) such ideas exist, add a top-level `# Candidate follow-up issues`
section to `plan.md`, placed between `# PRD` and `# Task breakdown` (see step 8). Each
entry is a single-line markdown checkbox with a title and one-line body, in the form:

```markdown
# Candidate follow-up issues

- [ ] OAuth refresh path leaks tokens — separate concern; needs a dedicated session.
- [ ] `gh-action-cache@v3` is deprecated — pin to v4 in CI.
```

Leave every checkbox **unticked** (`- [ ]`). The supervisor's step 4 will pop an
`AskUserQuestion` form to let the user pick which to file (1–4 candidates) or fall back to
manual editing (5+ candidates). The user's selections persist back as `- [x]`; the post-
merge sweep at step 10 reads `- [x]` items and fires `flow-create-issue` for each.

If discovery surfaces no orthogonal ideas, **omit the section entirely** — do not write an
empty heading. An empty heading is a no-op for the supervisor (count is `0` → no form,
no fallback), but it implies candidates exist when none do, adds noise to plan review,
and risks accumulating stale `- [ ]` entries on later edits. The supervisor's
"section absent" and "count is 0" branches behave identically; the value of omitting
the heading is signal-to-noise, not control flow.

Bar for inclusion: would the user want to come back to this in a separate session? If the
answer is "no, this is part of the current feature" or "no, this is just a question for
the user", it does not belong here. Keep the bar high — backlogs full of low-confidence
candidates are noise.

### Prompt interpretation (conditional)

This is the upstream artifact half of the `## Output style` rule **Treat user prompts as
evidence of intent, not exhaustive specifications.** in `AGENTS.md`. The rule body covers
the *why* (PR #170 is the canonical precedent — four prescribed trims landed at -71 lines
vs a <800-line target, with no tension surfaced). This sub-section covers the *how* —
what the discovery subagent must emit so downstream consumers (`/new-feature` Step 2,
`/flow-pipeline` Step 3 routing, `/pr-review` Step 1.5 Gatekeeper) can act on it.

**Trigger.** When the user prompt names BOTH (a) **prescribed methods** — typically a
numbered list, "do X then Y then Z" phrasing, an explicit enumeration of moves to make —
AND (b) a **quantitative target** — a number with units (`<800 lines`, `30% faster`,
`≤ 100ms`, `-N lines`), a coverage percentage, a latency budget — your PRD MUST include
a top-level `## Prompt interpretation` section.

Apply prose judgment for detection (NOT a regex catalogue). Signals worth weighting:
numbered lists (`1. Do X. 2. Do Y. 3. Do Z.`) or explicit enumeration ("the three changes
are…"); a number with units in the same prompt; "make X reach Y" / "reduce X to Y" /
"increase X to Y" framing pairs a method (the verb) with a target (Y). Two signals does
not guarantee tension — sometimes the methods clearly reach the target. The Recommended
path captures that.

**Omit-when-no-tension.** When discovery surfaces neither signal — or only one — omit the
`## Prompt interpretation` section entirely. Same omit-when-empty rule as the
`# Candidate follow-up issues` section above: an empty heading adds noise and risks
downstream consumers treating absent-tension prompts as tension-flagged (the
`/flow-pipeline` Step 3 routing helper exact-matches against the four-value enum below
and a missing heading is treated as "no tension", but an empty heading would be ambiguous
to a human reading the file).

**Section shape.** Three subsections, in this order:

- **Reading of prescribed methods.** One of: `exhaustive` (the user intends the named
  methods as the complete set) or `starting points` (the user is signalling these are
  minimum moves; you may extend). Anchor on the user's framing — verbs like
  "specifically" / "exactly these" / "only" lean exhaustive; verbs like "for example" /
  "such as" / "to start with" lean starting points; ambiguous framing defaults to
  `starting points` since literal-spec failures (PR #170) are more costly than
  over-eager extensions.

- **Plausibility estimate.** Your honest read on whether the named methods can plausibly
  reach the named target. Cite evidence (file sizes, current measurements, existing
  patterns) rather than speculation. When you do not have evidence and cannot easily get
  it, say so — "uncertain — would need to run X to verify".

- **Recommended path.** One of these four strings, copied verbatim. The
  `/flow-pipeline` Step 3 routing helper at `bin/flow-step3-route.ts` exact-matches
  against the first string; drift here silently routes runs the wrong way, so the four
  values are case-sensitive and must not be paraphrased. Emit the value **bare** — no
  surrounding backticks, no bold, no trailing punctuation — so the producer here and
  the consumer (`bin/flow-step3-route.ts`) agree on an exact string:

  - `methods plausibly reach target` — the prescribed methods fully cover the stated
    target without extension. No tension; downstream consumers treat the run as if no
    `## Prompt interpretation` section existed (same routing outcome).
  - `extend scope with named additional safe steps` — the prescribed methods leave a
    gap and you can name specific additional steps that close it. Surface those steps
    in the `# Task breakdown` as additional tasks marked as the extension (e.g.
    Task N: "scope extension — covers the gap between prescribed methods and target").
  - `relax target` — the prescribed methods are correct but the target is unreachable
    without scope blow-up (e.g. "<800 lines" requires deleting load-bearing prose).
    Name what you'd cut and why; the user can choose to accept the looser target or
    redirect.
  - `split into multiple pipelines` — the prescribed methods and target together require
    effort that exceeds a single PR (multiple migrations, breaking changes to a public
    API). Name the natural seams; the user can decide whether to file the rest as
    candidate follow-up issues.

**Open-Questions emission rule.** When the Recommended path is NOT
`methods plausibly reach target`, the PRD's `## Open Questions` section MUST include one
user-facing question naming the choice. Example: "Extend scope to add X and Y, or relax
the target to a looser bound?". The question gives the user a single redirect to resolve
the tension at the next `plan-pending-review` checkpoint without re-running discovery.
When the Recommended path IS `methods plausibly reach target`, no Open-Questions entry
is needed (the prompt and the methods are in agreement).

**Single source of truth.** The four enum values and the Open-Questions emission rule
above live in this file ONLY. Downstream consumers — the helper at
`bin/flow-step3-route.ts`, `/new-feature` Step 2 (Critical Analysis), `/pr-review`
Step 1.5 Gatekeeper — reference this file by path rather than duplicating the contract
inline. Drift between this file and a duplicated copy is exactly the silent-failure
mode PR #170 demonstrates; do not inline the enum or anti-pattern list in
`templates/prd-template.md` or in the consumers' SKILL.md files.

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
  User Stories, applying the **automation test** from
  `skills/pipeline/pr-review/references/manual-test-rubric.md` ("Automate first"
  section) to each candidate item *before* you write it. The test:

  > Can I name (a) a fixture / setup, (b) one or more deterministic assertions, and
  > (c) an exit condition — all without subjective human judgment? If yes, this is
  > a runnable item, not manual prose.

  When the answer is yes, write the item as the deterministic shell command itself
  (`npm run test -- <file>`, `bun bin/<helper>.test.ts`, `gh pr view <n> --json …
  --jq …`, `test -f <path>`, `grep -q <pattern> <file>`,
  `[ "$(cat <path>)" = "<expected>" ]`) so `/pr-review` Step 8c can run it and tick
  the box. Manual prose survives only when the rubric flags the scenario as genuinely
  manual (subjective UX, production-only integrations, cross-browser rendering,
  performance under realistic load). Use as many items as the change warrants —
  don't pad to look thorough and don't truncate to look concise.

Open the `## Test Steps` section with this HTML comment, copied verbatim, between
the heading and the first `- [ ]` item. The auto-merge gate strips HTML comments
before counting so the marker is invisible to the count, and any later editor (an
agent re-running pr-review, a human pasting in steps) sees the same standard:

```html
<!-- flow:authoring-rubric — for each `- [ ]` item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/pr-review/references/manual-test-rubric.md. -->
```

Example (auto-merge — empty section):

<!-- No human verification needed — pure-internal change. -->

Example (gated — non-empty section, marker preserved):

<!-- flow:authoring-rubric — for each `- [ ]` item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/pr-review/references/manual-test-rubric.md. -->

- [ ] Run `npm run test -- <test-file>` — all specs pass.
- [ ] Run `[ -f <path> ] && grep -q "<expected>" <path>` — config is wired.
- [ ] Open /portfolio in dark mode — chart contrast feels right (subjective UX, manual).
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
first with `mkdir -p` if it doesn't already exist. Single artifact, sections
in this order:

```markdown
# PRD

<the structured PRD from step 5>

# Candidate follow-up issues

<optional — only when discovery surfaced orthogonal ideas; see step 5's
"Candidate follow-up issues" sub-section. Omit the heading entirely when
empty>

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
sentences max): the problem statement in one line, the number of tasks, the
candidate follow-up issue count if non-zero (e.g. "3 candidate follow-up
issues for the user to pick from"), and the top one or two open questions
or assumptions the user should pay attention to. Do not paste the PRD or
task list back — the wrapper only forwards your summary to the caller, and
the artifacts on disk are the durable record. Keeping the return value
short is the whole point of the subagent fan-out.

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
- `# Candidate follow-up issues` section is omitted from `plan.md` when discovery
  surfaced no orthogonal ideas; populated as one or more `- [ ]` items otherwise
  (never written as an empty heading).

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
