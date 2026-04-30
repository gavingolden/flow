# Roadmap

## Architectural shift

flow is moving its front door from the CLI (`flow start`) to a Claude
Code skill (`/flow add`). The CLI is demoted to a backend used for
unattended runs, parallelism, and CI. The subprocess-per-phase
architecture is preserved — it's load-bearing for context isolation,
walk-away, and crash recovery. See [`architecture.md`](./architecture.md)
for the high-level shape and [`chat-first-design.md`](./chat-first-design.md)
for the rationale, diagrams, user flows, and alternatives considered.

Each PR below is independently usable: at the end of each, `flow` does
something more end-to-end than it did before. Internal abstractions are
not introduced ahead of the PR that needs them.

## Status table

| Phase | Adds | Status |
|---|---|---|
| **Triage + scaffold** | Phase 0 (triage) + CLI scaffold | **shipped** |
| **Plan / worktree / implement** | Phases 1–3 (plan, worktree, implement), single task | **shipped** |
| **Phase 1 — foundation** | jsonl logging, detached subprocesses, cross-process claim primitive, implement create/fix split | **next** |
| **Phase 2 — pipeline buildout** | ci-wait, verify retry loop, `flow log` viewer, review + critical loop-back, gate + merge | planned |
| **Phase 3 — entry point + UX** | `/flow add`, `/flow status`, `/flow watch`, plan checkpoint | planned |
| **Phase 4 — cutover + parallelism** | deprecate `flow start`, `flow install --upgrade`, parallelism, pause/resume/abort, notifications, `flow tui` | planned |

## Shipped work

### Triage + scaffold (shipped)

Done when:

- `flow start "<prompt>"` opens an interactive Claude Code session in the
  surrounding git repo with the triage system prompt appended.
- For a no-change request, the session answers in-line and exits without
  writing a file.
- For a change request, the session writes `.orchestrator/tasks/<id>.md`
  conforming to [`task-schema.md`](./task-schema.md) and exits.

### Plan / worktree / implement (shipped)

Done when:

- `flow run [<task-id>]` reads a `triaged` task and runs phases 1–3
  sequentially.
- After phase 1 (worktree), the task file has `worktree` and `branch`
  populated, the worktree exists on disk, and `<worktree>/.orchestrator`
  is a symlink to the main repo's `.orchestrator/`.
- After phase 2 (plan), the task file has populated `plan` outputs
  (PRD, breakdown, PR draft path) — written from inside the worktree
  via the symlink.
- After phase 3 (implement), the task has `pr` populated (number) and
  the PR exists on GitHub with the implementation committed and the
  `Manual validation` section in the body.
- A flow run on a `triaged` task with no human in between produces an
  open PR with code changes and tests.

The exit status of `flow run` is non-zero on any phase failure or
`needs-human` outcome, with the failing phase's reason printed.

## Phase 1 — foundation (PRs 1–3)

No user-visible UX change yet. Phase 1 lays the plumbing the chat-first
front door and the rest of the pipeline depend on.

### PR 1 — jsonl logging + detached subprocess plumbing

Done when:

- Every `claude -p` invocation runs with `--output-format stream-json
  --verbose` and its event stream is redirected to
  `.orchestrator/tasks/<id>/logs/<phase>-<ISO>.jsonl`.
- Script phases write their own structured logs to the same directory.
- Subprocesses can be spawned `detached: true` with a PID file recorded
  in the task directory, so the parent shell can exit without killing
  the pipeline.
- Closing the terminal that ran `flow run --detach` leaves the pipeline
  running.
- The detach-but-immediate-exit race is covered: if `flow run --detach`
  exits before the first phase logs an event, `/flow status` reflects
  the actual exit state (failure / `needs-human`) rather than reporting
  the task stuck at `triaged`. PID-file reaping plus a final-status
  write on every exit path is the contract this PR is responsible for.

### PR 2 — cross-process claim primitive

Done when:

- An atomic-rename file lock claims a `triaged` task for one runner —
  loser of the race skips the task and moves on.
- The in-memory lock in `runner.ts` is replaced with the new primitive.
- Two concurrent `flow run --all` invocations cannot pick up the same
  task id.

### PR 3 — implement mode split + re-entry hardening

Done when:

- `runImplementPhase` accepts an explicit `mode: "create" | "fix"`
  rather than inferring from `task.pr != null`.
- `mode: "create"` opens the PR; `mode: "fix"` re-runs against the
  existing branch with a failure log appended to the prompt.
