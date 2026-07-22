# flow

[![CI](https://github.com/gavingolden/flow/actions/workflows/ci.yml/badge.svg)](https://github.com/gavingolden/flow/actions/workflows/ci.yml)
[![Runtime: Bun](https://img.shields.io/badge/runtime-bun-black?logo=bun)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Shipping a small change still costs you a whole afternoon of plan → branch → code → test → PR → CI → review → merge.
**flow ships a change end-to-end from one command** — a [Claude Code](https://docs.claude.com/en/docs/claude-code) supervisor drives the entire pipeline while you watch or walk away.

![flow demo](docs/demo/demo.gif)

The transcript below is **illustrative — not exact output**; it shows the shape of a run, not its real verbosity.

```text
$ flow feature create "add CSV export"

[plan] feature detected — drafting plan, pausing for approval
  Plan: add a CSV exporter behind a flag, with tests.
  approve? > approved

[implement] worktree ready, applying edits, running verify ... ok
[ci]       PR #142 opened — waiting for checks ............... green
[review]   multi-agent review + Copilot ... 2 findings fixed
[gate]     Test Steps all checked → auto-merge

MERGED
```

Every run works in its own git worktree (your checkout is never touched), pauses once for plan approval on feature work, and ends in a clear terminal state: `MERGED`, `GATED: <url>`, `NEEDS HUMAN: <reason>`, or `cancelled`. flow also ships a curated skill library that any Claude Code project can use on its own.

## Quickstart

1. **Check the prerequisites.** You need **git**, **node / npm**, **bun**, and an authenticated **gh** (GitHub CLI) — flow opens the PR, polls CI, and merges through it. **tmux is optional**: only needed if you opt into the tmux launcher; the default plain launcher runs in your own terminal. Your target project must be a git repo with a GitHub remote.

2. **Install:**

   ```sh
   git clone https://github.com/gavingolden/flow ~/code/flow
   cd ~/code/flow
   npm install
   bun bin/flow install
   ```

3. **Verify it worked:** run `flow ls` — it should print an empty pipeline list, not "command not found". The most common failure is `~/.local/bin` not being on your `PATH`; add it and open a fresh shell.

4. **Ship something:** `cd` into any GitHub-backed project and run

   ```sh
   flow feature create "add CSV export"
   ```

`flow install` symlinks a **selected set of modules** — the pipeline core plus whichever stack/integration skills you pick. `core` is always installed; everything else (Svelte, Tailwind/shadcn, Supabase, Cloudflare Pages, GitHub Copilot review, AI-Ultra research tooling) is opt-in via an interactive Q&A. Selection flags, upgrades (`flow install --upgrade`), and the standalone skills home are covered in [docs/configuration.md](docs/configuration.md); setup internals live in [CONTRIBUTING.md](CONTRIBUTING.md).

## Everyday commands

```sh
flow                             # (on a TTY) interactive Claude session with flow skills loaded
flow feature create "add CSV export"        # start a pipeline (runs in your terminal by default)
flow ls                          # list active pipelines (add --cost for spend)
flow feature resume add-csv-export  # re-launch a crashed or closed pipeline from saved state
flow done add-csv-export         # close a finished pipeline
flow done --merged               # sweep merged/cancelled pipelines
```

Run `flow help` for the full command reference (`epic`, `config`, `attach`, `completion`, `version`, and every flag).

**The plain shell is the default.** `flow feature create` runs Claude Code as a foreground process in whatever terminal you launched it from — no window management, no extra command to see it. It holds your terminal until the run reaches a terminal state. By default a pipeline auto-merges its PR when the merge gate is clear; pass `--no-auto-merge` to always stop at the gate.

New here? The full first-run walkthrough — reading a run, resuming, cleaning up — is at [docs/getting-started.md](docs/getting-started.md).

## Power users: the tmux launcher

Reach for the tmux launcher when you want to run several pipelines at once from one place, or start a pipeline and walk away, re-attaching from anywhere later. Opt in per run with `flow feature create --tmux "<description>"`, answer "yes" to the tmux question `flow install` asks on an interactive install, or set it as your default with `flow config launcher set tmux`. Agent- or script-driven `flow feature create` (anything without a TTY) must pass `--tmux`: the default plain launcher refuses non-interactive launches by design (since PR #457).

Under the tmux launcher, your first `flow feature create` starts the pipeline in a tmux window but doesn't drop you into it — run `flow attach` (no args) to pop into the flow session, or `flow attach <name>` (alias `flow a <name>`) to jump to a specific one. To step away without stopping the run, detach with `Ctrl-b d` — the pipeline keeps running, and you come back with `flow attach`.

## Per-phase models

You can route different Claude models to different pipeline phases (an expensive model on planning, a cheap one on verify). See [docs/configuration.md#per-phase-models](docs/configuration.md#per-phase-models) for the flags, config keys, and precedence rules.

## Consumer repos

flow runs the `flow-pre-commit` verify gate before every push. **Single-package repos and monorepos work with zero config** — it auto-detects scope from the diff and runs your declared `npm run` scripts (plus per-package scripts in `apps/<pkg>/` and `packages/<pkg>/`). For a non-conventional layout, drop in a `.flow/pre-commit.json` escape hatch. Full detail is in [`AGENTS.md`](AGENTS.md) under `## Consumer-repo notes`.

[`semgrep`](https://semgrep.dev) is an optional tool: when it is on `PATH`, `/flow-pr-review` runs the static-analysis security lens; without it, that lens is skipped (everything else still runs).

## Learn more

| You want                                 | Read                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| Your first pipeline, step by step        | [docs/getting-started.md](docs/getting-started.md)                                 |
| Config, models, install flags, upgrades  | [docs/configuration.md](docs/configuration.md)                                     |
| Working on flow itself                   | [CONTRIBUTING.md](CONTRIBUTING.md)                                                 |
| The supervisor skill itself              | [`skills/pipeline/flow-pipeline/SKILL.md`](skills/pipeline/flow-pipeline/SKILL.md) |
| Project rules for agents working on flow | [`AGENTS.md`](AGENTS.md)                                                           |

## License

MIT — see [LICENSE](LICENSE).
