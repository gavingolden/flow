/**
 * `flow --version` / `flow -v` / `flow version` — print the version from the
 * flow source's package.json. Reuses resolveFlowSource() so the version lines
 * up with the install on PATH (matching the passthrough's source resolution).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { argsContainHelp, printVerbHelp } from "./help";
import { resolveFlowSource } from "./paths";

export type VersionOptions = {
  /** Override the flow source root (test-only). */
  flowSource?: string;
};

/**
 * CLI shim for `bin/flow`'s `version` / `--version` / `-v` verb. Intercepts
 * --help / -h before any fs read, then dispatches to `runVersion`.
 */
export function runVersionCli(args: string[], opts: VersionOptions = {}): number {
  if (argsContainHelp(args)) {
    printVerbHelp("version");
    return 0;
  }
  return runVersion(opts);
}

export function runVersion(opts: VersionOptions = {}): number {
  const source = opts.flowSource ?? resolveFlowSource();
  const pkgPath = path.join(source, "package.json");

  let raw: string;
  try {
    raw = fs.readFileSync(pkgPath, "utf8");
  } catch (err) {
    console.error(`flow: cannot read ${pkgPath}: ${(err as Error).message}`);
    return 1;
  }

  let version: unknown;
  try {
    version = (JSON.parse(raw) as { version?: unknown }).version;
  } catch (err) {
    console.error(`flow: cannot parse ${pkgPath}: ${(err as Error).message}`);
    return 1;
  }

  if (typeof version !== "string" || version.length === 0) {
    console.error(`flow: ${pkgPath} has no 'version' field`);
    return 1;
  }

  console.log(version);
  return 0;
}
