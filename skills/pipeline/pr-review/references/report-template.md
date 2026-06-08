# PR Review Report Template

Use this format for the structured report at the end of every PR review.

```
## PR Review Report — #<number>

### Summary

- **PR size**: +<additions> -<deletions> across <N> files
- **Agents**: 6 ran, <M> findings above 80 confidence, <P> praise observations
- **Blocking issues**: <count>
- **Inline review comments addressed**: <count> (or "none" when the PR had none)

---

### Findings

Group findings by file. Within each file, order by line number. Each finding MUST include
a **Status** line recording whether it was addressed in this run or deferred. Silent skips
are forbidden — every finding above the confidence threshold (or praise) appears here.

#### `path/to/file.ts`

The per-finding heading form is conditional on the label. For `praise`
findings — which carry no decoration (conventional-comments.md Rule 2) —
render `**praise: <subject>**` with no parenthesised decoration. For the
other five labels (`nitpick`, `suggestion`, `issue`, `todo`, `question`),
render `**<label> (<decoration>): <subject>**`.

**<label> (<decoration>): <subject>**  ← nitpick, suggestion, issue, todo, question
**praise: <subject>**  ← praise only
- **Line(s)**: L<start>–L<end>
- **Agent**: <Bug Detection | Security | Pattern/Consistency | Performance | Supply-Chain | Test Coverage>
- **Confidence**: <score>/100
- **Status**: ✅ **Addressed** — <1-line summary of the change, e.g. "renamed to findFromIndex"> · commit `<sha>`
  — OR —
- **Status**: ⏭️ **Deferred** — <1-sentence reason; bar criterion that applies (design decision needed; cross-cutting refactor; needs new test infrastructure)> · tracker entry: <`flow-create-issue` URL — e.g. https://github.com/owner/repo/issues/142 — or empty, with the deferral surfaced loudly here, when the repo has no GitHub Issues surface>
- **Details**: <explanation and suggestion, retained even after deferral so a future run can pick it up>

If no findings above threshold: "No significant issues found."

---

### Disposition Summary

Immediately after the Findings section, include a one-glance tally:

- **Addressed**: <N> (list file:line refs)
- **Deferred**: <N> (list file:line refs with short reason + tracker URL — `flow-create-issue` URL by default; when the repo has no GitHub Issues surface, the deferral is surfaced loudly here with no tracker URL)
- **Praise**: <N> (informational, no action required)

If Deferred is >0, this is the section the author scans to decide what to follow up on.
If Deferred is 0, say so explicitly: "All findings addressed in this run."

---

### Review Comments (<count> total)

For each existing inline review comment, include:
- **File / line**: `path/to/file.ts:42`
- **Reviewer**: who left the comment (e.g. "Copilot", a GitHub username)
- **Comment**: one-line summary of what they said
- **Action**: what you did — "Addressed: <description>" or "Skipped: <reason>"

If there were no review comments: "No review comments were found on this PR."

---

### Pre-Commit Checks

- format: pass/fail
- check: pass/fail
- lint: pass/fail (note any pre-existing warnings unrelated to the PR)
- test: pass/fail (<count> passed, <count> failed, <count> skipped)

---

### Test Steps (from PR description)

Mirror the PR body's checklist with verification status. One line per item.
Items promoted from author prose via 8c.ii append `(prose-promoted: <command>)`
so the audit trail names both the prose and the command the agent ran.

- [x] `<item as written>` — pass
- [x] `<item as written>` — pass (<count> passed, <count> skipped)
- [x] `<author prose>` — pass (prose-promoted: `<one-line shell command>`)
- [ ] `<item as written>` — not run: <rubric category: subjective UX | production-only | cross-browser | performance under realistic load | cost-prohibitive infra>

End the section with the **Automation-precedence audit line**:

```

Automation-precedence audit: ran N/M items (X prose-promoted, Y left manual: <reasons>)

```

Always emit the audit line, including when `M = 0`
(`Automation-precedence audit: ran 0/0 items (no Test Steps to verify)`). When
`Y = 0`, write `0 left manual` and omit the parenthetical reason list. See
`skills/pipeline/pr-review/SKILL.md` Step 12 for the field semantics.

When Step 11e's `Fail (automatable)` branch fires and converts manual checklist
items into automated tests (default-on), emit a second adjacent line naming each
converted bullet:

```

- Auto-converted N items per rubric: <comma-separated list of converted bullets>

```

Omit the line when no items were auto-converted in this run (the audit line above
still fires unconditionally). See `skills/pipeline/pr-review/SKILL.md` Step 12 for
the emit conditions and rubric-flaky-caveat fallback.

Worked example — both lines firing together on a run that ticked one runnable
item, prose-promoted one, left one manual, and auto-converted two manual items
into tests:

```

- [x] `unit tests pass` — pass (42 passed, 0 skipped)
- [x] `verify CLI flag handling` — pass (prose-promoted: `bun bin/foo --help`)
- [x] `verify runner.pid exists and matches printed PID` — auto-converted to test
- [x] `verify task ends needs-human after a phase throws` — auto-converted to test
- [ ] `confirm the toast feels right` — not run: subjective UX

Automation-precedence audit: ran 2/3 items (1 prose-promoted, 1 left manual: subjective UX)

- Auto-converted 2 items per rubric: "verify runner.pid exists and matches printed PID", "verify task ends needs-human after a phase throws"

```

If every item was ticked: "All items ticked — PR body updated."
If the section was missing: "No 'Test Steps' section to verify; flagged in 11b."
If the section had no unchecked items (auto-merge state per the rubric): "Test Steps section had no unchecked items — auto-merge state, no items to verify."

---

### PR Description Quality

- **Format**: Standardized / Non-standard / Missing
- **Intent clarity**:
  - Motivation stated: Pass / Fail
  - Scope is bounded: Pass / Fail
  - Claims are accurate: Pass / Fail
  - No misleading specifics: Pass / Fail
  - Testability: Pass / Fail (missing) / Fail (shallow — happy-path only)
- **Status**: No changes needed / Scenarios appended (pending confirmation) / Test section drafted (pending confirmation) / Updated (pending confirmation) / Drafted (was missing) / Manual items auto-converted (N items, redirect by replying)
- **Changes** (if updated): <1-2 sentence summary of what changed and which criteria drove it>

---

### Retrospective

Compare the multi-agent independent review findings against any existing reviewer comments.

- **Agent coverage**: <X> of <Y> reviewer findings were independently caught by agents
- **Gaps identified**: <count>
  - **<issue class>** — should have been caught by <agent name> — checklist updated: Yes/No
- **Learning note**: <1 sentence summarizing what this review taught the checklist>

If no gaps: "No gaps identified — all reviewer findings were independently caught."
If the PR had no inline review comments: "No reviewer comments to retrospect against."
```

## Size Warning Templates

Include these in the Summary section when applicable:

- 400-999 changed lines:
  `suggestion (non-blocking): This PR is on the large side (+<N> lines). Consider splitting future changes of this size into smaller, focused PRs for faster, more thorough reviews.`

- 1000+ changed lines:
  `issue (non-blocking): This PR is very large (+<N> lines). Large PRs receive slower, less thorough reviews and are harder to revert. Strongly consider splitting into smaller, atomic changes.`
