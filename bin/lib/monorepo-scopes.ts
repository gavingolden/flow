/**
 * Zero-config monorepo auto-detect + a tolerant `.flow/pre-commit.json`
 * reader + a pure Layer-3 draft helper, all consumed by `flow-pre-commit.ts`
 * as a SEPARATE layered pass over the files no built-in scope claimed.
 *
 * Modeled on `bin/lib/copilot-config.ts`: injectable `Read*` seams, boundary
 * validation, `undefined`/`null` on any malformation, never a throw. The
 * config path is the REPO-RELATIVE `.flow/pre-commit.json` (read cwd-relative
 * like `loadDefinedNpmScripts`), NOT the per-machine `~/.flow/config.json`.
 */

import {
  resolveChecks,
  type CheckDef,
  type ReadPackageJson,
} from "./stack-table";

/** A scope discovered at runtime (auto-detect or config) — distinct from the
 * closed built-in `Scope` union so the union never widens in place. */
export type DynamicScope = {
  /** Selectable name, e.g. `apps/web` (a package path) or a configured name. */
  name: string;
  /** Prefixes a changed file must start with to belong to this scope. */
  prefixes: string[];
  checks: CheckDef[];
};

const WORKSPACE_ROOTS = ["apps/", "packages/"];

/** Built-in scope names a configured entry may never collide with. */
const BUILTIN_SCOPE_NAMES = new Set([
  "src",
  "scripts",
  "docs",
  "actions",
  "backend",
  "root-fallback",
]);

/**
 * Derives the owning `apps/<pkg>/` or `packages/<pkg>/` prefix for a file, or
 * `undefined` when the file does not live two-or-more segments under a
 * workspace root. `apps/web/src/x.ts` → `apps/web/`; a bare `apps/x.ts`
 * (no package dir) → `undefined`.
 */
export function workspacePrefixOf(file: string): string | undefined {
  for (const root of WORKSPACE_ROOTS) {
    if (!file.startsWith(root)) continue;
    const rest = file.slice(root.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return undefined;
    const pkg = rest.slice(0, slash);
    return `${root}${pkg}/`;
  }
  return undefined;
}

/**
 * Auto-detects conventional monorepo scopes for the unmatched-file remainder.
 * A prefix becomes a scope ONLY when its `<pkg>/package.json` owner exists
 * (confirmed via the injected `readPkgJson` seam) — a bare `apps/web/src/x.ts`
 * with no `apps/web/package.json` is NOT a workspace and stays an orphan. The
 * scope name is the package path (e.g. `apps/web`) so `--scope apps/web` is
 * selectable. Checks resolve through `resolveChecks` in the `-w <pkg>` form.
 */
export function detectWorkspaceScopes(
  unmatchedFiles: string[],
  readPkgJson: ReadPackageJson,
): DynamicScope[] {
  const byPrefix = new Map<string, DynamicScope>();
  for (const file of unmatchedFiles) {
    const prefix = workspacePrefixOf(file);
    if (!prefix || byPrefix.has(prefix)) continue;
    const pkgJsonPath = `${prefix}package.json`;
    const raw = readPkgJson(pkgJsonPath);
    if (raw === undefined) continue;
    const workspacePath = prefix.replace(/\/$/, "");
    const checks = resolveChecks({
      marker: "package.json",
      readPackageJson: readPkgJson,
      pkgPath: pkgJsonPath,
      workspacePath,
    });
    byPrefix.set(prefix, { name: workspacePath, prefixes: [prefix], checks });
  }
  return [...byPrefix.values()];
}

/** A configured scope from `.flow/pre-commit.json`. */
export type ConfigScope = {
  name: string;
  prefixes: string[];
  checks: CheckDef[];
};

/** Read seam for the repo-relative `.flow/pre-commit.json`. Returns the raw
 * parsed JSON, or `undefined` when the file is absent/unreadable/non-JSON.
 * Mirrors `copilot-config.ts`'s `ReadConfigFile`. */
export type ReadConfigFile = () => unknown;

function stringArray(x: unknown): string[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out = x.filter((e): e is string => typeof e === "string");
  return out.length === x.length ? out : undefined;
}

/** Coerces one raw config entry into a ConfigScope, or `undefined` on any
 * shape violation (name not a string / colliding with a built-in, prefixes
 * not a string[], checks not a string[]). Each check string becomes a CheckDef
 * whose argv is the whitespace-split command. */
function parseConfigScope(raw: unknown): ConfigScope | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const name = obj.name;
  if (typeof name !== "string" || name.length === 0) return undefined;
  if (BUILTIN_SCOPE_NAMES.has(name)) return undefined;
  const prefixes = stringArray(obj.prefixes);
  if (!prefixes || prefixes.length === 0) return undefined;
  const checks = stringArray(obj.checks);
  if (!checks) return undefined;
  return {
    name,
    prefixes,
    checks: checks.map((cmd) => ({
      name: cmd,
      argv: cmd.split(/\s+/).filter(Boolean),
    })),
  };
}

