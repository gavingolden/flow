/**
 * `flow --version` / `flow -v` / `flow version` — print the version from the
 * flow source's package.json. Reuses resolveFlowSource() so the version lines
 * up with the install on PATH (matching the passthrough's source resolution).
 */

import { argsContainHelp, printVerbHelp } from "./help";
import { resolveFlowSource } from "./paths";
import { readFlowVersion } from "./pkg-version";
import {
  checkForUpdate,
  formatUpdateNotice,
  type UpdateCheckResult,
} from "./update-check";

export type VersionOptions = {
  /** Override the flow source root (test-only). */
  flowSource?: string;
  /** Injectable for tests; defaults to the real read-only update check. */
  checkUpdate?: () => UpdateCheckResult;
};

/**
 * CLI shim for `bin/flow`'s `version` / `--version` / `-v` verb. Intercepts
 * --help / -h before any fs read, then dispatches to `runVersion`.
 */
export function runVersionCli(
  args: string[],
  opts: VersionOptions = {},
): number {
  if (argsContainHelp(args)) {
    printVerbHelp("version");
    return 0;
  }
  return runVersion(opts);
}

export function runVersion(opts: VersionOptions = {}): number {
  const source = opts.flowSource ?? resolveFlowSource();

  let version: string;
  try {
    version = readFlowVersion(source);
  } catch (err) {
    console.error(`flow: ${(err as Error).message}`);
    return 1;
  }

  console.log(version);
  // STDERR, on a separate line — never concatenated onto the bare version
  // token that downstream parsers read from stdout.
  const notice = formatUpdateNotice((opts.checkUpdate ?? checkForUpdate)());
  if (notice) console.error(notice);
  return 0;
}
