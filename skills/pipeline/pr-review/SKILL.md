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

Helpers (installed globally by `flow setup` and on PATH):

- `flow-fetch-pr-review` — fetches PR metadata, description, changed files, review
  summaries, and inline comments from GitHub
- `flow-pr-diff` — wraps `gh pr diff <number>` and per-file caps each block at 300
  source lines (head 200 + tail 100) plus one marker line between them, so a
  truncated block emits at most 301 lines on the wire. Used at Step 3 so the four
  parallel review agents don't each receive a 50–100 KB raw diff in their prompt
  context; agents are already instructed to Read the changed files in full for
  surrounding context, so the diff is a "what changed at a glance" hint, not the
  source of truth.
- `flow-pr-static-analysis` — runs the consumer's installed static-analysis tools
  (semgrep for security, biome or eslint for lint, tsc for types, an existing
  Istanbul coverage report for coverage), parses each into a unified
  `{file, line, rule_id, confidence, severity, source}` shape, filters to PR-touched
  lines, and emits a single combined JSON envelope keyed by lens
  (`{security, types, coverage, lint, meta}`). Default `--min-confidence 80`. Used
  at Step 3 so each of the four review agents receives only the lens subset
  relevant to its role, instead of re-deriving the same low-level facts from raw
  diff inspection. Tool-presence detection is graceful: any missing tool produces
  `meta.<lens>.ran=false` + `skipped_reason` and the lens emits `[]`; the helper
  always exits 0.
- `flow-pre-commit` — auto-detects scope, runs format + checks, reports pass/fail
- `flow-reply-pr-comments` — batch-posts replies to PR review comments

If `flow setup` has not been run on this machine, fall back to `gh pr view`, `gh pr diff`,
and the project's npm scripts directly. The skill workflow is the value; the binaries are
just helpers.

Reference files (read on demand, not upfront):

- `references/review-checklist.md` — 3-part checklist: Universal (security, performance),
  Project-Specific (SvelteKit patterns), and Learned Patterns (grows from retrospectives).
  Read at Step 3 when preparing agent context.
- `references/conventional-comments.md` — labeling framework (praise/nitpick/suggestion/
  issue/todo/question) with decorations. Read at Step 3 when preparing agent context.
- `references/agent-prompts.md` — prompt templates for the 4 specialized review agents.
  Read at Step 3 when spawning agents.
- `references/manual-test-rubric.md` — depth rubric for the "Test Steps" criterion
  (happy/unhappy/edges + PR-type scenario menus). Read at Step 11 when evaluating
  description Testability.
- `references/report-template.md` — output format for the final report. Read at Step 12.

# Instructions

## 1. Parse the PR Identifier

Use `$ARGUMENTS` as the PR number or URL. If empty, ask the user. Extract the numeric PR
number from URLs like `https://github.com/owner/repo/pull/100`.

## 2. Fetch and Pre-Flight

Run the fetch helper:

```bash
flow-fetch-pr-review $ARGUMENTS
```

Then perform pre-flight checks on the output:

1. **Closed/merged**: If the PR state is `closed` or `merged`, tell the user and stop.
2. **Draft**: If the PR is a draft, warn the user ("PR is a draft — findings may change
   before it's ready for review") and continue.
3. **PR size**: Check additions + deletions from the metadata line:
   - 400–999 lines: note as a `suggestion (non-blocking)` in the final report
   - 1000+ lines: note as an `issue (non-blocking)` recommending the PR be split
4. Save the full fetch output — you'll need different sections at different steps.

## 3. Independent Multi-Agent Review

This is the core of the skill. You will spawn 4 specialized review agents in parallel,
each examining the PR from a different angle. Their independent perspectives catch more
than any single reviewer could.

**Task-tool fan-out is intentional.** This step ("Independent Multi-Agent Review")
spawns the four review agents via the Task tool. When `/pr-review` is loaded in-process
by `/flow-pipeline` (the supervisor's step 8), this fan-out is permitted by the named
Task-tool exception in `skills/pipeline/flow-pipeline/SKILL.md`'s "Hard rules" section
(itself anchored on this step's heading name, not its number, so it survives future
renumbering). Outside the supervisor context (e.g. invoked directly from a user session),
the Task tool is unrestricted, so the fan-out runs identically. Either path: four agents
in parallel, then merge.

**Preparation** (before spawning):

1. Read the PR description and changed files list from the fetch output. DO NOT read
   the review comments section yet — reviewing before seeing others' feedback eliminates
   anchoring bias and lets you independently validate what reviewers found.
2. Get the diff: `flow-pr-diff <number>`. The output is a per-file capped unified
   diff (default budget 300 source lines/file; truncated files emit head 200 + a
   `... [truncated N lines] ...` marker + tail 100, so at most 301 lines on the
   wire, with the marker pointing at `gh pr diff <number>` for the full view).
   Agents already Read each changed file in full for surrounding context, so
   capping the diff does not blind them — it just keeps each agent's prompt
   context bounded when fanning out.
3. Get the commit history with full messages (not just subjects):
   `gh pr view <number> --json commits -q '.commits[] | "\(.oid[0:7]) \(.messageHeadline)\n\(.messageBody)\n---"'`
   Per `AGENTS.md`, commit bodies are expected to capture the **why**, non-obvious design
   choices, and approaches that were tried and rejected. Use these as primary context for
   the review — they explain intent that the diff alone cannot convey. If a commit body
   is missing or only restates the diff, flag it in Step 11 as a `suggestion` so the
   author can backfill context in the PR description.
4. Run the static-analysis pre-digest and capture its JSON to scratch:

   ```bash
   mkdir -p .flow-tmp
   flow-pr-static-analysis <number> > .flow-tmp/static-analysis.json
   ```

   The helper runs semgrep (security), biome or eslint (lint), tsc (types), and the
   project's existing Istanbul coverage report (coverage), parses each into a unified
   shape, filters to PR-touched lines, and emits a single combined JSON envelope keyed
   by lens. (Lenses run sequentially today; gh-issue #101 tracks switching to genuine
   parallelism — the structural `Promise.all` wrapper is in place but the underlying
   `spawnSync` blocks.) Each lens subset is fanned out to the matching agent in the
   spawn step below. Tool-presence detection is graceful: any missing tool produces
   `meta.<lens>.ran=false` + `skipped_reason` and the lens emits `[]`; the helper
   always exits 0, so a repo with none of the tools installed is a no-op rather than
   an error. Read the JSON before spawning so the per-agent subsets can be templated
   in (the next sub-step):

   ```bash
   STATIC_ANALYSIS=$(cat .flow-tmp/static-analysis.json)
   ```

5. Read `references/agent-prompts.md` for the prompt templates.

**Spawn 4 agents in parallel**, each as a subagent. For each agent:

- Copy the shared context block from `references/agent-prompts.md`
- Fill in the template variables: `{{PR_NUMBER}}`, `{{PR_TITLE}}`, `{{PR_DESCRIPTION}}`,
  `{{COMMIT_MESSAGES}}` (full bodies from step 3), `{{CHANGED_FILES_LIST}}`, `{{DIFF}}`,
  `{{STATIC_ANALYSIS_FACTS}}`. For the static-analysis variable, substitute a single
  self-contained JSON object containing both the lens findings and the matching meta
  slice — agents are instructed to check `meta.<lens>.ran` so the substituted block
  needs both. Use this `jq` filter against `.flow-tmp/static-analysis.json` per agent:
  - Bug Detection: `jq '{findings: .types, meta: .meta.types}' .flow-tmp/static-analysis.json`
  - Security: `jq '{findings: .security, meta: .meta.security}' .flow-tmp/static-analysis.json`
  - Pattern/Consistency: `jq '{findings: .lint, meta: .meta.lint}' .flow-tmp/static-analysis.json`
  - Test Coverage: `jq '{findings: .coverage, meta: .meta.coverage}' .flow-tmp/static-analysis.json`
- Append the agent-specific section (Role, Process, False Positive Avoidance)
- Include paths to `references/review-checklist.md` and `references/conventional-comments.md`
  so agents can read them
- Instruct agents to treat commit bodies as author intent: a finding that contradicts a
  stated rationale should cite the commit and explain why the rationale doesn't hold,
  rather than assuming the author didn't consider the alternative.

The 4 agents:

| Agent                   | Focus                                                       | Checklist sections                          | Static-analysis lens |
| ----------------------- | ----------------------------------------------------------- | ------------------------------------------- | -------------------- |
| **Bug Detection**       | Logic errors, null deref, race conditions, broken contracts | Error Handling, Type Safety                 | `types` (tsc errors) |
| **Security**            | OWASP top 10, input validation, auth, secrets, injection    | Security                                    | `security` (semgrep) |
| **Pattern/Consistency** | AGENTS.md compliance, cross-cutting uniformity, dead code   | Consistency, Lifecycle/Cleanup, Composition | `lint` (biome/eslint) |
| **Test Coverage**       | Missing tests, untested edges, test quality, env setup      | Test Environment                            | `coverage` (Istanbul/c8/vitest) |

Each agent returns a JSON array of findings with: `file`, `line`, `end_line`, `label`,
`decoration`, `confidence`, `subject`, `body`.

Wait for all 4 agents to complete before proceeding.

## 4. Merge and Filter Findings

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

## 5. Retrospective

If the fetch output contained no inline review comments, this step is a no-op — record "No reviewer comments to retrospect against" for the report and skip to Step 6.

Otherwise, read the review comments from Step 2's fetch output. This is the self-improvement step.

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

## 6. Address Agent Findings

The multi-agent review exists to catch real issues — not to produce a report. For every
finding in the filtered set (Step 4), you must either fix it now or escalate it to a
durable tracker. Silently listing findings in the report without action is a failure mode.

**Pre-flight mode assertion (do not skip).** You are in fix-now mode — you MUST attempt
the edits. Specifically:

- Do **not** preemptively decide that a hook, permission rule, or read-only filesystem
  state will block writes. Don't assume one applies; attempt the edit and rely on the
  tool-call result.
- Do **not** infer a block from the worktree path (e.g. `flow-agent-*` worktrees are
  ordinary git worktrees; they have no special write protection).
- Make a real `Edit` / `Write` tool call. If — and only if — the tool returns an error,
  surface the verbatim error message to the user and ask how to proceed. Paraphrasing a
  refusal as "the hook denied edits" without an actual tool-call error is a fabrication
  and a verification failure.

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

## 7. Address Each Review Comment

If the fetch output contained no inline comments, this step is a no-op — skip to Step 8.

Otherwise, for each inline comment from the fetch output:

1. Open the referenced file at the specified line.
2. Read surrounding context to understand the comment fully.
3. Assess whether the feedback is valid and actionable.
4. If valid: implement the change (or an improved version if you see a better approach).
5. If not applicable: note the reason — you'll include it in the reply and report.

Push back on comments that are incorrect or would degrade code quality. Blindly accepting
every suggestion is worse than thoughtfully declining some.

## 7.5. Roadmap Mark-Shipped Sweep

Edit `docs/roadmap.md` in the worktree so the merged-state marker for the current PR (and
any drifted prior PRs) lands in this PR's own diff, not in a post-merge commit on `main`.
Carrying the flip in the PR diff is the project convention ("PR self-marks shipped before
merge, no post-merge drift") — see the `Auto-push exemption: pr-review` clause in
`AGENTS.md` for the authorising context.

If `docs/roadmap.md` doesn't exist in this repo, this step is a no-op — skip to Step 8.

### 7.5a. Self-mark the current PR's row

Read `docs/roadmap.md`. Find every line containing `(#$PR_NUMBER)` (the PR being reviewed).
For each match:

- **Table row** (line starts with `|`): locate the cell containing `(#$PR_NUMBER)` and
  replace its full contents with ` ✅ shipped (#$PR_NUMBER) ` — single leading and trailing
  space inside the cell pipes, matching the existing roadmap convention. Preserve all other
  cells verbatim.
- **`Status:` line** (line matches `^Status:`): replace the entire line with
  `Status: ✅ shipped (#$PR_NUMBER).`

If no line contains `(#$PR_NUMBER)`, log "no roadmap row for current PR; skipping
self-mark" and continue to 7.5b — many PRs (chores, hotfixes, dep bumps) aren't roadmap
items and that's fine. Do not create a row that didn't exist.

If multiple table rows match, flip all of them (a PR can legitimately span items). The
old `flow-roadmap-mark-shipped` helper refused ambiguous matches with exit code 2; that
defensive posture made sense for an out-of-process post-merge sweep but is unnecessary
here — the change is in the PR diff, so the human reviewer (or auto-merge gate) sees the
flip count before merge.

The edit is idempotent: rows already showing `✅ shipped (#$PR_NUMBER)` produce no diff.

### 7.5b. Sweep drifted rows from prior PRs

Find every line in `docs/roadmap.md` matching `🚧 in review (#N)` for any N other than
`$PR_NUMBER`. For each such N, look up the PR's state:

```bash
gh pr view N --json state -q .state
```

Branch on the result:

- `MERGED` — flip the row using the same cell-replacement rule as 7.5a (replace the cell
  containing `(#N)` with ` ✅ shipped (#N) `; replace any matching `Status:` line with
  `Status: ✅ shipped (#N).`).
- `OPEN` — leave the row untouched. The PR is in flight; another supervisor or the same
  PR's eventual `/pr-review` pass will mark it.
- `CLOSED` (without merge) — leave the row untouched. The roadmap may still be valid
  (the work might land via a different PR); a human can decide.
- `gh` non-zero / 404 (PR doesn't exist) — leave the row untouched. Don't error; some
  rows reference renumbered or deleted PRs and the sweep should be tolerant.

The sweep is bounded — typically 0–2 drifted rows in practice. Sequential lookups are
fine; do not parallelise.

### 7.5c. Commit handling

Step 7.5 only edits the file. The diff is included in whatever commit Step 8b produces:

- If pr-review made code fixes in Steps 6/7 and the roadmap edit is the only additional
  change, bundle into the same fix commit (Step 8b already permits batching).
- If the roadmap edit is the *only* change pr-review produced (clean PR with no findings,
  no comments to address), use commit message
  `chore(roadmap): mark Item N shipped (pr-review #$PR_NUMBER)` where `Item N` is the
  item number parsed from the matched row's `**Item N` token. If no item number can be
  parsed, use `chore(roadmap): mark row shipped (pr-review #$PR_NUMBER)`.
- If the sweep flipped additional rows beyond the self-mark, mention the count in the
  commit body: `Also swept N drifted row(s) for PRs already merged on main: #X, #Y`.

Do not commit yet — Step 8 owns the commit + push, and Step 8a's pre-commit checks must
run against the worktree state including this edit.

## 8. Run Pre-Commit Checks and Commit

Run the pre-commit checks with the PR number:

```bash
flow-pre-commit --pr <pr-number>
```

The helper auto-detects changed areas (frontend, backend, scripts), runs `npm run format`
first, then each check separately with structured pass/fail output.

A non-zero exit code means a check failed. Do not explain it away — investigate, fix the
issue, and re-run. Repeat until all checks pass. Run each check individually; never chain
with `&&`.

### 8b. Commit and push changes — auto, do not ask

Once checks are green, **commit and push any uncommitted changes from Steps 6/7
immediately**. Do not leave the working tree dirty for the user to clean up, and
do not stop after `git commit` waiting for confirmation to push. Both halves are
explicitly authorised by the `Auto-push exemption: pr-review` clause in `AGENTS.md`
— invoking `/pr-review` *is* the user's explicit instruction to commit *and* push.
The global no-auto-push default does not apply here; do not ask the user to
confirm. Failing to push leaves the inline-comment replies in Step 9 anchored to
a SHA the GitHub UI no longer has, which is the bug this exemption exists to
prevent.

- One commit per logical fix is fine, but a single batched commit is also fine — match
  what's clearest for the diff.
- Commit message: conventional-commits prefix (`fix:`, `chore:`, `refactor:`) +
  `(pr-review #<N>)` suffix in the subject, body explains the *why* (what the finding
  was), referencing the agent's category (e.g. "Bug-Detection", "Pattern-Consistency").
- If the PR is **still open**: commit on the PR's branch and `git push` to it — the
  inline comments in Step 10 will then anchor to a head SHA the new commit doesn't
  invalidate (use the pre-commit head SHA captured at Step 2).
- If the PR is **already merged**: switch to `main`, pull, commit there, and `git push`.
  Do not leave fixes stranded on a merged branch.
- The only acceptable reason to stop short of pushing is a failed push (CI, branch
  protection, network) — in that case, surface the error to the user. "I wasn't sure
  if I should push" is not a valid reason; the exemption removes the ambiguity.

### 8c. Run every runnable verification item and tick the boxes

After 8b's commit + push, run every runnable `- [ ]` item in the PR body, **regardless
of which section it lives under** — `Test Steps` is the canonical heading flow
templates emit, but legacy or hand-edited PRs may still use `Manual validation`,
`How to test`, `Manual smoke`, or other variants. The classification below is
per-item, not per-section. The format note in 11b promises reviewers that
checkbox state means something — leaving every box unticked after a successful
run breaks that contract and forces the next reviewer (human or agent) to
re-run everything from scratch.

> **Headings do not exempt items.** A section called "Test Steps" or any other
> manual-flavoured heading does not mean its items are off-limits to automation.
> The author's choice of heading reflects intent ("a human should sanity-check
> this end-to-end"), not impossibility. The architectural reason `## Test Steps`
> is the canonical heading is that the auto-merge gate parses it: zero
> unchecked `- [ ]` items ⇒ auto-merge, one or more ⇒ gated. The heading is
> load-bearing for the orchestrator, **not** a hands-off signal for the
> reviewer. Apply the runnable test below to every checkbox in the body. If an
> item is deterministic and exec'able from a terminal in this repo, you must
> run it, even when the section heading suggests human-only.

For each `- [ ]` item, classify before running:

- **Runnable**: a shell command, test invocation, build, or script with deterministic
  pass/fail from exit code, **including** items that involve scripted filesystem
  setup (`ln -s`, hand-editing a tracked file, `git add -f`) followed by a CLI
  invocation and an assertion on disk state, exit code, or stdout/stderr. Examples:
  `npm run test`, `npm run typecheck`, `RUN_INTEGRATION=1 npm run test -- foo`,
  `./scripts/foo.ts`, `curl localhost:3000/x` paired with a documented assertion,
  "edit `.gitignore`, create symlink, run `flow setup --upgrade`, confirm `1
  removed` and the symlink is gone."
- **Not runnable**: requires a browser, a deploy target, real human/UI judgment ("the
  modal animates smoothly"), production credentials, or external services (Slack post,
  Stripe redirect, real-LLM judgment). Leave unticked.

**Self-check before classifying anything as not-runnable**: am I about to invoke
phrases like "out of scope for an automated agent run", "the harness flagged this
as manual", or "this is the author's deliberate human sanity check"? If so, stop —
those are post-hoc excuses, not real signals. The bar is literal: can I exec this
from a terminal in this repo? If yes, run it.

For each runnable item:

1. Execute it exactly as written, capturing both stdout and stderr to a file
   (e.g. `bash -c 'cmd 2>&1' | tee .flow-tmp/evidence-<n>.txt; echo $? > .flow-tmp/exit-<n>`).
   Same discipline as Step 8 — a non-zero exit means investigate and fix the
   underlying issue, not explain it away.
2. If a fix is needed, make a **new commit** (do not amend the pushed commit per
   `AGENTS.md`) and `git push` before re-running.
3. On pass, the box gets ticked AND the captured output gets injected as a
   `<details>` evidence block immediately under the item — see the next sub-step.

### 8c.i. Inject evidence under each runnable item

Use `flow-inject-evidence` (installed by `flow setup` and on PATH) to perform
both the box-tick and the evidence injection in one idempotent edit. Save the
PR body to scratch first so all items can be applied to the same working copy:

```bash
mkdir -p .flow-tmp
gh pr view <number> --json body --jq '.body' > .flow-tmp/body.md

# For each runnable item, after running it:
flow-inject-evidence \
  --body-file .flow-tmp/body.md \
  --item '<regex matching the item line>' \
  --output-file .flow-tmp/evidence-<n>.txt \
  --exit-code "$(cat .flow-tmp/exit-<n>)"
```

The helper:

- Finds the first body line matching `--item` (a JS regex tested per-line).
- On exit code 0: ticks `- [ ]` → `- [x]`.
- On any exit code: inserts a `<details><!-- flow:evidence --><summary>Output
  (auto-captured <ts>; pass|FAILED exit N)</summary>...` block on the line below.
- On re-run: replaces the existing `<details>` block in place via the
  `<!-- flow:evidence -->` marker. Idempotent — running twice yields the same
  body.
- Trims output > 150 lines to head 100 + tail 50 with a count marker, so the
  PR body stays under GitHub's 65,536-char limit.

After every runnable item has been processed, write the body back in a single
edit:

```bash
gh pr edit <number> --body-file .flow-tmp/body.md
```

Apply the no-hard-wrap and preserve-existing-wrapping rules from 11e — the
helper only edits the matched item line and the immediately-following block.
Everything else in the body is preserved byte-for-byte.

The `<!-- flow:evidence -->` marker is **not** stripped by the auto-merge
gate. The gate counts unchecked `- [ ]` items only; injected evidence sits
under ticked items and never affects the gate decision.

Record unticked items in the report with a one-line reason
("requires browser session", "needs prod creds", "subjective UI judgment"). Do not
invent excuses for items you should run; the bar is "I literally cannot exec this
from a terminal in this repo."

If the PR has no checklist items in any section, this step is a no-op — the
missing-section case is handled by Step 11b/11e. If 11e later drafts new
items into either section, return here once on user confirmation to attempt to tick
the new items before producing the final report.

## 9. Reply to PR Comments

If there are no inline comments to reply to, this step is a no-op — skip to Step 10.

Otherwise, construct a JSON array of replies and pipe it to the reply helper:

```bash
echo '<json-array>' | flow-reply-pr-comments <pr-number>
```

Each entry: `{"comment_id": <id>, "body": "<reply>"}`.

Use a leading emoji for scannability:

- ✅ **Addressed** — terse confirmation. Include detail only if the fix differs from the
  suggestion.
- ⏭️ **Skipped** — brief justification for why no change was made.

Keep replies to 1-2 sentences. Don't repeat the comment back.

## 10. Post Findings to PR

This step runs on every invocation, including PRs that already have human or bot reviewer comments. Agents catch a different miss profile than human reviewers; suppressing them when comments exist would force readers to scrape the diff to discover what the agents found.

Post each finding as an **individual inline review comment**, not as a batched formal
review with an event wrapper. The formal-review wrapper creates a heavier-weight
"X reviewed your PR" entry with an Approved / Requested-changes / Commented banner that
is overkill for self-review.

Build a JSON array of findings (one entry per inline comment) and pipe it to
`flow-post-findings`:

```bash
echo '<findings-json>' | flow-post-findings <pr-number>
```

Each entry: `{"file": "src/foo.ts", "line": 42, "end_line": 48, "side": "RIGHT", "body": "<conventional-comment-body>"}`.

- `file` is the PR path (gh's wire field is `path`; the helper accepts either).
- `line` is the post-fix line number (the line as it appears in the PR's "after" view).
  For a single-line comment, this is *the* line. For a multi-line range, this is the
  range's **start** line (the top of the highlighted region).
- `end_line` is optional; include for multi-line ranges. When present, it must be `>= line`
  and is the **end** line (the bottom of the highlighted region). The helper maps these to
  GitHub's wire shape — `start_line=line` and `line=end_line` — and emits `start_side`
  matching `side`. Don't try to invert the order: passing the bottom as `line` and the top
  as `end_line` is rejected with `"end_line" must be >= "line"`.
- `side` is optional, default `"RIGHT"` (the new file). Use `"LEFT"` only when commenting
  on a removed line.
- `body` uses the conventional comments format (label + decoration + subject + body). Do
  NOT include the confidence score in PR comments — it's internal.

The helper resolves the PR's head SHA via `gh pr view --json headRefOid` (override with
`--head-sha <sha>` for tests), POSTs each finding to the
`repos/{owner}/{repo}/pulls/<n>/comments` endpoint with the right `-f` / `-F` flag mix,
and prints a per-finding pass/fail summary. Exit 0 when every finding posted, exit 1 when
any failed.

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

## 11. PR Description Quality Check

Evaluate the PR description for both accuracy and intent clarity. The description is the
first thing a reviewer reads — if it's missing, vague, or misleading, the review starts
from a deficit. This step acts as a safety net regardless of which skill created the description.

**Cross-check against commit messages.** The commit bodies from Step 3 should capture the
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
- **User-facing changes** — concrete user-observable deltas (or the literal `none` for pure-internal PRs)
- **Test Steps** — verification steps for reviewers, automated and manual (also the auto-merge gate signal: zero unchecked `- [ ]` items ⇒ auto-merge, one or more ⇒ gated)

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

**Testability has three fail subtypes** — record which one applies so the report reflects it:

- `Fail (missing)` — no "Test Steps" section at all, or a section with no concrete
  steps where a material change clearly needs them. A section with zero unchecked
  `- [ ]` items under the heading is **not** a failure — it's the explicit "no human
  verification needed; auto-merge" signal, valid for pure-internal changes (refactors,
  doc fixes, generated-code regens) and for runs where pr-review has already ticked
  every item.
- `Fail (shallow — happy-path only)` — steps exist but only cover the happy path on a
  material change that warrants unhappy/edge scenarios per the rubric
- `Fail (automatable — manual items should be tests)` — the **Test Steps**
  section, or **any other section in the body** (legacy `Manual validation`,
  `How to test`, `Manual smoke`, etc.), contains scenarios that pass the rubric's
  automation test (named fixture + deterministic assertion + exit condition, no
  subjective judgment). Manual is the fallback; default is automation. Scan every
  checkbox in the body — section heading is irrelevant; the rubric is per-item.
  Apply this when you can sketch the test in one or two sentences ("a
  `RUN_INTEGRATION=1` test that spawns the CLI, asserts the file exists and `jq`
  parses every line, then SIGTERMs the child").

Multiple subtypes can apply simultaneously (e.g. shallow *and* automatable). Record each.
The criterion fails for the 2+ threshold even if only one subtype applies.

When scoring Testability, consult `references/manual-test-rubric.md` — it defines
"material change", provides PR-type scenario menus (new data providers, migrations,
UI features, config changes), and includes the **Automate first** section listing what's
safely automatable vs genuinely manual. For non-material changes (pure internal refactors,
typo fixes), happy-path only is acceptable; do not over-prescribe.

**Format note (advisory, not a rubric criterion):** "Test Steps" should be a markdown
checklist (`- [ ]` items) so reviewers can tick steps off as they verify and the
auto-merge gate can count unchecked items. If the section is otherwise good but uses
plain bullets, do not flag it as a Testability failure — but when you draft or edit a
"Test Steps" section in Step 11e, always emit `- [ ]` items.

### 11c. Deployment Follow-Up Check

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
description (Step 11e) listing each action with the exact commands. This prevents "works
locally, breaks in prod" gaps.

### 11d. Accuracy Sync

Compare the current implementation (diff + any changes from Steps 6–7) against the description:

- Files or modules added that the description doesn't mention (only flag if they represent
  significant new capabilities, not supporting files)
- Capabilities described that were removed or substantially changed during implementation
  or review
- Architectural approach that differs from what was described (e.g., description says
  "client-side only" but implementation adds a server endpoint)

### 11e. Resolution

**Drafting conventions** (apply to every drafted/edited description in this step):

- Render "Test Steps" items as `- [ ]` markdown checkboxes.
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
  paths? edge cases?), and propose appending them to the existing "Test Steps"
  section.

  Show the user the focused diff — just the proposed additions to the test section, not
  the full description — with a one-sentence explanation of which categories are being
  added and why. On confirmation, edit the PR with the extended test section, preserving
  everything else in the description:

  ```bash
  gh pr edit <number> --body-file /dev/stdin <<'EOF'
  <original description with test section extended>
  EOF
  ```

- **Fail (missing)**: Draft a minimal "Test Steps" section tailored to the change,
  using the rubric's scenario menu for the relevant change type. Do not redraft the rest of
  the description.

  Show the user the focused diff — just the new test section — with a one-sentence
  explanation of why the added section is sufficient. On confirmation, edit the PR by
  inserting the new test section and preserving everything else in the description:

  ```bash
  gh pr edit <number> --body-file /dev/stdin <<'EOF'
  <original description with minimal test section added>
  EOF
  ```

- **Fail (automatable)**: Do NOT just edit the description. The fix is a **code change**:
  add automated tests that subsume the flagged manual items. List each automatable
  manual item with (a) the existing test file it should slot into (or the new file
  path) and (b) a one-or-two-sentence sketch of the assertions. Example:

  > - "verify `runner.pid` exists and matches printed PID" → add `it(...)` to
  >   `src/commands/run.detach.smoke.test.ts` reading `runner.pid` and asserting it
  >   equals the PID parsed from stdout (existing fixture suffices).
  > - "verify task ends `needs-human (runner-crashed)` after a phase throws" → new
  >   `it(...)` in the same file using a non-git `target_repo` + stub script;
  >   `findWorktreePath` throws, runner catch should rewrite status.

  Show the user the list with a one-sentence explanation. On confirmation, write the
  tests, run them (`npm test` / `RUN_INTEGRATION=1 npm test` as appropriate), and
  remove the now-automated bullets from the manual section of the PR description.
  Leave only items that genuinely require human judgment (per the rubric's
  "Genuinely manual" list).

  If the user declines or defers, surface the proposal as a `suggestion` finding in
  the report instead of silently dropping it.

**If 0 criteria fail, or 1 non-Testability criterion fails, and no accuracy issues**: Note
"PR description is accurate and communicates intent clearly" in the report.

**IMPORTANT**: Never update the description without showing the user a diff of what's
changing (focused on just the affected section is fine) and getting confirmation. The
description is the author's voice — edits should improve clarity, not impose a rigid
template.

**After any 11e edit that adds `- [ ]` test items** (fail-shallow or fail-missing
branches), re-run Step 8c against the newly added items to tick the runnable ones
before producing the final report. fail-automatable runs its own tests inline and
prunes the bullets, so it does not require re-entry.

## 12. Structured Report

Read `references/report-template.md` and produce the full report. This is the most
important output — the user needs a clear, at-a-glance summary of everything that happened.

Always produce this report, even when there are no findings or comments. The report format
covers: summary, findings (each annotated as **Addressed** or **Deferred with reason**),
review comments addressed, pre-commit check results, PR description quality, and
retrospective.

**The report MUST explicitly separate addressed vs deferred findings.** Never leave the
reader guessing which findings were silently skipped — every finding surfaced in Step 4
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
  duplicates in the final output, the filtering in Step 4 failed.
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
- When inline review comments existed: every comment is addressed or explicitly skipped with reason, replies are posted, and the retrospective + checklist update appear in the report (or the report records "No reviewer comments to retrospect against" when none existed)
- Findings posted as individual inline review comments via `gh api` on every invocation, including PRs that already have reviewer comments
- Roadmap self-mark + sweep performed (Step 7.5): when `docs/roadmap.md` exists, the current PR's row is flipped to `✅ shipped (#$PR)` if a row exists, and any `🚧 in review (#N)` rows whose PR is already MERGED are flipped in the same diff
- Pre-commit checks pass (run individually, not chained)
- PR description quality check completed
- Structured report produced using the template format
- **Report clearly labels each finding as Addressed or Deferred (+ reason) — no finding is
  silently dropped between Step 4 and the report**

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
  work that legitimately warrants a separate standalone agent session per the bar in Step 6.
  A deferral that lives only in the review report will be lost when the PR merges.
