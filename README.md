# flow

**tmux-driven pipelines for [Claude Code](https://docs.claude.com/en/docs/claude-code), plus a curated skill library.** One repo, two responsibilities:

1. **Pipeline driver** — `flow new "<description>"` opens a tmux window, launches Claude Code, and a single supervisor skill (`/flow-pipeline`) drives the run end-to-end: triage → plan → worktree → implement → verify → CI → review → gate → merge. Walk-away execution is just detaching from tmux; resume by attaching again.
2. **Skill library** — `skills/` ships pipeline, universal, and stack skills along with the helper binaries they shell out to. `flow setup` symlinks them globally under `~/.claude/` and `~/.local/bin/` so every project sees the same skills with zero per-repo footprint.

## Status

flow has finished its move to the tmux-driven supervisor design. The Node-based orchestrator and the legacy per-repo `flow install` are gone; `flow setup` is the only install entry point.

## Consumer repos

`flow-pre-commit` is the verify gate flow runs before every push. **Single-package repos need no setup** — it auto-detects scope from the diff and runs your declared `npm run` scripts (and `go vet`/`go test` for a `backend/`). **Monorepos work with zero config too:** flow auto-detects `apps/<pkg>/` and `packages/<pkg>/` directories that own a `package.json` and runs that package's own declared verify scripts (`typecheck`/`check`, `lint`, `test`, `format:check`), scoped with `npm run <script> -w <pkg-path>`. For a non-conventional layout or non-default commands, drop in an optional repo-relative `.flow/pre-commit.json` — a top-level array of `{ name, prefixes, checks }` scope entries — as an escape hatch. A changed file that matches no scope, no package owner, and no config still fails the gate loudly rather than passing silently.

## Install

```sh
git clone https://github.com/<user>/flow ~/code/flow
cd ~/code/flow
npm install
bun bin/flow setup
```

`flow setup`:

- Symlinks every skill from `~/code/flow/skills/{pipeline,universal,stacks}/` into `~/.claude/skills/`. Available in every project, zero per-repo declaration.
- Symlinks every helper (`flow-new-worktree`, `flow-pre-commit`, `flow-fetch-pr-review`, `flow-reply-pr-comments`, `flow-remove-worktree`, `flow-state-update`, `flow-pr-review-result-schema`, `flow-agent-finding-schema`) into `~/.local/bin/`.
- Symlinks the `flow` wrapper itself into `~/.local/bin/flow`.
- Records every symlink in `~/.flow/installed.json` so `flow setup --upgrade` can reap orphans deterministically.

Verifies `tmux` is on PATH (a hard requirement for the tmux-driven flow) and warns if `~/.local/bin/` is missing from `PATH`.

Also verifies every declared runtime dependency resolves from the source root: if `node_modules` is missing or stale you get a loud error naming the unresolved package (e.g. `picomatch`) plus the `npm install` remediation and a non-zero exit, instead of the pipeline silently degrading later (the Copilot classifier and static-analysis review lenses fall back to empty/own-judgment results when their picomatch-backed helper throws on a missing module).

Pass the opt-in `flow setup --install-deps` to run `npm install` at the source root and re-check before symlinking, rather than reporting the missing package and exiting.

Update with `cd ~/code/flow && git pull && flow setup --upgrade`.

If `flow setup` emits `! hooks/Stop:flow-stop-guard (malformed-json: ...)`, the user's `~/.claude/settings.json` was malformed before flow touched it (a third-party tool, a crashed editor, or hand-editing typo) and the Stop-hook merge has refused to overwrite it. Run `flow setup --repair-settings` to back up the malformed file to a timestamped sibling (`<path>.flow-backup-<ISO8601>`) and rewrite it with a minimal valid file containing just the Stop hook. The backup is created next to the file the path resolves to, so dotfiles-managed symlinked settings are handled correctly (the symlink is preserved; the underlying target is the file that gets backed up and rewritten).

## Quick start

```sh
flow new "add CSV export"        # creates tmux window flow:add-csv-export
flow ls                          # lists active pipelines
flow attach add-csv-export       # attach to a specific window (alias: flow a)
flow attach                      # attach into the session and browse windows
flow done add-csv-export         # close the window when finished
flow done --merged               # sweep terminal-state windows
flow done --orphans              # sweep state files whose tmux window is gone
```

Each pipeline is a tmux window inside a `flow` session. Inside the window, Claude Code loads the `/flow-pipeline` skill and supervises the run from triage to merge. State lives at `~/.flow/state/<slug>.json` (one JSON per pipeline) plus the worktree on disk plus the PR. There is no `.orchestrator/` directory.

The supervisor pauses for plan approval on `feature`-intent tasks (type `approved`, a redirection, or `cancel` into the chat). Non-feature intents (`bug`, `refactor`, `docs`, `infra`, `chore`) run straight through. Every pipeline ends with one of `MERGED`, `GATED: <url>`, `NEEDS HUMAN: <reason>`, or `cancelled` printed to the window's scrollback.

### Opt-in Copilot review

`flow new --copilot-review <auto|always|never>` (default `auto`) controls whether flow requests a Copilot review on the pipeline's PR. In `auto` mode a hybrid classifier requests a review only for non-trivial changes; trivial diffs (lockfiles, snapshots, generated files, docs-only) are declined and skip the bot wait entirely.

**Manual prerequisite:** to actually realize the opt-in, the repo admin must **disable GitHub's repo-level automatic Copilot review** in the GitHub UI (Settings → Copilot → code review). There is no stable API to toggle this programmatically, so flow can't do it for you — and if it stays on, GitHub auto-requests Copilot on every PR and defeats the opt-in. Per-repo glob overrides live under `bots.copilot.globs` in `~/.flow/config.json`.

**`bots.copilotAutoReview: true | false`** (in `~/.flow/config.json`) overrides flow's "is Copilot review already configured?" auto-detection. It is consulted **first** — a defined value beats both the authoritative `copilot_code_review` ruleset read AND the 5-PR historical heuristic, and short-circuits them (zero `gh` calls). `true` declares that Copilot already reviews every PR (so flow skips its own request); `false` declares it does not; **unset** keeps today's auto-detect behavior. It is the durable, declarative alternative to the per-invocation `--override always` flag, and is the right escape hatch when the ruleset API is unreachable — e.g. a private repo on a free personal account where the rules endpoint 403s and auto-detect would otherwise fall back to the noisier heuristic.

## Shell completions

`flow setup` installs bash and zsh tab completion automatically. The completion scripts ship under `completions/` in this repo and are symlinked into `~/.flow/completions/flow.<shell>`. To wire them into your shell, `flow setup` writes a small managed block into each of these rc files **if they already exist** (it never creates an rc file you don't already have):

- `~/.zshrc`
- `~/.bashrc`
- `~/.bash_profile`

The block looks like this and is bracketed by markers so `flow setup --upgrade` can rewrite it in place and a future `flow setup --no-completions` can remove it cleanly:

```sh
# managed by flow completions
[ -f "/Users/<you>/.flow/completions/flow.zsh" ] && source "/Users/<you>/.flow/completions/flow.zsh"
# end flow completions
```

After the install, open a fresh shell and:

- `flow <TAB>` lists every verb.
- `flow attach <TAB>` / `flow done <TAB>` / `flow new --resume <TAB>` complete from your active pipelines (`~/.flow/state/*.json`).
- Per-verb flag completion works for every flag the wrapper accepts.

To opt out (or to remove a previously installed block), run `flow setup --no-completions`. Set/unset is symmetric: this removes the block from any rc files that currently have it and leaves the rest of the file byte-identical to the pre-install state.

For environments where editing rc files isn't viable (read-only homedirs, NixOS / Guix, CI), use the escape hatch:

```sh
# bash
eval "$(flow completion bash)"

# zsh
eval "$(flow completion zsh)"
```

## Migrate a repo off the legacy per-repo install

The old `flow install` command was deleted in PR 5. Repos that were set up with it still carry the per-repo footprint (managed gitignore blocks, symlinks under `.claude/skills/` and `scripts/`). To clean it up:

```sh
cd <some-repo>
flow migrate                     # dry-run — print what would change
flow migrate --apply             # remove managed symlinks, strip gitignore blocks
flow migrate --apply --include-orchestrator   # also delete .orchestrator/
flow migrate --scan ~/code/      # dry-run across every git repo under a path
```

`flow migrate` only deletes symlinks listed in the two managed `.gitignore` blocks (`# managed by flow install-skills`, `# managed by flow install-scripts`). Real files in those paths are warned about, never deleted. See [`docs/migration.md`](docs/migration.md) for full details.

## Skills

Three categories under `skills/`:

- **`skills/pipeline/`** — invoked by `/flow-pipeline` (`product-planning`, `new-feature`, `verify`, `pr-review`). Used by the supervisor to advance a pipeline phase by phase.
- **`skills/universal/`** — generic productivity skills (`refactoring`, `skill-creator`, `add-worktree`, etc.).
- **`skills/stacks/`** — stack-specific (Svelte, Tailwind+shadcn, Supabase). Each carries explicit `TRIGGER when` / `SKIP when` clauses in its frontmatter so Claude Code's matcher only auto-loads it in matching contexts.

`flow setup` makes every skill — pipeline, universal, and stack — available in every project. Stack-skill noise in unrelated repos is bounded by the frontmatter triggers/anti-triggers, not by a per-project install step.

## Why skills live here too

The skills are usable on their own — Claude Code resolves them via `~/.claude/skills/` regardless of whether `/flow-pipeline` ever runs. Bundling them in this repo means one git remote, one install ritual, one place to evolve a skill.

## The supervisor carries no nested LLM context

Inside a flow window, the Claude Code session is the single LLM container. Sub-skills (`/product-planning`, `/new-feature`, `/verify`, `/pr-review`) load **in-process** as skill instructions; they are not nested sub-agents. This sidesteps Claude Code's one-level sub-agent cap and avoids the context bloat of a long-running parent that fans out into deep agent trees. Helpers like `flow-new-worktree` and `gh` are plain Bash tool calls.

## Design

| You want | Read |
|---|---|
| The architectural rationale | [`docs/architecture.md`](docs/architecture.md) |
| The supervisor skill itself | [`skills/pipeline/flow-pipeline/SKILL.md`](skills/pipeline/flow-pipeline/SKILL.md) |
| Project rules for agents working on flow | [`AGENTS.md`](AGENTS.md) |

