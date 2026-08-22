# Failure recovery

Three sections:

- **(a) Per-step failure recovery** — what the supervisor does when
  a step fails mid-pipeline. Used live in PR 2.
- **(b) Resume-from-disk** — what the supervisor does when invoked
  with `--resume` after a Claude Code crash. Pinned here for PR 9;
  the `--resume` entry-point is not yet wired in PR 2.
- **(c) No-retry escalation variants** — the full procedures for the
  three no-retry escalations (`branch-mismatch`, `terminal-regression`,
  `task-tool-unavailable`), read on demand from the trigger table in
  SKILL.md's `# Failure paths` section rather than kept inline there.

## (a) Per-step failure recovery

The general rule: **prefer escalating to human over silent retry**.
Each step that fails has a bounded retry budget; once exhausted,
print `NEEDS HUMAN: <reason>`, leave the worktree + PR intact, and
end the turn. The user attaches to the tmux window and types a
redirect to recover.

| Step          | Failure                                                                                      | Budget                            | Action when budget exhausts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — triage    | classification ambiguous after 1 clarifying question                                         | 1 question                        | Escalate: `NEEDS HUMAN: triage-ambiguous`. End.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 1 — triage    | first `flow-state-update` returns no-state-file inside a flow window (`@flow-slug` resolves) | ~3 retries                        | Escalate: `NEEDS HUMAN: state-file-missing-on-start`. End — never work inline on the base branch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2 — worktree  | `flow-new-worktree` non-zero exit                                                            | 1 attempt                         | Escalate: `NEEDS HUMAN: worktree-create-failed <stderr>`. End.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 3 — plan      | `/flow-product-planning` exits without writing `<worktree>/.flow-tmp/plan.md`                | 1 retry                           | Escalate: `NEEDS HUMAN: plan-missing`. End.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4 — approval  | user input ambiguous                                                                         | 1 clarifying question             | Ask the question; if still unclear, escalate: `NEEDS HUMAN: approval-ambiguous`. End.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5 — implement | `/flow-new-feature` exits without committing + pushing + opening PR                          | 1 retry                           | Escalate: `NEEDS HUMAN: implement-failed`. End.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 6 — verify    | `/flow-verify` exits without a clean pass                                                    | **3 outer attempts**              | Escalate: `NEEDS HUMAN: verify-exhausted`. Surface the last failure log on the PR body's `## Test Steps` as a `> [!CAUTION]` block (idempotent). End.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 6 — verify    | UI-smoke bootstrap needs a test-user credential it can't infer or resolve from the local env | 0 attempts                        | Write everything else verified into `.flow/ui-validation.json` + commit, then escalate: `NEEDS HUMAN: smoketest-needs-creds`. Provide the credential env var(s) named in `credentialEnvVars`, then `flow feature resume <slug>`. End.                                                                                                                                                                                                                                                                                                                                                                                                   |
| 7 — ci-wait   | hard cap reached, CI still pending                                                           | 20 min cap                        | Escalate: `NEEDS HUMAN: ci-hang`. End.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 7 — ci-wait   | CI red                                                                                       | **3 fix-loops total**             | Escalate: `NEEDS HUMAN: ci-fix-exhausted`. End.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 8 — review    | `/flow-pr-review` finds critical issues                                                      | **2 fix-loops total**             | Escalate: `NEEDS HUMAN: review-fix-exhausted`. End.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 8 — review    | `/flow-pr-review` exits non-zero                                                             | 1 retry                           | Escalate: `NEEDS HUMAN: review-failed`. End.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 9 — gate      | `gh pr view` fails or returns unparseable JSON                                               | 1 retry                           | Escalate: `NEEDS HUMAN: gh-error <stderr>`. End.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 9 — gate      | PR `CLOSED` without merge                                                                    | 0 attempts                        | Escalate: `NEEDS HUMAN: pr-closed-without-merge`. End.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 10 — merge    | `gh pr merge --squash` fails                                                                 | 1 retry                           | Escalate: `NEEDS HUMAN: merge-failed`. End.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 10 — merge    | merge-resolver subagent returns without writing `.flow-tmp/merge-resolver-result.json`       | 0 retries (one Task call per run) | Escalate: `NEEDS HUMAN: merge-resolver-missing-artifact`. End.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 10 — merge    | merge-resolver Task spawn is denied by the permission system                                 | 0 retries (one Task call per run) | Escalate: `NEEDS HUMAN: merge-resolver-spawn-denied`. End.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| (any)         | user types `cancel` / `abort` / `kill this`                                                  | 0 attempts                        | Run `flow-remove-worktree`, run `flow-browser-teardown --reap --record` (registry-driven reap; records its outcome in state.json and always exits 0 — never blocked, never swallowed) as its own standalone step, then author `TLDR="Cancelled at your request; nothing further will run."` and render the CANCELLED block via `flow-gate-summary --status cancelled --cleanup --why "<context>" --tldr "$TLDR" --lens "$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)" --untracked-file <(flow-untracked render --format gate --unfiled-only)` (BEFORE the terminal state transition), write `phase: cancelled`. End. |

