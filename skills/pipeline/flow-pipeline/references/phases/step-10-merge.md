## Step 10 — Merge

Contents: Independent Merge-Conflict Resolver Subagent · Load the Task tool before spawning · Post-merge follow-up sweep

**Phase:** `merging`

Emitted by `flow-merge-guard merge` as a side effect of its checks; there
is no separate phase-write command.

`flow-merge-guard merge "$PR"` is the gate-checked merge, mandatory on every
merge path. It re-fetches the *live* PR body and checks (the same audited
`## Test Steps` parse as `flow-gate-decide`) and refuses — exit 1, no
merge — unless the PR is open and this pipeline's own, the section has zero
unchecked items **or** a fresh gate-override token exists (written by the step 9
"Gate override" sub-step), `autoMerge` is not `false` (or that token is
fresh), and every CI check is passing. On pass it writes `merging` and runs a
bare `gh pr merge --squash` — no `--body`, no `--subject`, so gh builds the
squash body from the branch's commit messages (issue #486 re-litigated this
and lost; see [references/git-workflow.md](../../../../../references/git-workflow.md))
— from the base checkout, never the feature worktree: gh's post-merge `git
checkout <base>` would collide with the primary checkout.

Run it as its **own standalone Bash call** — never inside `$(...)`, a pipe,
or a `cd ... &&` prefix. flow's launch-settings allow rule
`Bash(flow-merge-guard merge *)` ([docs/configuration.md](../../../../../docs/configuration.md),
"Unattended merges under auto mode") only matches that shape; a wrapped
call falls back to the permission classifier, which can refuse a merge.

```bash
flow-merge-guard merge "$PR"
```

The call prints one JSON line and writes the same to
`$WORKTREE/.flow-tmp/merge-result.json` (removed at the start of every
call). Read that file, never a stdout capture, and branch on `.decision`:

- **`merged`** (exit 0, including `reason: already-merged`) — continue to the
  post-merge sweep below.
- **`refused`** (exit 1), **`error`** (exit 2), or exit 127 (helper missing:
  run `flow install --upgrade`) — never merge past the guard or retry it in
  place. Route on the `.reason` prefix: `checks-pending` / `checks-unreadable`
  — CI has not settled, re-enter step 7, then steps 9 and 10; `checks-failed`
  — the step 7 `ci-failed` path; `gate-blocked` — escalate
  `gate-override-without-confirmation`; anything else (`pr-not-owned`,
  `pr-not-open`, `auto-merge-disabled`, `phase-not-advanceable`,
  `checks-unrecognised`, `error`, a missing helper) — escalate
  `merge-refused`. Both escalations render the same block:

  ```bash
  TAG=merge-refused  # or gate-override-without-confirmation, per the routing above
  PR_URL=$(gh pr view "$PR" --json url -q .url 2>/dev/null)
  GUARD_REASON=$(jq -r '.reason // empty' "$WORKTREE/.flow-tmp/merge-result.json" 2>/dev/null)
  GUARD_REASON=${GUARD_REASON:-"flow-merge-guard merge produced no result (helper missing from PATH? run flow install --upgrade)"}
  flow-followups run --note-only > "$WORKTREE/.flow-tmp/followups-block.txt"
  flow-browser-teardown --reap --record  # registry-driven; records outcome; always exits 0
  TLDR="Merge was refused by the merge guard; nothing was merged."
  LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)
  flow-gate-summary --status needs-human \
    --reason "$TAG" --cleanup \
    --pr-url "$PR_URL" --why "$GUARD_REASON" \
    --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt" \
    --tldr "$TLDR" --lens "$LENS"  # records phase: needs-human itself (flow-gate-summary is the sole terminal-phase emitter)
  flow-notify --status needs-human --url "$PR_URL" \
    --reason "$TLDR" --tag "$TAG"
  ```
- **`merge-failed`** (exit 3) with `failureClass: conflict` — spawn the
  Independent Merge-Conflict Resolver Subagent (below), then follow its
  step 3 (CI re-runs on the pushed head first).
- **`merge-failed`** with `failureClass: other` (auth, network,
  branch-protection denial, required check failed, PR closed externally,
  any unrecognised stderr) — re-run the same standalone call once. Do
  **not** spawn the resolver: it can't help with non-conflict failures and
  would waste a Task call.
- **Still `merge-failed` after that one retry** (or a second conflict-class
  failure after a resolver push) — author `TLDR="The merge
  failed after a retry; nothing was lost."`, capture follow-ups
  (`flow-followups run --note-only > "$WORKTREE/.flow-tmp/followups-block.txt"`),
  render via `flow-gate-summary --status needs-human --reason merge-failed
  --pr-url "$PR_URL" --why "$(jq -r .stderr "$WORKTREE/.flow-tmp/merge-result.json" | head -1)"
  --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt" --tldr "$TLDR"
  --lens "$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)"`
  (records `phase: needs-human` itself), then `flow-notify --status
  needs-human --url "<pr-url>" --reason "$TLDR" --tag merge-failed`. Leave
  the worktree intact; then the standard `# Failure paths` chain.
