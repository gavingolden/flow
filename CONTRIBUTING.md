# Contributing to flow

This is the developer/maintainer guide for working **on** flow itself. If you only want to _use_ flow, the [README](README.md) is the front door, and [docs/getting-started.md](docs/getting-started.md) walks you through your first pipeline. The canonical rules every agent (human or AI) must follow live in [`AGENTS.md`](AGENTS.md) — read that first; this file covers the mechanical how-to.

## Dev setup

```sh
npm install                # one-time
npm run typecheck:scripts  # tsc -p tsconfig.scripts.json (bin/)
npm run test               # vitest run (bin/)
npm run verify             # typecheck:scripts + test + lint
bun bin/flow install         # global install (skills, helpers, wrapper)
```

There is no `npm run build` — flow ships `bin/flow` directly via Bun, so there is no compile step. `.github/workflows/ci.yml` runs `npm run verify` on every PR and push to `main` as the server-side backstop for the local-only `flow-pre-commit` gate.

## Code conventions

Everything under `bin/` runs on Bun (`#!/usr/bin/env bun`, gated by `import.meta.main`); `package.json` declares `engines.node >= 20` only so `npm install` and the vitest suite still work. Keep modules small and single-purpose (target < 200 lines), default to no comments (add one only when the _why_ is non-obvious), validate at boundaries, and avoid premature abstractions and backwards-compat shims. [`AGENTS.md`](AGENTS.md) is the canonical and complete statement of these rules — this paragraph is a summary, not a substitute.

## Architecture

A flow pipeline is one Claude Code chat session. Sub-skills (`/flow-product-planning`, `/flow-new-feature`, `/flow-verify`, `/flow-pr-review`) load **in-process** as skill instructions rather than as nested sub-agents, and helper scripts under `bin/` are plain Bash tool calls. The supervisor never spawns nested LLM sessions except at a small set of named `Task`-tool exemptions — one of which, the Verify-Retry-Loop → edit-applier site, itself nests one level deeper (depth 3), the one place flow deliberately nests. This is flow's own deliberate flat-fan-out policy, not a platform limit: nesting has been platform-possible since Claude Code v2.1.172, but is ruinously token-expensive and hard to observe (see `docs/nested-subagents-assessment.md`). The policy sidesteps deep sub-agent fan-out and the context-window bloat a long-running parent would accrue if it fanned out into deep agent trees. The full rationale lives in [`docs/target-architecture.md`](docs/target-architecture.md).

## Setup internals

`flow install` is the only install entry point. It:

- Symlinks every selected skill from `skills/{pipeline,universal,stacks}/` into the standalone skills home at `~/.flow/claude-home/.claude/skills/` (not the global `~/.claude/skills/`), so a plain `claude` session carries zero flow skills — only `flow`-launched and pipeline/epic seed sessions (which pass `--add-dir ~/.flow/claude-home`) see them. A pre-retarget install migrates on the next `flow install --upgrade`.
- Symlinks each helper under `bin/` (`flow-new-worktree`, `flow-remove-worktree`, `flow-pre-commit`, `flow-fetch-pr-review`, `flow-reply-pr-comments`, `flow-state-update`, and the rest) into `~/.local/bin/<name>` (extensionless, `*.test.ts` skipped). The two schema validators `flow-pr-review-result-schema` and `flow-agent-finding-schema` are sourced from `bin/lib/*-schema.ts` via an explicit allowlist and symlinked the same way.
- Symlinks the `flow` wrapper itself into `~/.local/bin/flow` and records every symlink in `~/.flow/installed.json` so `flow install --upgrade` can reap orphans deterministically.
- Verifies `tmux` is on `PATH` (a hard requirement) and that every declared runtime dependency resolves from the source root, warning if `~/.local/bin/` is missing from `PATH`.

Update with `cd <flow-checkout> && git pull && flow install --upgrade`.

