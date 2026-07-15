---
name: flow-new-feature
description: >-
  Scaffold and implement a new user-facing feature with upfront critical analysis,
  it.todo() acceptance criteria, and mandatory test implementation. Use when user
  says "new feature", "implement feature", "build this feature", or wants a
  structured feature implementation process.
---

# Goal

Guide the implementation of new user-facing features through critical analysis, upfront
acceptance criteria as `it.todo()` test specs, and mandatory test implementation.

# When to Use

- Implementing a new user-facing feature from scratch
- User asks for a structured feature implementation process
- User says "new feature", "implement feature", "build this feature"

# When NOT to Use

- For small bug fixes or single-line changes
- For refactoring without behavior change — use `/flow-refactoring`
- For adding tests to existing code — use the `flow-testing` skill directly

# How it works

This skill is a thin wrapper around a one-shot **Independent Scout
Subagent**. The wrapper itself does no codebase scouting — it spawns one
Task-tool subagent (`subagent_type: flow-scout`, guarded `general-purpose`
fallback), passes the user's
verbatim description plus the absolute path to write, and waits for the
subagent to return a brief both-sides summary. The subagent does the
discovery in its own isolated context: reading source files, scanning
adjacent modules, identifying tests, surfacing public API surface, and
flagging anti-patterns / off-limits surfaces. It writes a structured
artifact to `$WORKTREE/.flow-tmp/scout.md` and returns a short summary.

The supervisor session that loads this skill (typically `/flow-pipeline`
step 5, but also any direct caller) only ever sees:

1. The prose of this SKILL.md (the wrapper).
2. The Task-tool call's prompt and brief result envelope.
3. The one-paragraph summary the subagent returns.
4. One Read of `.flow-tmp/scout.md` early in Critical Analysis (Step 2).

It never sees the scouting transcript — the source-file reads, the
adjacent-module scans, the API-surface enumeration. Those stay inside the
subagent's context. Same context-cost surgery PR #95 applied to
`/flow-product-planning`'s discovery; this is the analogous fix for
`/flow-new-feature`.

The trade-off is intentional: the supervisor cannot refer back to the
scouting exploration in later steps. The contract that absorbs the
trade-off is `.flow-tmp/scout.md` itself — the supervisor reads it once
during Critical Analysis and never re-reads.

## Independent Scout Subagent

