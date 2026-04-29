---
name: pr-review
description: >-
  Perform multi-agent code review on pull requests and address existing review comments,
  surfacing confidence-scored findings with conventional comment labels and either fixing
  each finding now or deferring it to a tracker entry. Use when user says "review PR",
  "address PR comments", "PR feedback", "fix review comments", "code review", "review this
  PR", "check this PR", or provides a PR number/URL. Handles both standalone independent
  reviews and addressing existing review feedback from humans or bots.
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
  (happy/unhappy/edges + PR-type scenario menus). Read at Step 12 when evaluating
  description Testability.
- `references/report-template.md` — output format for the final report. Read at Step 13.

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
   is missing or only restates the diff, flag it in Step 12 as a `suggestion` so the
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
3. **Praise specificity**: A `praise` finding must name the specific behaviour,
   file:line, or pattern being praised — e.g. "the X path correctly handles the Y
   edge case", "the new pure helper at foo.ts:42 is straightforward to test".
   Drop content-free openers/closers ("great work!", "nice refactor!", "looks
   great overall!") before the report. Test: if removing the praise sentence
   removes no information a reviewer would act on, drop it. A specific praise of
   one thing is better than a generic praise of everything; zero praise is fine
   when no specific positive observation can be made.
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

## 7. Address Agent Findings (Both modes)

The multi-agent review exists to catch real issues — not to produce a report. For every
finding in the filtered set (Step 5), you must either fix it now or escalate it to a
durable tracker. Silently listing findings in the report without action is a failure mode.

**Default is fix-now.** Per `AGENTS.md` Hardening: "Fix security, reliability, and
correctness issues immediately — don't defer them. If a fix is complex enough to warrant
separate work, add a concrete task to the project's tracker (e.g., `ROADMAP.md`, GitHub
Issues, Linear) with enough detail to act on it immediately." Deferral that lives only in
the review report is a disappearing-task failure mode — review reports are ephemeral, the
tracker is durable.

**For each finding**, classify it into one of:

- **Auto-fix (default)** — fix it in this skill run. This is the expected path for almost
  all findings: dead imports/deps, unused files, trivially wrong names, missing guards,
  stale comments, adding a unit test, small bug fixes, error-toast additions, etc. If you
  can ship it in <30 lines of clear changes, fix it.
- **Defer + log** — only when the fix legitimately warrants a separate standalone agent
  session (see bar below). When you defer, you MUST log the item in the project's tracker
  (e.g., a `ROADMAP.md` "Followups" entry, a GitHub Issue, a Linear ticket) in the same
  commit that addresses the rest of the review. The deferral is not complete until the
  tracker entry exists. The review report alone is not a tracker.

**Do not silently skip findings.** Every finding must end in either a commit-with-fix or a
commit-with-tracker-entry. Praise findings are informational only — they do not need action.

**Bar for deferral — ALL must be true (otherwise fix it now):**

1. Fix requires meaningful design decisions or research that exceed the scope of "address
   this review" (e.g., picks an architectural direction, needs user input on intent).
2. Fix would expand the PR materially (touches >3 files as a cross-cutting refactor, OR
   requires new test infrastructure / harnesses, OR rewrites a non-trivial component).
3. The work is coherent enough to brief a future agent session in 1–2 sentences with a
   concrete trigger ("when X is next touched", "before Phase N starts", etc.).

Cosmetic edge cases, small bugs, and mechanical refactors do **not** clear this bar — fix
them now. "I don't want to expand the PR" is also not sufficient: a 5-line guard is not a
PR-expansion concern.

When deferring, the tracker entry must include:

