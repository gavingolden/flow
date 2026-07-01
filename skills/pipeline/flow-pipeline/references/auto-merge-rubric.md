# Auto-merge rubric

The gate decision: should this PR auto-merge, or does it need a human to
perform validation steps before merging? The whole rule turns on a single
section of the PR body.

This file is the **single source of truth for the heading contract**:
which heading the gate keys on, what counts as "needs a human" vs.
"clear to ship", what the gate does on missing vs. empty vs. populated.
The supervisor's SKILL.md step 9 holds only the operational decision
matrix (PR state × autoMerge opt-out × section verdict → action) and
points back here for the parse contract. `/product-planning` and
`/new-feature` PR-description templates also defer to this file for
the canonical heading. The hand-author scaffold at
`.github/PULL_REQUEST_TEMPLATE.md` mirrors the same contract.

## The contract: `## Test Steps`

Every PR opened by `/new-feature` (and every PR-description draft from
`/product-planning`) includes a `## Test Steps` section, **unconditionally**.
The heading must always be present — it doubles as the test plan for
reviewers and as the gate signal. The section spans both automated
verification (e.g. `npm run verify`) and manual smoke steps; one heading,
one place to look.

The gate does **not** look at whole-section emptiness. It looks at one
question: are there any **unchecked `- [ ]` items** in the section?

- **No unchecked items** (empty body, only prose, only `- [x]` items,
  only `<details>` evidence blocks injected by `/pr-review`) — the
  change is either pure-internal (refactor, infra, doc fix,
  generated-code regen) or every item the author asked for has already
  been verified. Either way, no human action remains.
- **Has unchecked `- [ ]` items** — at least one verification step
  hasn't completed. A human must walk those items before merge.

The gate decides:

- **No unchecked items** → auto-merge.
- **Has unchecked items** → gated; surface the checklist to the user.
- **Heading missing entirely** → escalate
  `NEEDS HUMAN: test-steps-section-missing`. A missing heading
  signals an upstream regression (template drift, hand-edited PR), not
  a "no items left" state — silently auto-merging would ship PRs the
  user expected to be gated.

The user-facing rule is: "if you put unchecked validation steps in the
PR body, flow waits for you. If you don't (or once they're all
ticked), it ships."

### Why bullet-driven instead of body-emptiness

The gate used to fire on any non-empty content. That worked when nothing
else wrote to the section. Once `/pr-review` started injecting `<details>`
evidence blocks (captured stdout/stderr from each runnable item), a
naive "non-empty ⇒ gated" rule would always trip the gate — the
evidence makes the section non-empty by design.

Two alternatives were considered and rejected:

- **Hide evidence in HTML comments.** Defeats the point — comments
  don't render to humans. The whole reason to inject evidence is so a
  reader of the merged PR sees what was tested and what came back.
- **Tag evidence blocks with a marker the gate strips.** Workable but
  fragile — every new evidence consumer needs to register its marker
  shape. The bullet-driven rule is robust to any future evidence
  format because it doesn't ask "is there content?", it asks "is there
  an action item?"

Bullet-driven also aligns with the canonical convention. Every flow-emitted
template (`/new-feature`, `/product-planning`, `.github/PULL_REQUEST_TEMPLATE.md`)
already mandates `- [ ]` items; pr-review's drafting rules in 11e mandate
the same. The new gate just keys on the convention that was already in
force.

## A `gated` verdict is terminal, not advisory

When the gate returns `gated`, that verdict is **terminal** — not a
suggestion the `/flow-pipeline` supervisor may weigh against its own
judgment. The supervisor renders the GATED block, writes `phase: gated`,
and ends. On a `gated` verdict it must **not**:

- run `gh pr merge` on the PR on its own authority;
- reclassify the PR's unchecked Test Steps items to change the verdict —
  in particular, relabelling a **functional** manual check (a binary
  pass/fail observation: a popover opens, a button responds, a page
  renders) as **subjective UX** to wave it through is a prohibited move
  (see `skills/pipeline/pr-review/references/manual-test-rubric.md`,
  "Genuinely manual" → functional vs subjective);
- treat a "merge" / "ship it" instruction given _before_ the gate
  verdict was surfaced as authorisation to merge.

The gate's whole purpose is to stop a non-functional feature from
shipping while manual verification steps are still unchecked. An
unverified functional step means the feature has not been shown to work;
merging past it on the supervisor's own authority defeats that purpose.
The incident this contract exists for: a supervisor reached a correct
`gated` verdict (three unchecked manual steps, one a binary functional
check — "hover the legend entry, the popover opens"), reclassified them
as "subjective UX", and merged anyway on a stale instruction. The
feature was completely broken.

There are exactly two routes from `gated` to merged:

