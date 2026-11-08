# flow

[![CI](https://github.com/gavingolden/flow/actions/workflows/ci.yml/badge.svg)](https://github.com/gavingolden/flow/actions/workflows/ci.yml)
[![Runtime: Bun](https://img.shields.io/badge/runtime-bun-black?logo=bun)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Shipping a small change still costs you a whole afternoon of plan → branch → code → test → PR → CI → review → merge.
**flow ships a change end-to-end from one command** — a [Claude Code](https://docs.claude.com/en/docs/claude-code) supervisor drives the entire pipeline while you watch or walk away.

[Quickstart](#quickstart) · [Run pipelines in parallel (tmux)](docs/tmux.md) · [Getting started](docs/getting-started.md) · [Configuration](docs/configuration.md) · [All docs](docs/README.md)

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

Every run works in its own git worktree (your checkout is never touched), pauses for plan approval on feature work (and can pause earlier for a short clarifying interview), and ends in a clear terminal state: `MERGED`, `GATED: <url>`, `NEEDS HUMAN: <reason>`, or `cancelled`. flow also ships a curated skill library that any Claude Code project can use on its own.

## Quickstart

1. **Check the prerequisites.** You need **git**, **node / npm**, **bun**, and an authenticated **gh** (GitHub CLI; 2.99.0+ for PR-page screenshots) — flow opens the PR, polls CI, and merges through it. **tmux is optional**: only needed if you opt into the tmux launcher; the default plain launcher runs in your own terminal. Your target project must be a git repo with a GitHub remote.

2. **Install:**

   ```sh
   git clone https://github.com/gavingolden/flow ~/code/flow
   cd ~/code/flow
   npm install
   bun bin/flow install
   ```

3. **Verify it worked:** run `flow doctor` — it checks your install, shell, and tools and prints the exact command that fixes each problem it finds (`flow ls` should also print an empty pipeline list, not "command not found"). The most common failure is `~/.local/bin` not being on your `PATH`; add it and open a fresh shell. If `flow` itself is not found, run `bun ~/code/flow/bin/flow doctor` from your checkout instead.

4. **Ship something:** `cd` into any GitHub-backed project and run

   ```sh
   flow feature create "add CSV export"
   ```

`flow install` sets up the core pipeline plus the optional modules you pick; module flags, upgrades, and install internals are in [docs/configuration.md](docs/configuration.md).

## Documentation

- **Your first pipeline, step by step:** [docs/getting-started.md](docs/getting-started.md)
- **Run pipelines in parallel:** [docs/tmux.md](docs/tmux.md)
- **Config, models, install flags, upgrades:** [docs/configuration.md](docs/configuration.md)
- **Working on flow itself:** [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md)
- **Everything else:** [docs/README.md](docs/README.md)

## Everyday commands

```sh
flow                             # (on a TTY) interactive Claude session with flow skills loaded
flow feature create "add CSV export"        # start a pipeline (runs in your terminal by default)
flow doctor                      # check your setup; prints the fix for each problem (--json for scripts)
flow ls                          # list this repo's pipelines (--all-repos for every repo; --cost for spend)
flow feature resume add-csv-export  # re-launch a crashed or closed pipeline from saved state
flow done add-csv-export         # close a finished pipeline
flow done --merged               # sweep merged/cancelled pipelines
```

Run `flow help` for the full command reference (`epic`, `config`, `attach`, `completion`, `version`, and every flag).

**The plain shell is the default.** `flow feature create` runs Claude Code as a foreground process in whatever terminal you launched it from — no window management, no extra command to see it. It holds your terminal until the run reaches a terminal state. By default a pipeline auto-merges its PR when the merge gate is clear; pass `--no-auto-merge` to always stop at the gate.

New here? The full first-run walkthrough — reading a run, resuming, cleaning up — is at [docs/getting-started.md](docs/getting-started.md).

## Run pipelines in parallel with tmux

Start as many pipelines as you like, walk away, and see them all in one view.

![Several flow pipelines in a tmux tree view](docs/demo/tmux.gif)

1. **Turn it on.** Run `flow config launcher set tmux`, or pass `--tmux` on each run. Optional, for the tree view in the clip: add it to your tmux config (adjust the path if you cloned elsewhere), then reload if tmux is already running:

   ```sh
   echo 'source-file ~/code/flow/docs/tmux-tree.conf' >> ~/.tmux.conf
   tmux source-file ~/.tmux.conf
   ```

2. **Create.** Run `flow feature create "<description>"` as often as you like. Each call returns at once and runs in its own window.
3. **View.** Run `flow attach`, then press `Ctrl-b w`. A `!` marks pipelines waiting for you. `flow ls` works with no tmux setup. Detach with `Ctrl-b d`; the runs keep going.

More in the [tmux guide](docs/tmux.md).

## Per-phase models

You can route different Claude models to different pipeline phases (an expensive model on planning, a cheap one on verify). See [docs/configuration.md#per-phase-models](docs/configuration.md#per-phase-models) for the flags, config keys, and precedence rules.

## Consumer repos

flow runs the `flow-pre-commit` verify gate before every push. **Single-package repos and monorepos work with zero config** — it auto-detects scope from the diff and runs your declared `npm run` scripts (plus per-package scripts in `apps/<pkg>/` and `packages/<pkg>/`). For a non-conventional layout, drop in a `.flow/pre-commit.json` escape hatch. Full detail is in [`references/consumer-repo-contract.md`](references/consumer-repo-contract.md).

[`semgrep`](https://semgrep.dev) is an optional tool: when it is on `PATH`, `/flow-pr-review` runs the static-analysis security lens; without it, that lens is skipped (everything else still runs).

## License

MIT — see [LICENSE](LICENSE).