### The verify outer-retry loop

`/flow-verify` has its own internal "run checks → fix → re-run" loop. The
supervisor's outer cap of 3 attempts fires only when `/flow-verify` exits
without a clean pass (it hit its own internal cap, or its
self-reported success failed the deterministic post-check at
`.flow/verify`). Each outer retry appends the previous attempt's
failure log to the next prompt so `/flow-verify` doesn't re-attempt the
same fix in a vacuum. At 30-min timeout per attempt, the worst-case
bound is **90 minutes** before escalation.

### The implement-fix loop

When CI is red (step 7) or review surfaces critical findings (step
8), the supervisor loops back to step 5 with `mode: fix` and the
failure log appended. The implement skill then writes a focused fix
commit on the existing branch and pushes — it does NOT open a new
PR. After each fix push, the supervisor returns to step 7 (CI wait),
not to step 8 directly: a fix can break CI just as easily as it can
fix the review finding.

The two fix-loop caps (3 for ci-fail, 2 for review-critical) are
counted independently. A pipeline can in principle do up to 3
ci-fix loops _and_ 2 review-fix loops before escalating.

### What "escalate" means

The order below is load-bearing: the NEEDS HUMAN block renders BEFORE
the state file's terminal transition, so a reader watching scrollback
sees the reason before the phase flips. All four steps are supervisor
actions with no user step in between, so no actor prefix is needed here
(compare the per-variant procedures in §(c) below, where the actor
alternates and each step names it). Shape rule:
`references/pause-output-contract.md` `## Step contract`.

1. Run `flow-browser-teardown --reap --record` (registry-driven reap;
   records its outcome in state.json and always exits 0 — never
   blocked, never swallowed) as its own standalone step — never
   `&&`-chained to the render below; a non-zero exit here is expected
   on the failure path and must not block step 2.
2. Render the NEEDS HUMAN block via `flow-gate-summary --status
needs-human --reason <tag> --cleanup` (carrying any inline context as
   `--why`). The helper emits `STATUS:` / optional `PR:` / `WHY:` /
   `NEXT ACTION:` / `CLEANUP:` / optional `FOLLOW-UPS:` rows above the
   sentinel; the
   sentinel line itself (`NEEDS HUMAN: <reason>`) remains byte-identical
   as the **final line** of the block.
3. Run `flow-state-update "$SLUG" --phase needs-human` so `flow ls`
   surfaces the stall.
4. Leave the worktree intact. Leave the PR intact. **Do not** call
   `flow-remove-worktree`.
5. End the supervisor's conversation turn. The user attaches and types
   a redirect (or runs `flow done <name>` to abandon).

The helper maintains a per-reason `NEXT_ACTION_BY_REASON` mapping;
new escalation reasons added to the cap table below must also be
added to the helper at `bin/flow-gate-summary.ts`.

The supervisor does **not** re-enter the failed step on its own
after escalation — `flow feature resume <name>` (PR 9) is the way
back in.

## (b) Resume-from-disk decision tree (pinned for PR 9)

When PR 9 lands, `flow feature resume <name>` re-enters the supervisor
into a tmux window whose Claude Code session crashed. The supervisor
must infer "what phase am I in" from the worktree + PR state, not
from any in-process memory (which is gone).

