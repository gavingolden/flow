# flow — agent guide

`flow` has two responsibilities in one repo:

1. A **tmux-driven multi-phase pipeline supervisor**. Each `flow new
   "<description>"` opens a tmux window running Claude Code, and the
   `/flow-pipeline` supervisor skill drives the full pipeline (triage →
   plan → worktree → implement → verify → CI → review → gate → merge)
   inside that one chat session. Sub-skills load in-process; helper
   scripts under `bin/` are Bash tool calls.
2. A **curated skill library** at `skills/` plus the helper binaries at
   `bin/` they shell out to. Both are distributed by `flow setup` (the
   global install). Skills are usable independent of the supervisor; the
   wrapper is just one consumer.

This file is the entry point for any agent (human or AI) working on flow.
Read it once at the start of a session.

## Where to look

| You want | Read |
|---|---|
| The current end-state architecture | `docs/roadmap.md` "End-state shape" + the supervisor SKILL at `skills/pipeline/flow-pipeline/SKILL.md` |
| Milestone status + what's next | `docs/roadmap.md` |
| The skill library structure | `skills/` (categorized: `pipeline/`, `universal/`, `stacks/`) |
| Generic engineering rules to copy into a new repo | `templates/AGENTS.md.template` |
| Historical context on the old Node orchestrator (deleted) | `docs/architecture.md`, `docs/phases/*.md` (kept as historical artefacts) |

If you're picking up a roadmap item, the order is: `roadmap.md` →
`skills/pipeline/flow-pipeline/SKILL.md` → the relevant sub-skill or
helper.

## Current state

See `docs/roadmap.md`. The redesign from a Node orchestrator to a
tmux-driven supervisor is complete: `src/`, the per-repo `flow install`,
and the orchestrator-only skills (`flow-add`, `flow-approve`,
`flow-revise`, `flow-watch`, `flow-status`) are deleted. The wrapper at
`bin/flow` is Bun; it dispatches verbs natively (`new`, `ls`, `attach`,
`done`, `setup`, `migrate`) with no passthrough fallback.

Note: `docs/phases/m2-plan.md`, `docs/phases/m3-plan.md`, and the rest
of `docs/phases/` describe the deleted orchestrator's phase contracts
— historical artefacts kept for context. New work uses the sequential
Item / Phase numbering from `docs/roadmap.md`.

## Code conventions

- **Runtime:** Bun for everything under `bin/`. `package.json`
  declares `engines.node >= 20` so `npm install` and `npm run test`
  (vitest) still work, but no shipped code is Node-specific.
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

Source for shipped helper binaries lives in **`bin/`**. The user-callable
helpers — `flow-new-worktree`, `flow-remove-worktree`, `flow-pre-commit`,
`flow-fetch-pr-review`, `flow-reply-pr-comments`, `flow-state-update`,
`flow-notify` — live there with `.ts` extensions, Bun shebangs, and
tests next door (`<name>.test.ts`). `flow setup` symlinks each into
`~/.local/bin/<name>` (extensionless on PATH).

The `flow` wrapper itself is also Bun, at `bin/flow`. It dispatches every
verb natively — there is no passthrough or legacy entry point.

Conventions for any script under `bin/`:

