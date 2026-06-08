# `task.md` schema

The cross-phase data contract. Every phase reads this file, does its
work, and writes its outputs back into it. The next phase reads the
same file. There is no other state.

## Location

```
<target-repo>/.orchestrator/
├── tasks/
│   ├── <id>.md          ← active tasks live here
│   └── archive/
│       └── <id>.md      ← terminal tasks (merged, aborted) move here
```

`<target-repo>` is the git repo the user is working in (the value of
`git rev-parse --show-toplevel` at the time `flow start` was run).
`.orchestrator/` is created lazily and should be added to that repo's
`.gitignore`.

**Filenames never change.** A task's `<id>` is fixed at creation and
keeps its `.md` filename through the entire lifecycle. Completion is
expressed by:

1. The `status` frontmatter field reaching a terminal value (`merged`
   or `aborted`).
2. The file moving from `tasks/` to `tasks/archive/`.

The directory move is an index optimisation — `glob("tasks/*.md")`
gives "active tasks" without filtering, and `tasks/archive/*.md` gives
history. Read helpers should look up `<id>` in both directories so
`flow status <id>` keeps working after archival.

The merge phase (M4) performs the move when it sets `status: merged`.
`flow abort` (M5+) does the same when setting `status: aborted`.

## Filename / id

`<id>` is `YYYY-MM-DD-<kebab-slug>` — today's UTC date plus a 3–5 word
slug derived from the user's prompt. Example:
`2026-04-27-add-portfolio-chart`.

The id appears both as the filename and inside the frontmatter; they
must match.

## Frontmatter

```yaml
---
id: 2026-04-27-add-portfolio-chart
status: implementing
created: 2026-04-27T10:30:00Z
updated: 2026-04-27T10:45:00Z
target_repo: /Users/gavin/code/me/econ-data
worktree: /Users/gavin/code/me/econ-data-add-portfolio-chart
branch: gavin/add-portfolio-chart
pr: 184
test_steps: false
merge_commit: null
---
```

| Field           | Type                    | Set by                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ----------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | string                  | triage                       | Matches filename (without `.md`).                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `status`        | enum                    | every phase that transitions | See state machine below.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `created`       | ISO-8601 UTC            | triage                       | Immutable after creation.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `updated`       | ISO-8601 UTC            | every phase                  | Set on every write.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `target_repo`   | absolute path           | triage                       | The git repo `flow start` was run in. Canonicalised to the _primary_ worktree, so a `flow start` from inside a child worktree still anchors the new task to the main repo's `.orchestrator/`.                                                                                                                                                                                                                                                                                          |
| `worktree`      | absolute path \| `null` | worktree phase               | Created in M2. Null until phase 2 runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `branch`        | string \| `null`        | worktree phase               | Branch name created in the target repo.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pr`            | integer \| `null`       | implement phase              | GitHub PR number. Null until phase 3 opens it.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `test_steps`    | bool \| `null`          | gate phase                   | True if the PR's "Test Steps" section is non-empty. Null before the gate runs.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `merge_commit`  | string \| `null`        | merge phase                  | SHA of the squash-merge commit on the base branch. Hard to recover after the fact (branch deleted, PR squashed) so we capture it explicitly. Null until M4's merge phase runs.                                                                                                                                                                                                                                                                                                         |
| `review_cycles` | integer \| `null`       | review phase                 | Number of review→implement(fix) loop-backs that completed successfully (i.e. `implement(fix)` returned ok). Null until review runs the first time, then 0; increments only after a successful fix, so a failed fix does not consume budget and resume re-runs the same cycle. Capped at 2; reaching the cap with critical-code findings still present escalates to `needs-human (review-cycles-exhausted)`. Persists across crashes so resume-mid-loop continues from the right cycle. |

Add new fields freely as later phases need them, but keep the schema
backward-compatible: existing readers must not crash on missing fields.

## Discoverability — where to look for what

The frontmatter holds **structured pointers** an agent can grep
without parsing prose. The body holds **rich content** that varies
per phase. Agents looking for information should consult them in this
order:

| Looking for                        | Look here                                                |
| ---------------------------------- | -------------------------------------------------------- |
| PR number                          | `frontmatter.pr`                                         |
| Merge commit SHA                   | `frontmatter.merge_commit`                               |
| Branch / worktree path             | `frontmatter.branch`, `frontmatter.worktree`             |
| Current state in pipeline          | `frontmatter.status` (machine) or `## Progress` (visual) |
| State transition history           | `## Phase log` (timestamped audit)                       |
| Files changed, tests added         | `## Phase outputs > implement`                           |
| Test results, lint state           | `## Phase outputs > verify`                              |
| CI run IDs and outcomes            | `## Phase outputs > ci`                                  |
| Review findings / replies          | `## Phase outputs > review`                              |
| PRD, task breakdown, PR draft path | `## Phase outputs > plan`                                |

