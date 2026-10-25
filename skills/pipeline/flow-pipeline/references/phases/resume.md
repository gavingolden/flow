# Resume mode

Contents: Checkpoint re-injection

Step 0 (Echo the originating request) runs first on this re-entry path too,
before the resume-mode detection below.

The supervisor enters resume mode when the seed prompt begins with
the literal prefix:

```
Use the /flow-pipeline skill in --resume mode for: <slug>
```

`flow feature resume <name>` writes that prompt; nothing else does.
On detecting it, **do not** start at step 1. Call `flow-resume-decide`
to walk the resume-from-disk decision tree:

```bash
RESULT=$(flow-resume-decide)
RESUME_AT=$(printf '%s' "$RESULT" | jq -r '.resumeAt')
REASON=$(printf '%s' "$RESULT" | jq -r '.reason')
WORKTREE=$(printf '%s' "$RESULT" | jq -r '.context.worktree // empty')
PR=$(printf '%s' "$RESULT" | jq -r '.context.pr // empty')
ANSWER=$(printf '%s' "$RESULT" | jq -r '.context.answer // empty')
CHECKPOINT_EXISTS=$(printf '%s' "$RESULT" | jq -r '.context.checkpointExists // empty')
```

The helper reads `~/.flow/state/<slug>.json`, probes the worktree +
plan + PR + CI + HEAD commit, and returns one of the values below.
Each step in the 10-step pipeline has at least one inspectable
side-effect on disk or on GitHub, so the helper can always answer
"what was already done?" without any in-process memory; the contract
is unit-tested at `bin/flow-resume-decide.test.ts`. The full per-row
precondition table lives in `references/failure-recovery.md`
section (b).

Print `RESUMING AT: <resumeAt> (<reason>)` on its own line before
re-entering the step, so the user reading scrollback can confirm.
From that step onward, behave exactly as the normal pipeline — the
same phase transitions, the same `flow-state-update` calls, the same
caps.

**Checkpoint re-injection (persisted conversational state).** A fresh
process reconstructs the pipeline *step* from disk but drops any
instruction held only in chat. Before re-entering the resolved step,
check `$CHECKPOINT_EXISTS`: when `true` (a **usable** body — present,
non-empty, still fresh; slug-keyed, so it survives a worktree-less phase and
the `terminal` row re-injects too), resolve
`CHECKPOINT_PATH=$(printf '%s' "$RESULT" | jq -r '.context.checkpointPath // empty')`
and **read `$CHECKPOINT_PATH` BEFORE running `--consume`**, folding its
addenda into the re-entered step — honor the persisted approval
condition, redirect, or in-chat decision as if just given. Then run:

```bash
flow-checkpoint --consume
```

which retires the body — archiving it to `checkpoint.consumed.md` (same
directory, recoverable, never silently deleted), clearing the freshness record,
and deleting the one-shot `checkpoint.pending` marker so a later `/clear` does
not re-fire it. Skip the read-before-consume ordering and an addendum like
"approved with condition X" vanishes on the clear.

Branch on `.resumeAt`:

| `.resumeAt` | Action |
|---|---|
| `step-1` | Re-enter step 1's Intent interview (adaptive) sub-step. `.context.interview` carries `state.interview`'s persisted digest — re-render the frontier's `still-open` questions from it under their existing `Q<n>` ids (do NOT re-derive the frontier from scratch, and do NOT renumber) and continue the round protocol from `references/interview-playbook.md`. Step 1's ask-time write means a digest is present at every `triage-pending-interview` pause; an ABSENT one is a pre-fix state file (or a crash before the phase write landed), so re-derive the frontier from the original request and say so in the re-rendered round, rather than silently presenting renumbered questions as if they were the ones already on screen. |
| `step-2` | Re-enter step 2 (worktree). Recreate via `flow-new-worktree`. |
| `step-3` | Re-enter step 3 (plan). If `state.phase` was `plan-pending-interview`, re-render the battery from `.flow-tmp/interview-questions.md` on disk (the file, not `.context.interview`) instead of blindly re-invoking discovery; `.context.interview`, when present, carries only the prior triage-side digest as background context for framing the re-render, never the battery itself. Otherwise re-invoke `/flow-product-planning`. `!inputs.planExists`-guarded (the `plan-pending-interview` row in `bin/flow-resume-decide.ts`, identified by name rather than line number since the file reflows), so this row is discovery's own question gate only — the method pause (`references/blind-survey.md`) fires AFTER `plan.md` exists and lands on `step-4` instead, a safe, lossy degrade. |
| `step-4` | Re-enter step 4 (approval). Re-print the plan summary, then emit the same two markdown bullets as step 3's feature-intent end-condition (worktree absolute path + plan file absolute path, on their own lines as the last lines of the message, no trailing punctuation), and wait — never replay an approval the user gave to a now-dead session. |
| `step-5` | Re-enter step 5 (implement). Re-invoke `/flow-new-feature`. |
| `step-5.5` | Re-enter step 5.5 (re-symlink). Re-run `flow-skill-overlay sync` (when a copy exists) and `flow install --upgrade --source "$WORKTREE"` per step 5.5's end-condition (idempotent). |
| `step-6` | Re-enter step 6 (verify). Re-invoke `/flow-verify` inline (phase stays `verifying`; a re-invocation is idempotent because `/flow-verify` only reuses passes recorded on the identical tree within 30 minutes and never for a check that failed there). |
| `step-7` | Re-enter step 7 (ci-wait). A `state.json` phase of `ci-wait` **or** `ci-wait-pending` (the yielded-while-waiting pending phase) both resolve here. **Read `$WORKTREE/.flow-tmp/ci-wait-result.json` first**: if it exists and parses, a prior `flow-ci-check` call already reached `decided` — read the persisted verdict and branch on `.decision` without re-running anything. Only when the file is absent or unparseable does the supervisor re-run `flow-ci-check` fresh (never re-launch the old poll loop — there is none; a `waiting` verdict re-arms the dumb `flow-ci-wait` waiter per step 7's wake ladder). |
| `step-8` | Re-enter step 8 (review). Re-invoke `/flow-pr-review <PR>`. |
| `step-9` | Re-enter step 9 (gate). Two sub-cases distinguished by `.reason`: `pr-merged-worktree-still-exists` (run step 11's MERGED branch — which re-runs `flow-pipeline-summary ... --echo-prose ...` and re-echoes the recap verbatim per the [Gate-stage echo-verbatim recap](shared-gate-contracts.md#gate-stage-echo-verbatim-recap---echo-prose) subsection — then render the MERGED block via `flow-gate-summary --status merged ...` (same `--tldr`/`--lens` augmentation as step 11's MERGED block; records `phase: merged` itself, only after its block reaches stdout) then, since arming first would be stale on arrival, best-effort checkpoint: `[ "$(flow-checkpoint --probe --site terminal \| jq -r '.verdict')" = write ] && echo "Pipeline reached MERGED at $(date -u +%Y-%m-%dT%H:%M:%SZ)." > "$(flow-checkpoint --path)"; flow-checkpoint --site terminal >/dev/null` (stdout muted, stderr deliberately left connected — echo the `checkpointed: ` line verbatim per the [Checkpoint arm signal (echo-verbatim)](shared-gate-contracts.md#checkpoint-arm-signal-echo-verbatim) subsection) and run `flow-remove-worktree --delete-branch`, end; **do not** fall through to step 10's merge on an already-merged PR) vs. `at-auto-merge-gate` (re-evaluate the gate via `flow-gate-decide`). |
| `gated-feedback` | Re-enter feedback mode for a `gated` PR carrying a checkpoint marker. Print `RESUMING AT: gated-feedback (gated-with-checkpoint-marker)`, re-inject `$CHECKPOINT_PATH` (the generic checkpoint re-injection above), then position to take a bug callout → route it through the `/flow-coder` interactive redirect → re-verify (step 6) → re-gate (step 9). **This loop introduces no new merge path and never merges on its own authority:** its re-gate re-enters the normal step 9 gate, which routes every merge through the existing `flow-merge-guard` backstop (Decision A1) — a still-`gated` PR ends terminally at `gated`; the only merge routes are the user ticking all Test Steps boxes (gate re-reads `auto-merge`, `flow-merge-guard` confirms zero-unchecked) or the existing gate-override token. Then `flow-checkpoint --consume` to retire the body (archive to `checkpoint.consumed.md`, clear the freshness record) and drop the one-shot marker. The loop's phase writes are exactly `verifying` (step 6) and `gating` (step 9) — the `/flow-coder` step itself writes no phase — and both are allowlisted in `TERMINAL_EXIT_TRANSITIONS` (`bin/lib/state.ts`) so they no longer trip the exit-4 terminal-regression guard. |
| `browser-retry` | Re-enter step 9's `browser-retry` re-drive for a `browser-retry-pending` PR. Print `RESUMING AT: browser-retry (browser-retry-pending-open-browser-items)`, re-run `flow-gate-decide "$PR"` to recompute `.browserItems`, then record phase `reviewing` (Step 8's head fence) and run `/flow-pr-review "$PR" --resume-from 8c --browser-items <indices>` (the marker is ignored: a human asked), then step 9 again. |
| `awaiting-human` | A `needs-human` pipeline with a live worktree and no PR, or an open PR (mirrors `gated`). Print `RESUMING AT: awaiting-human (needs-human-awaiting-human-step)`. When `$CHECKPOINT_EXISTS` is true, read `$CHECKPOINT_PATH` per the generic checkpoint re-injection above, but do NOT run `flow-checkpoint --consume` at this pause — consume only on the confirming reply, so a second `/clear` before `done` re-resumes into the same pause. Resolve the effective step BEFORE rendering: checkpoint notes that explicitly name a `step-N` target override `.context.continueAt`, so the step shown here is always the step a `done` reply uses. Render the pause per `references/pause-output-contract.md` (`**TLDR:**` paused waiting on you; `**Manual action:**` the human step from the notes; when no notes are usable, say plainly that the pending step's details were not recorded and ask what it was — never print `.reason` (an internal verdict tag, e.g. `needs-human-awaiting-human-step`, not a human-facing description); when the pause's last `phaseLog` row carries an `outcome` (e.g. the stop guard's `stalled at <phase> after <n> blocked stops — reply …`), show it as the cause; `**Next action:**` reply `done` to continue at the effective step — or `merge #<pr>` at a `merge-permission-denied` pause or a stop-guard stall at `gating`/`merging` — or redirect / cancel) and end the turn. **This row never continues the pipeline before the user confirms the human step is done.** On a later affirmative reply: run `flow-checkpoint --consume`, then `flow-state-update --phase "$(printf '%s' "$RESULT" \| jq -r '.context.continuePhase')"` with no `--force` (allowlisted in `TERMINAL_EXIT_TRANSITIONS`; it grants no merge authority — its FEATURE continue phases are exactly `planning`, `plan-pending-review`, `implementing`, `installing-skills`, `verifying`, `ci-wait`, `reviewing`, `gating` (the four epic-design continue phases in the same allowlist belong to `/flow-epic-create`'s Resume mode), and `merging` is never one, so any merge always re-runs the step 9 gate — a merge-failed pause continues at that gate, never straight to a merge; a `merge #<pr>` reply is this same affirmative reply, continuing `gating` → step 9 `flow-gate-decide` → step 10), then re-enter the resume row for the effective step shown at the pause. A reply carrying detail or an instruction is an imperative redirect applied at that step; `cancel` runs the Mid-flight redirects cancel path. When `.context.continueAt` is absent, ask one clarifying question naming the escalation reason. |
| `terminal` | Already in a terminal state. Re-run the corresponding gate render (the same helpers every gate-emission site uses) and end without re-running anything else. On `merged`/`gated` the render re-runs `flow-pipeline-summary ... --echo-prose ...` above `flow-gate-summary --status <merged\|gated> ...`, so the echo recap re-surfaces on resume re-entry — extract the `<!-- flow-echo-recap:start -->`…`<!-- flow-echo-recap:end -->` block and echo it VERBATIM per the [Gate-stage echo-verbatim recap](shared-gate-contracts.md#gate-stage-echo-verbatim-recap---echo-prose) subsection (re-orientation is exactly the resume use case). `cancelled` has no PR, so `--echo-prose` is a no-op there. `needs-human` re-renders the escalation via `flow-gate-summary --status needs-human ...` (same `--tldr`/`--lens` augmentation as its originating render) ONLY when the worktree is gone; a `needs-human` pipeline with a live worktree resolves `awaiting-human` above instead, never this row. The two no-in-flight-work pending phases short-circuit here pre-tree (reasons `no-change-investigation-complete` for `triaged-no-change`, `awaiting-triage-clarification` for `triage-pending-clarification`): they carry no PR/worktree and have no gate-summary status, so print a one-line note that the pipeline already completed (a no-change investigation, or one awaiting a clarification a resume can't re-ask) and end — do NOT build a worktree. On the `triaged-no-change` path, when `$ANSWER` is non-empty, re-print the saved `$ANSWER` (as markdown) so the user re-reads the original answer instead of the generic terminal note; fall back to the generic note when `$ANSWER` is empty. The re-rendered UNTRACKED row still accepts `file #N` / `drop #N` (`flow-untracked file|drop <N>`) on the very next reply — the resume terminal row is not read-only. |
| `escalate` | Escalate `NEEDS HUMAN: <.reason>` (e.g. `worktree-missing-on-resume`, `pr-closed-without-merge`). Leave the worktree + PR intact. |
| `abort` | The state file is missing. Escalate `NEEDS HUMAN: state-missing-on-resume` and end. |

On the `terminal` row, any post-render QA prose the resume turn adds (answering a user question after re-rendering the gate block) is formatted per `references/pause-output-contract.md` — labeled slots, no open prose, never a second block over the helper render (the re-rendered gate block already satisfies the contract).
<!-- any new pause site below must reference pause-output-contract.md -->

`flow-resume-decide` resolves `approval-pending-clarification` to
`step-4` (`bin/flow-resume-decide.ts` Row 4 — the phase is not in
`POST_APPROVAL_PHASES`) for both feature and `route-to-step-4`
non-feature pipelines alike: it is the phase step 4's Ambiguous branch
writes while awaiting the user's clarifying-question reply, so the
plain step-4 row above already covers it — no disambiguation marker is
needed.

## Edge cases (condensed from `references/failure-recovery.md` section (b))

These mirror the resume-table rows above; the full per-row precondition
table lives in `references/failure-recovery.md` section (b).

- **Worktree path recorded but the directory is gone.** Escalate
  `NEEDS HUMAN: worktree-missing-on-resume` — don't auto-recreate.
- **Worktree exists but state.json shows `phase: starting` /
  `triaging` / `worktree-create`.** Treat as resume-from-step-3 (the
  worktree was created but planning never advanced state).
- **`.flow-tmp/plan.md` exists but no PR.** Resume at step 4 (approval).
  The user may have approved before the crash; re-print the plan
  summary, emit the same two markdown bullets as step 3's
  feature-intent end-condition (worktree absolute path + plan file
  absolute path, last lines, no trailing punctuation), and wait for
  the user to re-confirm. Don't replay an approval the user gave to
  a now-dead session.
- **PR exists but state.json is stale (e.g. `implementing`).** Resume at
  step 6 (verify) — the PR survived; the phase didn't catch up.
- **PR `CLOSED` without merge.** Escalate `NEEDS HUMAN:
  pr-closed-without-merge`; let the user decide reopen vs. abandon.
- **Terminal phase (`merged` / `gated` / `needs-human` / `cancelled`).**
  Render the terminal block via `flow-gate-summary --status
  <merged|gated|needs-human|cancelled> ...` and end without re-running
  anything (`needs-human` sourced from `TERMINAL_PHASES` in
  `bin/lib/state.ts`, so a crashed escalation resolves `terminal`) —
  except a `needs-human` pipeline with a live worktree, which resolves `awaiting-human` above instead.
- **No-in-flight-work pending phase (`triaged-no-change` /
  `triage-pending-clarification`).** `flow-resume-decide` short-circuits
  these to `terminal` pre-tree — they carry no worktree, plan, or PR. On
  `triaged-no-change`, re-print the saved `$ANSWER` (from `.context.answer`)
  as markdown when non-empty; otherwise a one-line already-completed note.
  Do **not** fall through to step 2 and build a worktree.

## What resume mode does NOT do

- It does not re-run verify or review steps if they previously
  passed. Their successful exit is observable from disk + PR state.
- It does not auto-merge a PR that's already in `gated` state — the
  user gated it intentionally.
- It does not delete a worktree on entry. Worktree cleanup happens
  after step 10's merge (or in step 9's MERGED branch when the PR
  was merged externally); if neither ran, the worktree stays.
- It does not re-run `gh pr merge` on a PR that is already `MERGED`.
  An already-merged PR with the worktree still present resumes into
  step 9's `MERGED` cleanup branch (render the MERGED block via
  `flow-gate-summary --status merged ...` — same `--tldr`/`--lens`
  augmentation as step 11's MERGED block above — which records
  `phase: merged` itself, only after its block reaches stdout), then
  run `flow-remove-worktree --delete-branch`, not step 10.
  The roadmap row was flipped to `✅ shipped (#$PR)` in the PR's own
  diff by `/flow-pr-review` step 7.5, so no post-merge sweep is needed.
- It does not rewrite state.json on entry. The first transition you
  make from your re-entry step is what updates phase.