**Task-tool fan-out is intentional.** This step ("Independent Scout
Subagent") spawns one scout agent via the Task tool. When `/flow-new-feature`
is loaded in-process by `/flow-pipeline` (the supervisor's step 5), this
fan-out is permitted by the named Task-tool exception #3 in
`skills/pipeline/flow-pipeline/SKILL.md`'s "Hard rules" section (itself
anchored on this step's heading name, not its number, so it survives
future renumbering). Outside the supervisor context (e.g. invoked
directly from a user session), the Task tool is unrestricted, so the
spawn runs identically. Either path: one subagent, returns artifact on
disk + a brief summary.

# Context

- Test files live adjacent to the component or module being built
- `it.todo()` naming format: `"should <expected observable behavior> when <trigger/condition>"`
- Skill consultation: before writing `.svelte` files, read the `svelte` skill. Before writing
  tests, read the `flow-testing` skill. Before UI/layout work, read the `tailwind-shadcn` skill.
  Before database/migrations, read the `supabase-project` skill. (Names assume the canonical stack
  skills installed by `flow install`; substitute whatever your project uses.)

# Instructions

## 1. Understand the User Flow

- If `$ARGUMENTS` is provided, use it as the initial feature description. Ask clarifying
  questions to fill gaps rather than asking the user to describe the feature from scratch.
- If `$ARGUMENTS` is empty, ask the user to describe the feature from their perspective:
  what they click, what they see, what changes.
- Identify the entry point (page, button, trigger) and the expected end state.
- Clarify edge cases: empty states, error states, loading states, boundary conditions.
- Define **scope boundaries** — explicitly state what is out of scope to prevent scope creep.

## 1b. Scout the Codebase

**Resolve `PLAN_PATH` first**, before the hybrid threshold below — this
runs on every entry to Step 1b, not only the wider-scope spawn path, so a
supplied plan is never silently dropped when a feature is judged
description-trivial (Step 5's `/flow-coder` threshold is independent and can
still take the wider path at implement time). Resolve the working
directory absolutely: if the caller passed a `WORKTREE` value (typical
when invoked from `/flow-pipeline`), use it; otherwise use `pwd`. Define:

- `PLAN_PATH` — the absolute plan path when the invocation carried a
  `PLAN: <path>` line AND that file exists AND contains a heading (any
  level, case-insensitive) matching `Task breakdown`; the literal string
  `absent` otherwise. A supplied plan does not change the hybrid
  threshold below — it neither forces nor skips the scout spawn; on the
  skip-scout path it still feeds Step 2's contract read and Step 5's
  edit-set composition. On the spawn path it additionally switches the
  spawned scout into verify-not-rederive mode (see
  `references/scout-instructions.md`).

Decide whether to spawn the scout subagent based on the **hybrid threshold**:

- **Trivially scoped features** (≤3 affected files, judged from the
  verbatim user description) skip the scout entirely. Phrasing
  signals: a single named file ("fix the colors on Z.svelte"), a
  single named flag ("rename `--foo` to `--bar`"), a single
  one-liner ("add a column to X"). Log a one-line reason in chat
  ("trivial scope: single .svelte file — skipping scout") so the
  user can audit the decision in scrollback. Proceed inline to Step 2
  with the existing 1–2-file read budget.
- **Tiebreaker for soft-edge phrasing.** If the description names
  one file but contains fan-out language ("and all callers", "every
  caller of X", "and downstream consumers", "and update its tests")
  or introduces a _new_ sibling module / component / migration, route
  SPAWN regardless of the leading single-file phrasing. The
  `## affected_modules` and `## public_api_surface` sections of the
  scout report exist precisely to enumerate fan-out the description
  hand-waved past; routing SKIP on a description like "Refactor
  `bin/lib/state.ts`, updating all callers and adding tests" defeats
  that. Log the tiebreaker reason ("wider scope: fan-out language
  past leading single-file phrasing — spawning scout") so the user
  can audit.
- **Wider scopes** spawn the scout subagent via the Spawn procedure
  below. Log a one-line reason ("wider scope: spawning scout") so
  the user can audit.

### Spawn procedure (wider-scope path only)

**Load the Task tool before spawning.** In Claude Code sessions where neither `Task` nor its alias `Agent` is surfaced top-level by the harness (both are aliases of the same one-shot subagent-spawn primitive: identical `subagent_type` / `prompt` / `description` schema), the spawn will silently fall through to in-line execution unless the schema is loaded first. Before the Task call below, run `ToolSearch query="select:Task"` and confirm the response contains either a `<function>{"name": "Task", ...}</function>` or a `<function>{"name": "Agent", ...}</function>` line. If it does not, **do not fall back to in-line execution** — escalate `NEEDS HUMAN: task-tool-unavailable: new-feature-scout` and exit. The fan-out's value is its context isolation; an in-line fallback breaks the contract that this exemption is justified by.

1. Resolve the working directory absolutely (same resolution as above,
   reused rather than re-derived). Define:
   - `SCOUT_PATH = <workdir>/.flow-tmp/scout.md`
   - `PLAN_PATH` — already resolved above; do not re-derive it here.
2. Resolve the skill base directory absolutely. The Skill tool prints
   the "Base directory for this skill" at the top of this SKILL.md when
   loaded — capture it as `SKILL_DIR`. Then derive:
   - `INSTRUCTIONS_PATH = <SKILL_DIR>/references/scout-instructions.md`

   The subagent reads its instructions via this absolute path. Pass
   `SKILL_DIR` so the subagent never has to resolve sibling references
   relative to its `cd`'d worktree, where they don't exist. Also create
   the consumer-side `.flow-tmp/` directory now (single side-effect
   attribution site) so the subagent never has to:

   ```bash
   mkdir -p "$WORKTREE/.flow-tmp"
   ```

2b. **Excluded paths (omit-when-absent).** Fill `{{EXCLUDED_PATHS}}` from
`$WORKTREE/.flow-tmp/excluded-paths.json` — the machine-readable mirror of
plan.md's `## Alternatives considered` (see
`skills/pipeline/flow-product-planning/references/discovery-instructions.md`
"Alternatives considered"):

- When the file exists and is non-empty, `cat` its contents verbatim into
  the block.
- When the file is absent or malformed but `PLAN_PATH` is non-`absent` AND
  plan.md carries a non-empty `## Alternatives considered` section, fall
  back to quoting that section's prose bullets into the block instead
  (graceful degradation — the injection still happens even when the JSON
  mirror drifted or was never written).
- Omit the block entirely only when BOTH sources are absent — non-plan and
  plan-without-alternatives pipelines see byte-identical spawn prompts.

3. Resolve the subagent type. The `agents/flow-scout.md` definition
   (Bash/Read/Grep/Glob/Write allowlist, no `effort:`/`model:` pins)
   resolves via a file-exists guard that falls back to `general-purpose`
   with a loud `NOTICE — agent-fallback:` line so the pipeline never
   fails on an unknown agent type:

   ```bash
   SCOUT_SUBAGENT=flow-scout
   [ -f ~/.claude/agents/flow-scout.md ] || { SCOUT_SUBAGENT=general-purpose; echo "NOTICE — agent-fallback: flow-scout → general-purpose (definition not installed; tool-allowlist containment lost — run \`flow install\`)."; }
   ```

   Make exactly **one** Task-tool call:

   ```
   subagent_type: $SCOUT_SUBAGENT
   description:   Scout for /flow-new-feature
   prompt:        <the prompt template below, with variables filled in>
   ```

   **Per-phase model (implement → scout) resolution.** The Scout is the
   `implement` fan-out's read half; resolution field `state.modelImplement`
   with the scout config-only fine-grain layered **above** it — precedence
   `config.models.scout > state.modelImplement(--model-implement) >
config.models.implement > inherited` (see
   `../flow-pipeline/references/model-routing.md`). Resolve via `jq` and pass
   the non-empty result as the Task call's per-spawn `model:` (empty ⇒ omit ⇒
   inherit). There is **no** `--model-scout` flag — the finer grain is
   config-only:

   ```bash
   SLUG=$(tmux show-options -t "$TMUX_PANE" -v -w @flow-slug)
   SCOUT_MODEL=$(jq -r '.models.scout // empty' ~/.flow/config.json 2>/dev/null)
   [ -z "$SCOUT_MODEL" ] && SCOUT_MODEL=$(jq -r '.modelImplement // empty' ~/.flow/state/"$SLUG".json)
   [ -z "$SCOUT_MODEL" ] && SCOUT_MODEL=$(jq -r '.models.implement // empty' ~/.flow/config.json 2>/dev/null)
   # Non-empty ⇒ pass model: "$SCOUT_MODEL" on the Task call; empty ⇒ omit.
   ```

4. When the subagent returns, treat its 3–5-sentence both-sides summary
   as the chat output. Do **not** read `.flow-tmp/scout.md` from disk in
   the wrapper — the main session will read it once at the top of Step
   2 (Critical Analysis), and reading it twice in the same supervisor
   session erodes the context-cost win. The wrapper's only post-spawn
   job is a cheap existence check (`test -s "$SCOUT_PATH"`); on missing
   artifact, surface the failure to the caller per the Constraints
   below — do not retry, do not re-spawn.

### Spawn prompt template

Fill in the seven `{{...}}` placeholders before passing to the Task tool:
`INSTRUCTIONS_PATH`, `USER_DESCRIPTION`, `WORKTREE`, `SKILL_DIR`,
`SCOUT_PATH`, `PLAN_PATH`, `EXCLUDED_PATHS` (omit-when-absent — see step 2b
above).

```
You are the Independent Scout Subagent for `/flow-new-feature`. You run in an
isolated context and return an artifact on disk plus a brief summary.

Read the full instructions at:
  {{INSTRUCTIONS_PATH}}

User feature description (verbatim):
  {{USER_DESCRIPTION}}

Working directory (cd here before reading any project files):
  {{WORKTREE}}

Skill base directory (resolve sibling references against this absolute
path — they do not exist relative to {{WORKTREE}}):
  {{SKILL_DIR}}

Write the scout report to (absolute path):
  {{SCOUT_PATH}}

Approved plan path (when not the literal `absent`, verify the plan's
`# Task breakdown` contracts against the code instead of re-deriving —
see scout-instructions.md "Verify-not-rederive"):
  {{PLAN_PATH}}

