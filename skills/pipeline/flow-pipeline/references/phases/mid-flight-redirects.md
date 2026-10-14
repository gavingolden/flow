# Mid-flight redirects

The user can type into the tmux chat at any phase boundary or
mid-phase. Apply `references/redirect-handling.md`:

- Affirmative input mid-phase → acknowledge, keep going.
- Imperative redirect → re-enter the relevant phase with the
  redirect appended to the next prompt. Verbatim — don't paraphrase.
- Cancel → wait for any in-flight atomic action (commit, push, merge) to
  finish, then close the PR if open, run `flow-remove-worktree`, run
  `flow-browser-teardown --reap --record` (registry-driven; standalone step,
  never `&&`-chained; always exits 0), then author `TLDR="Cancelled at
  your request; nothing further will run."` and render the CANCELLED
  block via `flow-gate-summary --status cancelled --cleanup --why "user
  cancelled mid-flight at $(jq -r .phase ~/.flow/state/$SLUG.json)"
  --tldr "$TLDR" --lens "$(jq -r '.output.lens // "pm"'
  ~/.flow/config.json 2>/dev/null)"` — which records `phase: cancelled`
  itself, only after its block reaches stdout (`checkWorktreeBranch`
  no-ops gracefully against the already-deleted worktree path, so the
  earlier `flow-remove-worktree` does not block the finalize) — then
  best-effort checkpoint, always AFTER that render, since arming first
  is stale on arrival (`flow-checkpoint --probe --site terminal`; on
  `write`, echo a one-line residue to `flow-checkpoint --path`'s
  target, then `flow-checkpoint --site terminal` to arm — echo its
  `checkpointed: ` stderr line verbatim per the [Checkpoint arm signal
  (echo-verbatim)](shared-gate-contracts.md#checkpoint-arm-signal-echo-verbatim) subsection), end.
- Ambiguous → one clarifying question; if still unclear, escalate.

## Mid-flight code-change redirects

An imperative redirect splits into two kinds. A **scope/plan redirect**
("redo the plan with different scope") re-runs `/flow-product-planning` or
re-prompts the in-flight sub-skill. A **code-change redirect** ("rename
foo to bar", "change this line") arriving at a worktree-existing phase
(`plan-pending-review`, `implementing`, `verifying`, `ci-wait`,
`reviewing`) and NON-trivial takes the **interactive code-change redirect**
path: the supervisor composes a structured edit-set
`{file, intent, expected_outcome}` from the verbatim redirect, invokes
`/flow-coder` in-process, and reads `.flow-tmp/coder-result.json`
(`verify_status` + `summary`) exactly once — never the per-edit diff. A
trivial edit (≤1 file AND ≤30 LOC AND every file named in the redirect,
the same bar `/flow-new-feature` step 5 uses) stays inline. Do not collapse the
two paths. See `references/redirect-handling.md` for the per-phase matrix.

**Gated is an explicit carve-out, not a sixth in-flight phase.** `gated`
is terminal — it is deliberately NOT added to the
`plan-pending-review`/`implementing`/`verifying`/`ci-wait`/`reviewing`
list above. But a **bug callout at `gated`** (a code-change redirect
arriving while the PR sits at the gate during manual validation) still
routes through `/flow-coder`: compose the edit-set, invoke `/flow-coder`, then
re-verify (step 6) and re-gate (step 9). This preserves the
gated-is-terminal / no-new-merge-authority invariant — the re-gate
re-enters the normal step 9 gate and merges only through
`flow-merge-guard`; it is distinct from the post-verdict gate-override
*merge* path (a "merge this gated PR anyway" instruction), which stays
governed by "Gate override". The `gated-feedback` Resume-mode row above
is the auto-resumed entry into exactly this loop after a `/clear`. The
carve-out is mechanical, not only prose — `gated` and `needs-human` are
the only terminal phases with a `TERMINAL_EXIT_TRANSITIONS` entry
(needs-human's being the `awaiting-human` row's continue phases above),
and their allowlisted targets are the only terminal→non-terminal writes
`flow-state-update` accepts without `--force`.
