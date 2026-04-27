---
name: pr-review
description: >-
  Perform multi-agent code review on pull requests and address existing review comments,
  using confidence-scored findings with conventional comment labels. Use when user says
  "review PR", "address PR comments", "PR feedback", "fix review comments", "code review",
  "review this PR", "check this PR", or provides a PR number/URL. Handles both standalone
  independent reviews and addressing existing review feedback from humans or bots.
context: fork
argument-hint: "PR-number-or-URL"
---

# Goal

Perform a thorough, multi-agent independent code review of a PR and (when present) address
all existing review comments — using conventional comment labels with confidence scoring,
running pre-commit checks, and producing a structured report. The skill improves over time
by learning from gaps between its findings and human reviewer feedback.

# When to Use

- User wants to address review comments on a PR (Copilot, human reviewers, etc.)
- User pastes a PR URL or number and asks for review or feedback
- User says "address PR feedback", "fix review comments", "review PR", "code review"
- User wants an independent code review before requesting human review
- User wants to verify a PR is ready to merge

# When NOT to Use

- For creating a new PR — use git commands directly
- For running pre-commit checks only — use the `verify` skill
- For code review not tied to a specific PR — just review the files directly

# Context

Scripts the consumer repo is expected to ship at `scripts/` (substitute the equivalent in
projects that name them differently):

- `scripts/fetch-pr-review.ts` — fetches PR metadata, description, changed files, review
  summaries, and inline comments from GitHub
- `scripts/pre-commit-checks.ts` — auto-detects scope, runs format + checks, reports pass/fail
- `scripts/reply-pr-comments.ts` — batch-posts replies to PR review comments

If a project doesn't have these scripts, fall back to `gh pr view`, `gh pr diff`, and the
project's npm scripts directly. The skill workflow is the value; the scripts are just
helpers.

- **Runtime:** When the project uses `#!/usr/bin/env bun` shebangs in `scripts/`, run with
  **Bun** — do not substitute `node`, `npx tsx`, or other Node runtimes.

Reference files (read on demand, not upfront):

- `references/review-checklist.md` — 3-part checklist: Universal (security, performance),
  Project-Specific (SvelteKit patterns), and Learned Patterns (grows from retrospectives).
  Read at Step 4 when preparing agent context.
- `references/conventional-comments.md` — labeling framework (praise/nitpick/suggestion/
  issue/todo/question) with decorations. Read at Step 4 when preparing agent context.
- `references/agent-prompts.md` — prompt templates for the 4 specialized review agents.
  Read at Step 4 when spawning agents.
- `references/manual-test-rubric.md` — depth rubric for the "How to test" criterion
  (happy/unhappy/edges + PR-type scenario menus). Read at Step 11 when evaluating
  description Testability.
- `references/report-template.md` — output format for the final report. Read at Step 12.

# Instructions

## 1. Parse the PR Identifier

Use `$ARGUMENTS` as the PR number or URL. If empty, ask the user. Extract the numeric PR
number from URLs like `https://github.com/owner/repo/pull/100`.

## 2. Fetch and Pre-Flight

Run the fetch script:

```bash
./scripts/fetch-pr-review.ts $ARGUMENTS
```

Then perform pre-flight checks on the output:

