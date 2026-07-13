/**
 * Single source of truth for `flow`'s top-level and per-verb help text.
 *
 * Every verb's CLI shim must call `argsContainHelp(args)` before parsing
 * args or producing side-effects. The check existed only at the verb
 * position before — `flow feature create --help` slugified `--help` to `help` and
 * spawned a phantom pipeline. The helpers here close that gap.
 */

const HELP_FLAGS = new Set(["--help", "-h"]);

export function isHelpFlag(arg: string | undefined): boolean {
  return arg !== undefined && HELP_FLAGS.has(arg);
}

export function argsContainHelp(args: string[]): boolean {
  // Stop scanning at `--` (POSIX end-of-options) so a literal `-h` or
  // `--help` inside a `flow feature create <description>` body — e.g. `flow feature create -- fix
  // the -h crash` — isn't mistaken for a help flag and doesn't suppress the
  // pipeline. Without this, `argsContainHelp(["fix", "-h", "crash"])` would
  // return true and short-circuit a real run.
  for (const a of args) {
    if (a === "--") return false;
    if (HELP_FLAGS.has(a)) return true;
  }
  return false;
}

export const HELP_TOP = `flow — tmux-driven pipelines for Claude Code

Usage:
  flow install [--upgrade] [--force] [--source <path>] [--no-completions] [--no-hooks] [--no-pull-canonical] [--repair-settings] [--install-deps] [--modules <csv>|--all|--core-only]
                                        install skills, agents, helpers globally
                                        (--source overrides the install root,
                                        e.g. for /flow-pipeline step 5.5 in a worktree;
                                        --no-completions skips rc-file editing;
                                        --no-hooks skips the Stop-hook merge into ~/.claude/settings.json;
                                        --no-pull-canonical skips pulling the canonical source before symlinking;
                                        --repair-settings backs up and rewrites ~/.claude/settings.json when malformed;
                                        --install-deps installs missing source-root runtime deps before symlinking;
                                        --modules selects a comma-separated module-id list (core always folded in);
                                        --all selects every module; --core-only selects core alone;
                                        the three are mutually exclusive; absent any of them, an interactive
                                        terminal is asked once per optional module and a non-interactive run
                                        defaults to core only)
  flow feature create [--no-auto-merge] [--wait-for-copilot] [--research] [--copilot-review <auto|always|never>] [--effort <low|medium|high|xhigh|max>] [--model <opus|haiku|sonnet|fable>] [--model-<phase> <alias>] [--slug <slug>] <description>
                                        start a new pipeline in a tmux window
                                        (--no-auto-merge stops at gated regardless of rubric;
                                        --wait-for-copilot forces the full 10-min Copilot wait
                                        even when auto-detect would skip;
                                        --research forces web-grounded discovery research on,
                                        bypassing the relevance gate and the research.discovery config opt-in;
                                        --copilot-review controls Copilot review opt-in, default auto;
                                        --effort sets the Claude Code reasoning-effort level for the claude session;
                                        --model sets the whole-session Claude model alias;
                                        --model-<phase> overrides just one phase — planning/implement/review/verify/
                                        fix-applier/consolidator/merge-resolver; see 'flow help feature';
                                        --slug uses an explicit slug instead of deriving one from the description;
                                        hard-fails if that slug's window already exists)
  flow feature resume <name> [<name> ...]  resume one or more crashed pipelines (>=2 prompts to confirm; -y/--yes bypasses)
  flow epic <create|run|status|bind|launch|ls|done> design and run an epic
  flow config models [--slug <name>] [--json]
                                        show the resolved model + effort + source for every
                                        pipeline phase and fan-out sub-agent (--slug overlays a
                                        pipeline's per-run overrides; --json emits machine-readable rows)
  flow ls [--cost [--detail]]           list active pipelines (cost adds $ column; detail breaks it down by model)
  flow attach [<name>]                  attach to a pipeline window — single window only  (alias: a)
  flow done <name> [<name> ...]         close one or more pipeline windows
  flow done --merged                    close every merged or cancelled window
  flow done --orphans                   close every state file whose tmux window is gone
  flow done --merged --orphans          compose: close terminal-state OR orphaned pipelines
  flow completion <bash|zsh>            print a shell completion script to stdout

  flow --version                        print the installed flow version
  flow --help                           this help
  flow help <verb>                      print verb-specific usage

Run 'flow install' once after cloning the flow source. Pipelines run inside
tmux windows; the supervisor skill (/flow-pipeline) drives each one.
Shell completions install automatically into ~/.zshrc / ~/.bashrc /
~/.bash_profile via 'flow install' — opt out with --no-completions.`;

