# flow

**Ship a change end-to-end from one command.** `flow feature create "<description>"` opens a tmux window, launches [Claude Code](https://docs.claude.com/en/docs/claude-code), and a single supervisor skill drives the whole run — plan, worktree, implement, verify, CI, review, and merge — while you watch or walk away. flow also ships a curated skill library that any Claude Code project can use on its own.

## Prerequisites

- **git** — flow works in a per-pipeline worktree off your repo.
- **node / npm** — installs flow's dependencies (`npm install`).
- **bun** — the runtime for the `flow` wrapper and its helpers.
- **tmux** — each pipeline runs in its own tmux window; `flow install` checks for it.
- **gh** (GitHub CLI, authenticated) — flow opens the PR, polls CI, and merges through it.

Your target project must be a **git repo with a GitHub remote** — the pipeline opens and merges a PR, so without a remote there is nothing to push to.

## Install

```sh
git clone https://github.com/<user>/flow ~/code/flow
cd ~/code/flow
npm install
bun bin/flow install
```

`flow install` symlinks a **selected set of modules** — the pipeline core plus whichever stack/integration skills you pick — into place. `core` (the pipeline itself) is always installed; everything else (Svelte, Tailwind/shadcn, Supabase, Cloudflare Pages, GitHub Copilot review, and the AI-Ultra research tooling) is opt-in. Run it from an interactive terminal and it asks once per optional module; run it non-interactively (CI, a script) and it installs `core` only, printing a one-line notice naming how to widen the selection. Skip the Q&A with a flag:

```sh
bun bin/flow install --modules stack-svelte,stack-tailwind-shadcn   # exactly the modules you name (core is always folded in)
bun bin/flow install --all                              # every module (today's original unconditional behavior)
bun bin/flow install --core-only                         # core only, no prompt
```

The resolved selection persists to `~/.flow/config.json`'s `modules` array, so `flow install --upgrade` never re-asks. To change your selection later, re-run `flow install` with one of the flags above — narrowing prunes the now-deselected symlinks, widening adds the new ones. Verify it worked by running `flow ls` (it should print an empty pipeline list, not "command not found"). The most common failure is `~/.local/bin` not being on your `PATH` — add it and open a fresh shell. Setup internals (symlink mechanics, shell completions, the Copilot escape hatch) live in [CONTRIBUTING.md](CONTRIBUTING.md).

flow links its skills into a **standalone skills home** at `~/.flow/claude-home/.claude/skills/`, not the global `~/.claude/skills/`. A plain `claude` session anywhere on your machine therefore carries **zero** flow skills — only sessions launched with `claude --add-dir ~/.flow/claude-home` see them (bare `flow`, and every pipeline/epic seed session wire this in automatically). If you installed a pre-retarget version, one `flow install --upgrade` migrates your skills to the new home and removes the old `~/.claude/skills/` links; run it **with no active pipelines**, since removing a skill from a location a running session already loaded hot-unloads it mid-session (Claude Code live change detection). Agents stay at `~/.claude/agents/` and hooks in `~/.claude/settings.json` — those are unaffected.

To come current, run `flow install --upgrade`: it self-pulls (fast-forwards your canonical checkout to `origin`) and reports what changed, so a non-contributor needs only that one command. flow also surfaces a non-blocking staleness notice at `flow ls` and `flow version` when your checkout is behind origin, naming the exact upgrade command to run. Opt out by setting `update.checkFor` to `"off"` in `~/.flow/config.json` (or exporting `FLOW_UPDATE_CHECK=off`). A reserved `update.autoUpgrade` flag (default off, not yet executing) is parsed for a future opt-in that upgrades automatically.

## Usage

```sh
flow                             # (on a TTY) launch an interactive Claude session with flow skills loaded
flow feature create "add CSV export"        # start a pipeline in a new tmux window
flow ls                          # list active pipelines
flow attach add-csv-export       # attach to a pipeline's window (alias: flow a)
flow attach                      # attach into the session and browse windows
flow done add-csv-export         # close a finished pipeline's window
flow done --merged               # sweep windows that reached a terminal state
```

Bare `flow` on a terminal starts an interactive Claude session with your installed flow skills loaded (`claude --add-dir ~/.flow/claude-home`) — the way to get flow's skills in an ad-hoc session now that they no longer live in the global `~/.claude/skills/`. Run `flow help` (or `flow -h`) for the command reference; a non-interactive bare `flow` (a script, CI) prints that help instead of launching.

By default a pipeline auto-merges its PR when the merge gate is clear; pass `flow feature create --no-auto-merge "<desc>"` to always stop at the gate for a manual merge.

**New to tmux?** Your first `flow feature create` starts the pipeline in a tmux window but doesn't drop you into it — run `flow attach` (no args) to pop into the flow session (it lands you on your most-recent pipeline), or `flow attach <name>` (alias `flow a <name>`) to jump to a specific one. To step away from a running pipeline without stopping it, detach with `Ctrl-b d` (`Ctrl-b` is tmux's prefix key, then press `d`) — the pipeline keeps running in the background, and you come back with `flow attach`.

