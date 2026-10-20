## Step 9 — Auto-merge gate

Contents: Post-render QA prose · A gated verdict is terminal, not advisory · Gate auto-checkpoint sub-step · Feedback-mode turn-ending replies · Gate override (post-verdict, opt-in) · Re-query the live gate first

**Phase:** `gating`

Emitted by `flow-gate-decide` as a side effect of returning the value
this step branches on (`.decision`); there is no separate phase-write
command.

`flow-gate-decide` consolidates the rubric parse (heading-presence grep →
section extract → HTML-comment strip → unchecked-`- [ ]`-count) and the
four-state matrix (PR state × autoMerge opt-out × section verdict) into one
call. The heading contract lives in **`references/auto-merge-rubric.md`**
(single source of truth) and is unit-tested at
`bin/flow-gate-decide.test.ts`. The heading-presence check is load-bearing:
a missing heading escalates explicitly rather than collapsing to
auto-merge (which would ship a PR the user expected to be gated).

```bash
RESULT=$(flow-gate-decide "$PR")
DECISION=$(printf '%s' "$RESULT" | jq -r '.decision')
PR_URL=$(printf '%s' "$RESULT" | jq -r '.prUrl // empty')
REASON=$(printf '%s' "$RESULT" | jq -r '.reason // empty')
VALIDATION_ITEMS=$(printf '%s' "$RESULT" | jq -r '.validationItems[]? // empty')
```

The helper reads `autoMerge` from `~/.flow/state/<slug>.json`
itself (defaulting to `true` when absent). `autoMerge: false` —
the user passed `flow feature create --no-auto-merge`, or
`flow-state-update --no-auto-merge` was issued mid-flight — routes
every `OPEN` PR to `gated` (or `browser-retry`, when only un-run browser checks are open) regardless of section content. `MERGED`
and `CLOSED` states still take their normal branches.