export const HELP_TEXT: Record<string, string> = {
  feature: `flow feature — start or resume a pipeline in a tmux window

Usage:
  flow feature create [--no-auto-merge] [--wait-for-copilot] [--research] [--copilot-review <auto|always|never>] [--effort <low|medium|high|xhigh|max>] [--model <opus|haiku|sonnet|fable>] [--model-<phase> <alias>] [--slug <slug>] <description>
  flow feature resume <name> [<name> ...] [--yes]

Subcommands:
  create <description>  start a new pipeline in a tmux window
  resume <name> [<name> ...]
                        resume one or more crashed pipelines in their existing windows;
                        resumes sequentially, and with >=2 names previews the list and
                        confirms once (each name spawns a Claude Code session)

Options (create):
  --no-auto-merge       stop at gated regardless of the auto-merge rubric
  --wait-for-copilot    force the full 10-min Copilot wait even when auto-detect would skip
  --research            force web-grounded discovery research on, bypassing the relevance gate
                        and the research.discovery config opt-in
  --copilot-review <auto|always|never>
                        opt-in for Copilot review (default auto): 'always' always requests,
                        'never' never requests, 'auto' lets the hybrid classifier decide
  --effort <low|medium|high|xhigh|max>
                        Claude Code reasoning-effort level for the pipeline's claude session
  --model <opus|haiku|sonnet|fable>
                        whole-session Claude model alias (omit for the default; also settable via
                        ~/.flow/config.json models.default)
  --model-planning|--model-implement|--model-review|--model-verify|--model-fix-applier|--model-consolidator|--model-merge-resolver <alias>
                        override the model for just that phase (alias one of opus|haiku|sonnet|fable).
                        Precedence: --model-<phase> > config.models.<phase> > inherited session model.
                        verify is the one exception — it defaults to sonnet, NOT the session model.
                        scout/coder are finer-grain config-only (config.models.scout|coder, no flag);
                        the gatekeeper stays pinned to haiku (no flag). See README 'Per-phase models'.
  --slug <slug>         use an explicit slug instead of deriving one from the description;
                        hard-fails if that slug's window already exists

Options (resume):
  --yes, -y             skip the multi-resume confirmation preview`,

  epic: `flow epic — design and run an epic

Usage:
  flow epic create [--effort <low|medium|high|xhigh|max>] [--model <opus|haiku|sonnet|fable>] [--model-planning <alias>] "<prompt>"
  flow epic run <slug> [--model <alias>] [--effort <level>]
  flow epic status <slug> [--json]
  flow epic bind <epic-slug> <feature-id> <feature-slug> [--force]
  flow epic bind <epic-slug> <feature-id> --external "<ref>" [--force]
  flow epic launch <epic-slug> <feature-id> [--model <alias>] [--effort <level>] [--force]
  flow epic ls
  flow epic done <slug> [--yes]

Subcommands:
  create "<prompt>"     design an epic — open a tmux window running /epic-create
                        (clarify → design → validate → open the design PR)
  run <slug>            open the /epic-run playbook window: an LLM reconciles the
                        committed manifest against GitHub/git truth and takes one
                        deliberate step at a time (no tick loop, no sub-agents).
                        Also invocable directly as \`/epic-run <slug>\` in any
                        existing Claude session
  status <slug>         render the live board (read-only): per-feature status,
                        launched slug + PR + phase, and the current frontier.
                        --json emits a machine-readable board framed as a
                        hypothesis to verify against GitHub/git
  bind <epic> <id> ...  repoint or adopt a feature's run.json binding safely:
                        \`<feature-slug>\` binds a live pipeline; \`--external
                        "<ref>"\` records a completed out-of-band feature
  launch <epic> <id>    atomically create + bind a feature (manifest read →
                        \`flow feature create\` → binding recorded)
  ls                    list every epic under ~/.flow/epics with per-state
                        feature counts and overall status
  done <slug>           remove the recomputable per-machine ~/.flow/epics/<slug>/
                        runtime state (does NOT close the design window or
                        pipeline state — use \`flow done <slug>\` for those)

Options (create):
  --effort <low|medium|high|xhigh|max>
                        Claude Code reasoning-effort level for the epic-design session
  --model <opus|haiku|sonnet|fable>
                        whole-session Claude model alias for the epic-design session (omit for the default)
  --model-planning <alias>
                        model for just the design/planning phase (the epic design phase shares the
                        feature planning knob). Precedence: --model-planning > config.models.planning > inherited

Options (run):
  --model <alias>       whole-session Claude model alias for the /epic-run supervisor session
  --effort <low|medium|high|xhigh|max>
                        Claude Code reasoning-effort level for the /epic-run supervisor session

Options (launch):
  --model <opus|haiku|sonnet|fable>
                        per-launch model override — wins over the manifest's flowNewHints
                        for this one launch (never mutates the committed manifest)
  --effort <low|medium|high|xhigh|max>
                        per-launch reasoning-effort override — wins over the manifest's
                        flowNewHints for this one launch

Options (bind / launch):
  --external "<ref>"    (bind) record a completed out-of-band feature (a PR/issue
                        that merged with no flow pipeline); no live slug
  --force               overwrite a differing existing binding (bind) / relaunch
                        an already-bound feature (launch); on bind also bypasses
                        the target-slug typo guard

Options (done):
  --yes, -y             skip the confirmation prompt`,

  config: `flow config — inspect flow configuration

Usage:
  flow config models [--slug <name>] [--json]

Subcommands:
  models                print the effective Claude model + reasoning effort for
                        every pipeline phase and fan-out sub-agent (session,
                        planning, scout, coder, verify, review, fix-applier,
                        consolidator, merge-resolver, gatekeeper),
                        with a SOURCE column showing where each value resolved
                        from (per-run flag/state, global config, built-in
                        fallback, pinned, or inherited-session)

Options (models):
  --slug <name>         overlay a specific pipeline's ~/.flow/state/<name>.json
                        per-run overrides on top of the global-defaults view;
                        a name with no state file exits non-zero (no table)
  --json                emit the rows as a machine-readable JSON array
                        ({phase, model, source, effort}) with no color or footer

Read-only: reports routing, not spend — see 'flow ls --cost' for realized cost.`,

  ls: `flow ls — list active pipelines

Lists each pipeline with its repository, phase, PR, and last activity.

Usage:
  flow ls [--cost [--detail]]

Options:
  --cost                add a $ column summing supervisor-session cost
  --detail              break the cost down by model (requires --cost)`,

  attach: `flow attach — attach to a pipeline window  (alias: a)

Usage:
  flow attach [<name>]

When <name> is omitted, attach into the 'flow' session for browsing; if
several windows exist the most-recently-active one is focused first.
With <name>, it must match a window in the 'flow' tmux session.

attach takes a single window only — a tmux client attaches to exactly one
window, so passing more than one <name> is an error (not a silent drop).`,

  done: `flow done — close a pipeline window and remove its state

Usage:
  flow done <name> [<name> ...]
  flow done --merged
  flow done --orphans
  flow done --merged --orphans

Options:
  --merged              close every pipeline whose phase is 'merged' or 'cancelled'
  --orphans             close every pipeline whose state file has no matching tmux window
  --yes, -y             skip the confirmation prompt

Pass two or more <name>s to close several pipelines in one confirm-once sweep
(an unknown name warns and forces a non-zero exit while the rest still close).
When both --merged and --orphans are passed, the sweep unions the two filters
and tags each preview row 'merged', 'orphan', or 'merged+orphan'.`,

  install: `flow install — install skills, agents, helpers globally

Usage:
  flow install [--upgrade] [--force] [--source <path>] [--no-completions] [--no-hooks] [--no-pull-canonical] [--repair-settings] [--install-deps] [--modules <csv>|--all|--core-only]

Options:
  --upgrade              update existing symlinks to point at the current source
  --force                overwrite user-modified files at managed paths
  --source <path>        override the flow source root (e.g. /flow-pipeline step 5.5)
  --no-completions       skip rc-file editing for shell completions
  --no-hooks             skip the Claude Code Stop-hook merge into ~/.claude/settings.json
                         (use when you manage settings.json by hand)
  --no-pull-canonical    skip pulling the canonical source before symlinking
  --repair-settings      back up and rewrite ~/.claude/settings.json when malformed
  --install-deps         install missing source-root runtime dependencies before symlinking
                         (default is to report the missing package and exit non-zero)
  --modules <csv>        select exactly these module ids (core is always folded in)
  --all                  select every module (mutually exclusive with --modules/--core-only)
  --core-only            select core alone, skipping the Q&A (sugar for --modules core)
                         (absent all three, an interactive terminal is asked once per
                         optional module and a non-interactive run defaults to core only,
                         printing a one-line notice; the resolved selection persists to
                         ~/.flow/config.json and --upgrade never re-asks)`,

  completion: `flow completion — print a shell completion script to stdout

Usage:
  flow completion <bash|zsh>

Source the output in your shell rc to enable tab-completion. 'flow install'
installs completions automatically; this verb is the escape hatch for
read-only homedirs (NixOS, Guix) or explicit eval-based sourcing.`,

  version: `flow version — print the installed flow version

Usage:
  flow --version
  flow -v
  flow version`,
};

