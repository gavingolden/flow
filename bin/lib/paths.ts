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
import { createHash } from "node:crypto";

export const HOME = os.homedir();
export const FLOW_DIR = path.join(HOME, ".flow");
export const FLOW_STATE_DIR = path.join(FLOW_DIR, "state");
/**
 * Per-repo cache root for artifacts that must survive a worktree's removal
 * (e.g. the agent-memory-local handoff) — distinct from `FLOW_STATE_DIR`
 * (per-pipeline state) and `~/.flow/research-cache` (the only cache dir
 * that exists on a host today). Callers that need a test-visible path
 * still take a `cacheRoot` parameter defaulting to this constant, rather
 * than reading it eagerly inside test-sensitive logic — same HOME-capture
 * hazard `flowConfigPath()` below documents.
 */
export const FLOW_CACHE_DIR = path.join(FLOW_DIR, "cache");

/**
 * Single path segment shared by every agent-memory-local call site
 * (the worktree-local symlink name, the git-exclude entry, and the
 * cache-salvage subdir name) — extracted so a future rename touches one
 * constant instead of drifting across `worktree-marker.ts`,
 * `worktree-fs.ts`, and `flow-plugin-probe.ts`.
 */
export const AGENT_MEMORY_DIRNAME = "agent-memory-local";
/**
 * Repo-relative path to the worktree-local agent-memory symlink, written
 * verbatim into `.git/info/exclude`. MUST stay a template literal with a
 * forward slash — NEVER `path.join` — because git parses exclude entries
 * with `/` separators unconditionally, regardless of host OS.
 */
export const AGENT_MEMORY_RELPATH = `.claude/${AGENT_MEMORY_DIRNAME}`;

/**
 * Stable per-repo cache key: `<basename>-<sha256(realpath)[0..8]>` — the
 * hash disambiguates same-named repos at different paths (e.g. two
 * checkouts of "flow" for different clients) without leaking the full path
 * into a directory name.
 */
export function repoCacheKey(primaryDir: string): string {
  const real = fs.realpathSync(primaryDir);
  const base = path.basename(real);
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}
/**
 * Per-machine epic-orchestrator runtime state root: `~/.flow/epics/<slug>/run.json`.
 * Physically distinct from the repo's committed `.flow/epics/<slug>/` (manifest +
 * design) — that is the design-vs-runtime split. Never committed, recomputable.
 */
export const FLOW_EPICS_DIR = path.join(FLOW_DIR, "epics");
export const FLOW_COMPLETIONS_DIR = path.join(FLOW_DIR, "completions");
export const FLOW_MANIFEST = path.join(FLOW_DIR, "installed.json");

/**
 * Resolves `~/.flow/config.json` at call time rather than import time. `HOME`
 * above is captured when this module is first imported — which happens
 * before vitest's setup file swaps `$HOME` for a sandbox — so an eager
 * `path.join(FLOW_DIR, "config.json")` constant would still point at the
 * developer's real `~/.flow/config.json`. Every reader of the config file
 * must go through this function, or the test suite silently depends on
 * whatever the author happens to have configured globally.
 */
export function flowConfigPath(): string {
  return path.join(os.homedir(), ".flow", "config.json");
}

/**
 * Host-wide epic-status lock directory, resolved at call time — same
 * rationale as `flowConfigPath()` above: `HOME` is captured at import time,
 * before vitest's setup file swaps `$HOME` for a sandbox, so an eager const
 * (the `SETUP_LOCK_PATH` pattern below) would leak the developer's real
 * `~/.flow` into every test that acquires an epic-status lock.
 */
export function epicStatusLockDir(): string {
  return path.join(os.homedir(), ".flow", "locks", "epic-status");
}

/**
 * Resolves `~/.local/bin/<name>` at call time, same rationale as
 * `flowConfigPath()` above: `HOME` is captured at import time, before
 * vitest's setup file swaps `$HOME` for a sandbox, so an eager
 * `path.join(LOCAL_BIN_DIR, name)` would resolve against the developer's
 * real home directory under tests.
 */
export function installedHelperPath(name: string): string {
  return path.join(os.homedir(), ".local", "bin", name);
}

/**
 * Resolves the `source` field from `~/.flow/config.json` at call time, for
 * the same reason as `flowConfigPath()` and `installedHelperPath()` above:
 * defaulting `homeDir` to the eager `HOME` constant would read the
 * developer's real config under vitest's sandbox HOME. Returns `null` when
 * the field is absent or the config is malformed/unreadable.
 */
export function configuredFlowSource(
  homeDir: string = os.homedir(),
): string | null {
  const config = readConfig(homeDir);
  return config.source ?? null;
}

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

/**
 * Standalone skills home. flow links its skills under here instead of the
 * global `~/.claude/skills/`, so a plain `claude` session carries zero flow
 * skills; only sessions launched with `claude --add-dir ~/.flow/claude-home`
 * (bare `flow`, plus every pipeline/epic seed) discover them.
 *
 * The home nests one level below `~/.flow` — the `--add-dir` grant is scoped
 * to everything under the added directory, so pointing at `~/.flow` directly
 * would expose `config.json`, every pipeline's `state/`, and
 * `research-cache/` to a prompt-injected session. Nesting at
 * `~/.flow/claude-home/` keeps the grant to the `.claude/` subtree only.
 */
export const FLOW_CLAUDE_HOME = path.join(FLOW_DIR, "claude-home");
export const FLOW_CLAUDE_HOME_SKILLS_DIR = path.join(
  FLOW_CLAUDE_HOME,
  ".claude",
  "skills",
);

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
