# Scout instructions

These instructions are read by the scout subagent that `/new-feature`'s
SKILL.md spawns via the Task tool. The subagent runs in an isolated context —
its file reads, codebase scans, reference loads, and analytical prose stay
inside its own session and are never returned to the caller. The only outputs
it produces are the artifact it writes to disk (`.flow-tmp/scout.md`) and a
brief one-paragraph summary it returns on completion.

Same shape as `/product-planning`'s discovery subagent (PR #95). The
context-cost win is identical: the supervisor never sees the codebase reads
that the Critical Analysis depends on, but still gets a structured artifact
with everything Critical Analysis needs to assess scope, debt risk, and
composability.

The wrapper passes you these inputs in its spawn prompt:

- The verbatim user feature description.
- The absolute worktree path (your working directory).
- The absolute skill base directory (`SKILL_DIR`). Resolve every sibling
  template/reference path under it. Those files do not exist relative to the
  worktree you `cd`'d into — they live in the skill directory, which is
  somewhere else on disk (typically `~/.claude/skills/new-feature/` or
  `<flow-checkout>/skills/pipeline/new-feature/`).
- The absolute path to write `scout.md` (`SCOUT_PATH`).
- The approved plan path (`PLAN_PATH`) — an absolute path when an approved
  plan with a `# Task breakdown` exists, the literal string `absent`
  otherwise. A non-`absent` value switches step 2 into verify-not-rederive
  mode (see step 2b).

Follow the steps below in order.

## 1. Load Project Context

Before forming opinions about scope or strategy, load background context so
your scouting is informed:

- Read `README.md` (if present) for architecture, tech stack, and existing
  capabilities.
- Read `AGENTS.md` / `CLAUDE.md` (if present) for project-level rules and
  conventions. A scout report that conflicts with documented constraints
  is a rework risk.
- Scan the project's source tree to understand existing modules and domain
  models. Don't read every file — read the ones the user description
  implicates plus their immediate neighbours.
