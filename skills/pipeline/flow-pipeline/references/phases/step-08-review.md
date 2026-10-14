## Step 8 — Review

Contents: Pre-review checkpoint arm · Surface UI screenshots · Fix-loop cap: 2 total review-fix loops · End condition · Read the /flow-pr-review result artifact and branch on .status · Missing or empty artifact

**Phase:** `reviewing`

Write the phase BEFORE invoking the review sub-skill below, so the
phase names the step the run is actually inside:

```bash
flow-state-update --phase reviewing
```

`flow-fetch-pr-review` (run by `flow-review-prep`, the review sub-skill's
Step 2 setup call) still emits `reviewing` at this step's tail as an
idempotent backstop — by then
`advancePhase` returns `already-at-or-past`, so the backstop adds no
duplicate `phaseLog[]` row. An inline metadata triage `skip`
short-circuit (Step 1.5, closed/merged/trivial PR) bypasses Step 2's
fetch, so the backstop never fires — but the step-head write above has
already recorded `reviewing` regardless, closing the `phaseLog[]` audit
hole that short-circuit used to leave.

Invoke `/flow-pr-review` in-process with the PR number:

```
/flow-pr-review <PR>
```

**Pre-review checkpoint arm (best-effort).** Once `/flow-pr-review` Step
2's `flow-review-prep` payloads land under `.flow-tmp/` — never before,
or a `/clear` in that window resumes without them, and before Step 3's
lens fan-out — arm one: `[ "$(flow-checkpoint --probe --site pre-review | jq -r '.verdict')" = write ] && echo "Mid-review for PR <PR> — setup payloads on disk." > "$(flow-checkpoint --path)"; flow-checkpoint --site pre-review >/dev/null`. Writes no phase, ends no turn.

Every entry — including fix-loop re-entries — is delta-scoped and
lens-gated by `flow-review-scope` (`flow-pr-review`
`references/review-scope.md`); opt-outs `review.deltaScope` /
`review.lensGates` restore today's full-diff, all-six-lenses behaviour.

