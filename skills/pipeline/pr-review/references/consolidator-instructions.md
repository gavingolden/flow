# Consolidator + Validator instructions

These instructions are read by the consolidator subagent that `/pr-review`'s
SKILL.md spawns via the Task tool at Step 3.5. The subagent runs in an
isolated context — its per-finding second-opinion reads, the review agents'
raw JSON arrays, and the dedup/threshold filter prose stay inside its own
session and are never returned to the caller. The only outputs it produces
are the structured artifact it writes to disk
(`.flow-tmp/consolidator-result.json`), plus a brief one-paragraph summary
it returns on completion.

The wrapper passes you these inputs in its spawn prompt:

- The absolute paths to each review agent's JSON output file (one per
  agent — currently Bug Detection, Security, Pattern & Consistency,
  Performance, Supply-Chain, and Test Coverage; the agent set lives in
  `pr-review/SKILL.md` Step 3 and is the source of truth). Each file
  contains a JSON array of findings shaped per `references/agent-prompts.md`'s
  Output Format section.
- The absolute worktree path (`WORKTREE` — your working directory).
- The absolute skill base directory (`SKILL_DIR`). Resolve every sibling
  reference path under it — e.g.
  `<SKILL_DIR>/references/agent-prompts.md`. Those files do not exist
  relative to the worktree you `cd`'d into.
- The absolute path to write the artifact (`ARTIFACT_PATH` —
  `.flow-tmp/consolidator-result.json` under the worktree).

# Goal

Merge the review agents' raw JSON arrays into a single deduplicated,
threshold-filtered, second-opinion-validated finding set. Surface the
result via `.flow-tmp/consolidator-result.json` so `/pr-review` Step 4
can consume it from disk in a single read and never has to see the raw
per-agent arrays.

# Inputs

The wrapper provides these absolute paths in the spawn prompt:

- `BUG_DETECTION_OUTPUT` — JSON array, Bug-Detection agent
- `SECURITY_OUTPUT` — JSON array, Security agent
- `PATTERN_OUTPUT` — JSON array, Pattern & Consistency agent
- `PERFORMANCE_OUTPUT` — JSON array, Performance agent
- `SUPPLY_CHAIN_OUTPUT` — JSON array, Supply-Chain agent
- `COVERAGE_OUTPUT` — JSON array, Test Coverage agent
- `WORKTREE` — absolute worktree path
- `SKILL_DIR` — absolute skill base directory
- `ARTIFACT_PATH` — absolute path for the result artifact

Follow the steps below in order.

## 1. Validate each agent's JSON output

Before merging anything, run each agent output through the per-finding
shape validator:

```bash
bun "$SKILL_DIR/../../../bin/lib/agent-finding-schema.ts" --validate "$BUG_DETECTION_OUTPUT"
bun "$SKILL_DIR/../../../bin/lib/agent-finding-schema.ts" --validate "$SECURITY_OUTPUT"
bun "$SKILL_DIR/../../../bin/lib/agent-finding-schema.ts" --validate "$PATTERN_OUTPUT"
bun "$SKILL_DIR/../../../bin/lib/agent-finding-schema.ts" --validate "$PERFORMANCE_OUTPUT"
bun "$SKILL_DIR/../../../bin/lib/agent-finding-schema.ts" --validate "$SUPPLY_CHAIN_OUTPUT"
bun "$SKILL_DIR/../../../bin/lib/agent-finding-schema.ts" --validate "$COVERAGE_OUTPUT"
```

