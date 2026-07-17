/**
 * Tolerant boundary reader + read-modify-write writer for
 * `~/.flow/config.json`'s `launcher` key — the persisted launcher backend
 * (`plain` | `tmux`) `flow install` records so `--upgrade` never re-asks —
 * plus the runtime precedence resolver (`resolveLauncherBackend`:
 * flag > state > config > default-plain, with a tmux-absent degrade) and the
 * install-time Q&A resolver (`resolveLauncherSelection`).
 *
 * Mirrors `modules-config.ts`: injectable `ReadConfigFile` seam, absent ≡
 * `undefined`, sibling-key-preserving writes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { flowConfigPath } from "./paths";
import {
  defaultReadConfigFile,
  readConfigFileAt,
  type ReadConfigFile,
} from "./modules-config";

export type LauncherId = "plain" | "tmux";

export const LAUNCHER_IDS = ["plain", "tmux"] as const;

export function isLauncherId(x: unknown): x is LauncherId {
  return x === "plain" || x === "tmux";
}

/**
 * The notice printed when the resolved backend is `tmux` but tmux is not on
 * PATH — the resolver degrades to `plain` rather than failing.
 */
export const TMUX_DEGRADE_NOTICE =
  "flow: tmux launcher selected but tmux is not on PATH — falling back to the plain launcher";

const LAUNCHER_PROMPT =
  "Use tmux as your pipeline launcher? (recommended for parallel pipelines and walk-away/attach)";

function extractLauncher(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return undefined;
  return (raw as Record<string, unknown>).launcher;
}

/**
 * The persisted launcher when `launcher` is a well-formed id. `undefined`
 * means "unset" (absent, unreadable, or the wrong type / unknown id) — the
 * caller's precedence then falls through. Never throws.
 */
export function readLauncherConfig(
  read: ReadConfigFile = defaultReadConfigFile,
): LauncherId | undefined {
  const raw = extractLauncher(read());
  return isLauncherId(raw) ? raw : undefined;
}

/**
 * Best-effort, non-fatal warnings for a malformed `launcher` config value.
 * Never throws; an unreadable/absent config yields an empty list.
 */
export function collectLauncherConfigWarnings(
  read: ReadConfigFile = defaultReadConfigFile,
): string[] {
  const raw = extractLauncher(read());
  if (raw === undefined || isLauncherId(raw)) return [];
  return [
    `launcher: expected 'plain' or 'tmux', got ${JSON.stringify(raw)}; ignoring.`,
  ];
}

/**
 * Read-modify-write: sets `launcher` to `id` while preserving every sibling
 * top-level key untouched. Same discipline as `writeModuleSelection`.
 */
export function writeLauncherConfig(
  id: LauncherId,
  options: { configPath?: string; read?: ReadConfigFile } = {},
): void {
  const configPath = options.configPath ?? flowConfigPath();
  const raw = options.read ? options.read() : readConfigFileAt(configPath);
  const obj =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const next = { ...obj, launcher: id };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n");
}

export type LauncherBackendSource = "flag" | "state" | "config" | "default";

export type LauncherBackendResult = {
  id: LauncherId;
  source: LauncherBackendSource;
  /** Present only when a tmux resolution degraded to plain (tmux off PATH). */
  notice?: string;
};

// node:child_process (not Bun.spawnSync) so the probe also works under the
// vitest node runtime — this fires on every tmux-resolved launch path.
function tmuxOnPathDefault(): boolean {
  try {
    return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Runtime backend resolution. Precedence, exactly:
 *   1. explicit CLI flag (`--tmux` / `--no-tmux`),
 *   2. the pipeline's recorded `state.launcher` (resume must reuse the
 *      backend the pipeline was created under),
 *   3. the recorded `~/.flow/config.json` `launcher`,
 *   4. default `plain`.
 * A `tmux` resolution degrades to `plain` with `TMUX_DEGRADE_NOTICE` when
 * tmux is not on PATH (source is preserved so callers can still report where
 * the tmux preference came from).
 */
export function resolveLauncherBackend(opts: {
  flag?: LauncherId;
  state?: LauncherId;
  read?: ReadConfigFile;
  tmuxOnPath?: () => boolean;
}): LauncherBackendResult {
  let id: LauncherId;
  let source: LauncherBackendSource;
  if (opts.flag !== undefined) {
    id = opts.flag;
    source = "flag";
  } else if (opts.state !== undefined) {
    id = opts.state;
    source = "state";
  } else {
    const recorded = readLauncherConfig(opts.read);
    if (recorded !== undefined) {
      id = recorded;
      source = "config";
    } else {
      id = "plain";
      source = "default";
    }
  }
  if (id === "tmux") {
    const onPath = opts.tmuxOnPath ?? tmuxOnPathDefault;
    if (!onPath()) {
      return { id: "plain", source, notice: TMUX_DEGRADE_NOTICE };
    }
  }
  return { id, source };
}

export type LauncherSelectionResult = {
  id: LauncherId;
  source: "config" | "prompt" | "default";
  /**
   * True only for a completed interactive prompt (real user intent); false
   * for a replayed recorded value (already persisted) or the non-TTY default
   * (no intent was expressed).
   */
  shouldPersist: boolean;
};

/**
 * The install-time launcher Q&A resolver. Precedence, exactly:
 *   1. A recorded `launcher` config value — re-installs/`--upgrade` honor it
 *      with zero `confirm` calls.
 *   2. Interactive TTY: ask the (default-off) tmux question once.
 *   3. Non-interactive, nothing recorded: default `plain`, do NOT persist.
 */
export function resolveLauncherSelection(opts: {
  isTTY: boolean;
  confirm: (prompt: string) => boolean;
  read?: ReadConfigFile;
}): LauncherSelectionResult {
  const recorded = readLauncherConfig(opts.read);
  if (recorded !== undefined) {
    return { id: recorded, source: "config", shouldPersist: false };
  }
  if (opts.isTTY) {
    const id: LauncherId = opts.confirm(LAUNCHER_PROMPT) ? "tmux" : "plain";
    return { id, source: "prompt", shouldPersist: true };
  }
  return { id: "plain", source: "default", shouldPersist: false };
}
