## Step 7 — CI + Copilot wait

Contents: Copilot-module precheck · Copilot request decision · Anchors, not an in-process clock · Fix-loop cap: 3 total ci-fix loops · End condition

**Phase:** `ci-wait`

Write the phase BEFORE the module precheck and the `flow-ci-check`
call below, so the phase names the step the run is actually inside:

```bash
flow-state-update --phase ci-wait
```

`flow-ci-check` still emits `ci-wait` at this step's tail as an
idempotent backstop — by then `advancePhase` returns
`already-at-or-past`, so the backstop adds no duplicate `phaseLog[]` row.
When the pipeline has a private skill copy, re-run step 5.5's `flow-skill-overlay sync` here (idempotent) so fix-loop skill edits reach a resume or reload, then MERGE its `.written` into the existing PR-body not-exercised NOTE (never replace it).

**Copilot-module precheck (before any of this).** Probe
`flow-module-status --check copilot >/dev/null 2>&1` — non-zero means the
`copilot` module is deselected (`flow-request-copilot` never on PATH): skip
the request/classify subsection below (PR treated as declined), note the
skip quietly, and invoke `flow-ci-check` below with `--copilot-not-requested`
(its self-guard prints the one user-facing notice — hence the discarded
stderr). Full rationale in
[references/polling-protocol.md](../polling-protocol.md#copilot-module-precheck).

**Copilot request decision (before the wait).** Copilot review is opt-in
for non-trivial changes only; decide *before* invoking `flow-ci-check`, so a
declined PR can collapse the bot wait. The decision combines the
per-pipeline `copilotReview` override (from state.json) with
`flow-request-copilot`'s deterministic glob classifier:

```bash
OVERRIDE=$(jq -r '.copilotReview // "auto"' ~/.flow/state/"$SLUG".json)
GLOB_CLASS=$(gh pr diff "$PR" --name-only | flow-request-copilot --classify)
```

Branch on `$GLOB_CLASS`:

- `always-review` / `never-alone` — the classifier is decisive; the
  supervisor does **NOT** judge. (`always-review` → request;
  `never-alone` → decline, unless `$OVERRIDE` is `always`.)
- `ambiguous` — the supervisor makes its own **inline** trivial /
  non-trivial judgment against the rubric *"would a reviewer plausibly
  catch a bug here that CI and the author would miss?"* — with **NO
  `claude -p` subprocess and NO Task spawn** (the load-bearing
  no-nested-LLM constraint). When uncertain, **fail open** to
  requesting. Set `DECISION=non-trivial` (request) or `DECISION=trivial`
  (decline).

Then fire the helper's request mode (it owns the `requested_reviewers`
POST + the queued-verification re-read):

```bash
DECISION_ARG=""    # set to "--decision non-trivial" or "--decision trivial" only for the ambiguous branch
VERDICT=$(gh pr diff "$PR" --name-only \
  | flow-request-copilot --pr "$PR" --override "$OVERRIDE" $DECISION_ARG)
REQUESTED=$(printf '%s' "$VERDICT" | jq -r '.requestCopilot')
```

Two helpers split the old single-file poll loop: `flow-ci-check` is the
one-shot decider (presence checks → conflict/blocked short-circuits →
CI/Copilot/PR-state decision matrix, one fresh `gh` observation per call,
wall-clock anchors durably persisted in `~/.flow/state/<slug>.json`'s
`ciWait` record) and `flow-ci-wait` is the dumb bounded waiter (owns zero
state, zero decisions — it only sleeps). Wake precedence: the Bash
`run_in_background` completion notification on the backgrounded waiter →
a bounded Monitor `until` loop (or `ScheduleWakeup`, equivalent, when
present) → the `ci-wait-pending` yield-and-resume as the last resort —
every layer ends in the same foreground `flow-ci-check` call, so the wake
primitive never changes the verdict. Full contract in
`references/polling-protocol.md`, unit-tested at `bin/lib/ci-decision.test.ts`,
`bin/lib/ci-observe.test.ts`, `bin/flow-ci-check.test.ts`.

Append `--copilot-not-requested` to the `flow-ci-check` call only when no
Copilot review is coming — **two** signals: the request decision was to
**decline** (`$REQUESTED` is `false` — trivial PR or the
`bots.copilotSkipWait` budget short-circuit), or the verdict reports
`copilotRequestable:false` (Copilot unavailable on this repo). Read
`$REQUESTABLE` via `jq` alongside `$REQUESTED`; the verdict's `declineKind`
field (`skip-wait` vs `skip-request`) makes the decline reason
machine-checkable instead of string-sniffing `reason`.

