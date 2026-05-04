/**
 * Argument parsing + CLI wrapper for `flow setup`. Kept separate from
 * `bin/lib/setup.ts` so the CLI seam is unit-testable without enlarging
 * the library file (already over the < 200-line target).
 */

import { argsContainHelp, printVerbHelp } from "./help";
import { resolveFlowSource } from "./paths";
import { runSetup, type SetupOptions } from "./setup";

export type ParsedSetupArgs = {
  upgrade: boolean;
  force: boolean;
  noCompletions: boolean;
  noHooks: boolean;
  flowSource?: string;
};

export type SetupArgsResult = ParsedSetupArgs | { error: string };

const USAGE =
  "usage: flow setup [--upgrade] [--force] [--source <path>] [--no-completions] [--no-hooks]";
const FLAGS = new Set(["--upgrade", "--force", "--no-completions", "--no-hooks"]);

export function parseSetupArgs(args: string[]): SetupArgsResult {
  const out: ParsedSetupArgs = {
    upgrade: false,
    force: false,
    noCompletions: false,
    noHooks: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--upgrade") {
      out.upgrade = true;
    } else if (arg === "--force") {
      out.force = true;
    } else if (arg === "--no-completions") {
      out.noCompletions = true;
    } else if (arg === "--no-hooks") {
      out.noHooks = true;
    } else if (arg === "--source") {
      const value = args[i + 1];
      if (!value || FLAGS.has(value) || value === "--source") {
        return { error: "flow setup: --source requires a path argument" };
      }
      out.flowSource = value;
      i++;
    } else {
      return { error: `flow setup: unknown option '${arg}'` };
    }
  }
  return out;
}

/**
 * CLI wrapper for `bin/flow`'s setup verb. Parses args, delegates to
 * `runSetup`, and translates the resulting `SetupSummary` to a process
 * exit code: blocked symlinks → 1, parser errors → 2, otherwise 0.
 *
 * `extraOptions` is a test-only escape hatch for the same internal
 * overrides that `runSetup` itself accepts (`targets`, `manifestPath`,
 * `lockPath`, `skipPreflight`, `quiet`, …). It also lets a test pass
 * `flowSource` without going through `--source` parsing — handy when the
 * fake source path includes characters that aren't worth round-tripping
 * through arg parsing.
 */
export function runSetupCli(args: string[], extraOptions?: SetupOptions): number {
  if (argsContainHelp(args)) {
    printVerbHelp("setup");
    return 0;
  }
  const parsed = parseSetupArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    console.error(USAGE);
    return 2;
  }
  // Pin installRoot to canonical at the CLI seam when --source is in play.
  // Without this, runSetup's internal fallback through resolveFlowSource()
  // would re-derive installRoot after the wrapper symlink was already
  // poisoned by a prior --source run, collapsing it onto the worktree and
  // stranding the manifest on the next worktree removal.
  const opts: SetupOptions = { ...parsed, ...extraOptions };
  if (parsed.flowSource !== undefined && opts.installRoot === undefined) {
    opts.installRoot = resolveFlowSource(opts.homeDir);
  }
  const summary = runSetup(opts);
  return summary.blocked > 0 ? 1 : 0;
}
