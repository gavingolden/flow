/**
 * Runtime-dependency resolution check for `flow setup`. Lives in its own
 * module because setup.ts is already over the 200-line budget. Strictly pure:
 * no logging, no process.exit, no spawn — so it runs identically under Bun and
 * vitest's Node. Uses node:fs / node:path (not Bun.resolveSync, which is used
 * nowhere in the repo and would not run under the Node-based vitest suite).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads `<sourceRoot>/package.json` and returns the declared runtime
 * `dependencies` (devDependencies are ignored) that do not resolve against
 * `<sourceRoot>/node_modules/<name>/package.json`. A missing or unparseable
 * package.json yields `{ missing: [] }` — a missing package.json is not this
 * check's failure to own.
 */
export function findMissingRuntimeDeps(sourceRoot: string): { missing: string[] } {
  const pkgPath = join(sourceRoot, "package.json");
  if (!existsSync(pkgPath)) return { missing: [] };
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return { missing: [] };
  }
  const deps =
    pkg && typeof pkg === "object" && "dependencies" in pkg
      ? (pkg as { dependencies?: Record<string, unknown> }).dependencies
      : undefined;
  if (!deps || typeof deps !== "object") return { missing: [] };

  const missing: string[] = [];
  for (const name of Object.keys(deps)) {
    // path.join handles scoped names (@scope/name → @scope/name/package.json).
    if (!existsSync(join(sourceRoot, "node_modules", name, "package.json"))) {
      missing.push(name);
    }
  }
  return { missing };
}

/**
 * Loud, clearly-labelled remediation string naming the unresolved package(s)
 * and the `npm install` (or `--install-deps`) fix. Pure — the caller decides
 * how to surface it.
 */
export function formatMissingDepsError(missing: string[], sourceRoot: string): string {
  const names = missing.join(", ");
  return (
    `! missing runtime dependencies: ${names}\n` +
    `      node_modules at ${sourceRoot} is missing or stale.\n` +
    `      Run "npm install" from ${sourceRoot}, or re-run with --install-deps.`
  );
}