Each step in the 10-step pipeline has at least one inspectable
side-effect on disk or on GitHub. The supervisor walks the table
top-down and resumes at the first step whose precondition is **not**
met:

| Step             | Inspect                                                                                                                                                                                                                                                                                                    | If true, this step is done                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 2 — worktree     | the worktree path recorded in `~/.flow/state/<slug>.json` (originally printed by `flow-new-worktree`) exists and is a git checkout                                                                                                                                                                         | yes                                                                   |
| 3 — plan         | `<worktree>/.flow-tmp/plan.md` exists and is non-empty                                                                                                                                                                                                                                                     | yes                                                                   |
| 4 — approval     | `state.json` shows `phase` ∈ {`implementing`, `installing-skills`, `verifying`, `ci-wait`, `reviewing`, `gating`, `merging`, `merged`, `gated`}                                                                                                                                                            | yes                                                                   |
| 5 — implement    | `gh pr view` for the worktree's branch returns a PR (any state)                                                                                                                                                                                                                                            | yes                                                                   |
| 5.5 — re-symlink | `state.json` shows `phase` ∈ {`verifying`, `ci-wait`, `reviewing`, `gating`, `merging`, `merged`, `gated`} OR the worktree's `git diff --name-only origin/<default-branch>...HEAD` adds nothing under `skills/` or `agents/` (resolve `<default-branch>` from `git symbolic-ref refs/remotes/origin/HEAD`) | yes (idempotent — safe to re-run `flow install --upgrade` regardless) |
| 6 — verify       | `state.json` shows `phase` ∈ {`ci-wait`, `reviewing`, `gating`, `merging`, `merged`, `gated`}                                                                                                                                                                                                              | yes                                                                   |
| 7 — ci-wait      | PR's checks all reached terminal state                                                                                                                                                                                                                                                                     | yes                                                                   |
| 8 — review       | PR has a `pr-review` commit on HEAD (look for the conventional commit prefix `review:` or the trailer `Co-Authored-By: ... pr-review`)                                                                                                                                                                     | yes                                                                   |
| 9 — gate         | PR is `MERGED` or `state.json` shows `phase: gated`                                                                                                                                                                                                                                                        | yes                                                                   |
| 10 — merge       | PR is `MERGED` AND worktree directory removed                                                                                                                                                                                                                                                              | yes (terminal)                                                        |

The first row whose "done" condition is **false** is where the
supervisor resumes. If every row is done, the pipeline is in a
terminal state — render the terminal block via `flow-gate-summary
--status <merged|gated|needs-human|cancelled> ...` (the same helper
every gate-emission site uses) and end.

Two phase classes are decided **before** the row walk, not by it.
`flow-resume-decide` sources its terminal-phase set from the canonical
`TERMINAL_PHASES` in `bin/lib/state.ts` (so `needs-human` resolves
`terminal` like `merged`/`gated`/`cancelled`, rather than drifting
through the tree), and short-circuits the two no-in-flight-work pending
phases — `triaged-no-change` and `triage-pending-clarification` — to
`terminal` as well. Those two carry no worktree/plan/PR, so without the
short-circuit they would reach row 2 (`worktree not yet created`) and
spin up a worktree + plan + build, contradicting the recorded triage.

### Edge cases

- **Worktree exists but `state.json` shows `phase: starting` /
  `triaging` / `worktree-create`.** Treat as resume-from-step-3
  (plan). The worktree was created but the pipeline crashed before
  the planning phase advanced state.
- **`.flow-tmp/plan.md` exists but no PR.** Resume at step 4 (approval).
  The user may have approved before the crash; the supervisor re-prints
  the plan summary, emits the same two markdown bullets as step 3's
  feature-intent end-condition (worktree absolute path + plan file
  absolute path, last lines, no trailing punctuation), and waits for the
  user to re-confirm. We don't replay an approval the user gave to a
  now-dead session.
- **PR exists but `state.json` is stale (e.g. still shows
  `implementing`).** Resume at step 6 (verify). The PR survived; the
  phase value didn't catch up before the crash.
