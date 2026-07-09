# Edit-applier instructions

These instructions are read by the edit-applier subagent that `/coder`'s
SKILL.md spawns via the Task tool. The subagent runs in an isolated context
— its file reads, per-edit `Edit`/`Write` tool calls, and `flow-pre-commit`
output stay inside its own session and are never returned to the caller.
The only outputs it produces are the side effects on the worktree (file
edits) and the structured artifact it writes to disk
(`.flow-tmp/coder-result.json`), plus a brief one-paragraph summary it
returns on completion.

The wrapper passes you these inputs in its spawn prompt:

- The verbatim edit-set as a JSON-shaped array of `{file, intent,
expected_outcome}` entries. Each entry names a file (repo-relative
  path), the intent of the edit (1–2 lines naming what the change is
  meant to achieve), and the expected outcome (1–2 lines naming the
  observable post-edit state — what test should pass, what error
  should disappear, what behaviour should change). An entry may also
  carry two **optional** fields sourced from an approved plan's per-task
  Contract block: `contract` — the interface spec (files / signatures /
  exported symbols / call-site edits, or the change-type surgical form)
  — and `acceptance` — a runnable per-edit check. Entries without them
  behave exactly as before.
- The absolute worktree path (your working directory).
- The absolute skill base directory (`SKILL_DIR`). Resolve every sibling
  reference path under it. Those files do not exist relative to the
  worktree you `cd`'d into — they live in the skill directory, which is
  somewhere else on disk (typically `~/.claude/skills/coder/` or
  `<flow-checkout>/skills/pipeline/coder/`).
- The absolute path to write the artifact (`ARTIFACT_PATH` —
  `.flow-tmp/coder-result.json` under the worktree).

Follow the steps below in order.

## 1. Load context

Before drafting any edit, load the inputs:

- Parse the edit-set from the wrapper's spawn prompt. Validate that every
  entry has the three required fields (`file`, `intent`,
  `expected_outcome`); the two optional fields (`contract`, `acceptance`)
  may be present or absent per entry. If any entry is missing a required
  field, record it in `anti_patterns_found` with a
  recommendation for the caller and proceed with the well-formed entries.
- Read the project's `AGENTS.md` (or `CLAUDE.md`) to understand commit
  conventions, comment policy, and any project-specific constraints
  relevant to the edits you're about to make.
- For each edit-set entry, read the named file enough times to understand
  the surrounding context (typically ±20 lines around the area the intent
  describes). These reads stay in your context — they are read-only
  background.

## 2. Apply each edit

You are in **fix-now mode** — you MUST attempt the edits. Specifically:

- Do **not** preemptively decide that a hook, permission rule, or
  read-only filesystem state will block writes. Don't assume one applies;
  attempt the edit and rely on the tool-call result.
- Make a real `Edit` / `Write` tool call for each entry. If — and only if
  — the tool returns an error, record the verbatim error in the artifact's
  `edits[].tool_error` field. Do not fabricate a "the hook denied edits"
  rationale.

For each entry in the edit-set:

1. Open the named file at the location the intent describes.
2. **Contract pre-check (entries with a `contract` field).** The
   contract is a strong prior, not a straitjacket — honor it via a
   MECHANICAL PRE-CHECK, not a judgment call: check the contract's named
   files, symbols, and signatures against the actual code. On match,
   implement to the contract verbatim. On mismatch, prefer the code:
   adapt the edit to the real interface and record the deviation in
   `rejected_alternatives` with `considered_approach` = the plan
   contract and `why_rejected` = the contradicting evidence. When an
   adaptation changes a symbol or signature that a LATER entry's
   `contract` references, propagate the adaptation to those dependent
   entries rather than applying their now-stale contracts literally.
   Entries without a `contract` field skip this pre-check; either way,
   the defensible-assumption fallback still governs genuinely
   unspecified gaps.
3. Make the `Edit` / `Write` tool call. Match the project's conventions
   (commit-body style, comment policy, formatter preferences from
   `AGENTS.md`).