Branch on `.decision`. Resolve the render lens once for the whole table: `LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)`. At every terminal `flow-gate-summary` render below (status: merged, gated, needs-human, or cancelled), first author `TLDR="<one sentence, ≤25 words, the user-visible outcome>"` (per [TLDR and WHY authoring (product brief)](shared-gate-contracts.md#tldr-and-why-authoring-product-brief)) and pass `--tldr "$TLDR"`; a `flow-notify` call in the same row passes `--reason "$TLDR"` (needs-human also passes `--tag <reason-tag>`); a `flow-pipeline-summary` call in the same row adds `--lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)` and, right after, captures `COUNTS_LINE=$(flow-pipeline-summary --status <status> --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)`, threaded into `flow-gate-summary --counts-line "$COUNTS_LINE" --untracked-file <(flow-untracked render --format gate --unfiled-only)`.

| `.decision` | Action |
|---|---|
| `auto-merge` | Run `flow-followups pr-body-upsert "$PR"` (no-op when log is empty; otherwise idempotent in-place upsert of `## Local Follow-ups` so the section survives the squash-merge), then run `flow-foreclosed-paths pr-body-upsert "$PR"` (idempotent; no-ops when there are no foreclosed paths). Continue to step 10 (auto-merge). |
| `gated` | Run `flow-followups pr-body-upsert "$PR"` (idempotent), then run `flow-foreclosed-paths pr-body-upsert "$PR"` (idempotent; no-ops when there are no foreclosed paths), then capture the deferred follow-ups block via `flow-followups run --note-only > "$WORKTREE/.flow-tmp/followups-block.txt"` (the renderer suppresses the FOLLOW-UPS slot when the file is empty). Set `SLUG="$FLOW_SLUG"`, in ONE `gh pr view` round-trip, capture the diff-size source AND the echo-recap fields (`gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName > "$WORKTREE/.flow-tmp/pr-view.json" && IFS=$'\t' read -r PR_URL PR_TITLE PR_BRANCH < <(jq -r '[.url, .title, .headRefName] \| @tsv' "$WORKTREE/.flow-tmp/pr-view.json") && jq '{additions,deletions,changedFiles,commits:(.commits\|length)}' "$WORKTREE/.flow-tmp/pr-view.json" > "$WORKTREE/.flow-tmp/pr-changes.json"`), then render the snapshot ABOVE the gate block via `flow-pipeline-summary --status gated --state-file ~/.flow/state/"$SLUG".json --pr-changes-file "$WORKTREE/.flow-tmp/pr-changes.json" --pr-review-result "$WORKTREE/.flow-tmp/pr-review-result.json" --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --consolidator-result "$WORKTREE/.flow-tmp/consolidator-result.json" --ci-wait-result "$WORKTREE/.flow-tmp/ci-wait-result.json" --followups-block-file "$WORKTREE/.flow-tmp/followups-block.txt" --filed-issues-file "$WORKTREE/.flow-tmp/filed-issues.txt" --intent-resolution "$WORKTREE/.flow-tmp/intent-resolution.json" --echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH" --lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)`, then capture `COUNTS_LINE=$(flow-pipeline-summary --status gated --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)` — then **extract the block between `<!-- flow-echo-recap:start -->` and `<!-- flow-echo-recap:end -->` from the helper output and echo it VERBATIM as markdown bullets in your assistant message (prose, not tool output)**; see the [Gate-stage echo-verbatim recap](shared-gate-contracts.md#gate-stage-echo-verbatim-recap---echo-prose) subsection. Then render the epic-membership block via `flow-epic-membership --slug "$SLUG" --terminal-state gated` (prints nothing for non-epic features). Run `flow-browser-teardown --reap --record` (registry-driven reap; records its outcome in state.json and always exits 0 — never blocked, never swallowed) as its own standalone step, then run `jq -r '.skips[]? \| select(.step \| startswith("screenshots_")) \| "Screenshots are local-only (not on the PR page): \(.reason)"' "$WORKTREE/.flow-tmp/review-finalize.json" 2>/dev/null` and print any line it emits verbatim in your assistant message (a `screenshots_*` skip in the review-finalize envelope is never silent; an old GitHub CLI's reason names `brew upgrade gh`), then author `TLDR="<one-sentence outcome + count of items needing you>"` and render the GATED block via `flow-gate-summary --status gated --pr-url "$PR_URL" --why "$REASON" --validation-items-file <(printf '%s\n' "$VALIDATION_ITEMS") --cleanup --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt" --tldr "$TLDR" --lens "$LENS" --untracked-file <(flow-untracked render --format gate --unfiled-only) --counts-line "$COUNTS_LINE"` — which records `phase: gated` itself, only after its block reaches stdout, so a render failure leaves state.json non-terminal and `flow-stop-guard` nudges retry. Call `flow-notify --status gated --url "$PR_URL" --reason "$TLDR"`. End. |
| `browser-retry` | **Non-terminal** (unlike `gated`): every open item is an un-run `Browser:` check (`.browserItems[].status` env-blocked, not-attempted or passed-unticked) or a `SUBJECTIVE:`/`DECISION:` item. FIRST, when `.autoRedriven` is false (the gate compares `$WORKTREE/.flow-tmp/browser-auto-redrive` to the local head): write the head into it (`git -C "$WORKTREE" rev-parse HEAD > "$WORKTREE/.flow-tmp/browser-auto-redrive"`, so a new commit re-arms the re-drive), record phase `reviewing` the way Step 8's head fence does (keeps the stop guard armed), run `/flow-pr-review "$PR" --resume-from 8c --browser-items "$(printf '%s' "$RESULT" \| jq -r '[.browserItems[].index] \| join(",")')"` with no human input, then re-run Step 9. ONLY when `.autoRedriven` is true (the automatic re-drive ran on this head; the gate returns `browser-retry` then only while an item is still `env-blocked`, any other leftover status is `gated`): render a pause per `references/pause-output-contract.md` — TLDR: how many browser checks did not run and why (from `.flow-tmp/ui-preflight.json`'s load and dependency snapshot — name its `rootCause`, the deepest dependency that is down); `**Unsolved:**` lists them plus any judgment items, noting those can be ticked while paused; nothing is lost; name any dependency with `startedByFlow: true` left running; `**Next action:**` type `retry`. Then `flow-notify --status needs-human --url "$PR_URL" --reason "$TLDR" --tag browser-retry-pending`, `flow-state-update --phase browser-retry-pending`, close this pipeline's own browser page, and end the turn — **no browser reap** (non-terminal; the browser stays up for the retry). An in-window `retry` at that phase runs the same re-drive (writing `reviewing` first), then Step 9. See `references/failure-recovery.md`. |
| `merged-externally` | Already merged externally. **Do not** run `gh pr merge`. Capture follow-ups output: `flow-followups run > "$WORKTREE/.flow-tmp/followups-block.txt"` (executes allowlisted+auto entries while the worktree is still alive; `>` captures the rendered block). Set `SLUG="$FLOW_SLUG"`, in ONE `gh pr view` round-trip guarded by `[ -n "$PR" ]`, capture the diff-size source AND the echo-recap fields (`[ -n "$PR" ] && gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName > "$WORKTREE/.flow-tmp/pr-view.json" && IFS=$'\t' read -r PR_URL PR_TITLE PR_BRANCH < <(jq -r '[.url, .title, .headRefName] \| @tsv' "$WORKTREE/.flow-tmp/pr-view.json") && jq '{additions,deletions,changedFiles,commits:(.commits\|length)}' "$WORKTREE/.flow-tmp/pr-view.json" > "$WORKTREE/.flow-tmp/pr-changes.json"`), then render the snapshot ABOVE the gate block via `flow-pipeline-summary --status merged --state-file ~/.flow/state/"$SLUG".json --pr-changes-file "$WORKTREE/.flow-tmp/pr-changes.json" --pr-review-result "$WORKTREE/.flow-tmp/pr-review-result.json" --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --consolidator-result "$WORKTREE/.flow-tmp/consolidator-result.json" --ci-wait-result "$WORKTREE/.flow-tmp/ci-wait-result.json" --followups-block-file "$WORKTREE/.flow-tmp/followups-block.txt" --filed-issues-file "$WORKTREE/.flow-tmp/filed-issues.txt" --intent-resolution "$WORKTREE/.flow-tmp/intent-resolution.json" --post-comment "$PR" --echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH" --lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)` (the helper yields `none` for absent artifacts, so a thin merged-externally snapshot is expected; `--post-comment` durably persists the snapshot as an idempotent PR comment and no-ops when `$PR` is empty), then capture `COUNTS_LINE=$(flow-pipeline-summary --status merged --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)` — then **extract the block between `<!-- flow-echo-recap:start -->` and `<!-- flow-echo-recap:end -->` from the helper output and echo it VERBATIM as markdown bullets in your assistant message (prose, not tool output)**; see the [Gate-stage echo-verbatim recap](shared-gate-contracts.md#gate-stage-echo-verbatim-recap---echo-prose) subsection. Then render the epic-membership block via `flow-epic-membership --slug "$SLUG" --terminal-state merged-externally` (no-op for non-epic features). Run `flow-browser-teardown --reap --record` (registry-driven reap; records its outcome in state.json and always exits 0 — never blocked, never swallowed) as its own standalone step, then author `TLDR="<one-sentence outcome>"` and render the MERGED block via `flow-gate-summary --status merged --pr-url "$PR_URL" --why "PR was merged externally; supervisor cleaned up worktree only" --cleanup --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt" --tldr "$TLDR" --lens "$LENS" --untracked-file <(flow-untracked render --format gate --unfiled-only) --counts-line "$COUNTS_LINE"` — which records `phase: merged` itself, only after its block reaches stdout, so a render failure leaves state.json non-terminal and `flow-stop-guard` nudges retry. Then, since arming first would be stale on arrival, best-effort checkpoint: `[ "$(flow-checkpoint --probe --site terminal \| jq -r '.verdict')" = write ] && echo "Pipeline reached MERGED (externally) at $(date -u +%Y-%m-%dT%H:%M:%SZ)." > "$(flow-checkpoint --path)"; flow-checkpoint --site terminal >/dev/null` (stdout muted, stderr deliberately left connected — echo the `checkpointed: ` line verbatim per the [Checkpoint arm signal (echo-verbatim)](shared-gate-contracts.md#checkpoint-arm-signal-echo-verbatim) subsection). Then `flow-remove-worktree --delete-branch`, call `flow-notify --status merged --url "$PR_URL" --reason "$TLDR"`. End. (The roadmap row was self-marked in the PR's diff by `/flow-pr-review` step 7.5; no post-merge sweep is needed.) |
| `closed-no-merge` | Author `TLDR="The PR was closed without merging; nothing was shipped."`. Call `flow-notify --status needs-human --url "$PR_URL" --reason "$TLDR" --tag pr-closed-without-merge`. Run `flow-browser-teardown --reap --record` (registry-driven reap; records its outcome in state.json and always exits 0 — never blocked, never swallowed) as its own standalone step, then render the NEEDS HUMAN block via `flow-gate-summary --status needs-human --reason pr-closed-without-merge --pr-url "$PR_URL" --why "PR closed without merge" --cleanup --tldr "$TLDR" --lens "$LENS"`. End. |
| `escalate-heading-missing` | Author `TLDR="The PR body is missing its Test Steps section, so I can't tell whether this is safe to auto-merge."`. Run `flow-browser-teardown --reap --record` (registry-driven reap; records its outcome in state.json and always exits 0 — never blocked, never swallowed) as its own standalone step, then render the NEEDS HUMAN block via `flow-gate-summary --status needs-human --reason test-steps-section-missing --pr-url "$PR_URL" --why "PR body has no ## Test Steps heading — gate cannot evaluate" --cleanup --tldr "$TLDR" --lens "$LENS"`. Call `flow-notify --status needs-human --url "$PR_URL" --reason "$TLDR" --tag test-steps-section-missing`. End. |
| `escalate-gh-error` | Author `TLDR="A GitHub API error stopped the gate check; nothing was merged."`. Run `flow-browser-teardown --reap --record` (registry-driven reap; records its outcome in state.json and always exits 0 — never blocked, never swallowed) as its own standalone step, then render the NEEDS HUMAN block via `flow-gate-summary --status needs-human --reason gh-error --pr-url "$PR_URL" --why "$(printf '%s' "$REASON" | tr '\n' ' ' | head -c 200)" --cleanup --tldr "$TLDR" --lens "$LENS"` (one-line, length-bounded from the `gh` stderr). Call `flow-notify --status needs-human --url "$PR_URL" --reason "$TLDR" --tag gh-error`. End. |

**Post-render QA prose.** Any prose the supervisor adds around these terminal renders — a follow-up answer, a post-merge QA reply — is formatted per `references/pause-output-contract.md` (labeled slots, no open prose, ≤12 lines; template: the answer lives as prose ABOVE the block per the contract's Q&A rule, then `### ✅ <terminal state> — question answered` / `**Next action:** <what remains>`), but NEVER as a second block over the helper render: the `flow-gate-summary` / `flow-pipeline-summary` output already satisfies the contract via its own `STATUS:`/`WHY:`/`NEXT ACTION:` grammar and is never duplicated or re-wrapped.
<!-- any new pause site below must reference pause-output-contract.md -->

**A `gated` verdict is terminal, not advisory.** When `flow-gate-decide`
returns `gated`, the supervisor renders the GATED block via
`flow-gate-summary` (which records `phase: gated` itself) and ends — full stop. The `gated` verdict is **not** an
input the supervisor may weigh against its own judgment. The supervisor
must **not** run `gh pr merge` on a `gated` PR on its own authority; must
**not** reclassify the PR's unchecked Test Steps items (in particular, it
must not relabel a functional check — a popover opens, a button works, a
page renders — as "subjective UX") to make the verdict come out
differently; and must **not** treat a "merge" / "ship it" instruction
given *before* the gate verdict was surfaced as authorisation to merge.
The gate exists precisely to stop a non-functional feature from shipping
while manual verification steps are still unchecked; overriding it on the
supervisor's own authority is the exact failure mode this rule
forecloses. The only two routes from `gated` to merged are (a) a human
merging the PR through GitHub themselves, or (b) the fresh-confirmation
gate-override path below. See `references/auto-merge-rubric.md` "A
`gated` verdict is terminal, not advisory" for the full contract.

### Gate auto-checkpoint sub-step

After rendering the GATED block (which records `phase: gated` itself), arm a
lightweight checkpoint so the user can `/clear` during manual validation
without typing `/flow-checkpoint` first — `gated` is the highest-value
context-clear point in the pipeline (it routinely sits through several
rounds of feedback while the supervisor carries a huge `/flow-pr-review`
context the next fix does not need). **Non-clobbering:** probe with
`flow-checkpoint --probe --site gate`; only on a `write` verdict write a
minimal one-line pointer (e.g. `gated on PR #<pr> — feedback-mode
checkpoint`) to the path `flow-checkpoint --path` prints — a still-fresh
manual note (`verdict: preserve`) wins, left untouched. Then arm:
`flow-checkpoint --site gate`.

This is a **near-zero-residue** arm — it flushes no approval state, only
the pointer that lets `SessionStart:clear` fire at `gated`. After the GATED
render, echo the arm's `checkpointed: ` stderr line verbatim as the last
line of the turn, per the [Checkpoint arm signal
(echo-verbatim)](shared-gate-contracts.md#checkpoint-arm-signal-echo-verbatim) subsection — the
pipeline auto-resumes into feedback mode (`flow-resume-decide` resolves
`gated` + a checkpoint marker → `gated-feedback`, see Resume mode). It
grants no new merge authority — the gated verdict stays terminal.

**Feedback-mode turn-ending replies.** While a `gated` PR sits through feedback rounds (including `gated-feedback` resume re-entries), every turn-ending reply — a fix confirmation, a re-verify report, a validation answer — is formatted per `references/pause-output-contract.md` — labeled slots, no open prose, ≤12 lines (template: `### ⏸ GATED — <what this round did>` / `**Unsolved:** <unchecked Test Steps, collapsed to a count line when all are minor>` / `**Needs attention:** <the SUBJECTIVE/gated item touched, with the PR URL>` / `**Untracked:** <unfiled items, `file #N` / `drop #N` to act on one>` / `**Next action:** tick the boxes and say merge, or report another issue`). Solved items from this round collapse into the one count line; they never get their own bullet. A "run the remaining tests" request at `gated` runs the `browser-retry` re-drive WITHOUT writing `reviewing` (`gated` → `reviewing` is not allowlisted; the gate's `gating` write is the exit): the stack comes up from the manifest `launch` plus each `dependsOn[].start`, login goes through `flow-ui-login` (never a `.env` check), and because GATED already reaped the browser, 8c.iii takes the headless fallback and the reply names `/mcp` → reconnect `chrome-devtools`.
<!-- any new pause site below must reference pause-output-contract.md -->

### Gate override (post-verdict, opt-in)

A `gated` run has ended, but the tmux window stays open. A *new*
instruction to merge the gated PR anyway is a mid-flight redirect,
classified per `references/redirect-handling.md` "Gate override" (full
procedure, the `case`-statement bash, and the canonical anti-pattern this
rule exists for live there). An override is authorised **only** when the
instruction is all three of **fresh** (sent after the GATED block was
surfaced), **unambiguous** (about merging this gated PR — bare
"merge"/"ship it"/"lgtm" qualify; the `AskUserQuestion` form fired next
is itself the conscious-confirmation step), and **in-context** (actually
about this gate verdict, not inferred from an earlier instruction given
for a different purpose). A stale or pre-verdict instruction never
qualifies. The "unambiguous" test fails only on inputs that are not
about merging at all (bare "cool", "thanks", "next").

**Re-query the live gate first.** Before firing or refusing the
override, always re-query the live verdict via `flow-gate-decide "$PR"`
— the user may have ticked `- [ ]` boxes themselves between the GATED
render and their instruction, clearing the gate. `auto-merge` ⇒ no
override needed, route straight to step 10 (`flow-merge-guard` there
re-confirms the cleared gate); `gated` ⇒ proceed to the confirmation
below; any other decision ⇒ route per step 9's main decision table.

When the three tests pass, fire exactly one `AskUserQuestion`
confirmation naming the PR and the unchecked-step count (the named
exemption in "Hard rules"); on an affirmative answer, run
`flow-merge-guard "$PR" --record-override` as its own standalone Bash
call (pre-approved in flow-launched sessions, so the confirmation is the
only prompt) and re-enter step 10 — the backstop there reads the token
and lets the merge through. A `pr-not-owned` or `not-gated` refusal
records nothing: re-render the GATED block and end. On any
non-affirmative answer, or when the instruction fails the "fresh" or
"in-context" test, do **not** fire the confirmation and do **not**
record a token — re-render the GATED block via `flow-gate-summary
--status gated ...`, restate that the verdict is terminal, and end. The
PR stays `gated`. Step 10's `merging` write out of `gated` is the third
allowlisted exit, and the allowlist grants no merge authority — the
override still requires this fresh `AskUserQuestion` confirmation and
`flow-merge-guard --record-override`.
