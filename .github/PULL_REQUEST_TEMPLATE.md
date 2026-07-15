## Why

<!-- Problem statement: what motivated this change. 1-3 sentences. Avoid solution
language ("by adding X", "through implementing Y") — focus on the user's pain point. -->

## What

<!-- Bulleted list of deliverables phrased as capabilities or behaviors, not file paths.
Each bullet should be verifiable against the diff. -->

## Key decisions

<!-- Non-obvious choices and their rationale. Each bullet: the decision + why. Skip
obvious choices — only include where a reasonable alternative existed. -->

## User-facing changes

<!-- Concrete user-observable deltas in user terms ("you can now run X"), not
implementation terms ("added X to the renderer"). For renames or removals use
`Before → After` bullets. If the PR is pure-internal (refactor, infra, no
user-observable delta), write the literal word `none` here — never delete the
heading. -->

## Test Steps

<!-- Verification — automated and manual. Always emit the heading; the body controls
the auto-merge gate.

The contract (single source of truth: skills/pipeline/flow-pipeline/references/auto-merge-rubric.md):

- 0 unchecked `- [ ]` items ⇒ flow auto-merges this PR.
- 1+ unchecked `- [ ]` items ⇒ flow gates and waits for you to verify them.
- Heading missing ⇒ flow escalates `NEEDS HUMAN: test-steps-section-missing`.

For pure-internal changes (refactor, infra, doc fix) leave only this comment in
place — the section is empty after HTML-comment strip, so the gate auto-merges.

For changes that need human verification, replace this comment with `- [ ]`
items. Apply the **automation test** to each candidate item before you write it
(source of truth: skills/pipeline/flow-pr-review/references/manual-test-rubric.md
"Automate first" section): can you name (a) a fixture / setup,
(b) one or more deterministic assertions, and (c) an exit condition — all
without subjective human judgment? If yes, write the item as a deterministic
shell command (`npm run verify`, `test -f <path>`, `grep -q <pattern> <file>`,
`[ "$(cat X)" = "Y" ]`, `gh pr view <n> --json … --jq …`) so the pr-review
skill can run it and tick the box. Manual prose is the fallback, reserved for
genuinely manual scenarios (subjective UX, production-only integrations,
cross-browser rendering, performance under realistic load).

When you keep this section, paste the authoring-rubric marker between the
heading and the first `- [ ]` item so the rubric travels with the body:

<!-- flow:authoring-rubric — for each `- [ ]` item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

The pr-review skill will run any item that's a deterministic shell command,
tick the box, and inject the captured output as a `<details>` evidence block
under the item. -->

<!--
Example (gated — non-empty section):

- [ ] Run `npm run verify` — typecheck + tests pass.
- [ ] Run `test -f .flow-tmp/foo && grep -q "expected" .flow-tmp/foo` — config wired.
- [ ] Open /portfolio in dark mode — chart contrast feels right (subjective UX, manual).
-->
