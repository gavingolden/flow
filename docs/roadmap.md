# Roadmap

## Architectural shift — tmux as the interface

flow is being **radically simplified** by adopting Design B from
[`alternate-architecture.md`](./alternate-architecture.md): tmux
windows replace the orchestrator as the pipeline driver and interface.

The bet: the **automation core** (auto-progression, walk-away
execution, parallel pipelines) is what carries the value. The
**interface layer** (CLI verbs, `.orchestrator/` state directory,
custom watch tools, gate phase) is what carries the cost. tmux
windows already provide every interface affordance the orchestrator
reinvents — scrollback (logs), window list (status), attach
(drilldown), detach (walk away), interactive prompt (approval).

In the new design, **one tmux window per pipeline; one long-running
Claude Code chat session inside each window runs the full pipeline by
following a single supervisor skill (`/flow-pipeline`).** The agent
decides when to call `/product-planning`, when to spawn the worktree,
when to call `/new-feature`, when to sleep + poll Copilot, when to
call `/pr-review`, and whether to auto-merge. flow shrinks to a thin
shell wrapper (`flow new`, `flow ls`, `flow attach`, `flow done`,
`flow setup`, `flow migrate`) plus the new supervisor skill.

Net code deletion: ~70-80% of the current TypeScript surface. The
existing high-quality skills (`/product-planning`, `/new-feature`,
`/verify`, `/pr-review`) are kept as-is or with minor amendments.

A second simplification rides along: **flow installs globally under
`~/.claude/`** rather than per-repo. No more `flow install` in each
consumer repo, no managed `.gitignore` blocks, no per-repo symlinks
for core flow. The single named exception is stack skills (svelte,
supabase, tailwind-shadcn) under option B — see "Stack skills" in the
Installation UX section; those are scoped per-project on purpose so
they don't pollute every repo's skill resolution.

See [`alternate-architecture.md`](./alternate-architecture.md) for the
full reasoning behind picking Design B over Designs A (GitHub-native)
and C (Claude Code supervisor session).

## End-state shape

| Component | Today (orchestrator) | Tomorrow (tmux) |
|---|---|---|
| Pipeline driver | `src/pipeline/runner.ts` + 8 phase modules in Node | `/flow-pipeline` skill followed by Claude Code inside one tmux window |
| State store | `.orchestrator/tasks/<id>.md` + jsonl logs + locks + archive | tmux window scrollback + the PR + the worktree on disk |
| Status surface | `flow status` reads task files | `flow ls` parses `tmux list-windows` |
| Drill-in | `flow log <id> --follow` | `tmux attach -t flow:<name>` |
| Approval | `/flow-approve <id>` skill | Type into the tmux window's chat |
| Mid-flight redirect | `/flow-revise <id>` skill | Type into the tmux window's chat |
| Parallelism | Worker pool (`flow run --all --max N`) | Multiple tmux windows; the OS schedules them |
| Distribution | `flow install` per-repo symlinks | `flow setup` once globally — symlinks to `~/.claude/skills/`, `~/.claude/agents/`, `~/.local/bin/`. Zero per-repo footprint. |

## Status table

| Block | Adds | Status |
|---|---|---|
| **Old orchestrator (Phases 1–4 PRs 13–17)** | Full Node-based pipeline, chat-first entry, parallelism, notifications | **shipped — being deprecated.** History preserved in this file's "Old roadmap" appendix. |
| **PR 1 — global install + shell wrapper** | `flow setup`, `flow new`, `flow ls`, `flow attach`, `flow done`, `flow migrate` | **next** |
| **PR 2 — `/flow-pipeline` supervisor skill** | The new pipeline-as-skill that replaces the Node runner + 8 phases | queued |
| **PR 3 — `pr-review` machine-mode removal** | Drop `RESULT_JSON_PATH` opt-in; use native mode-detection (subsumes the queued Phase 2 follow-up) | queued |
| **PR 4 — delete the orchestrator** | Remove `src/pipeline/`, `src/log/`, and orchestrator CLI verbs | queued |
| **PR 5 — delete obsolete pipeline skills + retire per-repo install** | Remove `/flow-add`, `/flow-approve`, `/flow-revise`, `/flow-watch`, `/flow-status`, plus `src/install/` | queued |
| **PR 6 — cost reporting in `flow ls`** | `flow ls --cost` per pipeline | queued |
| **PR 7 — per-skill model + effort tuning** | Carries forward queued Phase 5 PR 20 | queued |
| **PR 8 — eval harness** | Carries forward queued Phase 5 PR 21 | queued |
| **PR 9 (optional) — `flow new --resume <name>`** | Recover a crashed Claude Code session in an existing window | optional |
| **PR 10 (optional) — notifications** | macOS notifications on `NEEDS HUMAN`, `MERGED`, `gated`. Carries forward shipped PR 17. | optional |

---

## User flows

The flows are described by what the **user** sees and types.
"Supervisor" = the Claude Code session inside the tmux window.
"Deterministic" = a shell command run by the supervisor as a tool
call, not an LLM decision. "LLM" = the supervisor or a sub-skill
making a judgment.

### Flow 1 — Kickoff (happy path, feature)

