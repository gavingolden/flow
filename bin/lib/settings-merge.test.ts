import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countSessionStartHook,
  countStopHook,
  ensureSessionStartHook,
  ensureStopHook,
  repairSettings,
} from "./settings-merge";

const COMMAND = "flow-stop-guard";

let dir!: string;
let settings!: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-settings-merge-"));
  settings = path.join(dir, "settings.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function read(): unknown {
  return JSON.parse(fs.readFileSync(settings, "utf8"));
}

// Existing tests stash settings under per-test tmpdir subdirs (some under
// `dir`, some under sibling `realDir` for the symlink case). The symlink-
// containment guard added in the symlink-target hardening expects the
// resolved path to live under a `homeDir` root — without DI, every existing
// test would trip the guard because tmpdir is not under the real
// `os.homedir()`. Threading `os.tmpdir()` as homeDir contains every per-test
// fixture (both `dir` and the symlink-test's `realDir` are under tmpdir),
// while the `symlink-target containment guard` describe block below still
// exercises the negative path with an isolated homeOverride.
const TEST_HOME = os.tmpdir();
function ensureWithHome(p: string): ReturnType<typeof ensureStopHook> {
  return ensureStopHook(p, COMMAND, { homeDir: TEST_HOME });
}
function repairWithHome(p: string): ReturnType<typeof repairSettings> {
  return repairSettings(p, COMMAND, { homeDir: TEST_HOME });
}

describe("ensureStopHook", () => {
  it("creates settings.json with the hook entry when the file is missing", () => {
    const result = ensureWithHome(settings);
    expect(result).toEqual({ changed: true });
    expect(countStopHook(settings, COMMAND)).toBe(1);
  });

  it("creates the parent directory when missing", () => {
    const nested = path.join(dir, "nested", "settings.json");
    const result = ensureWithHome(nested);
    expect(result).toEqual({ changed: true });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("preserves unrelated keys when the file exists with no hooks", () => {
    fs.writeFileSync(
      settings,
      JSON.stringify({
        theme: "dark",
        model: "opus",
        permissions: { allow: ["Bash(ls:*)"] },
      }),
    );
    expect(ensureWithHome(settings)).toEqual({ changed: true });
    const got = read() as Record<string, unknown>;
    expect(got.theme).toBe("dark");
    expect(got.model).toBe("opus");
    expect((got.permissions as { allow: string[] }).allow).toEqual([
      "Bash(ls:*)",
    ]);
    expect(countStopHook(settings, COMMAND)).toBe(1);
  });

  it("appends to existing hooks.Stop without mutating user-authored entries", () => {
    fs.writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "command", command: "/usr/local/bin/user-script.sh" },
              ],
            },
          ],
        },
      }),
    );
    expect(ensureWithHome(settings)).toEqual({ changed: true });
    const got = read() as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(got.hooks.Stop).toHaveLength(2);
    expect(got.hooks.Stop[0].hooks[0].command).toBe(
      "/usr/local/bin/user-script.sh",
    );
    expect(got.hooks.Stop[1].hooks[0].command).toBe(COMMAND);
  });

  it("is idempotent: re-running does not duplicate the entry", () => {
    expect(ensureWithHome(settings)).toEqual({ changed: true });
    expect(ensureWithHome(settings)).toEqual({ changed: false });
    expect(ensureWithHome(settings)).toEqual({ changed: false });
    expect(countStopHook(settings, COMMAND)).toBe(1);
  });

  it("treats malformed JSON as an error and does not overwrite", () => {
    fs.writeFileSync(settings, "{not valid json");
    const result = ensureWithHome(settings);
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("malformed-json");
    expect(fs.readFileSync(settings, "utf8")).toBe("{not valid json");
  });

  it("reproduces the 'Unterminated string' symptom from PR's user report", () => {
    // Seed the literal unterminated-string content from the user's terminal
    // and assert the safe-bailout contract: reason is malformed-json, the
    // error mentions Unterminated AND includes the absolute settingsPath
    // (the path-prefixed error added in Task 2), and the file is byte-
    // identical to the seed (never stomped).
    const seed = '{"theme":"dar';
    fs.writeFileSync(settings, seed);
    const result = ensureWithHome(settings);
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("malformed-json");
    expect(result.error).toContain("Unterminated");
    expect(result.error).toContain(settings);
    expect(fs.readFileSync(settings, "utf8")).toBe(seed);
  });

  it("preserves the symlink when settingsPath is a symlink to a target file", () => {
    // Dotfiles-managed setup: settings.json is a symlink to the real file
    // (e.g. ~/code/dotfiles/claude/settings.json). The write must target
    // the realpath so the symlink survives — without realpath, renameSync
    // would replace the symlink with a regular file.
    const target = path.join(dir, "real-settings.json");
    fs.writeFileSync(target, "{}");
    fs.symlinkSync(target, settings);

    const result = ensureWithHome(settings);
    expect(result).toEqual({ changed: true });
    expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
    expect(countStopHook(settings, COMMAND)).toBe(1);
    // The hook now lives in the target file, not at the symlink path.
    const targetContent = JSON.parse(fs.readFileSync(target, "utf8")) as {
      hooks?: { Stop?: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    expect(targetContent.hooks?.Stop?.[0]?.hooks?.[0]?.command).toBe(COMMAND);
  });

  it("treats a non-object root as malformed", () => {
    fs.writeFileSync(settings, "[1,2,3]");
    const result = ensureWithHome(settings);
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("malformed-json");
  });

  it("treats an empty file as a fresh start (no error)", () => {
    fs.writeFileSync(settings, "");
    const result = ensureWithHome(settings);
    expect(result).toEqual({ changed: true });
    expect(countStopHook(settings, COMMAND)).toBe(1);
  });

  it("countStopHook returns 0 when the file is missing", () => {
    expect(countStopHook(path.join(dir, "missing.json"), COMMAND)).toBe(0);
  });

  it("countStopHook returns 0 for malformed json", () => {
    fs.writeFileSync(settings, "{nope");
    expect(countStopHook(settings, COMMAND)).toBe(0);
  });

  it("uses an atomic temp+rename so a crashed write does not leave a partial file", () => {
    expect(ensureWithHome(settings)).toEqual({ changed: true });
    const remaining = fs.readdirSync(dir);
    expect(remaining.filter((f) => f.includes("flow-tmp"))).toEqual([]);
    expect(remaining).toContain("settings.json");
  });
});

