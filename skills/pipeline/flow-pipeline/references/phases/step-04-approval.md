## Step 4 — Approval handling

Contents: Auto-checkpoint sub-step

**Phase:** `plan-pending-review` (set by step 3 for feature intent)

This step runs only when the next turn arrives — i.e. when the user
typed something into the tmux chat. Classify the input using
`references/redirect-handling.md`:

- **Affirmative** ("approved", "looks good", "go ahead", etc.) →
  proceed straight to the auto-checkpoint sub-step below, which ends
  the turn at `checkpoint-pending-clear`; the user resumes into step 5
  by typing `continue` (same session) or `/clear` (fresh, auto-resumed
  session). Bundled tasks and ticked candidates proceed exactly as
  authored — the user had the full `--details` disclosure (step 3's End
  condition above) in front of them before replying Affirmative.
- **Candidate curation reply** (`drop candidate #N`, `drop all
  candidates`, `file candidate #N`) → **mechanical, not a redirect and
  not a revision pass.** Run `flow-candidate-issues --plan-md-file
  "$WORKTREE/.flow-tmp/plan.md" --untick <N>` (single index) or
  `--untick <every currently-ticked index>` (bulk `drop all candidates`
  form) — or `--tick <N>` for `file candidate #N`, the mirror of drop —
  confirm the change in one line, and stay at
  `plan-pending-review` awaiting the user's next reply (approve /
  redirect / cancel). Full classifier detail in
  `references/redirect-handling.md`.
- **Imperative redirect** ("actually, also handle TSV"; "redo with
  X") → loop back to step 3, appending the redirect to the
  `/flow-product-planning` prompt as `USER REDIRECT (received during
  plan-pending-review): <verbatim>`. Two named redirect shapes carry
  extra handling:
  - `pull #N into the plan` → fold candidate #N's text into the plan
    body as the redirect payload; on re-entry the `--details` echo
    (step 3's End condition above) RE-FIRES over the full candidate
    list (`renderDetails` prints every candidate, grouped by state, not
    only unticked ones), so pulling one never silently drops the
    others. The step-3 auto-bundle pass composes this same payload
    itself, once, before the first render.
  - `defer task #N` (one or many task numbers in a single reply, e.g.
    `defer tasks #2 and #4`) → batch ALL deferred targets into ONE
    `USER REDIRECT: defer task(s) <N[, M...]> (<titles>) to follow-up
    issues` loop back to step 3 with the `REVISION: <n>` marker (same
    re-entry mechanics as any other Imperative redirect). **Defer-
    revision drift guard:** the redirect text MUST scope the resulting
    revision pass to exactly four surgical edits — remove the deferred
    task(s), renumber/repair the dependency table, update the Skills
    Summary if a removed task was its only user of a named skill, and
    append the item as a ticked candidate with a matching ranking-table
    row — its Rationale MUST read `user-foreclosed: "defer task #N"` —
    and a value-prop block whose Problem anchor is the user's
    `defer task #N` instruction — every other section of plan.md is
    preserved byte-for-byte. **Batched-defer corruption guard:** step 3's
    existing deterministic backstops (`flow-plan-lint`,
    `flow-candidate-issues --lint`) already re-validate the revised
    plan's structure on re-entry — that re-validation now also carries
    `bundlingMisses`, and the `user-foreclosed` Rationale above is what
    keeps the deferred item from being auto-bundled straight back.
- **Cancel** ("cancel", "abort") → run `flow-remove-worktree
  <slug>`, run
  `flow-browser-teardown --reap --record` (registry-driven; records
  outcome in state.json, always exits 0) as a standalone step, then
  render the CANCELLED block via `TLDR="Cancelled at your request before
  any code was written." LENS=$(jq -r '.output.lens // "pm"'
  ~/.flow/config.json 2>/dev/null) flow-gate-summary --status cancelled
  --cleanup --why "user cancelled at plan-pending-review" --tldr "$TLDR"
  --lens "$LENS"` — which records `phase: cancelled` itself, after the
  block reaches stdout (`checkWorktreeBranch` no-ops gracefully against the
  already-deleted worktree, so the earlier `flow-remove-worktree` does not
  block the finalize). End.
- **Ambiguous** → write `flow-state-update --phase
  approval-pending-clarification`, then ask the single clarifying
  question and end the turn. The next turn re-enters step 4 with
  the user's reply. If the answer is still unclear, escalate
  `NEEDS HUMAN: approval-ambiguous` via `flow-gate-summary --status
  needs-human` (which records `phase: needs-human` itself). Format this reply per `references/pause-output-contract.md` — labeled slots, no open prose (template: `### ❓ Clarification needed` / `**Needs attention:** <the ambiguous reply, quoted>` / `**Next action:** approve / redirect: … / cancel`).
  <!-- any new pause site below must reference pause-output-contract.md -->

### Auto-checkpoint sub-step

Runs on the **Affirmative** branch, as the last thing step 4 does before
ending the turn. This is the sub-step the forward-reference above
("proceed straight to the auto-checkpoint sub-step below") resolves to.
It is the approval → implement clear point: it flushes the load-bearing
approval state so the user can `/clear` here and resume into step 5 on
a fresh, low-context session.

1. **Flush approval state to `checkpoint.md` (non-clobbering).** Write it at
   the path `flow-checkpoint --path` prints. Probe with
   `flow-checkpoint --probe --site plan-approval`; only on a `write` verdict
   (a still-fresh manual note reads `preserve` and wins, left untouched)
   write the load-bearing conversational state the fresh process would
   otherwise drop: the approval verdict plus any addenda or conditions the
   user attached (e.g. an "approved with A1" note, a folded-in scope change,
   an "ignore flake X" decision). Unlike the gate auto-checkpoint (near-zero
   residue), this one genuinely flushes approval state, so it uses the fuller
   `/flow-checkpoint`-style flush.
2. **Arm the one-shot marker:** `flow-checkpoint --site plan-approval`
   (validates `checkpoint.md`, writes the `checkpoint.pending` marker on
   a ready verdict, and records the freshness receipt for this site).
3. **Advance the phase:** `flow-state-update --phase checkpoint-pending-clear`.
4. **Echo and end.** Echo step 2's `checkpointed: ` stderr line verbatim as
   the last line of the turn, per the [Checkpoint arm signal
   (echo-verbatim)](shared-gate-contracts.md#checkpoint-arm-signal-echo-verbatim) subsection — the
   pipeline resumes into step 5 on a fresh session, or the user can type
   `continue` to proceed in this session. Then end the turn.

On resume, Resume mode re-injects `checkpoint.md` and runs
`flow-checkpoint --consume`; `flow-resume-decide` resolves
`checkpoint-pending-clear` → step-5, so the fresh session re-enters at
implement with the approval addenda folded in (no helper change needed —
it's a non-terminal phase the resume + hook machinery already handles).
