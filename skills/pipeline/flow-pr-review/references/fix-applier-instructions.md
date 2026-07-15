# Fix-applier instructions

These instructions are read by the fix-applier subagent that `/flow-pr-review`'s
SKILL.md spawns via the Task tool. The subagent runs in an isolated context —
its file reads, per-finding fix prose, `flow-pre-commit` output, and `/flow-verify`
transcript stay inside its own session and are never returned to the caller.
The only outputs it produces are the side effects on the worktree (file edits,
git commits, push) and the structured artifact it writes to disk
(`.flow-tmp/fix-applier-result.json`), plus a brief one-paragraph summary it
returns on completion.

The wrapper passes you these inputs in its spawn prompt:

- The verbatim PR fetch output from `flow-fetch-pr-review` (PR metadata, the
  filtered set of agent findings to address, the inline review comments to
  address, the changed-files list).
- The PR number.
- The absolute worktree path (your working directory).
- The absolute skill base directory (`SKILL_DIR`). Resolve every sibling
  reference path under it — e.g. `<SKILL_DIR>/references/review-checklist.md`,
  `<SKILL_DIR>/references/conventional-comments.md`. Those files do not exist
  relative to the worktree you `cd`'d into — they live in the skill directory,
  which is somewhere else on disk (typically
  `~/.flow/claude-home/.claude/skills/flow-pr-review/` or
  `<flow-checkout>/skills/pipeline/flow-pr-review/`).
- The absolute path to write the artifact (`ARTIFACT_PATH` —
  `.flow-tmp/fix-applier-result.json` under the worktree).

Follow the steps below in order.

## 1. Load context

Before drafting any fix, load the inputs:

- Read the PR fetch output the wrapper passed you. Extract: the filtered
  finding set (each entry has `file`, `line`, `end_line`, `label`,
  `decoration`, `confidence`, `subject`, `body`, and an agent category like
  `Bug-Detection`/`Security`/`Pattern-Consistency`/`Performance`/`Supply-Chain`/`Test-Coverage`), the
  inline review comments to address (each has `comment_id`, `path`, `line`,
  `body`), and the head SHA captured at fetch time.
- Read `<SKILL_DIR>/references/conventional-comments.md` for the labelling
  vocabulary the inline reply bodies in step 4 must use.
- Read `<SKILL_DIR>/references/review-checklist.md` only if a finding's
  category is unclear and you need to disambiguate.

This is read-only background — these reads stay in your context.

## 2. Classify each finding (auto-fix vs defer)

You are in **fix-now mode** — you MUST attempt the edits. Specifically:

- Do **not** preemptively decide that a hook, permission rule, or read-only
  filesystem state will block writes. Don't assume one applies; attempt the
  edit and rely on the tool-call result.
- Do **not** infer a block from the worktree path (e.g. `flow-*` worktrees
  are ordinary git worktrees; they have no special write protection).
- Make a real `Edit` / `Write` tool call. If — and only if — the tool returns
  an error, record the verbatim error in the artifact's
  `commits[].tool_error` field (a separate field from `verify_status`,
  which is reserved strictly for `/flow-verify` outcomes; conflating tool
  errors and verify failures into one field made downstream readers
  unable to tell which signal they were looking at). When the tool error
  blocks the entire run rather than a single fix, also surface it as an
  `anti_patterns_found` entry. Either way, surface the error verbatim in
  the return summary.

**Default is fix-now.** Per `AGENTS.md` Hardening: "Fix security, reliability,
and correctness issues immediately — don't defer them." Deferral that lives
only in the artifact is a disappearing-task failure mode unless the artifact
records a concrete tracker entry the wrapper can surface.

For each finding, classify it into one of:

- **Auto-fix (default)** — apply the edit in this run. This is the expected
  path for almost all findings: dead imports/deps, unused files, trivially
  wrong names, missing guards, stale comments, adding a unit test, small bug
  fixes, error-toast additions, etc. If it ships in <30 lines of clear
  changes, fix it.
