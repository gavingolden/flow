# PR description authoring (Step 4b)

Full section-by-section authoring guidance for `flow-new-feature/SKILL.md`
Step 4b "Seed PR Description" — the synthesized-draft markdown template,
the Test Steps automation-test detail, and the drafting rules. The body
keeps only the heading, the one-line automation test, the
`flow:authoring-rubric` HTML comment template, and a pointer here.

**Proactive verification at the seed moment.** Before writing any factual
claim into the seeded PR description — a cited file path, line number,
function/flag name, commit SHA, version string, referenced PR number,
referenced issue number — verify the value live against its source
(`Read` the file at the exact path, `git rev-parse <ref>`, `gh pr view <n>
--json title,state,mergedAt` for a PR, `gh issue view <n> --json
title,state` for a plain issue, `grep -cE '<anchored>'`, `<verb>
--help`). The PR and issue lookups are distinct surfaces: `gh pr view`
against an issue number fails or surfaces the wrong record. Seeding a
proactively verified description means `/flow-pr-review` Step 11d's
post-hoc Accuracy Sync has nothing to fix up later. The canonical rule
body — full trigger-category list, anti-patterns, per-category
verification recipes — lives in `AGENTS.md` under the 'Verify factual
claims before emitting them.' rule (the bolded rule prefix is the stable
anchor; section structure can differ between flow's own `AGENTS.md` and a
consumer repo initialised from `templates/AGENTS.md.template`). Line
numbers themselves are a trigger category, so anchor by rule name rather
than by line.

**If `.flow-tmp/pr-description-draft.md` exists in the working
directory** (left by `product-planning`): use it as-is. It was already
distilled from a full PRD and approved by the user. Skip to Step 5.

**If no draft exists**, synthesize one from the critical analysis and
test specs:

````markdown
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
- Before → After: `flow install` (removed) → `flow install` (global install via symlink).

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
  test** from `skills/pipeline/flow-pr-review/references/manual-test-rubric.md` ("Automate
  first" section) to each candidate item _before_ you write it. The test:

  > Can I name (a) a fixture / setup, (b) one or more deterministic assertions, and
  > (c) an exit condition — all without subjective human judgment? If yes, this is
  > a runnable item, not manual prose.

  When the answer is yes, write the item as the deterministic shell command itself
  (`npm run test -- <file>`, `bun bin/<helper>.test.ts`, `gh pr view <n> --json …
--jq …`, `test -f <path>`, `grep -q <pattern> <file>`,
  `[ "$(cat <path>)" = "<expected>" ]`) so `/flow-pr-review` Step 8c can run it and tick
  the box. Manual prose survives only when the rubric flags the scenario as genuinely
  manual (subjective UX, production-only integrations, cross-browser rendering,
  performance under realistic load). A step whose only unmet preconditions are
  `local and reversible` (start the dev server, bring up / seed the local DB, set a
  local `.env` var, drive a headless browser) is `locally satisfiable` — write it as
  the runnable setup-plus-assertion, NOT pre-labeled "manual — needs the local
  stack"; see `references/manual-test-rubric.md` ("Genuinely manual") for the
  boundary. Authoring manual prose for an automatable
  scenario is the failure mode this contract exists to prevent — it surfaces as a
  `GATED:` end state where every unticked item could have been an exit-code check
  the agent ran itself.

  When the feature adds or alters **multiple distinct user-facing behaviors** (several
  facets, commands, or states), emit at least one end-user functional check per distinct
  change — not a single representative step that conflates them — so the checklist shows
  the full scope of new behavior and no facet can break silently because nothing asserted
  it. This is the breadth axis, orthogonal to the happy/unhappy/edge depth categories; each
  facet still routes through the automation test above (automate where automatable, manual
  only where genuinely manual — it is not a mandate to add manual prose). See
  `skills/pipeline/flow-pr-review/references/manual-test-rubric.md` ("Coverage breadth") for the
  requirement and a worked multi-facet example.

  For a non-trivial UI appearance change, author one `SUBJECTIVE: `-prefixed `- [ ]` Test
  Step per distinct UI facet (layout, animation, empty state, color/theme) that the agent
  can never tick on the user's behalf — a brand-new page built only from auto-tickable
  visual-appearance assertions would otherwise auto-merge with no aesthetic sign-off. Trivial
  tweaks (copy fix, padding nudge, icon swap) are exempt. Defer to
  `skills/pipeline/flow-pr-review/references/manual-test-rubric.md` ("Subjective checks") for the
  full contract, the include-vs-exempt test, and a worked example — do not inline the rule body.

  **Artifact-referencing PRs (the plan carries `## Visual Spec`) scope the two rules above
  differently** — mirroring discovery step 7's authoring rule in
  `skills/pipeline/flow-product-planning/references/discovery-instructions.md`: emit one enumerated
  `- [ ]` Test Step per Visual Spec assertion, tagged with its assertion id (e.g.
  `- [ ] [nav-active-weight] .nav a.active renders font-weight: 600 — verified by
  flow-design-spec diff`), plus **exactly one** overall `SUBJECTIVE: ` sign-off for the
  artifact-referenced surface. The per-assertion enumeration subsumes the per-facet breakdown,
  so do NOT also author per-facet `SUBJECTIVE: ` steps; the per-facet rule in the paragraph
  above is unchanged for artifact-less non-trivial UI changes, and a Visual Spec assertion is
  never `SUBJECTIVE: `-relabelled.

  Before writing any item as a browser-manual step, apply the layered-decomposition check:
  route a backend/API contract to a deterministic integration test, reserve the browser tier
  for assertions only a browser can make, and split a step that bundles the two — pushing each
  assertion to its lowest faithful layer. See
  `skills/pipeline/flow-pr-review/references/manual-test-rubric.md` ("Decompose a manual step by layer")
  for the rule and the econ-data #370 worked example.

  For whatever stays manual, spell out the exact how for every precondition the step states —
  name the command, click path, or setting that satisfies it, assuming no prior knowledge of
  project-specific toggles or jargon, and never a bare "turn X on" / "with X enabled" without
  the concrete steps. See
  `skills/pipeline/flow-pr-review/references/manual-test-rubric.md` ("Precondition concreteness")
  for the rule and a before/after example.

Open the `## Test Steps` section with this HTML comment, copied verbatim, between
the heading and the first `- [ ]` item. The auto-merge gate strips HTML comments
before counting so the marker is invisible to the count, and any later editor (an
agent re-running pr-review, a human pasting in steps) sees the same standard:

```html
<!-- flow:authoring-rubric — for each `- [ ]` item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->
```
````

Use as many items as the change warrants — a one-line fix may need one or
two; a new integration may need a dozen. Don't pad and don't truncate.
The pr-review skill will run any item that's a deterministic shell
command, tick the box on success, and inject the captured output as a
`<details>` block under the item; remaining `- [ ]` items are what gates
the merge.

Example (auto-merge — empty section):

<!-- No human verification needed — pure-internal change. -->

Example (gated — non-empty section, marker preserved):

<!-- flow:authoring-rubric — for each `- [ ]` item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `npm run test -- <test-file>` — all specs pass.
- [ ] Run `[ -f <path> ] && grep -q "<expected>" <path>` — config is wired.
- [ ] SUBJECTIVE: you approve the overall look and feel of the new <route> page

Save to `.flow-tmp/pr-description-draft.md` in the working directory.
Create the directory first with `mkdir -p .flow-tmp` if it doesn't already
exist — `/flow-pipeline` worktrees pre-register the path in
`.git/info/exclude` so it stays untracked, and a stray write at the
worktree root would block the post-merge `git worktree remove` in
`/flow-pipeline` step 10. Present the draft to the user for quick
confirmation before proceeding to implementation.

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
