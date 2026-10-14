/**
 * Read-only access to the owner's Claude user settings file. Shared by every
 * doctor probe and gate-summary hint that inspects it (the merge permission,
 * the auto-mode UI login entry) so they all resolve the same file the same
 * way. flow reads this file and never writes it — not here, not from
 * `flow install`, not into a consumer repo.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const MAX_LINK_HOPS = 16;

export type UserSettingsRead =
  | { status: "ok"; path: string; settings: Record<string, unknown> }
  | { status: "missing-file" | "malformed"; path: string };

/** `settings.json` under `CLAUDE_CONFIG_DIR` when set and non-empty, else `~/.claude/settings.json`. */
export function userSettingsPath(
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir !== undefined && dir.length > 0
    ? path.join(dir, "settings.json")
    : path.join(homeDir, ".claude", "settings.json");
}

/** Where a possibly dangling symlink chain ends, so the owner is told which file to create. */
function followLinks(start: string): string {
  let current = start;
  for (let i = 0; i < MAX_LINK_HOPS; i++) {
    try {
      const target = fs.readlinkSync(current);
      current = path.resolve(path.dirname(current), target);
    } catch {
      return current;
    }
  }
  return current;
}

/**
 * Read-only, never throws. Follows symlinks (the owner's file is typically a
 * dotfiles link) and reports the resolved path so a warning names the real
 * file to edit. A top level that is not a JSON object is `malformed`.
 */
export function readUserSettings(settingsPath: string): UserSettingsRead {
  let resolvedPath: string;
  try {
    resolvedPath = fs.realpathSync(settingsPath);
  } catch {
    return { status: "missing-file", path: followLinks(settingsPath) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    return {
      status: missing ? "missing-file" : "malformed",
      path: resolvedPath,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "malformed", path: resolvedPath };
  }
  return {
    status: "ok",
    path: resolvedPath,
    settings: parsed as Record<string, unknown>,
  };
}