A `requestSkipReason` (auto-review already enabled, so the helper skipped
the redundant request) **deliberately does NOT** append the flag — the
auto-review will still post, so the supervisor keeps waiting and picks it up
via the historical/author-match path. The flag hard-forces
`copilotConfigured=false`, bypassing both the in-flight `reviewRequests`
check and the historical-PR fallback; `$SKIP_REASON` is logged only, never a
driver. A forced request (`--override always`) never yields a
`requestSkipReason` — the POST always fires (the #260 fix).

**(1) Foreground decider call** — `flow-ci-check` directly, NOT backgrounded (one fresh `gh` observation completes in seconds):

```bash
VERDICT_FILE="$WORKTREE/.flow-tmp/ci-wait-result.json"
rm -f "$VERDICT_FILE"   # clear any stale verdict from a prior CI cycle
REQUESTABLE=$(printf '%s' "$VERDICT" | jq -r '.copilotRequestable // empty')
SKIP_REASON=$(printf '%s' "$VERDICT" | jq -r '.requestSkipReason // empty')  # logged only
NOT_REQUESTED_FLAG=""
# A genuine decline or unavailability collapses the wait; an auto-review skip keeps it.
[ "$REQUESTED" = "false" ] || [ "$REQUESTABLE" = "false" ] && NOT_REQUESTED_FLAG="--copilot-not-requested"
# WAIT_FLAG mirrors state.json's waitForCopilot — a per-call shell loses any prior `SLUG=...`, so re-set it from $FLOW_SLUG.
SLUG="$FLOW_SLUG"; WAIT_FLAG=""
[ "$(jq -r '.waitForCopilot // empty' ~/.flow/state/"$SLUG".json)" = "true" ] && WAIT_FLAG="--wait-for-copilot"
flow-ci-check "$PR" $NOT_REQUESTED_FLAG $WAIT_FLAG --out "$VERDICT_FILE" > "$WORKTREE/.flow-tmp/ci-check-stdout.json"
CHECK=$(cat "$WORKTREE/.flow-tmp/ci-check-stdout.json"); STATUS=$(printf '%s' "$CHECK" | jq -r '.status')
```

Branch on `.status`: **`decided`** — go straight to "Branch on `.decision`"
below (`$CHECK` already carries every `RunResult` field; `$VERDICT_FILE`
was written since the exit was decided). **`waiting`** — go to step (2).

**(2) Backgrounded waiter, primary wake** — read `nextCheckSec` (flat 60s,
`FLAT_CADENCE_SEC`) and arm the dumb waiter with `run_in_background: true`:

```bash
NEXT=$(printf '%s' "$CHECK" | jq -r '.nextCheckSec')
flow-spawn --class default -- flow-ci-wait "$PR" --min-sec "$NEXT" --max-sec 540
```

The Bash completion notification (waiter exit, up to 540s later) is the
wake: **on wake, re-run step (1)** — a fresh `flow-ci-check` call, never a
resumed loop.

**(3) Fallback ladder**, only when the primary wake misses a turn: a
bounded Monitor `until` loop (`until flow-ci-check "$PR"
$NOT_REQUESTED_FLAG $WAIT_FLAG --out "$VERDICT_FILE" | jq -e
'.status=="decided"' >/dev/null; do sleep "$NEXT"; done`, ≤3600000 ms) or
`ScheduleWakeup` (same 60s floor, equivalent, when present) — both end in
the same `flow-ci-check` call. If neither fires before turn-end:
**yield-and-resume (`ci-wait-pending`)** — write `flow-state-update --phase
ci-wait-pending` and end the turn cleanly (a pending phase; `flow-stop-guard`
treats it as a legitimate turn-end, no loop-break budget consumed). On
re-invocation, re-run step (1): a parsing `$VERDICT_FILE` short-circuits to
"Branch on `.decision`"; otherwise `flow-ci-check` runs fresh.

**(4) Failed observation.** A `flow-ci-check` call whose `gh` read itself
failed emits `waiting` + `observation:"failed"` + `observationFailedSec`
(from `ciWait.lastObservedAt ?? ciWait.startedAt`) — never a fabricated
decision. Rule: `observationFailedSec >= 1200` ⇒ `NEEDS HUMAN: gh-unavailable`.

**Anchors, not an in-process clock.** Every `elapsedSec` re-derives from
`ciWait.startedAt` in state.json; `ciTerminalAt` prefers GitHub's own
`completedAt` (floored at `startedAt`) over observation time — a
suspended/parked waiter can delay the next `flow-ci-check` call but never
inflate what it reports as elapsed, immune to fabricating `ci-hang`.
`$VERDICT_FILE` is written only on `decided`, so "file exists and parses
⇒ branch" resume logic and `flow-pipeline-summary --ci-wait-result` keep
working unchanged.

Branch on `.decision`. Resolve the render lens once for the whole table: `LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)`. At every terminal `flow-gate-summary` render below (status: merged, gated, needs-human, or cancelled), first author `TLDR="<one sentence, ≤25 words, the user-visible outcome>"` (per [TLDR and WHY authoring (product brief)](shared-gate-contracts.md#tldr-and-why-authoring-product-brief)) and pass `--tldr "$TLDR"`; a `flow-notify` call in the same row passes `--reason "$TLDR"` (needs-human also passes `--tag <reason-tag>`); a `flow-pipeline-summary` call in the same row adds `--lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)` and, right after, captures `COUNTS_LINE=$(flow-pipeline-summary --status <status> --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)`, threaded into `flow-gate-summary --counts-line "$COUNTS_LINE" --untracked-file <(flow-untracked render --format gate --unfiled-only)`.

| `.decision` | Action |
|---|---|
| `proceed-to-review` | Continue to step 8. |
| `proceed-to-review-no-bot` | Same as above; the bot review timed out 10 min after CI went terminal, or the Copilot auto-detect short-circuited (see `copilotSkipReason` JSON field — one of `unclaimed-after-deadline`, `self-dismissed`, or `null` when the 10-min timeout fired). |
| `ci-failed` | Continue to step 5 mode=fix. Pass `$CI_FAILED_CHECKS` (extracted above) as the failure log. Subject to the 3-loop ci-fix cap below. |
| `merged-externally` | PR was merged externally mid-flight. Capture follow-ups output to a file: `flow-followups run > "$WORKTREE/.flow-tmp/followups-block.txt"` (still executes auto-allowlisted entries; `>` captures the rendered block). Set `SLUG="$FLOW_SLUG"`, in ONE `gh pr view` round-trip guarded by `[ -n "$PR" ]`, capture the diff-size source AND the echo-recap fields (`[ -n "$PR" ] && gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName > "$WORKTREE/.flow-tmp/pr-view.json" && IFS=$'\t' read -r PR_URL PR_TITLE PR_BRANCH < <(jq -r '[.url, .title, .headRefName] \| @tsv' "$WORKTREE/.flow-tmp/pr-view.json") && jq '{additions,deletions,changedFiles,commits:(.commits\|length)}' "$WORKTREE/.flow-tmp/pr-view.json" > "$WORKTREE/.flow-tmp/pr-changes.json"`), then render the snapshot ABOVE the gate block via `flow-pipeline-summary --status merged --state-file ~/.flow/state/"$SLUG".json --pr-changes-file "$WORKTREE/.flow-tmp/pr-changes.json" --pr-review-result "$WORKTREE/.flow-tmp/pr-review-result.json" --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --consolidator-result "$WORKTREE/.flow-tmp/consolidator-result.json" --ci-wait-result "$WORKTREE/.flow-tmp/ci-wait-result.json" --followups-block-file "$WORKTREE/.flow-tmp/followups-block.txt" --filed-issues-file "$WORKTREE/.flow-tmp/filed-issues.txt" --intent-resolution "$WORKTREE/.flow-tmp/intent-resolution.json" --post-comment "$PR" --echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH" --lens "$LENS" --scout-file "$WORKTREE/.flow-tmp/scout.md" --untracked-file <(flow-untracked render --format markdown --unfiled-only)` (`--post-comment` durably persists the snapshot as an idempotent PR comment on the MERGED path; it no-ops when `$PR` is empty), then capture `COUNTS_LINE=$(flow-pipeline-summary --status merged --fix-applier-result "$WORKTREE/.flow-tmp/fix-applier-result.json" --counts-line)` — then **extract the block between `<!-- flow-echo-recap:start -->` and `<!-- flow-echo-recap:end -->` from the helper output and echo it VERBATIM as markdown bullets in your assistant message (prose, not tool output)**; see the [Gate-stage echo-verbatim recap](shared-gate-contracts.md#gate-stage-echo-verbatim-recap---echo-prose) subsection. Then render the epic-membership block via `flow-epic-membership --slug "$SLUG" --terminal-state merged-externally` (no-op for non-epic features). Run `flow-browser-teardown --reap --record` (registry-driven reap; records its outcome in state.json and always exits 0 — never blocked, never swallowed) as its own standalone step, then author `TLDR="<one-sentence outcome>"` and render the MERGED block via `flow-gate-summary --status merged --pr-url "$PR_URL" --why "PR was merged externally mid-flight; supervisor cleaned up the worktree" --cleanup --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt" --tldr "$TLDR" --lens "$LENS" --untracked-file <(flow-untracked render --format gate --unfiled-only) --counts-line "$COUNTS_LINE"` — which records `phase: merged` itself, only after its block reaches stdout, so a render failure leaves state.json non-terminal and `flow-stop-guard` nudges retry (the helper silently suppresses the FOLLOW-UPS slot when the file is empty; its final stdout line is the byte-exact sentinel `MERGED`). Then, since arming first would be stale on arrival, best-effort checkpoint: `[ "$(flow-checkpoint --probe --site terminal \| jq -r '.verdict')" = write ] && echo "Pipeline reached MERGED (externally) at $(date -u +%Y-%m-%dT%H:%M:%SZ)." > "$(flow-checkpoint --path)"; flow-checkpoint --site terminal >/dev/null` (stdout muted, stderr deliberately left connected — echo the `checkpointed: ` line verbatim per the [Checkpoint arm signal (echo-verbatim)](shared-gate-contracts.md#checkpoint-arm-signal-echo-verbatim) subsection). Then `flow-remove-worktree --delete-branch`, call `flow-notify --status merged --url "$PR_URL" --reason "$TLDR"`. End. The roadmap row was self-marked in the PR's diff by `/flow-pr-review` step 7.5; no post-merge sweep required. |
| `pr-closed` | Escalate `NEEDS HUMAN: pr-closed-mid-flight`. |
| `pr-conflicted` | Branch conflicts with base; CI can never run. Advance to the step-10 merge path — `flow-merge-guard merge` surfaces the conflict-class failure and the existing Merge-Conflict Resolver Subagent merges base into the branch, resolves, and pushes, after which CI re-runs on the clean head and the pipeline re-enters step 7. Does NOT consume a ci-fix-loop budget slot (conflict remediation is a merge, not a code fix). |
| `pr-blocked` | Branch protection blocks the merge — `mergeStateStatus` is still `BLOCKED` (a failing required check, a missing required review, CODEOWNERS, or a linear-history rule outside the `gh pr checks` surface) **after** CI reached terminal and passed. Unlike `pr-conflicted`, this fires only post-CI-terminal (a PR is legitimately `BLOCKED` while required checks are still pending, so `flow-ci-check` waits CI out first), and unlike a conflict it has no universal mechanical fix the pipeline owns. Escalate `NEEDS HUMAN: pr-blocked` via the standard `# Failure paths` block. Does NOT route to the step-10 merge path and does NOT consume a ci-fix-loop budget slot. |
| `ci-hang` | Escalate `NEEDS HUMAN: ci-hang`. |

`--copilot-login <login>` overrides the bot login (default reads
`~/.flow/config.json` `bots.copilot`, falling back to
`copilot-pull-request-reviewer`). The helper applies the
`CI_CONFIGURED=0` and `COPILOT_REQUESTED=0` presence overrides
internally — no workflows in `.github/workflows/` collapses to
vacuously-passing CI; bot not requested as a reviewer collapses to
vacuously-posted (skipping the 10-min timeout).

`--wait-for-copilot` is a per-pipeline opt-out of the Copilot
auto-detect short-circuits (see
`references/polling-protocol.md` "Claim-deadline auto-detect" and
"Self-dismissal short-circuit"). The supervisor reads the
`waitForCopilot` field from state.json (`jq -r '.waitForCopilot //
empty'`) and appends `--wait-for-copilot` to the `flow-ci-check` call
when the value is the literal `true`. Absent ≡ false ≡ auto-detect ON
(the documented default). The flag is set per-pipeline via
`flow feature create --wait-for-copilot "<description>"`.

**Fix-loop cap: 3 total ci-fix loops** across the whole pipeline.
When the third ci-fix loop still leaves CI red, escalate
`NEEDS HUMAN: ci-fix-exhausted`.

The cap is counted in `state.json`, not in context, so it survives a
compaction or a resume. On every ci-fix re-entry, read the counter
BEFORE bumping it and gate the re-entry on the cap (absent `loops` ≡
`{ciFix: 0, reviewFix: 0}`):

```bash
SLUG="$FLOW_SLUG"
CI_FIX=$(jq -r '.loops.ciFix // 0' ~/.flow/state/"$SLUG".json)
```

When `CI_FIX` is already 3, do not re-enter step 5 — escalate
`NEEDS HUMAN: ci-fix-exhausted` and end. Otherwise bump the counter and
loop back to step 5:

```bash
flow-state-update --increment-loop ciFix
```

**End condition:** the helper exits 0 with one of the decisions
above. On `proceed-to-review` / `proceed-to-review-no-bot`, continue
to step 8. On `ci-failed`, continue to step 5 mode=fix. On
`pr-conflicted`, advance to the step-10 merge path (the existing
Merge-Conflict Resolver Subagent merges base in + resolves + pushes; no
ci-fix-loop budget consumed) and re-enter step 7 once CI re-runs on the
clean head. On `merged-externally`, run cleanup and end. On `pr-blocked`
/ `pr-closed` / `ci-hang`, escalate and end.