- **The call itself refused by the permission system** (the tool result is
  a permission denial and `merge-result.json` is absent) — do not retry, and
  never try another merge command (no raw `gh pr merge`). Run
  `flow-browser-teardown --reap --record` as its own standalone step, author
  `TLDR="The permission system refused the merge; nothing was merged and
  nothing is lost."`, render via `flow-gate-summary --status needs-human
  --reason merge-permission-denied --pr-url "$PR_URL" --cleanup --tldr
  "$TLDR" --lens "$LENS"` (it adds a conflicting-rule or relaunch line itself), then
  `flow-notify --status needs-human --url "$PR_URL" --reason "$TLDR" --tag
  merge-permission-denied`. End. The reply `merge #<pr>` re-runs the gate and
  this step (`awaiting-human` row, Resume mode).

### Independent Merge-Conflict Resolver Subagent

Fires only on the conflict-class branch above. The subagent merges
`origin/<base>` into the branch, resolves each conflicted file,
records actions taken + ambiguous calls in a structured artifact,
pushes, and returns a brief summary. The supervisor never sees
the merge output, the per-file resolution prose, or the push
transcript — only the artifact and the summary.

**Load the Task tool before spawning** — i.e. before the Task call below. See [../flow-pr-review/references/task-tool-exemption-preamble.md](../../../flow-pr-review/references/task-tool-exemption-preamble.md) for the full rationale. On missing schema: escalate `NEEDS HUMAN: task-tool-unavailable: flow-pipeline-merge-resolver` and exit (do not fall back to in-line execution).

Resolve the inputs the subagent needs, then make exactly **one**
Task call:

```bash
ARTIFACT_PATH="$WORKTREE/.flow-tmp/merge-resolver-result.json"
INSTRUCTIONS_PATH="$SKILL_DIR/../flow-merge-resolver-instructions/SKILL.md"; FLOW_ROOT=$(cd -P "$SKILL_DIR/../../.." && pwd -P); [ -f "$FLOW_ROOT/bin/flow-conflict-marker-check.ts" ] || FLOW_ROOT=$(cd -P "$(dirname "$(realpath "$SKILL_DIR/../../bin/flow-conflict-marker-check")")/.." && pwd -P); MARKER_CHECK_CMD="bun $FLOW_ROOT/bin/flow-conflict-marker-check.ts"  # cd -P+pwd -P load-bearing: a logical cd lands in ~/.flow/claude-home; a private skill copy has no bin/, so the fallback follows its plugin-root helper link to the checkout
BASE_BRANCH=$(gh pr view "$PR" --json baseRefName -q .baseRefName)
mkdir -p "$WORKTREE/.flow-tmp"
rm -f "$ARTIFACT_PATH"   # clear any stale artifact from a prior re-entry (step 10 is re-enterable via the step-7 pr-conflicted row)
# Per-phase model (mergeResolver) — resolution field: state.modelMergeResolver.
# Precedence: --model-merge-resolver > config.models.mergeResolver > inherited.
# Empty ⇒ omit model: from the Task call (inherit). See references/model-routing.md.
SLUG="$FLOW_SLUG"
MERGE_RESOLVER_MODEL=$(jq -r '.modelMergeResolver // empty' ~/.flow/state/"$SLUG".json)
[ -z "$MERGE_RESOLVER_MODEL" ] && MERGE_RESOLVER_MODEL=$(jq -r '.models.mergeResolver // empty' ~/.flow/config.json 2>/dev/null)
# Per-spawn effort: non-empty ⇒ pass effort: "$MERGE_RESOLVER_EFFORT"; empty ⇒ omit.
MERGE_RESOLVER_EFFORT=$(command -v flow-spawn-effort >/dev/null 2>&1 && flow-spawn-effort merge-resolver)
# Best-effort conflicting-file list — only non-empty when an outer
# process already left the worktree mid-merge (the resolver runs the
# merge itself in Step 2). `git diff --name-only --diff-filter=U`
# catches every U-class status (UU/AU/UA/DU/UD), unlike a porcelain
# prefix grep which misses the AU/DU pair where U is in column 2.
git -C "$WORKTREE" fetch origin "$BASE_BRANCH" || echo "warn: git fetch origin $BASE_BRANCH failed; resolver will retry the fetch in Step 2" >&2
CONFLICTING_FILES=$(git -C "$WORKTREE" diff --name-only --diff-filter=U)
PR_DESCRIPTION=$(gh pr view "$PR" --json body -q .body)
MERGE_STDERR=$(jq -r '.stderr // empty' "$WORKTREE/.flow-tmp/merge-result.json")  # the stderr that triggered this resolver
# Guarded agent resolution — contract in references/exemption-contracts.md (exemption #5).
# Plugin-hosted agents resolve ONLY by the plugin-qualified name
# <pluginRootName>:<agentBasename> — a bare name fails Task-tool
# resolution outright (measured: "Agent type 'flow-scout' not found").
MERGE_RESOLVER_SUBAGENT=general-purpose
if [ -f ~/.flow/claude-home/.claude/skills/flow-module-core/agents/flow-merge-resolver.md ]; then
  MERGE_RESOLVER_SUBAGENT=flow-module-core:flow-merge-resolver
else
  echo "NOTICE — agent-fallback: flow-merge-resolver → general-purpose (definition not installed; tool-allowlist containment lost — run \`flow install\`)."
fi
```

