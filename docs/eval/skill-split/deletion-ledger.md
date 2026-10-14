# Skill-split deletion ledger

Every pre-split line of `skills/pipeline/flow-pipeline/SKILL.md` (at `6acd8ee`, the post-merge base; the original split point was `8e5c823`, and main's #941 changed 3 of its lines in the merge at `d4a0fa1`) that is not present byte-for-byte in the corpus after the split. `bun docs/eval/skill-split-fidelity.ts --before 6acd8ee` reads the fenced blocks below: the lines above each `owner:` line are the original text, and `owner:` names the test or helper that owns the fact (or the reason the line changed).

## Relative links re-pathed for the deeper doc location

Text moved verbatim except that a relative markdown link target was re-pathed so it still resolves from the new directory. The link text is unchanged and the target file is unchanged.

```
Full gate/brief/run contract: [references/blind-survey.md](references/blind-survey.md).
[references/step3-threading.md](references/step3-threading.md); none add a
  ([references/model-routing.md](references/model-routing.md)).
  [references/step3-threading.md](references/step3-threading.md)).
  the survey ran (full contract: [references/blind-survey.md](references/blind-survey.md)).
[references/step3-threading.md](references/step3-threading.md#deterministic-forced-research-mandatory-on-the-forced-path).
in [references/exemption-contracts.md](../../../references/exemption-contracts.md); the discovery method in
the TLDR per [TLDR and WHY authoring (product brief)](#tldr-and-why-authoring-product-brief).
[references/step3-threading.md](references/step3-threading.md#deterministic-note-backstop-mandatory-non-skippable).
[references/step3-threading.md](references/step3-threading.md#follow-up-reference-consistency-backstop-advisory-deterministic).
[references/step3-threading.md](references/step3-threading.md#auto-bundle-revision-pass-bounded-once-per-pipeline).
[references/step3-threading.md](references/step3-threading.md#plan-shape-backstop-advisory-deterministic).
[references/step3-threading.md](references/step3-threading.md#design-spec-validation-backstop-deterministic-advisory).
[references/step3-threading.md](references/step3-threading.md#blind-product-critic-brief-gated-once-per-pipeline).
[references/step3-threading.md](references/step3-threading.md#cross-model-plan-review-layer-2--re-fire-hashing-detail).
[references/blind-survey.md](references/blind-survey.md).
  [references/blind-survey.md](references/blind-survey.md) "The method pause".
  # Author the TLDR per [TLDR and WHY authoring (product brief)](#tldr-and-why-authoring-product-brief).
  recap](#gate-stage-echo-verbatim-recap---echo-prose). At AWAITING
  `flow-checkpoint --site plan-review` to arm the marker and record the freshness receipt, then echo its `checkpointed: ` stderr line verbatim as the last line of the turn, per the [Checkpoint arm signal (echo-verbatim)](#checkpoint-arm-signal-echo-verbatim) subsection.
    # Author the TLDR per [TLDR and WHY authoring (product brief)](#tldr-and-why-authoring-product-brief).
    recap](#gate-stage-echo-verbatim-recap---echo-prose).
owner: link target re-pathed for references/phases/step-03-plan.md (moved text; target file unchanged)
```

```
   (echo-verbatim)](#checkpoint-arm-signal-echo-verbatim) subsection — the
owner: link target re-pathed for references/phases/step-04-approval.md (moved text; target file unchanged)
```

```
On non-zero exit without a PR: never bypass hooks with `--no-verify`; run `flow-open-pr` and every push with Bash `timeout: 600000`. A push refused by a local hook (flow-open-pr's hook-refusal line, or any failed push with no `[rejected]` line) re-enters step 6 with that output as the failure excerpt; once step 6 ends clean, re-run `flow-open-pr` (Bash `timeout: 600000`) before advancing to step 7, because `$PR` is set only after it succeeds — per [references/git-workflow.md](../../../references/git-workflow.md) `### Pipeline pushes run the consumer's hooks`.
owner: link target re-pathed for references/phases/step-05-implement.md (moved text; target file unchanged)
```

```
not-exercised `> [!NOTE]` per [references/skill-overlay.md](references/skill-overlay.md).
owner: link target re-pathed for references/phases/step-05.5-install-skills.md (moved text; target file unchanged)
```

```
[references/ui-smoke-pass.md](references/ui-smoke-pass.md), and reports the
owner: link target re-pathed for references/phases/step-06-verify.md (moved text; target file unchanged)
```

```
[references/polling-protocol.md](references/polling-protocol.md#copilot-module-precheck).
Branch on `.decision`. Resolve the render lens once for the whole table: `LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)`. At every terminal `flow-gate-summary` render below (status: merged, gated, needs-human, or cancelled), first author `TLDR="<one sentence, ≤25 words, the user-visible outcome>"` (per [TLDR and WHY authoring (product brief)](#tldr-and-why-authoring-product-brief)) and pass `--tldr "$TLDR"`; a `flow-notify` call in the same row passes `--reason "$TLDR"` (needs-human also passes `--tag <reason-tag>`); a `flow-pipeline-summary` call in the same row adds `--lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)` and, right after, captures `COUNTS_LINE=$(flow-pipeline-summary --status <status> --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)`, threaded into `flow-gate-summary --counts-line "$COUNTS_LINE" --untracked-file <(flow-untracked render --format gate --unfiled-only)`.
| `merged-externally` | PR was merged externally mid-flight. Capture follow-ups output to a file: `flow-followups run > "$WORKTREE/.flow-tmp/followups-block.txt"` (still executes auto-allowlisted entries; `>` captures the rendered block). Set `SLUG="$FLOW_SLUG"`, in ONE `gh pr view` round-trip guarded by `[ -n "$PR" ]`, capture the diff-size source AND the echo-recap fields (`[ -n "$PR" ] && gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName > "$WORKTREE/.flow-tmp/pr-view.json" && IFS=$'\t' read -r PR_URL PR_TITLE PR_BRANCH < <(jq -r '[.url, .title, .headRefName] \| @tsv' "$WORKTREE/.flow-tmp/pr-view.json") && jq '{additions,deletions,changedFiles,commits:(.commits\|length)}' "$WORKTREE/.flow-tmp/pr-view.json" > "$WORKTREE/.flow-tmp/pr-changes.json"`), then render the snapshot ABOVE the gate block via `flow-pipeline-summary --status merged --state-file ~/.flow/state/"$SLUG".json --pr-changes-file "$WORKTREE/.flow-tmp/pr-changes.json" --pr-review-result "$WORKTREE/.flow-tmp/pr-review-result.json" --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --consolidator-result "$WORKTREE/.flow-tmp/consolidator-result.json" --ci-wait-result "$WORKTREE/.flow-tmp/ci-wait-result.json" --followups-block-file "$WORKTREE/.flow-tmp/followups-block.txt" --filed-issues-file "$WORKTREE/.flow-tmp/filed-issues.txt" --intent-resolution "$WORKTREE/.flow-tmp/intent-resolution.json" --post-comment "$PR" --echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH" --lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)` (`--post-comment` durably persists the snapshot as an idempotent PR comment on the MERGED path; it no-ops when `$PR` is empty), then capture `COUNTS_LINE=$(flow-pipeline-summary --status merged --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)` — then **extract the block between `<!-- flow-echo-recap:start -->` and `<!-- flow-echo-recap:end -->` from the helper output and echo it VERBATIM as markdown bullets in your assistant message (prose, not tool output)**; see the [Gate-stage echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose) subsection. Then render the epic-membership block via `flow-epic-membership --slug "$SLUG" --terminal-state merged-externally` (no-op for non-epic features). Run `flow-browser-teardown --reap --record` (registry-driven reap; records its outcome in state.json and always exits 0 — never blocked, never swallowed) as its own standalone step, then author `TLDR="<one-sentence outcome>"` and render the MERGED block via `flow-gate-summary --status merged --pr-url "$PR_URL" --why "PR was merged externally mid-flight; supervisor cleaned up the worktree" --cleanup --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt" --tldr "$TLDR" --lens "$LENS" --untracked-file <(flow-untracked render --format gate --unfiled-only) --counts-line "$COUNTS_LINE"` — which records `phase: merged` itself, only after its block reaches stdout, so a render failure leaves state.json non-terminal and `flow-stop-guard` nudges retry (the helper silently suppresses the FOLLOW-UPS slot when the file is empty; its final stdout line is the byte-exact sentinel `MERGED`). Then, since arming first would be stale on arrival, best-effort checkpoint: `[ "$(flow-checkpoint --probe --site terminal \| jq -r '.verdict')" = write ] && echo "Pipeline reached MERGED (externally) at $(date -u +%Y-%m-%dT%H:%M:%SZ)." > "$(flow-checkpoint --path)"; flow-checkpoint --site terminal >/dev/null` (stdout muted, stderr deliberately left connected — echo the `checkpointed: ` line verbatim per the [Checkpoint arm signal (echo-verbatim)](#checkpoint-arm-signal-echo-verbatim) subsection). Then `flow-remove-worktree --delete-branch`, call `flow-notify --status merged --url "$PR_URL" --reason "$TLDR"`. End. The roadmap row was self-marked in the PR's diff by `/flow-pr-review` step 7.5; no post-merge sweep required. |
owner: link target re-pathed for references/phases/step-07-ci-wait.md (moved text; target file unchanged)
```

```
[references/exemption-contracts.md](../../../references/exemption-contracts.md).
owner: link target re-pathed for references/phases/step-08-review.md (moved text; target file unchanged)
```

```
Branch on `.decision`. Resolve the render lens once for the whole table: `LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)`. At every terminal `flow-gate-summary` render below (status: merged, gated, needs-human, or cancelled), first author `TLDR="<one sentence, ≤25 words, the user-visible outcome>"` (per [TLDR and WHY authoring (product brief)](#tldr-and-why-authoring-product-brief)) and pass `--tldr "$TLDR"`; a `flow-notify` call in the same row passes `--reason "$TLDR"` (needs-human also passes `--tag <reason-tag>`); a `flow-pipeline-summary` call in the same row adds `--lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)` and, right after, captures `COUNTS_LINE=$(flow-pipeline-summary --status <status> --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)`, threaded into `flow-gate-summary --counts-line "$COUNTS_LINE" --untracked-file <(flow-untracked render --format gate --unfiled-only)`.
| `gated` | Run `flow-followups pr-body-upsert "$PR"` (idempotent), then run `flow-foreclosed-paths pr-body-upsert "$PR"` (idempotent; no-ops when there are no foreclosed paths), then capture the deferred follow-ups block via `flow-followups run --note-only > "$WORKTREE/.flow-tmp/followups-block.txt"` (the renderer suppresses the FOLLOW-UPS slot when the file is empty). Set `SLUG="$FLOW_SLUG"`, in ONE `gh pr view` round-trip, capture the diff-size source AND the echo-recap fields (`gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName > "$WORKTREE/.flow-tmp/pr-view.json" && IFS=$'\t' read -r PR_URL PR_TITLE PR_BRANCH < <(jq -r '[.url, .title, .headRefName] \| @tsv' "$WORKTREE/.flow-tmp/pr-view.json") && jq '{additions,deletions,changedFiles,commits:(.commits\|length)}' "$WORKTREE/.flow-tmp/pr-view.json" > "$WORKTREE/.flow-tmp/pr-changes.json"`), then render the snapshot ABOVE the gate block via `flow-pipeline-summary --status gated --state-file ~/.flow/state/"$SLUG".json --pr-changes-file "$WORKTREE/.flow-tmp/pr-changes.json" --pr-review-result "$WORKTREE/.flow-tmp/pr-review-result.json" --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --consolidator-result "$WORKTREE/.flow-tmp/consolidator-result.json" --ci-wait-result "$WORKTREE/.flow-tmp/ci-wait-result.json" --followups-block-file "$WORKTREE/.flow-tmp/followups-block.txt" --filed-issues-file "$WORKTREE/.flow-tmp/filed-issues.txt" --intent-resolution "$WORKTREE/.flow-tmp/intent-resolution.json" --echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH" --lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)`, then capture `COUNTS_LINE=$(flow-pipeline-summary --status gated --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)` — then **extract the block between `<!-- flow-echo-recap:start -->` and `<!-- flow-echo-recap:end -->` from the helper output and echo it VERBATIM as markdown bullets in your assistant message (prose, not tool output)**; see the [Gate-stage echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose) subsection. Then render the epic-membership block via `flow-epic-membership --slug "$SLUG" --terminal-state gated` (prints nothing for non-epic features). Run `flow-browser-teardown --reap --record` (registry-driven reap; records its outcome in state.json and always exits 0 — never blocked, never swallowed) as its own standalone step, then run `jq -r '.skips[]? \| select(.step \| startswith("screenshots_")) \| "Screenshots are local-only (not on the PR page): \(.reason)"' "$WORKTREE/.flow-tmp/review-finalize.json" 2>/dev/null` and print any line it emits verbatim in your assistant message (a `screenshots_*` skip in the review-finalize envelope is never silent; an old GitHub CLI's reason names `brew upgrade gh`), then author `TLDR="<one-sentence outcome + count of items needing you>"` and render the GATED block via `flow-gate-summary --status gated --pr-url "$PR_URL" --why "$REASON" --validation-items-file <(printf '%s\n' "$VALIDATION_ITEMS") --cleanup --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt" --tldr "$TLDR" --lens "$LENS" --untracked-file <(flow-untracked render --format gate --unfiled-only) --counts-line "$COUNTS_LINE"` — which records `phase: gated` itself, only after its block reaches stdout, so a render failure leaves state.json non-terminal and `flow-stop-guard` nudges retry. Call `flow-notify --status gated --url "$PR_URL" --reason "$TLDR"`. End. |
| `merged-externally` | Already merged externally. **Do not** run `gh pr merge`. Capture follow-ups output: `flow-followups run > "$WORKTREE/.flow-tmp/followups-block.txt"` (executes allowlisted+auto entries while the worktree is still alive; `>` captures the rendered block). Set `SLUG="$FLOW_SLUG"`, in ONE `gh pr view` round-trip guarded by `[ -n "$PR" ]`, capture the diff-size source AND the echo-recap fields (`[ -n "$PR" ] && gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName > "$WORKTREE/.flow-tmp/pr-view.json" && IFS=$'\t' read -r PR_URL PR_TITLE PR_BRANCH < <(jq -r '[.url, .title, .headRefName] \| @tsv' "$WORKTREE/.flow-tmp/pr-view.json") && jq '{additions,deletions,changedFiles,commits:(.commits\|length)}' "$WORKTREE/.flow-tmp/pr-view.json" > "$WORKTREE/.flow-tmp/pr-changes.json"`), then render the snapshot ABOVE the gate block via `flow-pipeline-summary --status merged --state-file ~/.flow/state/"$SLUG".json --pr-changes-file "$WORKTREE/.flow-tmp/pr-changes.json" --pr-review-result "$WORKTREE/.flow-tmp/pr-review-result.json" --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --consolidator-result "$WORKTREE/.flow-tmp/consolidator-result.json" --ci-wait-result "$WORKTREE/.flow-tmp/ci-wait-result.json" --followups-block-file "$WORKTREE/.flow-tmp/followups-block.txt" --filed-issues-file "$WORKTREE/.flow-tmp/filed-issues.txt" --intent-resolution "$WORKTREE/.flow-tmp/intent-resolution.json" --post-comment "$PR" --echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH" --lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)` (the helper yields `none` for absent artifacts, so a thin merged-externally snapshot is expected; `--post-comment` durably persists the snapshot as an idempotent PR comment and no-ops when `$PR` is empty), then capture `COUNTS_LINE=$(flow-pipeline-summary --status merged --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)` — then **extract the block between `<!-- flow-echo-recap:start -->` and `<!-- flow-echo-recap:end -->` from the helper output and echo it VERBATIM as markdown bullets in your assistant message (prose, not tool output)**; see the [Gate-stage echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose) subsection. Then render the epic-membership block via `flow-epic-membership --slug "$SLUG" --terminal-state merged-externally` (no-op for non-epic features). Run `flow-browser-teardown --reap --record` (registry-driven reap; records its outcome in state.json and always exits 0 — never blocked, never swallowed) as its own standalone step, then author `TLDR="<one-sentence outcome>"` and render the MERGED block via `flow-gate-summary --status merged --pr-url "$PR_URL" --why "PR was merged externally; supervisor cleaned up worktree only" --cleanup --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt" --tldr "$TLDR" --lens "$LENS" --untracked-file <(flow-untracked render --format gate --unfiled-only) --counts-line "$COUNTS_LINE"` — which records `phase: merged` itself, only after its block reaches stdout, so a render failure leaves state.json non-terminal and `flow-stop-guard` nudges retry. Then, since arming first would be stale on arrival, best-effort checkpoint: `[ "$(flow-checkpoint --probe --site terminal \| jq -r '.verdict')" = write ] && echo "Pipeline reached MERGED (externally) at $(date -u +%Y-%m-%dT%H:%M:%SZ)." > "$(flow-checkpoint --path)"; flow-checkpoint --site terminal >/dev/null` (stdout muted, stderr deliberately left connected — echo the `checkpointed: ` line verbatim per the [Checkpoint arm signal (echo-verbatim)](#checkpoint-arm-signal-echo-verbatim) subsection). Then `flow-remove-worktree --delete-branch`, call `flow-notify --status merged --url "$PR_URL" --reason "$TLDR"`. End. (The roadmap row was self-marked in the PR's diff by `/flow-pr-review` step 7.5; no post-merge sweep is needed.) |
(echo-verbatim)](#checkpoint-arm-signal-echo-verbatim) subsection — the
owner: link target re-pathed for references/phases/step-09-gate.md (moved text; target file unchanged)
```

```
and lost; see [references/git-workflow.md](../../../references/git-workflow.md))
`Bash(flow-merge-guard merge *)` ([docs/configuration.md](../../../docs/configuration.md),
**Load the Task tool before spawning** — i.e. before the Task call below. See [../flow-pr-review/references/task-tool-exemption-preamble.md](../flow-pr-review/references/task-tool-exemption-preamble.md) for the full rationale. On missing schema: escalate `NEEDS HUMAN: task-tool-unavailable: flow-pipeline-merge-resolver` and exit (do not fall back to in-line execution).
See [references/merge-resolver-spawn-prompt.md](references/merge-resolver-spawn-prompt.md) for the verbatim spawn-prompt template (nine `{{...}}` placeholders). Fill the placeholders from the resolve-inputs block above before passing it to the Task tool.
session model — see [references/model-routing.md](references/model-routing.md)),
   (see [references/exemption-contracts.md](../../../references/exemption-contracts.md)
owner: link target re-pathed for references/phases/step-10-merge.md (moved text; target file unchanged)
```

```
TLDR="<one sentence, <=25 words, the user-visible outcome>"  # authored here, not derived; per [TLDR and WHY authoring (product brief)](#tldr-and-why-authoring-product-brief)
recap](#gate-stage-echo-verbatim-recap---echo-prose). **Discharging the
owner: link target re-pathed for references/phases/step-11-follow-ups.md (moved text; target file unchanged)
```

```
| `step-9` | Re-enter step 9 (gate). Two sub-cases distinguished by `.reason`: `pr-merged-worktree-still-exists` (run step 11's MERGED branch — which re-runs `flow-pipeline-summary ... --echo-prose ...` and re-echoes the recap verbatim per the [Gate-stage echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose) subsection — then render the MERGED block via `flow-gate-summary --status merged ...` (same `--tldr`/`--lens` augmentation as step 11's MERGED block; records `phase: merged` itself, only after its block reaches stdout) then, since arming first would be stale on arrival, best-effort checkpoint: `[ "$(flow-checkpoint --probe --site terminal \| jq -r '.verdict')" = write ] && echo "Pipeline reached MERGED at $(date -u +%Y-%m-%dT%H:%M:%SZ)." > "$(flow-checkpoint --path)"; flow-checkpoint --site terminal >/dev/null` (stdout muted, stderr deliberately left connected — echo the `checkpointed: ` line verbatim per the [Checkpoint arm signal (echo-verbatim)](#checkpoint-arm-signal-echo-verbatim) subsection) and run `flow-remove-worktree --delete-branch`, end; **do not** fall through to step 10's merge on an already-merged PR) vs. `at-auto-merge-gate` (re-evaluate the gate via `flow-gate-decide`). |
| `terminal` | Already in a terminal state. Re-run the corresponding gate render (the same helpers every gate-emission site uses) and end without re-running anything else. On `merged`/`gated` the render re-runs `flow-pipeline-summary ... --echo-prose ...` above `flow-gate-summary --status <merged\|gated> ...`, so the echo recap re-surfaces on resume re-entry — extract the `<!-- flow-echo-recap:start -->`…`<!-- flow-echo-recap:end -->` block and echo it VERBATIM per the [Gate-stage echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose) subsection (re-orientation is exactly the resume use case). `cancelled` has no PR, so `--echo-prose` is a no-op there. `needs-human` re-renders the escalation via `flow-gate-summary --status needs-human ...` (same `--tldr`/`--lens` augmentation as its originating render) ONLY when the worktree is gone; a `needs-human` pipeline with a live worktree resolves `awaiting-human` above instead, never this row. The two no-in-flight-work pending phases short-circuit here pre-tree (reasons `no-change-investigation-complete` for `triaged-no-change`, `awaiting-triage-clarification` for `triage-pending-clarification`): they carry no PR/worktree and have no gate-summary status, so print a one-line note that the pipeline already completed (a no-change investigation, or one awaiting a clarification a resume can't re-ask) and end — do NOT build a worktree. On the `triaged-no-change` path, when `$ANSWER` is non-empty, re-print the saved `$ANSWER` (as markdown) so the user re-reads the original answer instead of the generic terminal note; fall back to the generic note when `$ANSWER` is empty. The re-rendered UNTRACKED row still accepts `file #N` / `drop #N` (`flow-untracked file|drop <N>`) on the very next reply — the resume terminal row is not read-only. |
owner: link target re-pathed for references/phases/resume.md (moved text; target file unchanged)
```

```
- **chrome-devtools MCP pages/contexts** — the per-pipeline isolated page each browser pass opens is closed with `close_page` on completion and on every error/early-exit path, scoped to the page/context this pipeline opened. Contract in [references/ui-smoke-pass.md](references/ui-smoke-pass.md) "Teardown" and `/flow-pr-review`'s `references/ui-validation-evidence.md` "Teardown".
- **Agent-written env/config files** — any env/config file a browser/UI pass created is deleted on completion and on every error/early-exit path (see "Teardown" in [references/ui-smoke-pass.md](references/ui-smoke-pass.md)).
owner: link target re-pathed for references/phases/resource-cleanup.md (moved text; target file unchanged)
```

```
TLDR="<one sentence, <=25 words, the user-visible outcome for <reason>>"  # authored here, not derived; per [TLDR and WHY authoring (product brief)](#tldr-and-why-authoring-product-brief)
recap](#gate-stage-echo-verbatim-recap---echo-prose). PRE-review escalations
owner: link target re-pathed for references/phases/failure-paths.md (moved text; target file unchanged)
```

```
  (echo-verbatim)](#checkpoint-arm-signal-echo-verbatim) subsection), end.
owner: link target re-pathed for references/phases/mid-flight-redirects.md (moved text; target file unchanged)
```

```
> spawned together ([references/exemption-contracts.md](../../../references/exemption-contracts.md)).
> [references/exemption-contracts.md](../../../references/exemption-contracts.md).
> contract in [references/exemption-contracts.md](../../../references/exemption-contracts.md).
> full contract in [references/exemption-contracts.md](../../../references/exemption-contracts.md).
> [references/exemption-contracts.md](../../../references/exemption-contracts.md) and
> [references/exemption-contracts.md](../../../references/exemption-contracts.md) and `skills/pipeline/flow-coder/SKILL.md`.
> `.flow-tmp/consolidator-result.json`; full contract in [references/exemption-contracts.md](../../../references/exemption-contracts.md).
> [references/exemption-contracts.md](../../../references/exemption-contracts.md).
owner: link target re-pathed for references/hard-rules-detail.md (moved text; target file unchanged)
```

## Core pointers re-aimed at the doc that now holds the section

Two prose pointers in the core said "below" / "above" for sections that now live in step docs. Only the pointer was reworded; the surrounding sentence is unchanged.

```
`references/failure-recovery.md` section (b). See **Resume mode**
below.
PR not yet merged):`) block written by step 11 — see the step 11 contract
above for when it appears. The `cancelled` line is never preceded by a
owner: deliberate pointer fix in skills/pipeline/flow-pipeline/SKILL.md (now names references/phases/resume.md and references/phases/step-11-follow-ups.md)
```

```
**Durable PR-comment persistence (MERGED-only, `--post-comment`).** The scrollback render is transient — close the tmux window or overflow the buffer and the snapshot is gone. On the MERGED terminal state, the three MERGED call sites (the step-11 block and both `merged-externally` renders) additionally pass `--post-comment "$PR"`, which posts the rendered `## PIPELINE SNAPSHOT` as a **top-level PR issue-comment** (not a review), so a merged PR carries its own pipeline provenance. The write is **idempotent**: the comment body is the rendered block plus a single-line HTML-comment marker (`<!-- flow-pipeline-snapshot-v1 -->`); the helper lists the PR's issue-comments, edits the marked one in place if present, and only creates a new one otherwise — a resume / watch-driven re-render replaces rather than duplicates. The marker lives ONLY in the posted comment body, never in stdout, so the scrollback render and the `flow-stop-guard`/auto-merge invariants are byte-for-byte unchanged. Persistence is **MERGED-only** (enforced inside the helper — `--post-comment` is ignored on `gated`/`needs-human` even if supplied), because a gated PR keeps churning and a snapshot comment would go stale while a merged PR is frozen. The write is **best-effort, never escalated** — a `gh` failure (or an empty `$PR`) is reported to stderr and never changes the exit code, the scrollback render, or the terminal verdict; this mirrors the "Failed auto-runs are reported, not escalated" rule below (a peripheral comment-post failure must not un-merge a PR).
owner: deliberate pointer fix in references/phases/shared-gate-contracts.md (the "Failed auto-runs" rule it cites now lives in references/phases/step-11-follow-ups.md)
```

## Deleted: Stop-hook internals

Prose describing what `flow-stop-guard` does internally (what it reads, exit codes, loop-break budget, stagnation, background-task allowance). The supervisor cannot act on it; the imperative (the hook blocks a mid-pipeline turn end; pause only via a pending phase or the pause renderer) and the tokens `flow install`, `--no-hooks`, `stop_hook_active` and `flow-stop-guard` stay in SKILL.md `# Harness-level enforcement (Stop hook)`.

```
`flow-stop-guard` is a Claude Code Stop hook installed by
`flow install` into `~/.claude/settings.json`. It is the structural
defence behind the "never end the turn between sub-skills" Hard
rule above — text-only reminders in this SKILL.md cannot intercept
a model that has already chosen to stop, but a Stop hook fires
*at* the model's turn-end signal.
Contract:
- Reads `~/.flow/state/<slug>.json` (slug resolved from the
  `FLOW_SLUG` env var — set in the launch env by both launcher
  backends).
- Exits 2 with a stderr `DO NOT END THE TURN` reminder when phase
  is non-terminal-non-pending — the supervisor is mid-pipeline and
  must continue.
- Exits 0 (allows the stop) when phase is in the legitimate-end
  set: any of the four terminals (`merged`, `gated`, `needs-human`,
  `cancelled`) or the pending-end phases (`PENDING_PHASES` in
  `bin/lib/state.ts`: `plan-pending-review`, `triaged-no-change`,
  `triage-pending-clarification`, `approval-pending-clarification`,
  `ci-wait-pending`, `browser-retry-pending`, `checkpoint-pending-clear`,
  and the interview/review-wait phases).
- Self-detects: exits 0 (no-op) when no flow slug resolves (no
  `FLOW_SLUG`), or when state.json is
  missing. Safe to install in a global Stop hook list.
- Loop-break budget: a per-turn block counter persisted at
  `~/.flow/state/turns/<slug>.json` (a sibling subdirectory so `flow ls`
  ignores it). Legitimate pending exits do NOT consume it.
- `stop_hook_active` is treated as advisory (turn-boundary detection via
  `false`-on-first-stop), not an authoritative budget.
- Stagnation detection: once the budget is exhausted (blockCount ≥
  TURN_BLOCK_LIMIT), subsequent stops exit 0 only when phase has advanced
  since the last block; otherwise it re-engages and exits 2. The loop-break
  exit writes a stderr breadcrumb Claude Code surfaces the next turn-start.
- Bounded: on the 4th consecutive same-phase stop the guard records
  `phase: needs-human` itself (outcome `stalled at <phase> after <n>
  blocked stops — reply merge #<pr>` at `gating`/`merging`, else `reply
  continue`) and exits 0 — a hook write no permission check can refuse.
  A stop made while any background task is in flight (agent, monitor,
  workflow, or a backgrounded shell such as the CI waiter) is allowed
  uncounted, capped at 30 consecutive such stops per phase. Its reminders
  name phase values (`merged`, `gated`, `needs-human`) and the pause
  renderer (`flow-gate-summary` with `--reason <tag>`) — a phase value is
Opt out: `flow install --no-hooks` skips the merge entirely and
leaves `~/.claude/settings.json` untouched. The supervisor's
contract still holds — the hook is the mechanical guardrail, not
the contract itself.
owner: bin/flow-stop-guard.test.ts
```

## Deleted: notifier internals

Prose describing the notifier's backends, darwin-only behaviour and fire-and-forget semantics. The call fence, the `FLOW_NOTIFY=1` no-op rule and the `every slug-taking flow helper (...)` sentence (parsed by `bin/slug-flag-contract-lint.test.ts`) stay in SKILL.md `# Notifications`.

```
When the pipeline reaches a terminal end-state (`MERGED`, `GATED`,
or `NEEDS HUMAN`), call `flow-notify` immediately *before* printing
the end-state line. The helper is opt-in (`FLOW_NOTIFY=1` in the
environment that started the supervisor's tmux session) and a no-op
otherwise — so calling it unconditionally is safe; the user
controls firing via the env var, not the skill prompt.
- darwin-only; non-mac hosts and unset `FLOW_NOTIFY` both no-op.
- Backend: `terminal-notifier` preferred (click-through to
  `--url`), `osascript display notification` fallback.
- Detached + fire-and-forget. The helper exits 0 even if the
  notifier fails — it must never break the supervisor's terminal
  print.
- `cancelled` is **not** a notify status. Cancellation is
  user-initiated; they already know.
The exact call sites are listed inline at steps 9, 10, and at every
escalation site documented under `# Failure paths`.
owner: bin/flow-notify.test.ts
```

## Deleted: phase-value quick reference

The happy-path and pending phase lists. The phase set is owned by `STEP_PHASES`, `PENDING_PHASES` and `PIPELINE_PHASES` in `bin/lib/state.ts`; the step-to-phase map is SKILL.md's `## Phase dispatch` table, which names `PIPELINE_PHASES`.

```
# Quick reference: phase values
In write-order on the happy path:
triaging
worktree-create
planning
plan-pending-review     (feature only; ends turn — pending phase)
checkpoint-pending-clear (feature only; ends turn — pending phase; step 4 auto-checkpoint before implement)
implementing
installing-skills       (only if worktree adds skills/agents; otherwise skipped)
verifying
ci-wait
reviewing
gating
merging
merged                  (terminal)
Off-path terminals: `gated`, `needs-human`, `cancelled`.
Pending phases (legitimate turn-ends mid-pipeline; recognised by
`flow-stop-guard`):
plan-pending-review                (step 3 → 4 handoff for feature intent)
triaged-no-change                  (step 1 no-change branch)
triage-pending-clarification       (step 1 single clarifying question)
triage-pending-interview           (step 1 intent interview (adaptive) round)
approval-pending-clarification     (step 4 single clarifying question)
plan-pending-interview             (step 3 post-discovery question-gate round)
ci-wait-pending                    (step 7 yield while flow-ci-wait is backgrounded)
browser-retry-pending              (step 9 pause: open browser checks still env-blocked after the automatic re-drive)
checkpoint-pending-clear           (step 4 auto-checkpoint at the approval → implement hand-off)
The canonical phase set is exported from `bin/lib/state.ts` as
`PIPELINE_PHASES`; `flow-state-update --phase` rejects values
outside that set so a typo can't silently land in state.json and
defeat the Stop hook.
owner: bin/lib/state.ts (phase arrays), pinned by bin/lib/state.test.ts
```
