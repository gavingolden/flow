# Auto-merge rubric

The gate decision: should this PR auto-merge, or does it need a human to
perform validation steps before merging? The whole rule turns on a single
section of the PR body.

This file is the **single source of truth for the heading contract**:
which heading the gate keys on, what "empty" means, what the gate does on
missing vs. empty vs. non-empty. The supervisor's SKILL.md step 9 holds
only the operational decision matrix (PR state × autoMerge opt-out ×
section verdict → action) and points back here for the parse contract.
`/product-planning` and `/new-feature` PR-description templates also
defer to this file for the canonical heading.

## The contract: `## Manual validation`

Every PR opened by `/new-feature` (and every PR-description draft from
`/product-planning`) includes a `## Manual validation` section,
**unconditionally**. The heading must always be present — it doubles as
the test plan for reviewers and as the gate signal. The body is empty
or populated based on whether human verification is required:

- **Empty body** (just an HTML-comment placeholder, or nothing) — the
  change is pure-internal (refactor, infra, doc fix, generated-code
  regen) and no human verification is required.
- **Populated body** (`- [ ]` items) — the change touches something
  risky (DB migration, external API integration, UI behaviour change,
  security-touching code, anything user-observable) and a human must
  walk the items before merge.

The gate reads this section and decides:

- **Empty** → auto-merge.
- **Non-empty** → gated; surface the checklist to the user.
- **Heading missing entirely** → escalate
  `NEEDS HUMAN: manual-validation-section-missing`. A missing heading
  signals an upstream regression (template drift, hand-edited PR), not
  an "empty" state — silently auto-merging would ship PRs the user
  expected to be gated.

The user-facing rule is: "if you put validation steps in the PR body,
flow waits for you. If you don't, it ships."

## How to extract the section

Run:

```bash
gh pr view <pr> --json body --jq '.body'
```

Then apply this **four-step contract** — the heading-presence check is
not optional, because steps 2-4 alone cannot distinguish "section
exists but trims to empty" (auto-merge) from "section is missing
entirely" (escalate, per the defensive cases below).

1. **Confirm the heading exists.** Grep the body for a column-0
   `^## Manual validation\s*$`. If not found, do **not** treat this
   as empty — escalate `NEEDS HUMAN: manual-validation-section-missing`
   and end. A missing heading means a hand-edited PR or an upstream
   regression in the implement skill, and silently auto-merging would
   ship a PR the user might have expected to be gated.
2. **Find the section.** Match the heading at column 0:
   `^## Manual validation\s*$`. The section runs to the next `## `
   heading at column 0, or to end-of-input.
3. **Strip HTML comments.** Remove every `<!-- ... -->` block
   (multi-line, non-greedy). The implement skill sometimes leaves
   instructional comments inside the section that the user never
   sees rendered — they don't count as content.
4. **Trim.** Empty result after trim ⇒ auto-merge. Non-empty ⇒ gated.

A one-liner that does all four — note the explicit
`grep -q` heading-presence check before the awk extraction, so a
missing heading exits non-zero and routes to escalation rather than
falling through to "empty ⇒ auto-merge":

```bash
body=$(gh pr view <pr> --json body --jq '.body')

# Step 1: heading-presence check. Must run first; awk's flag-loop
# returns the same empty output for "heading missing" and "heading
# present but section empty", so we cannot disambiguate downstream.
if ! printf '%s' "$body" | grep -Eq '^## Manual validation[[:space:]]*$'; then
  # Escalate: NEEDS HUMAN: manual-validation-section-missing
  exit 2
fi

# Steps 2-4: extract, strip comments, trim.
extracted=$(printf '%s' "$body" \
  | awk '/^## Manual validation[[:space:]]*$/{flag=1; next} /^## /{flag=0} flag' \
  | perl -0pe 's/<!--.*?-->//gs' \
  | tr -d '[:space:]')

# extracted=""  ⇒ auto-merge
# extracted=*   ⇒ gated
```

If `grep -q` failed: heading missing → escalate (do **not** treat as
empty). If it passed and `extracted` is empty: section is empty →
auto-merge. If `extracted` is non-empty: gated.

## The four PR states

`gh pr view <pr> --json state` returns one of `OPEN`, `MERGED`,
`CLOSED`. Combine with the section result:

| PR state | Section | Decision | Action |
|---|---|---|---|
| `OPEN` | empty | **auto-merge** | `gh pr merge --squash --delete-branch <pr>`, then `flow-remove-worktree`, then write `phase: merged`, print `MERGED`, end. |
| `OPEN` | non-empty | **gated** | Write `phase: gated`. Print the validation checklist, the PR URL, and the manual-merge verb (`gh pr merge --squash <pr>`). End. |
| `MERGED` | (any) | **already-merged** | The user merged externally (gated → merged path). Run `flow-remove-worktree`, write `phase: merged`, print `MERGED`, end. |
| `CLOSED` | (any) | **closed-without-merge** | Escalate: `NEEDS HUMAN: pr-closed-without-merge <url>`. Leave worktree intact (the user may want to reopen). End. |

## Defensive cases

These shouldn't happen on the happy path. If they do, escalate rather
than guess.

- **PR number missing.** The supervisor's step 5 (implement) captures
  the PR number from `gh pr view --json number`. If it's empty here,
  something went wrong upstream — escalate `NEEDS HUMAN: pr-missing`.
- **Manual-validation heading missing.** The implement skill always
  writes the heading (empty or full). A missing heading means a
  hand-edited PR or an upstream regression. Escalate `NEEDS HUMAN:
  manual-validation-section-missing`. Treating a missing heading as
  empty would silently ship hand-edited PRs that the user might have
  expected to be gated.
- **`gh` non-zero exit or unparseable JSON.** Escalate `NEEDS HUMAN:
  gh-error <stderr>`. Don't retry — gh failures here are typically
  auth or repo-permission issues that need human attention.

## Worked examples

**Auto-merge.** Refactor PR; section reads:

```
## Manual validation

<!-- Document any validation the reviewer should perform manually. Empty if none. -->
```

After strip-and-trim: empty. Decision: auto-merge.

**Gated.** DB-migration PR; section reads:

```
## Manual validation

- Confirm the migration ran cleanly against staging.
- Verify no rows lost from `users.email_verified`.
```

After strip-and-trim: non-empty. Decision: gated. Print:

```
GATED: manual validation required

PR: https://github.com/org/repo/pull/142

Steps:
  - Confirm the migration ran cleanly against staging.
  - Verify no rows lost from `users.email_verified`.

After validating, merge with: gh pr merge --squash 142
```

End the turn.

## Why this contract is small on purpose

The gate's whole job is one parse of one section. Anything richer
(checks for "this PR touches a migration file", "did the test suite
include integration tests", etc.) belongs in the implement skill's
own decision about whether to populate the section — not here.
The implement skill knows the diff; the gate doesn't need to.
