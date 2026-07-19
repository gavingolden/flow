import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TMUX_DEGRADE_NOTICE,
  collectLauncherConfigWarnings,
  readLauncherConfig,
  resolveLauncherBackend,
  resolveLauncherSelection,
  writeLauncherConfig,
} from "./launcher-config";
import type { ReadConfigFile } from "./modules-config";

const reader =
  (raw: unknown): ReadConfigFile =>
  () =>
    raw;

describe("readLauncherConfig", () => {
  it("returns undefined when launcher is absent", () => {
    expect(readLauncherConfig(reader({}))).toBeUndefined();
  });

  it("returns undefined when the config is unreadable", () => {
    expect(readLauncherConfig(reader(undefined))).toBeUndefined();
  });

  it("returns undefined for a wrong-type value", () => {
    expect(readLauncherConfig(reader({ launcher: 42 }))).toBeUndefined();
    expect(readLauncherConfig(reader({ launcher: ["tmux"] }))).toBeUndefined();
  });

  it("returns undefined for an unknown id", () => {
    expect(readLauncherConfig(reader({ launcher: "screen" }))).toBeUndefined();
  });

  it("returns the recorded id", () => {
    expect(readLauncherConfig(reader({ launcher: "tmux" }))).toBe("tmux");
    expect(readLauncherConfig(reader({ launcher: "plain" }))).toBe("plain");
  });
});

describe("collectLauncherConfigWarnings", () => {
  it("is empty for absent, unreadable, or valid values", () => {
    expect(collectLauncherConfigWarnings(reader({}))).toEqual([]);
    expect(collectLauncherConfigWarnings(reader(undefined))).toEqual([]);
    expect(collectLauncherConfigWarnings(reader({ launcher: "tmux" }))).toEqual(
      [],
    );
  });

  it("warns on a wrong-type or unknown value", () => {
    expect(
      collectLauncherConfigWarnings(reader({ launcher: "screen" })),
    ).toEqual([
      "launcher: expected 'plain' or 'tmux', got \"screen\"; ignoring.",
    ]);
    expect(collectLauncherConfigWarnings(reader({ launcher: 1 }))).toHaveLength(
      1,
    );
  });
});

describe("writeLauncherConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-launcher-config-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file (and parent dir) when absent", () => {
    const configPath = path.join(dir, "nested", "config.json");
    writeLauncherConfig("tmux", { configPath });
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
      launcher: "tmux",
    });
  });

  it("preserves sibling top-level keys", () => {
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ models: { verify: "sonnet" }, modules: ["core"] }),
    );
    writeLauncherConfig("plain", { configPath });
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
      models: { verify: "sonnet" },
      modules: ["core"],
      launcher: "plain",
    });
  });

  it("replaces a corrupt (non-object) file rather than throwing", () => {
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, "not json");
    writeLauncherConfig("tmux", { configPath });
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
      launcher: "tmux",
    });
  });
});

describe("resolveLauncherBackend", () => {
  const tmuxPresent = () => true;
  const tmuxAbsent = () => false;

  it("precedence: flag > state > config > default", () => {
    expect(
      resolveLauncherBackend({
        flag: "plain",
        state: "tmux",
        read: reader({ launcher: "tmux" }),
        tmuxOnPath: tmuxPresent,
      }),
    ).toEqual({ id: "plain", source: "flag" });
    expect(
      resolveLauncherBackend({
        state: "tmux",
        read: reader({ launcher: "plain" }),
        tmuxOnPath: tmuxPresent,
      }),
    ).toEqual({ id: "tmux", source: "state" });
    expect(
      resolveLauncherBackend({
        read: reader({ launcher: "tmux" }),
        tmuxOnPath: tmuxPresent,
      }),
    ).toEqual({ id: "tmux", source: "config" });
    expect(
      resolveLauncherBackend({ read: reader({}), tmuxOnPath: tmuxPresent }),
    ).toEqual({ id: "plain", source: "default" });
  });

  it("degrades tmux to plain with the named notice when tmux is off PATH", () => {
    expect(
      resolveLauncherBackend({ flag: "tmux", tmuxOnPath: tmuxAbsent }),
    ).toEqual({ id: "plain", source: "flag", notice: TMUX_DEGRADE_NOTICE });
    expect(
      resolveLauncherBackend({
        read: reader({ launcher: "tmux" }),
        tmuxOnPath: tmuxAbsent,
      }),
    ).toEqual({ id: "plain", source: "config", notice: TMUX_DEGRADE_NOTICE });
  });

  it("never probes tmux for a plain resolution", () => {
    let probed = false;
    const result = resolveLauncherBackend({
      flag: "plain",
      tmuxOnPath: () => {
        probed = true;
        return false;
      },
    });
    expect(result).toEqual({ id: "plain", source: "flag" });
    expect(probed).toBe(false);
  });
});

describe("resolveLauncherSelection", () => {
  it("honors a recorded config value with zero confirm calls", () => {
    let asked = 0;
    const r = resolveLauncherSelection({
      isTTY: true,
      confirm: () => {
        asked++;
        return true;
      },
      read: reader({ launcher: "plain" }),
    });
    expect(r).toEqual({ id: "plain", source: "config", shouldPersist: false });
    expect(asked).toBe(0);
  });

  it("prompts once on a TTY with nothing recorded — yes ⇒ tmux, persisted", () => {
    const prompts: string[] = [];
    const r = resolveLauncherSelection({
      isTTY: true,
      confirm: (p) => {
        prompts.push(p);
        return true;
      },
      read: reader({}),
    });
    expect(r).toEqual({ id: "tmux", source: "prompt", shouldPersist: true });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Use tmux as your pipeline launcher?");
  });

  it("prompts once on a TTY — no ⇒ plain, persisted", () => {
    expect(
      resolveLauncherSelection({
        isTTY: true,
        confirm: () => false,
        read: reader({}),
      }),
    ).toEqual({ id: "plain", source: "prompt", shouldPersist: true });
  });

  it("defaults to plain without persisting when non-TTY and nothing recorded", () => {
    expect(
      resolveLauncherSelection({
        isTTY: false,
        confirm: () => {
          throw new Error("must not prompt");
        },
        read: reader({}),
      }),
    ).toEqual({ id: "plain", source: "default", shouldPersist: false });
  });
});
