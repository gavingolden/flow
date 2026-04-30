---
name: flow-abort
description: >-
  Tear down a flow task: close its PR, remove the worktree and branch,
  archive the task file. Destructive — collects an interactive
  confirmation listing the planned actions before invoking `flow abort
  <id> --confirm`. Use ONLY when the user explicitly invokes
  `/flow-abort <id>` or says "abort `<id>`" / "kill `<id>`" / "scrap
  `<id>`" with a task-id present. Do NOT auto-trigger on broad abort
  phrasing ("abort", "scrap that", "nevermind") without a task-id —
  that hijacks unrelated chats.
argument-hint: '<task-id>'
---

# Goal

Cleanly tear down a task the user has decided not to pursue. Closes
the PR (if open), removes the worktree and branch via the existing
`remove-agent-worktree.ts` helper, moves `task.md` into
`.orchestrator/tasks/archive/`, and marks status `aborted`. This
skill collects an interactive confirmation listing the specific
destructive actions, then shells out to `flow abort <id> --confirm`.

# When to Use

- The user explicitly invokes `/flow-abort <id>`.
- The user says "abort `<id>`", "kill `<id>`", "scrap `<id>`", "drop
  `<id>`" — anything that names a specific task and signals "tear
  this down."

# When NOT to Use

- The user said "abort" / "scrap that" / "nevermind" *without* a
  task id. Those phrases occur constantly in non-flow contexts; ask
  which task before invoking. Aborting the wrong task is
  hard-to-reverse — re-creating a worktree and re-opening a PR is
  the ask.
- The user just wants to *pause* (e.g. switching machines, refining
  `task.md`) → that's `/flow-pause`, which is non-destructive.
- The task is already at `merged` or `aborted`. The CLI rejects with
  `cannot abort task at terminal status <status>` — surface verbatim.

# Constraints / What NOT to do

- NEVER invoke `flow abort` without first confirming via
  `AskUserQuestion`. The CLI requires `--confirm`; the skill is the
  layer that collects an *informed* yes (PR number, worktree path,
  branch, archive destination) before forwarding the flag.
- NEVER pass `--confirm` to the CLI without an explicit "yes" from
  the user in this session. Treating prior approvals from earlier
  conversations as carry-over consent is the same footgun the
  destructive-action policy in `AGENTS.md` warns against.
- NEVER `gh pr close` / `git worktree remove` / `mv task.md`
  manually as a "fast path." The CLI's ordering (status transition
  first, cleanup steps best-effort, archive last) is what guarantees
  a half-failed abort still leaves the task in the right terminal
  state.

# Instructions

## 1. Confirm the task-id

The skill argument is `<task-id>`. If the user's message includes a
task-id (e.g. `2026-04-30-my-feature`), use it. If not, ask once:
"Which task would you like to abort?" — do not guess from the most
recent `/flow-status` output.

## 2. Read the task to enumerate the destructive actions

Use `Bash` to read the relevant frontmatter fields (a quick
`flow status <id>` works, or `head -20 .orchestrator/tasks/<id>.md`):

- `pr` — the PR number that will be closed (or "(none)" if null).
- `worktree` — the directory that will be removed (or "(none)").
- `branch` — the branch that will be deleted (or "(none)").
- The archive destination is always
  `.orchestrator/tasks/archive/<id>.md`.

## 3. Collect explicit confirmation via AskUserQuestion

Use the `AskUserQuestion` tool to enumerate exactly what abort will
do. Keep the wording specific — naming the PR number, worktree
path, branch, and archive destination is what makes this an
*informed* yes:

```
Abort task <id>? This will:
  - Close PR #<n> (if open)
  - Remove worktree at <path>
  - Delete branch <branch>
  - Archive task.md to .orchestrator/tasks/archive/<id>.md

Proceed?
```

Offer two options: "Yes, abort" and "No, cancel."

## 4. On "yes": shell out to the CLI

Invoke via `Bash`:

```bash
flow abort <id> --confirm
```

Forward the CLI's stdout verbatim into chat. The CLI prints a
structured per-step summary (one line per step, with `WARN:` on any
that didn't succeed). Do not paraphrase, summarise, or truncate.

## 5. On "no": print "Aborted (no changes made)." and exit

If the user picked "No, cancel" (or any non-yes response), do not
invoke the CLI. Print:

```
Aborted (no changes made).
```

— and stop.

# Verification

- The CLI exited 0 (or stdout includes the per-step summary even if
  one step printed `WARN:`). Best-effort cleanup is a feature, not a
  failure.
- The chat received the `aborted <id>:` header and at least one of
  the `- PR / Worktree / Archived` lines.
- The user's confirmation answer was explicit "yes" — never silently
  pass `--confirm` without it.

# Constraints (repeat for emphasis)

- **You do not write code in this skill.** Abort is a one-line CLI
  call after the confirmation prompt; the CLI does the work.
- **You do not bypass the CLI.** The Phase-log entry, the status
  transition, the worktree/branch removal, and the archive move all
  happen inside `flow abort`; running the steps by hand drops the
  Phase-log row and leaves the task in an inconsistent state if any
  step fails partway through.