{{EXCLUDED_PATHS}}
Follow the scout-instructions.md steps in order. You are one-shot — do
not ask the user clarifying questions. When the user description leaves
something unspecified, make a defensible assumption based on the codebase
and project conventions, and surface every assumption you made in the
artifact's "## open_questions" section.

Return a one-paragraph summary (3–5 sentences) that surfaces BOTH sides
of what you learned: at least one positive finding (top affected module,
recommended strategy, key assumption) AND at least one negative finding
(top anti-pattern, off-limits surface, rejected approach). A summary
that names only positive findings fails the contract. Do not paste the
scout report back; the artifact on disk is the record.
```

## 2. Critical Analysis

- **If the wider-scope path was taken in Step 1b**, read `scout.md`
  from the same `SCOUT_PATH` the wrapper resolved in Step 1b
  (`$WORKTREE/.flow-tmp/scout.md` when `/flow-pipeline` passed
  `WORKTREE`; `$(pwd)/.flow-tmp/scout.md` for direct-call
  invocations) exactly once at the top of this step. Use the six
  sections (`affected_modules`, `relevant_tests`,
  `public_api_surface`, `open_questions`, `recommended_strategy`,
  `anti_patterns`) as the inputs to the assessment table below. Do
  not re-read `scout.md` later in this skill — once is the contract.
- **If the trivial path was taken**, fill the assessment from inline
  knowledge plus at most 1–2 targeted Read calls on the named files.
- Before committing to implementation, perform a brief structured
  assessment. Present findings to the user as a table:

  | Criterion            | Assessment                                                                                              |
  | -------------------- | ------------------------------------------------------------------------------------------------------- |
  | Customer value       | _How much does this improve the user's workflow?_                                                       |
  | Technical complexity | _Rough effort estimate and what areas of the codebase are affected_                                     |
  | Debt risk            | _Does this follow existing patterns or introduce new ones?_                                             |
  | Composability        | _Can this design be easily extended, layered on, or reused?_                                            |
  | Redundancy           | Does this duplicate an existing capability (skill/helper/config/prior feature)? Cite it, or state none. |
  | **Recommendation**   | **Proceed / Reconsider scope / Defer / Reject**                                                         |

- Within this analysis:
  - **Challenge the feature.** Don't just validate the user's idea. Identify potential
    downsides, over-engineering risks, or simpler alternatives. Question whether the
    request is necessary at all — "do nothing / reject the premise" is a legitimate
    recommendation (the `Reject` verdict already in the assessment table above), not a
    failure to engage. If an existing capability or no change at all serves the user
    better, say so and set the Recommendation to `Reject` with a one-line rationale.
    Minimal scope / anti-over-engineering targets unrequested feature creep, not
    trivial robustness fixes — for the fix-now-vs-defer bar (when a small,
    low-risk, in-scope fix must land in-PR rather than be deferred), see
    `templates/AGENTS.md.template` (`## Anti-Overengineering`) and `/flow-pr-review`'s
    `references/fix-applier-instructions.md`.
  - **Consider alternatives.** Propose at least one alternative approach if one exists.
    Briefly explain the trade-off. When the user's feature description is framed as a
    binary either/or choice (A or B), comparing only the two named poles is
    insufficient — per the AGENTS.md `## Output style` rule **Consider the middle ground when a request is framed as a binary choice.**, look for and propose an
    intermediate option (a hybrid, a phased rollout, a config-gated default) and
    explain its trade-off against both poles, rather than defaulting to a pole.
  - **Suggest complementary enhancements, and name mutually-exclusive ones.** Proactively
    identify features or improvements that would naturally pair with the requested feature
    (complementary — they increase its value) AND any that are mutually exclusive with it
    or with each other (conflicting approaches that cannot coexist — surface the trade-off
    so the user consciously picks one path). Per the AGENTS.md `## Output style` rule
    **Treat every request as production-bound, not a hobby project.**, default a _cohesive_
    complementary enhancement — one that serves the requested feature's user goal or
    surface, or whose absence would leave it partial — **into the build**, not a follow-up;
    the include-vs-defer test is cohesion, not size. Reserve separate-issue suggestions for
    genuinely separate features. These should be pragmatic, not scope creep.
  - **Rank recommendations** by: perceived customer value, technical complexity, likelihood
    of future debt, and composability.
  - **Require externally-failable acceptance criteria.** Each acceptance criterion — and each
    `it.todo()` spec you author in Step 3 — must name an externally-failable check: something
    that can fail without a human looking at it (a test that runs, a file in the expected shape,
    or a command exit code), not a self-review assertion like "it looks right". A criterion a
    machine cannot falsify provides no regression signal. This is a strong default with named
    exceptions, consistent with the same discipline in
    `skills/pipeline/flow-product-planning/references/discovery-instructions.md` "Draft the PRD": it
    defers to the genuinely-manual carve-out (subjective UX, cross-browser rendering,
    performance-under-load criteria are legitimately human-judgment), so do not force an author
    to fake an exit-code check for an irreducibly subjective item.
  - **Surface scout's anti-patterns.** When the scout's `## anti_patterns`
    section names off-limits surfaces or rejected approaches that
    intersect the feature, raise them in the analysis so the user
    sees the foreclosed paths alongside the recommended one.
  - **Surface prompt-interpretation tension.** When `.flow-tmp/plan.md`
    exists (typical when `/flow-pipeline` ran `/flow-product-planning` upstream)
    and contains a `## Prompt interpretation` section whose **Recommended
    path** is anything other than `methods plausibly reach target`, the
    upstream discovery flagged a tension between prescribed methods and
    the stated target (see
    `skills/pipeline/flow-product-planning/references/discovery-instructions.md`
    "Prompt interpretation (conditional)" for the four-value enum). Add a
    **Prompt interpretation** row to the assessment table whose Assessment
    cell names the tension verbatim from plan.md and surfaces the
    Recommended path; if a parallel signal in the scout's `## anti_patterns`
    section names foreclosed-by-prescribed-method surfaces, mention that
    too. This is the downstream half of the AGENTS.md `## Output style`
    rule **Treat user prompts as evidence of intent, not exhaustive
    specifications.** — discovery flags the tension upstream, this step
    surfaces it before implementation kicks in so the user sees the gap
    alongside the recommendation. When plan.md has no `## Prompt
interpretation` section, or the section's Recommended path is
    `methods plausibly reach target`, omit the row entirely (the original
    six-row table is unchanged for no-tension prompts).
  - **Check for redundancy.** Fill the Redundancy row above by checking the request
    against existing capabilities — a skill, a helper, a config surface, or a prior
    feature — and cite the specific one it duplicates, or state none found. Customer
    value and Recommendation already carry the helps-the-user / is-it-necessary /
    is-there-a-better-way questions; this bullet adds only the redundancy dimension.
    This is the same obligation authored one site over in
    `skills/pipeline/flow-product-planning/references/discovery-instructions.md`'s
    **Necessity & redundancy** category — the two sites cross-link so the discipline
    is consistent whether the plan originates in discovery or in `/flow-new-feature`.
  - **Name the plan's weakest assumption.** Close the analysis with an adversarial
    self-critique that names the plan's single weakest assumption / biggest risk — "if this
    plan is wrong, here is the most likely reason". This is the load-bearing assumption whose
    failure would most likely sink the implementation, not a restatement of the assessment
    table; surface it before it ships silently into code. This mirrors the always-present
    `## Plan risks` section authored upstream in
    `skills/pipeline/flow-product-planning/references/discovery-instructions.md` "Plan risks"; the
    two self-critique sites cross-link so the discipline is consistent whether the plan
    originated in discovery or in this Critical Analysis. When `.flow-tmp/plan.md` already
    carries a `## Plan risks` line, reconcile against it rather than duplicating — confirm the
    named risk still holds or update it if scouting changed the picture.
  - **Reconcile the Decision analysis.** When `.flow-tmp/plan.md` carries a `## Decision analysis`
    section (omit-when-empty, so it is present only when discovery found ≥1 consequential diverging
    decision), read it and reconcile its ranked verdict against your post-scout findings — confirm
    the verdict still holds or update it if scouting changed the downstream picture, mirroring the
    `## Plan risks` reconciliation above. Omit this reconciliation entirely when plan.md has no
    `## Decision analysis` section.
  - **Read the plan's task contracts and reconcile scout deviations.** When Step 1b resolved a
    non-`absent` `PLAN_PATH`, read the plan's `# Task breakdown` per-task Contract blocks as part
    of the same single plan.md read as the `## Prompt interpretation` / `## Plan risks` /
    `## Decision analysis` sections above — never a second open. Reconcile any
    `PLAN-DEVIATION:`-prefixed bullets in the scout's `## open_questions` as **contract
    adjustments** — implement to the corrected interface the scout verified against the code —
    not as product risks; only a deviation that guts a task's intent escalates into the
    assessment table's risk rows. The reconciled contracts feed Step 5's edit-set composition
    (the optional `contract` / `acceptance` fields). Skip this bullet entirely when `PLAN_PATH`
    is `absent`.

