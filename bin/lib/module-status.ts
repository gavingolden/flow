/**
 * Pure resolver for "is module X active right now" — the runtime
 * counterpart to `modules.ts`'s static registry. `modules-config.ts` /
 * `manifest.ts` answer "what did the user select" / "what got symlinked";
 * this module composes the two into a single per-module `active` verdict
 * that callers (the `flow-module-status` CLI, `flow-ci-wait`,
 * `/flow-pipeline`, `setup.ts`'s doctor summary) can gate on without each
 * re-deriving the manifest/selection precedence themselves.
 *
 * Two read paths, chosen by which signal is available:
 *   - MANIFEST-DRIVEN (the common case, post-install): count linked
 *     artifacts per module from `~/.flow/installed.json` and compare
 *     against the module's declared artifact count. Strict-all — a
 *     partially-linked module (e.g. an interrupted install) reads as
 *     inactive, never partially active. This is the safe direction: a
 *     caller gating a feature on a module being installed must never treat
 *     a half-installed module as usable.
 *   - SELECTION-FALLBACK (manifest empty or carries no artifacts this
 *     registry recognises — e.g. a synthetic/fixture manifest, or a
 *     just-recorded `~/.flow/config.json` selection ahead of the next
 *     `flow install` run): fall through to the recorded module selection.
 *
 * `core` (`MANDATORY_MODULE`) is always reported active — it is never
 * optional, so it never needs the deselected/not-linked machinery the rest
 * of this module exists for.
 *
 * No side effects at import; every function takes an injectable `deps`
 * seam so tests never touch real `~/.flow` state.
 */

import { basename, dirname } from "node:path";
import {
  MANDATORY_MODULE,
  MODULES,
  moduleForArtifactName,
  type ModuleDefinition,
  type ModuleId,
} from "./modules";
import { moduleIdFromPluginRootName } from "./plugin-manifest";
import { readModuleSelection } from "./modules-config";
import { readManifest, type Manifest } from "./manifest";

export type ModuleActivity = {
  id: ModuleId;
  active: boolean;
  reason: "selected" | "linked" | "deselected" | "not-linked";
};

type Deps = {
  /** Defaults to `readModuleSelection` (reads real `~/.flow/config.json`). */
  readSelection?: () => string[] | undefined;
  /** Defaults to `readManifest` (reads real `~/.flow/installed.json`). */
  readManifest?: () => Manifest;
};

function declaredCount(m: ModuleDefinition): number {
  // Agents contribute at most ONE linked artifact per module regardless of
  // how many `.md` files the registry lists — `discoverAgents` materializes
  // a single directory symlink per owning module, not one per file (see
  // `sources.ts`). `m.agents.length` stays the true file count for other
  // consumers (docs, the agents-drift test); only the install-count formula
  // here collapses it.
  const agentsContribution = m.agents.length > 0 ? 1 : 0;
  return (
    m.helpers.length +
    m.skills.length +
    agentsContribution +
    m.validators.length
  );
}

/**
 * Resolves activity for every row in `MODULES`. See the module doc comment
 * for the manifest-driven vs selection-fallback precedence.
 */
export function resolveModuleActivity(deps: Deps = {}): ModuleActivity[] {
  const readSelection = deps.readSelection ?? readModuleSelection;
  const readManifestFn = deps.readManifest ?? readManifest;
  const manifest = readManifestFn();

  // Tally linked artifacts per owning module, skipping any record whose
  // target basename maps to no module (the `flow` wrapper, shell
  // completions) — those are never counted as a missing artifact for any
  // module's declared set. An "agent" record's target is now the module's
  // `agents/` directory symlink itself (`sources.ts`'s `discoverAgents`),
  // not a `.md` basename, so its owner is read off the enclosing plugin-root
  // directory name (`flow-module-<id>`) instead of `moduleForArtifactName`.
  const linkedCount = new Map<ModuleId, number>();
  let relevantRecords = 0;
  for (const rec of manifest.symlinks) {
    const owner =
      rec.kind === "agent"
        ? moduleIdFromPluginRootName(basename(dirname(rec.target)))
        : moduleForArtifactName(basename(rec.target));
    if (owner === undefined) continue;
    relevantRecords++;
    linkedCount.set(owner, (linkedCount.get(owner) ?? 0) + 1);
  }

  if (relevantRecords === 0) {
    const selection = readSelection();
    return MODULES.map((m): ModuleActivity => {
      if (m.id === MANDATORY_MODULE) {
        return { id: m.id, active: true, reason: "selected" };
      }
      if (selection === undefined) {
        return { id: m.id, active: false, reason: "deselected" };
      }
      const active = selection.includes(m.id);
      return { id: m.id, active, reason: active ? "selected" : "deselected" };
    });
  }

  return MODULES.map((m): ModuleActivity => {
    if (m.id === MANDATORY_MODULE) {
      return { id: m.id, active: true, reason: "selected" };
    }
    const active = (linkedCount.get(m.id) ?? 0) >= declaredCount(m);
    return { id: m.id, active, reason: active ? "linked" : "not-linked" };
  });
}

/** `core` is always active; every other id defers to `resolveModuleActivity`. */
export function isModuleActive(id: ModuleId, deps: Deps = {}): boolean {
  if (id === MANDATORY_MODULE) return true;
  return resolveModuleActivity(deps).find((m) => m.id === id)?.active ?? false;
}

/**
 * The module id whose `skills[]` includes `skill`, or `undefined` if none
 * does. Skills are registered under their shipped `flow-` prefix, but prose
 * cross-references and `--check-skill` callers often name the bare skill
 * (`svelte`, not `flow-svelte`), so an unprefixed argument also matches the
 * `flow-`-prefixed registry entry.
 */
export function moduleForSkill(skill: string): ModuleId | undefined {
  const candidates = skill.startsWith("flow-")
    ? [skill]
    : [skill, `flow-${skill}`];
  for (const m of MODULES) {
    if (candidates.some((c) => m.skills.includes(c))) return m.id;
  }
  return undefined;
}

/**
 * An unknown skill (not owned by any module row) is treated as active — it
 * isn't gated by module selection at all, so its absence must never be
 * misread as "deselected".
 */
export function isSkillActive(skill: string, deps: Deps = {}): boolean {
  const id = moduleForSkill(skill);
  return id ? isModuleActive(id, deps) : true;
}

/** One-line, user-facing notice for a deselected module. */
export function noticeLine(id: ModuleId): string {
  const def = MODULES.find((m) => m.id === id)!;
  const description = def.description.replace(/\.$/, "");
  return `flow: ${id} module not installed (deselected) — ${description}; re-enable with 'flow install --modules ${id}'.`;
}

/** The graceful-skip JSON envelope callers already emit for other skip reasons. */
export function skipEnvelope(id: ModuleId): { ran: false; skipReason: string } {
  return { ran: false, skipReason: `${id}-module-deselected` };
}

/** Every non-`core` module currently reporting inactive. */
export function inactiveOptionalModules(deps: Deps = {}): ModuleActivity[] {
  return resolveModuleActivity(deps).filter(
    (m) => !m.active && m.id !== MANDATORY_MODULE,
  );
}
