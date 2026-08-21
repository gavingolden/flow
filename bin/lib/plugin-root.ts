/**
 * Materializes / refreshes / prunes a flow-owned `.claude-plugin` plugin
 * root directory — one per selected module, at
 * `<skillsDir>/flow-module-<id>/` — plus the shared root-discovery helpers
 * both the launcher (`--plugin-dir` / PATH) and the reap scan consume.
 *
 * Ownership discipline, STRICTER than `symlink.ts`'s: flow owns a root ONLY
 * if `<root>/.claude-plugin/plugin.json` exists, parses, its `name` is a
 * KNOWN module's plugin-root name (`moduleIdFromPluginRootName`, not a mere
 * prefix match), AND the directory's own basename matches that same name —
 * so a directory can't self-declare ownership just by carrying a
 * `flow-module-`-prefixed `name` field. A root that exists but isn't
 * flow-owned is never mutated without `force`. Never delete a real file
 * flow did not write.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FLOW_CLAUDE_HOME_SKILLS_DIR } from "./paths";
import { MODULES, type ModuleId } from "./modules";
import {
  moduleIdFromPluginRootName,
  pluginManifestFor,
  pluginRootName,
} from "./plugin-manifest";
import { ensureSymlink } from "./symlink";
import {
  discoverAgents,
  discoverHelpers,
  discoverSkills,
  discoverValidators,
  effectiveLinkSource,
  type InstallTargets,
} from "./sources";

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
  if (
    typeof name !== "string" ||
    moduleIdFromPluginRootName(name) === undefined
  ) {
    return false;
  }
  return path.basename(root) === name;
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

export function pluginBinPath(roots: readonly string[]): string {
  return roots
    .map((root) => path.join(root, "bin"))
    .filter(existsDir)
    .join(":");
}

/**
 * Composes a plugin-root PATH suffix with the current PATH, guarding both
 * hazards that four independent call sites (`launch.ts`, `launcher.ts`,
 * `feature.ts`, `epic.ts`) used to reimplement by hand and disagreed on:
 * (1) an empty `currentPath` must never produce a leading/trailing `:` —
 * POSIX reads a leading/trailing empty PATH segment as the current working
 * directory; (2) each segment of `pluginPath` already present ANYWHERE in
 * `currentPath` (a flow session shelling out to another `flow feature
 * create` / `flow epic create`, or a plugin root's `bin/` already sitting
 * earlier on PATH) must never be appended a second time — a per-segment
 * `Set` membership check, not a whole-string `startsWith`/`endsWith`
 * guard, since either of those is order-dependent and misses a duplicate
 * that isn't at the exact boundary being checked. `pluginPath`'s entries
 * are APPENDED to the end of `currentPath` (never prepended), so a
 * flow-managed plugin `bin/` can never shadow an earlier PATH entry.
 * Returns `undefined` when there is nothing left to append (either
 * `pluginPath` is empty, or every one of its segments is already present),
 * so callers can omit the PATH override entirely rather than reason about
 * an unchanged string.
 */
