# Consolidator-Validator instructions

These instructions are read by the Consolidator-Validator subagent that
`/pr-review`'s SKILL.md spawns via the Task tool at Step 3.5 — after
Step 3's six-agent multi-agent review and before Step 4's
finding-consumption pass. The subagent runs in an isolated context: its
per-agent JSON reads, second-opinion validation prose, and dedup
reasoning all stay inside its own session and are never returned to the
caller. The only outputs it produces are the structured artifact at
`<worktree>/.flow-tmp/consolidator-result.json` and a brief
one-paragraph summary it returns on completion.

## 1. Role and scope

The Consolidator-Validator's job:

- Read the six per-agent JSON outputs (one each from bug-detection,
  security, pattern-consistency, performance, supply-chain,
  test-coverage), validate each against the per-agent schema, and merge
  them into a single findings array.
- Apply the confidence threshold (>=80 for non-praise; praise findings
  pass through unfiltered) and dedup by `(file, line ± 2 lines window,
  issue-class)`.
- Apply praise specificity (drop content-free praise).
- Run a **second-opinion** validation pass on every >=80-confidence
  non-praise finding that survives dedup, moving false positives to
  `dropped_by_validation[]` with a `reason` string naming the rule
  that rejected them.
- Write the consolidated + validated artifact at
  `<worktree>/.flow-tmp/consolidator-result.json` using the atomic
  write-`.tmp` → validate-`.tmp` → `mv` idiom.

The Consolidator-Validator's job is NOT:

- It does **not** post PR comments — that's Step 8c of `/pr-review`'s
  wrapper.
- It does **not** apply fixes — that's the Fix-Applier Subagent (Step 8).
- It does **not** read review-comment threads or static-analysis output
  — those are upstream agent inputs already digested at Step 3.

## 2. Inputs

The wrapper passes you these inputs in its spawn prompt:

- The absolute worktree path (your working directory).
- The absolute skill base directory (`SKILL_DIR`).
- Six absolute per-agent output paths, one each:
  - `$WORKTREE/.flow-tmp/agent-output-bug-detection.json`
  - `$WORKTREE/.flow-tmp/agent-output-security.json`
  - `$WORKTREE/.flow-tmp/agent-output-pattern-consistency.json`
  - `$WORKTREE/.flow-tmp/agent-output-performance.json`
  - `$WORKTREE/.flow-tmp/agent-output-supply-chain.json`
  - `$WORKTREE/.flow-tmp/agent-output-test-coverage.json`