1. **User (any terminal)**: `flow new "add CSV export"`
2. **Deterministic** (the `flow new` shell function): slugifies the
   description → `csv-export`. Creates a tmux window named `csv-export`
   inside the `flow` session (creating the session if it doesn't exist
   yet). The tmux target is `flow:csv-export` — `<session>:<window>` in
   tmux syntax, not a literal window name. Starts Claude Code in the
   window with an initial prompt: *"Run the `/flow-pipeline` skill for:
   add CSV export."*
3. **Supervisor (LLM, in attached or detached tmux window)**: invokes
   the `/flow-pipeline` skill. Step 1 of the skill:
   - **Deterministic tool call**: `flow-new-worktree csv-export` →
     creates `<repo>.worktrees/csv-export/` on a fresh branch.
4. **Supervisor (LLM)**: invokes `/product-planning` (in-process
   skill). The skill produces a PRD + task breakdown + PR-draft seed
   in the worktree. The supervisor prints the plan summary to chat
   and **ends its turn**.
5. **User** (next time they attach to `flow:csv-export`): reads the
   plan in scrollback. Types one of:
   - `approved` (or any affirmative) → proceed.
   - "Actually, also handle TSV." (free-form redirect) → supervisor
     re-runs `/product-planning` with the redirect appended.
   - `cancel` → supervisor calls `flow-remove-worktree` and ends.

### Flow 2 — Implementation, CI, review (unattended after approval)

6. **Supervisor (LLM)**: invokes `/new-feature`. The skill writes
   code + tests in the worktree, commits, pushes, opens a PR via
   `gh`. Captures the PR number.
7. **Supervisor (deterministic-in-LLM-loop)**: enters a poll loop —
   `gh pr checks <pr> --json` and `gh pr view <pr> --json reviews`
   on a 30s cadence. The supervisor's own single conversation turn
   drives this; each iteration is a tool call pair. Cap: 20 minutes.
8. **Supervisor (LLM)**: when CI is terminal AND Copilot has posted
   a review (or the bot timed out), invokes `/pr-review <PR>` —
   **native invocation**, no machine-mode JSON contract. The skill
   detects inline comments, picks Address mode, addresses each, runs
   the multi-agent independent review, auto-fixes findings, commits,
   pushes.
9. **Supervisor (LLM)**: reads the auto-merge gate — same heuristic
   as today's `gate` phase, expressed in the skill prompt:
   - `## Manual validation` section in the PR body **empty** → run
     `gh pr merge --squash --delete-branch`. Run
     `flow-remove-worktree`. Print `MERGED` and end.
   - Section **non-empty** → print the validation checklist, the PR
     URL, the verb to merge manually (`gh pr merge --squash <pr>`),
     and end. The user merges from GitHub when ready.

### Flow 3 — Status check

`flow ls` (any terminal) reads `tmux list-windows -t flow` for the set
of active pipelines, then for each window reads
`<worktree>/.flow-status` (a one-line file the supervisor updates at
each phase transition) to get the current phase. Prints a table:

```
NAME            PHASE         PR    LAST ACTIVITY
csv-export      reviewing     #142  2m ago
mobile-tabs     planning      —     12m ago
db-migration    gated         #138  1h ago
```

Pure shell — no LLM. For richer state, the user attaches to any
window and reads scrollback.

### Flow 4 — Drilldown / mid-flight redirect

