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
import * as os from "node:os";
import * as path from "node:path";

export type EnsureResult = {
  changed: boolean;
  reason?: "malformed-json" | "io-error" | "unsafe-symlink-target";
  error?: string;
};

export type RepairResult = {
  changed: boolean;
  backupPath?: string;
  resolvedPath?: string;
  reason?: "no-file" | "io-error" | "unsafe-symlink-target";
  error?: string;
};

/**
 * Containment guard: a symlink at `settingsPath` must resolve to a path
 * under the resolved home directory. Without this, a planted symlink at
 * the well-known `~/.claude/settings.json` location could redirect flow's
 * atomic temp+rename write at arbitrary files (e.g. `/etc/sudoers`,
 * dotfiles outside the home dir). The guard is symmetric across
 * `ensureStopHook` and `repairSettings`.
 *
 * Both operands are realpath'd before comparison so macOS's `/var → /private/var`
 * symlink chain doesn't cause a spurious escape (homedir returns `/var/...`,
 * realpath(settingsPath) returns `/private/var/...`, raw path.relative would
 * report an escape). When the resolved path doesn't yet exist (first-install
 * ENOENT fall-through), we walk up to its nearest existing ancestor before
 * realpath'ing — otherwise the comparison would still trip on the chain.
 */
function escapesHome(resolved: string, home: string): boolean {
  const realHome = realpathOrSelf(home);
  const realResolved = realpathWithExistingAncestor(resolved);
  const rel = path.relative(realHome, realResolved);
  return rel.startsWith("..") || path.isAbsolute(rel);
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function realpathWithExistingAncestor(p: string): string {
  let current = p;
  while (current !== path.dirname(current)) {
    try {
      const real = fs.realpathSync(current);
      // Re-attach the trailing path the ancestor didn't include.
      const tail = path.relative(current, p);
      return tail ? path.join(real, tail) : real;
    } catch {
      current = path.dirname(current);
    }
  }
  return p;
}

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

export function ensureStopHook(
  settingsPath: string,
  command: string,
  options: { homeDir?: string } = {},
): EnsureResult {
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
  const home = options.homeDir ?? os.homedir();
  if (escapesHome(resolved, home)) {
    return {
      changed: false,
      reason: "unsafe-symlink-target",
      error: `realpath ${resolved} escapes ${home}`,
    };
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
export function repairSettings(
  settingsPath: string,
  command: string,
  options: { homeDir?: string } = {},
): RepairResult {
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

  const home = options.homeDir ?? os.homedir();
  if (escapesHome(resolved, home)) {
    return {
      changed: false,
      reason: "unsafe-symlink-target",
      error: `realpath ${resolved} escapes ${home}`,
    };
  }

  // Preserve the original file's mode across both the backup and the
  // replacement write — repair must not silently widen permissions on a
  // 0600 settings file.
  let originalMode: number;
  try {
    originalMode = fs.statSync(resolved).mode & 0o777;
  } catch (err) {
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
    fs.writeFileSync(backupPath, original, { mode: originalMode });
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
    fs.writeFileSync(tmp, serialized + "\n", { mode: originalMode });
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
