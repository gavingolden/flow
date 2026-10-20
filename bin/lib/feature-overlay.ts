/**
 * Launch-side glue for the per-pipeline private skill copy: parses and
 * validates `--skills-from`, decides whether a launch runs on a copy, and
 * names the copy's roots and its per-slug `--add-dir`.
 */

import * as path from "node:path";
import { flowOverlaysDir, resolveFlowSource } from "./paths";
import { moduleIdFromPluginRootName } from "./plugin-manifest";
import {
  isFlowSelfRepo,
  materializeSkillOverlay,
  overlayPluginRoots,
} from "./skill-overlay";
import { isFlowCheckout } from "./skill-overlay-fs";
import { inspectFlowRoot } from "./worktree-source";
import type { ModuleId } from "./modules";

export type OverlayLaunch = {
  /** Plugin roots the session loads via --plugin-dir and PATH. */
  roots: string[];
  /** The slug's own directory — the only overlays path granted via --add-dir. */
  addDir: string;
};

export function canonicalFlowRoot(): string {
  const source = resolveFlowSource();
  return inspectFlowRoot(source).canonicalRoot ?? source;
}

/** Validates `--skills-from <path>` (present or not) before any side effect. */
export function parseSkillsFrom(
  args: readonly string[],
  cwd: string,
): { skillsFrom?: string; error?: string } {
  const idx = args.indexOf("--skills-from");
  if (idx < 0) return {};
  const value = args[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    return { error: "--skills-from requires a flow checkout path." };
  }
  const resolved = path.resolve(cwd, value);
  if (!isFlowCheckout(resolved)) {
    return {
      error: `invalid --skills-from '${value}': expected a flow checkout containing skills/ and bin/lib/modules.ts.`,
    };
  }
  return { skillsFrom: resolved };
}

/** A fresh launch's copy: a flow-self repo or an explicit `--skills-from`. */
export function createOverlay(args: {
  slug: string;
  repo: string;
  skillsFrom?: string;
  overlaysDir?: string;
  flowCanonicalRoot?: string;
  sharedRoots: readonly string[];
}): OverlayLaunch | null {
  const canonical = args.flowCanonicalRoot ?? canonicalFlowRoot();
  if (!args.skillsFrom && !isFlowSelfRepo(args.repo, canonical)) return null;
  const moduleIds = args.sharedRoots
    .map((r) => moduleIdFromPluginRootName(path.basename(r)))
    .filter((id): id is ModuleId => id !== undefined);
  if (moduleIds.length === 0) return null;
  const overlaysDir = args.overlaysDir ?? flowOverlaysDir();
  const roots = materializeSkillOverlay({
    slug: args.slug,
    contentSource: args.skillsFrom ?? canonical,
    installRoot: canonical,
    moduleIds,
    overlaysDir,
    kind: args.skillsFrom ? "skills-from" : "flow-self",
  });
  return { roots, addDir: path.join(overlaysDir, args.slug) };
}

/** A resumed launch reuses the slug's existing copy; null launches as today. */
export function resumeOverlay(
  slug: string,
  overlaysDir?: string,
): OverlayLaunch | null {
  const roots = overlayPluginRoots(slug, overlaysDir);
  if (!roots) return null;
  return { roots, addDir: path.join(overlaysDir ?? flowOverlaysDir(), slug) };
}
