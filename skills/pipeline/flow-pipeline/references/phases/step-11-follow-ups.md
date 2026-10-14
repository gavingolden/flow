## Step 11 — Local follow-ups

**Phase:** still `merging` — no new phase value (see "no resume scenario"
note below).

Local follow-ups are manual local-computer steps a pipeline produced (e.g.
`flow install --upgrade` after a new helper landed). Sub-skills register them
during the run via `flow-followups add`; step 11 reports them and, on the
MERGED path, executes the safe subset.

**Two-layer safety boundary:** an entry's `auto: true` flag declares
*intent*; the helper's hardcoded ALLOWLIST gates *permission* (exact-match:
`flow install`, `flow install --upgrade`, and `brew install shellcheck`). Both
must be true to execute. `bin/flow-followups.test.ts` pins the exact set, so
this enumeration and the code cannot drift silently.
Same narrow-and-named exemption pattern as the `/flow-pr-review` auto-push and
`/flow-pipeline` auto-merge clauses in `.claude/rules/flow-supervisor-contracts.md` "Don'ts". Auto-run is
gated by the same `autoMerge` flag as step 10 — `flow feature create --no-auto-merge`
disables both.

**End-state matrix:**

| End-state | Step 11 behaviour |
|---|---|
| MERGED | Run the helper here (post-merge, pre-`flow-remove-worktree`); execute allowlisted+auto entries, note the rest, print `LOCAL FOLLOW-UPS:` block. |
| GATED | Documented in step 9 (`gated` decision branch): `flow-followups pr-body-upsert "$PR"` + `flow-followups run --note-only`. Print before `GATED: <url>`. |
| NEEDS HUMAN | Documented in `# Failure paths`: `flow-followups run --note-only` printed before `NEEDS HUMAN: <reason>`. |
| cancelled | Skipped — the worktree is being removed; pending follow-ups are intentionally lost. |

For MERGED, run the helper here and finalize. **Ordering is
load-bearing on two fronts:** (a) `flow-remove-worktree` deletes the
worktree, so both the follow-ups capture and the `flow-gate-summary`
render must happen BEFORE worktree removal; and (b) `flow-gate-summary`
records `phase: merged` internally, only after its block reaches stdout — so a render failure leaves state.json non-terminal and `flow-stop-guard`
keeps nudging, rather than marking a pipeline merged whose block the user
never saw:

