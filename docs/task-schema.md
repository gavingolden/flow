# `task.md` schema

The cross-phase data contract. Every phase reads this file, does its
work, and writes its outputs back into it. The next phase reads the
same file. There is no other state.

## Location

```
<target-repo>/.orchestrator/tasks/<id>.md
```

`<target-repo>` is the git repo the user is working in (the value of
`git rev-parse --show-toplevel` at the time `flow start` was run).
`.orchestrator/` is created lazily and should be added to that repo's
`.gitignore`.

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
manual_validation: false
---
```

| Field | Type | Set by | Notes |
|---|---|---|---|
| `id` | string | triage | Matches filename (without `.md`). |
| `status` | enum | every phase that transitions | See state machine below. |
| `created` | ISO-8601 UTC | triage | Immutable after creation. |
| `updated` | ISO-8601 UTC | every phase | Set on every write. |
| `target_repo` | absolute path | triage | The git repo `flow start` was run in. |
| `worktree` | absolute path \| `null` | worktree phase | Created in M2. Null until phase 2 runs. |
| `branch` | string \| `null` | worktree phase | Branch name created in the target repo. |
| `pr` | integer \| `null` | implement phase | GitHub PR number. Null until phase 3 opens it. |
| `manual_validation` | bool \| `null` | gate phase | True if the PR's "Manual validation" section is non-empty. Null before the gate runs. |

Add new fields freely as later phases need them, but keep the schema
backward-compatible: existing readers must not crash on missing fields.

## Status state machine

```
   triaged ──► planning ──► implementing ──► verifying ──► ci
                                                              │
                                                              ▼
                                                          reviewing
                                                              │
                                                              ▼
                          gated  (if manual_validation = true)
                            │
                            ▼
                          merged  ──► (terminal)

   any state ──► aborted   (terminal — user-initiated or unrecoverable)
   any state ──► needs-human  (transient — pipeline pauses, user resumes)
```

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

### `## Phase log`

Append-only audit trail of phase transitions. Each line:

```
- <ISO-8601 UTC> <from> → <to> (<note>)
```

The note is optional — useful for retry attempts (`(retry 2/3)`) or
failure messages.

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
- Manual validation flagged: yes (UI change)

### verify
- 1230/1230 PASS, lint clean
```

Subsections may carry whatever structured data the phase needs to
hand off to the next one. Keep it grep-able.

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
