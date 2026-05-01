# flow

Multi-phase AI agent dev orchestration **plus a curated library of
[Claude Code](https://docs.claude.com/en/docs/claude-code) skills**. One repo,
two responsibilities:

1. **Orchestrator CLI** — `flow start "<prompt>"` and `flow run` drive a pipeline:
   triage → (optionally) plan → worktree → implement → verify → CI → review → gate
   → merge. Inspired by WAVE, minus the enterprise integrations. Markdown plan
   files act as the cross-phase state store.
2. **Skill library** — `flow/skills/` bundles a curated set of skills (pipeline,
   universal, stacks) along with the helper scripts they shell out to. `flow
   install` symlinks both into target repos, so every project shares one source
   of truth.

## Status

**Mid-redesign.** flow is moving from a Node-based orchestrator to a
tmux-driven supervisor skill. This PR (PR 1) ships the new global install
model and the `flow` shell wrapper. The Node orchestrator (`flow run`,
`flow start`, `flow log`, etc.) still works in already-installed repos —
deletion is later in the redesign. See [`docs/roadmap.md`](docs/roadmap.md)
for the full plan.

## Install (global, recommended)

```sh
git clone https://github.com/<user>/flow ~/code/flow
cd ~/code/flow
npm install     # `prepare` also builds dist/ for old verbs
bun bin/flow setup
```

`flow setup`:

- Symlinks every skill from `~/code/flow/skills/{pipeline,universal,stacks}/`
  into `~/.claude/skills/`. Available in every project, zero per-repo
  declaration.
- Symlinks every helper (`flow-new-worktree`, `flow-pre-commit`,
  `flow-fetch-pr-review`, `flow-reply-pr-comments`, `flow-remove-worktree`)
  into `~/.local/bin/`.
- Symlinks the `flow` wrapper itself into `~/.local/bin/flow`.
- Records every symlink in `~/.flow/installed.json` so `flow setup --upgrade`
  can reap orphans deterministically.

Verifies `tmux` is on PATH (a hard requirement for the tmux-driven flow)
and warns if `~/.local/bin/` is missing from `PATH`.

Update with `cd ~/code/flow && git pull && bun bin/flow setup --upgrade`.

## Quick start (tmux-driven)

> The supervisor skill (`/flow-pipeline`) that drives a pipeline end-to-end
> ships in PR 2. Until then, `flow new` opens a window with the right
> initial prompt but the supervisor doesn't yet automate the phases — it
> shows up as plain chat input.

```sh
flow new "add CSV export"        # creates tmux window flow:add-csv-export
flow ls                          # lists active pipelines
flow attach add-csv-export       # tmux attach (alias: flow a)
flow done add-csv-export         # close the window when finished
flow done --all-merged           # sweep terminal-state windows
```

Pipelines are tmux windows inside a `flow` session. State lives at
`~/.flow/state/<slug>.json` (one JSON per pipeline). Walk-away execution
is just detaching from tmux (`Ctrl-b d`); resume by attaching again.

## Migrate a repo off the legacy per-repo install

Repos that were set up with the old `flow install` keep working. To clean
up the per-repo footprint:

```sh
cd <some-repo>
flow migrate                     # dry-run — print what would change
flow migrate --apply             # remove managed symlinks, strip gitignore blocks
flow migrate --apply --include-orchestrator   # also delete .orchestrator/
flow migrate --scan ~/code/      # dry-run across every git repo under a path
```

`flow migrate` only deletes symlinks listed in the two managed
`.gitignore` blocks (`# managed by flow install-skills`, `# managed by
flow install-scripts`). Real files in those paths are warned about, never
deleted. See [`docs/migration.md`](docs/migration.md) for full details.

## Install (legacy, dev only)

The old `npm link` path still works for hacking on `src/`:

```sh
npm install     # `prepare` builds dist/ automatically
npm link        # makes `flow` available on PATH (overwritten by `flow setup`)
```

## Use the orchestrator

### From a Claude Code chat — `/flow-add`

Once `flow install` has run in the repo, any Claude Code chat opened inside
that repo can kick off a flow task without leaving the chat:

```
/flow-add "add a portfolio allocation chart to the dashboard"
```

The skill conducts triage in the same chat session, records
`.orchestrator/tasks/<id>.md`, and spawns `flow run --detach` so the
pipeline runs as a detached process tree. The chat is freed immediately;
follow up with `/flow-status <id>` or `/flow-watch <id>` to check
progress.

For `feature`-intent tasks, the pipeline pauses after the plan phase at
status `plan-pending-review` so you can read the PRD before paying
implement-phase tokens. Resume the pipeline with one of:

```
/flow-approve <id>                     # accept the plan, continue to implement
/flow-revise  <id> "<redirection>"     # record a redirection, re-plan
```

Set `FLOW_NOTIFY=1` in the shell that started the pipeline to fire a
macOS notification when the checkpoint hits (see "Notifications" below).
Non-feature intents (`bug`, `refactor`, `docs`, `infra`, `chore`) skip
the checkpoint and run straight through.

### Legacy CLI (`flow start`)

> `flow start` is deprecated and will be removed in a future release.
> Prefer `/flow-add` (above) for new tasks.

The CLI front door does the same triage in a spawned interactive Claude
Code session:

```sh
flow start "add a portfolio allocation chart to the dashboard"
flow start "explain how the FRED manifest works"
```

The first opens triage and writes `.orchestrator/tasks/<id>.md`. The second
answers in-line and exits with no file written.

Both front doors produce the same `task.md` schema and feed the same
pipeline.

### Drain the queue — `flow run --all`

After several `/flow-add` kickoffs leave a stack of `triaged` tasks
sitting in `.orchestrator/tasks/`, drain the lot in parallel:

```sh
flow run --all                          # one-shot drain (default --max=min(cpus, 4))
flow run --all --watch                  # stay alive, picking up new tasks every 5s
flow run --all --max 2 --detach         # bounded fan-out, parent shell freed
```

`--all` spawns one `flow run <id>` child per claimed task, bounded by
`--max`. The cross-process claim primitive guarantees that two concurrent
`flow run --all` invocations never pick up the same task twice. First
Ctrl+C stops claiming new tasks but lets in-flight children finish; a
second Ctrl+C within 5 seconds propagates SIGTERM. Scheduler activity
logs to `.orchestrator/runs/all-<stamp>.{log,jsonl}`.

Add `.orchestrator/` to your project's `.gitignore`.

## Install skills + scripts

From inside the target repo:

```sh
# Pipeline + universal skills, plus all bundled scripts:
flow install

# Add opt-in stacks:
flow install --stack svelte,supabase

# Skip pipeline skills (for repos that don't use flow's pipeline):
flow install --skip-pipeline

# Replace existing real files in scripts/ (otherwise they're left alone):
flow install --force
```

Each invocation symlinks skills into `<repo>/.claude/skills/` and scripts into
`<repo>/scripts/`, then updates `.gitignore` so the symlinks don't get tracked.
Idempotent — re-run any time to heal broken links or pick up new skills/scripts.

Three categories of skills:

- **`skills/pipeline/`** — invoked by flow's pipeline by name (`product-planning`,
  `new-feature`, `verify`, `pr-review`). Output formats are coupled to flow's parser.
