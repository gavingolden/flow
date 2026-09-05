/**
 * Read/write ~/.flow/installed.json — the canonical record of every symlink
 * `flow install` created. `flow install --upgrade` diffs this against the current
 * source tree to reap orphans.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FLOW_MANIFEST } from "./paths";

export type SymlinkKind =
  | "skill"
  | "agent"
  | "workflow"
  | "bin"
  | "completion"
  // A "plugin" record's target is a real directory materialized by
  // `plugin-root.ts`, not a symlink — consumers must branch on `kind`
  // before calling any symlink primitive (`ensureSymlink`,
  // `removeIfManagedSymlink`) against it.
  | "plugin";

export type SymlinkRecord = {
  source: string;
  target: string;
  kind: SymlinkKind;
  /** `"copy"` for a `kind: "workflow"` record — `target` is real file
   * bytes, not a symlink (Claude Code 2.1.261 rejects a `workflows` dir
   * symlink-out; see `sources.ts`'s `discoverWorkflows`). Undefined
   * (symlink) for every other kind. */
  materialize?: "symlink" | "copy";
  /** sha256 of the copied file's content at the time it was written —
   * lets `flow install --upgrade` refresh a stale copy without re-reading
   * every byte, and lets the drift audit report a copy whose on-disk hash
   * no longer matches this recorded value as drift. Only set alongside
   * `materialize: "copy"`. */
  sha256?: string;
};

export type Manifest = {
  version: 1;
  symlinks: SymlinkRecord[];
};

const EMPTY: Manifest = { version: 1, symlinks: [] };

export function readManifest(manifestPath = FLOW_MANIFEST): Manifest {
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as Manifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.symlinks)) return EMPTY;
    return parsed;
  } catch {
    return EMPTY;
  }
}

export function writeManifest(
  manifest: Manifest,
  manifestPath = FLOW_MANIFEST,
): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}
