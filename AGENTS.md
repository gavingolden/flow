# flow — agent guide

`flow` has two responsibilities in one repo:

1. A **multi-phase AI dev orchestrator**. One prompt classifies into a
   no-change flow (Q&A, brainstorm) or a change flow (triage → plan → worktree
   → implement → verify → CI → review → gate → merge). It targets any git
   repository and drives Claude Code skills via headless subprocess invocations.
2. A **curated skill library** at `skills/` plus the helper binaries at
   `bin/` they shell out to. Both are distributed by `flow setup`
   (the new global install) and `flow install` (the legacy per-repo
   install, retained until PR 5 of the redesign deletes it). Skills are
   usable independent of the orchestrator; the CLI is just one consumer.

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

See `docs/roadmap.md`. flow is mid-redesign — moving from a Node-based
orchestrator to a tmux-driven supervisor skill.

- **PR 1 (this work) — global install + shell wrapper.** Adds `flow
  setup`, `flow new`, `flow ls`, `flow attach`, `flow done`,
  `flow migrate`. Migrates 5 helpers from `templates/scripts/` to `bin/`
  with backward-compat symlinks. Old verbs (`run`, `log`, `status`,
  `approve`, `revise`, `install`) keep working via passthrough to
  `src/cli.ts`.
- **Pre-redesign orchestrator (Phases 1–4)** shipped — runs end-to-end
  in any flow-installed repo. The new design replaces it incrementally;
  PR 4 of the redesign deletes `src/`.

Note: `docs/phases/m2-plan.md` and `docs/phases/m3-plan.md` use the
legacy `M<N>` syntax — they're historical artefacts kept for
reference. New work uses the sequential PR / Phase numbering from
`docs/roadmap.md`.

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

## Scripts: Bun runtime, distributed via symlinks

Source for shipped helper binaries lives in **`bin/`** as of PR 1 of the
redesign. The five user-callable helpers — `flow-new-worktree`,
`flow-remove-worktree`, `flow-pre-commit`, `flow-fetch-pr-review`,
`flow-reply-pr-comments` — live there with `.ts` extensions, Bun
shebangs, and tests next door (`<name>.test.ts`). `flow setup` symlinks
each into `~/.local/bin/<name>` (extensionless on PATH).

`templates/scripts/` retains:

- **Symlinks back to `bin/<name>.ts`** for the migrated helpers — keeps
  legacy `flow install` working without duplicating logic.
- **The orchestrator-only scripts** (`ci-wait.ts`, `flow-add.ts`,
  `flow-watch.ts`) until PR 5 of the redesign deletes them along with
  the orchestrator that calls them.

The new `flow` wrapper itself is also Bun, at `bin/flow`. It dispatches
new verbs natively (`new`, `ls`, `attach`, `done`, `setup`, `migrate`)
and shells out to `bun src/cli.ts <verb> $@` for legacy verbs (`run`,
`start`, `log`, `status`, `approve`, `revise`, `install`).

Conventions for any script under `bin/` or `templates/scripts/`:

- `#!/usr/bin/env bun` shebang and `chmod +x`.
- Use `import.meta.main` (Bun's symlink-aware "is this the entry
  point?" check) to gate the `main()` call. Do **not** compare
  `import.meta.url` to `process.argv[1]` — that comparison breaks
  when the script is invoked through a symlink.
- Tests live next door as `<name>.test.ts` and run via vitest
  (`npm run test`). They're flow-internal: the install excludes
  `*.test.ts` because consumer vitest configs typically refuse to load
  files outside the workspace root, and the test imports use Bun-only
  APIs that wouldn't run anyway. `flow install --force` deletes any
  stale companion `*.test.ts` files left behind by a prior pre-flow
  setup (and untracks them from git).
- Source ≠ install target by design (`bin/` and `templates/scripts/` in
  flow's repo vs `scripts/` and `~/.local/bin/` on the consumer's
  machine). Don't move scripts back to the consumer-side install
  directories.

The legacy CLI under `src/` is still Node + tsx. The new wrapper at
`bin/flow` is Bun — Bun runs the existing Node/TS source as-is for the
old-verb passthrough, which is what makes the additive cutover possible.
Once PR 4 of the redesign deletes `src/`, the wrapper's only runtime is
Bun and the AGENTS.md "Bun is *only* a script runtime" rule lapses
naturally.

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
- **PRs:** Why / What / Key decisions / User-facing changes / How to test,
  in that order. The Why must read as a problem statement, not a feature spec.
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
npm run typecheck:scripts  # tsc -p tsconfig.scripts.json (bin/ + templates/scripts/)
npm run test               # vitest run (bin/ + templates/scripts/ + src/)
npm run dev install        # legacy: symlink skills + scripts into the current repo
bun bin/flow setup         # global install (replaces npm link)
npm link                   # legacy: also makes `flow` available globally
```

The build script chmods `dist/cli.js` so direct invocation works locally
(npm install/link does this for you when published).

## What flow is *not*

- The orchestrator does not re-implement Claude Code skills inside its own
  process. It hosts a skill library at `skills/` and distributes it via symlink
  (`flow install`); the CLI itself only invokes skills via headless
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
  until the queue gets unwieldy (then we swap in Beads via an adapter
  — see `docs/roadmap.md` "Future stretch").
- Don't auto-commit or auto-push without an explicit user instruction.
  Creating PRs counts as user-visible action — confirm before pushing.
  - **Auto-push exemption: `pr-review`.** The `pr-review` skill is exempt
    from the no-auto-commit and no-auto-push defaults — invoking
    `/pr-review` is itself the user's explicit instruction to commit and
    push the review-fix commit in the same run. The exemption is named
    and narrow: no other skill or agent flow is authorised to bypass the
    default. If a future skill needs the same license, add it here by
    name rather than generalising the rule.