- The static-analysis JSON path at
  `$WORKTREE/.flow-tmp/static-analysis.json` (for context only — you
  don't re-derive from it; the agents already absorbed it).
- The PR diff path (`DIFF_PATH`, typically
  `$WORKTREE/.flow-tmp/diff.txt` — `flow-pr-diff <number>` output)
  and the PR metadata (`PR_METADATA`, the `gh pr view --json
  number,title,headRefName,baseRefName` JSON the wrapper saved to
  scratch, or the same fields inlined). Both feed the second-opinion
  validation pass's in-scope-of-diff check below.
- The absolute artifact path to write
  (`$WORKTREE/.flow-tmp/consolidator-result.json`).

## 3. Procedure

### (a) Read and validate each per-agent output

For each of the six per-agent paths, run:

```bash
flow-agent-finding-schema --validate "$PER_AGENT_PATH"
```

The validator now coerces trivially-fixable label/decoration drift (strips a
single surrounding-paren pair from `decoration`; maps lens-name / `add-a-test`
/ `doc-fix` labels to `suggestion`) BEFORE validating, so
`consolidator-schema-failure` fires only on genuinely-unparseable findings;
`bin/lib/agent-finding-schema.ts` is the authoritative source for exactly what
is and isn't coerced.

Exit-1 outcomes are split by source:

- **File missing** (`test -s "$PER_AGENT_PATH"` fails): escalate
  `consolidator-missing-artifact`. Write
  `<worktree>/.flow-tmp/pr-review-result.json` with `status: "escalated"`
  and `escalation_tag: "consolidator-missing-artifact"` per the
  `consolidator-missing-artifact` recipe in
  [references/escalation-recipes.md](escalation-recipes.md), then exit.
- **Schema validation failed** (the file exists but its JSON shape is
  invalid): escalate `consolidator-schema-failure`. Same write protocol,
  with `escalation_tag: "consolidator-schema-failure"` per the
  `consolidator-schema-failure` recipe in
  [references/escalation-recipes.md](escalation-recipes.md), then exit.

Escalation writes overwrite any prior `pr-review-result.json` with
`status: "clean"` — escalation always wins over a prior clean status.
But the read-before-overwrite guard from
[references/result-artifact-write-protocol.md](result-artifact-write-protocol.md)
DOES apply to these escalation writes too: if the prior artifact is
already `status: "escalated"` (from an even earlier subagent), skip
the write and exit. This prevents a less-specific escalation tag from
clobbering a more-specific one. The recipes in
[references/escalation-recipes.md](escalation-recipes.md) include the
guard inline.

### (b) Merge into a single array

Read each per-agent output, tag each finding with its source agent
(`agent_source: "bug-detection"`, etc.), assign each a stable
`finding_id` of the form `<agent>:<file>:<line>:<label>` (or
`<agent>:<file>:<line>:<label>:<idx>` if dedup-by-id is needed within
one agent's output). Concatenate into a single in-memory array.

### (c) Filter and dedup

Apply, in order:

- **Confidence threshold**: drop non-praise findings with `confidence <
  80`. Praise findings pass through (the threshold is non-praise-only
  per Step 4's existing rules in pr-review/SKILL.md).
- **Deduplication**: cluster findings by `(file, line ± 2 lines
  window, issue-class)`. Keep the highest-confidence entry per cluster;
  drop the rest into `dropped_by_validation[]` with `reason:
  "duplicate of <higher-confidence finding_id>"`. Two findings at the
  same location about different issue classes (e.g. null deref vs.
  injection risk) are NOT duplicates and survive.
- **Praise specificity**: drop praise findings that fail the
  specificity bar (content-free openers/closers like "great work",
  "nice refactor", "looks great overall"). Move to
  `dropped_by_validation[]` with `reason: "low-specificity praise"`.

### (d) Second-opinion validation pass

For each >=80-confidence **non-praise** finding that survives dedup,
apply this in-context rubric (an embedded prompt you self-apply — do
NOT spawn a sub-sub-agent; the one-level sub-agent cap forbids it):

- Is the cited line actually in scope of the diff? (PR-touched lines
  only.)
- Does the cited code actually behave as the finding claims? (Read the
  file at the exact path and confirm.)
- Is the framework or language already preventing the described
  defect? (e.g. SvelteKit's auto-XSS escaping, the type system already
  proving non-nullability.)
- Is the cited line in a test fixture or generated file? (A
  hardcoded-secret finding in `*.test.ts` or `dist/` is almost always
  a false positive.)

False positives move to `dropped_by_validation[]` with a `reason`
string naming the rule that rejected them — e.g. `"false-positive:
cited line is in test fixture"`, `"false-positive: framework already
prevents this"`, `"false-positive: out-of-diff context"`. Praise
findings and `<80`-confidence findings (which were already dropped at
step (c)) skip the second-opinion pass entirely.

The second-opinion rubric is calibrated for false-positive suppression,
not false-negative recovery. A finding that doesn't appear in any
agent's output stays absent — the consolidator does not invent new
findings.

### (e) Write the artifact

Write `consolidator-result.json` atomically:

```bash
ARTIFACT_PATH="$WORKTREE/.flow-tmp/consolidator-result.json"

cat > "$ARTIFACT_PATH.tmp" <<EOF
{
  "consolidated_findings": [...],
  "dropped_by_validation": [...],
  "rejected_alternatives": [...],
  "anti_patterns_found": [...],
  "summary": "..."
}
EOF

flow-agent-finding-schema --validate "$ARTIFACT_PATH.tmp" \
  && mv "$ARTIFACT_PATH.tmp" "$ARTIFACT_PATH"
```

The `flow-agent-finding-schema --validate` invocation
dispatches by JSON shape: presence of `consolidated_findings` routes
to `validateConsolidatorResult`. On validation failure, leave the
`.tmp` file on disk for inspection and escalate
`consolidator-schema-failure` per the recipe in
[references/escalation-recipes.md](escalation-recipes.md).

The clean-exit write itself does NOT use the read-before-overwrite
guard from
[references/result-artifact-write-protocol.md](result-artifact-write-protocol.md)
because this is a write to `consolidator-result.json`, not
`pr-review-result.json`. The protocol applies only to the
`pr-review-result.json` clean-exit sites (Step 1.5 Gatekeeper "skip"
branch, Step 13 clean-completion). The consolidator's artifact is
single-use, read once by `/pr-review`'s wrapper at Step 4, and never
overwrites a prior escalation.

### (f) Return summary

Return a brief 3–5-sentence both-sides summary surfacing at least one
positive AND at least one negative finding. Examples:

- Positive: "Consolidated 17 findings from 6 agents into 14 surfaced +
  3 dropped during second-opinion validation."
- Negative (from `rejected_alternatives` or `anti_patterns_found`):
  "Considered relaxing the dedup window to ±5 lines but rolled back
  because that would cluster unrelated findings on long
  functions." OR "Two agents flagged the same line with different
  issue classes; the dedup window correctly preserved both."

A summary that names only positive findings fails the contract.
**Silence is not the default.**

## 4. Artifact schema

The five top-level keys, with their types and one-line descriptions:

| Key | Type | Description |
|---|---|---|
| `consolidated_findings` | `Array<Finding>` | Per-agent findings that cleared the confidence threshold, dedup, praise specificity, and the second-opinion validation pass. Each carries `finding_id`, `agent_source`, and the standard per-agent finding fields (`file`, `line`, `end_line?`, `label`, `decoration`, `confidence`, `subject`, `body`). |
| `dropped_by_validation` | `Array<{finding_id: string, original_finding: object, reason: string}>` | Findings the consolidator removed — duplicates, low-specificity praise, second-opinion false positives. The `reason` string names the rule that rejected each entry. |
| `rejected_alternatives` | `Array<string>` | Consolidation strategies considered and rolled back (e.g. "dropped dedup window from ±5 to ±2 lines because long functions clustered unrelated findings"). |
| `anti_patterns_found` | `Array<string>` | Off-pattern observations the next session should know about (e.g. "Pattern-Consistency and Performance agents both flagged the same `await`-in-loop; the lens-sharing rule worked but logged a clustering note"). |
| `summary` | `string` | One-paragraph both-sides summary (≥1 positive, ≥1 negative). |

The validator at `bin/lib/agent-finding-schema.ts` is the runtime
schema reference: `validateConsolidatorResult(parsed)` enforces the
above shape strictly and exits 1 with a typed reason string on any
deviation.

## 5. Escalation recipes

Two escalation paths are documented in
[references/escalation-recipes.md](escalation-recipes.md):

- **`consolidator-schema-failure`** — fires when
  `flow-agent-finding-schema --validate` exits 1 on any of
  the six per-agent outputs (one of the upstream agents produced
  malformed JSON), or on the consolidator's own pre-`mv`
  `validateConsolidatorResult` call (the consolidator itself produced
  malformed JSON in its candidate `.tmp` file).
- **`consolidator-missing-artifact`** — fires when the wrapper's
  post-spawn existence check `test -s
  $WORKTREE/.flow-tmp/consolidator-result.json` fails (the
  Consolidator subagent crashed before writing its artifact).

Both heredocs use the atomic write-`.tmp` → validate-`.tmp` → `mv`
idiom shared with the existing recipes. The
read-before-overwrite guard from
[references/result-artifact-write-protocol.md](result-artifact-write-protocol.md)
applies to **clean-exit** writes of `pr-review-result.json`, not to
escalation writes — escalation overwriting a prior status is the
correct behaviour.

## 6. Negative-findings contract

The Consolidator-Validator MUST populate `rejected_alternatives[]` and
`anti_patterns_found[]` with at least one entry each when applicable.
**Silence is not the default.** If you considered an alternative
consolidation strategy and rolled it back (even briefly), record it.
If you observed an off-pattern in passing — two agents flagging the
same line with overlapping but distinct findings, a static-analysis
lens producing high-confidence false positives in test fixtures, a
dedup cluster spanning more lines than expected — record it.

The summary must surface both sides: at least one positive (a
consolidated-count statistic, the highest-confidence cluster's intent,
the second-opinion drop rate) AND at least one negative (the top entry
from `rejected_alternatives` or `anti_patterns_found`). A summary that
names only positive findings fails the contract.

# Verification

Before writing the artifact and returning, self-check:

- All six per-agent output paths were read and validated. Any missing
  or schema-invalid file escalated to the appropriate recipe.
- `consolidated_findings[]` contains only findings that cleared the
  threshold, dedup, praise specificity, and second-opinion validation.
- `dropped_by_validation[]` contains every removed finding with a
  non-empty `reason` string.
- `rejected_alternatives[]` and `anti_patterns_found[]` are populated
  whenever you considered alternatives or saw off-pattern code.
- The artifact JSON parses and passes
  `flow-agent-finding-schema --validate` on the `.tmp` file
  before the `mv`.
- The return summary is 3–5 sentences and surfaces both positive and
  negative findings.
