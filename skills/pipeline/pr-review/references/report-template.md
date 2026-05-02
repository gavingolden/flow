# PR Review Report Template

Use this format for the structured report at the end of every PR review.

```
## PR Review Report — #<number>

### Summary

- **PR size**: +<additions> -<deletions> across <N> files
- **Agents**: 4 ran, <M> findings above 80 confidence, <P> praise observations
- **Blocking issues**: <count>
- **Inline review comments addressed**: <count> (or "none" when the PR had none)

---

### Findings

Group findings by file. Within each file, order by line number. Each finding MUST include
a **Status** line recording whether it was addressed in this run or deferred. Silent skips
are forbidden — every finding above the confidence threshold (or praise) appears here.

#### `path/to/file.ts`

**<label> (<decoration>): <subject>**
- **Line(s)**: L<start>–L<end>
- **Agent**: <Bug Detection | Security | Pattern/Consistency | Test Coverage>
- **Confidence**: <score>/100
- **Status**: ✅ **Addressed** — <1-line summary of the change, e.g. "renamed to findFromIndex"> · commit `<sha>`
  — OR —
- **Status**: ⏭️ **Deferred** — <1-sentence reason; bar criterion that applies (design decision needed; cross-cutting refactor; needs new test infrastructure)> · tracker entry: <link/anchor>
- **Details**: <explanation and suggestion, retained even after deferral so a future run can pick it up>

If no findings above threshold: "No significant issues found."

---

### Disposition Summary

Immediately after the Findings section, include a one-glance tally:

- **Addressed**: <N> (list file:line refs)
- **Deferred**: <N> (list file:line refs with short reason + tracker anchor)
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

### Manual Validation (from PR description)

Mirror the PR body's checklist with verification status. One line per item.

- [x] `<item as written>` — pass
- [x] `<item as written>` — pass (<count> passed, <count> skipped)
- [ ] `<item as written>` — not run: <one-line reason: requires browser, needs prod creds, subjective UI judgment, etc.>

If every item was ticked: "All items ticked — PR body updated."
If the section was missing: "No 'Manual validation' section to verify; flagged in 11b." If the section was empty (auto-merge state per the rubric): "Manual validation section empty — auto-merge state, no items to verify."

---

### PR Description Quality

- **Format**: Standardized / Non-standard / Missing
- **Intent clarity**:
  - Motivation stated: Pass / Fail
  - Scope is bounded: Pass / Fail
  - Claims are accurate: Pass / Fail
  - No misleading specifics: Pass / Fail
  - Testability: Pass / Fail (missing) / Fail (shallow — happy-path only)
- **Status**: No changes needed / Scenarios appended (pending confirmation) / Test section drafted (pending confirmation) / Updated (pending confirmation) / Drafted (was missing)
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