- **Defer + log** — only when the fix legitimately warrants a separate
  standalone agent session (see bar below). When you defer, you MUST surface
  the deferral in the artifact's `deferred[]` array AND file a durable
  tracker entry. **Default tracker is a GitHub issue** filed via
  `flow-create-issue` (idempotent on title — re-running the address loop
  against the same PR after a re-push reuses the existing open issue):

  ```bash
  mkdir -p "$WORKTREE/.flow-tmp"
  cat > "$WORKTREE/.flow-tmp/deferred-body.md" <<'EOF'
  <file/area + 1-line issue>

  **Why deferred:** <bar criterion>

  **Revisit trigger:** <concrete trigger>

  Surfaced by `/flow-pr-review` on PR #<n>.
  EOF

  ISSUE_JSON=$(flow-create-issue \
    --title "<short finding subject>" \
    --body-file "$WORKTREE/.flow-tmp/deferred-body.md" \
    --label flow-agent,deferred-review)
  ISSUE_URL=$(printf '%s' "$ISSUE_JSON" | jq -r '.url')
  ```

  Set `tracker_entry_url` to `$ISSUE_URL`. The helper files against the
  **current repo only** (no `--repo` flag); third-party regressions get a
  `flow-agent,deferred-review,third-party` label combo and a body that names
  the upstream project, leaving the user to mirror the issue upstream
  manually.

  **Fallback path.** If `flow-create-issue` exits non-zero (e.g. `gh`
  unavailable, no GH Issues surface for this repo), do NOT append to an
  in-repo tracker file — most repos have none, and a flat file with no status
  lifecycle is not a durable tracker. Instead, leave `tracker_entry_url` as an
  empty string, put the full deferral context in `reason`, and let the wrapper
  surface the deferral loudly in the Step 12 report so it is not lost. A GitHub
  issue via `flow-create-issue` is the single canonical durable tracker — try
  the helper first; loud surfacing is the degraded fallback when no Issues
  surface exists, not a silent write to a file.

**Bar for deferral — ALL must be true (otherwise fix it now):**

1. Fix requires meaningful design decisions or research that exceed the
   scope of "address this review" (e.g., picks an architectural direction,
   needs user input on intent).
2. Fix would expand the PR materially (touches >3 files as a cross-cutting
   refactor, OR requires new test infrastructure / harnesses, OR rewrites a
   non-trivial component).
3. The work is coherent enough to brief a future agent session in 1–2
   sentences with a concrete trigger ("when X is next touched", "before
   Phase N starts", etc.).

Cosmetic edge cases, small bugs, and mechanical refactors do **not** clear
this bar — fix them now. "I don't want to expand the PR" is not sufficient:
a 5-line guard is not a PR-expansion concern.

When deferring, the `deferred[]` entry must include:

- `finding_id` — the finding's stable identifier (the agent emits one; if
  missing, synthesise from `file:line` + label).
- `reason` — 1–2 lines: what the issue is and which bar criterion applies.
- `tracker_entry_url` — the `flow-create-issue` URL when a GitHub issue was
  filed; empty string otherwise. The wrapper renders this in the Step 12 report.

**Bar for fix-now (mirror of the deferral bar) — when ALL three hold, you MUST
fix in-PR:**

1. **Small** — roughly a handful of lines.
2. **Low-risk / mechanical** — no meaningful design decision, no research.
3. **In-scope** — directly related to code this PR already touches, OR to a
   brittleness / regression this PR itself introduced.