- **`state.json` is missing entirely.** The pipeline was never
  started, or `flow done` already ran. Refuse to resume — the user
  should run `flow feature create` afresh.
- **PR `CLOSED` without merge.** The user closed the PR while the
  session was crashed. Escalate `NEEDS HUMAN: pr-closed-without-
merge`; do not resume. Let the user decide reopen vs. abandon.
- **No-change / pending-clarification triage with no worktree
  (`triaged-no-change` / `triage-pending-clarification`).** Resolved to
  `terminal` before the row walk (see the note above the table). Re-surface
  that the pipeline already completed (a no-change investigation) or was
  awaiting a clarification a resume can't re-ask, and end — do not build a
  worktree.

### What `--resume` does NOT do

- It does not re-run the verify or review steps if they previously
  passed. Their successful exit is observable from disk + PR state.
- It does not auto-merge a PR that's already in `gated` state — the
  user gated it intentionally.
- It does not delete a worktree on crash. Worktree cleanup is a
  step-10 effect; if step 10 didn't run, the worktree stays.

## Why escalation is preferred over deeper retry

Each retry burns latency, money, and (most importantly) supervisor
context — every failed attempt's tool results stay in the
conversation until the turn ends. A 4th verify attempt that
hallucinates a fix to a 3-failed-attempt log is worse than a clean
hand-off to the user. The pipeline's value comes from automating
the boring 80%, not from heroic recovery on the messy 20%.

If a particular failure starts hitting the same cap repeatedly in
practice, raise the cap deliberately — don't paper over it with an
inner retry layer.

## (c) No-retry escalation variants

Three escalations take a no-retry path with their own procedure, moved
here from SKILL.md's `# Failure paths` section behind a trigger table.
Read the relevant block below and execute it rather than acting from
memory.

### Branch-mismatch escalation (no retries)

When `flow-state-update` exits with status 3, the worktree's branch
no longer matches the `.flow-branch` marker written by
`flow-new-worktree`. This means a peer pipeline (or a stray manual
git command) renamed this branch out from under us — the same family
of failure as the 2026-05-01 incident. The mechanical guard refused
to write the phase transition; the supervisor must NOT retry. Shape
rule: `references/pause-output-contract.md` `## Step contract`.

1. **Supervisor:** escalate immediately:

```bash
flow-browser-teardown --reap --record  # registry-driven reap; records the outcome in state.json; always exits 0 — never blocks, never silently no-ops
TLDR="A branch mismatch was detected; nothing was overwritten."
LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)
flow-gate-summary --status needs-human --reason branch-mismatch \
  --why "<expected vs actual from stderr>" --cleanup \
  --tldr "$TLDR" --lens "$LENS" \
  --untracked-file <(flow-untracked render --format gate --unfiled-only)  # render BEFORE the terminal state transition
flow-state-update --phase needs-human  # may itself fail; that's ok, scrollback shows the cause
flow-notify --status needs-human --reason "$TLDR" --tag branch-mismatch
```

2. **User:** inspect `git reflog` and `git worktree list` to decide
   whether the rename was malicious, accidental, or expected. There is
   no auto-recovery — branch state is load-bearing. The worktree and
   PR stay intact throughout.

### Terminal-regression escalation (no retries)

When `flow-state-update` exits with status 4, a terminal→non-terminal
phase regression was detected — the existing phase in state.json is one
of `merged`, `gated`, `needs-human`, `cancelled`, or `epic-approved`,
but the requested transition would move to a non-terminal phase. This
signals an ambient-pane race that wrote to the wrong pipeline's state:
`resolveSlugFromPane()` resolved a stale or mismatched slug and the
write was blocked by the mechanical guard. The supervisor must NOT
retry. Shape rule: `references/pause-output-contract.md`
`## Step contract`.

The three documented `gated` exits — to `verifying`, `gating`, or
`merging` — are allowlisted and never reach this escalation. So a
surviving exit 4 always signals a genuine cross-pipeline write, never
one of those three normal resume paths.

1. **Supervisor:** escalate immediately:

```bash
flow-browser-teardown --reap --record  # registry-driven reap; records the outcome in state.json; always exits 0 — never blocks, never silently no-ops
TLDR="A cross-pipeline state write was blocked; nothing was corrupted."
LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)
flow-gate-summary --status needs-human --reason terminal-regression \
  --why "<expected→actual from stderr>" --cleanup \
  --tldr "$TLDR" --lens "$LENS" \
  --untracked-file <(flow-untracked render --format gate --unfiled-only)   # render BEFORE the terminal state transition
flow-state-update --phase needs-human     # may itself fail; that's ok, scrollback shows the cause
flow-notify --status needs-human --reason "$TLDR" --tag terminal-regression
```

2. **User:** inspect the state file and decide whether the victim
   pipeline is genuinely terminal. There is no auto-recovery — the guard
   blocked the write precisely to avoid corrupting a finished pipeline's
   terminal state. The worktree and PR stay intact for inspection.
3. **User (only if the victim's state was already corrupted by a prior
   race):** direct the supervisor to run the operational recovery for an
   already-corrupted pipeline:

```bash
flow-state-update --phase <merged|gated|needs-human|...> --force --slug <victim-slug>
```

`--force` bypasses the regression guard; `--slug` targets the
specific pipeline rather than relying on pane resolution. Use only
after confirming which pipeline's state needs correction.

### Task-tool unavailable (no retries)

Fires when any of the nine spawn procedures' load step
(`ToolSearch query="select:Task"`) returns a response that does not
contain _either_ a `<function>{"name": "Task", ...}</function>` _or_ a
`<function>{"name": "Agent", ...}</function>` line — i.e. the harness
has surfaced neither alias of the one-shot subagent-spawn primitive
top-level in the current session. The supervisor must NOT fall back
to in-line execution; in-line fallback breaks the context-isolation
contract each Task-tool exemption is justified by (PR #124 was the
inaugural silent-fallback regression). Shape rule:
`references/pause-output-contract.md` `## Step contract`.

1. **Supervisor:** escalate immediately:

```bash
flow-followups run --note-only > "$WORKTREE/.flow-tmp/followups-block.txt"
flow-browser-teardown --reap --record  # registry-driven reap; records the outcome in state.json; always exits 0 — never blocks, never silently no-ops
TLDR="The subagent spawn tool isn't available in this session; nothing was lost."
LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)
flow-gate-summary --status needs-human \
  --reason "task-tool-unavailable: <exemption-name>" \
  --cleanup \
  --deferred-file "$WORKTREE/.flow-tmp/followups-block.txt" \
  --tldr "$TLDR" --lens "$LENS" \
  --untracked-file <(flow-untracked render --format gate --unfiled-only)   # render BEFORE the terminal state transition
flow-state-update --phase needs-human
flow-notify --status needs-human --reason "$TLDR" --tag "task-tool-unavailable: <exemption-name>"
```

2. **User:** restart `claude` (or upgrade the CLI) so the Task tool is
   surfaced top-level.
3. **User:** resume the pipeline (`flow feature resume <slug>`).
   - The helper parses the `:`-suffix and appends ` (spawn site:
<exemption-name>)` to the `NEXT ACTION:` **header line** of
     `NEXT_ACTION_BY_REASON["task-tool-unavailable"]` so the rendered
     block names the exact spawn site; the sentinel line is byte-exact
     `NEEDS HUMAN: task-tool-unavailable: <exemption-name>`.
   - `<exemption-name>` is one of `pr-review-gatekeeper`,
     `pr-review-multi-agent-review`, `pr-review-fix-applier`,
     `pr-review-consolidator-validator`, `product-planning-discovery`,
     `new-feature-scout`, `coder-edit-applier`, `flow-pipeline-merge-resolver`,
     `flow-pipeline-verify-loop`.

No retry is appropriate — the deferred-tool surfacing is environmental;
remediation is to re-run in a session where `Task` or `Agent` is surfaced
top-level (restart `claude` or upgrade the CLI). Leave the worktree + PR
intact. For the `pr-review-*` sites (now reachable from the in-process
Skill load, `context: fork` removed), the escalation tag is written into
`<worktree>/.flow-tmp/pr-review-result.json` with `status: "escalated"`
and step 8's artifact-read propagates it into `NEEDS HUMAN:
<escalation_tag>`.