See [references/merge-resolver-spawn-prompt.md](../merge-resolver-spawn-prompt.md) for the verbatim spawn-prompt template (nine `{{...}}` placeholders). Fill the placeholders from the resolve-inputs block above before passing it to the Task tool.

Make the Task call with `subagent_type: $MERGE_RESOLVER_SUBAGENT` (resolved
above — `flow-module-core:flow-merge-resolver` on a plugin-root install, else
`general-purpose`), the per-spawn
`model: "$MERGE_RESOLVER_MODEL"` argument resolved above (precedence
`--model-merge-resolver > config.models.mergeResolver > inherited`; when
`$MERGE_RESOLVER_MODEL` is empty, omit `model:` so the resolver inherits the
session model — see [references/model-routing.md](../model-routing.md)),
the per-spawn `effort: "$MERGE_RESOLVER_EFFORT"` argument resolved above (omit
`effort:` when it is empty), and the filled prompt. After it returns:

1. Spawn-denial check: if the Task call itself returns a permission
   denial / refusal (not a subagent result) AND no artifact was
   written, author `TLDR="The merge-conflict resolver couldn't start;
   nothing was touched."` and escalate `NEEDS HUMAN:
   merge-resolver-spawn-denied` via `flow-gate-summary --status needs-human
   --reason merge-resolver-spawn-denied --pr-url
   "$PR_URL" --tldr "$TLDR" --lens "$(jq -r '.output.lens // "pm"'
   ~/.flow/config.json 2>/dev/null)"`, leave the worktree intact, and
   end — do **not** resolve inline in the supervisor
   (see [references/exemption-contracts.md](../../../../../references/exemption-contracts.md)
   for why). Then the standard `# Failure paths` chain. **Partial-result continuation:** a Task result marked partial with an agent id and a missing artifact gets one `SendMessage` continuation per `references/partial-result-continuation.md` before escalating.
2. Existence check: `test -s "$ARTIFACT_PATH"`. If absent, escalate
   `NEEDS HUMAN: merge-resolver-missing-artifact` and end. (Do not
   re-spawn the resolver — exactly one Task call per run, per the
   exemption contract.) Then the standard `# Failure paths` chain.
3. Read the artifact's `push_status`. If `succeeded`, the push moved the head
   and CI re-runs on it, so a merge call now would refuse `checks-pending`:
   re-enter step 7 (CI wait), then steps 9 and 10, which call `flow-merge-guard
   merge "$PR"` again. Spawn the resolver at most once per run — a later
   conflict-class failure takes the "Still `merge-failed`" bullet above. If
   `failed` or `skipped`, do not retry — author `TLDR="The
   conflict-resolver's push didn't take; the merge still needs you."`
   and render the NEEDS HUMAN block via `flow-gate-summary --status needs-human
   --reason merge-failed --pr-url "$PR_URL" --why "$(jq -r
   .summary "$ARTIFACT_PATH" | head -1)" --tldr "$TLDR" --lens "$(jq -r
   '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)"`. End.
   Then the standard `# Failure paths` chain. The artifact stays on disk in
   the worktree for human inspection.

On success, the roadmap row for this PR was already flipped to
`✅ shipped (#$PR)` in the PR's own diff by `/flow-pr-review` step 7.5
(self-mark + sweep), so no post-merge metadata sweep is required.

### Post-merge follow-up sweep

