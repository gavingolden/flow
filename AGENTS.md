# flow — agent guide

`flow` has two responsibilities in one repo:

1. A **multi-phase AI dev orchestrator**. One prompt classifies into a
   no-change flow (Q&A, brainstorm) or a change flow (triage → plan → worktree
   → implement → verify → CI → review → gate → merge). It targets any git
   repository and drives Claude Code skills via headless subprocess invocations.
2. A **curated skill library** at `skills/`, distributed via `flow install-skills`
   into target repos and `~/.claude/skills/`. Skills are usable independent of
   the orchestrator; the CLI is just one consumer.

This file is the entry point for any agent (human or AI) working on flow.
Read it once at the start of a session.

## Where to look

| You want | Read |
|---|---|
| The design and *why* behind the orchestrator | `docs/architecture.md` |
| The cross-phase data contract (`task.md`) | `docs/task-schema.md` |
| Milestone status + what's next | `docs/roadmap.md` |
| A specific phase's contract | `docs/phases/<phase>.md` |
| The detailed plan for the next milestone | `docs/phases/m<N>-plan.md` |
| The skill library structure | `skills/` (categorized: `pipeline/`, `universal/`, `stacks/`) |
| Generic engineering rules to copy into a new repo | `templates/AGENTS.md.template` |

If you're picking up a milestone, the order is: `architecture.md` →
`task-schema.md` → `roadmap.md` → the phase doc(s) you're implementing.

## Current state

See `docs/roadmap.md`. As of now:

- **M1 shipped.** Triage phase + CLI scaffold (`flow start`).
- **M2 next.** Phases 1–3 (plan, worktree, implement) — see
  `docs/phases/m2-plan.md`.

## Code conventions

- **Runtime:** Node ≥ 20, ESM, TypeScript strict.
- **Style:** small, single-purpose modules. Target < 200 lines/file.
- **Comments:** default to none. Add one only when the *why* is non-obvious
  (a constraint, a workaround, a subtle invariant). Don't restate what the
  code does.
- **Errors:** validate at boundaries (CLI args, subprocess output, parsed
  YAML). Trust internal callers. No defensive checks for things that can't
  happen.
- **No premature abstractions.** A phase is just a function. Don't introduce
  a `Phase` class hierarchy until two phases share enough behaviour to
  justify it.
- **No backwards-compat shims.** flow has no users yet. Refactor freely.

## Scripts: Bun runtime

Every executable script under `scripts/` uses `#!/usr/bin/env bun` and
must be `chmod +x`. Tests live alongside as `*.test.ts` and run via
vitest (`npm run test`).

The CLI itself (`src/`) is Node + tsx — see "Code conventions" above.
The two runtimes are independent: the orchestrator invokes target-repo
scripts directly via their shebang, so a script's runtime choice
doesn't leak into the CLI's dependency graph. Bun is *only* a script
runtime, never a CLI runtime.

When adding a new script, default to Bun. If you need to deviate (e.g.
a target-repo install needs Node-only), confirm with the user first
and document the exception inline.

## The orchestrator carries no LLM context

This is the load-bearing constraint. The CLI is plain Node — Claude only
runs in spawned subprocesses, never inside the orchestrator's own process.
This sidesteps two limits at once:

1. Claude Code sub-agents can't spawn sub-agents (one-level cap).
2. A long-running Claude session would bloat past the context window.

If you find yourself adding logic that *needs* an LLM in the orchestrator,
redesign so the LLM lives in a phase subprocess and the orchestrator just
reads/writes files.

## Git workflow

- **Branches:** short, descriptive. `m<N>-<topic>` for milestone work
  (e.g. `m1-triage`, `m2-implement-pipeline`). Otherwise `<type>/<topic>`.
- **Commits:** conventional commits (`feat:`, `fix:`, `chore:`, `docs:`,
  `refactor:`, `test:`). Imperative summary ≤ 50 chars. Body explains
  *why* — motivation, non-obvious choices, what was tried and didn't work.
  Trivial changes (typo, dep bump) may omit the body.
- **PRs:** Why / What / Key decisions / How to test, in that order. The
  Why must read as a problem statement, not a feature spec.
- **Never amend pushed commits.** Make a new commit instead.
- **Never force-push** without explicit user request.

Pass multi-line messages through a heredoc:

```sh
git commit -F - <<'EOF'
feat: short summary

Why: …
Approach: …
EOF
```

## Development

```sh
npm install                # one-time
npm run dev -- <args>      # tsx, no build
npm run build              # tsc + chmod +x dist/cli.js
npm run typecheck          # tsc --noEmit (src/ only)
npm run typecheck:scripts  # tsc -p tsconfig.scripts.json (scripts/ only)
npm run test               # vitest run (scripts/ + src/)
npm link                   # makes `flow` available on PATH globally
```

The build script chmods `dist/cli.js` so direct invocation works locally
(npm install/link does this for you when published).

## What flow is *not*

- The orchestrator does not re-implement Claude Code skills inside its own
  process. It hosts a skill library at `skills/` and distributes it via symlink
  (`flow install-skills`); the CLI itself only invokes skills via headless
  `claude -p ...` calls in subprocesses.
- It is not a full SDLC tool. It does not host a web UI, post to Slack,
  open Jira tickets, or manage permissions.
- It is not a long-running daemon. Each `flow` invocation does one thing
  and exits. State persists on disk in the target repo's `.orchestrator/`.

## Don'ts

- Don't add LLM logic to the orchestrator itself. See above.
- Don't add features beyond the current milestone scope. The roadmap is
  ordered for a reason; later milestones depend on the constraints earlier
  ones impose.
- Don't introduce a database. Markdown plan files are the state store
  until the queue gets unwieldy (then we swap in Beads via an adapter —
  M6).
- Don't auto-commit or auto-push without an explicit user instruction.
  Creating PRs counts as user-visible action — confirm before pushing.