GitHub URLs are deliberately not stored — they're derivable from
`frontmatter.pr` plus the target repo's remote (one `gh repo view --json
nameWithOwner` call) and storing both numbers and URLs invites drift.

## Status state machine

```
   triaged ──► creating-worktree ──► worktree-ready ──► planning ──► planned
                                                                       │
                                                                       ▼
                                                                 implementing
                                                                       │
                                                                       ▼
                                                                    pr-open
                                                                       │
                                                                       ▼
                                                                   verifying
                                                                       │
                                                                       ▼
                                                                       ci
                                                                       │
                                                                       ▼
                                                                   reviewing
                                                                       │
                                                                       ▼
                                                                    gating
                                                                       │
                              ┌────────────────────────────────────────┤
                              ▼                                        ▼
                   gated  (test_steps = true)         merging  (test_steps = false)
                              │                                        │
                              ▼ (user merges PR; flow run resumes)     │
                           merging                                     │
                              │                                        │
                              └────────────────────┬───────────────────┘
                                                   ▼
                                                merged  ──► (terminal)

   any state ──► aborted   (terminal — user-initiated or unrecoverable)
   any state ──► needs-human  (transient — pipeline pauses, user resumes)
```

The `triaged → creating-worktree` edge is the post-triage entry: the
worktree phase runs _before_ plan so every later phase can execute
inside a per-task worktree, enabling concurrent `flow run` invocations
against the same target repo.

The script's phase scheduler reads `status` to decide where to resume
when `flow run` is called on an existing task. Phases set the status
to their target before running so an interrupted phase resumes from
its own start, not the previous phase's end.

## Body sections

### `## User prompt`

The verbatim text the user passed to `flow start`. Never rewritten.

### `## Triage`

```
- intent: feature | bug | refactor | docs | infra | chore
- summary: <one-line reading hook for downstream phases>
```

### `## Clarifications`

Bulleted Q/A pairs in short form, or a brief prose summary of what
was settled in the triage conversation. The plan phase reads this to
build the PRD.

### `## Constraints / out of scope`

Items the user excluded or that are deferred to a later task. Use this
to fight scope creep during implementation. If none, the section says
`nothing flagged`.

### `## Open questions`

Anything still unresolved that downstream phases will need to decide.
The plan phase converts these into ADRs or carries them into the PRD
as Open Questions. If none, `none`.

### `## Progress`

A visual mirror of the `status` field, rendered as GitHub-flavoured
markdown checkboxes. Generated deterministically from `status` plus
the canonical phase order:

```
## Progress

- [x] triage
- [ ] plan
- [ ] worktree
- [ ] implement
- [ ] verify
- [ ] ci
- [ ] review
- [ ] gate
- [ ] merge
```

Rules:

- A phase is `[x]` if its target status (or any later status) has been
  reached. Examples: status `planned` → triage and plan are checked;
  status `pr-open` → triage, plan, worktree, implement are checked.
- The runner regenerates this section on every `writeTask()` from
  `status`; agents should not edit it by hand. The frontmatter
  `status` is the source of truth — drift between the two is a bug
  in the writer, not a state to be reconciled.
- The triage agent writes the initial state (only triage checked) when
  it creates the file.
- Sub-phase progress (e.g., "implement is 3/5 files in") is not
  captured here. Phases are atomic from the orchestrator's perspective.

### `## Phase log`

Append-only audit trail of phase events. Each line is either a
transition or a single-phase event:

```
- <ISO-8601 UTC> <from> → <to> (<note>)     # transition between phases
- <ISO-8601 UTC> <phase> <event> (<note>)   # event inside one phase
```

The note is optional — useful for retry attempts (`(retry 2/3)`) or
failure messages. The very first entry is typically `triage complete`,
written by the triage agent when it finishes the file. Transitions
start appearing once the runner takes over.

### `## Phase outputs`

Per-phase scratchpad. One subsection per phase, in execution order.
Phases overwrite their own subsection on retry; they do not delete
other phases' subsections.

```
### plan (latest: 2026-04-27T10:35:00Z, ok)
- PRD: docs link or inline content
- Tasks: bulleted list as designed in /product-planning
- PR draft: pr-description-draft.md path

### implement (latest: 2026-04-27T10:45:00Z, ok)
- Files changed: src/lib/domain/dashboard/portfolio-chart.svelte, …
- Tests added: 4
- PR: #184
- Test Steps flagged: yes (UI change)

### verify
- 1230/1230 PASS, lint clean

### review (latest: 2026-04-30T01:30:12Z)
- cycle 1 (2026-04-30T01:23:45Z): summary "<one-line>"
  - critical (code): src/foo.ts:42 — <subject>
  - minor: src/bar.ts:73 — <subject>
- cycle 2 (2026-04-30T01:30:12Z): summary "<one-line>"
  - critical (code): src/foo.ts:42 — <subject> (still flagged)
- decision: needs-human (review-cycles-exhausted)
- JSON: <task-dir>/review/result-2.json
```

Subsections may carry whatever structured data the phase needs to
hand off to the next one. Keep it grep-able.

The `review` subsection is special: it re-renders on every cycle so the
full history of review runs (and the final decision line) stays visible.
On a resume after a mid-loop crash, the review phase rehydrates prior
cycles by reading the per-cycle JSON files at
`<task-dir>/review/result-<i>.json` so the rendered history survives the
restart. Decision is one of `clean — advancing`,
`needs-human (architectural-concern)`, or
`needs-human (review-cycles-exhausted)`.

## Read/write conventions

- **Read:** parse with `gray-matter`. Frontmatter → typed object;
  body → string. Sections are not parsed individually unless the
  phase actually needs to consume one.
- **Write:** rewrite the whole file with `gray-matter.stringify`.
  Always update `updated`. Never edit in place with regex on a
  partial section — rebuild and rewrite.
- **Concurrency:** one phase touches a task at a time. The runner
  enforces this via an in-memory lock per task id. No filesystem
  locks needed.
