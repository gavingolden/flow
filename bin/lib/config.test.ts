import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConfigCli } from "./config";
import type { ReadConfigFile } from "./models-config";

// Config-read seam (mirrors config-models.test.ts): feed a fixture models
// table so the real ~/.flow/config.json is never touched.
const reader =
  (raw: unknown): ReadConfigFile =>
  () =>
    raw;

describe("runConfigCli", () => {
  let logSpy!: ReturnType<typeof vi.spyOn>;
  let errSpy!: ReturnType<typeof vi.spyOn>;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      out.push(String(m ?? ""));
    });
    errSpy = vi.spyOn(console, "error").mockImplementation((m?: unknown) => {
      err.push(String(m ?? ""));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("bare `flow config` renders the aggregate view and exits 0", () => {
    const code = runConfigCli([], { read: reader(undefined) });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.length).toBeGreaterThan(0);
    expect(out.join("\n")).toContain(
      "resolved at each sub-agent spawn — a config edit changes the next spawn",
    );
  });

  it("exits 2 on an unknown subcommand, naming the four subcommands", () => {
    const code = runConfigCli(["bogus"]);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/unknown config subcommand: bogus/);
    // "launch" alone is a substring of the pre-existing "launcher"; anchor
    // to the whole usage string so this can actually fail if `launch` is
    // dropped from it.
    expect(err.join("\n")).toContain(
      "usage: flow config <all|models|launcher|launch>",
    );
  });

  it("routes `all` to runConfigAllCli", () => {
    const code = runConfigCli(["all", "--json"], {
      read: reader(undefined),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.groups.map((g: { group: string }) => g.group)).toEqual([
      "models",
      "launch",
      "settings",
    ]);
  });

  it("exits 0 and prints help for --help at verb position", () => {
    const code = runConfigCli(["--help"]);
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/flow config/);
  });

  it("routes `models` to runConfigModelsCli", () => {
    const code = runConfigCli(["models"], {
      read: reader({ models: {} }),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/PHASE\s+MODEL\s+SOURCE\s+EFFORT/);
  });

  it("routes `launcher` to runConfigLauncherCli", () => {
    const code = runConfigCli(["launcher", "get"], {
      read: reader({ launcher: "tmux" }),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/tmux/);
  });

  it("routes `launch` to runConfigLaunchCli", () => {
    const code = runConfigCli(["launch"], {
      read: reader({}),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/SETTING\s+VALUE\s+SOURCE/);
  });
});
