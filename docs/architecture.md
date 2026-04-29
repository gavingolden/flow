# Architecture

The whole design exists to satisfy three constraints. Everything else
follows.

## The three constraints

1. **Sub-agent depth limit.** Claude Code sub-agents (those spawned via
   the Task / Agent tool) cannot themselves spawn sub-agents. The graph
   is one level deep. So a "delegate further" pattern hits a wall fast.
2. **Context bloat.** A single long-running Claude Code session
   accumulates conversation, tool results, file reads. By the time a
   workflow has gone through plan → implement → verify → CI → review,
   any one session is full.
3. **Independent parallel tasks.** The user wants to queue several
   unrelated requests and have them run sequentially or in parallel.
   Sharing one Claude session across them is a non-starter (mixing
   contexts) and so is naive sub-agent fan-out (depth limit).

## The pattern that satisfies all three

**Spawn a fresh Claude Code subprocess per phase.** The orchestrator is a
plain Node script that calls `claude -p "<phase prompt>"` and waits for
exit, then moves on. The orchestrator script accumulates *no* LLM
context. Each phase gets a clean window. Multiple tasks run as multiple
worktrees with their own pipelines, in parallel.

This is what `claude-flow` and Goose Recipes do, and what WAVE
approximates with persona switching inside one session — except we get
true context isolation by using OS-level processes.

```
                  ┌─────────────────────────────────────┐
   You ─────────► │  flow CLI (TS, no LLM)              │
                  └────────────┬───────────┬────────────┘
                               │           │
                  spawns       │           │  spawns (subprocess per phase)
              (interactive)    │           │
                               ▼           ▼
                    ┌──────────────┐   ┌─────────────────────────┐
                    │  Triage      │   │  Pipeline runner        │
                    │  Claude      │──►│  - reads task.md        │
                    │  session     │   │  - claude -p per phase  │
                    │  (M1)        │   │  - retries / loops      │
                    │              │   │  - auto-merge gate      │
                    └──────────────┘   └────────────┬────────────┘
                                                    │
                                                    ▼ writes & reads
                                       ┌─────────────────────────┐
                                       │  .orchestrator/tasks/   │
                                       │   <task-id>.md          │
                                       └─────────────────────────┘
```

## Hybrid: interactive triage, scripted pipeline

The orchestrator has two halves with different runtime profiles.

- **Triage runs as an interactive Claude session.** A real conversation
  is required — the user is challenged on assumptions, offered
  alternatives, and asked clarifying questions. Outcome is either an
  in-line answer (no-change) or a written `task.md` (change). Triage
  is M1.
- **The rest of the pipeline runs in the script.** Once a `task.md`
  exists, every subsequent phase is deterministic enough to script:
  invoke `claude -p` with a focused prompt, parse JSON output, decide
  retry / proceed / escalate, write outputs back to `task.md`. Phases
  1–8 are M2–M4.

Conversation/judgment lives in the LLM; scheduling, retries, and IO
live in the script.

## The phase contract

Every phase — interactive or headless — exposes the same interface.

```ts
type PhaseResult =
  | { status: "ok" }
  | { status: "retry"; reason: string }       // bounded re-invocation
  | { status: "needs-human"; reason: string } // pause, exit
  | { status: "failed"; reason: string };     // abort

function runPhase(taskPath: string): Promise<PhaseResult>
```

Phases are pure with respect to in-memory state: they read `task.md`,
do their work, append to the task file's phase log and outputs, and
return a status. The next phase reads the same file. If a phase
crashes, the file persists; rerunning the pipeline is safe.

This is the "anchored summarization" pattern from research: agents
don't pass conversation between each other, they pass *artifacts*
(files), and each agent's input is a structured summary it knows how
to read.

## The pipeline (full set)

| # | Phase | Type | Skill / action | On failure |
|---|---|---|---|---|
| 0 | triage | Claude session (interactive) | `--append-system-prompt` triage rules | n/a — owned by user |
| 1 | worktree | script (no LLM) | `scripts/new-agent-worktree.ts` (target repo) + symlink `.orchestrator/` from main repo | abort |
| 2 | plan | headless (in worktree) | `/product-planning` | retry once with error appended |
| 3 | implement | headless (in worktree) | `/new-feature` | retry once |
| 4 | verify | headless (in worktree) | `/verify` | retry up to 3x; then `needs-human` |
| 5 | ci | script | poll `gh pr checks` until terminal; collect auto-reviewer findings | on red, loop back to implement with the failure log; cap 3 |
| 6 | review | headless | `/pr-review` | on critical findings, loop back to implement; cap 2 |
| 7 | gate | script | parse PR body's "Manual validation" section | n/a — outcome is the decision |
| 8 | merge | script | `gh pr merge --squash --delete-branch` + remove worktree | abort with clear status |

