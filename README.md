# flow

Multi-phase AI agent dev orchestration. One prompt → triage → (optionally)
plan → worktree → implement → verify → CI → review → gate → merge.

Inspired by WAVE, minus the enterprise integrations. Drives existing
[Claude Code](https://docs.claude.com/en/docs/claude-code) skills via
headless subprocess invocations, with markdown plan files as the cross-phase
state store.

## Status

**M1 only.** `flow start "<prompt>"` opens an interactive Claude Code
session in the current git repo with a triage system prompt. The session
either answers a no-change request in-line (Q&A, brainstorm) or writes a
structured `task.md` to `.orchestrator/tasks/` for the pipeline to pick up.

The pipeline phases (plan, worktree, implement, verify, CI, review, gate,
merge) ship in M2–M4.

## Install (dev)

```sh
npm install
npm run build
npm link        # makes `flow` available on PATH
```

## Use

From inside any git repository:

```sh
flow start "add a portfolio allocation chart to the dashboard"
flow start "explain how the FRED manifest works"
```

The first opens triage and writes `.orchestrator/tasks/<id>.md`. The second
answers in-line and exits with no file written.

Add `.orchestrator/` to your project's `.gitignore`.

## Why a separate orchestrator?

Claude Code sub-agents cannot themselves spawn sub-agents (one-level limit),
and a single long-running session bloats context. flow runs each phase as a
fresh `claude -p ...` subprocess; the orchestrator script itself carries no
LLM context. Each phase reads the task's markdown file, does its job, writes
its outputs back, and exits.

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
