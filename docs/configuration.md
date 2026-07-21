# Configuring flow

Everything you can tune after `flow install`: which modules are linked, which Claude models run which phases, and the knobs in `~/.flow/config.json`.

- [Install flags and module selection](#install-flags-and-module-selection)
- [The standalone skills home](#the-standalone-skills-home)
- [Staying up to date](#staying-up-to-date)
- [Per-phase models](#per-phase-models)
- [config.json reference](#configjson-reference)

## Install flags and module selection

`flow install` symlinks a **selected set of modules** — the pipeline core plus whichever stack/integration skills you pick — into place. `core` (the pipeline itself) is always installed; everything else (Svelte, Tailwind/shadcn, Supabase, Cloudflare Pages, GitHub Copilot review, and the AI-Ultra research tooling) is opt-in. Run it from an interactive terminal and it asks once per optional module; run it non-interactively (CI, a script) and it installs `core` only, printing a one-line notice naming how to widen the selection. Skip the Q&A with a flag:

```sh
bun bin/flow install --modules stack-svelte,stack-tailwind-shadcn   # exactly the modules you name (core is always folded in)
bun bin/flow install --all                                          # every module
bun bin/flow install --core-only                                    # core only, no prompt
```

The resolved selection persists to `~/.flow/config.json`'s `modules` array, so `flow install --upgrade` never re-asks. To change your selection later, re-run `flow install` with one of the flags above — narrowing prunes the now-deselected symlinks, widening adds the new ones.

`flow install` also registers a `SessionStart` hook in `~/.claude/settings.json` (used by the checkpoint/auto-resume flow); skip it with `flow install --no-hooks`.

## The standalone skills home

flow links its skills into a **standalone skills home** at `~/.flow/claude-home/.claude/skills/`, not the global `~/.claude/skills/`. A plain `claude` session anywhere on your machine therefore carries **zero** flow skills — only sessions launched with `claude --add-dir ~/.flow/claude-home` see them (bare `flow`, and every pipeline/epic seed session wire this in automatically). If you installed a pre-retarget version, one `flow install --upgrade` migrates your skills to the new home and removes the old `~/.claude/skills/` links; run it **with no active pipelines**, since removing a skill from a location a running session already loaded hot-unloads it mid-session (Claude Code live change detection). Agents stay at `~/.claude/agents/` and hooks in `~/.claude/settings.json` — those are unaffected.

## Staying up to date

To come current, run `flow install --upgrade`: it self-pulls (fast-forwards your canonical checkout to `origin`) and reports what changed, so a non-contributor needs only that one command. flow also surfaces a non-blocking staleness notice at `flow ls` and `flow version` when your checkout is behind origin, naming the exact upgrade command to run. Opt out by setting `update.checkFor` to `"off"` in `~/.flow/config.json` (or exporting `FLOW_UPDATE_CHECK=off`). A reserved `update.autoUpgrade` flag (default off, not yet executing) is parsed for a future opt-in that upgrades automatically.

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

## config.json reference

`~/.flow/config.json` is created by `flow install` and read at launch. The keys in use today:

| key                  | what it controls                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `modules`            | the persisted module selection from `flow install` (see above)                                                    |
| `models.*`           | per-phase model routing (see [Per-phase models](#per-phase-models))                                               |
| `update.checkFor`    | staleness-notice behaviour; set `"off"` to silence (or export `FLOW_UPDATE_CHECK=off`)                            |
| `update.autoUpgrade` | reserved future opt-in for automatic upgrades (default off, parsed but not yet executing)                         |
| `research.discovery` | opt-in for web-grounded discovery research on every pipeline (`flow feature create --research` forces it per run) |
| launcher             | set with `flow config launcher tmux` — makes the tmux launcher your default instead of the plain shell            |

The plain shell stays the default launcher unless you opt in: per run with `flow feature create --tmux "<desc>"`, or globally with `flow config launcher tmux`.
