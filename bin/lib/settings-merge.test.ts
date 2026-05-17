import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countStopHook, ensureStopHook, repairSettings } from "./settings-merge";

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

describe("ensureStopHook", () => {
  it("creates settings.json with the hook entry when the file is missing", () => {
    const result = ensureStopHook(settings, COMMAND);
    expect(result).toEqual({ changed: true });
    expect(countStopHook(settings, COMMAND)).toBe(1);
  });

  it("creates the parent directory when missing", () => {
    const nested = path.join(dir, "nested", "settings.json");
    const result = ensureStopHook(nested, COMMAND);
    expect(result).toEqual({ changed: true });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("preserves unrelated keys when the file exists with no hooks", () => {
    fs.writeFileSync(
      settings,
      JSON.stringify({ theme: "dark", model: "opus", permissions: { allow: ["Bash(ls:*)"] } }),
    );
    expect(ensureStopHook(settings, COMMAND)).toEqual({ changed: true });
    const got = read() as Record<string, unknown>;
    expect(got.theme).toBe("dark");
    expect(got.model).toBe("opus");
    expect((got.permissions as { allow: string[] }).allow).toEqual(["Bash(ls:*)"]);
    expect(countStopHook(settings, COMMAND)).toBe(1);
  });

  it("appends to existing hooks.Stop without mutating user-authored entries", () => {
    fs.writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "/usr/local/bin/user-script.sh" }] },
          ],
        },
      }),
    );
    expect(ensureStopHook(settings, COMMAND)).toEqual({ changed: true });
    const got = read() as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } };
    expect(got.hooks.Stop).toHaveLength(2);
    expect(got.hooks.Stop[0].hooks[0].command).toBe("/usr/local/bin/user-script.sh");
    expect(got.hooks.Stop[1].hooks[0].command).toBe(COMMAND);
  });

  it("is idempotent: re-running does not duplicate the entry", () => {
    expect(ensureStopHook(settings, COMMAND)).toEqual({ changed: true });
    expect(ensureStopHook(settings, COMMAND)).toEqual({ changed: false });
    expect(ensureStopHook(settings, COMMAND)).toEqual({ changed: false });
    expect(countStopHook(settings, COMMAND)).toBe(1);
  });

  it("treats malformed JSON as an error and does not overwrite", () => {
    fs.writeFileSync(settings, "{not valid json");
    const result = ensureStopHook(settings, COMMAND);
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
    const result = ensureStopHook(settings, COMMAND);
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

    const result = ensureStopHook(settings, COMMAND);
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
    const result = ensureStopHook(settings, COMMAND);
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("malformed-json");
  });

  it("treats an empty file as a fresh start (no error)", () => {
    fs.writeFileSync(settings, "");
    const result = ensureStopHook(settings, COMMAND);
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
    expect(ensureStopHook(settings, COMMAND)).toEqual({ changed: true });
    const remaining = fs.readdirSync(dir);
    expect(remaining.filter((f) => f.includes("flow-tmp"))).toEqual([]);
    expect(remaining).toContain("settings.json");
  });
});

describe("repairSettings", () => {
  it("backs up a malformed regular file and writes a minimal valid replacement", () => {
    const seed = '{"theme":"dar';
    fs.writeFileSync(settings, seed);

    const result = repairSettings(settings, COMMAND);
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
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-settings-real-"));
    try {
      const target = path.join(realDir, "real-settings.json");
      const seed = '{"theme":"dar';
      fs.writeFileSync(target, seed);
      fs.symlinkSync(target, settings);

      const result = repairSettings(settings, COMMAND);
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
    const result = repairSettings(path.join(dir, "missing.json"), COMMAND);
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("no-file");
  });
});