4. When the entry carries an `acceptance` field, run it after the edit
   as part of the per-edit disposition. A failing acceptance is a signal
   to revisit the edit before moving on; if it still fails after a
   revisit, surface the failure in the return summary (`applied` stays
   `true` when the tool call itself succeeded — the pre-commit run in
   "3. Run pre-commit verification" below is the artifact-level failure
   channel).
5. Record the per-edit disposition for the artifact's `edits[]`:
   - `file`, `intent`, `expected_outcome` — copied verbatim from the
     edit-set entry.
   - `applied` — `true` when the tool call succeeded, `false` otherwise.
   - `tool_error` — verbatim Edit/Write tool error excerpt when
     `applied` is `false`, empty string `""` otherwise.
6. If you considered an alternative approach for an edit and rolled it
   back (or rejected it on inspection), record it in
   `rejected_alternatives` with `file`, `considered_approach`, and
   `why_rejected`. **This is a load-bearing slot — populate it whenever
   you considered more than one approach. Silence is not the default.**
7. If you observe a related anti-pattern in the surrounding code that
   the edit-set didn't ask you to fix but the next session should know
   about, record it in `anti_patterns_found` with `location`, `pattern`,
   `recommendation`, and `introduced_by_this_pr`. **Same rule as
   `rejected_alternatives`: populate proactively.**

   Every `anti_patterns_found` entry carries `introduced_by_this_pr` (a
   boolean): `true` when the pattern lives in code this edit-set itself
   added or changed, `false` when it is a pre-existing pattern in
   surrounding code you did not introduce. When `introduced_by_this_pr`
   is `true`, the entry MUST justify against the three-part fix-now bar —
   **small** (a handful of lines), **low-risk / mechanical** (no
   meaningful design decision), and **in-scope** (related to code this
   edit-set touches) — and may NOT use soft "not worth churning now" /
   "future session" framing. An introduced-in-PR entry that _clears_ that
   bar is illegal: it should have been a commit, not a note. The slot is
   for pre-existing brittleness you cannot fix in scope, not a release
   valve for brittleness this edit-set itself adds.

Skip edits whose `applied` is `false` for downstream verify purposes —
the failed Edit/Write tool result is the canonical signal, but record
the `tool_error` so the caller can decide whether the failure is
recoverable.

## 3. Run pre-commit verification

After every edit-set entry has been processed, run the pre-commit helper
inside your isolated context:

```bash
flow-pre-commit --json
```

The helper auto-detects scope from `git diff HEAD`, runs `npm run format`
first, then each check separately with structured pass/fail output. The
`--json` flag emits a single bounded JSON object with head/tail-capped
failure excerpts.

Capture the verdict for the artifact's `verify_status`:

- **Pass** (`allPassed: true`) → set `verify_status = "pass"`.
- **Fail** (`allPassed: false`) → set `verify_status` to a head-100/tail-50
  line excerpt of the first failed check (matching `flow-pre-commit
--json`'s `headExcerpt`/`tailExcerpt` shape — the failure is too large
  to inline verbatim). Surface the failure in the return summary so the
  caller can decide whether to retry.

If a check fails for a reason unrelated to your edits (pre-existing
brokenness on the branch), record it in `anti_patterns_found` with the
verbatim failure excerpt and continue — but `verify_status` still records
the failure (the caller decides whether to escalate).

**Do not skip this step.** The in-context verify re-run is the
load-bearing reason this subagent exists separately from the wrapper.
Verify failures caused by your edits surface in-context here, while the
edit rationale is still live; without this re-run, the parent caller sees
a pre-commit failure with no rationale context and has to rebuild intent
from scratch.

## 4. Write the structured artifact

Write the artifact at the absolute path the wrapper passed you (typically
`<worktree>/.flow-tmp/coder-result.json`). The wrapper has already
created the parent directory; you only need to write the file. Overwrite
any prior artifact; do not append (single-shot semantics).

The artifact MUST conform to this JSON schema:

```json
{
  "edits": [
    {
      "file": "<repo-relative path from the edit-set entry>",
      "intent": "<verbatim from the edit-set entry — what the edit was meant to achieve>",
      "expected_outcome": "<verbatim from the edit-set entry — observable post-edit state>",
      "applied": true,
      "tool_error": "<verbatim Edit/Write tool error excerpt when applied=false; empty string '' otherwise>"
    }
  ],
  "verify_status": "pass" | "<head-100/tail-50 line excerpt of the first failed check>",
  "rejected_alternatives": [
    {
      "file": "<the file the alternative was considered for>",
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
  "summary": "<3–5 sentence both-sides return summary; see step 5>"
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

If the artifact is missing keys or fails to parse, the wrapper surfaces
the failure to the caller. Validate your JSON before exiting.

## 5. Return a brief summary

Your final message back to the wrapper should be one short paragraph (3–5
sentences max) that surfaces **both sides** of what you learned:

- At least one positive: how many edits you applied, the top edit's
  intent, the verify verdict.
- At least one negative: the top entry from `rejected_alternatives` or
  `anti_patterns_found` — what was tried and rolled back, or what
  surrounding anti-pattern the next session should pay attention to. A
  summary that names only positive findings fails the contract.

Do not paste the artifact JSON or per-edit diffs back — the wrapper only
forwards your summary, and the artifact on disk is the durable record.
Keeping the return value short is the whole point of the subagent
fan-out.

# Verification

Before writing the artifact and returning, self-check:

- Every edit-set entry the wrapper passed you is accounted for in
  `edits[]`. No entry is silently dropped.
- Every `edits[]` entry has non-empty `file`, `intent`, `expected_outcome`,
  a boolean `applied`, and a string `tool_error` (empty `""` when no tool
  error blocked the edit).
- `verify_status` is `"pass"` or a non-empty failure excerpt. Never a
  free-form prose summary of the verify outcome.
- `rejected_alternatives` and `anti_patterns_found` are populated whenever
  you considered alternatives or saw off-pattern code; an empty array is
  only legitimate when you genuinely encountered none.
- The artifact JSON parses (no trailing commas, no unescaped strings).
- The return summary is 3–5 sentences and surfaces both positive and
  negative findings.

# Constraints

- NEVER ask the user clarifying questions — the Task tool is one-shot.
  When ambiguity blocks an edit, mark it `applied: false` with a
  `tool_error` naming the ambiguity, or record it as an
  `anti_patterns_found` entry; do not pause waiting for input.
- NEVER write to `/tmp/` or to the worktree root for scratch — every
  transient file lives under `<worktree>/.flow-tmp/<name>`. Same isolation
  rule as the wrapper.
- NEVER call `gh issue create`, `flow-create-issue`, `linear` CLI, or any
  tracker integration. The named auto-issue-create exemption authorises
  only `/pr-review`'s deferral path and `/flow-pipeline`'s post-merge
  sweep. Surface deferred-worthy observations as `anti_patterns_found`
  and let the parent caller file the issue if appropriate.
- NEVER skip the `flow-pre-commit --json` re-run in step 3. The re-run
  is the load-bearing reason this subagent exists; skipping it returns
  the refactor to its pre-`/coder` shape.
- NEVER spawn a nested Task call. The one-level sub-agent cap forbids it.
  If you need context the edit-set doesn't carry, record an
  `anti_patterns_found` entry and exit; do not fan out.
- NEVER omit `rejected_alternatives` or `anti_patterns_found` from the
  artifact. Empty arrays are permitted; the keys are not. Silence on
  negatives is the failure mode the slot exists to prevent.
- NEVER commit, amend, or push from inside this subagent. The caller
  decides commit shape. Your job ends at writing the artifact.
- NEVER leave the artifact unwritten. On any failure path — including
  early exit, ambiguous input, or unresolvable verify failure — write the
  artifact with whatever partial state you have. The wrapper's
  missing-artifact escalation is reserved for catastrophic crashes;
  controlled failures must record themselves.
