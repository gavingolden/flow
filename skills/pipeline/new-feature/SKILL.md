---
name: new-feature
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
- For refactoring without behavior change — use `/refactoring`
- For adding tests to existing code — use the `testing` skill directly

# How it works

This skill is a thin wrapper around a one-shot **Independent Scout
Subagent**. The wrapper itself does no codebase scouting — it spawns one
Task-tool subagent (`subagent_type: general-purpose`), passes the user's
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
`/product-planning`'s discovery; this is the analogous fix for
`/new-feature`.

The trade-off is intentional: the supervisor cannot refer back to the
scouting exploration in later steps. The contract that absorbs the
trade-off is `.flow-tmp/scout.md` itself — the supervisor reads it once
during Critical Analysis and never re-reads.

## Independent Scout Subagent

**Task-tool fan-out is intentional.** This step ("Independent Scout
Subagent") spawns one scout agent via the Task tool. When `/new-feature`
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
  tests, read the `testing` skill. Before UI/layout work, read the `tailwind-shadcn` skill.
  Before database/migrations, read the `supabase-project` skill. (Names assume the canonical stack
  skills installed by `flow setup`; substitute whatever your project uses.)

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
  or introduces a *new* sibling module / component / migration, route
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

1. Resolve the working directory absolutely. If the caller passed a
   `WORKTREE` value (typical when invoked from `/flow-pipeline`), use it.
   Otherwise use `pwd`. Define:
   - `SCOUT_PATH = <workdir>/.flow-tmp/scout.md`
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

3. Make exactly **one** Task-tool call:

   ```
   subagent_type: general-purpose
   description:   Scout for /new-feature
   prompt:        <the prompt template below, with variables filled in>
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

Fill in the five `{{...}}` placeholders before passing to the Task tool:
`INSTRUCTIONS_PATH`, `USER_DESCRIPTION`, `WORKTREE`, `SKILL_DIR`,
`SCOUT_PATH`.

```
You are the Independent Scout Subagent for `/new-feature`. You run in an
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

  | Criterion            | Assessment                                                          |
  | -------------------- | ------------------------------------------------------------------- |
  | Customer value       | _How much does this improve the user's workflow?_                   |
  | Technical complexity | _Rough effort estimate and what areas of the codebase are affected_ |
  | Debt risk            | _Does this follow existing patterns or introduce new ones?_         |
  | Composability        | _Can this design be easily extended, layered on, or reused?_        |
  | **Recommendation**   | **Proceed / Reconsider scope / Defer / Reject**                     |

- Within this analysis:
  - **Challenge the feature.** Don't just validate the user's idea. Identify potential
    downsides, over-engineering risks, or simpler alternatives.
  - **Consider alternatives.** Propose at least one alternative approach if one exists.
    Briefly explain the trade-off.
  - **Suggest complementary enhancements.** Proactively identify features or improvements that
    would naturally pair with the requested feature and significantly increase its value.
    These should be pragmatic suggestions, not scope creep.
  - **Rank recommendations** by: perceived customer value, technical complexity, likelihood
    of future debt, and composability.
  - **Surface scout's anti-patterns.** When the scout's `## anti_patterns`
    section names off-limits surfaces or rejected approaches that
    intersect the feature, raise them in the analysis so the user
    sees the foreclosed paths alongside the recommended one.

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
    it.todo("should show a loading skeleton while profile data is being fetched");

    // Editing
    it.todo("should enter edit mode when the username field is clicked");
    it.todo("should save the updated username when the save button is clicked");

    // Error states
    it.todo("should display an error message when the username is already taken");
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
PR tells a coherent story from the start. Writing the description before implementation
(rather than after) ensures it captures intent — not just a post-hoc summary of what was built.

**If `.flow-tmp/pr-description-draft.md` exists in the working directory** (left by
`product-planning`): use it as-is. It was already distilled from a full PRD and approved by
the user. Skip to Step 5.

**If no draft exists**, synthesize one from the critical analysis and test specs:

```markdown
## Why

<From the Critical Analysis: combine the Customer Value assessment with the user's original
feature description to explain what problem this solves and why it matters. 1-3 sentences,
no solution language.>

## What

<From the it.todo() specs: convert the top-level describe/it.todo groups into a bulleted list
of deliverables. Phrase as capabilities, not test names. Example: "should display loading
skeleton while fetching" becomes "Loading states during data fetches".>

## Key decisions

<From the Critical Analysis: include the Recommendation rationale, any alternatives that were
considered and rejected (with **why** they were rejected), and scope boundaries defined in
Step 1. Each bullet: decision + why. During implementation, if a non-obvious choice is made
or an approach is tried and abandoned, append it here and also capture it in the commit
body per `AGENTS.md` — so future reviewers and agents don't retrace dead ends.>

## User-facing changes

<Concrete user-observable deltas — phrase in user terms ("you can now run `flow ls --cost`"),
not implementation terms ("added cost column to the ls renderer"). Consider these
categories: new CLI commands or subcommands, new flags or changed defaults,
renamed/removed commands, changed prompts or output formats, new env vars, and changed
file locations users interact with. Derive each bullet from the matching `it.todo()` spec
that describes externally observable behaviour — every spec asserting an output, a CLI
surface, or a side effect users can see should produce a bullet here.

Format: freeform bullets. For renames or removals, use a `Before → After` bullet so the
delta reads at a glance. Example:

- New flag: `flow ls --cost` adds a `$` column summed across the supervisor session.
- Before → After: `flow install` (removed) → `flow setup` (global install via symlink).

If the change is pure-internal (refactor, infra, no user-observable delta), write the literal
word `none` under the heading. Never delete the heading — `none` is an explicit author
affirmation, while a missing heading is ambiguous between "no change" and "author forgot".>

## Test Steps

<Verification steps for this PR — both automated and manual smoke. The heading is also
the auto-merge gate signal — see
`skills/pipeline/flow-pipeline/references/auto-merge-rubric.md` for the full contract.
The short version: zero unchecked `- [ ]` items ⇒ auto-merge; one or more ⇒ gated.

Always emit the heading. Decide the body based on the change:

- Pure-internal change (refactor, infra, doc fix, generated-code regen) with no
  user-observable delta — leave the section empty under just a placeholder HTML
  comment. The rubric strips HTML comments before counting, so zero unchecked items
  ⇒ auto-merge.
- Otherwise — derive `- [ ]` items from the it.todo() specs, applying the **automation
  test** from `skills/pipeline/pr-review/references/manual-test-rubric.md` ("Automate
  first" section) to each candidate item *before* you write it. The test:

  > Can I name (a) a fixture / setup, (b) one or more deterministic assertions, and
  > (c) an exit condition — all without subjective human judgment? If yes, this is
  > a runnable item, not manual prose.

  When the answer is yes, write the item as the deterministic shell command itself
  (`npm run test -- <file>`, `bun bin/<helper>.test.ts`, `gh pr view <n> --json …
  --jq …`, `test -f <path>`, `grep -q <pattern> <file>`,
  `[ "$(cat <path>)" = "<expected>" ]`) so `/pr-review` Step 8c can run it and tick
  the box. Manual prose survives only when the rubric flags the scenario as genuinely
  manual (subjective UX, production-only integrations, cross-browser rendering,
  performance under realistic load). Authoring manual prose for an automatable
  scenario is the failure mode this contract exists to prevent — it surfaces as a
  `GATED:` end state where every unticked item could have been an exit-code check
  the agent ran itself.

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

Use as many items as the change warrants — a one-line fix may need one or two; a
new integration may need a dozen. Don't pad and don't truncate. The pr-review
skill will run any item that's a deterministic shell command, tick the box on
success, and inject the captured output as a `<details>` block under the item;
remaining `- [ ]` items are what gates the merge.

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
- [ ] Open /foo in dark mode — animation feels balanced (subjective UX, manual).
```

Save to `.flow-tmp/pr-description-draft.md` in the working directory. Create the
directory first with `mkdir -p .flow-tmp` if it doesn't already exist — `/flow-pipeline`
worktrees pre-register the path in `.git/info/exclude` so it stays untracked, and a stray
write at the worktree root would block the post-merge `git worktree remove` in
`/flow-pipeline` step 10. Present the draft to the user for quick confirmation before
proceeding to implementation.

**Rules:**

- Do NOT block on the PR description — if the user says "skip" or "later", proceed to Step 5.
  The `pr-review` skill will catch missing descriptions.
- "Why" must focus on the user's problem, not the implementation approach.
- Keep it concise — this is a PR description, not a design doc.
- "User-facing changes" must be phrased in user terms (what someone running the tool will
  see or do differently), not implementation terms. If the PR has no user-observable
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

## 5. Implement the Feature

- **CRITICAL:** Do not write application code until both the critical analysis and test
  specs have been approved by the user.
- Read the required skills based on files being touched:
  - `.svelte` files — read the `svelte` skill
  - Test files — read the `testing` skill
  - Tailwind / layout / theming — read the `tailwind-shadcn` skill
  - Database / migrations — read the `supabase-project` skill
- **Design for testability.** Structure code so that unit tests are straightforward:
  - Extract logic into pure functions testable without rendering components.
  - Use dependency injection for external services so they can be easily mocked.
  - Separate side effects (network calls, DOM mutations) from decision logic.
- Refer to the `it.todo()` list as a living checklist of acceptance criteria.

Decide whether to delegate edits to `/coder` based on the **hybrid threshold**:

- **Trivially scoped edits** (≤1 file AND ≤30 LOC AND every file named in
  the prompt) skip `/coder` and edit inline. Log a one-line reason in chat
  ("trivial scope: single file ≤30 LOC — editing inline") so the user can
  audit the decision in scrollback.
- **Wider scopes** delegate the per-edit `Edit`/`Write` work to `/coder`
  via the Spawn procedure below. Log a one-line reason ("wider scope:
  spawning /coder") so the user can audit.

### Spawn procedure (wider-scope path only)

1. Compose the **edit-set** from the `it.todo()` list and the scout's
   `## affected_modules`. Each entry is a JSON-shaped object with three
   fields:
   - `file` — repo-relative path of the file to edit.
   - `intent` — 1–2 lines naming what the edit is meant to achieve.
   - `expected_outcome` — 1–2 lines naming the observable post-edit
     state (what test should pass, what behaviour should change).

   Render the edit-set as a single JSON array — pass it to `/coder` as
   the `EDIT_SET` argument.

2. Invoke `/coder` in-process via the Skill tool, passing the edit-set
   plus the worktree path:

   ```
   /coder
   EDIT_SET: [{...}, {...}]
   WORKTREE: <absolute path>
   ```

   `/coder` is itself a thin wrapper that spawns one **Independent
   Edit-Applier Subagent** via the Task tool (the fifth named Task-tool
   exemption — see `skills/pipeline/flow-pipeline/SKILL.md` "Hard
   rules"). The subagent applies every edit in its own isolated context,
   runs `flow-pre-commit --json` against the post-edit worktree, and
   writes the structured artifact at
   `<worktree>/.flow-tmp/coder-result.json`.

3. After `/coder` returns, do a cheap existence check on the artifact:

   ```bash
   test -s "$WORKTREE/.flow-tmp/coder-result.json" \
     || { echo "NEEDS HUMAN: coder-failed" >&2; exit 1; }
   ```

   On missing or empty artifact, surface the failure to the caller —
   the supervisor escalates `NEEDS HUMAN: coder-failed` rather than
   retrying past the 1-retry cap.

4. Read the artifact body once and parse into a typed object. Reuse
   the parsed object across Step 6 (test implementation, when it needs
   to know which files were edited) and Step 7 (skills-used summary).
   Do not re-read.

   The artifact's `verify_status` is the literal `"pass"` or a
   head/tail-capped failure excerpt. On non-pass, surface the failure
   to the caller — `/new-feature` does not retry inside its own
   wrapper; the parent supervisor decides escalation vs re-invoke.

## 5b. Register Local Follow-ups (when applicable)

When the implementation produces a side-effect the user must replicate on their
local machine after merge — a new helper added under `bin/` (so the home install
needs `flow setup --upgrade`), a new local dependency, a stale config file to
delete — register a follow-up:

```bash
flow-followups add \
  --command "flow setup --upgrade" \
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
- Follow the patterns in the `testing` skill (behavioral testing, accessible queries,
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
  Step 1b scout site with `subagent_type: general-purpose`;
  `.flow-tmp/scout.md` exists with the six expected sections
  (`## affected_modules`, `## relevant_tests`, `## public_api_surface`,
  `## open_questions`, `## recommended_strategy`, `## anti_patterns`);
  the wrapper's chat output is the subagent's 3–5-sentence both-sides
  summary (not a paste of the artifact).
- For trivially scoped features: no Task-tool call was made at the Step
  1b scout site; `scout.md` was not written; the wrapper logged a
  one-line trivial-scope reason.
- For wider-scope edits at Step 5: `/coder` was invoked exactly once;
  `.flow-tmp/coder-result.json` exists with all five top-level keys
  (`edits`, `verify_status`, `rejected_alternatives`,
  `anti_patterns_found`, `summary`); the wrapper's transcript contains
  no per-edit `Edit`/`Write` prose for the wider-scope path.
- For trivially scoped edits at Step 5: no `/coder` invocation; the
  wrapper logged a one-line trivial-scope reason and edited inline.

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
  `/new-feature` invocation. Two named spawn sites exist: Step 1b
  (scout, exemption #3) and Step 5 (`/coder`, exemption #5 —
  delegated through `/coder`'s own wrapper). Each fires exactly one
  Task call on its wider-scope path; multi-call fan-out at a single
  site is not authorised. If an artifact is missing after a spawn,
  surface the failure to the caller (e.g. `/flow-pipeline` retries by
  re-invoking `/new-feature`, which counts as a fresh invocation with
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
  the wider-scope Step 5 path. The `/coder` subagent owns those edits;
  inlining them defeats the migration's whole point.
