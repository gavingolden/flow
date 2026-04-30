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

**M1 only.** `flow start "<prompt>"` opens an interactive Claude Code
session in the current git repo with a triage system prompt. The session
either answers a no-change request in-line (Q&A, brainstorm) or writes a
structured `task.md` to `.orchestrator/tasks/` for the pipeline to pick up.

The pipeline phases (plan, worktree, implement, verify, CI, review, gate,
merge) ship in M2–M4.

## Install (dev)

```sh
npm install     # `prepare` builds dist/ automatically
npm link        # makes `flow` available on PATH
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
attention-worthy state (`needs-human`, `gated`, `merged`, `aborted`) so you
can walk away from a long run.

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