**Shell completions.** `flow install` installs bash and zsh tab completion automatically. The scripts ship under `completions/`, are symlinked into `~/.flow/completions/flow.<shell>`, and `flow install` writes a marker-bracketed managed block into each of `~/.zshrc`, `~/.bashrc`, `~/.bash_profile` **if they already exist** (it never creates an rc file you don't have). Opt out with `flow install --no-completions`, which removes the block and leaves the rest of the file byte-identical. For read-only homedirs or CI, use `eval "$(flow completion bash)"` / `eval "$(flow completion zsh)"`.

**Copilot review escape hatch.** `flow feature create --copilot-review <auto|always|never>` (default `auto`) controls per-PR Copilot review requests. The durable, declarative override is `bots.copilotAutoReview: true | false` in `~/.flow/config.json`: it is consulted first and short-circuits both the authoritative ruleset read and the 5-PR historical heuristic with zero `gh` calls — `true` declares Copilot already reviews every PR (flow skips its own request), `false` declares it does not, and **unset** keeps the auto-detect behavior. It is the right escape hatch when the ruleset API is unreachable (e.g. a private repo on a free account where the rules endpoint 403s). Per-repo glob overrides live under `bots.copilot.globs`. Note that GitHub's repo-level automatic Copilot review must be disabled in the GitHub UI for the opt-in to take effect — there is no stable API to toggle it.

## Releasing

flow is a symlink-distributed tool: a "release" tags the canonical `main` checkout, it does **not** publish to any registry. Users update by pulling `main` and re-running `flow install --upgrade`; the tag and bumped version exist so the staleness check in [`bin/lib/update-check.ts`](bin/lib/update-check.ts) can compare versions, not just commits, when surfacing its upgrade notice.

The ritual, from a clean `main` checkout:

```sh
bun bin/flow-release <patch|minor|major>   # maintainer-only; not on PATH, run from the checkout
git push --follow-tags                     # publish the release commit and the vX.Y.Z tag
```

`flow-release` bumps `package.json` + `package-lock.json`, commits a `chore(release): vX.Y.Z`, and creates an annotated `vX.Y.Z` tag — atomically, via `npm version <type>` under the hood (run `npm version <type>` directly if the helper is unavailable). It never pushes; that final `git push --follow-tags` is yours.

Post-1.0 versioning policy:

- **major** — a breaking change to the flow CLI contract or the skill-distribution layout.
- **minor** — new skills, helpers, or CLI surface.
- **patch** — fixes, docs, internal-only changes.

This bump is a deliberate, periodic maintainer ritual — **not** a per-PR auto-bump. flow-pipeline runs that build flow itself never touch the version. Commit/PR conventions for the release commit follow the usual rules in [`AGENTS.md`](AGENTS.md) Git workflow.

## Project rules for agents & contributors

All project-wide rules — commit/PR conventions, the output style, the `Task`-tool exemptions, the verify gate, consumer-repo notes — are in [`AGENTS.md`](AGENTS.md), which is canonical (`CLAUDE.md` is just `@AGENTS.md`). Don't duplicate those rules here; link to them.

## Tips

### tmux status integration (optional)

> **This is optional user tmux config, not something flow ships or requires.** flow never writes to your `~/.tmux.conf`, and `flow ls` remains the canonical status surface. The recipe below is yours to copy, adapt, or ignore.

flow's topology is one tmux session with many pipeline windows, so it's easy to lose track of which Claude Code sessions are actively working versus idle or waiting on you. If you run Claude Code inside tmux, you can color or glyph each window by session state using Claude Code's lifecycle hooks to set a window-scoped tmux option.

The mechanism: a tiny hook script sets a `@claude_state` window option on the pane's window, and `window-status-format` branches on it.

**Caveat:** `@claude_state` is keyed on generic Claude-Code session activity (the `UserPromptSubmit` / `Stop` / `Notification` lifecycle), **not** on flow's pipeline phase. It's a coarse running-vs-paused proxy — useful for "is this session busy?", not for "what phase is this pipeline in?". For the phase, use `flow ls` — or bind flow's own `@flow-phase` window option, described in the next section, which needs no hook script because flow sets it for you. Both `@claude_state` and `@flow-phase` are deliberately distinct from flow's `@flow-slug` identity option, so none of them collide.

#### 1. A hook script

Save this as `~/.claude/hooks/tmux-state.sh` and `chmod +x` it. It takes the state as its first argument and is a no-op outside tmux:

```bash
#!/usr/bin/env bash
# Reflect Claude Code session state onto the containing tmux window.
[ -n "$TMUX_PANE" ] || exit 0
tmux set-option -t "$TMUX_PANE" -w @claude_state "${1:-idle}"
```

#### 2. Wire it to the three Claude Code hooks

In your Claude Code settings (`~/.claude/settings.json`), call the script from each lifecycle hook — `UserPromptSubmit` when a turn starts (working), `Stop` when it finishes (idle), `Notification` when Claude is waiting on you (waiting):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/tmux-state.sh working"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/tmux-state.sh idle" }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/tmux-state.sh waiting"
          }
        ]
      }
    ]
  }
}
```

The event names above are illustrative — confirm they match your installed Claude Code version, and adapt the mapping if yours differs.

#### 3. Color the window list

In `~/.tmux.conf`, branch `window-status-format` (and its current-window twin) on `@claude_state`:

```tmux
# waiting → yellow, working → green, idle/unset → default
set -g window-status-format         "#{?#{==:#{@claude_state},waiting},#[fg=yellow],#{?#{==:#{@claude_state},working},#[fg=green],}}#I:#W#[default]"
set -g window-status-current-format "#{?#{==:#{@claude_state},waiting},#[fg=yellow bold],#{?#{==:#{@claude_state},working},#[fg=green bold],#[bold]}}#I:#W#[default]"
```

Prefer a glyph to a color? Swap the `#[fg=...]` branches for a prefix like `● `, `◐ `, or `○ ` ahead of `#I:#W`.

### Phase-accurate windows with `@flow-phase` (optional)

> **Also optional user tmux config.** flow _publishes_ the value onto its own windows but ships no theme, never writes your `~/.tmux.conf`, and `flow ls` stays the canonical status surface. Binding it is yours to opt into.

Where the `@claude_state` recipe above needs a hook script you wire up yourself and only tells you whether a session is busy, flow sets a `@flow-phase` window option **automatically** that carries the pipeline's actual phase — `starting`, `triaging`, `planning`, `implementing`, `verifying`, `ci-wait`, `reviewing`, `gating`, `merging`, and the terminal/pending phases (`gated`, `merged`, `needs-human`, `cancelled`, …). It mirrors the `phase` field flow already writes to `~/.flow/state/<slug>.json`: seeded to `starting` when the window is created, then updated at every transition the supervisor drives. So a window bound to it answers "what phase is this pipeline in?" at a glance — the question `@claude_state` can't.

No hook setup is required; the only thing you opt into is reading it in your own `window-status-format`:

```tmux
# Show flow's pipeline phase per window; blank for non-flow windows.
set -g window-status-format         "#I:#W#{?#{@flow-phase}, [#{@flow-phase}],}"
set -g window-status-current-format "#I:#W#{?#{@flow-phase}, [#{@flow-phase}],}"
```

You can combine it with the `@claude_state` colors above — color by activity, label by phase — since the two options are independent. Publishing is best-effort: if tmux can't be reached, flow still writes `~/.flow/state/<slug>.json` (the source of truth) and never fails a transition over it.