```bash
flow-followups run > "$WORKTREE/.flow-tmp/followups-block.txt"  # executes auto-allowlisted entries; > captures the rendered block
SLUG="$FLOW_SLUG"       # for the state-file path
LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)
gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName > "$WORKTREE/.flow-tmp/pr-view.json"  # ONE gh pr view round-trip: diff-size + url/title/headRefName for the echo recap
IFS=$'\t' read -r PR_URL PR_TITLE PR_BRANCH < <(jq -r '[.url, .title, .headRefName] | @tsv' "$WORKTREE/.flow-tmp/pr-view.json")
jq '{additions,deletions,changedFiles,commits:(.commits|length)}' "$WORKTREE/.flow-tmp/pr-view.json" > "$WORKTREE/.flow-tmp/pr-changes.json"
flow-pipeline-summary --status merged --state-file ~/.flow/state/"$SLUG".json --pr-changes-file "$WORKTREE/.flow-tmp/pr-changes.json" --pr-review-result "$WORKTREE/.flow-tmp/pr-review-result.json" --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --consolidator-result "$WORKTREE/.flow-tmp/consolidator-result.json" --ci-wait-result "$WORKTREE/.flow-tmp/ci-wait-result.json" --followups-block-file "$WORKTREE/.flow-tmp/followups-block.txt" --filed-issues-file "$WORKTREE/.flow-tmp/filed-issues.txt" --intent-resolution "$WORKTREE/.flow-tmp/intent-resolution.json" --post-comment "$PR" --echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH" --lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)  # prints the echo recap (top of stdout) then the ## PIPELINE SNAPSHOT block ABOVE the gate-summary (emits NO sentinel); --post-comment additionally persists the snapshot as an idempotent PR comment (MERGED-only, best-effort)
COUNTS_LINE=$(flow-pipeline-summary --status merged --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)
flow-epic-membership --slug "$SLUG" --terminal-state merged  # epic-membership block (prints nothing for non-epic features)
flow-browser-teardown --reap --record  # registry-driven reap; records the outcome in state.json; always exits 0 — never blocks, never silently no-ops
TLDR="<one sentence, <=25 words, the user-visible outcome>"  # authored here, not derived; per [TLDR and WHY authoring (product brief)](shared-gate-contracts.md#tldr-and-why-authoring-product-brief)
flow-gate-summary --status merged --pr-url "$PR_URL" --cleanup --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt" --tldr "$TLDR" --lens "$LENS" --untracked-file <(flow-untracked render --format gate --unfiled-only) --counts-line "$COUNTS_LINE"  # renders TLDR/STATUS/PR/NEEDS ATTENTION/MANUAL ACTION/UNTRACKED/count line/NEXT ACTION/CLEANUP + sentinel MERGED, then records phase: merged itself (after the block reaches stdout)
flow-notify --status merged --url "$PR_URL" --reason "$TLDR"
[ "$(flow-checkpoint --probe --site terminal | jq -r '.verdict')" = write ] && echo "Pipeline reached MERGED at $(date -u +%Y-%m-%dT%H:%M:%SZ)." > "$(flow-checkpoint --path)"; flow-checkpoint --site terminal >/dev/null  # best-effort, non-clobbering arm (stdout muted so the JSON verdict does not land beside the gate block; stderr deliberately left connected — echo the `checkpointed: ` line verbatim per the Checkpoint arm signal (echo-verbatim) subsection); the merged-externally rows above and the step-9 resume MERGED branch below now carry their own equivalent arm — nothing lost, the body is worktree-independent
flow-remove-worktree --delete-branch
```

Then echo the recap per [Gate-stage echo-verbatim
recap](shared-gate-contracts.md#gate-stage-echo-verbatim-recap---echo-prose). **Discharging the
`advance-to-step-5` disclosure obligation, part 2:** `flow-pipeline-summary`
reads `--pr-title`/`--pr-url` and `--plan-file`, so a PR body carrying the
`Bundled:` Key decisions bullet (written in step 5 above) surfaces in this
recap automatically — no separate step is needed, but do not drop the
`--plan-file` flag from the call above, since that is what makes the
recap see it.

The helper silently suppresses the FOLLOW-UPS slot when the follow-ups
file is empty, so call sites do not stat the path first. End.

### `flow-foreclosed-paths` (PR-body `## Foreclosed Paths` upsert)

`flow-foreclosed-paths pr-body-upsert <PR>` persists the rejected
alternatives and anti-patterns the `/flow-pr-review` Fix-Applier and
Consolidator subagents recorded (`rejected_alternatives[]` +
`anti_patterns_found[]` from `fix-applier-result.json` and
`consolidator-result.json`) as a durable `## Foreclosed Paths` section in
the PR body. It surfaces the full prose, not just the counts the snapshot
shows. The section is built by the same shared formatter the terminal
`FORECLOSED PATHS` snapshot section consumes (markdown mode here,
plain-text mode there), so the two surfaces cannot drift — a unit-level
cross-surface parity test (`bin/lib/foreclosed-paths-format.test.ts`,
including the partial-degradation path) now guards that claim against a
fix-applier artifact with one off-shape entry. The upsert is
idempotent (replace-in-place via the shared heading-parameterized
primitive) and **no-ops** (exit 0, no `gh pr edit`) when there are no
foreclosed paths or the artifacts are absent — same no-op contract as
`flow-followups pr-body-upsert`. It is wired into step 9 next to the
existing `flow-followups pr-body-upsert "$PR"` call on both the
`auto-merge` and `gated` branches. **Persistence caveat:** the section
lives on the GitHub PR page (reviewer-visible, survives squash-merge on
the PR page) but does NOT reach `git log` / `git blame` — gh builds the
squash commit from concatenated commit messages, not the PR description.
Git-history persistence (a commit-message trailer or a committed file)
would be a separate change.
