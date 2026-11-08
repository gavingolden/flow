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

/**
 * Every home-derived path below resolves at call time through this one
 * function, so a per-test `vi.stubEnv("HOME", ...)` (and the vitest sandbox
 * HOME) is always honoured instead of whatever HOME was at import time.
 */
// prettier-ignore
export function currentHome(): string { return process.env.HOME || os.homedir(); }

export function flowDir(): string {
  return path.join(currentHome(), ".flow");
}
export function flowStateDir(): string {
  return path.join(flowDir(), "state");
}
/**
 * Per-repo cache root for artifacts that must survive a worktree's removal
 * (e.g. the agent-memory-local handoff) — distinct from `flowStateDir()`
 * (per-pipeline state) and `~/.flow/research-cache` (the only cache dir
 * that exists on a host today).
 */
export function flowCacheDir(): string {
  return path.join(flowDir(), "cache");
}

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
export function flowEpicsDir(): string {
  return path.join(flowDir(), "epics");
}
export function flowCompletionsDir(): string {
  return path.join(flowDir(), "completions");
}
export function flowManifestPath(): string {
  return path.join(flowDir(), "installed.json");
}

/** Resolves `~/.flow/config.json`. Every reader of the config file must go through this function. */
export function flowConfigPath(): string {
  return path.join(flowDir(), "config.json");
}

/** Host-wide epic-status lock directory. */
export function epicStatusLockDir(): string {
  return path.join(flowDir(), "locks", "epic-status");
}

/**
 * Per-pipeline private skill copies root (`~/.flow/overlays/<slug>/`).
 * Pruning it against a test's tmp state dir would delete live pipelines'
 * copies, so it must follow the sandbox HOME.
 */
export function flowOverlaysDir(): string {
  return path.join(flowDir(), "overlays");
}

/** Resolves `~/.local/bin/<name>`. */
export function installedHelperPath(name: string): string {
  return path.join(localBinDir(), name);
}

/**
 * Resolves the `source` field from `~/.flow/config.json`. Returns `null`
 * when the field is absent or the config is malformed/unreadable.
 */
export function configuredFlowSource(
  homeDir: string = currentHome(),
): string | null {
  const config = readConfig(homeDir);
  return config.source ?? null;
}

/** Resolves `~/.flow/telemetry/events.jsonl`. */
export function flowTelemetryLogPath(homeDir: string = currentHome()): string {
  return path.join(homeDir, ".flow", "telemetry", "events.jsonl");
}

/** Resolves `~/.flow/telemetry/run-attribution.jsonl`. */
export function flowRunAttributionLogPath(
  homeDir: string = currentHome(),
): string {
  return path.join(homeDir, ".flow", "telemetry", "run-attribution.jsonl");
}

export function flowUpdateCachePath(): string {
  return path.join(flowDir(), "update-check.json");
}
export function setupLockPath(): string {
  return path.join(flowDir(), "setup.lock");
}
export function flowTestSemDir(): string {
  return path.join(flowDir(), "test-sem");
}
/**
 * Counting-semaphore slot dir for the host-wide `flow feature create` launch concurrency
 * cap (mirrors flowTestSemDir). Overridable for tests via the
 * `FLOW_LAUNCH_SEM_DIR` env var so unit launches stay off the real ~/.flow.
 */
export function flowLaunchSemDir(): string {
  return path.join(flowDir(), "launch-sem");
}
/**
 * Flow-scoped Claude Code settings file passed to `claude --settings` on the
 * launch argv. Registers the UserPromptSubmit seed-ingested hook for
 * flow-launched sessions only — `--settings` is ADDITIVE (the user's global
 * ~/.claude/settings.json still applies), so this file NEVER mutates global
 * settings.
 */
export function flowLaunchSettingsPath(): string {
  return path.join(flowDir(), "launch-settings.json");
}

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
export function flowClaudeHome(): string {
  return path.join(flowDir(), "claude-home");
}
export function flowClaudeHomeSkillsDir(): string {
  return path.join(flowClaudeHome(), ".claude", "skills");
}

export function claudeAgentsDir(): string {
  return path.join(currentHome(), ".claude", "agents");
}
export function claudeSettingsPath(): string {
  return path.join(currentHome(), ".claude", "settings.json");
}
export function localBinDir(): string {
  return path.join(currentHome(), ".local", "bin");
}

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
export function resolveFlowSource(homeDir: string = currentHome()): string {
  const config = readConfig(homeDir);
  if (config.source) return path.resolve(config.source.replace(/^~/, homeDir));
  return path.resolve(path.dirname(modulePath()), "..", "..");
}

function modulePath(): string {
  const bunPath = (import.meta as { path?: unknown }).path;
  if (typeof bunPath === "string") return bunPath;
  return fileURLToPath(import.meta.url);
}
