import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkUiLoginAutoMode,
  FLOW_UI_LOGIN_AUTOMODE_ALLOW_ENTRY,
  TOOLS_UI_LOGIN_AUTOMODE_META,
} from "./doctor-ui-login";
import { makeDeps } from "./doctor-test-deps";

let root: string;
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "doctor-ui-login-")),
  );
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function settingsAt(dir: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, body);
  return fs.realpathSync(file);
}

const homeClaude = () => path.join(root, "home", ".claude");
const allowOf = (allow: unknown) => JSON.stringify({ autoMode: { allow } });

describe("checkUiLoginAutoMode", () => {
  it("passes when autoMode.allow holds $defaults and a flow-ui-login entry, naming the file", () => {
    const file = settingsAt(
      homeClaude(),
      allowOf(["$defaults", FLOW_UI_LOGIN_AUTOMODE_ALLOW_ENTRY]),
    );
    const [c] = checkUiLoginAutoMode(makeDeps(root));
    expect(c).toMatchObject({
      id: TOOLS_UI_LOGIN_AUTOMODE_META.id,
      section: "tools",
      title: "Auto-mode UI login",
      status: "pass",
    });
    expect(c.summary).toContain(file);
  });

  it("warns when the entry is missing, naming the entry, the file and $defaults", () => {
    const file = settingsAt(homeClaude(), allowOf(["$defaults"]));
    const [c] = checkUiLoginAutoMode(makeDeps(root));
    expect(c.status).toBe("warn");
    expect(c.summary).toBe("auto mode may refuse the UI-check login");
    const details = c.details.join("\n");
    expect(details).toContain(FLOW_UI_LOGIN_AUTOMODE_ALLOW_ENTRY);
    expect(details).toContain(
      `add it to autoMode.allow in ${file}, keeping "$defaults"`,
    );
    expect(c.fix).toContain(file);
  });

  it("warns with the same text when the settings file does not exist", () => {
    const [c] = checkUiLoginAutoMode(makeDeps(root));
    expect(c.status).toBe("warn");
    expect(c.summary).toBe("auto mode may refuse the UI-check login");
    expect(c.details.join("\n")).toContain(FLOW_UI_LOGIN_AUTOMODE_ALLOW_ENTRY);
    expect(c.fix).toContain(path.join(homeClaude(), "settings.json"));
  });

  it("warns that built-in allow exceptions are replaced when the entry is present without $defaults", () => {
    const file = settingsAt(
      homeClaude(),
      allowOf([FLOW_UI_LOGIN_AUTOMODE_ALLOW_ENTRY]),
    );
    const [c] = checkUiLoginAutoMode(makeDeps(root));
    expect(c.status).toBe("warn");
    expect(c.details.join(" ")).toContain(
      "built-in allow exceptions are replaced",
    );
    expect(c.fix).toBe(`add "$defaults" to autoMode.allow in ${file}`);
  });

  it("warns that it cannot tell when the file is malformed", () => {
    settingsAt(homeClaude(), "{ nope");
    const [c] = checkUiLoginAutoMode(makeDeps(root));
    expect(c.status).toBe("warn");
    expect(c.summary).toContain("cannot tell");
    expect(c.details.join(" ")).toContain("not valid JSON");
  });

  it("treats a non-array autoMode.allow as an absent entry", () => {
    settingsAt(homeClaude(), allowOf("nope"));
    const [c] = checkUiLoginAutoMode(makeDeps(root));
    expect(c.status).toBe("warn");
    expect(c.summary).toBe("auto mode may refuse the UI-check login");
  });

  it("always notes that managed, --settings and repo-scope autoMode are not read", () => {
    settingsAt(
      homeClaude(),
      allowOf(["$defaults", FLOW_UI_LOGIN_AUTOMODE_ALLOW_ENTRY]),
    );
    for (const body of [null, "{ nope", allowOf(["$defaults"])]) {
      if (body !== null) settingsAt(homeClaude(), body);
      const [c] = checkUiLoginAutoMode(makeDeps(root));
      const details = c.details.join(" ");
      expect(details).toContain(
        "managed or --settings autoMode entries are not read",
      );
      expect(details).toContain(".claude/settings*.json");
    }
  });

  it("follows CLAUDE_CONFIG_DIR: the warning names a path under the config dir", () => {
    const cfg = path.join(root, "cfg");
    fs.mkdirSync(cfg);
    const [c] = checkUiLoginAutoMode(
      makeDeps(root, { env: { CLAUDE_CONFIG_DIR: cfg } }),
    );
    expect(c.status).toBe("warn");
    expect(c.fix).toContain(path.join(cfg, "settings.json"));
    expect(c.fix).not.toContain(homeClaude());
  });

  it("names the real file when settings.json is a symlink", () => {
    const real = path.join(root, "dotfiles", "claude-settings.json");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, allowOf(["$defaults"]));
    fs.mkdirSync(homeClaude(), { recursive: true });
    fs.symlinkSync(real, path.join(homeClaude(), "settings.json"));
    const [c] = checkUiLoginAutoMode(makeDeps(root));
    expect(c.status).toBe("warn");
    expect(c.fix).toContain(real);
  });

  it("never writes and never fails: bytes and mtime unchanged, status is never 'fail'", () => {
    const bodies = [
      allowOf(["$defaults", FLOW_UI_LOGIN_AUTOMODE_ALLOW_ENTRY]),
      allowOf([]),
      "{ nope",
    ];
    for (const body of bodies) {
      const file = settingsAt(homeClaude(), body);
      const stat = () => {
        const st = fs.statSync(file);
        return `${createHash("sha1").update(fs.readFileSync(file)).digest("hex")}@${st.mtimeMs}`;
      };
      const before = stat();
      const checks = checkUiLoginAutoMode(makeDeps(root));
      expect(stat()).toBe(before);
      for (const c of checks) expect(c.status).not.toBe("fail");
    }
    fs.rmSync(homeClaude(), { recursive: true, force: true });
    const [missing] = checkUiLoginAutoMode(makeDeps(root));
    expect(missing.status).not.toBe("fail");
    expect(fs.existsSync(path.join(homeClaude(), "settings.json"))).toBe(false);
  });
});
