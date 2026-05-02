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
items. Each item is something a reviewer must run, click, or read to confirm
the change is safe. The pr-review skill will run any item that's a deterministic
shell command, tick the box, and inject the captured output as a `<details>`
evidence block under the item. -->

<!--
Example (gated — non-empty section):

- [ ] Run `npm run verify` — typecheck + tests pass.
- [ ] Open /portfolio with the seeded user — allocation chart renders.
- [ ] Cut the network mid-load — error state appears, no console errors.
-->