describe("ensureSessionStartHook", () => {
  const SS_COMMAND = "flow-session-start-hook";
  function ensureSSWithHome(
    p: string,
  ): ReturnType<typeof ensureSessionStartHook> {
    return ensureSessionStartHook(p, SS_COMMAND, { homeDir: TEST_HOME });
  }

  it("creates settings.json with a matcher:'clear' SessionStart entry when missing", () => {
    const result = ensureSSWithHome(settings);
    expect(result).toEqual({ changed: true });
    expect(countSessionStartHook(settings, SS_COMMAND)).toBe(1);
    const got = read() as {
      hooks: { SessionStart: Array<{ matcher?: string }> };
    };
    expect(got.hooks.SessionStart[0].matcher).toBe("clear");
  });

  it("is idempotent: re-running does not duplicate the entry", () => {
    expect(ensureSSWithHome(settings)).toEqual({ changed: true });
    expect(ensureSSWithHome(settings)).toEqual({ changed: false });
    expect(ensureSSWithHome(settings)).toEqual({ changed: false });
    expect(countSessionStartHook(settings, SS_COMMAND)).toBe(1);
  });

  it("preserves user-authored SessionStart entries when registering", () => {
    fs.writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "startup",
              hooks: [{ type: "command", command: "/usr/local/bin/user.sh" }],
            },
          ],
        },
      }),
    );
    expect(ensureSSWithHome(settings)).toEqual({ changed: true });
    const got = read() as {
      hooks: {
        SessionStart: Array<{
          matcher?: string;
          hooks: Array<{ command: string }>;
        }>;
      };
    };
    expect(got.hooks.SessionStart).toHaveLength(2);
    expect(got.hooks.SessionStart[0].hooks[0].command).toBe(
      "/usr/local/bin/user.sh",
    );
    expect(got.hooks.SessionStart[1].hooks[0].command).toBe(SS_COMMAND);
    expect(got.hooks.SessionStart[1].matcher).toBe("clear");
  });

  it("coexists with a Stop hook without disturbing it", () => {
    ensureStopHook(settings, COMMAND, { homeDir: TEST_HOME });
    ensureSSWithHome(settings);
    expect(countStopHook(settings, COMMAND)).toBe(1);
    expect(countSessionStartHook(settings, SS_COMMAND)).toBe(1);
  });

  it("refuses to write when settingsPath is a symlink escaping homedir", () => {
    const homeOverride = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-ss-home-"),
    );
    const escapeTarget = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-ss-escape-"),
    );
    try {
      const settingsLink = path.join(homeOverride, "settings.json");
      const planted = path.join(escapeTarget, "planted-target.json");
      fs.writeFileSync(planted, "{}");
      fs.symlinkSync(planted, settingsLink);

      const result = ensureSessionStartHook(settingsLink, SS_COMMAND, {
        homeDir: homeOverride,
      });
      expect(result.changed).toBe(false);
      expect(result.reason).toBe("unsafe-symlink-target");
      expect(result.error).toContain("escapes");
      expect(fs.readFileSync(planted, "utf8")).toBe("{}");
    } finally {
      fs.rmSync(homeOverride, { recursive: true, force: true });
      fs.rmSync(escapeTarget, { recursive: true, force: true });
    }
  });
});

