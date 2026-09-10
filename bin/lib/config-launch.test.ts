import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConfigLaunchCli } from "./config-launch";
import type { ReadConfigFile } from "./launch-config";
import type { PipelineState } from "./state";

// Config-read seam (mirrors config-models.test.ts): feed a fixture launch
// table so the real ~/.flow/config.json is never touched.
const reader =
  (raw: unknown): ReadConfigFile =>
  () =>
    raw;

const st = (partial: Partial<PipelineState>): PipelineState =>
  ({
    slug: "s",
    phase: "planning",
    repo: "/r",
    updatedAt: "",
    ...partial,
  }) as PipelineState;

describe("runConfigLaunchCli", () => {
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

  it("renders all five launch settings with SOURCE built-in (...) when config is empty", () => {
    const code = runConfigLaunchCli([], { read: reader({}) });
    expect(code).toBe(0);
    const table = out.join("\n");
    for (const setting of [
      "effort",
      "autoMerge",
      "waitForCopilot",
      "forceResearch",
      "interviewMode",
    ]) {
      const row = table
        .split("\n")
        .find(
          (l) => l.startsWith(setting + " ") || l.startsWith(setting + "\t"),
        );
      expect(row).toBeDefined();
      expect(row).toMatch(/built-in \(/);
    }
  });

  it("renders a configured key as config (launch.<key>) with its value", () => {
    const code = runConfigLaunchCli([], {
      read: reader({ launch: { effort: "high" } }),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/effort\s+high\s+config \(launch\.effort\)/);
  });

  it("--slug overlays a per-run state override, beating config, as 'this run (fixed at launch)'", () => {
    const code = runConfigLaunchCli(["--slug", "feat"], {
      read: reader({ launch: { effort: "low" } }),
      loadState: () => st({ effort: "high" }),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(
      /effort\s+high\s+this run \(fixed at launch\)/,
    );
  });

  it("--slug with an absent state field renders built-in, never a live re-read of config (regression: value the pipeline is NOT running with)", () => {
    // `feature.ts` only persists `autoMerge` when it resolved to `false`; an
    // absent field means "resolved to the built-in ON", not "unset — go
    // check config". Config now has `launch.autoMerge: false`, which must
    // NOT leak onto this pipeline's row.
    const code = runConfigLaunchCli(["--slug", "feat"], {
      read: reader({ launch: { autoMerge: false } }),
      loadState: () => st({}),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/autoMerge\s+true\s+built-in \(/);
  });

  it("--slug with a resolved state.model wins over the live models.default", () => {
    const code = runConfigLaunchCli(["--slug", "feat", "--json"], {
      read: reader({ models: { default: "opus" } }),
      loadState: () => st({ model: "haiku" }),
    });
    expect(code).toBe(0);
    const rows = JSON.parse(out[0]);
    const modelRow = rows.find(
      (r: { setting: string }) => r.setting === "model",
    );
    expect(modelRow).toMatchObject({
      value: "haiku",
      source: "this run (fixed at launch)",
    });
  });

  it("--json emits the { setting, value, source } row shape for every row", () => {
    const code = runConfigLaunchCli(["--json"], { read: reader({}) });
    expect(code).toBe(0);
    expect(out.length).toBe(1);
    const rows = JSON.parse(out[0]);
    expect(Array.isArray(rows)).toBe(true);
    // 5 launch keys + 1 read-only model cross-reference row
    expect(rows.length).toBe(6);
    for (const r of rows) {
      expect(r).toHaveProperty("setting");
      expect(r).toHaveProperty("value");
      expect(r).toHaveProperty("source");
    }
  });

  it("an unknown --slug exits 1 and prints no table", () => {
    const code = runConfigLaunchCli(["--slug", "ghost"], {
      read: reader({}),
      loadState: () => null,
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("no feature pipeline 'ghost'");
    expect(out).toEqual([]);
  });

  it("rejects an unknown option with exit 2", () => {
    const code = runConfigLaunchCli(["--bogus"], { read: reader({}) });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("unknown option '--bogus'");
  });

  it("the read-only model row renders config (models.default) when set, built-in otherwise", () => {
    const withModel = runConfigLaunchCli(["--json"], {
      read: reader({ models: { default: "opus" } }),
    });
    expect(withModel).toBe(0);
    const rowsWithModel = JSON.parse(out[0]);
    const modelRow = rowsWithModel.find(
      (r: { setting: string }) => r.setting === "model",
    );
    expect(modelRow).toMatchObject({
      value: "opus",
      source: "config (models.default)",
    });

    out.length = 0;
    const withoutModel = runConfigLaunchCli(["--json"], { read: reader({}) });
    expect(withoutModel).toBe(0);
    const rowsWithoutModel = JSON.parse(out[0]);
    const bareModelRow = rowsWithoutModel.find(
      (r: { setting: string }) => r.setting === "model",
    );
    expect(bareModelRow.source).toMatch(/^built-in/);
  });

  it("has no copilotReview row", () => {
    const code = runConfigLaunchCli(["--json"], { read: reader({}) });
    expect(code).toBe(0);
    const rows = JSON.parse(out[0]);
    expect(
      rows.some((r: { setting: string }) => r.setting === "copilotReview"),
    ).toBe(false);
  });

  it("the footer states a config edit affects the next launch only", () => {
    const code = runConfigLaunchCli([], { read: reader({}) });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/NEXT launch only/);
  });

  it("warns on a rejected launch.<key> config value instead of silently rendering built-in", () => {
    const code = runConfigLaunchCli([], {
      read: reader({ launch: { effort: "highest" } }),
    });
    expect(code).toBe(0);
    expect(err.join("\n")).toMatch(/launch\.effort.*not valid/);
    expect(out.join("\n")).toMatch(/effort\s+\(none\)\s+built-in \(/);
  });

  it("reads the config file only once per invocation", () => {
    let calls = 0;
    const read: ReadConfigFile = () => {
      calls += 1;
      return { launch: { effort: "high" }, models: { default: "opus" } };
    };
    const code = runConfigLaunchCli([], { read });
    expect(code).toBe(0);
    expect(calls).toBe(1);
  });
});
