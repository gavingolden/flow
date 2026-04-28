# Roadmap

Each milestone is independently usable: at the end of each, `flow` does
something more end-to-end than it did before. We do not ship internal
abstractions ahead of the milestone that needs them.

## Status table

| M | Adds | Status | Doc |
|---|---|---|---|
| **M1** | Phase 0 (triage) + CLI scaffold | **shipped** | `phases/triage.md` |
| **M2** | Phases 1–3 (plan, worktree, implement), single task | **shipped** | `phases/m2-plan.md`, `phases/{plan,worktree,implement}.md` |
| **M3** | Phases 4–6 (verify, ci, review) with bounded retry loops | **next** | `phases/m3-plan.md` (TBD) |
| **M4** | Phases 7–8 (gate, merge) + manual-validation parser | planned | `phases/m4-plan.md` (TBD) |
| **M5** | Multi-task queue + `--all --max N` parallelism | planned | — |
| **M6** | Beads adapter behind the state interface (stretch) | planned | — |

## Milestone done-criteria

### M1 — triage + scaffold (shipped)

Done when:

- `flow start "<prompt>"` opens an interactive Claude Code session in the
  surrounding git repo with the triage system prompt appended.
- For a no-change request, the session answers in-line and exits without
  writing a file.
- For a change request, the session writes `.orchestrator/tasks/<id>.md`
  conforming to `docs/task-schema.md` and exits.

### M2 — plan / worktree / implement (shipped)

Done when:

- `flow run [<task-id>]` reads a `triaged` task and runs phases 1–3
  sequentially.
- After phase 1 (plan), the task file has populated `plan` outputs
  (PRD, breakdown, PR draft path).
- After phase 2 (worktree), the task file has `worktree` and `branch`
  populated and the worktree exists on disk.
- After phase 3 (implement), the task has `pr` populated (number) and
  the PR exists on GitHub with the implementation committed and the
  `Manual validation` section in the body.
- A flow run on a `triaged` task with no human in between produces an
  open PR with code changes and tests.

The exit status of `flow run` is non-zero on any phase failure or
`needs-human` outcome, with the failing phase's reason printed.

### M3 — verify / ci / review

**Pipeline shape:**

```
pr-open → verifying → ci → reviewing → (gated | needs-human | loop-back)
```

Two cross-phase loops: red CI → implement, and review critical → implement.
Both target `implement`, not `verify` — verify only knows whether the local
test command exits 0, so looping it on red CI or critical review can never
fix the underlying problem; only the LLM that wrote the code can.

**Phase 3 amendment carried into M3.** The implement phase should run
`/verify` locally and confirm it exits 0 *before* `gh pr create`, so PRs
open already-green. As shipped in M2, phase 3 opens the PR before any
verify happens; every phase-4 retry then pushes commits that re-fire CI
and partly burn phase 5's budget before phase 5 formally starts. Move the
local-verify gate inside phase 3. `pr-open` still means "PR exists" — the
new invariant is "and the local test suite passed against the pushed SHA".

Done when:

- **Phase 4 (verify)** runs `/verify` in the worktree. On failure, in-place
  retry up to 3x with the failure log appended to the next attempt's
  prompt (truncated to the last ~200 lines plus lines matching
  `error|fail|panic`, to bound prompt growth). On exhaustion, escalate to
  `needs-human` with the final failure log surfaced.

- **Phase 5 (ci)** polls `gh pr checks` until every check reaches terminal
  state (`success` | `failure` | `cancelled` | `skipped` | `neutral`;
  `failure` and `cancelled` count as red). Polling is custom (not
  `gh pr checks --watch`) so it survives `flow run` crashes — re-querying
  is idempotent. Cadence 30s; hard timeout 60 min; status `ci` persists
  across invocations. On red, loop back to **implement** (not verify) with
  the failing checks' logs appended to the implement prompt. Cap 3
  ci→implement cycles.

- **Phase 5 also absorbs the auto-reviewer wait.** Before declaring CI
  terminal, wait up to a configurable timeout (default 5 min) for reviews
  from a configurable list of bot logins (default `["Copilot"]`; users can
  add Codecov, SonarCloud, custom apps). Their findings enter phase 6 as
  second-opinion artefacts. This replaces the earlier sketch where the
  poll lived in phase 6 hard-coded to Copilot — the wait is a CI-adjacent
  external signal and belongs alongside the rest of the GitHub-state
  collection. Today's behaviour ("review races whatever Copilot has
  finished") is too dependent on wall-clock luck.

- **Phase 6 (review)** invokes `/pr-review` against the PR. Findings post
  as **inline review comments**, not formal GitHub reviews (see the user's
  `feedback_pr_review_comment_style` rule). "Critical" = `/pr-review`'s
  top-tier confidence label; the exact mapping is fixed in
  `phases/m3-plan.md`. Critical findings loop back to **implement**, cap
  2 cycles. Authentication uses the user's `gh` auth — bot-identity
  separation is out of scope for M3.

- **Implement re-entry on loop-back.** `runImplementPhase`'s
  `task.pr != null` short-circuit (`src/pipeline/phases/implement.ts`)
  must be relaxed when entering from a ci or review loop. Pass an explicit
  `mode: "create" | "fix"` to the phase rather than inferring from status
  — `mode: "fix"` re-runs the LLM with the failure context against the
  existing PR's branch.

