## Step 6 — Local verify

**Phase:** `verifying`

Write the phase explicitly before invoking verify:

```bash
flow-state-update --phase verifying
```

The verify work runs **inline** now — the supervisor invokes `/flow-verify`
in-process via the Skill tool and observes its output directly in its own
context (no subagent isolation, no separate artifact). Each `/flow-verify`
invocation makes one fix attempt per failing check and re-runs the checks
**at most 5 times** before returning its report (the inner cap in
`skills/pipeline/flow-verify/SKILL.md` Step 4 — the hard ceiling on how
much `flow-pre-commit --json` output can land in this session, replacing
the `maxTurns` bound the removed subagent carried). The supervisor owns the
outer ceiling: it re-invokes `/flow-verify` at most 3 times total (the
3-outer-attempt cap) when an attempt does not end clean, then stops and
returns the report rather than looping further. Each
re-invocation re-runs `flow-pre-commit --json` itself and reuses only passes
recorded on the identical tree within 30 minutes (never for a check that
failed there), so a re-invocation is idempotent.

**Automated UI-smoke pass.** `/flow-verify` Step 1 already runs the
browser-driven UI-smoke pass (when the diff touches a meaningful UI
surface and the `chrome-devtools` MCP is present), following
[references/ui-smoke-pass.md](../ui-smoke-pass.md), and reports the
outcome — passed / skipped (with a reason) / not-applicable — both as part
of its own turn output AND as the `flow-ui-driver` subagent's
`.flow-tmp/ui-driver-result.json` artifact (the eighth Task-tool exemption,
"Hard rules" above), except on the `UI_SMOKE_DRIVER: inline` path where the
pass runs in `/flow-verify`'s own context and the artifact still lands the
same way. When `/flow-verify`'s report shows the UI-smoke
pass was skipped on a UI-touching diff, upsert a user-visible sibling line
under `## Test Steps` outside the `<!-- /flow:verify-caution -->` marker
(idempotent, edit-in-place), using `/flow-verify`'s reported reason:

```bash
gh pr view "$PR" --json body --jq '.body' > "$WORKTREE/.flow-tmp/body.md"
# upsert the sibling line "> [!NOTE] UI changed; browser validation did
# not run — <reason>" under ## Test Steps, then
flow-md-validate --fix-pr-body "$WORKTREE/.flow-tmp/body.md" && gh pr edit "$PR" --body-file "$WORKTREE/.flow-tmp/body.md"
```

Also echo the same line to the user in-session (a plain assistant-message
line, not only the PR-body upsert above) so the gap is visible without
opening the PR.

**Surface UI screenshots.** Read `$WORKTREE/.flow-tmp/ui-driver-result.json`:
`jq -r '.item_results[]?'` first — when any entry carries `screenshots[]`, print each such `item` on its own line followed by its `screenshots[]` — else fall back to `jq -r '.ui_screenshots[]?'` for the paths (the driver already applied the
`test -f` survival guard mapping `evidence_paths[]` from
`flow-ui-validate --captures` — every path here landed on disk), and
`jq -r '.skipped_reason // empty'` for the skip line when the pass did not
run. Print each surviving screenshot path as a markdown link,
`[<abs path>](file://<abs path>)`, one per line, no bullet marker, no
trailing punctuation, all of them, no cap.

**Layer-3 proactive config-authoring branch.** `/flow-verify` owns this
directly (see `skills/pipeline/flow-verify/SKILL.md`): when
`flow-pre-commit --json` returns `reason: "unmatched-files"`, it calls the
pure `draftConfigEntryForOrphans` helper (`bin/lib/monorepo-scopes.ts`)
before treating the orphan as a failure, and commits a matched entry to
`.flow/pre-commit.json`. A config-authoring re-run does not consume an
outer attempt.

**Exhaustion.** After 3 failed outer attempts, escalate `NEEDS HUMAN:
verify-exhausted`. `$FINAL_FAILURE_EXCERPT` is the third attempt's
`flow-pre-commit --json` failure excerpt, copied from `/flow-verify`'s
visible report. It stays in the local file and the terminal escalation;
the PR gets a fixed pointer `> [!CAUTION]` block under `## Test Steps`,
never the output (a re-run replaces it). Then follow `# Failure paths`:

```bash
mkdir -p "$WORKTREE/.flow-tmp"
printf '%s\n' "$FINAL_FAILURE_EXCERPT" > "$WORKTREE/.flow-tmp/verify-caution.txt"
gh pr view "$PR" --json body --jq '.body' > "$WORKTREE/.flow-tmp/body.md"
flow-inject-evidence --body-file "$WORKTREE/.flow-tmp/body.md" --caution-file "$WORKTREE/.flow-tmp/verify-caution.txt"
flow-md-validate --fix-pr-body "$WORKTREE/.flow-tmp/body.md" && gh pr edit "$PR" --body-file "$WORKTREE/.flow-tmp/body.md"
```

**Re-entry / resume.** Phase stays `verifying` and the resume `step-6` row
re-enters here and re-invokes `/flow-verify` inline (it reuses only
same-tree passes — identical tree, at most 30 minutes old, never for a check
that failed there — so a re-invocation is idempotent). `/flow-verify`'s own
Step 3 hybrid threshold still decides narrow-inline vs.
`/flow-coder`-delegated fixes (the sixth named Task-tool exemption); the
work now happens directly in the supervisor's own context — there is no
longer a diff-bytes isolation boundary to preserve at this step. On a clean
pass after re-entry, clear the block; push the body only if it printed
`caution cleared`:

```bash
gh pr view "$PR" --json body --jq '.body' > "$WORKTREE/.flow-tmp/body.md"
flow-inject-evidence --body-file "$WORKTREE/.flow-tmp/body.md" --clear-caution | grep -qx 'caution cleared' \
  && flow-md-validate --fix-pr-body "$WORKTREE/.flow-tmp/body.md" \
  && gh pr edit "$PR" --body-file "$WORKTREE/.flow-tmp/body.md"
```

**End condition:** `/flow-verify` reports a clean pass. Continue to step 7.
