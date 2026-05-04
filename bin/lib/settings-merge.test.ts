import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countStopHook, ensureStopHook } from "./settings-merge";

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
