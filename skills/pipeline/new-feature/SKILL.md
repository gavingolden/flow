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

# Context

- Test files live adjacent to the component or module being built
- `it.todo()` naming format: `"should <expected observable behavior> when <trigger/condition>"`
- Skill consultation: before writing `.svelte` files, read the `svelte` skill. Before writing
  tests, read the `testing` skill. Before UI/layout work, read the `tailwind-shadcn` skill.
  Before database/migrations, read the `supabase` skill. (Names assume the canonical stack
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

## 2. Critical Analysis

- Before committing to implementation, perform a brief structured assessment. Present
  findings to the user as a table:

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

**If `pr-description-draft.md` exists in the working directory** (left by `product-planning`):
use it as-is. It was already distilled from a full PRD and approved by the user. Skip to Step 5.

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

## Manual validation

<Verification steps a human must perform before this PR can merge. The heading is also the
auto-merge gate signal — see
`skills/pipeline/flow-pipeline/references/auto-merge-rubric.md` for the full contract.
The short version: empty section ⇒ auto-merge; non-empty ⇒ gated.

Always emit the heading. Decide the body based on the change:

- Pure-internal change (refactor, infra, doc fix, generated-code regen) with no
  user-observable delta — leave the section empty under just a placeholder HTML
  comment. The rubric strips HTML comments before checking emptiness, so this is the
  auto-merge state.
- Otherwise — derive `- [ ]` items from the it.todo() specs. Each item is something a
  reviewer must run, click, or read to confirm the change is safe. Include the test command
  as one of the items. Use as many items as the change warrants — a one-line fix may need
  one or two; a new integration may need a dozen. Don't pad and don't truncate.

Example (auto-merge — empty section):

<!-- No human verification needed — pure-internal change. -->

Example (gated — non-empty section):

- [ ] Run `npm run test -- <test-file>` — all specs pass.
- [ ] Visit /foo with valid input — chart renders within 2s.
- [ ] Cut the network mid-load — error state appears, no console errors.>
```

Save to `pr-description-draft.md` in the working directory. Present the draft to the user
for quick confirmation before proceeding to implementation.

**Rules:**

- Do NOT block on the PR description — if the user says "skip" or "later", proceed to Step 5.
  The `pr-review` skill will catch missing descriptions.
- "Why" must focus on the user's problem, not the implementation approach.
- Keep it concise — this is a PR description, not a design doc.
- "User-facing changes" must be phrased in user terms (what someone running the tool will
  see or do differently), not implementation terms. If the PR has no user-observable
  delta, write `none` under the heading — never omit the heading itself.
- Always emit the `## Manual validation` heading, even for refactors. The auto-merge gate
  treats a missing heading as an upstream regression and escalates `NEEDS HUMAN`. An
  empty body under the heading is the auto-merge state; a populated body is the gate state.
- Render every "Manual validation" step as a `- [ ]` markdown checkbox so reviewers can tick
  items off as they verify.
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
  - Database / migrations — read the `supabase` skill
- **Design for testability.** Structure code so that unit tests are straightforward:
  - Extract logic into pure functions testable without rendering components.
  - Use dependency injection for external services so they can be easily mocked.
  - Separate side effects (network calls, DOM mutations) from decision logic.
- Refer to the `it.todo()` list as a living checklist of acceptance criteria.

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
- PR description draft exists (`pr-description-draft.md`) or user explicitly deferred it

# Constraints

- NEVER proceed to implementation before user approves the `it.todo()` list.
- NEVER leave `it.todo()` entries unimplemented without explicit user approval and justification.
- NEVER skip the critical analysis step — even for seemingly simple features.
- NEVER write test specs that describe implementation details instead of observable outcomes.
