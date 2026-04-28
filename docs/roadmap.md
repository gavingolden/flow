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

Done when:

- After phase 4 (verify), tests run in the worktree and the task carries
  pass/fail status. On failure, retry up to 3x; on exhaustion, escalate
  to `needs-human`.
- After phase 5 (ci), `flow` watches `gh pr checks` until terminal.
  On red CI, loop back to verify with the failure log appended; cap 3.
- After phase 6 (review), the `pr-review` skill has run against the PR
  and replied to comments. Critical findings loop back to implement,
  capped at 2 cycles.
- Phase 6 polls `gh api repos/:o/:r/pulls/<n>/reviews` for a review by
  GitHub Copilot before invoking `/pr-review`, with a configurable
  timeout (default 5 min). If Copilot finishes in time, its findings
  are visible to our review as a second-opinion artefact; if not, we
  proceed without them. Today's behaviour ("review races whatever
  Copilot has finished") is too dependent on wall-clock luck.

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

- **`flow install-skills` manages `.gitignore` for the symlinks it creates.**
  The symlinks resolve to absolute paths under the user's home and aren't
  portable across machines, so they shouldn't be committed. The command
  should append (and idempotently rewrite) a marked block to the target
  repo's `.gitignore` — e.g. `# managed by flow install-skills` … `# end
  flow` — listing each symlinked skill name. Hand-rolled skills sitting
  alongside under different names stay tracked.

## What's deliberately not on the roadmap

- A web UI, dashboard, or status server.
- Slack / email / desktop notifications. (Stdout + `task.md` updates are
  the notification surface for the foreseeable future.)
- Custom Claude Code skills shipped from `flow`. The only skill flow
  contributes is the triage system prompt, and that travels via
  `--append-system-prompt`. All other skills live in the target repo.
- Cross-repo coordination. `flow` operates on one repo at a time.