export function printTopHelp(): void {
  console.log(HELP_TOP);
}

export function printVerbHelp(verb: string): number {
  const text = HELP_TEXT[verb];
  if (!text) {
    console.error(`flow help: unknown verb '${verb}'`);
    console.error(`run 'flow --help' for available verbs.`);
    return 1;
  }
  console.log(text);
  return 0;
}

/**
 * `flow help` (no args) → top-level help.
 * `flow help <verb>`    → that verb's usage block.
 * `flow help <unknown>` → error, exit 1.
 *
 * Self-references (`help`, `--help`, `-h`) collapse to top-level. Aliases
 * (`a` → `attach`, `-v` / `--version` → `version`) canonicalize to the
 * verb name registered in `HELP_TEXT`. Lives here (not `bin/flow`) so the
 * canonicalization + dispatch is unit-testable without spawning Bun.
 */
export function runHelpVerb(args: string[]): number {
  if (args.length === 0) {
    printTopHelp();
    return 0;
  }
  const target = args[0];
  if (target === "help" || target === "--help" || target === "-h") {
    printTopHelp();
    return 0;
  }
  const canonical =
    target === "a"
      ? "attach"
      : target === "-v" || target === "--version"
        ? "version"
        : target;
  return printVerbHelp(canonical);
}