`flow attach <name>` (alias `flow a <name>`) runs
`tmux attach -t flow:<name>`. The user lands in the live Claude Code
chat. They can read scrollback, type into the chat ("actually, also
handle TSV"; "stop and rebuild against the new schema"; "ignore the
failing flake test on `<file>`"), or `Ctrl-b d` to detach.
Mid-flight redirect is a normal chat turn.

### Flow 5 — Cleanup

- **Auto** on merge: the supervisor calls `flow-remove-worktree`,
  prints `MERGED`, and ends. The tmux window stays open (scrollback
  retained) until killed.
- `flow done <name>` kills the tmux window after the user has read
  the scrollback.
- `flow done --all-merged` kills any window whose phase is `merged`
  or `cancelled`.

### Flow 6 — Resume after laptop sleep / detach

The tmux server persists across detach and laptop sleep. If the
supervisor was mid-poll-loop when the laptop slept, it picks up where
it left off when the tool call returns. **No special "resume" verb
needed**: the supervisor's state lives in the Claude Code session,
which lives in the tmux window.

The single failure mode: if Claude Code crashes inside the window,
the session is lost. The PR and worktree survive on disk. The user
can `flow new --resume <name>` (PR 9, optional): re-launches Claude
Code into the same window with a `/flow-pipeline --resume` prompt
that tells the supervisor to inspect the worktree + PR + branch
state and pick up from whatever phase looks done.

### Flow 7 — Parallelism

`flow new "feature A"` then `flow new "feature B"` then
`flow new "feature C"` creates three tmux windows. Each runs its own
supervisor session against its own worktree. They are completely
independent — the OS schedules them, no claim primitive needed.
`flow ls` shows all three. `flow attach <name>` drills into any one.

---

## LLM vs deterministic — the boundary

| Action | LLM or deterministic? | Where it runs |
|---|---|---|
| `flow new <desc>` slugify + tmux window create | Deterministic | shell wrapper |
| Initial supervisor prompt sent to the new window | Deterministic (template) | shell wrapper |
| `/flow-pipeline` skill: worktree creation | Deterministic (script) | supervisor invokes `flow-new-worktree` as a tool |
| `/product-planning` content | LLM | in-process skill |
| Approval-intent judgment ("approved" vs "redo X") | LLM | supervisor's chat turn |
| `/new-feature` content | LLM | in-process skill |
| `gh pr create` | Deterministic | `gh` tool call inside the skill |
| Sleep + poll loop on Copilot/CI | Deterministic loop, but driven by the LLM's tool-call turn | supervisor |
| `/pr-review` mode detection (Address vs Review) | LLM (the skill itself) | in-process skill |
| Auto-merge decision (Manual-validation section non-empty?) | Deterministic check expressed in the supervisor prompt | supervisor |
| `gh pr merge --squash` | Deterministic | `gh` tool call |
| Worktree cleanup | Deterministic (script) | `flow-remove-worktree` |
| `flow ls` table | Deterministic | shell, parses `tmux list-windows` |
| `flow attach`, `flow done` | Deterministic | shell |

**The single LLM container is the supervisor session inside the tmux
window.** No LLM lives outside it. All sub-skills (`/product-planning`,
`/new-feature`, `/verify`, `/pr-review`) run in-process within the
supervisor — they are *skill loads*, not subprocess invocations. This
sidesteps the sub-agent depth cap (Claude Code's one-level limit)
cleanly, because skills are in-process instructions, not nested
agents.

---

## Visibility

| Surface | Visible to user? | How |
|---|---|---|
| Plan output | Yes | scrollback when attached |
| Implementation activity | Yes | scrollback (every tool call narrated) |
| Sleep/poll loops | Yes | scrollback |
| `/pr-review` findings | Yes | inline PR comments + scrollback |
| Auto-merge decision | Yes | scrollback |
| Status of all pipelines | Yes | `flow ls` (any terminal) |
| Per-pipeline cost | Yes | `flow ls --cost` (PR 6) |
| Approval surface | Yes | the user types in the tmux window itself |
| Notifications on `NEEDS HUMAN` | Optional | terminal bell + macOS notification (PR 10) |

There is **no hidden state**: the supervisor session, scrollback,
PR, and worktree are the only places state lives, and all four are
inspectable directly. No `.orchestrator/` directory to learn.

---

## CLI API — full surface

```
flow new <description>            create a window and start a pipeline
flow new --resume <name>          recover a crashed session in an existing window (PR 9)
flow ls                           list all flow tmux windows + phase + PR
flow ls --cost                    same, with $ spent per pipeline (PR 6)
flow attach <name>                tmux attach to a window  (alias: flow a)
flow done <name>                  kill a window once the user is finished
flow done --all-merged            kill every window in a terminal phase

flow setup                        symlink skills, agents, scripts globally
flow setup --upgrade              re-symlink, drop orphans
flow setup --stack <name>         add a stack-specific skill bundle (e.g. svelte)
flow migrate                      (per-repo) reverse old per-repo install (dry-run)
flow migrate --apply              actually apply the cleanup
flow migrate --scan <path>        dry-run across every git repo under a path

flow stack add <name>             (per-repo) add a stack skill to one project (PR 1, option B)
flow stack remove <name>
flow stack list

flow --help                       command help
```

**Removed verbs** (PR 4): `flow start`, `flow run`, `flow run --all`,
`flow log`, `flow status`, `flow approve`, `flow revise`,
`flow install`, `flow tui`. Their job is now done by tmux directly
(`tmux attach`, `tmux ls`, `Ctrl-b d`) or by typing into the
supervisor window.

---

## Installation UX — global, zero per-repo footprint

### Where everything lives

```
~/.claude/skills/                # Claude Code user-level skills (auto-loaded everywhere)
  flow-pipeline/                 # → symlink to ~/code/flow/skills/pipeline/flow-pipeline/
  product-planning/
  new-feature/
  verify/
  pr-review/
  add-worktree/
  remove-worktree/
  refactoring/
  testing/
  skill-creator/

~/.claude/agents/                # Claude Code user-level agents (auto-loaded everywhere)
  pr-bug-detection.md            # → symlinks to ~/code/flow/agents/*
  pr-security.md
  pr-pattern.md
  pr-test-coverage.md
  skill-grader.md
  skill-comparator.md
  skill-analyzer.md

~/.local/bin/                    # on PATH; helper binaries callable from any repo
  flow                           # the wrapper (new, ls, attach, done, setup, migrate)
  flow-new-worktree
  flow-remove-worktree
  flow-pre-commit
  flow-fetch-pr-review
  flow-reply-pr-comments
```

Each helper binary is named `flow-<verb>` — no naming collision with
project-local scripts, easy to discover (`flow-<TAB>`), unambiguous.

Claude Code already merges `~/.claude/skills/**` into every session,
in every project, with zero per-repo declaration. So skills "just
work" in any repo. Same for `~/.claude/agents/**`.

**Critical change for sub-skills.** Skills that today reference
`./scripts/fetch-pr-review.ts` (a project-relative path) are amended
to call the corresponding global binary (`flow-fetch-pr-review`).
The binary is invoked with the project root as CWD, which preserves
all existing behaviour (`gh` works against the repo the user is in).

### One-time global setup

```sh
git clone https://github.com/<user>/flow ~/code/flow
cd ~/code/flow
npm install
npm run build
flow setup
```

`flow setup`:

1. Verifies `tmux` is on PATH; errors out with install instructions
   otherwise.
2. Verifies `~/.local/bin/` is on PATH; warns + offers a PATH update.
3. Symlinks every skill from `~/code/flow/skills/**` into
   `~/.claude/skills/<skill-name>/`. Refuses to overwrite any
   non-symlink without `--force`.
4. Symlinks every agent from `~/code/flow/agents/*.md` into
   `~/.claude/agents/`.
5. Symlinks every helper script from `~/code/flow/bin/` into
   `~/.local/bin/flow-<name>`.
6. Symlinks the `flow` wrapper itself into `~/.local/bin/flow`.
7. Records every symlink in `~/.flow/installed.json` so
   `flow setup --upgrade` and the future `flow uninstall` know
   exactly what to reap.

**No per-repo step for core flow.** Open any repo in Claude Code →
all flow skills are already available. Stack skills (option B below)
are the named exception: they install per-project on demand because
they're stack-specific and shouldn't autoload everywhere.

### Updating

```sh
cd ~/code/flow && git pull
flow setup --upgrade
```

Idempotent: re-creates missing symlinks, drops orphans, refreshes the
manifest. No project gets touched — flow's own repo and `~/.claude/`
/ `~/.local/bin/` are the only things that change.

### Stack skills (svelte, supabase, tailwind-shadcn)

These shouldn't be globally autoloaded — they'd pollute every
project's skill resolution. Two options to be picked during PR 1:

- **A:** `flow setup --stack svelte` symlinks the stack into
  `~/.claude/skills/` globally. Simple but pulls in stack skills for
  *every* project.
- **B (preferred):** `flow stack add svelte` (run inside a project)
  symlinks `~/code/flow/skills/stacks/svelte/` into
  `<repo>/.claude/skills/svelte/` and records it in a small managed
  `.gitignore` block. **This is the one explicit exception to the
  "zero per-repo footprint" goal stated above.** Stack skills are
  scoped where they belong — the managed-block + symlink pattern is
  retained from old flow's `flow install` because it's the right
  shape for stack scoping, just narrowed to opt-in stack skills only.

### Per-machine config

Optional `~/.flow/config.json`:

- Path to the flow source checkout (default: `~/code/flow`).
- Default branch convention (e.g. `main` vs `master`).
- Notification opt-in (`FLOW_NOTIFY=1` equivalent).
- Default poll cadence + cap for the supervisor's CI/Copilot wait.

The supervisor skill reads this on each pipeline start. No project
ever needs a flow config file.

---

## Migration — porting from old flow to new flow

For repos that have flow installed today, cleanup is mechanical and
fully scripted. The user runs **one command per repo** plus **one
global command**.

### What needs to be cleaned up

Per-repo footprint that today's `flow install` creates:

```
<repo>/
  .claude/skills/                # symlinks under `# managed by flow install-skills` block
    flow-add/  flow-approve/  flow-revise/  flow-status/  flow-watch/
    new-feature/  pr-review/  product-planning/  verify/
    add-worktree/  remove-worktree/  refactoring/  skill-creator/  testing/
  scripts/                       # symlinks under `# managed by flow install-scripts` block
    ci-wait.ts  fetch-pr-review.ts  flow-add.ts  flow-watch.ts
    new-agent-worktree.ts  pre-commit-checks.ts  remove-agent-worktree.ts
    reply-pr-comments.ts
  .gitignore                     # contains the two managed blocks
  .orchestrator/                 # state directory: tasks/, logs/, runs/, locks/, archive/
```

### `flow migrate`

Run from inside any flow-installed repo:

```sh
flow migrate                          # dry-run by default
flow migrate --apply                  # actually do it
flow migrate --apply --include-orchestrator   # also rm -rf .orchestrator/
flow migrate --scan ~/code/           # dry-run across every git repo under a path
```

What it does, deterministically:

1. **Inspect** the repo's `.gitignore` for the two managed blocks
   (`# managed by flow install-skills` and `# managed by flow
   install-scripts`).
2. **Print** the planned actions: every symlink to be removed, every
   `.gitignore` line to be removed, presence of `.orchestrator/`,
   any non-terminal in-flight tasks.
3. **Refuses to proceed** if `.orchestrator/tasks/` contains any task
   with non-terminal status. The user is told the ids and statuses
   and asked to either complete or abort them first.
4. **On `--apply`**: removes each managed symlink (only if it's
   actually a symlink — never deletes a real file), strips the two
   managed blocks from `.gitignore`, and (if opted in) deletes the
   state directory.

### One-pass global migration

```sh
cd ~/code/flow
git pull
npm install && npm run build
flow setup                            # global ~/.claude/ + ~/.local/bin/ install

cd ~/code/<repo-with-old-flow>
flow migrate --apply                  # cleans up the per-repo footprint
# repeat for each repo, or use `flow migrate --scan ~/code/` for batch
```

After this, every repo is footprint-free, and the new flow works
everywhere automatically.

### Cleanup safety properties

- `flow migrate` **never deletes a real file**, only symlinks listed
  in the managed `.gitignore` blocks. If the user has accidentally
  replaced a managed symlink with a real file (e.g. `git checkout
  --` overwrote a symlink), migrate skips it and warns.
- `flow migrate` **never touches** `.claude/skills/` entries that
  aren't in the managed block. User-authored skills are preserved.
- `flow migrate` is **idempotent**: re-running it is a no-op.

### Cleanup of the global old `npm link`

`flow setup` overwrites the old `npm link`-installed `flow` binary
cleanly. No manual `npm unlink` needed — but for the paranoid:

```sh
cd ~/code/flow && npm unlink && rm -f $(which flow)
flow setup
```

### What survives migration intentionally

- All open PRs created by old flow runs — they're just normal PRs.
- All worktrees on disk — they're just git worktrees.
- All branches — git is unmodified.
- The `.orchestrator/tasks/archive/` directory if the user kept it.

---

## Skills — delete, keep, enhance

### Delete (5 skills)

These are entirely orchestrator-control skills with no surviving
role:

| Skill | Why removed |
|---|---|
| `skills/pipeline/flow-add/` | Triage moves into `/flow-pipeline`'s first step. |
| `skills/pipeline/flow-approve/` | Approval is just typing in the tmux window. |
| `skills/pipeline/flow-revise/` | Mid-flight redirects are just typing in the tmux window. |
| `skills/pipeline/flow-watch/` | tmux scrollback is the watch surface. |
| `skills/pipeline/flow-status/` | `flow ls` (shell) replaces it. |

### Keep, lightly amended (4 skills)

| Skill | Notes |
|---|---|
| `skills/pipeline/product-planning/` | Minor: writes its PRD + task breakdown to `<worktree>/plan.md` (predictable path) so the supervisor can locate it without reading scrollback. |
| `skills/pipeline/new-feature/` | No structural change. The supervisor invokes it after approval. |
| `skills/pipeline/verify/` | No structural change. References `flow-pre-commit` instead of `./scripts/pre-commit-checks.ts`. |
| `skills/pipeline/pr-review/` | Drop the machine-mode opt-in (`RESULT_JSON_PATH`). Let native mode-detection drive Address vs Review. Reference `flow-fetch-pr-review` and `flow-reply-pr-comments` instead of project-relative paths. (This subsumes the queued Phase 2 follow-up.) |

### Keep unchanged (5 universal + 3 stack skills)

`skills/universal/{add-worktree,remove-worktree,skill-creator,
refactoring,testing}/`, plus `skills/stacks/{svelte,tailwind-shadcn,
supabase}/`. Zero orchestrator coupling, all viable as-is.

### Add (1 skill)

**`skills/pipeline/flow-pipeline/`** — the supervisor skill. Replaces
`runner.ts` + 8 phase modules with a single prompt:

```
skills/pipeline/flow-pipeline/
  SKILL.md                        # the supervisor's instructions
  references/
    auto-merge-rubric.md          # gate logic (Manual-validation section heuristic)
    polling-protocol.md           # CI/Copilot poll cadence + cap
    failure-recovery.md           # what to do if verify fails, ci hangs, review escalates
    redirect-handling.md          # how to interpret mid-flight user input
```

Skill content (SKILL.md outline):

1. **Triage**. Classify the request: change vs no-change, feature vs
   fix vs refactor. No-change → answer in chat, end. Change → continue.
2. **Worktree**. Tool-call `flow-new-worktree <slug>`. `cd` into it.
3. **Plan**. Invoke `/product-planning`. Print a summary. End the
   turn *if* intent is `feature` (highest-leverage human-in-loop).
   Non-feature intents skip the checkpoint.
4. **Approval handling**. Next turn: judge user intent — approved /
   redirect / cancel. Loop back to plan if redirect; cleanup and end
   if cancel.
5. **Implement**. Invoke `/new-feature`. It produces code, tests,
   commit, push, PR.
6. **Local verify**. Invoke `/verify`. On failure: retry with
   feedback, up to 3x. After exhaustion, escalate.
7. **Wait for CI + Copilot**. Sleep+poll loop. Cadence + cap from
   `references/polling-protocol.md`.
8. **Review**. Invoke `/pr-review <PR>` natively. Trust the skill.
9. **Auto-merge gate**. Apply rubric in
   `references/auto-merge-rubric.md`:
   - `## Manual validation` section empty → `gh pr merge --squash
     --delete-branch`, then `flow-remove-worktree`, then print
     `MERGED`. End.
   - Non-empty → print validation checklist + PR URL + manual-merge
     verb. End.
10. **Failure paths**: print a clear `NEEDS HUMAN: <reason>` line,
    leave the worktree + PR intact, end. The user attaches and
    redirects.

Each step's prompt-fragment goes in SKILL.md, not in code.

---

## Code deletions

### Fully delete (PR 4 + PR 5)

```
src/pipeline/                     # runner.ts + 8 phases + retry + cost + claim + headless
src/log/                          # follow, render*, concat, discover (all)
src/commands/start.ts
src/commands/run.ts
src/commands/run-all.ts
src/commands/approve.ts
src/commands/revise.ts
src/commands/log.ts
src/commands/status.ts            # replaced by `flow ls` shell verb
src/commands/triage-sentinel.ts
src/commands/install.ts           # per-repo install retired in favour of `flow setup`
src/install/                      # per-repo install retired
templates/scripts/                # the directory itself — content migrates to bin/
```

### Migrate (TS files re-homed, behaviour unchanged)

These scripts remain useful but become **global binaries** under
`~/.local/bin/flow-<name>` instead of per-repo `scripts/<name>.ts`.
They move to `bin/` in the flow source tree.

```
templates/scripts/new-agent-worktree.ts    →  bin/flow-new-worktree
templates/scripts/remove-agent-worktree.ts →  bin/flow-remove-worktree
templates/scripts/pre-commit-checks.ts     →  bin/flow-pre-commit
templates/scripts/fetch-pr-review.ts       →  bin/flow-fetch-pr-review
templates/scripts/reply-pr-comments.ts     →  bin/flow-reply-pr-comments
```

`#!/usr/bin/env bun` shebang preserved (no Bun → Node port). Skills
that referenced these scripts via `./scripts/<name>.ts` are amended
(PR 3) to call the global binary `flow-<name>` instead.

### Add (PR 1 + PR 2)

```
bin/flow                          # the wrapper itself: new, ls, attach, done, setup, migrate
bin/flow-*                        # the migrated helper scripts above
skills/pipeline/flow-pipeline/    # the new supervisor skill (PR 2)
agents/                           # promoted .claude/agents/ tier (PR 7)
```

The `.orchestrator/` directory is no longer written by anything.
`flow migrate` (PR 1) offers to delete it during the per-repo
cleanup. The supervisor never reads it, so any files left behind
are inert.

---

## PRs in detail

### PR 1 — global install + shell wrapper

Done when:

- `flow setup` symlinks all skills into `~/.claude/skills/`, all
  agents into `~/.claude/agents/`, all helper scripts into
  `~/.local/bin/flow-<name>`, and the `flow` wrapper itself into
  `~/.local/bin/flow`. Records every symlink in
  `~/.flow/installed.json`. Verifies tmux on PATH.
- `flow setup --upgrade` is idempotent — re-creates missing
  symlinks, reaps orphans, refreshes the manifest.
- `flow new <description>` creates a tmux session/window
  (`flow:<slug>`), launches Claude Code in it with a stub prompt
  (`Use the /flow-pipeline skill for: <description>`).
- `flow ls` lists windows from `tmux list-windows -t flow`, then reads
  `<worktree>/.flow-status` for each to recover the current phase, and
  prints a table: name, phase, pr, last-activity. Phase is tracked via
  the status file rather than encoded in the window name so window
  names stay parseable as `tmux attach -t flow:<name>` targets — see
  also the resolved open question #5 below.
- `<worktree>/.flow-status` format pinned as two key:value lines —
  `phase: <lifecycle-phase>` and `last_transition_at: <ISO-8601 UTC
  with Z>` — and documented as atomically rewritten (write-tmp +
  rename) on every phase transition. PR 1 ships only the reader plus
  format pin; PR 2's supervisor is responsible for actually writing
  the file. `flow ls` reads both fields, renders **LAST ACTIVITY** as
  the relative-time delta from `last_transition_at` (`<N>s ago`,
  `<N>m ago`, `<N>h ago`, `<N>d ago`), and tolerates missing or
  malformed files by rendering `phase: —` and `LAST ACTIVITY: —`
  (with a one-line stderr warning on malformed but never crashing
  the row).
- `flow attach <name>` runs `tmux attach -t flow:<name>`.
- `flow done <name>` kills the window after a confirmation prompt.
- `flow migrate` (with dry-run default and `--apply` to commit)
  reverses the per-repo install: removes managed-block symlinks
  under `.claude/skills/` and `scripts/`, strips the two managed
  blocks from `.gitignore`, optionally deletes `.orchestrator/`.
  Refuses to proceed if non-terminal tasks exist.
- `flow migrate --scan <path>` runs the dry-run across every git
  repo under a path.
- Old verbs (`run`, `start`, `install`, etc.) still work in this
  PR — they're removed in PR 4. This PR is additive so users can
  migrate at their own pace.

### PR 2 — `/flow-pipeline` supervisor skill

Done when:

- `skills/pipeline/flow-pipeline/SKILL.md` exists with the 10-step
  outline above; reference docs land under `references/`.
- A real-repo end-to-end pass: `flow new "trivial test feature"`
  from a scratch branch produces a merged PR (or a `gated` PR if the
  manual-validation section was filled), with no other commands
  needed.
- The skill never spawns nested agents; it only loads sub-skills
  in-process and invokes scripts as tool calls.
- The `references/failure-recovery.md` decision tree is pinned for
  use in PR 9 (`flow new --resume`).

### PR 3 — `pr-review` machine-mode removal + global-binary references

Done when:

- `skills/pipeline/pr-review/SKILL.md` no longer references
  `RESULT_JSON_PATH` machine-mode forcing or the
  Force-Review-mode/no-auto-fix/no-commit/no-push preamble.
- Native mode-detection drives Address vs Review.
- Script invocations switch from `./scripts/fetch-pr-review.ts` /
  `./scripts/reply-pr-comments.ts` to the global binaries
  `flow-fetch-pr-review` / `flow-reply-pr-comments`.
- Same change applied to `/verify` and `/new-feature` for any
  `pre-commit-checks.ts` references.
- This subsumes the previously-queued Phase 2 follow-up; it ships
  in service of the redesign rather than the old runner.

### PR 4 — delete the orchestrator

Done when:

- All files listed under "Fully delete" above are removed (except
  `src/install/` which goes in PR 5).
- `src/cli.ts` no longer registers `start`, `run`, `run-all`,
  `approve`, `revise`, `log`, `status`. Only the new shell-verb
  passthroughs from PR 1 (and `install`, until PR 5) remain.
- `npm run typecheck` and `npm run test` are clean.
- README is rewritten around the tmux flow.

### PR 5 — delete obsolete pipeline skills + retire per-repo install

Done when:

- `skills/pipeline/{flow-add,flow-approve,flow-revise,flow-watch,
  flow-status}/` are removed from the source tree.
- `templates/scripts/{ci-wait,flow-add,flow-watch}.ts` (and tests)
  are removed.
- `src/commands/install.ts`, `src/install/scripts.ts`,
  `src/install/skills.ts`, `templates/scripts/` (the directory)
  and any related tests are deleted. The per-repo install pattern is
  retired in favour of the global install from PR 1.
- A subsequent `flow setup --upgrade` reaps the orphan symlinks for
  the deleted skills/scripts from `~/.claude/skills/` and
  `~/.local/bin/`.
- `flow migrate` (PR 1) handles cleanup of legacy per-repo installs
  in any target repo that still has them.

### PR 6 — cost reporting in `flow ls`

Carry-forward from queued Phase 5. Done when:

- `flow ls --cost` shows `$ spent` per active window.
- Source: scrape `claude --output-format stream-json`-style usage
  events out of the supervisor session if exposed; otherwise pipe
  through Claude Code's session-usage API once available.
- Cost attribution by model is preserved (Haiku triage vs Opus plan
  vs Sonnet implement → distinct line items in
  `flow ls --cost --detail`).

### PR 7 — per-skill model + effort tuning

Carry-forward from queued Phase 5 PR 20. Done when:

- Skills under `skills/pipeline/` and agents under `agents/` declare
  `model:` and `effort:` in frontmatter where it matters:
  - `flow-pipeline` — Sonnet 4.6, `medium` (orchestration; control-
    flow judgment doesn't need Opus).
  - `product-planning` — Opus 4.7, `xhigh`.
  - `new-feature` — Sonnet 4.6, `high`.
  - `verify` — Sonnet 4.6, `medium`.
  - `pr-review` sub-agents (promoted to `agents/`): Opus for
    bug+security at `xhigh`; Sonnet for pattern+test-coverage at
    `high`/`medium`.
- The `agents/` directory is symlinked by `flow setup` into
  `~/.claude/agents/`.
- Verify-retry escalation: when `/verify` fails inside the
  supervisor's loop, the next attempt runs at Opus/`xhigh`. Logic
  lives in `/flow-pipeline`'s SKILL.md, since Node retry no longer
  exists.

### PR 8 — eval harness

Carry-forward from queued Phase 5 PR 21. Done when:

- 5–10 fixture features under `evals/` with expected diffs +
  rubrics.
- `flow eval` runs each fixture under two model configs (Claude Code
  defaults vs the per-skill picks from PR 7), captures pass/fail and
  $/run, prints a delta.
- Pass-rate regression of >1 fixture between configs exits non-zero
  (CI-friendly).

### PR 9 (optional) — `flow new --resume <name>`

Done when:

- `flow new --resume <name>` launches Claude Code into an existing
  tmux window with a `/flow-pipeline --resume` prompt that says:
  *"This pipeline was interrupted. Inspect the worktree, branch, PR
  state, and resume from the last completed phase."*
- The supervisor's first action is to read the worktree + `gh pr
  view` and decide where to pick up, using the decision tree pinned
  in PR 2's `references/failure-recovery.md`.
- Useful primarily for Claude Code crashes; for laptop sleep, the
  session usually resumes naturally.

### PR 10 (optional) — notifications

Carry-forward from shipped PR 17. Done when:

- The supervisor calls `terminal-notifier` (or `osascript`) on
  `NEEDS HUMAN`, `MERGED`, `gated`. Opt-in via env var.

---

## Roadmap items dropped from the queue

| Old item | Why dropped |
|---|---|
| Phase 4 PR 16 (pause/resume/abort) | tmux already supports this — `Ctrl-b d`, kill the window, free-form chat redirect. No verbs needed. |
| Phase 4 PR 18 (remove `flow start`) | Subsumed into PR 4 (delete the orchestrator entirely). |
| Phase 4 PR 19 (`flow tui`) | tmux *is* the TUI. |
| State-store backend swap (Beads) | The state store is gone — no backend to swap. |
| Cross-process claim primitive | Each pipeline is its own tmux process; OS-level isolation makes claiming trivial (window-name uniqueness). |
| Atomic-rename lock primitive | Same. |
| `flow log <id> --follow`, jsonl rendering | tmux scrollback replaces this. |

---

## Open questions

1. **Polling cost.** A 20-minute Copilot/CI poll inside one
   supervisor turn means dozens of tool-call iterations sharing one
   conversation context. Token cost per iteration is small (sleep +
   gh JSON), but bounded growth deserves measurement before treating
   it as free. PR 6's cost reporting will surface this; if it's
   meaningful, the supervisor can drop polling intervals (e.g. start
   at 30s and back off to 60s, 90s) at the cost of latency.
2. **Multi-machine.** Design B is single-machine by design (see
   [`alternate-architecture.md`](./alternate-architecture.md)
   Comparison table). If multi-machine ever returns as a requirement,
   Design A (GitHub-native) is the path back — noted but explicitly
   out of scope here.
3. **Crash-recovery contract for `flow new --resume`.** The
   supervisor must reliably infer "what phase am I in" from worktree
   state + PR state. The 10-step skill outline maps well to this
   (each step has a side-effect that's inspectable: worktree exists?
   `plan.md` written? PR open? CI green? review commit landed?
   merged?). Worth pinning the exact decision tree in
   `references/failure-recovery.md` during PR 2.
4. **`pr-review` post-merge cleanup.** `/pr-review`'s
   committed-and-pushed fixes retrigger CI. The supervisor's polling
   loop already handles this — but re-entering the gate after a
   review-fix commit means the supervisor must loop back to the
   "wait for CI + Copilot" step, not jump straight to merge. The
   skill prompt must encode this back-edge explicitly.
5. **Window-name phase encoding vs richer status file.** *Resolved:
   status file.* The supervisor writes a one-line phase to
   `<worktree>/.flow-status` at each transition; `flow ls` reads it.
   Reason: encoding phase as a `:<phase>` suffix in the window name
   collides with tmux's `<session>:<window>` target syntax — `tmux
   attach -t flow:csv-export:planning` is ambiguous to the tmux
   parser. The status-file approach also avoids a `tmux rename-window`
   call on every phase transition.
6. **Stack skill placement.** Per-machine global symlink (`flow
   setup --stack`) vs per-project on-demand (`flow stack add`). PR 1
   picks one; the rest of the doc currently treats option B as
   preferred but either is implementable.

---

## Verification (end-to-end)

After PR 2:

1. From flow's own repo: `flow setup --upgrade` (refreshes the
   global `~/.claude/skills/` symlinks so the new supervisor skill
   is loaded).
2. Pick a small real feature ("add a `--version` flag to the CLI
   wrapper").
3. From any repo: `flow new "add --version flag to CLI wrapper"`.
4. Wait for the supervisor to print a plan. Attach. Verify the plan
   is reasonable. Type `approved`.
5. Detach (`Ctrl-b d`). Walk away.
6. Run `flow ls` periodically. Phase should advance: `planning →
   implementing → ci-wait → reviewing → merged`.
7. End state: PR merged on GitHub, worktree gone, branch deleted,
   tmux window still open (scrollback retained).
8. `flow done <name>` to close the window.

After PR 4: `npm run typecheck` and `npm run test` clean against the
slimmed `src/`. Re-run the smoke pass to confirm no regression.

After PR 7: re-run the smoke pass. Pipeline should still complete;
costs should show distinct model attributions.

After PR 8: `flow eval` runs the fixture suite and exits 0 against
the chosen config.

---

## Future stretch / out of scope

- **Multi-machine pipelines.** Single-machine by design.
- **Web UI / dashboard / status server.** tmux is the UI.
- **Slack / email / Jira integration.** macOS notifications (PR 10)
  are the only notification surface.
- **Cross-repo coordination.** flow operates on one repo at a time.
- **Beads (database) state-store backend.** The state store is gone;
  no backend to swap.

---

## Old roadmap (orchestrator design — historical record)

The following PRs shipped under the previous orchestrator design and
are being deprecated. Their commit history and PR descriptions
remain authoritative for what was built; this section captures the
shape for context.

| Phase | Adds | PRs |
|---|---|---|
| **Triage + scaffold** | Phase 0 (triage) + CLI scaffold | shipped |
| **Plan / worktree / implement** | Phases 1–3 (plan, worktree, implement), single task | shipped |
| **Phase 1 — foundation** | jsonl logging, detached subprocesses, cross-process claim primitive, implement create/fix split | #13, #14, #16 |
| **Phase 2 — pipeline buildout** | ci-wait, verify retry loop, `flow log` viewer, review + critical loop-back, gate + merge | #17, #24, #15, #25, #33 |
| **Phase 3 — entry point + UX** | `/flow add`, `/flow status`, `/flow watch`, plan checkpoint | #29, #23, #26, #34 |
| **Phase 4 — cutover + parallelism** | deprecate `flow start`, `flow install --upgrade`, parallelism, notifications | #31, #27, #32, #28 |

These designs are documented in detail in
[`architecture.md`](./architecture.md),
[`chat-first-design.md`](./chat-first-design.md), and
[`task-schema.md`](./task-schema.md). They remain accurate
descriptions of the orchestrator that exists today; once PR 4 lands,
they should be archived or rewritten around the tmux design.