- **`skills/universal/`** — generic productivity skills with no flow coupling
  (`refactoring`, `skill-creator`, `add-worktree`, etc.).
- **`skills/stacks/`** — stack-specific (Svelte, Tailwind+shadcn, Supabase). Opt in via
  `--stack`.

## Why a separate orchestrator?

Claude Code sub-agents cannot themselves spawn sub-agents (one-level limit),
and a single long-running session bloats context. flow runs each phase as a
fresh `claude -p ...` subprocess; the orchestrator script itself carries no
LLM context. Each phase reads the task's markdown file, does its job, writes
its outputs back, and exits.

## Why skills live here too

The skills are usable on their own — Claude Code resolves them via `.claude/skills/`
regardless of whether flow's CLI ever runs. Bundling them in this repo means one
git remote, one install ritual, one place to evolve a skill. If flow as an
orchestrator ever falls out of favor, the skills survive: delete `src/`, keep
`skills/`.

## Notifications (macOS, opt-in)

flow can fire a desktop notification when a pipeline reaches an
attention-worthy state (`needs-human`, `gated`, `merged`, `aborted`,
`plan-pending-review`) so you can walk away from a long run.

Enable per-shell:

```sh
export FLOW_NOTIFY=1
```

Default is silent — leaving the variable unset (or set to anything other
than `1`) disables notifications entirely. Non-macOS platforms silently
no-op even with `FLOW_NOTIFY=1`.

flow uses [`terminal-notifier`](https://github.com/julienXX/terminal-notifier)
when it is on `PATH` (richer payload, click the notification to open the
PR in your browser) and falls back to the built-in `osascript display
notification` otherwise. To enable click-to-open-PR:

```sh
brew install terminal-notifier
```

Routine transitions (`triaged → planning → implementing → ...`) do not
fire notifications.

## Design

| You want | Read |
|---|---|
| The architectural rationale | [`docs/architecture.md`](docs/architecture.md) |
| The cross-phase data contract (`task.md`) | [`docs/task-schema.md`](docs/task-schema.md) |
| Milestone status + what's next | [`docs/roadmap.md`](docs/roadmap.md) |
| A specific phase's contract | `docs/phases/<phase>.md` |
| Project rules for agents working on flow | [`AGENTS.md`](AGENTS.md) |

If you're picking up the next milestone, start with
[`docs/phases/m2-plan.md`](docs/phases/m2-plan.md).