- File/area + what the issue is (1 line)
- Why it was deferred (1 line — the bar criterion that applies)
- Concrete revisit trigger (e.g., "address opportunistically next time AppHeader is touched",
  "delete if no use materializes before the next layout-touching PR", "open an issue if
  the design call needs broader input")

After addressing, record for the report:

- **Addressed**: list of file:line refs with 1-line summary of the change.
- **Deferred**: list of file:line refs with the reason **and a link/anchor to the tracker
  entry** (e.g., `ROADMAP.md` section anchor, issue #, Linear ticket URL). A deferral
  without a tracker reference is a verification failure — go back and add the entry before
  producing the report.

## 8. Address Each Review Comment (Address mode only)

For each inline comment from the fetch output:

1. Open the referenced file at the specified line.
2. Read surrounding context to understand the comment fully.
3. Assess whether the feedback is valid and actionable.
4. If valid: implement the change (or an improved version if you see a better approach).
5. If not applicable: note the reason — you'll include it in the reply and report.

Push back on comments that are incorrect or would degrade code quality. Blindly accepting
every suggestion is worse than thoughtfully declining some.

## 9. Run Pre-Commit Checks and Commit (Both modes)

Run the pre-commit checks with the PR number:

```bash
./scripts/pre-commit-checks.ts --pr <pr-number>
```

The script auto-detects changed areas (frontend, backend, scripts), runs `npm run format`
first, then each check separately with structured pass/fail output.

A non-zero exit code means a check failed. Do not explain it away — investigate, fix the
issue, and re-run. Repeat until all checks pass. Run each check individually; never chain
with `&&`.

### 9b. Commit and push changes — auto, do not ask

Once checks are green, **commit and push any uncommitted changes from Steps 7/8
immediately**. Do not leave the working tree dirty for the user to clean up, and
do not stop after `git commit` waiting for confirmation to push. Both halves are
explicitly authorised by the `Auto-push exemption: pr-review` clause in `AGENTS.md`
— invoking `/pr-review` *is* the user's explicit instruction to commit *and* push.
The global no-auto-push default does not apply here; do not ask the user to
confirm. Failing to push leaves the inline-comment replies in Step 10 anchored to
a SHA the GitHub UI no longer has, which is the bug this exemption exists to
prevent.

- One commit per logical fix is fine, but a single batched commit is also fine — match
  what's clearest for the diff.
- Commit message: conventional-commits prefix (`fix:`, `chore:`, `refactor:`) +
  `(pr-review #<N>)` suffix in the subject, body explains the *why* (what the finding
  was), referencing the agent's category (e.g. "Bug-Detection", "Pattern-Consistency").
- If the PR is **still open**: commit on the PR's branch and `git push` to it — the
  inline comments in Step 11 will then anchor to a head SHA the new commit doesn't
  invalidate (use the pre-commit head SHA captured at Step 2).
- If the PR is **already merged**: switch to `main`, pull, commit there, and `git push`.
  Do not leave fixes stranded on a merged branch.
- The only acceptable reason to stop short of pushing is a failed push (CI, branch
  protection, network) — in that case, surface the error to the user. "I wasn't sure
  if I should push" is not a valid reason; the exemption removes the ambiguity.

## 10. Reply to PR Comments (Address mode only)

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

## 11. Post Findings to PR (Review mode only)

Post each finding as an **individual inline review comment**, not as a batched formal
review with an event wrapper. The formal-review wrapper creates a heavier-weight
"X reviewed your PR" entry with an Approved / Requested-changes / Commented banner that
is overkill for self-review and looks odd when findings are already addressed in the
same run.

For each per-line finding, POST to the **comments** endpoint (not the **reviews**
endpoint):

```bash
gh api repos/{owner}/{repo}/pulls/<number>/comments \
  -f commit_id="<head-sha>" \
  -f path="file.ts" \
  -F line=42 \
  -f side="RIGHT" \
  -f body="<conventional-comment-body>"
```

- `commit_id` is the PR head SHA (`gh pr view <n> --json headRefOid -q .headRefOid`).
- `line` is the post-fix line number (the line as it appears in the PR's "after" view).
- `side="RIGHT"` anchors to the new file; use `"LEFT"` only when commenting on a
  removed line.
- For multi-line ranges, add `-F start_line=<n>` and `-f start_side="RIGHT"`.
- Format each body using the conventional comments format (label + decoration + subject
  + body). Do NOT include the confidence score in PR comments — it's internal.

For the top-level review summary (counts by label, suppression note, conventional-comments
link), use a regular issue comment:

```bash
gh pr comment <number> --body-file <(cat <<'EOF'
<summary-body>
EOF
)
```

If there are any `blocking` findings, say so explicitly in the summary body — the
inline-comments approach has no equivalent of `event="REQUEST_CHANGES"`, so the user
needs to see the blocking flag in the summary itself.

## 12. PR Description Quality Check (Both modes)

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

### 12a. Structure Check

Check whether the PR description follows the standardized format with these sections:

- **Why** — problem statement and motivation
- **What** — deliverables as capabilities/behaviors
- **Key decisions** — non-obvious choices with rationale
- **How to test** — verification steps for reviewers

**If the description is empty or missing**: Draft one from the diff and PR title using the
format above. This is the highest-priority fix in this step.

**If the description exists but doesn't follow the format**: Do NOT restructure it. Instead,
evaluate it against the criteria in 12b using its existing structure.

### 12b. Intent Clarity Evaluation

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

**Format note (advisory, not a rubric criterion):** "How to test" should be a markdown
checklist (`- [ ]` items) so reviewers can tick steps off as they verify. If the section
is otherwise good but uses plain bullets, do not flag it as a Testability failure — but
when you draft or edit a "How to test" section in Step 12e, always emit `- [ ]` items.

### 12c. Deployment Follow-Up Check

Scan the diff for changes that require manual follow-up outside the codebase. For each item
found, include exact commands (with `<PLACEHOLDER>` values matching `DEPLOYING.md` conventions)
so the deployer can copy-paste rather than hunt for syntax.

- **New environment variables** (`.env.example` additions):
  - Local: `<VAR>=<value>` in `.env`
  - Production: create secret + grant access + redeploy. Read the secret via `read -s`
    (keeps it out of shell history) and bind a dedicated runtime service account rather
    than the default Compute SA (which is shared and Editor-by-default):
    ```bash
    read -s SECRET_VALUE && printf '%s' "$SECRET_VALUE" \
      | gcloud secrets create <VAR> --data-file=-
    unset SECRET_VALUE
    gcloud secrets add-iam-policy-binding <VAR> \
      --member="serviceAccount:<SERVICE_NAME>-runtime@<PROJECT_ID>.iam.gserviceaccount.com" \
      --role="roles/secretmanager.secretAccessor"
    gcloud run deploy <SERVICE_NAME> --region us-central1 \
      --image <ARTIFACT_REGISTRY_PATH>/proxy:latest \
      --service-account="<SERVICE_NAME>-runtime@<PROJECT_ID>.iam.gserviceaccount.com" \
      --set-secrets "...,<VAR>=<VAR>:latest"
    ```
    Create the runtime SA once with `gcloud iam service-accounts create <SERVICE_NAME>-runtime`
    if it doesn't already exist.
- **New frontend build vars** (`VITE_*`): Set in Cloudflare Pages dashboard → Settings →
  Environment variables (both Production and Preview).
- **New allowlist files**: Verify `backend/Dockerfile` COPYs them into the image.
- **Database migrations**: `supabase db push` against the linked remote project.

If any follow-up items are found, include a **Deployment follow-up** section in the PR
description (Step 12e) listing each action with the exact commands. This prevents "works
locally, breaks in prod" gaps.

### 12d. Accuracy Sync

Compare the current implementation (diff + any changes from Steps 7–8) against the description:

- Files or modules added that the description doesn't mention (only flag if they represent
  significant new capabilities, not supporting files)
- Capabilities described that were removed or substantially changed during implementation
  or review
- Architectural approach that differs from what was described (e.g., description says
  "client-side only" but implementation adds a server endpoint)

### 12e. Resolution

**Drafting conventions** (apply to every drafted/edited description in this step):

- Render "How to test" items as `- [ ]` markdown checkboxes.
- Do not hard-wrap prose at a fixed column width. Write each paragraph as a single line
  and let the renderer wrap it. GitHub renders one long line as one flowing paragraph;
  hard wraps go ragged the moment a sentence is edited and add no value.
- If you are editing an existing description that is hard-wrapped, do not reflow it just
  for formatting — preserve the author's wrapping. The no-hard-wrap rule applies to your
  own output, not to lines you are leaving untouched.

Based on 12a-12d:

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

## 13. Structured Report (Both modes)

Read `references/report-template.md` and produce the full report. This is the most
important output — the user needs a clear, at-a-glance summary of everything that happened.

Always produce this report, even when there are no findings or comments. The report format
covers: summary, findings (each annotated as **Addressed** or **Deferred with reason**),
review comments addressed, pre-commit check results, PR description quality, and
retrospective (address mode).

**The report MUST explicitly separate addressed vs deferred findings.** Never leave the
reader guessing which findings were silently skipped — every finding surfaced in Step 5
must appear in one of the two buckets. If no findings were deferred, say so explicitly
("No findings deferred").

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
- Any praise findings name a specific behaviour, file:line, or pattern; zero
  praise is acceptable when no specific positive observation meets the bar.
  Reviews containing only filler praise are worse than reviews with no praise.
- Conventional comment format (label + decoration) used for all findings
- **Every surfaced finding ends in either a code change (addressed) or a deferral with a
  concrete reason (no silent skips)**
- **Every deferred finding has a corresponding entry in a durable tracker (`ROADMAP.md`,
  GitHub Issue, Linear, etc.) committed in this run — the review report is not a tracker**
- (Address mode) Retrospective in report comparing agent vs. reviewer findings
- (Address mode) Review checklist updated if gaps identified
- (Address mode) All review comments addressed or explicitly skipped with reason
- (Address mode) Replies posted to each review comment
- (Review mode) Findings posted as PR review via gh api
- Pre-commit checks pass (run individually, not chained)
- PR description quality check completed
- Structured report produced using the template format
- **Report clearly labels each finding as Addressed or Deferred (+ reason) — no finding is
  silently dropped between Step 5 and the report**

# Constraints

- NEVER read review comments before completing the independent multi-agent review. This
  eliminates anchoring bias and lets you independently validate reviewer findings.
- NEVER surface findings with confidence below 80. Low-confidence findings erode trust.
  The one exception is `praise`, which is always surfaced.
- NEVER flag style issues, linter-catchable problems, or pre-existing issues unrelated to
  this PR. Only flag what matters.
- NEVER emit content-free praise filler ("great work!", "nice refactor!", "looks great
  overall!"). Praise findings must name a specific behaviour, file:line, or pattern; if
  no specific positive observation meets that bar, omit praise entirely. Filler praise
  wastes tokens for downstream agents reading the review with no informational payoff.
- NEVER blindly apply every reviewer suggestion. Push back on comments that are incorrect
  or would degrade code quality — explain why.
- NEVER skip the independent review step, even if the user only asked to "address comments."
  The independent review catches things reviewers miss.
- NEVER chain pre-commit checks with `&&`. Run each separately to see individual results.
- NEVER commit without running pre-commit checks first.
- NEVER update the PR description without showing the user the before/after diff and getting
  confirmation.
- NEVER end a run by "just reporting" findings — every surfaced finding must either be fixed
  in this run or explicitly deferred with a reason. The report must make that split visible.
- NEVER defer a finding without writing a corresponding tracker entry (`ROADMAP.md`, GitHub
  Issue, Linear ticket, etc.) in the same run. Default to fix-now; deferral is reserved for
  work that legitimately warrants a separate standalone agent session per the bar in Step 7.
  A deferral that lives only in the review report will be lost when the PR merges.