/**
 * Tolerant reader of `.flow/pre-commit.json`. Accepts either a top-level array
 * of scope entries or `{ scopes: [...] }`. Returns the well-formed scopes (any
 * malformed entry is dropped), or `undefined` when the file is
 * absent/unreadable/non-JSON/wrong-shaped. Never throws.
 */
export function readMonorepoConfig(
  read: ReadConfigFile,
): ConfigScope[] | undefined {
  const raw = read();
  if (raw === undefined) return undefined;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" &&
        raw !== null &&
        Array.isArray((raw as Record<string, unknown>).scopes)
      ? ((raw as Record<string, unknown>).scopes as unknown[])
      : undefined;
  if (!list) return undefined;
  const scopes: ConfigScope[] = [];
  for (const entry of list) {
    const parsed = parseConfigScope(entry);
    if (parsed) scopes.push(parsed);
  }
  return scopes;
}

/**
 * Merges the three scope sources by prefix precedence: config > auto-detect >
 * built-in. A configured scope shadows an auto-detected one claiming the same
 * prefix; an auto-detected scope shadows nothing built-in (built-ins are the
 * closed union and matched upstream), but is dropped when a configured scope
 * already owns its prefix. Returns the dynamic scopes that survive.
 */
export function mergeScopeSources(
  autoDetected: DynamicScope[],
  configured: ConfigScope[],
): DynamicScope[] {
  const configuredPrefixes = new Set(configured.flatMap((c) => c.prefixes));
  const survivingAuto = autoDetected.filter(
    (a) => !a.prefixes.some((p) => configuredPrefixes.has(p)),
  );
  return [...configured, ...survivingAuto];
}

/**
 * Pure Layer-3 draft helper. Given orphan files no scope claimed, returns a
 * `.flow/pre-commit.json` entry for a recognizable-but-uncovered layout (a
 * workspace dir owning a `package.json`), or `null` for a genuine orphan (no
 * owner, no stack marker). The supervisor commits the returned entry into the
 * PR diff — this helper makes no LLM call and writes nothing.
 */
export function draftConfigEntryForOrphans(
  orphans: string[],
  readPkgJson: ReadPackageJson,
): ConfigScope | null {
  for (const file of orphans) {
    const prefix = workspacePrefixOf(file);
    if (!prefix) continue;
    const pkgJsonPath = `${prefix}package.json`;
    if (readPkgJson(pkgJsonPath) === undefined) continue;
    const workspacePath = prefix.replace(/\/$/, "");
    const checks = resolveChecks({
      marker: "package.json",
      readPackageJson: readPkgJson,
      pkgPath: pkgJsonPath,
      workspacePath,
    });
    if (checks.length === 0) continue;
    return { name: workspacePath, prefixes: [prefix], checks };
  }
  return null;
}
