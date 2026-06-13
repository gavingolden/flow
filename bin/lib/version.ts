/**
 * `flow --version` / `flow -v` / `flow version` — print the version from the
 * flow source's package.json. Reuses resolveFlowSource() so the version lines
 * up with the install on PATH (matching the passthrough's source resolution).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { argsContainHelp, printVerbHelp } from "./help";
import { resolveFlowSource } from "./paths";
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

/**
 * Reads the `version` field from `<source>/package.json`. Throws with a
 * caller-actionable message on a missing/unparseable file or absent field —
 * `runVersion` catches and routes to stderr; other consumers (e.g.
 * `flow setup`'s outcome headline) decide their own degradation.
 */
export function readFlowVersion(source: string): string {
  const pkgPath = path.join(source, "package.json");

  let raw: string;
  try {
    raw = fs.readFileSync(pkgPath, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${pkgPath}: ${(err as Error).message}`);
  }

  let version: unknown;
  try {
    version = (JSON.parse(raw) as { version?: unknown }).version;
  } catch (err) {
    throw new Error(`cannot parse ${pkgPath}: ${(err as Error).message}`);
  }

  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`${pkgPath} has no 'version' field`);
  }

  return version;
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
