---
name: pr-review
description: >-
  Perform multi-agent code review on pull requests and address existing review comments,
  surfacing confidence-scored findings with conventional comment labels and either fixing
  each finding now or deferring it to a tracker entry. Use when user says "review PR",
  "address PR comments", "PR feedback", "fix review comments", "code review", "review this
  PR", "check this PR", or provides a PR number/URL. Handles both standalone independent
  reviews and addressing existing review feedback from humans or bots.
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

# Fix-Applier Subagent

This skill spawns one **Fix-Applier Subagent** via the Task tool at Step 8 to
handle the per-finding address loop — Steps 6 (Address Agent Findings), 7
(Address Each Review Comment), 7.5 (Roadmap Mark-Shipped Sweep), plus the
pre-commit / commit / push that Step 8 used to own. The subagent does the
heavy lifting in its own isolated context: opening each cited file, drafting
fixes, running `flow-pre-commit`, committing, pushing, and re-running
`/verify` against the post-fix worktree. None of that material lives in this
skill's transcript; the only handoffs the wrapper sees are the Task-tool
envelope and a structured artifact at
`<worktree>/.flow-tmp/fix-applier-result.json`.

The supervisor session that loads this skill (typically `/flow-pipeline`
step 8, but also any direct caller) only ever sees:

1. The prose of this SKILL.md (the wrapper).
2. The Task-tool call's prompt and brief result envelope.
3. The one-paragraph summary the subagent returns.
4. One read of `.flow-tmp/fix-applier-result.json` body (Step 9), parsed
   once and reused across Steps 9, 10, 11, 12.

It never sees the per-finding fix prose, the per-comment file reads, the
`flow-pre-commit` transcript, or the `/verify` re-run. Those stay inside
the subagent's context. Same context-cost surgery PR #95 applied to
`/product-planning`'s discovery; this is the analogous fix for
`/pr-review`'s address loop.

The trade-off is intentional: the wrapper cannot refer back to the
fix-applier exploration in later steps. The contract that absorbs the
trade-off is `.flow-tmp/fix-applier-result.json` itself — its typed fields
(`commits`, `deferred`, `rejected_alternatives`, `anti_patterns_found`,
`summary`) are what Steps 9 / 10 / 11 / 12 consume.

## Independent Fix-Applier Subagent