Phases 2, 3, 4, 6 are headless Claude Code subprocess invocations of
skills that already exist in the target project (econ-data has them
today). Phases 1, 5, 7, 8 are pure script work — no LLM cost.

The worktree phase runs first (right after triage) so every subsequent
headless phase, including plan, executes inside a per-task worktree.
The new worktree gets a `.orchestrator/` directory symlink pointing at
the main repo's `.orchestrator/`, so task files and plan dirs remain a
single source of truth regardless of which worktree the phase runs
from. This is what unblocks running `flow run` against multiple tasks
in the same target repo concurrently — different worktrees, different
branches, different working trees, but one shared task store.

## State store: markdown plan files

One file per task at `<target-repo>/.orchestrator/tasks/<id>.md`.
WAVE-style: YAML frontmatter for indexable fields, markdown sections
for everything else. Schema is in `docs/task-schema.md`.

Why markdown and not a database:

- Human-readable. You can `cat` a task and understand its state.
- Git-friendly. The user can `.gitignore` `.orchestrator/` or commit
  it for traceability — both work.
- Zero deps. No SQLite, no Dolt, no daemon.

When this becomes painful (large queues, multi-machine, dependency
graphs across tasks) we swap in Steve Yegge's [Beads](https://github.com/steveyegge/beads)
behind a state-store interface. M6.

## Auto-merge rule

Defined once on the PR description, read by the gate phase.

The PR template (used by phase 3, *implement*) includes a `## Manual
validation` section. The implement phase fills it with steps when
heuristics flag the change as risky (DB migration, external API
integration, UI change, behaviour change to a critical path), and
leaves it empty for pure refactors / internal logic / docs.

The gate phase reads `gh pr view <pr> --json body`, strips HTML
comments from the section, and decides:

- Section non-empty ⇒ `needs-human`. The pipeline pauses; the user
  merges manually after performing the documented validation.
- Section empty ⇒ proceed to merge.

This pushes the human-in-loop decision into the PR description itself
— exactly where it belongs. Reviewers see it. Future readers see it.
The orchestrator just reads the artifact.

## Why headless subprocess and not SDK

We could build phases on top of the Claude Agent SDK in TypeScript
directly. Reasons we don't, today:

- The skills we're driving (`/product-planning`, `/new-feature`,
  `/pr-review`, `/verify`) already exist as Claude Code slash commands
  with mature prompt engineering. Re-implementing their behaviour
  through the SDK would be a multi-week detour with no functional gain.
- `claude -p "<prompt>"` already gives us scoped tools (`--allowed-tools`),
  JSON output, working directory control, and exit codes. That's the
  surface area we need.
- Subprocess isolation is the simplest possible answer to context
  bloat. There's no in-process state to leak.

If we ever want phases that don't map to existing skills (e.g. a custom
"diff scoring" phase), we revisit.

## Technology choices

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 20+ | ESM, top-level await, `fs/promises`, AbortController. Universal. |
| Language | TypeScript strict | Catches phase-output schema errors before subprocess errors do. |
| CLI | `commander` | Mature, small, no surprises. |
| Subprocess | `execa` | Cleaner stdio handling than child_process. |
| Frontmatter | `gray-matter` | Battle-tested YAML+markdown parser. |
| Color | `picocolors` | Lighter than chalk, same API. |
| Package manager | npm | User preference. |
| Build | `tsc` + `tsx` (dev) | No bundler — bin runs from `dist/`. |

## What the new repo *adds* and what the target repo *already has*

`flow` is a generic CLI. It assumes the target repo provides:

- A git repo (so `git rev-parse --show-toplevel` works).
- Skills in `.claude/skills/`: `product-planning`, `new-feature`,
  `verify`, `pr-review`, plus the worktree scripts.
- The `gh` CLI authenticated for the repo's GitHub remote.
- A pre-commit / pre-push setup such that `npm run verify`-style
  commands return clean when the working tree is clean.

If a target repo lacks one of these, the relevant phase fails with a
clear message. The orchestrator does not auto-install anything in the
target.