1. **A human merges the PR through GitHub.** Always correct — the human
   performed the validation the unchecked steps describe.
2. **A fresh, post-verdict gate override.** The user, in a _new_ turn
   _after_ the GATED block was surfaced, gives an unambiguous,
   in-context instruction to merge the gated PR anyway. The supervisor
   confirms once via `AskUserQuestion`, records the confirmation token
   (`flow-merge-guard --record-override`), and only then may step 10
   proceed — the `flow-merge-guard` step-10 backstop enforces this
   mechanically. The full contract is in
   `skills/pipeline/flow-pipeline/references/redirect-handling.md`
   "Gate override".

A stale or inferred instruction never qualifies for route 2.

## How to extract the section

Run:

```bash
gh pr view <pr> --json body --jq '.body'
```

Then apply this **four-step contract** — the heading-presence check is
not optional, because the unchecked-count check alone cannot distinguish
"section exists but has no unchecked items" (auto-merge) from "section
is missing entirely" (escalate, per the defensive cases below).

1. **Confirm the heading exists.** Grep the body for a column-0
   `^## Test Steps\s*$`. If not found, do **not** treat this as
   "no unchecked items" — escalate
   `NEEDS HUMAN: test-steps-section-missing` and end. A missing
   heading means a hand-edited PR or an upstream regression in the
   implement skill, and silently auto-merging would ship a PR the
   user might have expected to be gated.
2. **Find the section.** Match the heading at column 0:
   `^## Test Steps\s*$`. The section runs to the next `## ` heading
   at column 0, or to end-of-input.
3. **Strip HTML comments.** Remove every `<!-- ... -->` block
   (multi-line, non-greedy). Templates leave instructional comments
   inside the section that the user never sees rendered — they don't
   count toward the unchecked count.
4. **Count unchecked checkboxes.** Match `^[[:space:]]*- \[ \]` at
   the start of any line in the stripped section body. Zero matches
   ⇒ auto-merge. One or more matches ⇒ gated.

A one-liner that does all four — note the explicit `grep -q`
heading-presence check before extraction, so a missing heading exits
non-zero and routes to escalation rather than falling through to the
auto-merge path:

```bash
body=$(gh pr view <pr> --json body --jq '.body')

# Step 1: heading-presence check. Must run first; the count below
# returns 0 for both "heading missing" and "heading present but no
# unchecked items", so we cannot disambiguate downstream.
if ! printf '%s' "$body" | grep -Eq '^## Test Steps[[:space:]]*$'; then
  # Escalate: NEEDS HUMAN: test-steps-section-missing
  exit 2
fi

# Steps 2-4: extract, strip comments, count unchecked items.
unchecked=$(printf '%s' "$body" \
  | awk '/^## Test Steps[[:space:]]*$/{flag=1; next} /^## /{flag=0} flag' \
  | perl -0pe 's/<!--.*?-->//gs' \
  | grep -cE '^[[:space:]]*- \[ \]' || true)

# unchecked == 0  ⇒ auto-merge
# unchecked > 0   ⇒ gated
```

If `grep -q` failed: heading missing → escalate (do **not** treat as
"no unchecked items"). If it passed and `unchecked == 0`: auto-merge.
If `unchecked > 0`: gated.

`grep -c` exits non-zero when its count is zero, hence the trailing
`|| true` so the whole pipeline doesn't trip `set -e` on the
auto-merge path.

## The four PR states

`gh pr view <pr> --json state` returns one of `OPEN`, `MERGED`,
`CLOSED`. Combine with the unchecked-count result:

| PR state | Unchecked count | Decision                 | Action                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | --------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPEN`   | `0`             | **auto-merge**           | `(cd "$PRIMARY" && gh pr merge --squash <pr>)` (where `$PRIMARY` is the primary worktree path, so gh's post-merge `git checkout <base>` is a no-op there), then step 10.5, then render the MERGED block via `flow-gate-summary --status merged ...` (BEFORE the terminal state transition), then `flow-remove-worktree --delete-branch`, then write `phase: merged`, end. |
| `OPEN`   | `> 0`           | **gated**                | Write `phase: gated`. Print the validation checklist, the PR URL, and the manual-merge verb (`gh pr merge --squash <pr>`). End.                                                                                                                                                                                                                                           |
| `MERGED` | (any)           | **already-merged**       | The user merged externally (gated → merged path). Run step 10.5, then render the MERGED block via `flow-gate-summary --status merged ...` (BEFORE the terminal state transition), then `flow-remove-worktree --delete-branch`, write `phase: merged`, end.                                                                                                                |
| `CLOSED` | (any)           | **closed-without-merge** | Escalate: `NEEDS HUMAN: pr-closed-without-merge <url>`. Leave worktree intact (the user may want to reopen). End.                                                                                                                                                                                                                                                         |

## Defensive cases

These shouldn't happen on the happy path. If they do, escalate rather
than guess.

- **PR number missing.** The supervisor's step 5 (implement) captures
  the PR number from `flow-open-pr`. If it's empty here, something
  went wrong upstream — escalate `NEEDS HUMAN: pr-missing`.
- **Test-Steps heading missing.** The implement skill always writes
  the heading (with or without `- [ ]` items). A missing heading
  means a hand-edited PR or an upstream regression. Escalate
  `NEEDS HUMAN: test-steps-section-missing`. Treating a missing
  heading as "no unchecked items" would silently ship hand-edited PRs
  that the user might have expected to be gated.
- **`gh` non-zero exit or unparseable JSON.** Escalate `NEEDS HUMAN:
gh-error <stderr>`. Don't retry — gh failures here are typically
  auth or repo-permission issues that need human attention.

## Worked examples

**Auto-merge — empty section.** Pure-internal refactor; section reads:

```
## Test Steps