- `#!/usr/bin/env bun` shebang and `chmod +x`.
- Use `import.meta.main` (Bun's symlink-aware "is this the entry
  point?" check) to gate the `main()` call. Do **not** compare
  `import.meta.url` to `process.argv[1]` — that comparison breaks
  when the script is invoked through a symlink.
- Tests live next door as `<name>.test.ts` and run via vitest
  (`npm run test`). They're flow-internal: `flow setup` skips
  `*.test.ts` files when symlinking, since consumers don't need them
  on PATH.
- Source ≠ install target by design (`bin/` in flow's repo vs
  `~/.local/bin/` on the user's machine). Don't move scripts back to
  the install directory.

When adding a new script, default to Bun. If you need to deviate (e.g.
a Node-only dependency), confirm with the user first and document the
exception inline.

## Supervisor and sub-skills: in-process only

This is the load-bearing constraint for `/flow-pipeline`: the supervisor
is one Claude Code chat session, sub-skills (`/product-planning`,
`/new-feature`, `/verify`, `/pr-review`) load in-process via the `Skill`
tool, and helper scripts under `bin/` are Bash tool calls. The
supervisor never spawns the `Task` / `Agent` tool and never invokes
`claude -p ...` subprocesses. This sidesteps two limits at once:

1. Claude Code sub-agents can't spawn sub-agents (one-level cap).
2. A long-running supervisor with sub-agents would bloat past the
   context window.

If you find yourself adding logic that *needs* a separate LLM session,
redesign so the LLM lives in a sub-skill that loads in-process or a
helper script that doesn't need an LLM at all.

## Git workflow

- **Branches:** short, descriptive. The supervisor uses
  `flow-new-worktree` to create per-pipeline branches deterministically
  from the slug; humans can use `<type>/<topic>` for non-supervisor work.
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
npm run typecheck:scripts  # tsc -p tsconfig.scripts.json (bin/)
npm run test               # vitest run (bin/)
npm run verify             # typecheck:scripts + test
bun bin/flow setup         # global install (skills, agents, helpers, wrapper)
```

There is no `npm run build` — flow ships `bin/flow` directly via Bun;
no compile step.

## What flow is *not*

- The supervisor does not re-implement Claude Code skills inside its own
  process. It hosts a skill library at `skills/` and distributes it via
  symlink (`flow setup`); the wrapper at `bin/flow` only routes verbs to
  helper scripts and tmux. Pipeline behaviour lives in the
  `/flow-pipeline` supervisor skill, executed by Claude Code inside a
  tmux window.
- It is not a full SDLC tool. It does not host a web UI, post to Slack,
  open Jira tickets, or manage permissions.
- It is not a long-running daemon. Each `flow` invocation does one thing
  and exits. Per-pipeline state persists in `~/.flow/state/<slug>.json`
  and the tmux window's scrollback.

## Don'ts

- Don't bypass the helper scripts. The supervisor must always call
  `flow-new-worktree` / `flow-remove-worktree` / `flow-state-update`
  rather than reimplementing their behaviour with raw `git` / `gh` calls.
- Don't spawn sub-agents from the supervisor. See above.
- Don't add features beyond the current roadmap item's scope. The
  roadmap is ordered for a reason; later items depend on constraints
  earlier ones impose.
- Don't introduce a database. Markdown plan files plus
  `~/.flow/state/<slug>.json` are the state store until the queue gets
  unwieldy (then we swap in Beads via an adapter — see `docs/roadmap.md`
  "Future stretch").
- Don't auto-commit or auto-push without an explicit user instruction.
  Creating PRs counts as user-visible action — confirm before pushing.
  - **Auto-push exemption: `pr-review`.** The `pr-review` skill is exempt
    from the no-auto-commit and no-auto-push defaults — invoking
    `/pr-review` is itself the user's explicit instruction to commit and
    push the review-fix commit in the same run. The exemption is named
    and narrow: no other skill or agent flow is authorised to bypass the
    default. If a future skill needs the same license, add it here by
    name rather than generalising the rule.
  - **Auto-merge exemption: `/flow-pipeline` step 10 + 10.5.** The
    `/flow-pipeline` skill is exempt from the no-auto-commit / no-auto-
    push default for two narrow, named operations: (1) the documented
    `gh pr merge --squash --delete-branch <PR>` call inside step 10,
    only when the auto-merge gate fires (Manual-validation section
    empty) and only on a PR opened by `/flow-pipeline` itself; and (2)
    the post-merge roadmap-sweep commit inside step 10.5
    (`flow-roadmap-mark-shipped`), which runs unconditionally on
    successful merge to flip the PR's roadmap row from
    `🚧 in review (#N)` to `✅ shipped (#N)`. Invoking `/flow-pipeline`
    is itself the user's authorisation; opt out per-pipeline with
    `flow new --no-auto-merge` (the supervisor stops at the gated state
    regardless of the gate verdict). Same narrow-and-named contract as
    the `/pr-review` exemption above.
  - **Task-tool exemption: `/flow-pipeline` → `/pr-review` step 4.**
    `/flow-pipeline`'s "Hard rules" section forbids the supervisor
    from calling the `Task` / `Agent` tool, with one named exception:
    when `/flow-pipeline` step 8 loads `/pr-review`, `/pr-review`'s
    step 4 ("Independent Multi-Agent Review") spawns four review
    agents in parallel via the Task tool. Rationale: the supervisor
    is itself a top-level Claude Code session (started by `flow new`
    opening tmux + `claude`), so the one-level sub-agent cap doesn't
    apply to *its* Task calls; and `/pr-review` step 4 is one-shot,
    not long-running, so the context-bloat constraint also doesn't
    apply. This is the **only** authorised Task-tool fan-out from
    `/flow-pipeline`; no other skill or step may call Task. The
    contract is documented bidirectionally in
    `skills/pipeline/flow-pipeline/SKILL.md` "Hard rules" and
    `skills/pipeline/pr-review/SKILL.md` step 4 preamble. Same
    narrow-and-named contract as the `/pr-review` and `/flow-pipeline`
    exemptions above.