1. **Closed/merged**: If the PR state is `closed` or `merged`, tell the user and stop.
2. **Draft**: If the PR is a draft, warn the user ("PR is a draft — findings may change
   before it's ready for review") and continue.
3. **PR size**: Check additions + deletions from the metadata line:
   - 400–999 lines: note as a `suggestion (non-blocking)` in the final report
   - 1000+ lines: note as an `issue (non-blocking)` recommending the PR be split
4. Save the full fetch output — you'll need different sections at different steps.

## 3. Determine Mode

The skill operates in two modes:

- **Address mode**: The fetch output contains inline review comments (look for the
  "Inline Comments" section with actual comments). This is the default when comments exist.
- **Review mode**: No inline review comments exist, OR the user explicitly asked for a
  "review" or "code review" (not "address comments" or "fix review comments").

If the PR has comments but the user's phrasing suggests they want a fresh review rather
than addressing comments, ask which mode they want.

Both modes share the independent review (Steps 4-5) and diverge after.

## 4. Independent Multi-Agent Review

This is the core of the skill. You will spawn 4 specialized review agents in parallel,
each examining the PR from a different angle. Their independent perspectives catch more
than any single reviewer could.

**Preparation** (before spawning):

1. Read the PR description and changed files list from the fetch output. DO NOT read
   the review comments section yet — reviewing before seeing others' feedback eliminates
   anchoring bias and lets you independently validate what reviewers found.
2. Get the full diff: `gh pr diff <number>`
3. Get the commit history with full messages (not just subjects):
   `gh pr view <number> --json commits -q '.commits[] | "\(.oid[0:7]) \(.messageHeadline)\n\(.messageBody)\n---"'`
   Per `AGENTS.md`, commit bodies are expected to capture the **why**, non-obvious design
   choices, and approaches that were tried and rejected. Use these as primary context for
   the review — they explain intent that the diff alone cannot convey. If a commit body
   is missing or only restates the diff, flag it in Step 11 as a `suggestion` so the
   author can backfill context in the PR description.
4. Read `references/agent-prompts.md` for the prompt templates.

**Spawn 4 agents in parallel**, each as a subagent. For each agent:

- Copy the shared context block from `references/agent-prompts.md`
- Fill in the template variables: `{{PR_NUMBER}}`, `{{PR_TITLE}}`, `{{PR_DESCRIPTION}}`,
  `{{COMMIT_MESSAGES}}` (full bodies from step 3), `{{CHANGED_FILES_LIST}}`, `{{DIFF}}`
- Append the agent-specific section (Role, Process, False Positive Avoidance)
- Include paths to `references/review-checklist.md` and `references/conventional-comments.md`
  so agents can read them
- Instruct agents to treat commit bodies as author intent: a finding that contradicts a
  stated rationale should cite the commit and explain why the rationale doesn't hold,
  rather than assuming the author didn't consider the alternative.

The 4 agents:

| Agent                   | Focus                                                       | Checklist sections                          |
| ----------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| **Bug Detection**       | Logic errors, null deref, race conditions, broken contracts | Error Handling, Type Safety                 |
| **Security**            | OWASP top 10, input validation, auth, secrets, injection    | Security                                    |
| **Pattern/Consistency** | AGENTS.md compliance, cross-cutting uniformity, dead code   | Consistency, Lifecycle/Cleanup, Composition |
| **Test Coverage**       | Missing tests, untested edges, test quality, env setup      | Test Environment                            |

Each agent returns a JSON array of findings with: `file`, `line`, `end_line`, `label`,
`decoration`, `confidence`, `subject`, `body`.

Wait for all 4 agents to complete before proceeding.

## 5. Merge and Filter Findings

Collect all agent findings and apply these filters:

1. **Confidence threshold**: Remove findings with confidence < 80. Praise is exempt.
2. **Deduplication**: If two findings reference the same file + overlapping line range +
   same issue class, keep the one with higher confidence. Two findings at the same location
   about different issues (e.g., null deref vs. injection risk) are NOT duplicates.
3. **Praise guarantee**: If no agent produced a `praise` finding, add one yourself based
   on something positive you observed in the PR (good naming, clean structure, thorough
   tests, etc.). Every review should acknowledge something done well.
4. **Sort**: Blocking findings first, then by file path, then by line number.

## 6. Retrospective (Address mode only)

NOW read the review comments from Step 2's fetch output. This is the self-improvement step.

1. **Map findings to comments**: For each reviewer comment, check if any agent finding
   covers the same file + line region and the same issue. A "match" means agents independently
   caught what the reviewer caught.
2. **Identify gaps**: Reviewer comments with no matching agent finding are gaps — things the
   multi-agent review missed.
3. **Classify gaps**: For each gap, identify the issue _class_ (e.g., "race condition in async
   cleanup", "missing error boundary"), not the specific instance.
4. **Evolve the checklist**: Check `references/review-checklist.md` for coverage of each gap
   class. If not covered, append a new pattern to Part 3 ("Learned Patterns") following the
   template at the bottom of the checklist. Include the PR number for traceability.
5. Record coverage stats for the report: "X of Y reviewer findings independently caught."

## 7. Address Each Review Comment (Address mode only)

For each inline comment from the fetch output:

1. Open the referenced file at the specified line.
2. Read surrounding context to understand the comment fully.
3. Assess whether the feedback is valid and actionable.
4. If valid: implement the change (or an improved version if you see a better approach).
5. If not applicable: note the reason — you'll include it in the reply and report.

Push back on comments that are incorrect or would degrade code quality. Blindly accepting
every suggestion is worse than thoughtfully declining some.

## 8. Run Pre-Commit Checks (Both modes)

Run the pre-commit checks with the PR number:

```bash
./scripts/pre-commit-checks.ts --pr <pr-number>
```

The script auto-detects changed areas (frontend, backend, scripts), runs `npm run format`
first, then each check separately with structured pass/fail output.

A non-zero exit code means a check failed. Do not explain it away — investigate, fix the
issue, and re-run. Repeat until all checks pass. Run each check individually; never chain
with `&&`.

## 9. Reply to PR Comments (Address mode only)

Construct a JSON array of replies and pipe it to the reply script:

```bash
echo '<json-array>' | ./scripts/reply-pr-comments.ts <pr-number>
```

Each entry: `{"comment_id": <id>, "body": "<reply>"}`.

Use a leading emoji for scannability:

- ✅ **Addressed** — terse confirmation. Include detail only if the fix differs from the
  suggestion.
- ⏭️ **Skipped** — brief justification for why no change was made.

Keep replies to 1-2 sentences. Don't repeat the comment back.

## 10. Post Findings to PR (Review mode only)

Post the filtered findings as a PR review. Group all comments into a single review
submission using `gh api`:

```bash
gh api repos/{owner}/{repo}/pulls/<number>/reviews \
  -f event="COMMENT" \
  -f body="<review-summary>" \
  --raw-field comments='[{"path":"file.ts","line":42,"body":"..."}]'
```

- If there are any `blocking` findings: use `event="REQUEST_CHANGES"` instead of `"COMMENT"`.
- Format each comment body using the conventional comments format (label + decoration +
  subject + body). Do NOT include the confidence score in PR comments — it's internal.
- The review summary body should include: count of findings by label, a note that findings
  below 80 confidence were suppressed, and a link to the conventional comments spec for
  readers unfamiliar with the format.

## 11. PR Description Quality Check (Both modes)

Evaluate the PR description for both accuracy and intent clarity. The description is the
first thing a reviewer reads — if it's missing, vague, or misleading, the review starts
from a deficit. This step acts as a safety net regardless of which skill created the description.

**Cross-check against commit messages.** The commit bodies from Step 4 should capture the
**why**, design-choice rationale, and dead ends. If a commit body states a meaningful
design decision (e.g. "chose X over Y because Z") and that rationale is missing from the
PR description's **Key decisions** section, flag it for inclusion — reviewers shouldn't
have to read commit-by-commit to reconstruct intent. Conversely, if commit bodies are
uniformly one-liners on a non-trivial PR, note it as a `suggestion` that future commits
should capture rationale inline (per `AGENTS.md` Committing rules).

### 11a. Structure Check

Check whether the PR description follows the standardized format with these sections:

- **Why** — problem statement and motivation
- **What** — deliverables as capabilities/behaviors
- **Key decisions** — non-obvious choices with rationale
- **How to test** — verification steps for reviewers

**If the description is empty or missing**: Draft one from the diff and PR title using the
format above. This is the highest-priority fix in this step.

**If the description exists but doesn't follow the format**: Do NOT restructure it. Instead,
evaluate it against the criteria in 11b using its existing structure.

### 11b. Intent Clarity Evaluation

Evaluate the description (regardless of format) against these criteria:

| Criterion                   | Pass                                                                                                     | Fail                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Motivation stated**       | Description explains why this change exists — the problem or need                                        | Description only says what was done, not why                                                     |
| **Scope is bounded**        | Clear what the PR delivers; a reader wouldn't expect more                                                | Vague enough that a reviewer might wonder "is X also included?"                                  |
| **Claims are accurate**     | Every capability/behavior mentioned in the description is present in the diff                            | Description mentions functionality that was removed, never implemented, or substantially changed |
| **No misleading specifics** | Implementation details mentioned in the description match the actual code                                | Description references specific approaches, file names, or patterns that don't match the diff    |
| **Testability**             | Specific, reproducible steps; happy path covered; for material changes, ≥1 unhappy/edge scenario present | Missing; vague ("verify it works"); or happy-path only for a material change                     |

Score each criterion as Pass/Fail. If 2+ criteria fail, the description needs an update.

**Testability has two fail subtypes** — record which one applies so the report reflects it:

- `Fail (missing)` — no "How to test" section at all, or a section with no concrete steps
- `Fail (shallow — happy-path only)` — steps exist but only cover the happy path on a
  material change that warrants unhappy/edge scenarios per the rubric

Both subtypes count as one failed criterion for the 2+ failures threshold.

When scoring Testability, consult `references/manual-test-rubric.md` — it defines
"material change" and provides PR-type scenario menus (new data providers, migrations,
UI features, config changes). For non-material changes (pure internal refactors, typo
fixes), happy-path only is acceptable; do not over-prescribe.

### 11c. Deployment Follow-Up Check

Scan the diff for changes that require manual follow-up outside the codebase. For each item
found, include exact commands (with `<PLACEHOLDER>` values matching `DEPLOYING.md` conventions)
so the deployer can copy-paste rather than hunt for syntax.

- **New environment variables** (`.env.example` additions):
  - Local: `<VAR>=<value>` in `.env`
  - Production: create secret + grant access + redeploy:
    ```bash
    echo -n "VALUE" | gcloud secrets create <VAR> --data-file=-
    PROJECT_NUMBER=$(gcloud projects describe <PROJECT_ID> --format='value(projectNumber)')
    gcloud secrets add-iam-policy-binding <VAR> \
      --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
      --role="roles/secretmanager.secretAccessor"
    gcloud run deploy <SERVICE_NAME> --region us-central1 \
      --image us-central1-docker.pkg.dev/<PROJECT_ID>/stax-data/proxy:latest \
      --set-secrets "...,<VAR>=<VAR>:latest"
    ```
- **New frontend build vars** (`VITE_*`): Set in Cloudflare Pages dashboard → Settings →
  Environment variables (both Production and Preview).
- **New allowlist files**: Verify `backend/Dockerfile` COPYs them into the image.
- **Database migrations**: `supabase db push` against the linked remote project.

If any follow-up items are found, include a **Deployment follow-up** section in the PR
description (Step 11e) listing each action with the exact commands. This prevents "works
locally, breaks in prod" gaps.

### 11d. Accuracy Sync

Compare the current implementation (diff + any changes from Step 7) against the description:

- Files or modules added that the description doesn't mention (only flag if they represent
  significant new capabilities, not supporting files)
- Capabilities described that were removed or substantially changed during implementation
  or review
- Architectural approach that differs from what was described (e.g., description says
  "client-side only" but implementation adds a server endpoint)

### 11e. Resolution

Based on 11a-11d:

**If the description is empty/missing**: Draft a complete description from the diff using
the standardized format. Show the user and ask for confirmation before applying.

**If 2+ intent clarity criteria fail OR significant accuracy issues exist**: Draft an
updated description preserving the original author's voice and structure where possible.
Show a before/after comparison with the failing criteria annotated. Ask for confirmation:

```bash
gh pr edit <number> --body-file /dev/stdin <<'EOF'
<updated description>
EOF
```

**If only Testability fails and the rest of the description is accurate**: Do NOT redraft
the description — the intent is clear, and only the test guidance needs adjustment. Branch
on the fail subtype:

- **Fail (shallow — happy-path only)**: Consult `references/manual-test-rubric.md`, pick
  the scenario menu that matches the change type, identify the missing categories (unhappy
  paths? edge cases?), and propose appending them to the existing "How to test" section.

  Show the user the focused diff — just the proposed additions to the test section, not
  the full description — with a one-sentence explanation of which categories are being
  added and why. On confirmation, edit the PR with the extended test section, preserving
  everything else in the description:

  ```bash
  gh pr edit <number> --body-file /dev/stdin <<'EOF'
  <original description with test section extended>
  EOF
  ```

- **Fail (missing)**: Draft a minimal "How to test" section tailored to the change, using
  the rubric's scenario menu for the relevant change type. Do not redraft the rest of the
  description.

  Show the user the focused diff — just the new test section — with a one-sentence
  explanation of why the added section is sufficient. On confirmation, edit the PR by
  inserting the new test section and preserving everything else in the description:

  ```bash
  gh pr edit <number> --body-file /dev/stdin <<'EOF'
  <original description with minimal test section added>
  EOF
  ```

**If 0 criteria fail, or 1 non-Testability criterion fails, and no accuracy issues**: Note
"PR description is accurate and communicates intent clearly" in the report.

**IMPORTANT**: Never update the description without showing the user a diff of what's
changing (focused on just the affected section is fine) and getting confirmation. The
description is the author's voice — edits should improve clarity, not impose a rigid
template.

## 12. Structured Report (Both modes)

Read `references/report-template.md` and produce the full report. This is the most
important output — the user needs a clear, at-a-glance summary of everything that happened.

Always produce this report, even when there are no findings or comments. The report format
covers: summary, findings (with confidence scores), review comments addressed, pre-commit
check results, PR description quality, and retrospective (address mode).

Commit any changes with a clear message referencing the PR number, then present the report.

# Anti-Patterns

- **Flagging style preferences**: Import order, semicolons, trailing commas — that's what
  linters are for. Don't waste the developer's time.
- **Raising hypothetical issues**: "This could theoretically fail if..." without a concrete,
  reachable code path is noise, not signal.
- **Reviewing pre-existing code**: Only review changes introduced by this PR. Pre-existing
  issues are a separate task.
- **Vague feedback**: "This could be better" without a concrete suggestion is unhelpful.
  Every issue must include a fix.
- **Duplicate findings across agents**: The merge step exists to prevent this. If you see
  duplicates in the final output, the filtering in Step 5 failed.
- **Suppressing all findings on small PRs**: Even a 10-line PR can have a security
  vulnerability. Size doesn't determine review depth.

# Verification

- Independent multi-agent review completed BEFORE reading reviewer comments
- All agent findings filtered to confidence >= 80 (praise exempt)
- At least one praise finding in the output
- Conventional comment format (label + decoration) used for all findings
- (Address mode) Retrospective in report comparing agent vs. reviewer findings
- (Address mode) Review checklist updated if gaps identified
- (Address mode) All review comments addressed or explicitly skipped with reason
- (Address mode) Replies posted to each review comment
- (Review mode) Findings posted as PR review via gh api
- Pre-commit checks pass (run individually, not chained)
- PR description quality check completed
- Structured report produced using the template format

# Constraints

- NEVER read review comments before completing the independent multi-agent review. This
  eliminates anchoring bias and lets you independently validate reviewer findings.
- NEVER surface findings with confidence below 80. Low-confidence findings erode trust.
  The one exception is `praise`, which is always surfaced.
- NEVER flag style issues, linter-catchable problems, or pre-existing issues unrelated to
  this PR. Only flag what matters.
- NEVER post a review without at least one praise observation. Reviews that only criticize
  feel adversarial and miss the opportunity to reinforce good patterns.
- NEVER blindly apply every reviewer suggestion. Push back on comments that are incorrect
  or would degrade code quality — explain why.
- NEVER skip the independent review step, even if the user only asked to "address comments."
  The independent review catches things reviewers miss.
- NEVER chain pre-commit checks with `&&`. Run each separately to see individual results.
- NEVER commit without running pre-commit checks first.
- NEVER update the PR description without showing the user the before/after diff and getting
  confirmation.
