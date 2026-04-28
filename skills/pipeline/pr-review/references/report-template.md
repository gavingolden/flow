# PR Review Report Template

Use this format for the structured report at the end of every PR review. Sections marked
with a mode apply only to that mode — include all unmarked sections in both modes.

```
## PR Review Report — #<number>

### Summary

- **Mode**: Address / Review
- **PR size**: +<additions> -<deletions> across <N> files
- **Agents**: 4 ran, <M> findings above 80 confidence, <P> praise observations
- **Blocking issues**: <count>

---

### Findings

Group findings by file. Within each file, order by line number.

#### `path/to/file.ts`

**<label> (<decoration>): <subject>**
- **Line(s)**: L<start>–L<end>
- **Agent**: <Bug Detection | Security | Pattern/Consistency | Test Coverage>
- **Confidence**: <score>/100
- **Details**: <explanation and suggestion>

If no findings above threshold: "No significant issues found."

---

### Review Comments (<count> total)  [Address mode only]

For each comment, include:
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

### Retrospective  [Address mode only]

Compare the multi-agent independent review findings against the reviewer comments.

- **Agent coverage**: <X> of <Y> reviewer findings were independently caught by agents
- **Gaps identified**: <count>
  - **<issue class>** — should have been caught by <agent name> — checklist updated: Yes/No
- **Learning note**: <1 sentence summarizing what this review taught the checklist>

If no gaps: "No gaps identified — all reviewer findings were independently caught."
If this is a Review mode run: omit this section entirely.
```

## Size Warning Templates

Include these in the Summary section when applicable:

- 400-999 changed lines:
  `suggestion (non-blocking): This PR is on the large side (+<N> lines). Consider splitting future changes of this size into smaller, focused PRs for faster, more thorough reviews.`

- 1000+ changed lines:
  `issue (non-blocking): This PR is very large (+<N> lines). Large PRs receive slower, less thorough reviews and are harder to revert. Strongly consider splitting into smaller, atomic changes.`
