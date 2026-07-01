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
  flow install [--upgrade] [--force] [--source <path>] [--no-completions] [--no-hooks] [--no-pull-canonical] [--repair-settings] [--install-deps]
                                        install skills, agents, helpers globally
                                        (--source overrides the install root,
                                        e.g. for /flow-pipeline step 5.5 in a worktree;
                                        --no-completions skips rc-file editing;
                                        --no-hooks skips the Stop-hook merge into ~/.claude/settings.json;
                                        --no-pull-canonical skips pulling the canonical source before symlinking;
                                        --repair-settings backs up and rewrites ~/.claude/settings.json when malformed;
                                        --install-deps installs missing source-root runtime deps before symlinking)
  flow feature create [--no-auto-merge] [--wait-for-copilot] [--research] [--copilot-review <auto|always|never>] [--effort <low|medium|high|xhigh|max>] [--model <opus|haiku|sonnet|fable>] <description>
                                        start a new pipeline in a tmux window
                                        (--no-auto-merge stops at gated regardless of rubric;
                                        --wait-for-copilot forces the full 10-min Copilot wait
                                        even when auto-detect would skip;
                                        --research forces web-grounded discovery research on,
                                        bypassing the relevance gate and the research.discovery config opt-in;
                                        --copilot-review controls Copilot review opt-in, default auto;
                                        --effort sets the Claude Code reasoning-effort level for the claude session;
                                        --model sets the Claude Code model alias for the claude session)
  flow feature resume <name> [<name> ...]  resume one or more crashed pipelines (>=2 prompts to confirm; -y/--yes bypasses)
  flow epic <create|run|status|ls>      design and run an epic (create, run, status, ls)
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
  flow feature create [--no-auto-merge] [--wait-for-copilot] [--research] [--copilot-review <auto|always|never>] [--effort <low|medium|high|xhigh|max>] [--model <opus|haiku|sonnet|fable>] <description>
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
                        Claude Code model alias for the pipeline's claude session (omit for the default)

Options (resume):
  --yes, -y             skip the multi-resume confirmation preview`,

  epic: `flow epic — design and run an epic

Usage:
  flow epic create [--effort <low|medium|high|xhigh|max>] [--model <opus|haiku|sonnet|fable>] "<prompt>"
  flow epic run <slug> [--once] [--max-parallel <N>]
  flow epic status <slug>
  flow epic ls

Subcommands:
  create "<prompt>"     design an epic — open a tmux window running /epic-create
                        (clarify → design → validate → open the design PR)
  run <slug>            drive a merged epic to completion: read the committed
                        manifest, launch ready features as parallel
                        \`flow feature create\` windows in dependency order, and
                        watch for merges to advance the frontier until the epic
                        finishes or blocks
  status <slug>         render the live board (read-only): per-feature status,
                        launched slug + PR + phase, and the current frontier
  ls                    list every epic under ~/.flow/epics with per-state
                        feature counts and overall status

Options (create):
  --effort <low|medium|high|xhigh|max>
                        Claude Code reasoning-effort level for the epic-design session
  --model <opus|haiku|sonnet|fable>
                        Claude Code model alias for the epic-design session (omit for the default)

Options (run):
  --once                advance exactly one tick (launch the current frontier,
                        print the board, exit) — no watch loop
  --max-parallel <N>    cap concurrent feature windows (default 3, or
                        ~/.flow/config.json epic.maxParallel)`,

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
  flow install [--upgrade] [--force] [--source <path>] [--no-completions] [--no-hooks] [--no-pull-canonical] [--repair-settings] [--install-deps]

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
                         (default is to report the missing package and exit non-zero)`,

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
