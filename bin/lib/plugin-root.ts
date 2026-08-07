/**
 * Materializes / refreshes / prunes a flow-owned `.claude-plugin` plugin
 * root directory — one per selected module, at
 * `<skillsDir>/flow-module-<id>/` — plus the shared root-discovery helpers
 * both the launcher (`--plugin-dir` / PATH) and the reap scan consume.
 *
 * Ownership discipline, inherited VERBATIM from `symlink.ts`: flow owns a
 * root ONLY if `<root>/.claude-plugin/plugin.json` exists, parses, and its
 * `name` starts with `PLUGIN_ROOT_PREFIX`. A root that exists but isn't
 * flow-owned is never mutated without `force`. Never delete a real file
 * flow did not write.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FLOW_CLAUDE_HOME_SKILLS_DIR } from "./paths";
import { MODULES, type ModuleId } from "./modules";
import { PLUGIN_ROOT_PREFIX, pluginManifestFor } from "./plugin-manifest";
import { ensureSymlink } from "./symlink";
import { discoverHelpers, discoverValidators } from "./sources";

// Character-identical to symlink.ts's LinkResult on purpose, so setup.ts's
// existing bucketFor(result: LinkResult) is reused unchanged — do not add a
// parallel bucketer.
export type PluginRootResult = "created" | "updated" | "exists" | "blocked";

export function isFlowOwnedPluginRoot(root: string): boolean {
  const manifestPath = path.join(root, ".claude-plugin", "plugin.json");
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const name = (parsed as Record<string, unknown>).name;
  return typeof name === "string" && name.startsWith(PLUGIN_ROOT_PREFIX);
}

export function removePluginRoot(root: string): boolean {
  if (!isFlowOwnedPluginRoot(root)) return false;
  fs.rmSync(root, { recursive: true, force: true });
  return true;
}

/**
 * The OQ-7 manifest-independent orphan scan AND the launcher's
 * root-discovery source — one function, two consumers, so a rollback across
 * the plugin-era boundary can never strand a root the manifest forgot.
 */
export function scanPluginRoots(
  skillsDir: string = FLOW_CLAUDE_HOME_SKILLS_DIR,
): string[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const candidate = path.join(skillsDir, dirent.name);
    if (isFlowOwnedPluginRoot(candidate)) roots.push(candidate);
  }
  return roots;
}

export function pluginDirArgs(roots: readonly string[]): string[] {
  return roots.flatMap((root) => ["--plugin-dir", root]);
}

export function pluginPathPrefix(roots: readonly string[]): string {
  return roots
    .map((root) => path.join(root, "bin"))
    .filter(existsDir)
    .join(":");
}

/**
 * Resolves a module's `helpers` + `validators` rows to their source paths in
 * `flowSource`, the same way `discoverHelpers`/`discoverValidators` do —
 * reused directly from `./sources` (no cycle: `sources.ts` never imports
 * this module). Not exported: cross-model review flagged the speculative
 * public surface here, and there is no second consumer.
 */
function pluginBinEntries(
  moduleId: ModuleId,
  flowSource: string,
  root: string,
): { source: string; target: string }[] {
  const row = MODULES.find((m) => m.id === moduleId);
  if (!row) return [];
  const helperNames = new Set(row.helpers);
  const validatorNames = new Set(row.validators);
  const binDir = path.join(root, "bin");
  const matched = [
    ...discoverHelpers(flowSource).filter((e) =>
      helperNames.has(e.displayName),
    ),
    ...discoverValidators(flowSource).filter((e) =>
      validatorNames.has(e.displayName),
    ),
  ];
  return matched.map((e) => ({
    source: e.source,
    target: path.join(binDir, e.displayName),
  }));
}

function readFileOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Symlinks (not real files) directly under `binDir` — the set flow itself
 * may have written on a prior run. A real file is never a candidate. */
function listManagedSymlinks(binDir: string): string[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(binDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return dirents.filter((d) => d.isSymbolicLink()).map((d) => d.name);
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Materializes `<root>/.claude-plugin/plugin.json` (from `pluginManifestFor`)
 * plus `<root>/bin/` (from `pluginBinEntries`), pruning any stale
 * flow-managed bin symlink that fell out of the module's entry set. Never
 * creates a `skills/` directory — the skill-content move is a deferred
 * follow-up; this task only emits the manifest's `skills` field.
 *
 * Idempotent by construction: the manifest is only rewritten when its bytes
 * differ from what's on disk, and each bin entry goes through
 * `ensureSymlink` (itself a no-op when already correct), so a second
 * identical call leaves every mtime untouched and returns "exists".
 */
export function ensurePluginRoot(args: {
  root: string;
  moduleId: ModuleId;
  flowSource: string;
  version: string;
  includeSkills: boolean;
  force: boolean;
}): PluginRootResult {
  const { root, moduleId, flowSource, version, includeSkills, force } = args;
  const existedBefore = fs.existsSync(root);
  if (existedBefore && !isFlowOwnedPluginRoot(root) && !force) {
    return "blocked";
  }

  const manifestDir = path.join(root, ".claude-plugin");
  const manifestPath = path.join(manifestDir, "plugin.json");
  const manifestJson =
    JSON.stringify(
      pluginManifestFor(moduleId, { version, includeSkills }),
      null,
      2,
    ) + "\n";
  let changed = readFileOrNull(manifestPath) !== manifestJson;
  if (changed) {
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(manifestPath, manifestJson);
  }

  const binDir = path.join(root, "bin");
  const entries = pluginBinEntries(moduleId, flowSource, root);
  const previousBinLinks = listManagedSymlinks(binDir);
  if (entries.length > 0) {
    fs.mkdirSync(binDir, { recursive: true });
    for (const entry of entries) {
      // force:false — a real (non-symlink) file already occupying this exact
      // name is left untouched (returns "blocked"), never overwritten.
      const result = ensureSymlink(entry.target, entry.source, false);
      if (result === "created" || result === "updated") changed = true;
    }
  }
  const desired = new Set(entries.map((e) => path.basename(e.target)));
  for (const name of previousBinLinks) {
    if (!desired.has(name)) {
      fs.unlinkSync(path.join(binDir, name));
      changed = true;
    }
  }

  if (!existedBefore) return "created";
  return changed ? "updated" : "exists";
}
