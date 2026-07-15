/**
 * Decides which module registry `flow install` should resolve a selection
 * against: the compiled-in `./modules` registry on the fast path
 * (`flowSource === installRoot`), or — on a `--source` divergence — the
 * SOURCE tree's own `bin/lib/modules.ts`, so an in-flight worktree that adds
 * a new agent/skill/helper AND registers it in a new module row is picked up
 * even though the compiled-in registry (built from `installRoot`) doesn't
 * know about it yet. This is the fix for the PR #445-adjacent silent no-op:
 * a stale compiled registry silently omitting a brand-new artifact.
 *
 * The dynamic-import path never trusts what it loads: an absent file, an
 * import that throws, a missing `resolveArtifactSet` export, or a returned
 * value that doesn't shape-check as an `ArtifactSet` all fall back to the
 * compiled-in registry rather than propagating malformed data or an
 * exception to the caller.
 */

import * as path from "node:path";
import { resolveArtifactSet, type ArtifactSet } from "./modules";

export type ResolvedArtifactSet = {
  artifactSet: ArtifactSet;
  /** True when the SOURCE tree's own modules.ts was used instead of the compiled-in one. */
  usedSourceRegistry: boolean;
  /** Present only when a source-registry attempt failed and fell back. */
  warning?: string;
};

/**
 * A plain object whose values are all arrays — the shape every
 * `ArtifactSet` must have. Deliberately structural (not an `instanceof` or
 * branded check) since the value crossed a dynamic `import()` boundary and
 * may come from a differently-compiled copy of `./modules`.
 */
function isArtifactSetShape(value: unknown): value is ArtifactSet {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every((v) =>
    Array.isArray(v),
  );
}

export async function resolveArtifactSetForSource(
  flowSource: string,
  installRoot: string,
  selectedIds: readonly string[],
): Promise<ResolvedArtifactSet> {
  if (flowSource === installRoot) {
    return {
      artifactSet: resolveArtifactSet(selectedIds),
      usedSourceRegistry: false,
    };
  }

  const modulePath = path.join(flowSource, "bin", "lib", "modules.ts");
  try {
    const mod: unknown = await import(modulePath);
    const candidate = (mod as Record<string, unknown> | undefined)
      ?.resolveArtifactSet;
    if (typeof candidate !== "function") {
      return {
        artifactSet: resolveArtifactSet(selectedIds),
        usedSourceRegistry: false,
        warning: `${modulePath} has no resolveArtifactSet export — falling back to the compiled-in module registry`,
      };
    }
    const result: unknown = candidate(selectedIds);
    if (!isArtifactSetShape(result)) {
      return {
        artifactSet: resolveArtifactSet(selectedIds),
        usedSourceRegistry: false,
        warning: `${modulePath}'s resolveArtifactSet returned a value that isn't a valid ArtifactSet — falling back to the compiled-in module registry`,
      };
    }
    return { artifactSet: result, usedSourceRegistry: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      artifactSet: resolveArtifactSet(selectedIds),
      usedSourceRegistry: false,
      warning: `failed to load ${modulePath}: ${reason} — falling back to the compiled-in module registry`,
    };
  }
}
