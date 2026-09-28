/**
 * A pipeline's PRIVATE real-file copy of flow's plugin roots, under
 * `<overlaysDir>/<slug>/.claude/skills/flow-module-<id>/`. Launching a
 * flow-self (or `--skills-from`) supervisor on this copy lets step 5.5 sync
 * the branch's skills for a resumed or reloaded session without touching the
 * shared install other pipelines read live. A running session keeps the text
 * it started with (see skill-overlay.live.test.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FLOW_STATE_DIR, flowOverlaysDir } from "./paths";
import { livenessOf } from "./liveness";
import { MODULES, type ModuleId } from "./modules";
import { readFlowVersion } from "./pkg-version";
import { pluginRootName } from "./plugin-manifest";
import { ensurePluginRoot, scanPluginRoots } from "./plugin-root";
import { readState, statePath, TERMINAL_PHASE_SET } from "./state";
import { inspectFlowRoot } from "./worktree-source";
import {
  copyFileReal,
  plannedFiles,
  removeEmptyDirs,
  rootNamesFor,
  sameBytes,
  walkFiles,
  writeAtomic,
} from "./skill-overlay-fs";

const PRUNE_GRACE_MS = 30 * 60 * 1000;

export function overlaySkillsDir(
  slug: string,
  overlaysDir: string = flowOverlaysDir(),
): string {
  return path.join(overlaysDir, slug, ".claude", "skills");
}

function installVersion(installRoot: string): string {
  try {
    return readFlowVersion(installRoot);
  } catch {
    return "0.0.0";
  }
}

export function materializeSkillOverlay(args: {
  slug: string;
  contentSource: string;
  installRoot: string;
  moduleIds: readonly ModuleId[];
  overlaysDir?: string;
}): string[] {
  const { slug, contentSource, installRoot, moduleIds } = args;
  const overlaysDir = args.overlaysDir ?? flowOverlaysDir();
  fs.mkdirSync(overlaysDir, { recursive: true });
  const stage = fs.mkdtempSync(path.join(overlaysDir, ".build-"));
  try {
    const skillsRoot = path.join(stage, ".claude", "skills");
    for (const id of moduleIds) {
      const root = path.join(skillsRoot, pluginRootName(id));
      // flowSource = installRoot = canonical: helper links never point into a worktree.
      ensurePluginRoot({
        root,
        moduleId: id,
        flowSource: installRoot,
        installRoot,
        version: installVersion(installRoot),
        includeSkills: true,
        force: false,
      });
      if ((MODULES.find((m) => m.id === id)?.skills.length ?? 0) > 0) {
        fs.mkdirSync(path.join(root, "skills"), { recursive: true });
      }
    }
    for (const [dest, src] of plannedFiles(
      contentSource,
      skillsRoot,
      rootNamesFor(moduleIds),
    )) {
      copyFileReal(src, dest);
    }
    const final = path.join(overlaysDir, slug);
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(stage, final);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return scanPluginRoots(overlaySkillsDir(slug, overlaysDir));
}

export function overlayPluginRoots(
  slug: string,
  overlaysDir?: string,
): string[] | null {
  const roots = scanPluginRoots(overlaySkillsDir(slug, overlaysDir));
  return roots.length > 0 ? roots : null;
}

export function syncSkillOverlay(args: {
  slug: string;
  contentSource: string;
  overlaysDir?: string;
}): { written: string[]; removed: string[]; notExercised: string[] } {
  const overlaysDir = args.overlaysDir ?? flowOverlaysDir();
  const skillsRoot = overlaySkillsDir(args.slug, overlaysDir);
  const roots = scanPluginRoots(skillsRoot);
  const desired = plannedFiles(
    args.contentSource,
    skillsRoot,
    new Set(roots.map((r) => path.basename(r))),
  );
  const rel = (p: string) => path.relative(skillsRoot, p);
  const notExercised = new Set<string>();
  const written: string[] = [];
  for (const [dest, src] of desired) {
    const parts = rel(dest).split(path.sep);
    const bytes = fs.readFileSync(src);
    if (sameBytes(dest, bytes)) continue;
    if (parts[1] === "agents") notExercised.add(rel(dest));
    else if (!fs.existsSync(path.join(skillsRoot, ...parts.slice(0, 3)))) {
      notExercised.add(parts.slice(0, 3).join("/"));
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeAtomic(dest, bytes, fs.statSync(src).mode & 0o777);
    written.push(rel(dest));
  }
  const removed: string[] = [];
  for (const root of roots) {
    for (const sub of ["skills", "agents"]) {
      for (const file of walkFiles(path.join(root, sub), false)) {
        if (desired.has(file)) continue;
        fs.rmSync(file, { force: true });
        removed.push(rel(file));
      }
      removeEmptyDirs(path.join(root, sub));
    }
  }
  const now = new Date();
  fs.utimesSync(path.join(overlaysDir, args.slug), now, now);
  return { written, removed, notExercised: [...notExercised] };
}

export function pruneStaleOverlays(args: {
  overlaysDir?: string;
  stateDir?: string;
  isAlive?: (slug: string) => boolean;
  now?: number;
}): string[] {
  const overlaysDir = args.overlaysDir ?? flowOverlaysDir();
  const stateDir = args.stateDir ?? FLOW_STATE_DIR;
  const now = args.now ?? Date.now();
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(overlaysDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const pruned: string[] = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const dir = path.join(overlaysDir, d.name);
    // A copy modified recently may belong to a launch that has not written state yet.
    if (now - fs.statSync(dir).mtimeMs < PRUNE_GRACE_MS) continue;
    if (fs.existsSync(statePath(d.name, stateDir))) {
      const state = readState(d.name, stateDir);
      if (!state || !TERMINAL_PHASE_SET.has(state.phase)) continue;
      const alive = args.isAlive
        ? args.isAlive(d.name)
        : livenessOf(state) === "alive";
      if (alive) continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    pruned.push(d.name);
  }
  return pruned;
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** True when `repo` (a primary checkout or a linked worktree of it) is the
 * canonical flow checkout. */
export function isFlowSelfRepo(repo: string, canonicalRoot: string): boolean {
  const root = inspectFlowRoot(repo).canonicalRoot;
  return root !== null && realOrSelf(root) === realOrSelf(canonicalRoot);
}