export function withPluginPath(
  pluginPath: string,
  currentPath: string,
): string | undefined {
  if (!pluginPath) return undefined;
  const present = new Set(currentPath.split(":"));
  const missing = pluginPath.split(":").filter((seg) => !present.has(seg));
  if (missing.length === 0) return undefined;
  return currentPath
    ? `${currentPath}:${missing.join(":")}`
    : missing.join(":");
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
  installRoot: string,
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
  // Route each entry's source through effectiveLinkSource, mirroring the
  // symlink branch in setup.ts — under `flow install --source <worktree>`
  // this points the live link at the canonical (installRoot) path when one
  // already exists, so the root doesn't dangle once flow-remove-worktree
  // deletes the worktree.
  return matched.map((e) => ({
    source: effectiveLinkSource(e.source, flowSource, installRoot),
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
 * creates the `skills/`/`agents/` directories itself — those are populated
 * by `discoverSkills`/`discoverAgents`'s own per-artifact symlinks (routed
 * into this root by `sources.ts`) and `setup.ts`'s install loop, which runs
 * plugin-root materialization first so the root always exists
 * flow-owned before any child symlink lands inside it.
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
  /** Canonical checkout root, used to rebase bin/ symlinks off a
   * `--source <worktree>` install so they don't dangle post-merge. Defaults
   * to `flowSource` (no rebase) for callers that always run canonical
   * (probes, the contract lint). */
  installRoot?: string;
  version: string;
  includeSkills: boolean;
  force: boolean;
}): PluginRootResult {
  const {
    root,
    moduleId,
    flowSource,
    installRoot = flowSource,
    version,
    includeSkills,
    force,
  } = args;
  const existedBefore = fs.existsSync(root);
  if (existedBefore && !isFlowOwnedPluginRoot(root) && !force) {
    return "blocked";
  }

  // Refine the caller's blanket `includeSkills` by whether THIS module
  // actually owns any skill rows — `copilot`'s row is skills:[] (helper-only),
  // so declaring `skills: ["./skills"]` for it would promise a directory
  // `discoverSkills` never symlinks anything into (no artifact routes there),
  // which fails `claude plugin validate --strict` with a real "Path not
  // found" error. A module WITH skill rows still gets `includeSkills` as the
  // caller passed it.
  const moduleRow = MODULES.find((m) => m.id === moduleId);
  const effectiveIncludeSkills =
    includeSkills && (moduleRow?.skills.length ?? 0) > 0;

  const manifestDir = path.join(root, ".claude-plugin");
  const manifestPath = path.join(manifestDir, "plugin.json");
  const manifestJson =
    JSON.stringify(
      pluginManifestFor(moduleId, {
        version,
        includeSkills: effectiveIncludeSkills,
      }),
      null,
      2,
    ) + "\n";
  let changed = readFileOrNull(manifestPath) !== manifestJson;
  if (changed) {
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(manifestPath, manifestJson);
  }

  const binDir = path.join(root, "bin");
  const entries = pluginBinEntries(moduleId, flowSource, root, installRoot);
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

/**
 * `includeSkills: true` declares the manifest's `skills` key, and every
 * module's own `agents/` dir is unconditionally legitimate — but
 * `ensurePluginRoot` never populates either directory's CONTENT (that's
 * `sources.ts`'s/`setup.ts`'s job at real-install time). Without this, a
 * manifest that DECLARES `skills` but has no matching `<root>/skills/`
 * directory on disk fails `claude plugin validate --strict` with
 * `Path not found: ./skills`, and `claude plugin list --json` reports the
 * same as a non-empty `errors[]` — both would misreport genuine Claude Code
 * drift when the real cause is an incompletely materialized plugin root,
 * not an actual manifest/content mismatch. Mirrors `setup.ts`'s install
 * loop exactly: `discoverSkills`/`discoverAgents`
 * already route each artifact's target into its OWNING module's root
 * (`sources.ts`'s `ownerPluginRootName`), so one un-filtered call per kind,
 * scoped to `skillsRoot`, symlinks every module's content into its own root
 * in one pass — no per-module loop needed.
 *
 * Lifted verbatim from `bin/flow-plugin-contract-lint.ts` (originally a
 * local, non-exported helper there) so `bin/lib/eval-fixture.ts` can reuse
 * it to materialize a hermetic eval fixture's plugin roots without either
 * module duplicating the logic.
 */
export function materializeModuleContent(
  flowSource: string,
  skillsRoot: string,
  /** Restricts symlinking to roots actually materialized under
   * `skillsRoot` (the Phase-3 `--plugin-dir` probe only ever
   * `ensurePluginRoot`s the first two module ids there) — without this, an
   * unfiltered call would `mkdirSync` an ownerless, never-`ensurePluginRoot`'d
   * directory for every OTHER module id under the same parent. */
  onlyIds?: readonly ModuleId[],
): void {
  const targets: InstallTargets = {
    skillsDir: skillsRoot,
    agentsDir: skillsRoot, // unused by discoverSkills/discoverAgents post-retarget
    binDir: skillsRoot, // unused by either discover function
    completionsDir: skillsRoot, // unused by either discover function
  };
  const allowedRootDirs = onlyIds
    ? new Set(onlyIds.map((id) => path.join(skillsRoot, pluginRootName(id))))
    : undefined;
  for (const entry of [
    ...discoverSkills(flowSource, targets),
    ...discoverAgents(flowSource, targets),
  ]) {
    if (
      allowedRootDirs &&
      !allowedRootDirs.has(path.dirname(path.dirname(entry.target)))
    ) {
      continue;
    }
    ensureSymlink(entry.target, entry.source, false);
  }
}