<details>
<summary>More <code>flow feature create</code> flags</summary>

- `--copilot-review <auto|always|never>` (default `auto`) — control whether flow requests a Copilot review on the PR.
- `--wait-for-copilot` — block on the Copilot review before proceeding.
- `--research` — force web-grounded discovery research on for that pipeline, bypassing the relevance gate and the `research.discovery` config opt-in.
- `--slug <slug>` — use an explicit slug instead of deriving one from the description; hard-fails if that slug's window already exists (a derived-slug collision instead auto-suffixes to `-2`/`-3`).
- `--effort <low|medium|high|xhigh|max>` — set the Claude Code reasoning-effort level for the pipeline's session.
- `--model <opus|haiku|sonnet|fable>` — set the whole-session Claude model.
- `--model-<phase> <alias>` — override the model for just one phase: `--model-planning`, `--model-implement`, `--model-review`, `--model-verify`, `--model-fix-applier`, `--model-consolidator`, `--model-merge-resolver`. See **Per-phase models** below.
- `--resume <name>` — re-launch a crashed supervisor session for an existing pipeline.

Run `flow feature create --help` for the full surface.

</details>

## Per-phase models

A pipeline runs many distinct Claude phases — planning, implementation, review, verify, the fix-applier/consolidator tail, merge-conflict resolution — plus the epic-design and epic-run supervisors. You can concentrate an expensive model (e.g. the newly-released **Fable**) on the high-leverage reasoning phases and run cheaper models on the mechanical ones, controlled per-run (flags) or globally (config).

**Per-run flags** — `flow feature create --model-planning fable --model-verify haiku "add X"` routes Fable to planning and Haiku to verify for that pipeline, leaving every other phase on the session default. Epic knobs: `flow epic create --model-planning <alias>` (the epic design phase shares the feature planning knob), and `flow epic run --model <alias> [--effort <level>]` (the /flow-epic-run playbook supervisor session); `flow epic launch <epic> <id> [--model <alias>] [--effort <level>]` applies the same per-launch overrides without mutating the committed manifest.

**Global config** — set a house style once in `~/.flow/config.json`:

```json
{
  "models": {
    "default": "sonnet",
    "planning": "fable",
    "implement": "sonnet",
    "review": "sonnet",
    "verify": "haiku",
    "fixApplier": "sonnet",
    "consolidator": "sonnet",
    "mergeResolver": "sonnet",
    "scout": "sonnet",
    "coder": "sonnet"
  }
}
```

| key             | phase                                      | flag                     |
| --------------- | ------------------------------------------ | ------------------------ |
| `default`       | whole-session default (consumed at launch) | `--model`                |
| `planning`      | planning / epic design                     | `--model-planning`       |
| `implement`     | implementation (scout + coder)             | `--model-implement`      |
| `review`        | multi-agent PR review                      | `--model-review`         |
| `verify`        | pre-commit verify gate                     | `--model-verify`         |
| `fixApplier`    | PR-review fix-applier                      | `--model-fix-applier`    |
| `consolidator`  | PR-review consolidator-validator           | `--model-consolidator`   |
| `mergeResolver` | merge-conflict resolver                    | `--model-merge-resolver` |
| `scout`         | implementation scout (finer grain)         | _(config only, no flag)_ |
| `coder`         | implementation edit-applier (finer grain)  | _(config only, no flag)_ |

**Precedence** (highest wins):

- **Session model** — `--model` > `config.models.default` > Claude's default. Read once at launch and passed to `claude --model`.
- **Per-phase model** — `--model-<phase>` > `config.models.<phase>` > inherited session model.
- **Two deliberate asymmetries** — (1) **verify** defaults to `sonnet`, **not** the session model (a mechanical gate rarely earns an expensive model): `--model-verify` > `config.models.verify` > `sonnet`. (2) **scout / coder** are config-only fine-grain that layer _above_ `--model-implement`: `config.models.scout|coder` > `--model-implement` > `config.models.implement` > inherited.
- **The gatekeeper is pinned** to `haiku` — its whole job is cheap cost-routing. There is no `--model-gatekeeper` flag; a `config.models.gatekeeper` key is reachable but strongly discouraged (overriding it defeats the cost-routing).

Aliases are `opus`, `haiku`, `sonnet`, `fable`; flow forwards the alias verbatim to `claude --model`. An invalid alias in a flag exits non-zero writing no state; an invalid value in `config.models.*` emits a best-effort warning at create time and falls back.

