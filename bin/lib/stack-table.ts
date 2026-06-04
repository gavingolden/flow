/**
 * Data-driven stack table + a three-layer command resolver shared by every
 * scope `flow-pre-commit` runs — built-in and auto-detected alike.
 *
 * A "stack" is keyed on a marker file (`package.json` → node, `go.mod` → go).
 * `resolveChecks` resolves what to run for a package in two layers:
 *   - Layer 1 — delegate to the repo's OWN declared verify-class scripts,
 *     probed in a curated order with a safety denylist that matches declared
 *     script NAMES (never command bodies — econ-data's legit `test` =
 *     "npm run test:watch -- --run" must not be denied for referencing a
 *     denylisted name in its body).
 *   - Layer 2 — a stack default set when the package declares nothing (the
 *     go marker's `go vet ./...` + `go test ./...`).
 *
 * Pure and never-throwing: a missing/malformed package.json collapses to "no
 * declared scripts", mirroring `bin/lib/copilot-config.ts`'s tolerant-reader
 * convention. No filesystem I/O lives here — the caller injects the declared
 * scripts (or a `ReadPackageJson` seam) so the resolver stays unit-testable.
 */

export type CheckDef = {
  name: string;
  argv: string[];
};

/**
 * `verifyScriptOrder` groups are probed in order; WITHIN a group the first
 * declared script wins (so a package declaring `check` but not `typecheck`
 * emits `check`, and one declaring both emits only `typecheck`). `denylist`
 * holds exact script NAMES that are never run even on a probe-order match;
 * the suffix rules cover the interactive/long variants that don't fit an
 * exact name (`*:watch`, `*:e2e`) plus the exact `smoketest`.
 */
export type StackEntry = {
  stack: string;
  defaultChecks: CheckDef[];
  verifyScriptOrder?: string[][];
  denylist?: string[];
  denylistSuffixes?: string[];
};

export const STACK_TABLE: Record<string, StackEntry> = {
  "package.json": {
    stack: "node",
    defaultChecks: [],
    verifyScriptOrder: [["typecheck", "check"], ["lint"], ["test"], ["format:check"]],
    denylist: ["format", "dev", "build", "preview", "smoketest"],
    denylistSuffixes: [":watch", ":e2e"],
  },
  "go.mod": {
    stack: "go",
    defaultChecks: [
      { name: "go vet ./...", argv: ["go", "vet", "./..."] },
      { name: "go test ./...", argv: ["go", "test", "./..."] },
    ],
  },
};

/** Read seam for a package's `package.json`. Returns the parsed object, or
 * `undefined` when the file is absent/unreadable/non-JSON. Mirrors
 * `copilot-config.ts`'s `ReadConfigFile`. */
export type ReadPackageJson = (pkgPath: string) => unknown;

/** Extracts the declared npm script names from a tolerantly-read package.json.
 * Any non-object / missing-`scripts` shape collapses to an empty set. */
export function declaredScriptsOf(raw: unknown): Set<string> {
  if (typeof raw !== "object" || raw === null) return new Set();
  const scripts = (raw as Record<string, unknown>).scripts;
  if (typeof scripts !== "object" || scripts === null) return new Set();
  return new Set(Object.keys(scripts as Record<string, unknown>));
}

/** Name-based denylist test — matches the declared script NAME, never the
 * command body. */
function isDenylisted(name: string, entry: StackEntry): boolean {
  if (entry.denylist?.includes(name)) return true;
  return entry.denylistSuffixes?.some((s) => name.endsWith(s)) ?? false;
}

/** Builds an `npm run <script>` CheckDef, optionally workspace-scoped via
 * `-w <pkg-path>`. A bare (root) package omits the `-w` flag. */
export function npmRunCheck(script: string, workspacePath?: string): CheckDef {
  const argv = workspacePath
    ? ["npm", "run", script, "-w", workspacePath]
    : ["npm", "run", script];
  return { name: argv.join(" "), argv };
}

export type ResolveChecksOpts = {
  /** The stack marker file (`package.json`, `go.mod`). */
  marker: string;
  /** Declared npm script names for the package, when known. Supplying this (or
   * a populated `readPackageJson`+`pkgPath`) drives Layer 1. */
  declaredScripts?: Set<string>;
  /** Workspace path for the `-w <pkg-path>` form. Omit for a root package. */
  workspacePath?: string;
  /** Seam to read the package's package.json when `declaredScripts` is not
   * supplied directly. */
  readPackageJson?: ReadPackageJson;
  /** Path passed to `readPackageJson`. */
  pkgPath?: string;
};

/**
 * Resolves the check commands for a package on a given stack marker.
 *
 * Layer 1 (node): emit `npm run <script>` for each verify-class script the
 * package declares, in `verifyScriptOrder`, first-present-wins within a group,
 * skipping denylisted names. Layer 2: when Layer 1 yields nothing, fall back to
 * the stack's `defaultChecks` (the go marker's vet+test). The node marker's
 * `defaultChecks` is empty, so a node package that declares no verify-class
 * script resolves to `[]` — a silent pass, parallel to `filterDefinedChecks`.
 */
export function resolveChecks(opts: ResolveChecksOpts): CheckDef[] {
  const entry = STACK_TABLE[opts.marker];
  if (!entry) return [];

  if (entry.verifyScriptOrder) {
    const declared =
      opts.declaredScripts ??
      (opts.readPackageJson && opts.pkgPath !== undefined
        ? declaredScriptsOf(opts.readPackageJson(opts.pkgPath))
        : new Set<string>());

    const checks: CheckDef[] = [];
    for (const group of entry.verifyScriptOrder) {
      const pick = group.find((s) => declared.has(s) && !isDenylisted(s, entry));
      if (pick) checks.push(npmRunCheck(pick, opts.workspacePath));
    }
    if (checks.length > 0) return checks;
  }

  return entry.defaultChecks;
}
