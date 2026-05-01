/**
 * Path resolution for flow's global install + state.
 *
 * The flow-source location is derived from this module's own canonical path
 * (Bun's import.meta.path is symlink-aware: when ~/.local/bin/flow is a
 * symlink to <flow-source>/bin/flow, this resolves to the canonical file
 * inside the source tree, not the symlink). Override via ~/.flow/config.json.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export const HOME = os.homedir();
export const FLOW_DIR = path.join(HOME, ".flow");
export const FLOW_STATE_DIR = path.join(FLOW_DIR, "state");
export const FLOW_MANIFEST = path.join(FLOW_DIR, "installed.json");
export const FLOW_CONFIG = path.join(FLOW_DIR, "config.json");

export const CLAUDE_SKILLS_DIR = path.join(HOME, ".claude", "skills");
export const CLAUDE_AGENTS_DIR = path.join(HOME, ".claude", "agents");
export const LOCAL_BIN_DIR = path.join(HOME, ".local", "bin");

type FlowConfig = { source?: string };

function readConfig(): FlowConfig {
  try {
    return JSON.parse(fs.readFileSync(FLOW_CONFIG, "utf8")) as FlowConfig;
  } catch {
    return {};
  }
}

/**
 * Resolves the flow source checkout. Order of precedence:
 *   1. ~/.flow/config.json `source` field
 *   2. The directory two levels up from this module (works because Bun
 *      resolves import.meta.path through symlinks to the canonical file
 *      inside the flow source tree at <flow-source>/bin/lib/paths.ts).
 */
export function resolveFlowSource(): string {
  const config = readConfig();
  if (config.source) return path.resolve(config.source.replace(/^~/, HOME));
  // From <flow-source>/bin/lib/paths.ts → up two → <flow-source>
  return path.resolve(path.dirname(import.meta.path), "..", "..");
}