Runs **before** `flow-remove-worktree` (which would delete plan.md
and orphan the candidate-issue list) and before step 11. Reads
`$WORKTREE/.flow-tmp/plan.md`'s `# Candidate follow-up issues`
section, fires `flow-create-issue` once per `- [x]` item, prints a
summary line above `MERGED`. No-op if plan.md is absent (non-feature
pipelines won't have one) or the section is missing or has zero
ticked items.

```bash
PLAN="$WORKTREE/.flow-tmp/plan.md"
FILED=()
WARN=()
REJECTED=()
if [ -f "$PLAN" ] && grep -q '^# Candidate follow-up issues' "$PLAN"; then
  # `--ticked` owns the section parse + em-dash split; metadata fields
  # are `null` sans a matching ranking-table row.
  TICKED_JSON=$(flow-candidate-issues --plan-md-file "$PLAN" --ticked)
  COUNT=$(printf '%s' "$TICKED_JSON" | jq -r '.ticked | length')
  for ((i = 0; i < COUNT; i++)); do
    ITEM=$(printf '%s' "$TICKED_JSON" | jq -c ".ticked[$i]")
    TITLE=$(printf '%s' "$ITEM" | jq -r '.title')
    BODY_FILE="$WORKTREE/.flow-tmp/sweep-$(echo "$TITLE" | tr ' /' '__').md"
    # Body, then the value-prop block (details), then a Rationale/Relation
    # line per non-null field, then the sweep attribution footer.
    printf '%s' "$ITEM" | jq -r --arg pr "$PR" '[.body, (if .details != "" then "\n" + .details else empty end), (if .rationale then "\n**Rationale:** " + .rationale else empty end), (if .relation then "\n**Relation to current request:** " + .relation else empty end), "\nSurfaced by /flow-product-planning during the pipeline that landed PR #" + $pr + "."] | join("\n")' > "$BODY_FILE"
    JSON=$(flow-create-issue \
      --title "$TITLE" \
      --body-file "$BODY_FILE" \
      --label flow-agent,out-of-scope-discovery)
    RC=$?
    # RC=3 (REJECTED, distinct from a WARN gh/Issues-surface failure): the
    # body was rejected by the value-rubric contract; `$JSON` is the
    # rejection envelope, not a URL. Folding it into WARN would launder it.
    if [ $RC -eq 0 ]; then FILED+=("$(printf '%s' "$JSON" | jq -r '.url')")
    elif [ $RC -eq 3 ]; then REJECTED+=("$TITLE")
    else WARN+=("$TITLE"); fi
  done
fi
if [ "${#FILED[@]}" -eq 0 ] && [ "${#WARN[@]}" -eq 0 ] && [ "${#REJECTED[@]}" -eq 0 ]; then
  echo "No follow-up issues filed"
else
  [ "${#WARN[@]}" -gt 0 ] && echo "WARN: no Issues surface for: ${WARN[*]}"
  [ "${#REJECTED[@]}" -gt 0 ] && echo "REJECTED (exit 3, needs repair): ${REJECTED[*]}"
  [ "${#FILED[@]}" -gt 0 ] && { echo "Filed ${#FILED[@]} follow-up issues:"; printf '  %s\n' "${FILED[@]}"; }; fi
# Capture filed/unfiled/rejected entries as filed\t<url> / unfiled\t<title>
# / rejected\t<title> lines; ## PIPELINE SNAPSHOT reads this file. Truncate first.
: > "$WORKTREE/.flow-tmp/filed-issues.txt"
if [ "${#FILED[@]}" -gt 0 ]; then printf 'filed\t%s\n' "${FILED[@]}" >> "$WORKTREE/.flow-tmp/filed-issues.txt"; fi
if [ "${#WARN[@]}" -gt 0 ]; then printf 'unfiled\t%s\n' "${WARN[@]}" >> "$WORKTREE/.flow-tmp/filed-issues.txt"; fi
if [ "${#REJECTED[@]}" -gt 0 ]; then printf 'rejected\t%s\n' "${REJECTED[@]}" >> "$WORKTREE/.flow-tmp/filed-issues.txt"; fi
```

The sweep is best-effort: per-call failure surfaces as a `WARN:` line
but does not fail the pipeline — the merge already shipped.
`flow-create-issue`'s title-collision idempotency makes a sweep re-run
on resume safe (re-firing yields `flow-create-issue`'s `action:
"existing"` and the same URL — distinct from `flow-candidate-issues`'
decision enum).

Continue to step 11 — local follow-ups must run *before*
`flow-remove-worktree` so the JSONL log is still on disk when the
report builds.