## 3. Write `it.todo()` Test Specs

- Create the test file adjacent to the component or module being built.
- Write `it.todo()` entries that describe observable user outcomes — NOT implementation details.
- Group with `describe` blocks by user flow or component area.

  ```typescript
  import { describe, it } from "vitest";

  describe("UserProfilePage", () => {
    // Navigation
    it.todo("should navigate to /profile when the avatar menu item is clicked");

    // Display
    it.todo("should display the user's current username and email");
    it.todo(
      "should show a loading skeleton while profile data is being fetched",
    );

    // Editing
    it.todo("should enter edit mode when the username field is clicked");
    it.todo("should save the updated username when the save button is clicked");

    // Error states
    it.todo(
      "should display an error message when the username is already taken",
    );
    it.todo("should disable the save button when the username field is empty");
  });
  ```

## 4. Review with User

- Present both the **critical analysis** and the **`it.todo()` list** to the user.
- Iterate on missing scenarios, incorrect assumptions, or scope adjustments.
- **CRITICAL:** Do not proceed to implementation until the user approves both the critical
  analysis and the test specs.

## 4b. Seed PR Description

After the user approves the critical analysis and test specs, seed a PR description so the
PR tells a coherent story from the start — captures intent, not a post-hoc summary.
**If `.flow-tmp/pr-description-draft.md` exists** (left by `product-planning`): use it
as-is and skip to Step 5. Otherwise synthesize one with `## Why` / `## What` / `## Key
decisions` / `## User-facing changes` / `## Test Steps` sections (verify every factual
claim live per AGENTS.md's 'Verify factual claims before emitting them.' rule).

The **Test Steps** automation test: can I name (a) a fixture/setup, (b) one or more
deterministic assertions, and (c) an exit condition — all without subjective human
judgment? If yes, write the item as the runnable shell command, not manual prose. A
non-trivial UI change authors one `SUBJECTIVE: `-prefixed step per facet (or one overall
sign-off for a Visual-Spec-referencing PR) that the agent can never tick. Apply the
rubric's **Coverage breadth** (one check per distinct facet), **"Decompose a manual step by layer"** (route a backend contract to an integration test, keep only the genuine
browser remainder manual), and **Precondition concreteness** (spell out the exact how)
rules to every candidate item. Open the section with this HTML comment, copied verbatim,
between the heading and the first `- [ ]` item:

```html
<!-- flow:authoring-rubric — for each `- [ ]` item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->
```

Full section-by-section template, worked examples, and drafting rules (concise
non-implementation-terms "Why", user-terms "User-facing changes" with `none` for
pure-internal PRs, always-emit-the-heading, no-hard-wrap) in
[references/pr-description-authoring.md](references/pr-description-authoring.md). Save to
`.flow-tmp/pr-description-draft.md` (`mkdir -p .flow-tmp` first) and present to the user
for quick confirmation — do NOT block on it; "skip" or "later" proceeds to Step 5.

## 5. Implement the Feature

- **CRITICAL:** Do not write application code until both the critical analysis and test
  specs have been approved by the user.
- Read the required skills based on files being touched:
  - `.svelte` files — read the `svelte` skill
  - Test files — read the `flow-testing` skill
  - Tailwind / layout / theming — read the `tailwind-shadcn` skill
  - Database / migrations — read the `supabase-project` skill
- **Design for testability.** Structure code so that unit tests are straightforward:
  - Extract logic into pure functions testable without rendering components.
  - Use dependency injection for external services so they can be easily mocked.
  - Separate side effects (network calls, DOM mutations) from decision logic.
- Refer to the `it.todo()` list as a living checklist of acceptance criteria.

Decide whether to delegate edits to `/flow-coder` based on the **hybrid threshold**:

- **Trivially scoped edits** (≤1 file AND ≤30 LOC AND every file named in
  the prompt) skip `/flow-coder` and edit inline. Log a one-line reason in chat
  ("trivial scope: single file ≤30 LOC — editing inline") so the user can
  audit the decision in scrollback.