A finding clearing this bar may NOT be deferred and may NOT be parked in
`anti_patterns_found` as an "accepted trade-off." For this narrow class the
adjacent-production-file allowance overrides "review only changed files": if the
clean fix needs a minimal touch to a production file the diff didn't originally
include — e.g. adding a stable `data-` attribute to the adjacent component so a
test need not couple to a literal `.flex-1` Tailwind class — make that edit
rather than asserting against the brittle detail and recording the brittleness
as a trade-off. Recording a knowingly-brittle artifact you just created in
`anti_patterns_found` when the clean fix clears this bar is the exact
anti-pattern the bar forecloses (the canonical incident: a `.flex-1`-coupled
test shipped as a trade-off and later filed as a standalone issue, when the
durable fix was a one-line `data-` attribute on the adjacent component).
`anti_patterns_found` is for _pre-existing_ patterns in surrounding code you did
not introduce and cannot fix in scope — not a release valve for brittleness this
PR itself adds. Every `anti_patterns_found` entry now carries the
`introduced_by_this_pr` boolean that structures exactly this distinction:
`false` for the pre-existing patterns this slot is for, `true` for a pattern
living in code this PR added or changed. When `introduced_by_this_pr` is `true`,
the entry MUST justify against the three-part fix-now bar above (small /
low-risk-mechanical / in-scope) and may NOT use "not worth churning" /
"future session" framing — and an introduced-in-PR entry that _clears_ that bar
is illegal: it should have been a commit, not a note.

Fix-now and deferral are two outcomes of one classification: a finding clearing
the fix-now bar's three conditions is fixed now; a finding clearing the deferral
bar's three conditions is deferred; the residue is your judgment. The single
source of truth for the fix-now conditions is the consumer repo's `AGENTS.md`
`## Anti-Overengineering` / fix-now bar (seeded from
`templates/AGENTS.md.template`).

**Push back on inline comments** that are incorrect or would degrade code
quality. Blindly accepting every suggestion is worse than thoughtfully
declining some. Record the push-back in the artifact's `commits[]` with a
`reasoning` field that names what was rejected and why, _or_ surface it in
`rejected_alternatives` if you considered the suggestion's path and
ultimately rolled it back.

## 3. Apply fixes

For each finding classified as auto-fix:

1. Open the referenced file at the cited line. Read enough surrounding
   context (typically ±20 lines) to understand the change in scope.
2. Make the `Edit` / `Write` tool call. Match the project's conventions:
   read `AGENTS.md` if you're unsure about commit-body style, comment
   policy, or formatter preferences.
3. If you considered an alternative approach and rolled it back (or
   rejected it on inspection), record it in `rejected_alternatives` with
   `finding_id`, `considered_approach`, and `why_rejected`. **This is a
   load-bearing slot — populate it whenever you considered more than one
   approach. Silence is not the default.**