- The implement phase is idempotent on resume — re-running it reads
  the task file fresh and only performs side effects when state
  demands them (e.g. only opens a PR if `pr` is null).
- Idempotence audit for the other shipped phases (worktree, plan)
  is deferred: each phase's resume contract gets its own pass when
  Phase 2 work touches it. PR 3's scope is the implement phase only.

## Phase 2 — pipeline buildout (PRs 4–8)

The remaining phases land in the new shape: deterministic scripts where
no judgment is needed, `claude -p` with fresh context where it is.

### PR 4 — ci-wait phase (script)

Done when:

- A Bun script polls `gh pr checks <pr> --json` and `gh pr view <pr>
  --json reviews` on a 30s cadence until terminal state.
- Configurable bot list (default `["copilot-pull-request-reviewer"]`)
  controls which auto-reviewers count toward "all reviews collected."
  Codecov, SonarCloud, custom apps can be added per-repo.
- 20-minute hard cap. If checks haven't reached terminal state, the
  task escalates to `needs-human` with reason "CI hang." If checks
  are terminal but a configured bot hasn't posted, ci-wait proceeds
  (timeout treated as bot timed out).
- Bot review excerpts are appended to the task file's `## Phase
  outputs > ci` section so the review phase can pick them up.

### PR 5 — verify phase + retry loop

Done when:

- `src/pipeline/retry.ts`'s `retryOnce` is generalised to `retryN(fn, n)`.
- Verify runs `/verify` in the worktree. On failure, in-place retry up
  to 3x with the failure log appended to the next attempt's prompt
  (truncated to ~200 lines plus error/fail/panic matches, to bound
  prompt growth).
- On exhaustion, the task escalates to `needs-human` with the final
  failure log surfaced in `## Phase outputs > verify`.
- A "flake" notation lands on the task file when verify passes after
  one or more retries (e.g. `verify: 2/3 passed (1 retry — suspected
  flake)`).

### PR 6 — `flow log <id>` viewer + pretty-printer

**LOAD-BEARING for the logging UX.** Without this, the jsonl files
from PR 1 are unreadable; with it, every observability story (`/flow
watch`, optional tmux attach, debug-stuck-phase) becomes a thin wrapper.

Done when:

- `flow log <id>` reads `.orchestrator/tasks/<id>/logs/*.jsonl` and
  pretty-prints events to stdout: tool calls, edits, bash invocations,
  thinking, results.
- `--follow` tails the active phase's log.
- `--phase <name>` filters to one phase.
- The output is jq-friendly (`flow log <id> --raw | jq …`) so power
  users can post-process.

### PR 7 — review phase + critical loop-back

Done when:

- Review phase invokes `/pr-review` in a fresh `claude -p` (never
  continued from implement — see [`chat-first-design.md`](./chat-first-design.md#5-phase-shape-scripts-vs-llm-phases)
  for why).
- Bot reviews collected by ci-wait (PR 4) are passed in as additional
  context.
- `/pr-review` returns JSON with `critical` and `minor` arrays.
- Findings post as **inline review comments**, not formal GitHub
  reviews.
- If `critical.length > 0`, default behaviour is loop back to
  implement(fix). Cap 2 review→implement cycles. After exhaustion,
  escalate to `needs-human` with the review log surfaced.
- Review may escalate immediately to `needs-human` with reason
  `architectural-concern` (skipping the loop-back) when a finding
  indicates the **plan**, not the code, is wrong — looping back to
  implement against a wrong plan just spins. The `/pr-review` JSON
  contract gains a `kind: "code" | "architectural"` discriminator on
  each critical finding so review can make this call deterministically.

### PR 8 — gate + merge phases

Done when:

- The implement phase populates the PR description's `## Manual
  validation` section based on heuristics (DB migration, external API
  integration, UI change, behaviour change to a critical path → fill;
  pure refactor / docs / internal logic → leave empty).
- Gate phase reads `gh pr view <pr> --json body`, strips HTML
  comments from the section, and decides:
  - Section non-empty ⇒ status `gated`, exit `needs-human`. The user
    merges manually after performing the documented validation.
  - Section empty ⇒ proceed to merge.
- Merge phase runs `gh pr merge --squash --delete-branch`, removes
  the worktree via the target repo's `remove-agent-worktree.ts`, and
  archives the task file under `.orchestrator/tasks/archive/`.
- An end-to-end run with no manual validation needed reaches `merged`
  without human intervention.

## Phase 3 — entry point + UX (PRs 9–12)

The chat-first front door lands. Old `flow start` keeps working in
parallel; no flag day.

### PR 9 — `/flow add` skill

Done when:

- A new skill at `skills/pipeline/flow-add/SKILL.md` runs the triage
  conversation inside the user's existing Claude Code chat.
- On change request, the skill writes `.orchestrator/tasks/<id>.md`
  and shells out to `flow run <id> --detach` (using PR 1's plumbing).
- On no-change request, the skill answers in-line and exits.
- The chat session is free again immediately after kickoff — the
  pipeline runs as a detached process tree.
- `flow start` continues to work; the two front doors share the same
  task schema.

### PR 10 — `/flow status` skill + `flow status` CLI

Done when:

- `flow status` (CLI) prints a table of all tasks with id, status,
  current phase, PR number, last-updated, and cost-to-date.
- Cost is tallied from `result.usage` events in the jsonl logs (PR 1).
- The parser handles three cases deterministically and documents them
  as test cases: missing `usage` events (subprocess crash before
  result), mixed-model invocations within one task (e.g. Opus plan +
  Haiku verify), and loop-back retry rollups (cost across all attempts
  of a phase, not just the last). Undercounts and double-counts are
  bugs, not "expected fuzziness."
- A new skill at `skills/pipeline/flow-status/SKILL.md` shells out to
  the CLI and renders the table inline in chat with a brief narrative
  summary.
- Both forms support `flow status <id>` to drill into one task.

### PR 11 — `/flow watch` skill

Done when:

- A new skill at `skills/pipeline/flow-watch/SKILL.md` is a thin Bash
  wrapper around `flow log <id> --follow` (PR 6) and pretty-prints
  recent events into the chat session.
- PR 11 adds the bound on watched output (default 30s or N events
  / lines) so long phases don't burn arbitrary chat-session tokens.
  The bound lives in the skill wrapper, not in `flow log` itself.
- Useful for in-chat spot checks; for terminal-focused observation,
  users invoke `flow log` directly.

### PR 12 — plan checkpoint (high-leverage human-in-loop)

Done when:

- For tasks with `intent: feature`, the pipeline pauses after plan
  with status `plan-pending-review` instead of advancing to implement.
- Two new skills land:
  - `/flow approve <id>` — clear the checkpoint flag, advance to
    implement.
  - `/flow revise <id>` — append user feedback to the task file's
    plan-revision-notes section, mark for re-plan.
- The checkpoint is the highest-leverage human-in-loop point: catching
  a wrong direction here costs tokens-of-plan; catching it after
  implement costs tokens-of-implement plus the time to redo.
- `intent` values other than `feature` (bug fix, docs, refactor) skip
  the checkpoint and flow straight through.
- The plan phase gains its own escape hatch: when the LLM detects a
  load-bearing ambiguity it cannot resolve from `task.md` alone, it
  exits to status `needs-human` with reason `plan-blocked` rather than
  silently picking a direction. The user resolves via `/flow revise`
  or by editing `task.md` and re-running `flow run <id>`. Without this,
  ambiguity is forced through to the checkpoint where the user pays
  full plan-token cost to discover the question.
- README and `/flow add` skill output make the wait behaviour explicit:
  until PR 17 ships notifications, a `plan-pending-review` task waits
  indefinitely for the user to return. This is intentional (user owns
  when to spend implement tokens) but must be surfaced — silence in
  chat shouldn't be confusable with progress.

## Phase 4 — cutover + parallelism (PRs 13–19)

`/flow add` becomes the documented entry point. Old `flow start` stays
available, then is removed once chat-first is the proven path.

### PR 13 — deprecate `flow start`

Done when:

- `flow start` prints a one-line stderr deprecation warning pointing at
  `/flow add` but otherwise behaves identically.
- README leads with the chat-first workflow:
  `/flow add "your prompt"` in any Claude Code session opened in the
  repo.
- `flow start` documentation moves to a "legacy CLI" section.

### PR 14 — `flow install --upgrade`

Done when:

- A single command per target repo idempotently re-symlinks every
  skill and script, removes orphans (paths previously listed in the
  managed `.gitignore` block but absent from the current source
  tree), and refreshes the managed `.gitignore` blocks.
- Running `flow install --upgrade` against a repo that has flow
  installed before this PR brings it fully forward to chat-first
  without manual intervention.
- Old in-flight tasks keep working — task.md schema is additive
  through Phase 1-3.

> Note: this PR does **not** pre-create `.orchestrator/logs/`. PR 1 ships
> per-task logs under `.orchestrator/tasks/<id>/logs/` and detached-run
> artifacts under `.orchestrator/runs/`, both created on demand. There
> is no consumer of a top-level `.orchestrator/logs/`. If a future
> consumer needs it, that consumer creates the directory itself.

### PR 15 — `flow run --all --max N` parallelism (shipped)

Done when:

- The runner is a worker pool: pulls `status: triaged` tasks from
  `.orchestrator/tasks/*.md` (needs-human-after-resume deferred to
  PR 16 — `/flow resume` is the natural home for resumable status
  support), spawns `flow run <id>` as a child per claimed task, and
  refills as children exit. Claim acquisition stays inside the child
  via PR 2's primitive — the scheduler only filters by status, spawns,
  and reaps.
- `--max N` bounds concurrency; tasks beyond N wait in queue. Default
  is `min(os.cpus().length, 4)` and the chosen value is logged on
  startup.
- `--watch` keeps the scheduler alive after the initial drain, polling
  `.orchestrator/tasks/` on a 5-second cadence (overridable via
  `--watch-interval <seconds>`).
- `--detach` re-execs the scheduler itself as a detached process tree,
  mirroring `flow run <id> --detach`.
- Each running task uses its own worktree → no working-tree conflicts.
- Two unrelated `/flow add` invocations followed by `flow run --all
  --max 2` results in two PRs both reaching merge concurrently.
- Two concurrent `flow run --all` invocations claim every task exactly
  once across the union (covered by the worker-pool race smoke test).

### PR 16 — pause / resume / abort

Done when:

- Three new skills land: `/flow pause <id>`, `/flow resume <id>`,
  `/flow abort <id>`.
- Pause drops a `.pause` flag in `.orchestrator/`; the runner checks
  the flag at phase boundaries (no mid-tool interruption) and exits
  cleanly with status `needs-human`, reason `user-paused`.
- Resume removes the flag and spawns `flow run <id> --detach`.
- Abort sets a terminal `aborted` status, closes the PR if open,
  removes the worktree, deletes the branch, and moves the task file
  to `.orchestrator/tasks/archive/`. Confirmation prompt before
  proceeding.

### PR 17 — macOS notifications (opt-in)

Done when:

- `terminal-notifier` (preferred) or `osascript` fires on phase
  boundaries that need the user's attention: `needs-human`, `gated`,
  `plan-pending-review`, `merged`, `aborted`.
- Phase-start spam is suppressed by default — only the interesting
  events fire.
- Opt-in via env var (e.g. `FLOW_NOTIFY=1`); default off so the
  feature doesn't surprise users on first install.

### PR 18 — remove `flow start` entirely

Done when:

- `flow start` is removed from the CLI; invoking it prints a redirect
  message pointing at `/flow add`.
- `flow install --upgrade` cleans up any lingering references in
  target-repo configs.
- The chat-first workflow has been the documented path for long enough
  that removal is safe (multiple weeks, ideally several real users).

### PR 19 — `flow tui` dashboard (optional, later)

**Optional, later — only if reached for.** Mission-control TUI for
parallel queues. Default mode of operation should not require it; if
`flow status` polling proves insufficient as parallel queues become
routine, this lands.

Done when:

- `flow tui` opens an Ink-based dashboard that polls
  `.orchestrator/tasks/*.md` and the jsonl logs.
- Lists all in-flight tasks with current phase + heartbeat.
- Attach to any task's log stream (calls into the same code path as
  `flow log <id> --follow`).
- Cost / status at a glance.

## Future stretch: state-store backend swap (Beads adapter)

When markdown plan files become painful (large queues, multi-machine,
dependency graphs across tasks) we swap in Steve Yegge's
[Beads](https://github.com/steveyegge/beads) behind a state-store
interface.

Done when:

- The state-store interface that markdown plan files implement is
  also implemented by a Beads adapter.
- A config flag selects which backend to use.
- Existing tasks readable on either backend (round-trip via `bd
  import`).

This is not in the Phase 1-4 plan. Revisit when there's a real volume
problem to solve.

## DX / cross-cutting backlog

Smaller items that aren't phase-blocking but should land when convenient:

- **Unit-test the worktree script's git interactions.** `templates/scripts/new-agent-worktree.ts`
  currently has tests only for `toDirSuffix` and `SYMLINK_FILES`. The interesting
  logic — `detectDefaultBranch`, `getPrimaryDir`, `preflight`'s validation flow —
  isn't covered. Two real bugs in this area (the `"HEAD"` fallback and the
  `validateRefName(baseBranch)` mismatch, fixed in PR #6) would have been caught
  by tests. Refactor to a `GitOps` injection point matching `pre-commit-checks.ts`'s
  pattern, then add coverage. Deferred from PR #6 review because the refactor
  warrants its own session (touches the worktree script's structure, not just
  the bug).

- **Unit-test the new CLI output helpers.** `src/commands/run.ts`'s
  `fetchPrUrl()` and `src/commands/start.ts`'s `printNextCommand()` /
  `listTaskMdFilenames()` (added in PR #8) are I/O wrappers with no
  coverage — the rest of `src/commands/*.ts` has none either. Real bugs
  tests would catch: the `execa` spawn-error path that crashes `flow run`
  (fixed in PR #8 review), non-deterministic file selection when multiple
  task files appear in one run (also fixed in PR #8 review), and frontmatter
  validation gaps. Deferred because it requires standing up `execa`/`fs`
  injection points across the commands layer — bar criterion (2): expands
  cross-cutting test infrastructure. Trigger: address opportunistically
  next time a `src/commands/*.ts` file is touched, or before the first
  command grows non-trivial branching logic.

- **Unit-test the new logger integration points in `runHeadless` and
  verify-gate.** `src/pipeline/headless.ts` ships the live stderr tee, the
  64 KB rolling tail, and the `buffer: { stderr: false }` execa flag added
  in PR #11; `src/pipeline/phases/verify-gate.ts` ships the
  `verify-gate.start` / `verify-gate.exit` event lines and the heartbeat
  wrapping. None of these are covered by tests today — phases pass
  `NoopLogger` implicitly. Bug the tests would catch: the tee regressing
  to silent, the rolling tail growing unbounded, the events not firing on
  the success or throw paths. Deferred from PR #11 review because adding
  them requires standing up a fake-execa harness that streams `data`
  chunks deterministically (bar criterion 2: needs new test
  infrastructure). Trigger: address opportunistically next time
  `headless.ts` or `verify-gate.ts` is touched, or before PR 5's verify
  retry-loop work begins (the new attempt-counting will be hard to verify
  without this harness).

- **Default `opts.logger` to `NoopLogger` in `runHeadless` /
  `runVerifyGate` to remove the `logger?.event(...)` noise.** PR #11
  threads the logger as `logger?: Logger` in `headless.ts` and
  `verify-gate.ts` (rather than `logger: Logger = NoopLogger` as in the
  pipeline runner and phases), which forces every event/heartbeat call
  to be guarded with `?.`. The two patterns are functionally equivalent
  but the explicit default reads cleaner and matches the rest of the
  pipeline. Deferred from PR #11 review because the change is purely
  cosmetic and touches every `logger?.event` call site across both
  files (bar criterion 2: cross-cutting refactor whose only payoff is
  reading nicer). Trigger: address opportunistically next time either
  file is touched for behavioural reasons.

- **Harmonize state machine naming across `chat-first-design.md` and
  `task-schema.md`.** The design doc's section 4 diagram uses
  descriptive names (`local-verifying`, `ci-wait`, `gating`) for
  readability; the schema enum uses canonical names (`verifying`,
  `ci`, `gated`). Pick one set and align both docs. The PR that
  touches this should also remove the explanatory callout added at
  the top of section 4 (it exists only to flag the divergence).
  Trigger: address opportunistically alongside PR 1 (jsonl phase
  names land) or PR 4 (ci-wait phase enum lands), whichever comes
  first.

- **Unit-test the install commands.** `src/install/scripts.ts` and
  `src/install/skills.ts` (added in PR #6) carry the symlink, gitignore, stale-test
  cleanup, and `git rm --cached` logic but have no automated tests — only the
  `applyManagedBlock` pure helper does. Coverage today is via manual synthetic-repo
  walk-throughs documented in PR #6's How-to-test. Real bugs the tests would catch:
  the `--force`-blocks-on-directory regression, the stale-companion-test deletion,
  the `--diff-filter=DT` untrack sweep, and the symlink replacement loop. Needs an
  `FsOps`/`GitCmd` injection point so tests can run without spawning real `git`.
  Deferred from PR #6 review because the refactor warrants its own session
  (introduces new abstractions to two install modules and their tests).

- **Customize the `mode: "fix"` prompt for fix semantics.** PR #16 ships
  `runImplementPhase`'s `mode: "fix"` reusing the create-mode prompt
  unchanged via `buildImplementPrompt` — so a fix invocation tells the LLM
  to invoke `/new-feature`, "implement the feature, write tests", "use
  `pr-description-draft.md` as the starting point for the PR body", and
  "write the final PR body … to `${bodyFilePath}`". None of those make
  sense when the LLM's job is to address a verify-gate or review failure
  against an already-open PR. No production caller of `mode: "fix"` ships
  in PR #16, so the misalignment is latent — but PR 5 (verify retry) and
  PR 7 (review loop-back) will hit it the moment they wire the caller. The
  fix is design-level: split `buildImplementPrompt` (or add a
  `buildFixPrompt` sibling) so fix mode invokes the appropriate skill
  (likely `/pr-review` or a focused fix prompt) and drops the PR-body
  write instruction. Deferred from PR #16 review because picking the
  right skill / prompt shape is intrinsically tied to PR 5 and PR 7's
  caller contracts (bar criterion 1: design decision exceeds "address
  this review"; bar criterion 2: rewrites a non-trivial component shared
  with create mode). Trigger: address as part of PR 5 when the first
  `mode: "fix"` caller lands — do not ship that PR with the create-mode
  prompt still being used for fix mode.

- **Integration test for `startCommand`'s sentinel env-var plumbing.**
  PR #22 added `triage-sentinel.ts` with unit tests, but `startCommand`
  itself has no test that the `FLOW_TRIAGE_TASK_ID_FILE` env var is
  actually plumbed into the spawned `claude` subprocess and that the
  read-on-success path uses the same sentinel. A future refactor of
  `start.ts` could regress the wiring and the helper unit tests would
  not catch it; the only signal would be the manual concurrent-sessions
  validation step. Deferred from PR #22 review because covering it
  requires either standing up an `execa` injection point in
  `src/commands/start.ts` (cross-cutting test-infrastructure refactor —
  bar criterion 2) or adding a fake-`claude` shim on PATH for a smoke
  test (new test infrastructure). Trigger: address when `src/commands/start.ts`
  is next touched, or fold into the broader "Unit-test the new CLI output
  helpers" item above (which already covers `start.ts` injection points).

- **Unit-test `runAllCommand`'s SIGINT escalation, watch-loop, and pid
  lifecycle.** PR #32 ships the `flow run --all` command with unit
  coverage on its three pure dependencies (`listTriagedTasks`,
  `drain`, `createRunAllLogger`) plus a `RUN_INTEGRATION=1` smoke test
  that asserts claim-race correctness across two concurrent schedulers.
  The orchestrating function in `src/commands/run-all.ts` itself —
  two-step SIGINT escalation timing, watch-loop refill cadence, the
  detached-child pid-file lifecycle, the malformed-task-file
  forwarding to `logger.warn`, and the abort-during-full-pool path —
  has no unit coverage. Real bugs the tests would catch: a regression
  that drops the second-SIGINT escalation, a watch-mode hang when the
  abort signal fires during the poll sleep, the new pid-cleanup path
  silently failing on a permissions error. Deferred from PR #32
  review because covering it requires standing up a fake-spawn / fake-
  signal / fake-timer harness for a `process.exit`-calling command
  (bar criterion 2: needs new test infrastructure shared with
  `runCommand`'s equivalent gap). Trigger: address opportunistically
  next time `run-all.ts` or `run.ts` is touched, or fold into the
  broader "Unit-test the new CLI output helpers" item above.

## What's deliberately not on the roadmap

- A web UI, dashboard, or status server. (`flow tui` in PR 19 is a
  local terminal UI, not a server.)
- Slack / email notifications. (macOS desktop notifications land in
  PR 17, opt-in.)
- Cross-repo coordination. flow operates on one repo at a time.
- Cross-machine pipelines. The design assumes the user, chat session,
  repo, and pipeline live on one machine. There is no path for
  starting a pipeline on a laptop and checking status from a phone —
  status is read from the local `.orchestrator/` tree. This is a
  deliberate consequence of the no-daemon, no-server stance.
- Custom Claude Code skills bundled into the user's chat session that
  outlive flow's lifecycle. The skills flow ships are pipeline-scoped
  (`/flow add`, `/flow status`, etc.); the underlying domain skills
  (`/product-planning`, `/new-feature`, `/verify`, `/pr-review`) live
  in the target repo.