- List `.claude/skills/` (or the project's skill directory) to identify
  skills that may apply. The scout reports _which_ skills are relevant via
  `recommended_strategy`; it does not pre-load them.

This is read-only background — these reads stay in your context and don't
propagate to the supervisor.

## 2. Identify the Affected Surface

Decide what the feature actually touches. The user description names some
modules; the codebase will reveal others (call sites, sibling components,
shared types, related tests). Collect:

- **Concrete files and modules** the feature edits or creates.
- **Adjacent files** that would feel surprising if left untouched (e.g. a
  page that consumes a renamed export, a test that asserts the old shape).
- **Public API surface** — what other code imports from the affected
  modules. Renaming or restructuring a public surface is much more
  expensive than a private-only change; flag this early.

Be specific: a path, not "the auth module". A function name, not "some
helpers".

## 2b. Verify-not-rederive (plan-supplied runs only)

When `PLAN_PATH` is not `absent`, an approved plan has already made the
interface-level decisions, and your step-2 job shifts from re-deriving the
affected surface to **verifying the plan's contract against the code**:

- Read ONLY the plan's `# Task breakdown` section — not the PRD prose. The
  upstream rationale dilutes your codebase focus; the per-task Contract
  blocks (Files / Interfaces / Call-site edits / acceptance command) are
  the claims you verify.
- Verify each Contract claim against the codebase: the named file exists,
  the named symbol exists, the stated signature matches.
- Fill genuine gaps the plan left unspecified — adjacent files, tests,
  public-API fan-out — exactly as steps 2–3 describe.
- Record each contradiction as a `PLAN-DEVIATION:`-prefixed bullet in
  `## open_questions`: what the plan claims, what the code actually shows,
  and the corrected interface. Never silently follow a contradicted
  contract and never silently rewrite the plan — the contract is a strong
  prior, not a straitjacket.

The six-section artifact shape (step 7) is **unchanged** in this mode —
`PLAN-DEVIATION:` bullets live inside the existing `## open_questions`
section; there is no seventh section. When `PLAN_PATH` is `absent`, skip
this step entirely.

## 3. Identify Relevant Tests

For each affected file, find the test that covers it. Note:

- **Existing tests** that this feature must keep green (regression risk).
- **Missing tests** — places where the feature touches code with no
  coverage. The Critical Analysis can decide whether to expand coverage
  as part of the feature; the scout just reports the gap.
- **Tests that need updating** — where the feature's `it.todo()` specs
  will replace, supersede, or extend existing assertions.

## 4. Identify Anti-Patterns and Off-Limits Surfaces

This is the negative-findings pass — the half of scouting that's easy to
skip. Convey **what NOT to do** alongside what to do. Any of these belong
under `## anti_patterns`:

- **Off-limits files or modules.** Code that looks adjacent but is
  deliberately load-bearing for unrelated features, owned by a different
  team's contract, or generated and not hand-edited.
- **Rejected approaches.** Designs that look attractive but violate a
  documented constraint (`AGENTS.md`, security policy, framework
  best-practice). Foreclosed before the Critical Analysis spends a turn
  on them.
- **Dependencies the codebase rejects.** Patterns the project deliberately
  avoids — adding a new HTTP client when one is already standardised, a
  date library when the project uses native Date, a state-management lib
  when the project uses runes.
- **Existing patterns that look reusable but are not.** A util that
  superficially fits but has a hidden invariant that makes it unsafe for
  this feature's call site.
- **Foreclosed shortcuts.** "It would be tempting to do X here, but X
  breaks Y." Note the temptation and the why.

A scout report that returns only positive findings has done half the job.
The negative findings are what stops the Critical Analysis from walking
into a dead end.

## 5. Recommend a Strategy

A short, defensible recommendation: which pattern to follow, which existing
file to extend vs. create new, what order to tackle the work in. Two or
three sentences. Reference specific files and existing patterns by path.

If the strategy is non-obvious or there are two plausible options, name
both and pick one with a one-line rationale. The Critical Analysis can
override; the scout just gives the strongest defensible default.

## 6. Surface Open Questions

You are a one-shot subagent — you cannot ask the user clarifying questions.
The Task tool returns one result and exits. When the user description
leaves something unspecified:

- Make a defensible assumption based on the codebase and project
  conventions.
- Surface every assumption you made in `## open_questions` as one bullet
  per assumption: what you assumed, why, and what the user should confirm
  or redirect.

The Critical Analysis (which the supervisor's main session runs after
reading your `scout.md`) uses this list to flag ambiguities back to the
user during the section-4 review.

## 7. Write the artifact

Write your findings to the `SCOUT_PATH` absolute path the wrapper passed
you. The parent `.flow-tmp/` directory was created by the wrapper before
the spawn — do not `mkdir -p` yourself. Single artifact, six sections in
this order:

```markdown
# Scout report

## affected_modules

- <path/to/file.ts> — <one-line role + what changes>
- <path/to/component.svelte> — <one-line role + what changes>
- <...>

## relevant_tests

- <path/to/file.test.ts> — <existing | missing | needs-update; one-line note>
- <...>

## public_api_surface

- <module> exports <name> — consumed by <caller paths>; rename cost: <low | medium | high>
- <...>

## open_questions

- <assumption made | ambiguity surfaced; why; what to confirm>
- <...>

## recommended_strategy

<2–3 sentences. Pattern to follow, files to extend vs. create, work order.
Reference specific files by path.>

## anti_patterns

- <off-limits surface | rejected approach | dependency-to-avoid | foreclosed shortcut>: <why>
- <...>
```

Section headings are exact (`## affected_modules`, `## relevant_tests`, etc.)
— the consumer (Critical Analysis in the main session) reads them
positionally. The body of each section is markdown bullets; recommended
strategy is prose. Overwrite any prior `scout.md`; do not append.

The path lives under `.flow-tmp/` (rather than the worktree root) so the
post-merge `git worktree remove` in `/flow-pipeline` step 10 doesn't choke
on a stray untracked file. `flow-new-worktree` registers the path in
`.git/info/exclude`, and `flow-remove-worktree` cleans the directory
before removing the worktree.

## 8. Return a brief summary

Your final message back to the wrapper should be one short paragraph (3–5
sentences max). It must surface **both sides** of what you learned:

- At least one positive finding (what to do — top affected module, the
  recommended strategy, the most consequential assumption).
- At least one negative finding (what NOT to do — top anti-pattern,
  off-limits surface, or rejected approach).

A summary that names only the positive side fails the contract. The user
specifically asked (2026-05-05 feedback) that subagent return values
convey both halves of what the subagent learned, not just the "do" half.

Do not paste the scout report back — the wrapper only forwards your
summary to the caller, and the artifact on disk is the durable record.
Keeping the return value short is the whole point of the subagent
fan-out.

# Verification

- `scout.md` written at the absolute `SCOUT_PATH` the wrapper passed.
- File contains all six sections in order: `## affected_modules`,
  `## relevant_tests`, `## public_api_surface`, `## open_questions`,
  `## recommended_strategy`, `## anti_patterns`.
- Every assumption made under ambiguity appears as an Open Question.
- On a plan-supplied run (`PLAN_PATH` not `absent`), every contract
  contradiction appears as a `PLAN-DEVIATION:`-prefixed bullet in
  `## open_questions`, and only the plan's `# Task breakdown` section was
  read (not the PRD prose).
- `## anti_patterns` is non-empty — every scout has at least one
  off-limits surface, rejected approach, or foreclosed shortcut to
  report. An empty list means the negative-findings pass was skipped.
- Return summary names at least one positive finding and at least one
  negative finding (the both-sides contract).

# Constraints

- NEVER write application code or test code — your sole output is the
  scout artifact and a brief return summary.
- NEVER ask the user clarifying questions — the Task tool is one-shot.
  Make informed assumptions and surface them as open questions.
- NEVER `mkdir -p` the parent directory — that is the wrapper's
  side-effect attribution site. The wrapper has already created
  `.flow-tmp/` before spawning you.
- NEVER paste the scout report back to the wrapper as your return value
  — the artifact on disk is the record, the return summary is one short
  paragraph.
- NEVER omit `## anti_patterns` or leave it empty — the both-sides
  contract is load-bearing. If you genuinely found no anti-patterns,
  report that conclusion explicitly with the surfaces you considered
  and why each was safe; an empty list is indistinguishable from a
  skipped pass.