<!-- No human verification needed — pure-internal refactor. -->
```

After strip-and-count: 0 unchecked items. Decision: auto-merge.

**Auto-merge — pr-review-completed section.** Section reads:

```
## Test Steps

- [x] `npm run verify` — pass
  <details><summary>Output (auto-captured 2026-05-02T12:34:56Z)</summary>

  PASS bin/flow-foo.test.ts
  ✓ does the thing (4 ms)

  </details>
```

After strip-and-count: 0 unchecked items (the only checkbox is
`- [x]`, the `<details>` block contains no checkboxes). Decision:
auto-merge. The injected evidence is informational and does not gate.

**Gated.** UI-feature PR; section reads:

```
## Test Steps

- [x] `npm run verify` — pass
  <details>...</details>
- [ ] Open `/portfolio` with the seeded user — allocation chart renders
- [ ] Switch the time range to 1y — chart updates without a full reload
```

After strip-and-count: 2 unchecked items. Decision: gated. The
supervisor renders the GATED block via `flow-gate-summary` (see "How
the gate summary renders" below); stdout reads:

```
STATUS: GATED
PR: https://github.com/org/repo/pull/142
WHY: 2 unchecked test steps remain
NEXT ACTION: validate then run: gh pr merge --squash 142
  - Open `/portfolio` with the seeded user — allocation chart renders
  - Switch the time range to 1y — chart updates without a full reload
FOLLOW-UPS:
  LOCAL FOLLOW-UPS (deferred — PR not yet merged): 0 ran, 1 noted, 0 failed
  - [ ]   flow install --upgrade  # new helper landed (auto)
GATED: https://github.com/org/repo/pull/142
```

The `FOLLOW-UPS:` block is present only when `flow-followups run`
(or `flow-followups run --note-only`) produced output; it's silently
suppressed when the follow-ups log is empty. The slot is named
generically because the same captured block describes both deferred
(`--note-only`) and already-executed follow-ups; the embedded
`flow-followups` header row disambiguates them
(`LOCAL FOLLOW-UPS (deferred — PR not yet merged):` vs
`LOCAL FOLLOW-UPS:`).

End the turn.

## How the gate summary renders

The supervisor never emits the GATED / MERGED / NEEDS HUMAN /
CANCELLED block as ad-hoc prose. Every gate-emission site in
`skills/pipeline/flow-pipeline/SKILL.md` calls
`bin/flow-gate-summary.ts` (a thin Bun renderer with no side
effects); the helper carries the per-status template and the
`NEXT_ACTION_BY_REASON` mapping that keys each NEEDS HUMAN
escalation tag to a specific remediation line.

The **sentinel** line — `MERGED` / `GATED: <url>` / `NEEDS HUMAN:
<reason>` / `cancelled` — is byte-stable across the rewrite. It
remains the **final line** of every block, preserving the `# End
conditions` contract and any scrollback regex / `flow-stop-guard`
heuristics. The new template adds rows ABOVE the sentinel
(`STATUS:`, optional `PR:`, optional `WHY:`, `NEXT ACTION:`,
optional `FOLLOW-UPS:`); it does not replace the sentinel.

For the full template per status, see the worked example above (for
GATED) and the inline tables in
`skills/pipeline/flow-pipeline/SKILL.md` step 9, step 10, step 11,
the `# Failure paths` block, the branch-mismatch escalation, and
the task-tool-unavailable escalation (for the other statuses).

## Why this contract is small on purpose

The gate's whole job is one parse of one section. Anything richer
(checks for "this PR touches a migration file", "did the test suite
include integration tests", etc.) belongs in the implement skill's
own decision about which `- [ ]` items to seed in the section — not
here. The implement skill knows the diff; the gate doesn't need to.