When the `chrome-devtools` MCP and a `.flow/ui-validation.json` manifest are present, `/flow-pr-review` Step 8c runs the subjective visual-appearance pass against the browser-validation capability (opening each page in a per-pipeline `isolatedContext`): it drives each enumerated visual-appearance item, judges it via the `ui-ux` skill, captures an a11y snapshot as primary evidence (injected via `flow-inject-evidence`) plus a screenshot referenced by path under `.flow-tmp/ui-evidence/`, and ticks the box. This adds no new Task-tool exemption — Step 8c.iii spawns the same **UI-Driver Subagent** exemption Step 6 uses (`references/exemption-contracts.md`'s `/flow-verify` Independent UI-Driver Subagent contract, a second caller); the subjective ui-ux judgment itself stays in the `/flow-pr-review` wrapper, which reads the driver artifact's screenshot paths and a11y excerpts rather than driving the browser itself. `/flow-pr-review` Step 3.6's intent-mismatch resolution sub-step also runs in this in-process review, comparing the diff-only intent-guess agent's blind guess against the actual request; it may escalate `NEEDS HUMAN: intent-drift` or append an unchecked `- [ ] DECISION: confirm scope drift is intentional` item to the PR's Test Steps.

`/flow-pr-review` itself spawns one **Fix-Applier Subagent** via the Task
tool (the fourth of the eight named Task-tool exemptions in "Hard
rules" above) to handle the per-finding address loop, the pre-commit
run, the commit + push, and the `/flow-verify` re-run — all inside the
subagent's isolated context. The subagent writes a structured
artifact to `<worktree>/.flow-tmp/fix-applier-result.json`; the
wrapper reads it once and reuses the parsed object across its
remaining steps. The supervisor never sees the per-finding fix
prose, only `/flow-pr-review`'s brief return summary.

**Surface UI screenshots (review-time).** `/flow-pr-review` Step 8c.iii's
UI-Driver spawn (above) writes its own
`<worktree>/.flow-tmp/ui-driver-result.json` (a fresh artifact per spawn,
distinct from the Fix-Applier's), so read `ui_screenshots[]` from THAT
artifact — not `fix-applier-result.json` — mirroring the same recipe used
at step 6:

  ```bash
  jq -r '(.item_results[]? | select(.screenshots | length > 0) | "# \(.item)", .screenshots[]), (select((.item_results // []) | all(.screenshots | length == 0)) | .ui_screenshots[]?)' "$WORKTREE/.flow-tmp/ui-driver-result.json" | while IFS= read -r p; do
    case "$p" in "# "*) printf '%s\n' "${p#\# }" ;; *) a=$(cd "$WORKTREE" && realpath "$p" 2>/dev/null) && [ -f "$a" ] && printf '[%s](file://%s)\n' "$a" "$a" ;; esac
  done
  ```

  Print the loop's output verbatim: each `SUBJECTIVE: ` / browser item (from `item_results[]`) on its own line, then its surviving screenshots as markdown links,
  `[<abs path>](file://<abs path>)` — one per line, no bullet marker, no
  trailing punctuation — all of them, no cap; with no per-item screenshots it falls back to the flat `ui_screenshots[]` list.

`/flow-pr-review` Step 1.5 runs an inline metadata triage — performed by
the reviewing session itself, no Task-tool spawn — before any Task-tool
fan-out fires. This short-circuit fetches PR metadata (`gh pr view`) and
applies deterministic skip rules to skip closed/merged/trivial/no-new-commits
PRs cheaply without paying for the four-agent Sonnet review. On a skip
verdict the wrapper writes a `status: "clean"` artifact and the supervisor
proceeds to the auto-merge gate; on a proceed verdict it falls through to
the full review. Full contract in
[references/exemption-contracts.md](../../../../../references/exemption-contracts.md).

The skill auto-detects Address vs Review mode from the existing PR
state and:

- In Address mode (existing inline review comments to address):
  resolves each, commits, pushes.
- In Review mode (no existing comments to address): runs the
  multi-agent independent review, posts findings as inline
  comments, auto-fixes any critical findings, commits, pushes.

**Fix-loop cap: 2 total review-fix loops.** If `/flow-pr-review`
surfaces critical findings that it can't auto-fix, loop back to
step 5 with mode=fix and the finding details. After the second
loop-back, escalate `NEEDS HUMAN: review-fix-exhausted`.

Like the step-7 cap, this one is counted in `state.json` rather than in
context, so it survives a compaction or a resume. On every review-fix
re-entry, read the counter BEFORE bumping it and gate the re-entry on it
(absent `loops` ≡ `{ciFix: 0, reviewFix: 0}`):

```bash
SLUG="$FLOW_SLUG"
REVIEW_FIX=$(jq -r '.loops.reviewFix // 0' ~/.flow/state/"$SLUG".json)
```

When `REVIEW_FIX` is already 2, do not re-enter step 5 — escalate
`NEEDS HUMAN: review-fix-exhausted` and end. Otherwise bump the counter
and loop back to step 5 with mode=fix:

```bash
flow-state-update --increment-loop reviewFix
```

After `/flow-pr-review` commits + pushes, return to step 7 (CI wait),
not directly to step 9. The fix commit may have changed CI.

**End condition:** `/flow-pr-review` returns clean (no critical
findings outstanding) AND the most recent CI cycle is green.
Continue to step 9.

### Read the `/flow-pr-review` result artifact and branch on `.status`

After `/flow-pr-review` returns, the wrapper has written a structured
result artifact at `<worktree>/.flow-tmp/pr-review-result.json`
(documented in `skills/pipeline/flow-pr-review/SKILL.md`'s `# Result
artifact` section). Read it exactly once and validate the shape
before branching:

```bash
flow-pr-review-result-schema --validate \
  "$WORKTREE/.flow-tmp/pr-review-result.json"
```

The validator exits 0 and prints `{ok: true}` on a well-formed artifact;
on a malformed or missing file it exits non-zero with
`{ok: false, reason, path?}` on stderr.

**Missing or empty artifact** → escalate `NEEDS HUMAN:
pr-review-missing-artifact` (no retry; mirrors
`fix-applier-missing-artifact`). The wrapper writes the artifact on every
documented exit path, so absence signals a catastrophic crash.

Branch on the artifact's `.status` field — exactly one of the
three string literals `"clean"`, `"partial"`, or `"escalated"`:

- `"clean"` → the skill ran to completion; continue to step 7 (CI
  wait) per the existing flow above, then step 9.
- `"partial"` (with non-empty `.missed_steps`) → re-invoke
  `/flow-pr-review <PR> --resume-from <first-missed-step>` exactly once (the
  `--resume-from` flag skips the steps already in `.completed_steps` and
  resumes at the named step). After the retry returns, re-validate the
  artifact and re-branch on `.status`:
    - retry-`"clean"` → continue per the `"clean"` branch above.
    - retry-`"partial"` → escalate `NEEDS HUMAN: review-partial:
      <missed_steps joined with commas>`.
    - retry-`"escalated"` → propagate `.escalation_tag` verbatim
      into `NEEDS HUMAN: <escalation_tag>` (same as the
      first-call `"escalated"` branch below — collapsing it into
      `review-partial` would drop the actionable tag, e.g.
      `task-tool-unavailable: pr-review-fix-applier`, in favour
      of a generic missed-step list).
  The partial-retry budget is one, **independent of the 2-loop
  review-fix cap above** (that cap counts auto-fixed critical findings;
  this counter tracks structural missed-step retries).
- `"escalated"` → propagate the `.escalation_tag` verbatim into
  `NEEDS HUMAN: <escalation_tag>` and bail. No retry: the tag names a
  documented bail-out site (e.g. `task-tool-unavailable: pr-review-*`,
  `fix-applier-missing-artifact`) whose
  resolution is user-action.

On non-zero exit from `/flow-pr-review` itself (Bun-level / shell-level
failure with no artifact written): retry once. If the retry also
fails, escalate `NEEDS HUMAN: review-failed`.
