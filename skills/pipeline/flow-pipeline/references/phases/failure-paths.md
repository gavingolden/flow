# Failure paths

The general rule: **escalate over silent retry**. Each step has a
documented retry budget; once exhausted, capture deferred follow-ups,
render the NEEDS HUMAN block via `flow-gate-summary` — which records
`phase: needs-human` itself, only after its block reaches stdout, so a
render failure leaves state.json non-terminal and `flow-stop-guard`
keeps nudging — **then** fire the notification. The existing
`# End conditions` sentinel contract is preserved either way (the
helper's final stdout line is the byte-exact sentinel
`NEEDS HUMAN: <reason>`):

```bash
flow-followups run --note-only > "$WORKTREE/.flow-tmp/followups-block.txt"  # captures the deferred LOCAL FOLLOW-UPS block (empty when log is empty)
SLUG="$FLOW_SLUG"                  # for the state-file path
LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)
ECHO_PROSE_ARGS=()  # echo-prose only on POST-review escalations (a PR exists); guard the field fetch + flags on [ -n "$PR" ] — pre-review escalations have no PR/plan
[ -n "$PR" ] && gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName > "$WORKTREE/.flow-tmp/pr-view.json"  # guard: some escalations precede PR creation; ONE gh pr view round-trip (diff-size + url/title/headRefName)
[ -n "$PR" ] && IFS=$'\t' read -r PR_URL PR_TITLE PR_BRANCH < <(jq -r '[.url, .title, .headRefName] | @tsv' "$WORKTREE/.flow-tmp/pr-view.json") && ECHO_PROSE_ARGS=(--echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH")
[ -n "$PR" ] && jq '{additions,deletions,changedFiles,commits:(.commits|length)}' "$WORKTREE/.flow-tmp/pr-view.json" > "$WORKTREE/.flow-tmp/pr-changes.json"
flow-pipeline-summary --status needs-human --state-file ~/.flow/state/"$SLUG".json --pr-changes-file "$WORKTREE/.flow-tmp/pr-changes.json" --pr-review-result "$WORKTREE/.flow-tmp/pr-review-result.json" --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --consolidator-result "$WORKTREE/.flow-tmp/consolidator-result.json" --ci-wait-result "$WORKTREE/.flow-tmp/ci-wait-result.json" --followups-block-file "$WORKTREE/.flow-tmp/followups-block.txt" --filed-issues-file "$WORKTREE/.flow-tmp/filed-issues.txt" --intent-resolution "$WORKTREE/.flow-tmp/intent-resolution.json" "${ECHO_PROSE_ARGS[@]}" --lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)  # prints the ## PIPELINE SNAPSHOT block ABOVE the gate-summary (and the echo recap on top when a PR exists); absent artifacts render as `none`
COUNTS_LINE=$(flow-pipeline-summary --status needs-human --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)
flow-epic-membership --slug "$SLUG" --terminal-state needs-human  # epic-membership block (no-op for non-epic features)
flow-browser-teardown --reap --record  # registry-driven; records outcome; always exits 0
TLDR="<one sentence, <=25 words, the user-visible outcome for <reason>>"  # authored here, not derived; per [TLDR and WHY authoring (product brief)](shared-gate-contracts.md#tldr-and-why-authoring-product-brief)
flow-gate-summary --status needs-human --reason "<reason>" \
  --why "<one-line context>" --cleanup \
  --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt" \
  --tldr "$TLDR" --lens "$LENS" \
  --untracked-file <(flow-untracked render --format gate --unfiled-only) \
  --counts-line "$COUNTS_LINE"  # records phase: needs-human itself, then arms the terminal checkpoint — echo its `checkpointed: ` stderr line verbatim per the Checkpoint arm signal (echo-verbatim) subsection
flow-notify --status needs-human --reason "$TLDR" --tag "<reason>"
```

On a POST-review escalation (a PR exists), after the helper runs, echo the
recap per [Gate-stage echo-verbatim
recap](shared-gate-contracts.md#gate-stage-echo-verbatim-recap---echo-prose). PRE-review escalations
(triage-ambiguous, worktree-create-failed, plan-missing) have no PR/plan, so
`ECHO_PROSE_ARGS` stays empty and no recap is emitted.

The helper looks up the `NEXT ACTION` text from
`NEXT_ACTION_BY_REASON` in `bin/flow-gate-summary.ts` keyed off
`<reason>`, falling back to `DEFAULT_NEXT_ACTION` for unmapped tags;
the final line of stdout is the byte-exact sentinel
`NEEDS HUMAN: <reason>`. Do **not** call `flow-remove-worktree` on
escalation — leave the worktree + PR (and the JSONL log) intact so
the user can inspect and resume.

## No-retry escalation variants

Three escalations take a no-retry path with their own procedure. Each is
deterministically triggered and each has a full block in
`references/failure-recovery.md` § (c) No-retry escalation variants — read it
and execute its block rather than acting from memory.

| Trigger | Reason tag | Action |
|---|---|---|
| `flow-state-update` exits 3 | `branch-mismatch` | no retry — read `references/failure-recovery.md` § No-retry escalation variants and execute its block |
| `flow-state-update` exits 4 (a terminal→non-terminal write that is NOT an allowlisted `gated` / `needs-human` exit (`TERMINAL_EXIT_TRANSITIONS`)) | `terminal-regression` | no retry — read `references/failure-recovery.md` § No-retry escalation variants and execute its block |
| `ToolSearch query="select:Task"` surfaces neither a `Task` nor an `Agent` schema at a spawn site | `task-tool-unavailable: <exemption-name>` | no retry — read `references/failure-recovery.md` § No-retry escalation variants and execute its block |

The full per-step cap table, the resume-from-disk decision tree, and the
three no-retry escalation variants' full procedures live in
`references/failure-recovery.md`.
