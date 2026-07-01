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
import { fileURLToPath } from "node:url";

export const HOME = os.homedir();
export const FLOW_DIR = path.join(HOME, ".flow");
export const FLOW_STATE_DIR = path.join(FLOW_DIR, "state");
/**
 * Per-machine epic-orchestrator runtime state root: `~/.flow/epics/<slug>/run.json`.
 * Physically distinct from the repo's committed `.flow/epics/<slug>/` (manifest +
 * design) — that is the design-vs-runtime split. Never committed, recomputable.
 */
export const FLOW_EPICS_DIR = path.join(FLOW_DIR, "epics");
export const FLOW_COMPLETIONS_DIR = path.join(FLOW_DIR, "completions");
export const FLOW_MANIFEST = path.join(FLOW_DIR, "installed.json");
export const FLOW_CONFIG = path.join(FLOW_DIR, "config.json");
export const FLOW_UPDATE_CACHE = path.join(FLOW_DIR, "update-check.json");
export const SETUP_LOCK_PATH = path.join(FLOW_DIR, "setup.lock");
export const FLOW_TEST_SEM_DIR = path.join(FLOW_DIR, "test-sem");
/**
 * Counting-semaphore slot dir for the host-wide `flow feature create` launch concurrency
 * cap (mirrors FLOW_TEST_SEM_DIR). Overridable for tests via the
 * `FLOW_LAUNCH_SEM_DIR` env var so unit launches stay off the real ~/.flow.
 */
export const FLOW_LAUNCH_SEM_DIR = path.join(FLOW_DIR, "launch-sem");
/**
 * Flow-scoped Claude Code settings file passed to `claude --settings` on the
 * launch argv. Registers the UserPromptSubmit seed-ingested hook for
 * flow-launched sessions only — `--settings` is ADDITIVE (the user's global
 * ~/.claude/settings.json still applies), so this file NEVER mutates global
 * settings.
 */
export const FLOW_LAUNCH_SETTINGS_PATH = path.join(
  FLOW_DIR,
  "launch-settings.json",
);

export const CLAUDE_SKILLS_DIR = path.join(HOME, ".claude", "skills");
export const CLAUDE_AGENTS_DIR = path.join(HOME, ".claude", "agents");
export const CLAUDE_SETTINGS_PATH = path.join(HOME, ".claude", "settings.json");
export const LOCAL_BIN_DIR = path.join(HOME, ".local", "bin");

type FlowConfig = { source?: string };

function readConfig(homeDir: string): FlowConfig {
  const configPath = path.join(homeDir, ".flow", "config.json");
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as FlowConfig;
  } catch {
    return {};
  }
}

/**
 * Resolves the flow source checkout. Order of precedence:
 *   1. <homeDir>/.flow/config.json `source` field
 *   2. The directory two levels up from this module. Bun resolves
 *      import.meta.path through symlinks to the canonical file at
 *      <flow-source>/bin/lib/paths.ts; Node (used by vitest) doesn't
 *      define `path` on import.meta but does provide a file:// URL, so
 *      we fall back to fileURLToPath on import.meta.url for portability.
 *
 * The `homeDir` parameter exists so tests can stand up a fake
 * `~/.flow/config.json` and exercise the production resolution path. Same
 * pattern as `applyShellRcCompletions` in `setup-rc.ts`.
 */
export function resolveFlowSource(homeDir: string = HOME): string {
  const config = readConfig(homeDir);
  if (config.source) return path.resolve(config.source.replace(/^~/, homeDir));
  return path.resolve(path.dirname(modulePath()), "..", "..");
}

function modulePath(): string {
  const bunPath = (import.meta as { path?: unknown }).path;
  if (typeof bunPath === "string") return bunPath;
  return fileURLToPath(import.meta.url);
}