- **Wider scopes** delegate the per-edit `Edit`/`Write` work to `/flow-coder`
  via the Spawn procedure below. Log a one-line reason ("wider scope:
  spawning /flow-coder") so the user can audit.

### Spawn procedure (wider-scope path only)

1. Compose the **edit-set**. When Step 1b resolved a non-`absent`
   `PLAN_PATH`, compose it from the plan's per-task Contract blocks (as
   adjusted by Step 2's `PLAN-DEVIATION:` reconciliation); when no plan
   applies, fall back to composing from the `it.todo()` list and the
   scout's `## affected_modules` exactly as before. Each entry is a
   JSON-shaped object with three required fields:
   - `file` — repo-relative path of the file to edit.
   - `intent` — 1–2 lines naming what the edit is meant to achieve.
   - `expected_outcome` — 1–2 lines naming the observable post-edit
     state (what test should pass, what behaviour should change).

   On the plan-contract path each entry also carries two optional
   fields:
   - `contract` — the task's interface spec copied verbatim from its
     Contract block (Files / Interfaces / Call-site edits, or the
     change-type surgical form), with Step 2's contract adjustments
     applied.
   - `acceptance` — the task's runnable acceptance command.

   A task's `Files:` list routinely names more than one file — split
   such a task into one edit-set entry per file (each carrying that
   file's own `contract` slice). `acceptance` is task-grained, not
   file-grained: attach it only to the task's **final** entry (the
   `/flow-coder` edit-applier runs it once, after that last entry, not
   per-edit — see `references/coder-instructions.md` step 4). Earlier
   entries for the same task omit `acceptance` entirely.

   Both optional fields are absent on the no-plan fallback path —
   `/flow-coder` treats a bare triple exactly as today.

   Render the edit-set as a single JSON array — pass it to `/flow-coder` as
   the `EDIT_SET` argument.

2. **Design context (omit-when-absent).** When `.flow-tmp/plan.md`
   carries a `## Visual Spec` section, first **commit ONLY the
   foundation**: create-or-extend the repo-wide
   `.flow/design/foundation.md` from the `.flow-tmp/design/foundation.md`
   draft and commit it into the PR diff (the self-completing-manifest
   precedent — an agent-maintained committed contract). `spec.json` and
   the reference snapshot stay under `.flow-tmp/design/` (excluded via
   `.git/info/exclude`), never committed. Then pass the optional
   `DESIGN_CONTEXT` argument on the `/flow-coder` invocation (alongside
   `EDIT_SET`/`WORKTREE`), in one of these modes:
   - **foundation+spec mode** (plan carries `## Visual Spec`): the
     absolute paths of the committed `.flow/design/foundation.md` AND the
     ephemeral `.flow-tmp/design/spec.json`, plus the conform-every-edit
     instruction ("read both BEFORE the first UI edit and conform every
     edit to them").
   - **foundation-only mode** (no `## Visual Spec`, but a committed
     `.flow/design/foundation.md` exists AND the edit-set touches UI):
     the foundation path alone, same conform instruction.
   - **layout-only mode** (plan carries `## Layout Intent` but NO
     `## Visual Spec` and NO committed `.flow/design/foundation.md`):
     no committed foundation and no Visual Spec exist to seed
     `DESIGN_CONTEXT` up front, so this mode contributes only the same
     conform-every-edit instruction as the other modes — the Layout
     Intent body itself is attached exactly once, by the single append
     rule below, not by this bullet.

   **Layout append (applies in EVERY mode above).** When
   `.flow-tmp/plan.md` carries a `## Layout Intent` section, append its
   body verbatim inline to the `DESIGN_CONTEXT` argument exactly once,
   regardless of which mode fired above — this is the ONLY place the
   Layout Intent body is attached; the mode bullets above select the
   conform instruction and never append the body themselves — framed as
   a ratified Layout Intent — a structural constraint; conform every
   edit's layout to it and never silently drop it. Extraction is
   mechanical: extract from the `## Layout Intent` heading to the next
   `##` heading **or end-of-file, whichever comes first** — verbatim,
   never a paraphrase, never a partial grab (a truncated or over-grabbed
   extraction hands the coder malformed constraints; a lightweight plan
   that ends with `## Layout Intent` and has no following `##` still
   threads the whole section). Strip fenced code blocks (the ASCII topology diagrams)
   from the threaded body before appending — the diagram is a
   plan-review aid; only the normative prose reaches the implementer.

   Omit `DESIGN_CONTEXT` entirely only when the plan has NONE of a
   committed foundation, `## Visual Spec`, or `## Layout Intent` —
   non-UI pipelines see byte-identical spawn prompts. `/flow-new-feature` is
   the content source for the argument; `/flow-coder`'s wrapper only renders
   it into the `{{DESIGN_CONTEXT}}` placeholder of its spawn prompt.

3. Invoke `/flow-coder` in-process via the Skill tool, passing the edit-set
   plus the worktree path (and `DESIGN_CONTEXT` when step 2 produced
   one — omit the line entirely otherwise):

```

/flow-coder
EDIT_SET: [{...}, {...}]
WORKTREE: <absolute path>
DESIGN_CONTEXT: <optional — step 2's two-tier content, or omitted>

```

`/flow-coder` is itself a thin wrapper that spawns one **Independent
Edit-Applier Subagent** via the Task tool (the sixth named Task-tool
exemption — see `skills/pipeline/flow-pipeline/SKILL.md` "Hard
rules"). The subagent applies every edit in its own isolated context,
runs `flow-pre-commit --json` against the post-edit worktree, and
writes the structured artifact at
`<worktree>/.flow-tmp/coder-result.json`.

4. After `/flow-coder` returns, do a cheap existence check on the artifact:

```bash
test -s "$WORKTREE/.flow-tmp/coder-result.json" \
  || { echo "NEEDS HUMAN: coder-failed" >&2; exit 1; }
```

On missing or empty artifact, surface the failure to the caller —
the supervisor escalates `NEEDS HUMAN: coder-failed` rather than
retrying past the 1-retry cap.

5. Read the artifact body once and parse into a typed object. Reuse
   the parsed object across Step 6 (test implementation, when it needs
   to know which files were edited) and Step 7 (skills-used summary).
   Do not re-read.

   The artifact's `verify_status` is the literal `"pass"` or a
   head/tail-capped failure excerpt. On non-pass, surface the failure
   to the caller — `/flow-new-feature` does not retry inside its own
   wrapper; the parent supervisor decides escalation vs re-invoke.

## 5b. Annotate Diff (when applicable)

This step runs only after `/flow-coder` returns successfully (Step 5's wider-scope path) AND after `flow-open-pr` returns a PR number — the trigger contract is conjunctive on both pre-conditions, so a successful `/flow-coder` run with no open PR yet, or an open PR without a successful `/flow-coder` (i.e. the trivial-scope inline path that didn't go through `/flow-coder`), both no-op out of this step entirely. The intent is review-time-scoped per-hunk rationale that helps reviewers reason about non-obvious diff changes adjacent to where they appear; durable rationale still belongs in commit bodies and the PR body's `## Why` section.

Run `flow-annotate-pr <PR>` against the merged-to-base diff. The helper parses `git diff -U0 <merge-base>...HEAD`, evaluates three trigger rules per hunk — (a) hunk has ≥10 changed lines, (b) hunk is a mixed-add-delete restructure (≥4 `+` AND ≥4 `-` lines), (c) file's total changed LOC is ≥30 with per-file dedup (only the first non-trivial hunk in a ≥30-LOC file gets annotated via rule c) — ranks the matches by priority, caps the result via a floor(8)/ratio(50%)/ceiling(24) scaling formula (operator-overridable machine-wide via a `flowAnnotatePr` key in `~/.flow/config.json`), and emits a JSON envelope on stdout: `{candidates: [...], overflowBullet?: string}`. Each candidate carries `{file, line, end_line?, side: "RIGHT"|"LEFT", hunk_excerpt}` but NO `body` field — that is the agent's job.

For each candidate in the envelope, generate a 1-2-sentence rationale in casual tone (incomplete sentences permitted) explaining the non-obvious _why_ of the change at that location. Prefix the rationale with the literal `**why:** ` (Markdown bold + colon + space) and suffix it with `\n\n<!-- flow-intent-v1 -->` (newline-newline before the HTML-comment integrity suffix so the suffix is invisible in rendered Markdown). Construct the Finding[] JSON (each entry: `{file, line, end_line?, side, body}`) and pipe it to `flow-post-findings <PR>` (or write to `.flow-tmp/intent-findings.json` and pass via `--file`). `flow-post-findings` posts each annotation as an individual inline review comment via the `/comments` endpoint — same shape that `/flow-pr-review` uses for its findings, but with the `**why:** ` prefix marking these as author intent (not a Conventional Comments review finding).

When `overflowBullet` is present (more matched hunks than the resolved cap allows), append it to the PR body's `## Why` section. Read the current body with `gh pr view <PR> --json body --jq .body > .flow-tmp/pr-body.md`, append the overflow bullet under the existing `## Why` heading, then update with `gh pr edit <PR> --body-file .flow-tmp/pr-body.md`. This preserves the surplus rationale in durable form (the PR body survives the review-time-scoped trade-off named in `AGENTS.md` § Git workflow) when the inline annotation cap is hit.

Failure mode is **non-fatal**. `flow-open-pr` already succeeded before this step ran, so the PR is open and downstream steps can proceed. If `flow-annotate-pr` fails (synthesizing a malformed envelope, network glitch on `git`) or `flow-post-findings` fails (rate limit, transient gh failure), log one line to chat — `annotation post failed: <stderr first line>; PR is open, proceeding to Step 5c` — and proceed to Step 5c. Do not retry; do not block the pipeline.

The no-emoji rule from `AGENTS.md` § Output style applies to the generated rationale bodies. The body MUST NOT use Conventional Comments labels (`**issue:**`, `**suggestion:**`, `**nitpick:**`, `**praise:**`, `**question:**`, `**todo:**`) — those are reserved for `/flow-pr-review` findings, and reusing them here would confuse the reviewer-facing vocabulary. The `**why:** ` prefix is the only authorised label for these annotations.

## 5c. Register Local Follow-ups (when applicable)

When the implementation produces a side-effect the user must replicate on their
local machine after merge — a new helper added under `bin/` (so the home install
needs `flow install --upgrade`), a new local dependency, a stale config file to
delete — register a follow-up:

```bash
flow-followups add \
  --command "flow install --upgrade" \
  --reason "<why this matters post-merge>" \
  --auto    # only if the command is in the helper's allowlist
```

The supervisor (`/flow-pipeline` step 11) consumes the JSONL log: on the MERGED
path it executes allowlisted+auto entries and prints a `LOCAL FOLLOW-UPS:`
block; on GATED it lists them as deferred items in both the PR body
(`flow-followups pr-body-upsert`) and the terminal print
(`flow-followups run --note-only`); on NEEDS HUMAN it prints the deferred
block to scrollback only — escalation can fire before a PR exists, so the
PR body is not edited and the JSONL log is left on disk for a later resume
to consume. Do **not** execute the follow-up directly — that's the
supervisor's job, gated by the allowlist. See
`skills/pipeline/flow-pipeline/SKILL.md` step 11 for the contract.

Skip this step when the change has no user-visible local-machine side-effect
(pure code edits, doc-only changes, internal refactors).

## 6. Implement ALL Test Specs

- Return to the test file and implement **every** `it.todo()` entry. This is mandatory —
  the `it.todo()` specs ARE the acceptance criteria.
- Replace each `it.todo()` with a full `it()` containing test logic, assertions, and any
  necessary setup/teardown.
- Follow the patterns in the `flow-testing` skill (behavioral testing, accessible queries,
  `userEvent` over `fireEvent`, MSW for API mocking).
- Run the full test file: `npm run test -- <test-file>`.
- Confirm **all tests pass** and **no `it.todo()` entries remain**.
- If any spec is intentionally deferred, explicitly flag it to the user with a reason.

## 7. Skills Used

Summarize which skills were consulted during this feature implementation and why.
Present as a table:

| Skill    | Used? | Reason                           |
| -------- | ----- | -------------------------------- |
| svelte   | Yes   | Built new `.svelte` components   |
| testing  | Yes   | Implemented test specs           |
| ui       | No    | No layout or theming work needed |
| database | No    | Feature uses existing schema     |
| ...      | ...   | ...                              |

Include all skills from `.claude/skills/` that were relevant candidates. Only list skills
that were plausible for this feature — no need to explain why an obviously irrelevant skill
wasn't used for a UI-only change.

# Verification

- All `it.todo()` entries have been implemented as full `it()` tests
- `npm run test -- <test-file>` passes with no failures
- No `it.todo()` entries remain in the test file
- Critical analysis was reviewed and approved by the user before implementation
- Test specs were reviewed and approved by the user before implementation
- Any new environment variables have been added to `.env.example` with comments and safe defaults
- PR description draft exists (`.flow-tmp/pr-description-draft.md`) or user explicitly deferred it
- For wider-scope features: exactly one Task-tool call was made at the
  Step 1b scout site with `subagent_type: $SCOUT_SUBAGENT` (`flow-scout`,
  or the guarded `general-purpose` fallback);
  `.flow-tmp/scout.md` exists with the six expected sections
  (`## affected_modules`, `## relevant_tests`, `## public_api_surface`,
  `## open_questions`, `## recommended_strategy`, `## anti_patterns`);
  the wrapper's chat output is the subagent's 3–5-sentence both-sides
  summary (not a paste of the artifact).
- For trivially scoped features: no Task-tool call was made at the Step
  1b scout site; `scout.md` was not written; the wrapper logged a
  one-line trivial-scope reason.
- For wider-scope edits at Step 5: `/flow-coder` was invoked exactly once;
  `.flow-tmp/coder-result.json` exists with all five top-level keys
  (`edits`, `verify_status`, `rejected_alternatives`,
  `anti_patterns_found`, `summary`); the wrapper's transcript contains
  no per-edit `Edit`/`Write` prose for the wider-scope path.
- For trivially scoped edits at Step 5: no `/flow-coder` invocation; the
  wrapper logged a one-line trivial-scope reason and edited inline.
- Step 5b ran the annotator (or trivially-scoped: no annotations posted because no hunks matched rules a/b/c).

# Constraints

- NEVER proceed to implementation before user approves the `it.todo()` list.
- NEVER leave `it.todo()` entries unimplemented without explicit user approval and justification.
- NEVER skip the critical analysis step — even for seemingly simple features.
- NEVER write test specs that describe implementation details instead of observable outcomes.
- NEVER do codebase scouting in the wrapper's context on the wider-scope
  path — always spawn the subagent. The wrapper's job on that path is to
  compose the prompt, make one Task-tool call, and forward the subagent's
  summary. Loading reference docs, reading implicated source files, or
  drafting the assessment inline defeats the entire point of the refactor.
- NEVER make more than one Task-tool call **per spawn site** in a
  `/flow-new-feature` invocation. Two named spawn sites exist: Step 1b
  (scout, exemption #3) and Step 5 (`/flow-coder`, exemption #5 —
  delegated through `/flow-coder`'s own wrapper). Each fires exactly one
  Task call on its wider-scope path; multi-call fan-out at a single
  site is not authorised. If an artifact is missing after a spawn,
  surface the failure to the caller (e.g. `/flow-pipeline` retries by
  re-invoking `/flow-new-feature`, which counts as a fresh invocation with
  fresh one-shot Task calls at each site). The wrapper itself never
  retries — that would be a second Task call at the same site.
- NEVER read `.flow-tmp/scout.md` from the wrapper before Step 2. The
  main session reads it once at the top of Critical Analysis; reading
  it earlier (e.g. for an existence sniff that goes beyond `test -s`)
  would duplicate that read in the same context. After the Step 2
  read, do not re-read in subsequent steps.
- NEVER let the subagent own the `mkdir -p .flow-tmp/`. Single
  side-effect attribution site: the wrapper alone creates the directory.
  The subagent only writes the file. The main session only reads.
- NEVER do per-edit `Edit`/`Write` work in the wrapper's context on
  the wider-scope Step 5 path. The `/flow-coder` subagent owns those edits;
  inlining them defeats the migration's whole point.
