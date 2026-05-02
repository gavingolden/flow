/**
 * Argument parsing + CLI wrapper for `flow setup`. Kept separate from
 * `bin/lib/setup.ts` so the CLI seam is unit-testable without enlarging
 * the library file (already over the < 200-line target).
 */

import { runSetup, type SetupOptions } from "./setup";

export type ParsedSetupArgs = {
  upgrade: boolean;
  force: boolean;
  flowSource?: string;
};

export type SetupArgsResult = ParsedSetupArgs | { error: string };

const USAGE = "usage: flow setup [--upgrade] [--force] [--source <path>]";
const FLAGS = new Set(["--upgrade", "--force"]);

export function parseSetupArgs(args: string[]): SetupArgsResult {
  const out: ParsedSetupArgs = { upgrade: false, force: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--upgrade") {
      out.upgrade = true;
    } else if (arg === "--force") {
      out.force = true;
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
  const parsed = parseSetupArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    console.error(USAGE);
    return 2;
  }
  const summary = runSetup({ ...parsed, ...extraOptions });
  return summary.blocked > 0 ? 1 : 0;
}
