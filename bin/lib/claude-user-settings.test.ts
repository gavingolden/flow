import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readUserSettings, userSettingsPath } from "./claude-user-settings";

let root: string;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claude-user-settings-")),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(name: string, body: string): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, body);
  return file;
}

describe("userSettingsPath", () => {
  it("honours CLAUDE_CONFIG_DIR and falls back to ~/.claude when it is empty or unset", () => {
    expect(userSettingsPath({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u")).toBe(
      "/cfg/settings.json",
    );
    expect(userSettingsPath({ CLAUDE_CONFIG_DIR: "" }, "/home/u")).toBe(
      "/home/u/.claude/settings.json",
    );
    expect(userSettingsPath({}, "/home/u")).toBe(
      "/home/u/.claude/settings.json",
    );
  });
});

describe("readUserSettings", () => {
  it("returns the parsed settings and the file path when ok", () => {
    const file = write(
      "a.json",
      JSON.stringify({ autoMode: { allow: ["x"] } }),
    );
    expect(readUserSettings(file)).toEqual({
      status: "ok",
      path: file,
      settings: { autoMode: { allow: ["x"] } },
    });
  });

  it("reads through a symlinked file and reports the real file", () => {
    const real = write("dotfiles-settings.json", "{}");
    const link = path.join(root, "settings.json");
    fs.symlinkSync(real, link);
    expect(readUserSettings(link)).toEqual({
      status: "ok",
      path: real,
      settings: {},
    });
  });

  it("reports a dangling symlink as missing-file naming the end of the chain", () => {
    const target = path.join(root, "dotfiles", "settings.json");
    const link = path.join(root, "settings.json");
    fs.symlinkSync(target, link);
    expect(readUserSettings(link)).toEqual({
      status: "missing-file",
      path: target,
    });
  });

  it("reports a plain missing file with its own path", () => {
    const missing = path.join(root, "nope.json");
    expect(readUserSettings(missing)).toEqual({
      status: "missing-file",
      path: missing,
    });
  });

  it("reports invalid JSON and non-object top levels as malformed", () => {
    expect(readUserSettings(write("b.json", "{not json")).status).toBe(
      "malformed",
    );
    expect(readUserSettings(write("c.json", "[]")).status).toBe("malformed");
    expect(readUserSettings(write("d.json", "null")).status).toBe("malformed");
    expect(readUserSettings(write("e.json", '"str"')).status).toBe("malformed");
  });

  it("never writes: bytes and mtime of the settings file are unchanged by a read", () => {
    const file = write(
      "f.json",
      JSON.stringify({ permissions: { allow: [] } }),
    );
    const stat = () => {
      const st = fs.statSync(file);
      return `${createHash("sha1").update(fs.readFileSync(file)).digest("hex")}@${st.mtimeMs}`;
    };
    const before = stat();
    readUserSettings(file);
    expect(stat()).toBe(before);
  });
});
