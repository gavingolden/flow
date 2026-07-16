import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConfigLauncherCli } from "./config-launcher";
import type { ReadConfigFile } from "./modules-config";

const reader =
  (raw: unknown): ReadConfigFile =>
  () =>
    raw;

describe("runConfigLauncherCli", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("get prints the recorded value", () => {
    const code = runConfigLauncherCli(["get"], {
      read: reader({ launcher: "tmux" }),
    });
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith("tmux");
  });

  it("get (and bare invocation) prints 'plain (default)' when nothing is recorded", () => {
    expect(runConfigLauncherCli(["get"], { read: reader({}) })).toBe(0);
    expect(runConfigLauncherCli([], { read: reader({}) })).toBe(0);
    expect(logSpy).toHaveBeenNthCalledWith(1, "plain (default)");
    expect(logSpy).toHaveBeenNthCalledWith(2, "plain (default)");
  });

  it("set validates and persists, preserving sibling keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-config-launcher-"));
    try {
      const configPath = path.join(dir, "config.json");
      fs.writeFileSync(configPath, JSON.stringify({ modules: ["core"] }));
      const code = runConfigLauncherCli(["set", "tmux"], { configPath });
      expect(code).toBe(0);
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
        modules: ["core"],
        launcher: "tmux",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("set rejects an invalid value with exit 2", () => {
    expect(runConfigLauncherCli(["set", "screen"], { read: reader({}) })).toBe(
      2,
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("invalid launcher 'screen'"),
    );
  });

  it("set with no value is a usage error", () => {
    expect(runConfigLauncherCli(["set"], { read: reader({}) })).toBe(2);
  });

  it("an unknown subcommand is a usage error", () => {
    expect(runConfigLauncherCli(["frobnicate"], { read: reader({}) })).toBe(2);
  });
});