(In practice, resolve `bin/lib/agent-finding-schema.ts` against the flow
checkout root, not `$SKILL_DIR` — the validator ships at
`<flow-checkout>/bin/lib/agent-finding-schema.ts`. The example above uses
relative path arithmetic; if the path doesn't resolve in your environment,
use `npm exec --prefix <flow-checkout> bun bin/lib/agent-finding-schema.ts
--validate <path>` or invoke `bun` with an absolute path you constructed
from the supervisor's repo root.)

On **any** validation failure (any of the agent validations exits non-zero), do not
proceed to merging. Write the wrapper-level result artifact to
`$WORKTREE/.flow-tmp/pr-review-result.json` with:

- `status: "escalated"`
- `escalation_tag: "consolidator-schema-failure: <agent-name>"` (where
  `<agent-name>` is one of `bug-detection`, `security`, `pattern`,
  `performance`, `supply-chain`, `coverage`)
- `completed_steps`: include `"1"`, `"2"`, `"3"`
- `missed_steps`: include `"3.5"`, `"4"`, and downstream labels

Use the write-`.tmp` → validate-`.tmp` → `mv` pattern documented in
`skills/pipeline/pr-review/SKILL.md`'s `# Result artifact` section. Then
also write `$ARTIFACT_PATH` itself with empty arrays and a summary
naming the schema failure (so the wrapper's existence check at Step 3.5
finds an artifact regardless of the failure path):

```bash
cat > "$ARTIFACT_PATH.tmp" <<EOF
{
  "consolidated_findings": [],
  "dropped_by_validation": [],
  "rejected_alternatives": [],
  "anti_patterns_found": [],
  "summary": "Schema failure on <agent-name> agent output; escalated via consolidator-schema-failure."
}
EOF
bun "$SKILL_DIR/../../../bin/lib/consolidator-result-schema.ts" --validate "$ARTIFACT_PATH.tmp" \
  && mv "$ARTIFACT_PATH.tmp" "$ARTIFACT_PATH"
```

Exit non-zero. Do not silently drop a mis-shaped agent output and proceed —
the silent-drop failure mode is exactly what this step exists to prevent.

## 2. Merge and dedupe per the four canonical rules

Pool all agents' findings into a single working list, then apply the
following four filters in order. **These four rules are the single source
of truth for the dedup/filter contract.** They live verbatim here in this
file; `pr-review/SKILL.md`'s Step 4 references this file rather than
duplicating them.

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

## 3. Second-opinion validation pass (in-context)

For each `>= 80`-confidence **non-praise** finding that survived Step 2,
run a second-opinion validation pass *in-context*:

1. `Read` the cited `file:line` (and `end_line` if present) in the
   worktree to inspect the actual code, not just what the agent's `body`
   text described.
2. Decide whether the finding is a true positive (the code at that line
   genuinely exhibits the issue the agent named) or a false positive
   (the agent pattern-matched on shape without confirming the underlying
   semantic).
3. **True positive** → keep the finding in `consolidated_findings[]`.
4. **False positive** → move the finding to `dropped_by_validation[]`
   with a `reason` field naming *why* the second-opinion read disagreed
   (e.g. "agent flagged a null deref but the type narrowing on line 41
   already guarantees non-null", "agent flagged a missing test but
   `src/foo.test.ts:88` covers this branch via an integration spec").

Praise findings skip the validation pass — they are exempt from the
threshold filter and don't carry the same false-positive risk a
blocking/non-blocking issue does. They flow straight from Step 2 into
`consolidated_findings[]`.

The validation pass is in-context (you, the subagent, do the read). This
is the load-bearing reason this subagent exists — the second-opinion
read sees the actual file content alongside the agent's claim, and the
disagreement signal lives inside the consolidator's own context where it
can be expressed in `dropped_by_validation[].reason`. Without this pass,
false positives leak through to `/pr-review` Step 6 (Address Agent
Findings) and the Fix-Applier Subagent has to make the same judgment
call without the context the consolidator already had.

## 4. Write the structured artifact

Write the artifact at `$ARTIFACT_PATH` using the write-`.tmp` →
validate-`.tmp` → `mv` pattern. The wrapper has already created the
parent directory (`$WORKTREE/.flow-tmp/`); you only need to write the
file. Overwrite any prior artifact; do not append (single-shot
semantics).

```bash
cat > "$ARTIFACT_PATH.tmp" <<EOF
{
  "consolidated_findings": [...],
  "dropped_by_validation": [...],
  "rejected_alternatives": [...],
  "anti_patterns_found": [...],
  "summary": "..."
}
EOF
bun "$SKILL_DIR/../../../bin/lib/consolidator-result-schema.ts" --validate "$ARTIFACT_PATH.tmp" \
  && mv "$ARTIFACT_PATH.tmp" "$ARTIFACT_PATH"
```

On validation failure, leave `$ARTIFACT_PATH.tmp` on disk for inspection
and exit non-zero — never `mv` an unvalidated candidate into the canonical
path.

# Result artifact

The artifact MUST conform to this JSON schema:

```json
{
  "consolidated_findings": [
    {
      "file": "<repo-relative path>",
      "line": <positive int>,
      "end_line": <positive int, optional>,
      "label": "praise|nitpick|suggestion|issue|todo|question",
      "decoration": "blocking|non-blocking|if-minor",
      "confidence": <integer 0-100>,
      "subject": "<non-empty>",
      "body": "<may be empty string>"
    }
  ],
  "dropped_by_validation": [
    {
      "finding": { /* same AgentFinding shape as above */ },
      "reason": "<non-empty; why the second-opinion read disagreed>"
    }
  ],
  "rejected_alternatives": [
    "<1-line description of an approach you considered and rolled back>"
  ],
  "anti_patterns_found": [
    "<1-line description of an off-pattern observation the next session should know about>"
  ],
  "summary": "<3-5 sentence both-sides return summary; see step 5>"
}
```

**Negative-findings slots are required.** `rejected_alternatives` and
`anti_patterns_found` are not optional decorations — they are the slots
where you record what you learned should NOT be done. Populate them
proactively as you work. Empty arrays are permitted only when you
genuinely encountered no alternatives (e.g. a clean dedup pass with no
forks) or no anti-patterns (e.g. every agent output agreed and
required no second-opinion disagreement). **Silence is not the default.**

If the artifact is missing keys or fails to parse, the wrapper surfaces
the failure to the supervisor (`NEEDS HUMAN:
consolidator-missing-artifact`). Validate your JSON via
`bin/lib/consolidator-result-schema.ts --validate` before exiting.

## 5. Return a brief summary

Your final message back to the wrapper should be one short paragraph
(3-5 sentences max) that surfaces **both sides** of what you learned:

- At least one positive: how many findings survived consolidation, how
  many false positives the second-opinion pass dropped, the top
  agent-output reflection.
- At least one negative: the top entry from `rejected_alternatives` or
  `anti_patterns_found` — what merging strategy was tried and rolled
  back, or what surrounding anti-pattern the next session should pay
  attention to. A summary that names only positive findings fails the
  contract.

Do not paste the artifact JSON back — the wrapper only forwards your
summary, and the artifact on disk is the durable record. Keeping the
return value short is the whole point of the subagent fan-out.

# Escalation paths

The two named escalation tags this subagent can surface back to the
supervisor (via the wrapper-level `pr-review-result.json`):

- **`consolidator-schema-failure: <agent>`** — one of the agent JSON
  outputs failed shape validation in Step 1. The `<agent>` slot is one
  of `bug-detection`, `security`, `pattern`, `performance`,
  `supply-chain`, `coverage`. The supervisor
  treats this as a partial-review escalation requiring human triage —
  the offending agent's prompt is likely broken or the agent's output
  needs to be regenerated.
- **`consolidator-missing-artifact`** — the subagent exited without
  writing `$ARTIFACT_PATH` (or wrote a malformed artifact the wrapper
  could not parse). Reserved for catastrophic crashes; controlled
  failures must still record themselves in the artifact before exiting.

# Constraints

- **No per-finding Task fan-out.** The second-opinion validation pass
  in Step 3 runs in-context (you read the file, you decide). Spawning a
  per-finding subagent would violate the one-level sub-agent cap and
  defeat the whole reason this exemption exists.
- **No silent drop on schema failure.** If any of the agent JSON
  outputs fails shape validation, escalate per the
  `consolidator-schema-failure: <agent>` path. Silently dropping a
  mis-shaped agent output and proceeding with the remaining agents is
  exactly the failure mode this validator exists to prevent — the
  Fix-Applier later in the pipeline cannot tell the difference between
  "no security findings" and "the security agent's output was
  malformed and we dropped it".
- **Single source of truth for the four dedup rules.** The four rules
  in Step 2 above are the canonical version. `pr-review/SKILL.md`'s
  Step 4 references this file rather than duplicating them. If a rule
  needs to change, change it here once.
- **No `gh issue create` / `flow-create-issue` / `linear` calls.** The
  consolidator's outputs flow into the Fix-Applier Subagent via the
  artifact; deferred-worthy observations belong in
  `anti_patterns_found` so the caller can decide whether to file an
  issue, not in any tracker integration this subagent owns.
- **No commits, amends, or pushes.** This subagent never touches git.
  The caller (Fix-Applier at Step 8) decides commit shape; your job
  ends at writing the artifact.
- **Never leave the artifact unwritten.** On any failure path —
  including early exit, ambiguous input, or unresolvable validation
  failure — write the artifact with whatever partial state you have
  (empty arrays + a `summary` naming the failure). The wrapper's
  `consolidator-missing-artifact` escalation is reserved for
  catastrophic crashes; controlled failures must record themselves.
