# Contributing to flow

This is the developer/maintainer guide for working **on** flow itself. If you only want to _use_ flow, the [README](README.md) is the front door. The canonical rules every agent (human or AI) must follow live in [`AGENTS.md`](AGENTS.md) — read that first; this file covers the mechanical how-to.

## Dev setup

```sh
npm install                # one-time
npm run typecheck:scripts  # tsc -p tsconfig.scripts.json (bin/)
npm run test               # vitest run (bin/)
npm run verify             # typecheck:scripts + test + lint
bun bin/flow setup         # global install (skills, helpers, wrapper)
```

There is no `npm run build` — flow ships `bin/flow` directly via Bun, so there is no compile step. `.github/workflows/ci.yml` runs `npm run verify` on every PR and push to `main` as the server-side backstop for the local-only `flow-pre-commit` gate.

## Code conventions

Everything under `bin/` runs on Bun (`#!/usr/bin/env bun`, gated by `import.meta.main`); `package.json` declares `engines.node >= 20` only so `npm install` and the vitest suite still work. Keep modules small and single-purpose (target < 200 lines), default to no comments (add one only when the _why_ is non-obvious), validate at boundaries, and avoid premature abstractions and backwards-compat shims. [`AGENTS.md`](AGENTS.md) is the canonical and complete statement of these rules — this paragraph is a summary, not a substitute.

## Architecture

A flow pipeline is one Claude Code chat session. Sub-skills (`/product-planning`, `/new-feature`, `/verify`, `/pr-review`) load **in-process** as skill instructions rather than as nested sub-agents, and helper scripts under `bin/` are plain Bash tool calls. The supervisor never spawns nested LLM sessions except at a small set of named `Task`-tool exemptions. This sidesteps two limits at once: Claude Code's one-level sub-agent cap, and the context-window bloat a long-running parent would accrue if it fanned out into deep agent trees. The full rationale lives in [`docs/architecture.md`](docs/architecture.md).

## Setup internals

`flow setup` is the only install entry point. It:

- Symlinks every skill from `skills/{pipeline,universal,stacks}/` into `~/.claude/skills/`, so every project sees the same skills with zero per-repo footprint.
- Symlinks each helper under `bin/` (`flow-new-worktree`, `flow-remove-worktree`, `flow-pre-commit`, `flow-fetch-pr-review`, `flow-reply-pr-comments`, `flow-state-update`, and the rest) into `~/.local/bin/<name>` (extensionless, `*.test.ts` skipped). The two schema validators `flow-pr-review-result-schema` and `flow-agent-finding-schema` are sourced from `bin/lib/*-schema.ts` via an explicit allowlist and symlinked the same way.
- Symlinks the `flow` wrapper itself into `~/.local/bin/flow` and records every symlink in `~/.flow/installed.json` so `flow setup --upgrade` can reap orphans deterministically.
- Verifies `tmux` is on `PATH` (a hard requirement) and that every declared runtime dependency resolves from the source root, warning if `~/.local/bin/` is missing from `PATH`.

Update with `cd <flow-checkout> && git pull && flow setup --upgrade`.

**Shell completions.** `flow setup` installs bash and zsh tab completion automatically. The scripts ship under `completions/`, are symlinked into `~/.flow/completions/flow.<shell>`, and `flow setup` writes a marker-bracketed managed block into each of `~/.zshrc`, `~/.bashrc`, `~/.bash_profile` **if they already exist** (it never creates an rc file you don't have). Opt out with `flow setup --no-completions`, which removes the block and leaves the rest of the file byte-identical. For read-only homedirs or CI, use `eval "$(flow completion bash)"` / `eval "$(flow completion zsh)"`.

**Copilot review escape hatch.** `flow new --copilot-review <auto|always|never>` (default `auto`) controls per-PR Copilot review requests. The durable, declarative override is `bots.copilotAutoReview: true | false` in `~/.flow/config.json`: it is consulted first and short-circuits both the authoritative ruleset read and the 5-PR historical heuristic with zero `gh` calls — `true` declares Copilot already reviews every PR (flow skips its own request), `false` declares it does not, and **unset** keeps the auto-detect behavior. It is the right escape hatch when the ruleset API is unreachable (e.g. a private repo on a free account where the rules endpoint 403s). Per-repo glob overrides live under `bots.copilot.globs`. Note that GitHub's repo-level automatic Copilot review must be disabled in the GitHub UI for the opt-in to take effect — there is no stable API to toggle it.

## Project rules for agents & contributors

All project-wide rules — commit/PR conventions, the output style, the `Task`-tool exemptions, the verify gate, consumer-repo notes — are in [`AGENTS.md`](AGENTS.md), which is canonical (`CLAUDE.md` is just `@AGENTS.md`). Don't duplicate those rules here; link to them.

## Tips

### tmux status integration (optional)

> **This is optional user tmux config, not something flow ships or requires.** flow never writes to your `~/.tmux.conf`, and `flow ls` remains the canonical status surface. The recipe below is yours to copy, adapt, or ignore.

flow's topology is one tmux session with many pipeline windows, so it's easy to lose track of which Claude Code sessions are actively working versus idle or waiting on you. If you run Claude Code inside tmux, you can color or glyph each window by session state using Claude Code's lifecycle hooks to set a window-scoped tmux option.

The mechanism: a tiny hook script sets a `@claude_state` window option on the pane's window, and `window-status-format` branches on it.

**Caveat:** `@claude_state` is keyed on generic Claude-Code session activity (the `UserPromptSubmit` / `Stop` / `Notification` lifecycle), **not** on flow's pipeline phase. It's a coarse running-vs-paused proxy — useful for "is this session busy?", not for "what phase is this pipeline in?". For the latter, use `flow ls`. The option is also deliberately distinct from flow's own `@flow-slug` identity option, so it won't collide with anything flow sets.

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
