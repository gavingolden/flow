# Shared gate-stage contracts

Contracts the gate, merge and follow-up steps (and resume, failure paths and redirects) all consume, hoisted unchanged from the end of step 11 so no step doc has to borrow another step's doc.

Contents: PIPELINE SNAPSHOT block · Gate-stage echo-verbatim recap · TLDR and WHY authoring · Checkpoint arm signal

### `## PIPELINE SNAPSHOT` block (`flow-pipeline-summary`)

`flow-pipeline-summary` renders a `## PIPELINE SNAPSHOT` block ABOVE the `flow-gate-summary` block at the post-review terminal states (MERGED, GATED, NEEDS HUMAN) so the user reads one continuous terminal block: a phase-by-phase account, then the gate verdict. It is an LLM-free Bun helper that aggregates the structured artifacts the pipeline already writes and renders ONLY sourced facts across seven sections — CHANGES (commits/diff size from `gh pr view`), PHASES (`state.json`'s `phaseLog[]` written by `flow-state-update --phase`), INTENT (the `/flow-pr-review` Step 3.6 intent-mismatch verdict from `intent-resolution.json`, explicit `none` when the check never ran), FINDINGS (review verdict + fix-applier/consolidator counts + CI/Copilot outcome), FORECLOSED PATHS (the full prose of the fix-applier + consolidator rejected alternatives + anti-patterns, plain-text mode of the same shared formatter the PR-body `## Foreclosed Paths` section uses), FOLLOW-UP ISSUES (filed sweep URLs from `filed-issues.txt` + `/flow-pr-review` deferrals), and MANUAL STEPS (the captured `followups-block.txt` verbatim). Each section prints the literal `none` when its source is absent or empty (explicit-`none` discipline — never a fabricated "looks like it passed"). Degradation of the fix-applier-sourced FINDINGS `fixes:` and FORECLOSED PATHS slots is per-entry, not all-or-nothing: a partially-broken artifact (well-formed top-level keys, one off-shape entry) still renders every well-formed entry and appends a residual `(N unreadable)` marker for the dropped ones, while only a genuinely-unreadable artifact (non-JSON, non-object, or a missing/wrong-typed required top-level key) degrades the whole category to `(unreadable)` — never crashing the snapshot. The same shared formatter still backs both surfaces (so they cannot drift; the cross-surface parity test now also exercises this partial-degradation path). The block NEVER emits a `flow-stop-guard` sentinel (`MERGED` / `GATED:` / `NEEDS HUMAN:` / `cancelled`) — `flow-gate-summary` owns the sentinel as the byte-exact last line of stdout; the snapshot prints above it. v1 scope is the post-review terminal states only: the helper is wired at exactly the four post-review terminal `flow-gate-summary` sites (the step-11 MERGED block, the step-9 `gated` branch, both `merged-externally` renders, and the canonical `# Failure paths` NEEDS HUMAN block) and NOWHERE else — pre-review NEEDS HUMAN escalations (triage-ambiguous, worktree-create-failed, plan-missing) fire before any reviewable artifact exists, so wiring the snapshot there would print an all-`none` block of pure noise.

**Durable PR-comment persistence (MERGED-only, `--post-comment`).** The scrollback render is transient — close the tmux window or overflow the buffer and the snapshot is gone. On the MERGED terminal state, the three MERGED call sites (the step-11 block and both `merged-externally` renders) additionally pass `--post-comment "$PR"`, which posts the rendered `## PIPELINE SNAPSHOT` as a **top-level PR issue-comment** (not a review), so a merged PR carries its own pipeline provenance. The write is **idempotent**: the comment body is the rendered block plus a single-line HTML-comment marker (`<!-- flow-pipeline-snapshot-v1 -->`); the helper lists the PR's issue-comments, edits the marked one in place if present, and only creates a new one otherwise — a resume / watch-driven re-render replaces rather than duplicates. The marker lives ONLY in the posted comment body, never in stdout, so the scrollback render and the `flow-stop-guard`/auto-merge invariants are byte-for-byte unchanged. Persistence is **MERGED-only** (enforced inside the helper — `--post-comment` is ignored on `gated`/`needs-human` even if supplied), because a gated PR keeps churning and a snapshot comment would go stale while a merged PR is frozen. The write is **best-effort, never escalated** — a `gh` failure (or an empty `$PR`) is reported to stderr and never changes the exit code, the scrollback render, or the terminal verdict; this mirrors the "Failed auto-runs are reported, not escalated" rule in `step-11-follow-ups.md` (a peripheral comment-post failure must not un-merge a PR).

### Gate-stage echo-verbatim recap (`--echo-prose`)

At each gate stage, AFTER running the helper, the supervisor extracts the
block between `<!-- flow-echo-recap:start -->` and `<!-- flow-echo-recap:end -->`
from the helper's stdout and **echoes it verbatim** as markdown bullets in its
own assistant message body. This is **prose, not tool output** — Claude Code
routinely truncates and collapses Bash tool results, so the two click targets a
returning user needs (the full PR URL and the absolute plan-file path) can be
folded away exactly when they are needed. Echoing the block as assistant prose
re-surfaces the PR URL after follow-up commits (a `/flow-pr-review` fix push or a
CI-fix loop) have scrolled the original PR-open message far up the buffer. The
supervisor's only job is to mirror the pre-rendered block — it does NOT restate
the fields from memory, paraphrase, reorder, or drop any of them; the block is
identical-by-construction (helper-computed), so when echoed it is always
complete and correct.

`--echo-prose` is wired at two helper surfaces. At the post-review PR-bearing
gates (MERGED / GATED / NEEDS HUMAN / merged-externally), `flow-pipeline-summary
--echo-prose` prepends the block at the **top** of its stdout, above the
`## PIPELINE SNAPSHOT` block — a new top section of the SAME single invocation,
NOT a new call between the snapshot and the `flow-gate-summary` gate block, so
the snapshot → gate-summary → phase-transition ordering and the byte-exact
final-line sentinel are untouched. At the AWAITING-APPROVAL gate (where no
reviewable artifact exists yet, so `flow-pipeline-summary` is intentionally not
wired), `flow-gate-summary --status awaiting-approval --echo-prose` emits the
block above its own no-sentinel two-bullet path block.

Each post-review gate site issues a SINGLE
`gh pr view "$PR" --json additions,deletions,changedFiles,commits,url,title,headRefName`
round-trip into `"$WORKTREE/.flow-tmp/pr-view.json"`, then derives BOTH outputs
from that one blob via `jq`: the `pr-changes.json` diff-size object (same shape
as before) and the `url`/`title`/`headRefName` shell vars (`PR_URL` / `PR_TITLE` /
`PR_BRANCH`). It then passes
`--echo-prose --pr-url "$PR_URL" --plan-file "$WORKTREE/.flow-tmp/plan.md" --pr-title "$PR_TITLE" --branch "$PR_BRANCH"`
to the existing `flow-pipeline-summary` call. The PR-URL and plan-file bullet
lines render as markdown links (`bin/lib/link.ts`; `renderEchoRecap`
defaults to markdown because the recap is copied into assistant prose,
not a terminal) and carry **NO trailing punctuation** either way — the
link form closes with `)`, so the punctuation rule is the FALLBACK for
bare-URL auto-detection, not the mechanism. The
field-bearing bullets may carry normal punctuation.

The recap renders exactly this **bounded field set** and no more: PR URL,
absolute plan-file path, branch + PR number, PR title, current phase, CI verdict,
review verdict + finding count, and follow-up count. The set is pinned by a
`bin/skill-md-lint.test.ts` anchor so the recap stays a concise re-orientation
block, not a second snapshot. Absent fields render the literal `none` (the same
explicit-`none` discipline the snapshot uses).

Scope: the four post-review PR-bearing gates + AWAITING APPROVAL, and resume
re-entry into a gate state. NOT pre-review NEEDS HUMAN escalations
(triage-ambiguous, worktree-create-failed, plan-missing) — no PR/plan exists
there to echo.

### TLDR and WHY authoring (product brief)

Resolve the product brief ONCE per session, by bare PATH name — never a
`bin/lib` import, the same discipline discovery uses, since a sub-agent runs
in the consumer/target worktree where flow's own `bin/lib` does not exist:

```bash
{ test -f "$WORKTREE/.flow/product.md" || test -f ~/.flow/product.md; } && (cd "$WORKTREE" && flow-product-brief) || echo '{"found":false}'
```

Every `TLDR="..."` string and every `--why` string this skill authors is
REQUIRED to cite the resolved brief's top-ranked priorities, in its `Use`
vocabulary, as the lead clause — the user-visible consequence for what the
brief's PM ranks highest, never an internal mechanism. On `{"found":false}`,
change nothing: author the TLDR/WHY exactly as each site above already
documents, with no brief clause at all.

### Checkpoint arm signal (echo-verbatim)

`flow-checkpoint` prints exactly ONE stderr line at every arm —
`checkpointed: true — site=<site> — safe to /clear`, or
`checkpointed: false — <reason> — /clear will lose unsaved in-chat state`.
The supervisor extracts it by anchoring on `^checkpointed: (true|false)` (never
a raw stderr dump) and echoes it **verbatim** as the last line of its assistant
message at that arm site — same mirror-only discipline as the [Gate-stage
echo-verbatim recap](#gate-stage-echo-verbatim-recap---echo-prose): never
restate from memory, paraphrase, reorder, or drop it.

This does not conflict with `references/pause-output-contract.md`'s
`## Closing-summary` clause ("the block is always the last thing in the
message"): the banner is not a slot inside the block. It is a carved-out
trailer that follows the completed pause block as its own line — see that
file's own carve-out note for the authoritative statement of the exception.

**Never mute an arm call's stderr** (`2>/dev/null`, `2>&1`, `&>`) — that
silently swallows the line and leaves the arm invisible. An arm whose call
already redirects *stdout* to null (keeping the raw JSON verdict off the gate
block) keeps that redirect: it is stdout-only, and stderr stays connected.

The same line is also written to `last-arm-banner.txt` in the slug's checkpoint
dir (`armBannerPath`), for a reader that missed the original — a fresh session
resuming from a checkpoint. Treat its absence as unknown, never as "never
armed": `--consume` unlinks this file alongside the marker (never a recursive
directory delete — the checkpoint dir itself is never removed), so a consumed
checkpoint's banner is gone by design. Every `needs-human` render via `flow-gate-summary` that records a new pause prints this same line itself, regardless of which call site triggered it; echo it there like any other arm.
