import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConfigAllCli } from "./config-all";
import type { ReadConfigFile } from "./models-config";

describe("runConfigAllCli", () => {
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

  it("--json emits three timing groups", () => {
    const code = runConfigAllCli(["--json"], { read: () => undefined });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.groups.map((g: { group: string }) => g.group)).toEqual([
      "models",
      "launch",
      "settings",
    ]);
    for (const g of parsed.groups) {
      expect(typeof g.timing).toBe("string");
      expect(g.timing.length).toBeGreaterThan(0);
      expect(Array.isArray(g.rows)).toBe(true);
      expect(g.rows.length).toBeGreaterThan(0);
    }
  });

  it("the text render carries the three verbatim section captions", () => {
    const code = runConfigAllCli([], { read: () => undefined });
    expect(code).toBe(0);
    const table = out.join("\n");
    expect(table).toContain(
      "resolved at each sub-agent spawn — a config edit changes the next spawn",
    );
    expect(table).toContain(
      "fixed when a pipeline launches — a config edit changes only the next launch",
    );
    expect(table).toContain(
      "read each time a helper runs — a config edit takes effect on the next invocation",
    );
  });

  it("previously invisible settings (e.g. epic.maxParallel) appear in the settings section", () => {
    const code = runConfigAllCli([], { read: () => undefined });
    expect(code).toBe(0);
    const table = out.join("\n");
    expect(table).toContain("epic.maxParallel");
    expect(table).toContain("bots.copilot");
  });

  it("--slug naming a pipeline with no state file exits 1 with no table", () => {
    const code = runConfigAllCli(["--slug", "ghost"], {
      read: () => undefined,
      loadState: () => null,
    });
    expect(code).not.toBe(0);
    expect(err.join("\n")).toContain("no feature pipeline 'ghost'");
    expect(out).toEqual([]);
  });

  it("reads the config file exactly once per invocation", () => {
    let calls = 0;
    const read: ReadConfigFile = () => {
      calls++;
      return { models: { review: "opus" } };
    };
    const code = runConfigAllCli([], { read });
    expect(code).toBe(0);
    expect(calls).toBe(1);
  });

  it("rejects an unknown option with exit 2", () => {
    const code = runConfigAllCli(["--bogus"], { read: () => undefined });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("unknown option '--bogus'");
  });
});
