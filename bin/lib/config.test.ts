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

  it("exits 2 when the subcommand is missing", () => {
    const code = runConfigCli([]);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/subcommand is required/);
  });

  it("exits 2 on an unknown subcommand", () => {
    const code = runConfigCli(["bogus"]);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/unknown config subcommand: bogus/);
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
});
