/**
 * Idempotent merge of a Claude Code Stop hook into a settings.json file
 * (typically `~/.claude/settings.json`).
 *
 * Sentinel-based identity: a flow-managed entry is identified by its
 * `command` string (`"flow-stop-guard"`). This avoids clobbering any
 * user-authored Stop hook entries — they always have different
 * commands. Re-running is a no-op.
 *
 * Atomic write (temp + rename) prevents a partial-write from corrupting
 * the user's settings on a crash mid-flush.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type EnsureResult = {
  changed: boolean;
  reason?: "malformed-json" | "io-error";
  error?: string;
};

export type RepairResult = {
  changed: boolean;
  backupPath?: string;
  resolvedPath?: string;
  reason?: "no-file" | "io-error";
  error?: string;
};

type HookEntry = {
  type?: string;
  command: string;
  [k: string]: unknown;
};

type StopMatcher = {
  hooks?: HookEntry[];
  [k: string]: unknown;
};

type SettingsShape = {
  hooks?: {
    Stop?: StopMatcher[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

export function ensureStopHook(settingsPath: string, command: string): EnsureResult {
  let settings: SettingsShape = {};
  let hadFile = false;
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    hadFile = true;
    if (raw.trim().length > 0) {
      settings = JSON.parse(raw) as SettingsShape;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      if (err instanceof SyntaxError) {
        return {
          changed: false,
          reason: "malformed-json",
          error: "malformed JSON at " + settingsPath + ": " + err.message,
        };
      }
      return { changed: false, reason: "io-error", error: String(err) };
    }
  }

  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    return { changed: false, reason: "malformed-json", error: "settings root is not an object" };
  }

  const before = JSON.stringify(settings);
  settings.hooks ??= {};
  settings.hooks.Stop ??= [];

  if (alreadyContains(settings.hooks.Stop, command)) {
    return { changed: false };
  }

  settings.hooks.Stop.push({
    hooks: [{ type: "command", command }],
  });

  const after = JSON.stringify(settings, null, 2);
  if (after === before && hadFile) return { changed: false };

  // Resolve through any symlink so the rename targets the underlying file
  // and the user's dotfiles-managed symlink survives the write. First-install
  // (ENOENT) has no symlink to follow — fall through to the raw path.
  let resolved: string;
  try {
    resolved = fs.realpathSync(settingsPath);
  } catch {
    resolved = settingsPath;
  }
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${resolved}.flow-tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, after + "\n");
    fs.renameSync(tmp, resolved);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup; ignore
    }
    return { changed: false, reason: "io-error", error: String(err) };
  }
  return { changed: true };
}

/**
 * Opt-in recovery path for a malformed `settings.json`: copies the current
 * (malformed) content to a timestamped backup next to the realpath target,
 * then writes a minimal valid replacement containing only the Stop hook.
 *
 * Symlink-safe: `realpathSync` is applied first so the backup lives next to
 * the underlying file (e.g. dotfiles-managed target) and the rename targets
 * the resolved path — the symlink at `settingsPath` is preserved.
 */
export function repairSettings(settingsPath: string, command: string): RepairResult {
  let resolved: string;
  try {
    resolved = fs.realpathSync(settingsPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { changed: false, reason: "no-file" };
    }
    return { changed: false, reason: "io-error", error: String(err) };
  }

  let original: string;
  try {
    original = fs.readFileSync(resolved, "utf8");
  } catch (err) {
    return { changed: false, reason: "io-error", error: String(err) };
  }

  // ISO8601 with colons stripped — some filesystems mishandle `:` in
  // filenames, and the timestamp is recoverable-by-eyeball.
  const ts = new Date().toISOString().replace(/:/g, "-");
  const backupPath = `${resolved}.flow-backup-${ts}`;
  try {
    fs.writeFileSync(backupPath, original);
  } catch (err) {
    return { changed: false, reason: "io-error", error: String(err) };
  }

  const replacement: SettingsShape = {
    hooks: { Stop: [{ hooks: [{ type: "command", command }] }] },
  };
  const serialized = JSON.stringify(replacement, null, 2);
  const dir = path.dirname(resolved);
  const tmp = `${resolved}.flow-tmp-${process.pid}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, serialized + "\n");
    fs.renameSync(tmp, resolved);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup; ignore
    }
    return { changed: false, reason: "io-error", error: String(err) };
  }

  return { changed: true, backupPath, resolvedPath: resolved };
}

function alreadyContains(stops: StopMatcher[], command: string): boolean {
  for (const matcher of stops) {
    const hooks = Array.isArray(matcher?.hooks) ? matcher.hooks : [];
    for (const h of hooks) {
      if (h?.command === command) return true;
    }
  }
  return false;
}

/** Counts how many entries in hooks.Stop reference the given command — for tests/idempotency checks. */
export function countStopHook(settingsPath: string, command: string): number {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch {
    return 0;
  }
  let parsed: SettingsShape;
  try {
    parsed = JSON.parse(raw) as SettingsShape;
  } catch {
    return 0;
  }
  const stops = parsed.hooks?.Stop ?? [];
  let n = 0;
  for (const matcher of stops) {
    const hooks = Array.isArray(matcher?.hooks) ? matcher.hooks : [];
    for (const h of hooks) {
      if (h?.command === command) n++;
    }
  }
  return n;
}