describe("repairSettings", () => {
  it("backs up a malformed regular file and writes a minimal valid replacement", () => {
    const seed = '{"theme":"dar';
    fs.writeFileSync(settings, seed);

    const result = repairWithHome(settings);
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeDefined();
    // On macOS, /tmp -> /private/tmp through realpath; compare via realpath.
    expect(result.resolvedPath).toBe(fs.realpathSync(settings));

    // Backup file exists and carries the original (malformed) content.
    expect(fs.readFileSync(result.backupPath!, "utf8")).toBe(seed);

    // Main file is now valid JSON and contains the hook.
    const parsed = JSON.parse(fs.readFileSync(settings, "utf8"));
    expect(parsed).toBeDefined();
    expect(countStopHook(settings, COMMAND)).toBe(1);
  });

  it("places the backup next to the realpath target when settingsPath is a symlink", () => {
    // Dotfiles-style layout: settings.json is a symlink to the real file
    // somewhere else. The backup must land next to the *target* (not next
    // to the symlink) and the symlink itself must survive.
    const realDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-settings-real-"),
    );
    try {
      const target = path.join(realDir, "real-settings.json");
      const seed = '{"theme":"dar';
      fs.writeFileSync(target, seed);
      fs.symlinkSync(target, settings);

      const result = repairWithHome(settings);
      expect(result.changed).toBe(true);
      expect(result.resolvedPath).toBe(fs.realpathSync(target));
      // Backup lives next to the realpath, not the symlink.
      expect(result.backupPath!.startsWith(fs.realpathSync(target))).toBe(true);
      expect(path.dirname(result.backupPath!)).toBe(fs.realpathSync(realDir));

      // Symlink still exists at settingsPath.
      expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);

      // Target file is now valid JSON containing the hook.
      const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
      expect(parsed).toBeDefined();
      expect(countStopHook(settings, COMMAND)).toBe(1);

      // Backup carries original (malformed) content.
      expect(fs.readFileSync(result.backupPath!, "utf8")).toBe(seed);
    } finally {
      fs.rmSync(realDir, { recursive: true, force: true });
    }
  });

  it("returns no-file when settingsPath does not exist", () => {
    const result = repairWithHome(path.join(dir, "missing.json"));
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("no-file");
  });

  it("returns no-file when settingsPath is a dangling symlink (target missing)", () => {
    // Documents current ENOENT-mapping behaviour: a symlink whose target
    // doesn't exist is treated the same as a missing regular file. Freezes
    // the contract so a future refactor doesn't accidentally promote the
    // dangling-symlink case to a different reason (e.g. `io-error`).
    const missingTarget = path.join(dir, "missing-target.json");
    fs.symlinkSync(missingTarget, settings);

    const result = repairWithHome(settings);
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("no-file");
  });

  it("preserves the original file's mode across both backup and replacement", () => {
    // Repair runs against a hand-tightened 0600 settings file (a common
    // dotfiles-managed permissioning). The backup and the replacement both
    // need to keep that mode — silently widening to 0644 would leak the
    // user's secrets to other local accounts on a shared box.
    const seed = '{"theme":"dar';
    fs.writeFileSync(settings, seed, { mode: 0o600 });
    // Ensure the mode actually landed (umask on some platforms can mask
    // writeFileSync's mode arg on the *create* path; chmod is unambiguous).
    fs.chmodSync(settings, 0o600);

    const result = repairWithHome(settings);
    expect(result.changed).toBe(true);

    const backupMode = fs.statSync(result.backupPath!).mode & 0o777;
    expect(backupMode).toBe(0o600);

    const replacementMode = fs.statSync(settings).mode & 0o777;
    expect(replacementMode).toBe(0o600);
  });
});

