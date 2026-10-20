/**
 * Real-file tree helpers for the per-pipeline private skill copy. Every copy
 * is a REAL file (never a symlink), so the copy never dangles when the worktree
 * it was synced from is removed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ModuleId } from "./modules";
import { pluginRootName } from "./plugin-manifest";
import { discoverAgents, discoverSkills, type InstallTargets } from "./sources";

/** True for a directory holding flow's own `skills/` and `bin/lib/modules.ts`
 * — the one definition of "a flow checkout" for `--skills-from` and `sync --from`. */
export function isFlowCheckout(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "skills")) &&
    fs.existsSync(path.join(dir, "bin", "lib", "modules.ts"))
  );
}

function within(real: string, boundary: string): boolean {
  return real === boundary || real.startsWith(boundary + path.sep);
}

/** Absolute paths of every regular file below `dir`. `follow` dereferences
 * symlinks (source side) but only when their target stays inside `boundary`
 * (the realpath of the checkout being copied) and never re-enters a directory
 * already being walked; otherwise a symlink is listed as a file to replace. */
export function walkFiles(
  dir: string,
  follow: boolean,
  boundary?: string,
  ancestors: readonly string[] = [],
): string[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of dirents) {
    const p = path.join(dir, d.name);
    let isDir = d.isDirectory();
    let isFile = d.isFile();
    if (follow && d.isSymbolicLink()) {
      try {
        const real = fs.realpathSync(p);
        if (boundary !== undefined && !within(real, boundary)) continue;
        const st = fs.statSync(p);
        isDir = st.isDirectory();
        isFile = st.isFile();
        if (isDir && ancestors.includes(real)) continue;
      } catch {
        continue;
      }
    }
    if (isDir) {
      let real = p;
      try {
        real = fs.realpathSync(p);
      } catch {
        // walk with the lexical path
      }
      out.push(...walkFiles(p, follow, boundary, [...ancestors, real]));
    } else if (isFile || d.isSymbolicLink()) out.push(p);
  }
  return out;
}

/** dest file -> source file, for every skill/agent file routed into a root
 * whose directory name is in `allowedRoots` (mirrors materializeModuleContent's
 * onlyIds filter, so no root is created that ensurePluginRoot never manifested). */
export function plannedFiles(
  contentSource: string,
  skillsRoot: string,
  allowedRoots: ReadonlySet<string>,
): Map<string, string> {
  const targets: InstallTargets = {
    skillsDir: skillsRoot,
    agentsDir: skillsRoot,
    binDir: skillsRoot,
    completionsDir: skillsRoot,
  };
  const planned = new Map<string, string>();
  let boundary: string;
  try {
    boundary = fs.realpathSync(contentSource);
  } catch {
    return planned;
  }
  for (const entry of [
    ...discoverSkills(contentSource, targets),
    ...discoverAgents(contentSource, targets),
  ]) {
    const rootName = path.relative(skillsRoot, entry.target).split(path.sep)[0];
    if (!allowedRoots.has(rootName)) continue;
    let sourceReal: string;
    try {
      sourceReal = fs.realpathSync(entry.source);
    } catch {
      continue;
    }
    if (!within(sourceReal, boundary)) continue;
    for (const file of walkFiles(entry.source, true, boundary, [sourceReal])) {
      planned.set(
        path.join(entry.target, path.relative(entry.source, file)),
        file,
      );
    }
  }
  return planned;
}

export function rootNamesFor(ids: readonly ModuleId[]): Set<string> {
  return new Set(ids.map((id) => pluginRootName(id)));
}

export function copyFileReal(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  writeAtomic(dest, fs.readFileSync(src), fs.statSync(src).mode & 0o777);
}

/** Temp file + rename, so a concurrent reader never sees a half-written file. */
export function writeAtomic(dest: string, bytes: Buffer, mode: number): void {
  const tmp = path.join(
    path.dirname(dest),
    `.${path.basename(dest)}.sync-${process.pid}`,
  );
  fs.writeFileSync(tmp, bytes, { mode });
  try {
    if (!fs.lstatSync(dest).isFile()) fs.rmSync(dest, { recursive: true });
  } catch {
    // dest absent
  }
  fs.renameSync(tmp, dest);
}

/** True when `dest` is a regular file whose bytes already equal `bytes`. */
export function sameBytes(dest: string, bytes: Buffer): boolean {
  try {
    if (!fs.lstatSync(dest).isFile()) return false;
    return fs.readFileSync(dest).equals(bytes);
  } catch {
    return false;
  }
}

/** Removes empty directories strictly below `dir` (keeps `dir` itself). */
export function removeEmptyDirs(dir: string): void {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const p = path.join(dir, d.name);
    removeEmptyDirs(p);
    if (fs.readdirSync(p).length === 0) fs.rmdirSync(p);
  }
}
