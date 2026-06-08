/**
 * Read/write ~/.flow/installed.json — the canonical record of every symlink
 * `flow setup` created. `flow setup --upgrade` diffs this against the current
 * source tree to reap orphans.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FLOW_MANIFEST } from "./paths";

export type SymlinkKind = "skill" | "agent" | "bin" | "completion";

export type SymlinkRecord = {
  source: string;
  target: string;
  kind: SymlinkKind;
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
