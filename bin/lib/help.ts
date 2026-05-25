/**
 * Single source of truth for `flow`'s top-level and per-verb help text.
 *
 * Every verb's CLI shim must call `argsContainHelp(args)` before parsing
 * args or producing side-effects. The check existed only at the verb
 * position before — `flow new --help` slugified `--help` to `help` and
 * spawned a phantom pipeline. The helpers here close that gap.
 */

const HELP_FLAGS = new Set(["--help", "-h"]);

export function isHelpFlag(arg: string | undefined): boolean {
  return arg !== undefined && HELP_FLAGS.has(arg);
}

export function argsContainHelp(args: string[]): boolean {
  // Stop scanning at `--` (POSIX end-of-options) so a literal `-h` or
  // `--help` inside a `flow new <description>` body — e.g. `flow new -- fix
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
  flow setup [--upgrade] [--force] [--source <path>] [--no-completions] [--no-hooks] [--repair-settings]
                                        install skills, agents, helpers globally
                                        (--source overrides the install root,
                                        e.g. for /flow-pipeline step 5.5 in a worktree;
                                        --no-completions skips rc-file editing;
                                        --no-hooks skips the Stop-hook merge into ~/.claude/settings.json;
                                        --repair-settings backs up and rewrites ~/.claude/settings.json when malformed)
  flow new [--no-auto-merge] [--agent <runtime>] <description>
                                        start a new pipeline in a tmux window
                                        (--no-auto-merge stops at gated regardless of rubric;
                                        --agent picks claude or antigravity, auto-detected from env when omitted)
  flow new --resume <name>              resume a crashed pipeline in its existing window
  flow ls [--cost [--detail]]           list active pipelines (cost adds $ column; detail breaks it down by model)
  flow attach [<name>]                  attach to a pipeline window  (alias: a)
  flow done <name>                      close a pipeline window
  flow done --merged                    close every merged or cancelled window
  flow done --orphans                   close every state file whose tmux window is gone
  flow done --merged --orphans          compose: close terminal-state OR orphaned pipelines
  flow migrate [--apply] [--scan <p>]   clean up legacy per-repo flow install
  flow completion <bash|zsh>            print a shell completion script to stdout

  flow --version                        print the installed flow version
  flow --help                           this help
  flow help <verb>                      print verb-specific usage

Run 'flow setup' once after cloning the flow source. Pipelines run inside
tmux windows; the supervisor skill (/flow-pipeline) drives each one.
Shell completions install automatically into ~/.zshrc / ~/.bashrc /
~/.bash_profile via 'flow setup' — opt out with --no-completions.`;

export const HELP_TEXT: Record<string, string> = {
  new: `flow new — start a new pipeline in a tmux window

Usage:
  flow new [--no-auto-merge] [--agent <claude|antigravity>] <description>
  flow new --resume <name>

Options:
  --no-auto-merge       stop at gated regardless of the auto-merge rubric
  --agent <runtime>     pick the AI runtime (claude | antigravity); auto-detected
                        from CLAUDE_CODE_SESSION_ID / ANTIGRAVITY_CONVERSATION_ID
                        env vars when omitted
  --resume <name>       resume a crashed pipeline in its existing window`,

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
With <name>, it must match a window in the 'flow' tmux session.`,

  done: `flow done — close a pipeline window and remove its state

Usage:
  flow done <name>
  flow done --merged
  flow done --orphans
  flow done --merged --orphans

Options:
  --merged              close every pipeline whose phase is 'merged' or 'cancelled'
  --orphans             close every pipeline whose state file has no matching tmux window
  --yes, -y             skip the confirmation prompt

When both --merged and --orphans are passed, the sweep unions the two filters
and tags each preview row 'merged', 'orphan', or 'merged+orphan'.`,

  migrate: `flow migrate — exit ramp from per-repo 'flow install'

Usage:
  flow migrate [--apply] [--include-orchestrator]
  flow migrate --scan <path>

Options:
  --apply                  execute the plan (default is dry-run)
  --scan <path>            dry-run across every git repo under <path>
  --include-orchestrator   also rm -rf .orchestrator/`,

  setup: `flow setup — install skills, agents, helpers globally

Usage:
  flow setup [--upgrade] [--force] [--source <path>] [--no-completions] [--no-hooks] [--repair-settings]

When ~/.gemini/ exists, additionally installs the agy plugin at
~/.gemini/config/plugins/flow/ so flow runs under Antigravity too.

Options:
  --upgrade              update existing symlinks to point at the current source
  --force                overwrite user-modified files at managed paths
  --source <path>        override the flow source root (e.g. /flow-pipeline step 5.5)
  --no-completions       skip rc-file editing for shell completions
  --no-hooks             skip the Claude Code Stop-hook merge into ~/.claude/settings.json
                         (use when you manage settings.json by hand)
  --repair-settings      back up and rewrite ~/.claude/settings.json when malformed`,

  completion: `flow completion — print a shell completion script to stdout

Usage:
  flow completion <bash|zsh>

Source the output in your shell rc to enable tab-completion. 'flow setup'
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