4. If you observe a related anti-pattern in the surrounding code that did
   not reach the >=80 confidence bar (or was outside this finding's scope)
   but the next agent session should know about it, record it in
   `anti_patterns_found` with `location`, `pattern`, and `recommendation`.
   **Same rule as `rejected_alternatives`: populate proactively.**

## 4. Address each review comment

If the fetch output contained no inline comments, skip to step 5.

Otherwise, for each inline comment:

1. Open the referenced file at the specified line.
2. Read surrounding context to understand the comment fully.
3. Assess whether the feedback is valid and actionable.
4. If valid: implement the change (or an improved version if you see a
   better approach). Same rule as step 3: record alternatives you
   considered and rejected in `rejected_alternatives`.
5. If not applicable: the reason MUST be recorded in the artifact —
   the wrapper at step 9 has zero context from inside this subagent
   and can only draft inline replies by reading the artifact. Record
   the disposition in one of these two slots, with the comment id
   captured structurally so the wrapper can match exactly (no free-text
   scanning):
   - **Pushed back / declined** (no code change, here is why): add a
     `commits[]` entry whose `comment_ids: []` includes the comment id
     and whose `reasoning` field begins with `rejected suggestion:`
     followed by the rationale. Even though no _new_ commit is created
     for a pure push-back, you still emit a `commits[]` entry — set
     `sha` to the head SHA at fetch time, `files: []`, and the reasoning
     prose carries the explanation. (Yes, this is the one place a
     `commits[]` entry can have `files: []`; the trade-off keeps the
     comment-id contract uniform across addressed / pushed-back paths.)
   - **Deferred** (some other reason — needs design, blocked by tool
     error, etc.): add a `deferred[]` entry whose `comment_ids` includes
     the id and whose `reason` names what the issue is and why a fix
     didn't land. Set `tracker_entry_url=""` when no GitHub issue was
     filed (e.g. the repo has no GH Issues surface).

   The wrapper's inline reply body is composed from the `reasoning`
   (push-back) or `reason` (deferral) field; surfacing the prose here
   in your return summary is helpful for human-debugging but not
   load-bearing — the artifact is the contract.

Push back on incorrect comments. The reply body the wrapper posts at
step 9 is composed from the `reasoning` field of the matching
`commits[]` entry (with `rejected suggestion:` prefix) — that text is
what the reviewer sees on the PR. Surface a one-line digest in your
return summary so the wrapper's caller can preview the disposition,
but the load-bearing record is the artifact field, not the summary.

## 5. Roadmap mark-shipped sweep

If `docs/roadmap.md` does not exist in the worktree, skip to step 6 — many
repos don't have one and that's fine.

Otherwise, edit `docs/roadmap.md` so the merged-state marker for the current
PR (and any drifted prior PRs) lands in this PR's own diff:

### 5a. Self-mark the current PR's row

Find every line containing `(#$PR_NUMBER)`. For each match:

- **Table row** (line starts with `|`): replace the cell containing
  `(#$PR_NUMBER)` with `✅ shipped (#$PR_NUMBER)` (single leading and
  trailing space inside the cell pipes).
- **`Status:` line** (line matches `^Status:`): replace the entire line
  with `Status: ✅ shipped (#$PR_NUMBER).`

If no line contains `(#$PR_NUMBER)`, log it and continue — many PRs
(chores, hotfixes, dep bumps) aren't roadmap items. Do not create a row
that didn't exist.

If multiple rows match, flip all of them. The edit is idempotent.

### 5b. Sweep drifted rows from prior PRs

Find every line matching `🚧 in review (#N)` for any N other than
`$PR_NUMBER`. For each such N:

```bash
gh pr view N --json state -q .state
```

- `MERGED` → flip the row using the same cell-replacement rule.
- `OPEN` / `CLOSED` / non-zero → leave untouched.

Sequential lookups are fine. Typically 0–2 rows in practice.

### 5c. Commit handling

Don't commit the roadmap edit alone — it lands in whatever commit step 7
produces:

- If you made code fixes in steps 3–4 and the roadmap edit is the only
  additional change, bundle it into the same fix commit.
- If the roadmap edit is the _only_ change this run produced (clean PR
  with no findings, no comments to address), use commit message
  `chore(roadmap): mark Item N shipped (pr-review #$PR_NUMBER)` where
  `Item N` is parsed from the matched row's `**Item N` token. If no item
  number can be parsed, use `chore(roadmap): mark row shipped (pr-review
#$PR_NUMBER)`.
- If the sweep flipped additional rows beyond the self-mark, mention the
  count in the commit body: `Also swept N drifted row(s) for PRs already
merged on main: #X, #Y`.

## 6. Pre-commit checks

Run the pre-commit helper with the PR number:

```bash
flow-pre-commit --pr "$PR_NUMBER"
```

The helper auto-detects changed areas, runs `npm run format` first, then
each check separately with structured pass/fail output. A non-zero exit
means a check failed — investigate, fix, and re-run. Repeat until all
checks pass.

If a check fails for a reason unrelated to your fix (pre-existing brokenness
on the branch), record it in `anti_patterns_found` with the verbatim failure
excerpt and continue — but mark the affected commit's `verify_status` to
reflect that the failure was pre-existing, not introduced.

## 7. Commit and push

Once pre-commit is green, commit and push. **The `Auto-push exemption:
pr-review` clause in `AGENTS.md` already authorises commit + push during a
`/flow-pr-review` run, including when the work happens inside this subagent.**
Don't ask for confirmation; the exemption removes the ambiguity.

- One commit per logical fix is fine, but a single batched commit is also
  fine — match what's clearest for the diff.
- Commit message: conventional-commits prefix (`fix:`, `chore:`,
  `refactor:`) + `(pr-review #$PR_NUMBER)` suffix in the subject. The body
  explains the _why_ (what the finding was) and references the agent's
  category (e.g. "Bug-Detection", "Pattern-Consistency", "Performance", "Supply-Chain").
- If the PR is **still open**: commit on the PR's branch and `git push`.
- If the PR is **already merged**: switch to `main`, pull, commit there,
  and `git push`. Do not leave fixes stranded on a merged branch.
- The only acceptable reason to stop short of pushing is a failed push
  (CI, branch protection, network) — record the verbatim error in the
  artifact's summary so the wrapper can escalate.

After each commit, capture the 7-character SHA. You'll record it in the
artifact's `commits[].sha` in step 9.

## 8. Re-run `/flow-verify` (load-bearing differentiator)

After every commit lands, invoke `/flow-verify` in-process via the Skill tool:

```
/flow-verify
```

`/flow-verify` runs the project's full check suite (typecheck, tests, format).
Capture the verdict per commit:

- **Pass** → set `commits[].verify_status = "pass"` for every commit
  produced this run.
- **Fail (within `/flow-verify`'s internal cap)** → make a follow-up fix
  commit on the same branch, push, and re-run `/flow-verify`. Repeat until
  clean or until `/flow-verify`'s internal cap exhausts.
- **Fail (cap exhausted)** → do **not** make further fix attempts. Set
  the affected `commits[].verify_status` to a head-100/tail-50 line
  excerpt of the verify failure (matching `flow-pre-commit --json`'s
  `headExcerpt`/`tailExcerpt` shape — the failure is too large to inline
  verbatim). Surface the unresolved failure in the return summary so the
  wrapper can escalate `NEEDS HUMAN: review-fix-verify-failed` rather
  than letting CI catch it after you exit.

This step is the load-bearing reason this subagent exists separately from
the wrapper. CI failures caused by your fix surface in-context here, while
the fix rationale is still live; without this re-run, the supervisor sees a
red CI in step 7 of `/flow-pipeline` long after you've exited and has to
rebuild intent from scratch.

## 9. Write the structured artifact

Write the artifact at the absolute path the wrapper passed you (typically
`<worktree>/.flow-tmp/fix-applier-result.json`). The wrapper has already
created the parent directory; you only need to write the file. Overwrite
any prior artifact; do not append.

The artifact MUST conform to this JSON schema:

```json
{
  "commits": [
    {
      "sha": "<7-char hex>",
      "files": ["<repo-relative path>", "..."],
      "finding_id": "<stable id from agent finding or synthesise as `<file>:<line>:<label>` if absent; for comment-driven fixes use the matching comment_id as a string>",
      "comment_ids": [<integer reviewer-comment ids this commit addresses, or [] if none>],
      "reasoning": "<one-line why: what the finding was, which agent category, what the fix does. For pushed-back comments, prefix with 'rejected suggestion: '.>",
      "verify_status": "pass" | "<head-100/tail-50 line excerpt of the verify failure>",
      "tool_error": "<verbatim Edit/Write tool error excerpt, or empty string when no tool error blocked this fix>"
    }
  ],
  "deferred": [
    {
      "finding_id": "<stable id>",
      "comment_ids": [<integer reviewer-comment ids this deferral covers, or [] when the deferral is finding-driven not comment-driven>],
      "tracker_entry_url": "<the flow-create-issue URL when an issue was filed; empty string otherwise>",
      "reason": "<1-2 lines: what the issue is + which deferral-bar criterion applies>"
    }
  ],
  "rejected_alternatives": [
    {
      "finding_id": "<the finding this alternative was considered for>",
      "considered_approach": "<what was tried — 1 line>",
      "why_rejected": "<why it was rolled back or ruled out — 1 line>"
    }
  ],
  "anti_patterns_found": [
    {
      "location": "<file:line or file>",
      "pattern": "<what was observed — 1 line>",
      "recommendation": "<what the next session should do — 1 line>",
      "introduced_by_this_pr": false
    }
  ],
  "summary": "<3–5 sentence both-sides return summary; see step 10>"
}
```

**Negative-findings slots are required.** `rejected_alternatives` and
`anti_patterns_found` are not optional decorations — they are the slots
where you record what you learned should NOT be done. Populate them
proactively as you work, and surface their entries in the return summary.

An empty array is permitted only when you genuinely encountered no
alternatives (e.g. a one-line guard with no design space) or no
anti-patterns (e.g. a fix in a clean module with no surrounding noise).
**Silence is not the default. If you hit even one design fork or saw a
single off-pattern in passing, you must record it.**

If the artifact is missing keys or fails to parse, the wrapper surfaces the
failure to the supervisor (`NEEDS HUMAN: fix-applier-missing-artifact`).

**Self-validate before exiting (atomic write → validate → re-emit once →
mv).** Do not write directly to `$ARTIFACT_PATH` and exit. Instead, mirror
the consolidator self-validate precedent in
[consolidator-instructions.md](consolidator-instructions.md) section (e):

1. Write the candidate artifact to `$ARTIFACT_PATH.tmp` first.
2. Run `flow-fix-applier-schema --validate "$ARTIFACT_PATH.tmp"`. On
   `{ok: true}` (exit 0), `mv "$ARTIFACT_PATH.tmp" "$ARTIFACT_PATH"` and
   you are done.
3. On `{ok: false}` (exit 1), re-read the typed `reason`/`path` from the
   validator's stderr line, **re-emit a corrected artifact EXACTLY ONCE**
   targeting that field — most commonly a missing `introduced_by_this_pr`
   boolean on an `anti_patterns_found` entry — then re-validate the new
   `.tmp`.
4. Only if the SECOND emit is still off-shape, leave the `.tmp` on disk
   and surface the failure in your return summary so the wrapper escalates
   `NEEDS HUMAN: fix-applier-missing-artifact`. On success, `mv` the
   `.tmp` into place.
5. NEVER silently exit with an off-shape artifact, and NEVER auto-coerce
   or default a missing field — the contract is correct-at-source via
   re-emit, not silent coercion.

## 10. Return a brief summary

Your final message back to the wrapper should be one short paragraph (3–5
sentences max) that surfaces **both sides** of what you learned:

- At least one positive: how many findings you addressed, the top fix's
  intent, the verify verdict.
- At least one negative: the top entry from `rejected_alternatives` or
  `anti_patterns_found` — what was tried and rolled back, or what
  surrounding anti-pattern the next session should pay attention to. A
  summary that names only positive findings fails the contract.

Do not paste the artifact JSON or the diff back — the wrapper only
forwards your summary, and the artifact on disk is the durable record.
Keeping the return value short is the whole point of the subagent
fan-out.

# Troubleshooting

| Problem                                          | Symptom                                              | Fix                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Edit` tool refuses                              | "string not unique" or read-required error           | Read the file first; expand `old_string` with surrounding context until unique. Don't paraphrase the refusal as "the hook denied edits" — that's a fabrication.                                                                                                                                                                                                 |
| `flow-pre-commit` fails on pre-existing breakage | A check fails on files you didn't touch              | Record the failure in `anti_patterns_found` with the verbatim excerpt; mark affected commit's `verify_status` as the excerpt. Do not silently abandon the fix. (`verify_status` is the right field here — pre-commit and `/flow-verify` cover the same check semantic; both go in `verify_status`. `tool_error` is reserved for Edit/Write tool failures only.) |
| `/flow-verify` cap exhausts mid-run              | The skill exits without clean                        | Stop attempting fixes. Record the cap-exhausted failure in `commits[].verify_status` and surface in the return summary so the wrapper can escalate.                                                                                                                                                                                                             |
| Push fails (branch protection, CI required)      | `git push` exits non-zero                            | Capture the verbatim error, write it into the artifact's `summary`, and exit. Do not retry the push — let the wrapper decide whether to escalate.                                                                                                                                                                                                               |
| Roadmap row already shipped                      | A row already shows `✅ shipped (#$PR_NUMBER)`       | The edit is idempotent — your `Edit` call produces no diff and that's fine. Don't error.                                                                                                                                                                                                                                                                        |
| Multiple table rows match `(#$PR_NUMBER)`        | A PR legitimately spans items                        | Flip all matching rows. The diff is visible to the human reviewer / auto-merge gate before merge.                                                                                                                                                                                                                                                               |
| Inline comment conflicts with a finding          | Same `file:line` covered by both                     | Address once; record `finding_id` for both in the same `commits[]` entry's `reasoning` (e.g. `"agent finding f-7 + reviewer comment c-42 merged into one fix"`).                                                                                                                                                                                                |
| Repo has no GitHub Issues surface                | `flow-create-issue` exits non-zero / Issues disabled | Set `tracker_entry_url: ""` and put the full context in `reason`. The wrapper surfaces both fields loudly in the Step 12 report. Do not append to an in-repo file or invent a tracker integration.                                                                                                                                                              |

# Verification

Before writing the artifact and returning, self-check:

- Every finding from the wrapper's input set is accounted for in
  `commits[]` (addressed) or `deferred[]` (escalated). No finding is
  silently dropped.
- Every inline review comment is either addressed (recorded in a
  `commits[].reasoning`) or surfaced in `deferred[]` with a reason. No
  comment goes unaddressed without a record.
- Every `commits[]` entry has a non-empty `sha`, `files`, `finding_id`,
  `reasoning`, and `verify_status`. `comment_ids` is an array (empty
  `[]` is fine when the commit addresses agent findings only, not
  reviewer comments). `tool_error` is a string (empty `""` is the
  default when no Edit/Write error blocked the fix).
- `verify_status` is `"pass"` for every committed commit, OR the verbatim
  failure excerpt with the cap-exhausted reason in the return summary.
  Never put Edit/Write tool errors into `verify_status` — those go in
  `tool_error`.
- `rejected_alternatives` and `anti_patterns_found` are populated whenever
  you considered alternatives or saw off-pattern code; an empty array is
  only legitimate when you genuinely encountered none.
- `deferred[].tracker_entry_url` is either a real `flow-create-issue` URL
  or an empty string — never a fabricated URL.
- The artifact JSON parses (no trailing commas, no unescaped strings).
- The return summary is 3–5 sentences and surfaces both positive and
  negative findings.

# Constraints

- NEVER ask the user clarifying questions — the Task tool is one-shot.
  When ambiguity blocks a fix, defer it with a `reason` that names the
  ambiguity, or record it as an `anti_patterns_found` entry; do not
  pause waiting for input.
- NEVER write to `/tmp/` or to the worktree root for scratch — every
  transient file lives under `<worktree>/.flow-tmp/<name>`. Same isolation
  rule as the wrapper.
- NEVER call `gh issue create`, the `linear` CLI, or any other tracker
  integration directly — file deferrals through the `flow-create-issue`
  helper (the deferral path above), which is the only sanctioned
  issue-creation path. `tracker_entry_url` defaults to an empty string
  when no GitHub issue was filed (e.g. the repo has no GH Issues surface).
- NEVER skip the `/flow-verify` re-run in step 8. The re-run is the
  load-bearing reason this subagent exists; skipping it returns the
  refactor to its pre-PR-95 shape.
- NEVER omit `rejected_alternatives` or `anti_patterns_found` from the
  artifact. Empty arrays are permitted; the keys are not. Silence on
  negatives is the failure mode the slot exists to prevent.
- NEVER amend a pushed commit. If a fix needs revision after `/flow-verify`
  fails, make a new commit on the same branch.
- NEVER force-push. Branch protection or CI failures get surfaced to the
  wrapper via the artifact's `summary`; the wrapper decides escalation.
- NEVER leave the artifact unwritten. On any failure path — including
  early exit, ambiguous input, or unresolvable verify failure — write the
  artifact with whatever partial state you have. The wrapper's
  missing-artifact escalation is reserved for catastrophic crashes;
  controlled failures must record themselves.
