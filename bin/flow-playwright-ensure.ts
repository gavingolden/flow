#!/usr/bin/env bun
/**
 * Installs the Chromium build the repo's installed Playwright version pins, when
 * it is missing. Run after a dependency reinstall that may bump Playwright (the
 * merge-resolver's lockfile-conflict row); worktree creation does the same step
 * itself. Prints one line when it installed, failed, or found downloads turned
 * off; prints nothing otherwise. Always exits 0 except on usage errors.
 *
 * Usage:
 *   flow-playwright-ensure [--worktree <path>]
 */
import { resolve } from "node:path";
import {
  ensurePinnedBrowser,
  formatEnsureLine,
  type EnsureResult,
} from "./lib/playwright-browsers";

export type EnsureCliDeps = {
  ensure: (worktree: string) => Promise<EnsureResult>;
  print: (line: string) => void;
  printErr: (line: string) => void;
};

const defaultCliDeps: EnsureCliDeps = {
  ensure: (worktree) => ensurePinnedBrowser(worktree),
  print: (line) => console.log(line),
  printErr: (line) => console.error(line),
};

const USAGE = "usage: flow-playwright-ensure [--worktree <path>]";

export async function run(
  argv: string[],
  deps: EnsureCliDeps = defaultCliDeps,
): Promise<number> {
  let worktree = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--worktree") {
      const v = argv[++i];
      if (!v) {
        deps.printErr(USAGE);
        return 2;
      }
      worktree = resolve(v);
    } else {
      deps.printErr(`flow-playwright-ensure: unknown argument: ${a}`);
      deps.printErr(USAGE);
      return 2;
    }
  }
  const line = formatEnsureLine(await deps.ensure(worktree));
  if (line) deps.print(line);
  return 0;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
