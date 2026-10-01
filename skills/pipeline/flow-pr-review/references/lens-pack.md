# Lens brief (spawn prompt shape)

When `review.lensPack` is on, `flow-review-prep --skill-dir "$SKILL_DIR"`
(Step 2) renders one self-contained brief per `gates.<lens>.run == true`
lens at `$WORKTREE/.flow-tmp/lens-prompt-<lens>.md` and lists them in the
summary's `.lens_prompts` (lens to absolute path). A brief carries the
shared context block with every template variable filled, the lens
checklist, `conventional-comments.md`, the base-branch
`.flow/review-checklist.md` when present, and the lens section last.

## Spawn prompt

For every lens whose `.lens_prompts[<lens>]` is present, spawn with:

```text
Read exactly $WORKTREE/.flow-tmp/lens-prompt-<lens>.md first — it is your complete brief; Read/Grep further only for a finding that needs it; write $WORKTREE/.flow-tmp/agent-output-<lens>.json
```

Set `PACK_USED=1` once any lens spawned this way; leave it unset otherwise.
Step 12 forwards it as `PACK_ARGS=(--pack)` so the telemetry row records
which cohort the run belongs to.

## Fallback: pointer prompt

When `.lens_prompts[<lens>]` is absent (`review.lensPack` off, `NOTICE —
lens-pack: …` in `.notices`, or a render error for that lens), spawn from
the template exactly as before ("the agent table below" is the seven-agent
table in SKILL.md Step 3):

- Copy the shared context block from `references/agent-prompts.md`
- Fill in the template variables: `{{PR_NUMBER}}`, `{{PR_TITLE}}`, `{{PR_DESCRIPTION}}`,
  `{{COMMIT_MESSAGES}}` (full bodies from step 3), `{{CHANGED_FILES_LIST}}`, `{{DIFF}}`,
  `{{STATIC_ANALYSIS_FACTS}}`, `{{EXISTING_INTENT_COMMENTS}}` (from step 6's
  `.flow-tmp/intent-comments.md`), `{{REVIEW_SCOPE}}` (per
  `references/review-scope.md` "Spawn only the ungated lenses"),
  (Pattern & Consistency Agent only) `{{PROMPT_INTERPRETATION_TENSION}}` from
  `$PROMPT_INTERPRETATION_TENSION` computed in step 5 above, and
  (Product Agent only) `{{PRODUCT_BRIEF_PATH}}` from
  `jq -r '.product_brief.path // empty' "$WORKTREE/.flow-tmp/review-scope.json"`.
  For the static-analysis variable, substitute a single
  self-contained JSON object containing both the lens findings and the matching meta
  slice — agents are instructed to check `meta.<lens>.ran` so the substituted block
  needs both. Construct each agent's `{{STATIC_ANALYSIS_FACTS}}` block by running
  `flow-pr-agent-lens --agent <kebab-name>` against
  `.flow-tmp/static-analysis.json` (the lens routing is owned by the helper; the
  agent table below lists the lens-per-agent for human reference).
