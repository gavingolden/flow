# Configuring flow

Everything you can tune after `flow install`: which modules are linked, which Claude models run which phases, and the knobs in `~/.flow/config.json`.

- [Install flags and module selection](#install-flags-and-module-selection)
- [The standalone skills home](#the-standalone-skills-home)
- [Plugin materialization](#plugin-materialization)
- [Staying up to date](#staying-up-to-date)
- [Per-phase models](#per-phase-models)
- [chrome-devtools MCP registration](#chrome-devtools-mcp-registration)
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

flow links its skills AND agents into a **standalone skills home** at `~/.flow/claude-home/.claude/skills/`, not the global `~/.claude/skills/`/`~/.claude/agents/`. Both nest inside their owning module's plugin root — `~/.flow/claude-home/.claude/skills/flow-module-<id>/skills/<name>` and `.../flow-module-<id>/agents/<name>.md` — rather than a flat top-level directory. A plain `claude` session anywhere on your machine therefore carries **zero** flow skills or agents — only sessions launched through the flow launcher see them. The launcher's `--plugin-dir` wiring is what actually loads flow's skills-dir plugin roots (bare `--add-dir ~/.flow/claude-home` alone does not — see the limitation below); bare `flow`, and every pipeline/epic seed session, wire this in automatically. If you installed a pre-move version, one `flow install --upgrade` migrates both your skills and your agents to the new home and removes the old `~/.claude/skills/`/`~/.claude/agents/` links; run it **with no active pipelines** — removing a skill or agent from a location a running session already loaded hot-unloads it mid-session (Claude Code live change detection), and the agent migration additionally SKIPS pruning the old `~/.claude/agents/` location outright (a stderr warning, links left in place) whenever any recorded `~/.flow/state/*.json` sits in a non-terminal phase, so a resumed session's spawn-site guards keep resolving there until the next clean install. Hooks in `~/.claude/settings.json` are unaffected by either move.

**`--add-dir`-only limitation (no `flow` launcher).** Hand-running `claude --add-dir ~/.flow/claude-home` without going through the `flow`/`flow feature create` launcher no longer loads flow's skills or agents — the launcher wires in session setup beyond the bare `--add-dir` flag. The flow launcher (bare `flow`, or a pipeline/epic seed session) is the only supported entry point for a session that needs flow's skills/agents.

## Plugin materialization

Alongside the symlinks above, `flow install` also materializes one Claude Code **skills-dir plugin root** per SELECTED module, at `~/.flow/claude-home/.claude/skills/flow-module-<id>/`. Each root carries a `.claude-plugin/plugin.json` manifest plus a `skills/` directory and an `agents/` directory symlinking in every skill/agent that module owns — but only when that module actually owns skill or agent rows; a helper-only module (e.g. `copilot`) legitimately declares neither and gets no `skills/`/`agents/` directory. When the module ships helpers or validators it also gets a `bin/` directory symlinking them in. The same module-selection rules as everything else govern it: `core` is mandatory, every other module is opt-in, and `--all` is still strictly opt-in and never inferred at any layer.

A flow-owned root's expected contents are exactly `.claude-plugin/`, `bin/`, `agents/`, and — once the manifest declares it — `skills/`; anything else inside a flow-owned root is reported as install drift by `flow ls`, `flow version`, and the post-repair check in `flow install`, naming the root and the offending path. `flow install --upgrade` repairs managed symlinks; a real entry it flagged — a file or a directory, since the expected-children check is name-based and filters neither out — is never removed automatically and must be removed by hand, but a foreign live `bin/` symlink IS removed automatically by the next `flow install --upgrade` run. A `bin/` symlink is reported when it resolves outside the flow source tree — a foreign executable that, because each plugin root's `bin/` is appended to the END of the session PATH, wins PATH lookup for its name only when nothing earlier on PATH already resolves that name, until the next `flow install --upgrade`; flow's own `bin/` symlinks, which resolve inside that tree, are never reported. A flow-managed `bin/` entry itself can never shadow an earlier PATH entry — flow's helpers are all `flow-`-prefixed and collide with nothing.

The root is named `flow-module-<id>`, not `flow-<id>` — a plugin literally named `flow-research` would collide with the real `flow-research` skill directory already living in the same skills-home namespace.

`claude plugin details flow-module-<id>@skills-dir` is the per-module token-cost inventory this materialization exists to unlock: it now reports real `Skills (N)`/`Agents (N)` counts and per-component token estimates for every module — both the skill move AND the agent move have landed. As a bonus property (not a guaranteed feature — verify it still holds on your Claude Code version before relying on it), per-project `enabledPlugins` accepts `<name>@skills-dir` keys, e.g.:

```sh
claude plugin disable flow-module-core@skills-dir --scope project
```

## Staying up to date

To come current, run `flow install --upgrade`: it self-pulls (fast-forwards your canonical checkout to `origin`), re-materializes both the symlinks and the plugin roots above, and reports what changed, so a non-contributor needs only that one command. `flow install --upgrade` is idempotent — re-running it against unchanged content leaves every symlink and plugin root byte-identical. flow also surfaces a non-blocking staleness notice at `flow ls` and `flow version` when your checkout is behind origin, naming the exact upgrade command to run. Opt out by setting the nested `checkFor` key under `update` (i.e. `{ "update": { "checkFor": "off" } }`) to `"off"` in `~/.flow/config.json` (or exporting `FLOW_UPDATE_CHECK=off`). A reserved `update.autoUpgrade` flag (default off, not yet executing) is parsed for a future opt-in that upgrades automatically.

**Rollback.** The git checkout is flow's single version store for both the session surface and the CLI — there is no marketplace `autoUpdate` skew to worry about. To roll back:

```sh
cd <flow-checkout> && git checkout <earlier ref> && flow install --upgrade
```

`flow install --upgrade` re-derives every symlink and plugin root from whatever is checked out, so this is safe to run repeatedly in either direction.

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

## chrome-devtools MCP registration

flow's browser-driven UI-validation passes need the `chrome-devtools-mcp` MCP server registered once per machine (outside flow's control — this is a `~/.claude.json` MCP registration, not a `~/.flow/config.json` key). The line below is the server's own **foreground launch command** — running it directly hangs a terminal and registers nothing. To actually register it, either add an `mcpServers` entry to `~/.claude.json`:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--isolated"]
    }
  }
}
```

or use the `claude mcp add` user-scope form:

```sh
claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --isolated
```

The server command itself (what either registration path above ultimately runs):

```sh
npx -y chrome-devtools-mcp@latest --isolated
```

`--isolated` gives each session its own auto-cleaned throwaway Chrome profile instead of the single shared default one — this is what fixes the cross-process profile LOCK between parallel pipelines (`The browser is already running for ~/.cache/chrome-devtools-mcp/chrome-profile`). It does **not**, by itself, prevent a leaked browser process: the throwaway profile is documented as cleaned up only _after_ the browser is closed, so a browser that's never closed leaves its temp profile in place indefinitely too.

Add `--headless=new` (not the legacy `--headless`) if you never want a Dock icon for the automation browser. Caveat: headless rendering isn't guaranteed pixel-identical to headful (font rasterisation, animation timing, viewport bounds can all differ), so `/flow-pr-review`'s visual-appearance pass may shift under `--headless=new`.

**Cleaning up an existing backlog.** `flow reap --include-strays` sweeps sessionless browser processes and sessionless chrome-devtools-mcp server processes left behind by crashed/killed sessions (the shape-heuristic selection `flow-browser-teardown --orphans` used to run standalone, now deprecated in favor of this composed command) — the browser rows it recognizes are a positive allowlist of profile shapes (the chrome-devtools-mcp cache profile, its `--isolated` temp profile, and the go-rod temp-profile shape); a row whose profile doesn't match one of those shapes is emitted report-only and is **never** signalled, even with `--yes`. Run it without `--yes` first to preview, then `flow reap --yes --include-strays` to act. It uses SIGTERM only — never a harder signal, which would orphan Chrome instead of closing it.

**Registry-driven reap.** `flow-browser-teardown --reap [--slug <s>] [--dry-run] [--json] [--record]` verifies and signals every row recorded in the [process registry](#process-registry) below (`~/.flow/state/procs/<slug>.jsonl`) — a different surface from `--orphans` above, which selects by process-table shape heuristics rather than by a recorded row. Two class policies apply: a `default`-class row gets SIGTERM to its whole process group, a bounded grace wait, then a force-kill of the group if it's still alive; an `mcp-server`-class row gets SIGTERM to its pid only — never the group, and never escalated (that class's SIGTERM-only rule is the same one the paragraph above states, scoped here explicitly to the `mcp-server` class since `--reap`'s `default` class does escalate). A row whose recorded start time no longer matches the live process is skipped without any signal at all, and a `default`-class row whose leader has died while its group is still alive is reported as `skipped-dead-leader` rather than as a clean `already-dead` — the group is leaking and a human should see it. One `--reap` pass admits no new row after a 30-second aggregate wall-clock budget, but that budget is an admission check, not a hard cap: a row admitted just under the deadline still runs its full class policy (up to ~7s more for a `default`-class row's grace-then-force-kill sequence), so the registry phase's real worst case is ~37s, not 30s. And a `deadline-exceeded` mcp-server row does not count as registry-covered, so a registry pass that exhausts its budget still falls through to the ancestry fallback's ~12s poll — an absolute worst case of ~30s + ~7s + ~12s ≈ 49s for the newly-blocking terminal-state wait, not ~42s. Rows not reached in time report `deadline-exceeded` instead of being silently dropped. Run with `--dry-run` first — it sends no signal and is the recommended first invocation. `--reap` is wired into every `/flow-pipeline` terminal state (`MERGED`, `GATED`, `NEEDS HUMAN`, `cancelled`): the supervisor runs `flow-browser-teardown --reap --record` as a standalone step (never `&&`-chained) immediately before that terminal state's `flow-gate-summary` render.

**`--record` and the CLEANUP row.** `--record` (meaningful only alongside `--reap`; a no-op under `--dry-run`, which never writes) durably writes the reap verdict to `~/.flow/state/<slug>.json` as `state.reap` — `{at, status: "ok"|"unclean", summary, ran, problems?}` — a plain state write, not a phase transition (`updatedAt` is not bumped). `flow-gate-summary --cleanup` reads it and renders a `CLEANUP:` row in the gate-summary block: `reap ok` on a clean record, `REAP UNCLEAN` (plus a re-run hint) when the verdict recorded a leak, `REAP NOT RECORDED` when the terminal-state pipeline's own reap never ran or never recorded (e.g. a pre-this-feature pipeline, or `--record` was skipped), or `REAP NOT RECORDED (stale)` when the record on disk predates the current render's own state write. A gate-summary block with no `CLEANUP:` row at all means the site never passed `--cleanup` — distinct from `REAP NOT RECORDED`, which means `--cleanup` was passed but found nothing current to report.

`flow reap` (registered rows, plus shape-heuristic strays under `--include-strays`) is **not** the same sweep as `flow done --orphans`: `flow reap` sweeps **processes**, `flow done --orphans` sweeps stale pipeline **state files**.

## Process registry

`~/.flow/state/procs/<slug>.jsonl` is an append-only JSONL log of processes launched under a given pipeline slug — one JSON row per launch, each carrying `pgid`, `pid`, `startEpoch`, `slug`, `class` (`default` or `mcp-server`), `argv`, `argvTruncated` (present and `true` only when `argv` was cut to stay under the per-row byte cap — absent otherwise), `recordedAt`, `sessionPid`, and `sessionStartEpoch`. `startEpoch` is nullable: `null` means the pid's start time could not be read at record time, which the design treats as "never signal" — a row that can't prove which process it is describes is never eligible for the liveness match a future reap would require.

Launch a command through the registry with `flow-spawn --slug <slug> -- <cmd> [args...]`; it runs the command in its own process group, records one row, and passes through its stdio and exit code. Inspect a slug's recorded rows with `flow-spawn --list <slug> [--json]`.

Three sites launch through the wrapper today, each recorded with `class: "default"`:

- `flow-pre-commit`'s verify-gate check commands (each `npm run <script>` / `actionlint` / `go` invocation)
- the backgrounded `flow-ci-wait` CI-poll loop (`/flow-pipeline` step 7)
- the ui-smoke pass's dev-server launch

`flow-pre-commit` only wraps when a pipeline slug resolves (`FLOW_SLUG` is set), so a consumer repo, a git hook, or a CI run is byte-identical to before — no synthetic `untracked-*.jsonl` files accumulate there. The session's chrome-devtools-mcp browser server is harness-owned and cannot be wrapped this way; it stays on the process-ancestry fallback `flow-browser-teardown` already uses.

`flow-spawn --list` reads this registry for inspection, and `flow-browser-teardown --reap --record` (see above) consumes it at every `/flow-pipeline` terminal state — no longer exercised only by hand. `flow reap` (above) is the host-wide orphan-reaping consumer of this registry; a durable record still remains available for a future bulk-teardown-of-a-pipeline's-whole-process-tree feature to consume.

## config.json reference

`~/.flow/config.json` is created by `flow install` and read at launch. The keys in use today:

| key                  | what it controls                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `modules`            | the persisted module selection from `flow install` (see above)                                                    |
| `models.*`           | per-phase model routing (see [Per-phase models](#per-phase-models))                                               |
| `delegate.models.*`  | per-surface agy delegate-model routing (see [Delegate models](#delegate-models))                                  |
| `update.checkFor`    | staleness-notice behaviour; set `"off"` to silence (or export `FLOW_UPDATE_CHECK=off`)                            |
| `update.autoUpgrade` | reserved future opt-in for automatic upgrades (default off, parsed but not yet executing)                         |
| `research.discovery` | opt-in for web-grounded discovery research on every pipeline (`flow feature create --research` forces it per run) |
| `launcher`           | set with `flow config launcher set tmux` — makes the tmux launcher your default instead of the plain shell        |

The plain shell stays the default launcher unless you opt in: per run with `flow feature create --tmux "<desc>"`, or globally with `flow config launcher set tmux`.

## Delegate models

`delegate.models.<surface>` (`bin/lib/delegate-models.ts`) routes the agy
(Google AI Ultra, via `flow-delegate`) model used by each cross-model
delegate surface — distinct from `models.*` above, which routes the
**Claude Code** model for pipeline phases. Value grammar: an agy variant
**display-name** string, e.g. `"Gemini 3.1 Pro (High)"` (the form
`flow-delegate` accepts on `--model`, not the slug form `agy models`
emits). Absent key = today's default for that surface; a present but
wrong-typed value warns on stderr and falls back to the default; never
throws.

| surface            | what it drives                                                           | default today                             |
| ------------------ | ------------------------------------------------------------------------ | ----------------------------------------- |
| `intentGuess`      | `/flow-pr-review` cross-model intent guess                               | `Gemini 3.1 Pro (High)`                   |
| `reviewLens`       | `/flow-pr-review` Gemini review lens                                     | `Gemini 3.1 Pro (High)`                   |
| `researchGather`   | forced-research gather pass                                              | `Gemini 3.1 Pro (High)`                   |
| `researchRefute`   | forced-research adversarial refute pass                                  | `Claude Opus 4.6 (Thinking)`              |
| `planReview`       | `/flow-pipeline` step 3 plan review, reviewer 1                          | `Gemini 3.1 Pro (High)`                   |
| `planReviewSecond` | `/flow-pipeline` step 3 plan review, deep-tier reviewer 2                | `Claude Opus 4.6 (Thinking)`              |
| `scout`            | reserved — not yet wired; scouting still spawns the Claude Task subagent | `null` (no effect on any code path today) |

**Namespace disambiguation — `models.scout` vs `delegate.models.scout`:**
these two keys share the `scout` suffix but mean opposite things and use
disjoint value grammars. `models.scout` (see [Per-phase
models](#per-phase-models)) is a **Claude Code model alias**
(`opus`/`haiku`/`sonnet`/`fable`) for the Step-1b scout **Task subagent**,
and it IS wired. `delegate.models.scout` is an **agy variant display-name
string** that is meant to eventually mean "delegate scouting to agy instead
of spawning the Task subagent at all" — but no code reads it yet (the
default flip is gated on a benchmark clear that has not happened yet), so
**setting it today is a silent no-op**: scouting keeps using the Claude
Task subagent regardless of this key's value. Setting
one has no effect on the other.
