# flow

**Ship a change end-to-end from one command.** `flow new "<description>"` opens a tmux window, launches [Claude Code](https://docs.claude.com/en/docs/claude-code), and a single supervisor skill drives the whole run — plan, worktree, implement, verify, CI, review, and merge — while you watch or walk away. flow also ships a curated skill library that any Claude Code project can use on its own.

## Prerequisites

- **git** — flow works in a per-pipeline worktree off your repo.
- **node / npm** — installs flow's dependencies (`npm install`).
- **bun** — the runtime for the `flow` wrapper and its helpers.
- **tmux** — each pipeline runs in its own tmux window; `flow setup` checks for it.
- **gh** (GitHub CLI, authenticated) — flow opens the PR, polls CI, and merges through it.

Your target project must be a **git repo with a GitHub remote** — the pipeline opens and merges a PR, so without a remote there is nothing to push to.

## Install

```sh
git clone https://github.com/<user>/flow ~/code/flow
cd ~/code/flow
npm install
bun bin/flow setup
```

`flow setup` symlinks the skills, the helper binaries, and the `flow` wrapper itself into place. Verify it worked by running `flow ls` (it should print an empty pipeline list, not "command not found"). The most common failure is `~/.local/bin` not being on your `PATH` — add it and open a fresh shell. Setup internals (symlink mechanics, shell completions, the Copilot escape hatch) live in [CONTRIBUTING.md](CONTRIBUTING.md).

To come current, run `flow setup --upgrade`: it self-pulls (fast-forwards your canonical checkout to `origin`) and reports what changed, so a non-contributor needs only that one command. flow also surfaces a non-blocking staleness notice at `flow ls` and `flow version` when your checkout is behind origin, naming the exact upgrade command to run. Opt out by setting `update.checkFor` to `"off"` in `~/.flow/config.json` (or exporting `FLOW_UPDATE_CHECK=off`). A reserved `update.autoUpgrade` flag (default off, not yet executing) is parsed for a future opt-in that upgrades automatically.

Upgrading from the old per-repo `flow install`? See [`docs/migration.md`](docs/migration.md).

## Usage

```sh
flow new "add CSV export"        # start a pipeline in a new tmux window
flow ls                          # list active pipelines
flow attach add-csv-export       # attach to a pipeline's window (alias: flow a)
flow attach                      # attach into the session and browse windows
flow done add-csv-export         # close a finished pipeline's window
flow done --merged               # sweep windows that reached a terminal state
```

By default a pipeline auto-merges its PR when the merge gate is clear; pass `flow new --no-auto-merge "<desc>"` to always stop at the gate for a manual merge.

**New to tmux?** Your first `flow new` starts the pipeline in a tmux window but doesn't drop you into it — run `flow attach` (no args) to pop into the flow session (it lands you on your most-recent pipeline), or `flow attach <name>` (alias `flow a <name>`) to jump to a specific one. To step away from a running pipeline without stopping it, detach with `Ctrl-b d` (`Ctrl-b` is tmux's prefix key, then press `d`) — the pipeline keeps running in the background, and you come back with `flow attach`.

<details>
<summary>More <code>flow new</code> flags</summary>

- `--copilot-review <auto|always|never>` (default `auto`) — control whether flow requests a Copilot review on the PR.
- `--wait-for-copilot` — block on the Copilot review before proceeding.
- `--resume <name>` — re-launch a crashed supervisor session for an existing pipeline.

Run `flow new --help` for the full surface.

</details>

## How it works

Each pipeline is a tmux window inside a single `flow` session. Inside it, Claude Code loads the `/flow-pipeline` supervisor skill and drives the run from triage to merge; sub-skills load in-process, not as nested agents. Each pipeline runs in its own git worktree and branch in a sibling directory named like `<repo>-<slug>`, so parallel pipelines are isolated from each other and your main checkout is never touched. Detach from tmux to walk away and re-attach (`flow attach <name>`) to pick the run back up — state persists at `~/.flow/state/<slug>.json` plus the worktree on disk plus the PR.

The supervisor pauses once for plan approval on feature work (type `approved`, a redirection, or `cancel`); non-feature changes run straight through. Every run ends with `MERGED`, `GATED: <url>` (a manual-merge needed), `NEEDS HUMAN: <reason>`, or `cancelled` printed to the window.

The transcript below is **illustrative — not exact output**; it shows the sequence and the terminal-state strings with the real verbosity hidden.

```text
$ flow new "add CSV export"
  → window flow:add-csv-export created

[plan] feature detected — drafting plan, pausing for approval
  Plan: add a CSV exporter behind a flag, with tests.
  approve? > approved

[implement] worktree ready, applying edits, running verify ... ok
[ci]       PR #142 opened — waiting for checks ............... green
[review]   multi-agent review + Copilot ... 2 findings fixed
[gate]     Test Steps all checked → auto-merge

MERGED
```

When the merge gate is not clear (an unchecked Test Steps item, or `flow new --no-auto-merge`), the run ends with `GATED: <url>` instead — open that URL and merge when you're ready.

## Resuming

There are two distinct ways to come back to a pipeline, and which one you need depends on whether it's still running.

**Walk away and return.** If the pipeline is still running, just detach (`Ctrl-b d`) and later `flow attach` to re-enter — nothing special is needed, because the state lives on disk (`~/.flow/state/<slug>.json` plus the worktree plus the PR).

**Resume after a crash.** If the supervisor crashed or you closed the window, run `flow ls` to find the pipeline's slug, then `flow new --resume <slug>` to re-launch Claude Code into the same window and pick up exactly where it left off — it reads the saved phase, worktree, and PR and continues. It refuses if the pipeline is actually still running, telling you to attach instead.

The transcript below is **illustrative — not exact output**:

```text
$ flow ls
  add-csv-export    review    window died
  fix-login-redirect ci       running

$ flow new --resume add-csv-export
  → re-launching flow:add-csv-export
RESUMING AT: review (PR #142, 2 findings open)
[review] multi-agent review + Copilot ... resolving findings ...
```

## Consumer repos

flow runs the `flow-pre-commit` verify gate before every push. **Single-package repos and monorepos work with zero config** — it auto-detects scope from the diff and runs your declared `npm run` scripts (plus per-package scripts in `apps/<pkg>/` and `packages/<pkg>/`). For a non-conventional layout, drop in a `.flow/pre-commit.json` escape hatch. Full detail is in [`AGENTS.md`](AGENTS.md) under `## Consumer-repo notes`.

[`semgrep`](https://semgrep.dev) is an optional tool: when it is on `PATH`, `/pr-review` runs the static-analysis security lens against your tree; without it, that lens is skipped (everything else still runs).

## Contributing

Working on flow itself? See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, conventions, and architecture.

## Design / Learn more

| You want                                 | Read                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| The architectural rationale              | [`docs/architecture.md`](docs/architecture.md)                                     |
| The supervisor skill itself              | [`skills/pipeline/flow-pipeline/SKILL.md`](skills/pipeline/flow-pipeline/SKILL.md) |
| Project rules for agents working on flow | [`AGENTS.md`](AGENTS.md)                                                           |