**Task-tool fan-out is intentional.** This step ("Independent Fix-Applier
Subagent") spawns one fix-applier agent via the Task tool. When `/pr-review`
is loaded in-process by `/flow-pipeline` (the supervisor's step 8), this
fan-out is permitted by the named Task-tool exception in
`skills/pipeline/flow-pipeline/SKILL.md`'s "Hard rules" section (itself
anchored on this step's heading name, not its number, so it survives
future renumbering). Outside the supervisor context (e.g. invoked directly
from a user session), the Task tool is unrestricted, so the spawn runs
identically. Either path: one subagent, returns artifact on disk + a brief
summary.

**Verify re-run inside the subagent — load-bearing.** Unlike the discovery
subagent, the fix-applier re-runs `/verify` *after* applying fixes, before
returning. CI failures caused by the fix surface in-context where the fix
rationale is still live, not after the subagent exits and CI catches the
breakage in step 7 of `/flow-pipeline`. Skipping this re-run returns the
refactor to its pre-PR-95 shape.

**Negative-findings slots are required.** The artifact's
`rejected_alternatives` and `anti_patterns_found` arrays are not optional
decorations — they are the slots where the subagent records what it
learned should NOT be done. The spawn prompt below tells the subagent to
populate them proactively; the schema makes them required keys (empty
arrays are permitted only when the subagent genuinely encountered no
alternatives or anti-patterns).

## Spawn procedure

The wrapper spawns the subagent at Step 8. Before the spawn:

**Load the Task tool before spawning.** In Claude Code sessions where neither `Task` nor its alias `Agent` is surfaced top-level by the harness (both are aliases of the same one-shot subagent-spawn primitive: identical `subagent_type` / `prompt` / `description` schema), the spawn will silently fall through to in-line execution unless the schema is loaded first. Before the Task call below, run `ToolSearch query="select:Task"` and confirm the response contains either a `<function>{"name": "Task", ...}</function>` or a `<function>{"name": "Agent", ...}</function>` line. If it does not, **do not fall back to in-line execution** — escalate `NEEDS HUMAN: task-tool-unavailable: pr-review-fix-applier` and exit. Before exiting, write `<worktree>/.flow-tmp/pr-review-result.json` with `status: "escalated"` and `escalation_tag: "task-tool-unavailable: pr-review-fix-applier"` per the # Result artifact contract below (write-`.tmp` → validate-`.tmp` → `mv`). Worked example:

```bash
RESULT_PATH="$WORKTREE/.flow-tmp/pr-review-result.json"
cat > "$RESULT_PATH.tmp" <<'EOF'
{
  "status": "escalated",
  "completed_steps": ["1", "2", "3", "4", "5"],
  "missed_steps": ["6", "7", "7.5", "8", "8c", "9", "10", "11", "12", "13"],
  "escalation_tag": "task-tool-unavailable: pr-review-fix-applier",
  "summary": "Bailed at the Fix-Applier spawn-site preamble — neither Task nor Agent surfaced top-level in this session; supervisor must restart in a session where the alias is available."
}
EOF
bun bin/lib/pr-review-result-schema.ts --validate "$RESULT_PATH.tmp" \
  && mv "$RESULT_PATH.tmp" "$RESULT_PATH"
```

The fan-out's value is its context isolation; an in-line fallback breaks the contract that this exemption is justified by.

1. Resolve the working directory absolutely into a single shell variable
   `$WORKTREE` and use it everywhere downstream — never re-derive in any
   later step. If the caller passed a `WORKTREE` value (typical when
   invoked from `/flow-pipeline`), use it as-is. Otherwise, set
   `WORKTREE="$(pwd)"` explicitly so every subsequent `"$WORKTREE/..."`
   expansion has a defined value. Then derive the artifact path from it:

   ```bash
   WORKTREE="${WORKTREE:-$(pwd)}"
   ARTIFACT_PATH="$WORKTREE/.flow-tmp/fix-applier-result.json"
   ```

   `ARTIFACT_PATH` is the canonical handle for the artifact location;
   the boundary check in Step 8 and the body read in Step 9 both use it
   so the path lives in exactly one place.
2. Resolve the skill base directory absolutely. The Skill tool prints
   "Base directory for this skill" at the top of this SKILL.md when
   loaded — capture it as `SKILL_DIR`. Then derive:
   - `INSTRUCTIONS_PATH = <SKILL_DIR>/references/fix-applier-instructions.md`

   The subagent reads sibling references via absolute paths under
   `SKILL_DIR` (`references/conventional-comments.md`,
   `references/review-checklist.md`). Pass `SKILL_DIR` so the subagent
   never has to resolve those relative to its `cd`'d worktree, where they
   don't exist. Also create the consumer-side `.flow-tmp/` directory now
   (single side-effect attribution site for the parent dir; the subagent
   only writes the file):

   ```bash
   mkdir -p "$WORKTREE/.flow-tmp"
   ```

3. Make exactly **one** Task-tool call:

   ```
   subagent_type: general-purpose
   description:   Fix-applier for /pr-review
   prompt:        <the prompt template below, with variables filled in>
   ```

4. When the subagent returns, treat its 3–5 sentence summary as the chat
   output. Do **not** read the artifact body at the spawn boundary —
   Step 9's first read is the wrapper's single read of the artifact
   body, and reading it earlier would duplicate that read in the same
   context. The wrapper's only post-spawn job at the boundary is a cheap
   existence check against `$ARTIFACT_PATH` (`test -s "$ARTIFACT_PATH"`);
   on missing or empty artifact, surface the failure to the caller per
   the Constraints below.

5. Continue to Step 8c (the wrapper's post-spawn verification-item run),
   then Step 9 onwards.

## Spawn prompt template

Fill in the six `{{...}}` placeholders before passing to the Task tool:

```
You are the Fix-Applier Subagent for `/pr-review`. You run in an isolated
context and return an artifact on disk plus a brief summary.

Read the full instructions at:
  {{INSTRUCTIONS_PATH}}

PR fetch output (verbatim from `flow-fetch-pr-review`):
  {{FETCH_OUTPUT}}

PR number:
  {{PR_NUMBER}}

Working directory (cd here before reading any project files):
  {{WORKTREE}}

Skill base directory (resolve sibling references against this absolute
path — they do not exist relative to {{WORKTREE}}):
  {{SKILL_DIR}}

Write the structured artifact to (absolute path):
  {{ARTIFACT_PATH}}

Follow the fix-applier-instructions.md steps in order. You are one-shot —
do not ask the user clarifying questions. When ambiguity blocks a fix,
defer it with a `reason` that names the ambiguity, or record an
`anti_patterns_found` entry; do not pause waiting for input.

Populate `rejected_alternatives` for every fix you considered and rolled
back, and `anti_patterns_found` for every observation that did not reach
the >=80 confidence bar but the next agent session should know about. An
empty array is permitted only when you genuinely encountered none —
silence is not the default. Do not call `gh issue create`, `linear`, or
any tracker integration; flow has no GitHub-issue creation today.
`tracker_entry_url` defaults to empty string when no in-repo tracker
exists.

Return a one-paragraph summary (3–5 sentences) that surfaces BOTH sides
of what you learned: at least one positive (top fix's intent, the verify
verdict, finding count addressed) AND at least one negative (top entry
from `rejected_alternatives` or `anti_patterns_found`). A summary that
names only positive findings fails the contract. Do not paste the
artifact JSON back; the artifact on disk is the record.
```

The artifact's JSON schema is documented verbatim in
`references/fix-applier-instructions.md` step 9. Both files declare the
same five top-level keys (`commits`, `deferred`, `rejected_alternatives`,
`anti_patterns_found`, `summary`); a structural lint at
`bin/skill-md-lint.test.ts` enforces the schema-drift symmetry.

# Result artifact

`/pr-review` writes a second structured artifact distinct from the
Fix-Applier Subagent's: a wrapper-level **result artifact** that names
which top-level steps of this skill ran to completion, which were
skipped, and (on bail-out paths) which escalation tag fired. The
artifact lives at:

```
<worktree>/.flow-tmp/pr-review-result.json
```

The schema's typed fields are:

```
status:           "clean" | "partial" | "escalated"
completed_steps:  string[]
missed_steps:     string[]
escalation_tag:   string | null
summary:          string
```

**Canonical step labels.** `completed_steps[]` and `missed_steps[]`
use this skill's own step numbering: the top-level numbers `"1"`,
`"2"`, `"3"`, `"4"`, `"5"`, `"6"`, `"7"`, `"7.5"`, `"8"`, `"8c"`,
`"9"`, `"10"`, `"11"`, `"12"`, `"13"` (the sub-step labels actually
present in the # Instructions section above). Sub-steps like `"8c"`
appear only when the wrapper bails out mid-step 8 after `8b` returned
but before `8c.i` ticked any boxes; otherwise `completed_steps`
records just the parent number (`"8"`).

**When each `status` fires:**

- `"clean"` — every step from 1 through 13 either ran to completion
  or was a no-op-skipped (e.g. Step 5's "no inline review comments"
  branch, Step 13's "no local follow-ups to register" branch). The
  no-op skip is a successful completion, not a miss.
- `"partial"` — at least one step listed in this skill's # Instructions
  was not reached because an earlier escalation, retry-exhausted, or
  user redirect terminated the run before the wrapper got there. The
  unreached step labels go in `missed_steps[]`; the labels that did run
  go in `completed_steps[]`.
- `"escalated"` — the skill bailed at a documented escalation site
  (`task-tool-unavailable: pr-review-multi-agent-review`,
  `task-tool-unavailable: pr-review-fix-applier`,
  `fix-applier-missing-artifact`, or a multi-agent review failure
  surfaced verbatim from Step 3). `escalation_tag` carries the
  tag string the wrapper would have printed to scrollback; the
  supervisor consumes it directly (see `/flow-pipeline` step 8 for
  the propagation contract).

**Write contract.** The wrapper writes the artifact on **every exit
path** — clean Step 13 completion, every escalation site, and the
intermediate-step partial path. The atomic write goes
write-`.tmp` → validate-`.tmp` → `mv`-into-place:

1. Write the candidate JSON to `<path>.tmp` (heredoc or `jq`).
2. Validate the temp file's shape:

   ```bash
   bun bin/lib/pr-review-result-schema.ts --validate <path>.tmp
   ```

3. On `ok: true`, `mv <path>.tmp <path>` into place. On validation
   failure, leave `<path>.tmp` on disk for inspection and exit
   non-zero — never `mv` an unvalidated candidate into the canonical
   path.

The validator reads from disk (`Bun.file(path).text()`), so
validating `<path>` before the `.tmp` write would either fail with
`read failed: ENOENT` on a first-ever write or validate the stale
prior artifact instead of the new candidate. The temp-file write +
validate + `mv` order guarantees a half-written or off-shape
artifact never sits on disk where a reader expects a well-formed
JSON object. Overwrite any prior artifact; do not append.

**Exit-path wiring.**

- **Clean Step 13 completion** → `status: "clean"`,
  `completed_steps` contains all top-level step labels that ran,
  `missed_steps: []`, `escalation_tag: null`. Deferred-finding paths
  (Step 6's deferral bar, Step 7's "skip with reason") still count as
  completed_steps — deferral is a documented Step 6/7 outcome, not an
  escalation.
- **`task-tool-unavailable: pr-review-multi-agent-review`** (raised
  by Step 3's preamble when `ToolSearch query="select:Task"` returns
  neither `"name": "Task"` nor `"name": "Agent"`) → `status:
  "escalated"`, `escalation_tag: "task-tool-unavailable:
  pr-review-multi-agent-review"`, `completed_steps` lists Steps 1
  and 2, `missed_steps` lists 3 onward.
- **`task-tool-unavailable: pr-review-fix-applier`** (raised by the
  Spawn procedure's preamble before the Fix-Applier Task call) →
  `status: "escalated"`, `escalation_tag: "task-tool-unavailable:
  pr-review-fix-applier"`, `completed_steps` includes everything
  that ran before the spawn site, `missed_steps` lists the
  Fix-Applier-owned Steps 6/7/7.5/8 plus anything downstream.
- **`fix-applier-missing-artifact`** (Step 8's existence check
  failed) → `status: "escalated"`, `escalation_tag:
  "fix-applier-missing-artifact"`, `completed_steps` includes
  through Step 8 spawn, `missed_steps` lists 9 onward.
- **Multi-agent review failure** (Step 3 retry-exhausted or any of
  the four agents returned a structural error the wrapper can't
  parse) → `status: "escalated"`, `escalation_tag` carries the
  verbatim wrapper-level escalation tag, partial step lists per
  above.

**`--resume-from <step-number>` flag.** When `$ARGUMENTS` contains
`--resume-from <N>` (where `<N>` is one of the canonical step labels
above, e.g. `--resume-from 7` or `--resume-from 8`), the skill reads
the existing `<worktree>/.flow-tmp/pr-review-result.json`, skips
Steps 1 through N-1 (treating them as already-completed), and
resumes at Step N. The new run merges its `completed_steps[]` into
the existing list (deduplicating by label) before writing the new
artifact. This is the mechanism `/flow-pipeline` step 8 uses to
retry a `status: "partial"` review without re-running the multi-agent
fan-out from scratch. If no prior artifact exists when
`--resume-from` is passed, the wrapper escalates `NEEDS HUMAN:
pr-review-missing-artifact` — the flag's contract is to resume an
existing run, not to fabricate one.

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

**Load the Task tool before spawning.** In Claude Code sessions where neither `Task` nor its alias `Agent` is surfaced top-level by the harness (both are aliases of the same one-shot subagent-spawn primitive: identical `subagent_type` / `prompt` / `description` schema), the four parallel spawns will silently fall through to in-line execution unless the schema is loaded first. Before the Task calls below, run `ToolSearch query="select:Task"` and confirm the response contains either a `<function>{"name": "Task", ...}</function>` or a `<function>{"name": "Agent", ...}</function>` line. If it does not, **do not fall back to in-line execution** — escalate `NEEDS HUMAN: task-tool-unavailable: pr-review-multi-agent-review` and exit. Before exiting, write `<worktree>/.flow-tmp/pr-review-result.json` with `status: "escalated"` and `escalation_tag: "task-tool-unavailable: pr-review-multi-agent-review"` per the # Result artifact contract above (write-`.tmp` → validate-`.tmp` → `mv`). Worked example:

```bash
RESULT_PATH="$WORKTREE/.flow-tmp/pr-review-result.json"
cat > "$RESULT_PATH.tmp" <<'EOF'
{
  "status": "escalated",
  "completed_steps": ["1", "2"],
  "missed_steps": ["3", "4", "5", "6", "7", "7.5", "8", "8c", "9", "10", "11", "12", "13"],
  "escalation_tag": "task-tool-unavailable: pr-review-multi-agent-review",
  "summary": "Bailed at the Multi-Agent Review spawn-site preamble — neither Task nor Agent surfaced top-level in this session; supervisor must restart in a session where the alias is available."
}
EOF
bun bin/lib/pr-review-result-schema.ts --validate "$RESULT_PATH.tmp" \
  && mv "$RESULT_PATH.tmp" "$RESULT_PATH"
```

The fan-out's value is its context isolation; an in-line fallback breaks the contract that this exemption is justified by.

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

Delegated to the Fix-Applier Subagent (see § Fix-Applier Subagent above).
The subagent classifies each filtered finding (auto-fix vs defer per the
deferral bar), applies the edits, and records dispositions in the
artifact's `commits[]` (auto-fixed) and `deferred[]` (escalated). The
subagent runs at Step 8.

This step is documentation-only at the wrapper level — it names the
work the subagent owns. The wrapper does no per-finding fix work itself.
The deferral path's tracker-entry filing (default: a GitHub issue via
`flow-create-issue`, with `ROADMAP.md` as the no-GH-Issues fallback) is
documented inside the subagent's instructions at
`references/fix-applier-instructions.md`.

## 7. Address Each Review Comment

Delegated to the Fix-Applier Subagent (see § Fix-Applier Subagent above).
The subagent opens each cited line, assesses the comment, applies a change
when valid (or pushes back when incorrect), and records the disposition in
the artifact (`commits[].reasoning` for addressed comments, `deferred[]`
for skipped ones). Step 9 reads those dispositions to draft inline replies.

## 7.5. Roadmap Mark-Shipped Sweep

Delegated to the Fix-Applier Subagent (see § Fix-Applier Subagent above).
The subagent self-marks the current PR's row and sweeps drifted prior-PR
rows in `docs/roadmap.md` (when one exists), bundling the edit into the
same fix commit as Steps 6/7. The full self-mark + sweep contract lives in
`references/fix-applier-instructions.md` step 5; the `Auto-push exemption:
pr-review` clause in `AGENTS.md` covers the resulting commit + push.

## 8. Spawn Fix-Applier Subagent and Run Verification Items

Spawn the **Fix-Applier Subagent** per the Spawn procedure in § Fix-Applier
Subagent above. The subagent owns the per-finding fix loop (Steps 6, 7, 7.5),
the pre-commit run, the commit + push, and the `/verify` re-run — all inside
its own context.

After the subagent returns, do a cheap existence check against the
canonical `$ARTIFACT_PATH` resolved during the spawn procedure (the
single source of truth for the artifact's location):

```bash
test -s "$ARTIFACT_PATH" \
  || {
       # Write the wrapper-level result artifact recording the escalation
       # before bailing — every exit path must leave pr-review-result.json
       # on disk so the supervisor can branch on .status.
       RESULT_PATH="$WORKTREE/.flow-tmp/pr-review-result.json"
       cat > "$RESULT_PATH.tmp" <<'EOF'
{
  "status": "escalated",
  "completed_steps": ["1", "2", "3", "4", "5", "8"],
  "missed_steps": ["8c", "9", "10", "11", "12", "13"],
  "escalation_tag": "fix-applier-missing-artifact",
  "summary": "Fix-Applier subagent returned but the artifact at .flow-tmp/fix-applier-result.json is missing or empty. Wrapper bailed at Step 8's existence check; supervisor must restart."
}
EOF
       bun bin/lib/pr-review-result-schema.ts --validate "$RESULT_PATH.tmp" \
         && mv "$RESULT_PATH.tmp" "$RESULT_PATH"
       echo "NEEDS HUMAN: fix-applier-missing-artifact" >&2;
       exit 1;
     }
```

On missing or empty artifact, surface the failure to the supervisor — **do
not** retry the Task call. Re-invocation is the supervisor's decision; a
second call inside this run would violate the one-Task-call invariant.
On this bail-out path the wrapper writes
`<worktree>/.flow-tmp/pr-review-result.json` with `status: "escalated"`
and `escalation_tag: "fix-applier-missing-artifact"` per the
# Result artifact contract above, before exiting non-zero.

Do **not** read the artifact's body at this boundary. Step 9 reads it once,
parses into a typed object, and reuses that object across Steps 9, 10, 11,
12. Reading earlier would duplicate the read in the wrapper's context and
erode the context-cost win.

Then continue to 8c (the wrapper's post-spawn verification-item run).

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

**Second self-check — author-prose promotion**: when the item is written as prose
("verify `runner.pid` exists and matches printed PID", "confirm `~/.flow/state/<slug>.json`
shows `phase: merged`"), apply the **mechanical-obviousness bar** before classifying
it as not-runnable. If the cited file/path makes the assertion mechanical — the
prose maps to a one-line `test -f <X>`, `grep -q <pattern> <X>`,
`[ "$(cat X)" = "Y" ]`, or `[ "$(jq -r '.field' <X>)" = "<value>" ]` — promote it
to the runnable bucket per Step 8c.ii. If the prose requires subjective judgment
(animation feels smooth, error message reads naturally, contrast looks right) or
external services (browser, real network, prod credentials), it stays not-runnable.
Open-ended LLM rewriting of arbitrary manual prose is *out of scope* — the bar is
literal: can I write a one-line shell command whose stdout/exit code answers the
prose without me interpreting anything?

For each runnable item:

1. Execute it exactly as written, capturing both stdout and stderr to a file.
   Use `set -o pipefail` so the captured exit code reflects the command's
   status, not `tee`'s — without pipefail, a failing item is silently
   recorded as exit 0 and the box gets ticked incorrectly:

   ```bash
   set -o pipefail
   bash -c 'cmd 2>&1' | tee .flow-tmp/evidence-<n>.txt
   echo "${PIPESTATUS[0]}" > .flow-tmp/exit-<n>
   ```

   Same discipline as Step 8 — a non-zero exit means investigate and fix the
   underlying issue, not explain it away.
2. If a fix is needed, make a **new commit** (do not amend the pushed commit per
   `AGENTS.md`) and `git push` before re-running.
3. On pass, the box gets ticked AND the captured output gets injected as a
   `<details>` evidence block immediately under the item — see the next sub-step.

### 8c.ii. Prose-to-runnable promotion (mechanical-obviousness only)

When 8c's second self-check identifies an author-prose item that maps to a
mechanical assertion (`test -f`, `grep -q`, `[ "$(cat X)" = "Y" ]`,
`[ "$(jq -r '.field' X)" = "Y" ]`), promote it inline. The author's `- [ ]`
wording in the PR body **stays as written** — only the box-tick + evidence
injection runs. Body wording rewrites are a Step 11e responsibility (gated on
user confirmation), never 8c's. This split keeps the audit honest: reviewers
always see what the author *claimed* alongside the evidence block showing what
the agent *ran*.

For each promoted item:

1. Write the scripted equivalent to scratch:

   ```bash
   mkdir -p .flow-tmp
   cat > .flow-tmp/promoted-<n>.sh <<'EOF'
   # Prose: "verify `runner.pid` exists and matches the printed PID"
   set -e
   test -f runner.pid
   [ "$(cat runner.pid)" = "$EXPECTED_PID" ]
   EOF
   chmod +x .flow-tmp/promoted-<n>.sh
   ```

2. Run it, capturing stdout + stderr + exit code the same way 8c does for
   author-written runnable items. Use `set -o pipefail` so the captured exit
   code reflects the promoted script's status, not `tee`'s — without
   pipefail, a failing assertion is silently recorded as exit 0 and the box
   gets ticked incorrectly:

   ```bash
   set -o pipefail
   bash -c '.flow-tmp/promoted-<n>.sh 2>&1' | tee .flow-tmp/evidence-<n>.txt
   echo "${PIPESTATUS[0]}" > .flow-tmp/exit-<n>
   ```

3. On exit 0, hand off to 8c.i for the box-tick + evidence injection. The
   `--item` regex matches the *author's prose line*; the evidence block records
   the *exact promoted command* that was run, so the audit trail names both:

   ```bash
   flow-inject-evidence \
     --body-file .flow-tmp/body.md \
     --item '<regex matching the author prose line>' \
     --output-file .flow-tmp/evidence-<n>.txt \
     --exit-code "$(cat .flow-tmp/exit-<n>)"
   ```

4. On non-zero exit: do NOT tick the box. Leave the item unchecked and record
   the failed promoted command in the structured report (Step 12) so the user
   sees both the prose and the agent's interpretation of it.

**Bounded by mechanical-obviousness.** If you find yourself writing more than
~3 lines of shell to express the prose, or reaching for branching logic
(`if/then`, `case`, multiple `&&` clauses across distinct asserts), the prose
is **not** mechanically obvious — leave it not-runnable and record the
rubric category that applies (`subjective UX`, `production-only`,
`cross-browser`, `performance under realistic load`, etc.). Open-ended LLM
rewriting of arbitrary manual prose drifts toward executing scripts the
author did not intend; the bounded version trades some recall for safety.

Track the promotion count for Step 12's audit line: how many `- [ ]` items
were promoted from author prose vs. ran as the author wrote them, and how
many were left unticked with which rubric category.

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

Otherwise, **read the artifact once** at this step and parse into a typed
object that is reused across Steps 9, 10, 11, 12 — do not re-read in
subsequent steps. Use the canonical `$ARTIFACT_PATH` resolved during the
spawn procedure rather than rebuilding the path here:

```bash
ARTIFACT=$(cat "$ARTIFACT_PATH")
```

For each inline comment from Step 2's fetch output, look up the disposition
in the parsed `ARTIFACT` using **exact match** on the structured
`comment_ids` field (no substring/free-text fallback — the artifact is
the typed contract):

- **Addressed** — the comment's `comment_id` is a member of
  `commits[].comment_ids` for some entry. Build a ✅ reply citing that
  commit's `sha` and `reasoning`. Multiple comments may map to the same
  commit (e.g. one fix subsumes two reviewer points); a single comment
  may also map to multiple commits when the address spans commits.
- **Skipped** — the comment's `comment_id` appears as a `finding_id` in
  `deferred[]` (or, when the deferral covers multiple comments, in a
  `comment_ids: []` slot on the deferred entry). Build a ⏭️ reply with
  the `reason` field.
- **Pushed back** — the comment's `comment_id` is a member of
  `commits[].comment_ids` for an entry whose `reasoning` begins with
  `rejected suggestion:` (the subagent's marker for declined reviewer
  comments — the comment's disposition is "no code change, here is
  why"). Build a ⏭️ reply with the rejection rationale.

Wrapper does not fall back to free-text scanning. If a reviewer comment
has no exact `comment_ids` match in either `commits[]` or `deferred[]`,
the artifact is incomplete: surface the gap to the caller rather than
silently skipping the reply.

Construct a JSON array and pipe it to the reply helper:

```bash
echo '<json-array>' | flow-reply-pr-comments <pr-number>
```

Each entry: `{"comment_id": <id>, "body": "<reply>"}`.

Use a leading emoji for scannability:

- ✅ **Addressed** — terse confirmation. Include detail only if the fix
  differs from the suggestion.
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

Compare the current implementation (diff + the artifact's `commits[]` from
the Fix-Applier Subagent — already parsed at Step 9) against the description:

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

- **Fail (automatable)**: Unlike the `Fail (shallow)` and `Fail (missing)` branches
  above, the per-item conversion here is **default-on** — do not pause for upfront
  confirmation. Do NOT just edit the description. The fix is a **code change**: add
  automated tests that subsume the flagged manual items. List each automatable
  manual item with (a) the existing test file it should slot into (or the new file
  path) and (b) a one-or-two-sentence sketch of the assertions. Example:

  > - "verify `runner.pid` exists and matches printed PID" → add `it(...)` to
  >   `src/commands/run.detach.smoke.test.ts` reading `runner.pid` and asserting it
  >   equals the PID parsed from stdout (existing fixture suffices).
  > - "verify task ends `needs-human (runner-crashed)` after a phase throws" → new
  >   `it(...)` in the same file using a non-git `target_repo` + stub script;
  >   `findWorktreePath` throws, runner catch should rewrite status.

  Per-item conversion is **default-on** — do not pause for upfront confirmation. For
  each automatable item: write the test, run it (`npm test` / `RUN_INTEGRATION=1 npm
  test` as appropriate), commit and push the change (covered by the `Auto-push
  exemption: pr-review` clause in AGENTS.md), then prune the converted bullet from
  the PR body via `gh pr edit <number> --body-file /dev/stdin`. Leave only items
  that genuinely require human judgment (per the rubric's "Genuinely manual" list).
  The user redirects via reply after the fact (e.g. "this one should have stayed
  manual — revert it") rather than gating each conversion upfront.

  Items that fail the rubric's `Caveat: don't trade a working test for a flaky one`
  check (real network / real LLM / heavy harness disproportionate to risk /
  timing-dependent without a determinism shim) are **not** auto-converted: surface
  them as `suggestion` findings in the report instead of forcing a flaky test in.
  Same fallback applies if a converted test fails verification after a reasonable
  attempt — back it out and surface as a `suggestion`.

  Record the disposition in the report's PR Description Quality status as
  `Manual items auto-converted (N items, redirect by replying)` (see
  `references/report-template.md`).

**If 0 criteria fail, or 1 non-Testability criterion fails, and no accuracy issues**: Note
"PR description is accurate and communicates intent clearly" in the report.

**IMPORTANT**: For the `Fail (shallow)` and `Fail (missing)` branches, never update the
description without showing the user a diff of what's changing (focused on just the
affected section is fine) and getting confirmation. The description is the author's
voice — edits should improve clarity, not impose a rigid template. The `Fail
(automatable)` branch is default-on per the inversion above — its per-item
bullet-pruning edit is covered by the `Auto-push exemption: pr-review` clause in
`AGENTS.md` and does not require upfront confirmation; the user redirects via reply
after the fact.

**After any 11e edit that adds `- [ ]` test items** (fail-shallow or fail-missing
branches), re-run Step 8c against the newly added items to tick the runnable ones
before producing the final report. fail-automatable runs its own tests inline and
prunes the bullets, so it does not require re-entry.

## 12. Structured Report

Read `references/report-template.md` and produce the full report. This is the most
important output — the user needs a clear, at-a-glance summary of everything that happened.

Always produce this report, even when there are no findings or comments. The report
covers: summary, findings (each annotated as **Addressed** or **Deferred with reason**),
review comments addressed, pre-commit check results, **Rejected Alternatives** (from the
artifact's `rejected_alternatives[]`), **Anti-Patterns Observed** (from the artifact's
`anti_patterns_found[]`), PR description quality, and retrospective. The two
negative-findings sections surface what the Fix-Applier Subagent learned should NOT be
done — render them as named report sections so a human reading the report sees the
foreclosed paths alongside the fixes that landed.

**The report MUST explicitly separate addressed vs deferred findings.** Never leave the
reader guessing which findings were silently skipped — every finding surfaced in Step 4
must appear in one of the two buckets. If no findings were deferred, say so explicitly
("No findings deferred"). Same rule for the negative-findings sections: when
`rejected_alternatives` or `anti_patterns_found` is empty, write `None` under the heading
rather than omitting it — silence on negatives is the failure mode the slot exists to
prevent.

The Fix-Applier Subagent already committed and pushed any code changes during its run
(per the `Auto-push exemption: pr-review` clause); the wrapper does not re-commit at
this step. Present the report directly.

**Automation-precedence audit line.** The report's "Test Steps (from PR description)"
section ends with one summary line:

```
Automation-precedence audit: ran N/M items (X prose-promoted, Y left manual: <reasons>)
```

- `M` is the total `- [ ]` item count in the section.
- `N` is the number ticked by 8c (author-runnable + prose-promoted via 8c.ii).
- `X` is the subset of `N` that came from 8c.ii prose promotion.
- `Y` is `M − N` — items left unticked. `<reasons>` is a comma-separated list of
  the manual-test-rubric categories that applied (`subjective UX`,
  `production-only`, `cross-browser`, `performance under realistic load`,
  `cost-prohibitive infra`); cite the rubric file name verbatim. When `Y = 0`,
  write `0 left manual` and omit the parenthetical reason list.

The line emits unconditionally, including when `M = 0` (write
`Automation-precedence audit: ran 0/0 items (no Test Steps to verify)`). Always
emitting is the deliberate choice — `0 prose-promoted` on a PR with all-runnable
author items is itself a positive signal ("nothing was author-manual today").
The user reads the audit line to decide whether to redirect ("this should have
been a test, not a runtime conversion") with one comment.

**Auto-converted manual items line.** When Step 11e's `Fail (automatable)` branch
fires and converts one or more manual checklist items into automated tests
(default-on per the inverted resolution above), the report's "Test Steps (from PR
description)" section emits a second summary line adjacent to the audit line:

```
Auto-converted N items per rubric: <comma-separated list of the converted bullets>
```

- `N` is the number of `- [ ]` manual items converted to real tests in this run.
- The comma-separated list names each converted bullet (quoting the original wording
  is sufficient — `"verify runner.pid exists and matches printed PID"`), one entry
  per converted item, so the user can grep a single line to see what changed.

The line fires only when Step 11e's `Fail (automatable)` branch actually converted
at least one item (`N >= 1`). When the branch did not fire, or fired but every
candidate was rejected by the rubric's `Caveat: don't trade a working test for a
flaky one` check and surfaced as `suggestion` findings instead, omit the line —
its absence is itself a signal that no auto-conversion happened this run. This
line pairs with the `Manual items auto-converted (N items, redirect by replying)`
PR Description Quality status enum value, which records the same disposition in
the report's status field; the line on the test-steps side gives the per-item
detail the status enum compresses.

The emit-conditionality here deliberately diverges from the adjacent
`Automation-precedence audit` line (which always emits, even on `0 prose-promoted`):
the audit line reports on *every* Test Steps item by design (a `0 prose-promoted`
verdict is itself the positive signal that nothing was author-manual), while
auto-conversion is a per-PR side effect rather than a per-PR property — runs
without a `Fail (automatable)` fire have no auto-conversion semantics to report,
so the line is omitted rather than written as `0 items`.

## 13. Register Local Follow-ups (when applicable)

If addressing a review comment introduced a side-effect the user must replicate
locally post-merge (a new helper added to `bin/`, a new env var, a config file
to delete), register a follow-up:

```bash
flow-followups add \
  --command "flow setup --upgrade" \
  --reason "<why this matters post-merge>" \
  --auto    # only when command is in the helper's allowlist
```

`/flow-pipeline` step 11 consumes the JSONL log on terminal end-states. On
the auto-merge and GATED branches the entries are also surfaced as a
`## Local Follow-ups` section in the PR body via `flow-followups
pr-body-upsert`. The NEEDS HUMAN failure path prints the deferred block to
scrollback (via `flow-followups run --note-only`) but does **not** edit the
PR body — escalation can fire before a PR exists, and the JSONL log persists
on disk for any later resume to consume. PR review never runs the follow-up
directly — that's the supervisor's job, gated by the helper's allowlist.

After Step 13 finishes (including its no-op-skipped branch), write the
clean-completion result artifact at `<worktree>/.flow-tmp/pr-review-result.json`
per the # Result artifact contract above: `status: "clean"`,
`completed_steps` enumerating every top-level step label that ran in this
invocation (deduplicating against any prior list when `--resume-from` was
used), `missed_steps: []`, `escalation_tag: null`, and a one-paragraph
`summary` mirroring the Step 12 structured report's headline. Validate the
shape via `bun bin/lib/pr-review-result-schema.ts --validate <path>` then
atomically write. This is the single signal `/flow-pipeline` step 8 reads
to decide whether to continue (`"clean"`) or branch into the partial-retry
path (`"partial"`) or escalate verbatim (`"escalated"`).

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

- Exactly one Task-tool call to the Fix-Applier Subagent per `/pr-review`
  invocation; the wrapper did not retry on missing artifact (the supervisor
  re-invokes if needed).
- `.flow-tmp/fix-applier-result.json` exists at the resolved absolute path
  with all five top-level keys (`commits`, `deferred`,
  `rejected_alternatives`, `anti_patterns_found`, `summary`).
- The wrapper's transcript contains no per-finding fix prose, no
  `flow-pre-commit` output, and no `/verify` re-run output — those stayed
  inside the Fix-Applier Subagent.
- The wrapper read `.flow-tmp/fix-applier-result.json` body exactly once
  (at Step 9), parsed once, and reused the parsed object across Steps
  9 / 10 / 11 / 12.
- Independent multi-agent review completed BEFORE reading reviewer comments
- All agent findings filtered to confidence >= 80 (praise exempt)
- Any praise findings name a specific behaviour, file:line, or pattern; zero
  praise is acceptable when no specific positive observation meets the bar.
  Reviews containing only filler praise are worse than reviews with no praise.
- Conventional comment format (label + decoration) used for all findings
- **Every surfaced finding ends in either a code change (addressed) or a deferral with a
  concrete reason (no silent skips)**
- **Every deferred finding has a corresponding entry in a durable tracker — by default a
  GitHub issue filed via `flow-create-issue` (idempotent on title), falling back to a
  `ROADMAP.md` "Followups" entry only when the helper exits non-zero or the project has no
  GH Issues surface. The review report is not a tracker.**
- When inline review comments existed: every comment is addressed or explicitly skipped with reason, replies are posted, and the retrospective + checklist update appear in the report (or the report records "No reviewer comments to retrospect against" when none existed)
- Findings posted as individual inline review comments via `gh api` on every invocation, including PRs that already have reviewer comments
- Roadmap self-mark + sweep performed (Step 7.5): when `docs/roadmap.md` exists, the current PR's row is flipped to `✅ shipped (#$PR)` if a row exists, and any `🚧 in review (#N)` rows whose PR is already MERGED are flipped in the same diff
- Pre-commit checks pass (run individually, not chained)
- PR description quality check completed
- Structured report produced using the template format
- **Report clearly labels each finding as Addressed or Deferred (+ reason) — no finding is
  silently dropped between Step 4 and the report**

# Constraints

- NEVER do per-finding fix work in the wrapper's context. The Fix-Applier
  Subagent owns Steps 6, 7, 7.5, the pre-commit run, the commit + push, and
  the `/verify` re-run. Loading reference docs, opening cited files, or
  drafting fixes inline defeats the entire point of the refactor.
- NEVER make more than one Task-tool call per `/pr-review` invocation
  for the Fix-Applier Subagent. The single fan-out is the named exemption;
  multi-call fan-out is not authorised. If the artifact is missing after
  the spawn, surface the failure to the supervisor — the wrapper itself
  never retries. (The Independent Multi-Agent Review at Step 3 is a
  separate, already-exempted Task call covering review mode; that
  exemption is unchanged.)
- NEVER read `.flow-tmp/fix-applier-result.json` body at the spawn boundary
  (Step 8). The cheap existence check (`test -s`) is the only allowed
  artifact access between spawn and Step 9. Step 9's first read is the
  wrapper's single read of the body; reading earlier would duplicate that
  read in the same context.
- NEVER read the artifact's body more than once. Parse it into a typed
  object at Step 9 and reuse the object across Steps 10, 11, 12. Re-reads
  defeat the context-cost win the subagent was designed to deliver.
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
- NEVER defer a finding without writing a corresponding tracker entry in the same run.
  Default tracker is a GitHub issue filed via `flow-create-issue` (idempotent on title);
  fall back to `ROADMAP.md` only when the helper fails or the project has no GH Issues
  surface. Default to fix-now; deferral is reserved for work that legitimately warrants
  a separate standalone agent session per the bar in Step 6. A deferral that lives only
  in the review report will be lost when the PR merges.