describe("symlink-target containment guard", () => {
  // Both ensureStopHook and repairSettings must refuse to write when the
  // symlink at settingsPath escapes the supplied homedir. Without the guard,
  // a planted symlink at ~/.claude/settings.json could redirect flow's
  // atomic temp+rename at arbitrary files. We use a tmpdir-as-home fixture:
  // the symlink target lives OUTSIDE that tmpdir, so the guard's
  // `escapesHome` check fires. Both operands realpath'd inside the guard
  // (matches the production behaviour on macOS where /var → /private/var).
  let homeOverride!: string;
  let escapeTarget!: string;

  beforeEach(() => {
    homeOverride = fs.mkdtempSync(path.join(os.tmpdir(), "flow-home-"));
    // The escape target lives OUTSIDE homeOverride — a parallel tmpdir so
    // realpath comparison is unambiguous (no /private prefix mismatch).
    escapeTarget = fs.mkdtempSync(path.join(os.tmpdir(), "flow-escape-"));
  });

  afterEach(() => {
    fs.rmSync(homeOverride, { recursive: true, force: true });
    fs.rmSync(escapeTarget, { recursive: true, force: true });
  });

  it("ensureStopHook refuses to write when settingsPath is a symlink escaping homedir", () => {
    // settings.json lives inside the fake home, but symlinks OUT of it.
    const settingsLink = path.join(homeOverride, "settings.json");
    const planted = path.join(escapeTarget, "planted-target.json");
    fs.writeFileSync(planted, "{}");
    fs.symlinkSync(planted, settingsLink);

    const result = ensureStopHook(settingsLink, COMMAND, {
      homeDir: homeOverride,
    });
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("unsafe-symlink-target");
    expect(result.error).toContain("escapes");
    // Planted file must NOT have been written to.
    expect(fs.readFileSync(planted, "utf8")).toBe("{}");
  });

  it("repairSettings refuses to write when settingsPath is a symlink escaping homedir", () => {
    const settingsLink = path.join(homeOverride, "settings.json");
    const planted = path.join(escapeTarget, "planted-target.json");
    const seed = '{"theme":"dar';
    fs.writeFileSync(planted, seed);
    fs.symlinkSync(planted, settingsLink);

    const result = repairSettings(settingsLink, COMMAND, {
      homeDir: homeOverride,
    });
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("unsafe-symlink-target");
    expect(result.error).toContain("escapes");
    // Planted file untouched, no backup file landed in the escape dir.
    expect(fs.readFileSync(planted, "utf8")).toBe(seed);
    const entries = fs.readdirSync(escapeTarget);
    expect(entries.filter((f) => f.includes("flow-backup"))).toEqual([]);
  });
});