## How it works

Each pipeline is a tmux window inside a single `flow` session. Inside it, Claude Code loads the `/flow-pipeline` supervisor skill and drives the run from triage to merge; sub-skills load in-process, not as nested agents. Each pipeline runs in its own git worktree and branch in a sibling directory named like `<repo>-<slug>`, so parallel pipelines are isolated from each other and your main checkout is never touched. Detach from tmux to walk away and re-attach (`flow attach <name>`) to pick the run back up — state persists at `~/.flow/state/<slug>.json` plus the worktree on disk plus the PR.

The supervisor pauses once for plan approval on feature work (type `approved`, a redirection, or `cancel`); non-feature changes run straight through. Every run ends with `MERGED`, `GATED: <url>` (a manual-merge needed), `NEEDS HUMAN: <reason>`, or `cancelled` printed to the window.

The transcript below is **illustrative — not exact output**; it shows the sequence and the terminal-state strings with the real verbosity hidden.

```text
$ flow feature create "add CSV export"
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

When the merge gate is not clear (an unchecked Test Steps item, or `flow feature create --no-auto-merge`), the run ends with `GATED: <url>` instead — open that URL and merge when you're ready.

## Resuming

There are two distinct ways to come back to a pipeline, and which one you need depends on whether it's still running.

**Walk away and return.** If the pipeline is still running, just detach (`Ctrl-b d`) and later `flow attach` to re-enter — nothing special is needed, because the state lives on disk (`~/.flow/state/<slug>.json` plus the worktree plus the PR).

**Resume after a crash.** If the supervisor crashed or you closed the window, run `flow ls` to find the pipeline's slug, then `flow feature resume <slug>` to re-launch Claude Code into the same window and pick up exactly where it left off — it reads the saved phase, worktree, and PR and continues. It refuses if the pipeline is actually still running, telling you to attach instead.

**Reset context mid-run (`/flow-checkpoint` → `/clear` → auto-resume).** A long pipeline accumulates a large chat transcript, and the priciest tokens are spent late in a run against a near-full context. Because `flow feature resume` re-launches a _fresh_ Claude Code process (a cleared context) and rebuilds pipeline state entirely from disk, it already **is** the context-reset path — the only thing a fresh process drops is ad-hoc conversational state that never reached an artifact (an "approved with condition X" addendum, a mid-flight redirect). The `/flow-checkpoint` skill closes that gap: invoke `/flow-checkpoint` (or just say "checkpoint this") and the supervisor flushes that conversational state to `<worktree>/.flow-tmp/checkpoint.md` and tells you it is safe to `/clear`. After you type `/clear`, a `SessionStart` hook auto-resumes the pipeline in the fresh session and re-injects the checkpoint, so you don't have to run `flow feature resume` by hand. The auto-resume is gated on a one-shot marker `/flow-checkpoint` writes, so a `/clear` **without** a prior checkpoint clears normally (you keep the choice); Claude cannot invoke `/clear` itself, so that one keystroke stays yours. The supervisor also auto-checkpoints at the plan-approval → implementation hand-off — the highest-value place to reset before the heavy phases. The hook is registered by `flow install` and skippable with `flow install --no-hooks`.

The transcript below is **illustrative — not exact output**:

```text
$ flow ls
  add-csv-export    review    window died
  fix-login-redirect ci       running

$ flow feature resume add-csv-export
  → re-launching flow:add-csv-export
RESUMING AT: review (PR #142, 2 findings open)
[review] multi-agent review + Copilot ... resolving findings ...
```

## Consumer repos

flow runs the `flow-pre-commit` verify gate before every push. **Single-package repos and monorepos work with zero config** — it auto-detects scope from the diff and runs your declared `npm run` scripts (plus per-package scripts in `apps/<pkg>/` and `packages/<pkg>/`). For a non-conventional layout, drop in a `.flow/pre-commit.json` escape hatch. Full detail is in [`AGENTS.md`](AGENTS.md) under `## Consumer-repo notes`.

[`semgrep`](https://semgrep.dev) is an optional tool: when it is on `PATH`, `/flow-pr-review` runs the static-analysis security lens against your tree; without it, that lens is skipped (everything else still runs).

## Contributing

Working on flow itself? See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, conventions, and architecture.

## Design / Learn more

| You want                                 | Read                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| The architectural rationale              | [`docs/architecture.md`](docs/architecture.md)                                     |
| The supervisor skill itself              | [`skills/pipeline/flow-pipeline/SKILL.md`](skills/pipeline/flow-pipeline/SKILL.md) |
| Project rules for agents working on flow | [`AGENTS.md`](AGENTS.md)                                                           |