- **Retry helper generalised.** `src/pipeline/retry.ts`'s `retryOnce` is
  hard-coded to two attempts. M3 needs three for verify and configurable
  caps for the loops. Replace with `retryN(fn, n)` and migrate phase 3.

- **Cross-phase retry budgets are explicit.** Every phase records its
  total invocation count on the task file. Inner counters reset per outer
  cycle (so `review → implement → verify` gets a fresh verify budget),
  but per-task hard ceilings cap total work — verify ≤ 6, implement ≤ 4,
  ci ≤ 6 across the whole task lifetime. `needs-human` reasons print the
  per-phase counts so it's obvious why we stopped.

- **Flake recording.** When verify or CI passes after one or more retries,
  the task file logs e.g. `verify: 2/3 passed (1 retry — suspected flake)`.
  No automated remediation; just visibility for follow-up.

- **M2 deferred tests land here.** Unit tests for `runner.ts`'s
  state-machine dispatch, `task-file.ts`'s `## Progress` regeneration,
  the `retryN` helper, and the new ci/review loop accounting. M2
  explicitly deferred these (`docs/phases/m2-plan.md`); M3 is the catch-up.

- **End-to-end criteria.** A flow run on a `triaged` task with a clean
  change reaches `gated` (M4 takes over). A flow run with a deliberately
  broken local test escalates to `needs-human` after verify exhausts. A
  flow run with a CI-only failure escalates after ci→implement cap with
  the CI log surfaced.

**Open questions to resolve in `phases/m3-plan.md` before implementation:**

- Exact mapping of `/pr-review` confidence labels → "critical".
- `needs-human` resume semantics: does the user edit `status:` and rerun,
  or does flow grow a `flow resume <id>` command? Issue exists in M2 but
  becomes more frequent in M3.
- Rebase policy. Between phase 3 and phase 5 `main` may move; CI runs
  against the merge base captured at push. Default `auto_rebase: false`
  for M3, revisit if it bites.

**Deliberately out of scope for M3:**

- Bot-identity / separate `gh` auth for review comments (use the user's).
- LLM-driven CI-log summarisation (start with truncation; promote if
  truncation proves insufficient).
- Cross-task retry-budget sharing (budgets are per-task only).

### M4 — gate / merge

Done when:

- The implement phase populates the PR description's `## Manual validation`
  section based on heuristics (DB migration, external API, UI change → fill;
  pure refactor / docs → leave empty).
- Phase 7 (gate) reads the PR body, strips HTML comments from the section,
  and decides: empty → proceed; non-empty → set status `gated`, exit
  `needs-human`.
- Phase 8 (merge) runs `gh pr merge --squash --delete-branch` and removes
  the worktree via the target repo's `remove-agent-worktree.ts`.
- An end-to-end run with no manual validation needed reaches `merged`
  without human intervention.

### M5 — multi-task queue / parallelism

Done when:

- `flow run --all` picks up every `triaged` task in `.orchestrator/tasks/`
  and runs them.
- `--max N` bounds concurrency; tasks beyond N wait in queue.
- A `flow run next` (or `flow run --next`) shorthand picks up the
  oldest `triaged` task and runs it — equivalent to `--all --max 1`
  but ergonomic for sequential workflows.
- The runner has a cross-process claim primitive (compare-and-set on
  frontmatter `status: triaged → planning`, or rename-based file lock)
  so two concurrent invocations cannot pick up the same task. The
  in-memory lock in `runner.ts` only protects within one process —
  M5 must extend it across processes before queue mode is safe.
- Each running task uses its own worktree → no file conflicts.
- Two unrelated `flow start` invocations followed by `flow run --all --max 2`
  results in two PRs both reaching merge concurrently.

### M6 — Beads adapter (stretch)

Done when:

- The state-store interface that markdown plan files implement is also
  implemented by a Beads adapter.
- A config flag selects which backend to use.
- Existing tasks readable on either backend (round-trip via `bd import`).

## DX / cross-cutting backlog

Smaller items that aren't milestone-blocking but should land when convenient:

- **Unit-test the worktree script's git interactions.** `templates/scripts/new-agent-worktree.ts`
  currently has tests only for `toDirSuffix` and `SYMLINK_FILES`. The interesting
  logic — `detectDefaultBranch`, `getPrimaryDir`, `preflight`'s validation flow —
  isn't covered. Two real bugs in this area (the `"HEAD"` fallback and the
  `validateRefName(baseBranch)` mismatch, fixed in PR #6) would have been caught
  by tests. Refactor to a `GitOps` injection point matching `pre-commit-checks.ts`'s
  pattern, then add coverage. Deferred from PR #6 review because the refactor
  warrants its own session (touches the worktree script's structure, not just
  the bug).

## What's deliberately not on the roadmap

- A web UI, dashboard, or status server.
- Slack / email / desktop notifications. (Stdout + `task.md` updates are
  the notification surface for the foreseeable future.)
- Custom Claude Code skills shipped from `flow`. The only skill flow
  contributes is the triage system prompt, and that travels via
  `--append-system-prompt`. All other skills live in the target repo.
- Cross-repo coordination. `flow` operates on one repo at a time.
