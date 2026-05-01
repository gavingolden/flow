import { describe, expect, it } from "vitest";
import { decideExitCode, renderReport, REGRESSION_TOLERANCE } from "./eval-report";
import type { RunResult } from "./eval-runner";
import type { Config } from "./eval-config";

function runResult(overrides: Partial<RunResult> & { fixture: string; config: Config; pass: boolean }): RunResult {
  const base: RunResult = {
    fixture: overrides.fixture,
    config: overrides.config,
    pass: overrides.pass,
    hard: { pass: overrides.pass, failures: [] },
    soft: {
      pass: overrides.pass,
      verdicts: [],
      judgeCost: { usd: 0, authoritative: true, tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }, perModel: {} },
      rawStream: "",
      rawResponse: "",
    },
    implCost: { usd: 0, authoritative: true, tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }, perModel: {} },
    durationMs: 0,
    artefactsDir: "/tmp",
  };
  return { ...base, ...overrides };
}

describe("renderReport", () => {
  it("renders side-by-side columns when both configs are present", () => {
    const out = renderReport({
      fixtures: ["01"],
      results: [
        runResult({ fixture: "01", config: "defaults", pass: true, implCost: cost(0.01) }),
        runResult({ fixture: "01", config: "pr7", pass: true, implCost: cost(0.005) }),
      ],
    });
    expect(out).toContain("defaults pass");
    expect(out).toContain("pr7 pass");
    expect(out).toContain("PASS");
    expect(out).toContain("$0.0100");
    expect(out).toContain("$0.0050");
    expect(out).toContain("-$0.0050");
    expect(out).toContain("OK:");
  });

  it("flags regression when pr7 fails more than defaults by more than tolerance", () => {
    const out = renderReport({
      fixtures: ["01", "02", "03"],
      results: [
        runResult({ fixture: "01", config: "defaults", pass: true }),
        runResult({ fixture: "02", config: "defaults", pass: true }),
        runResult({ fixture: "03", config: "defaults", pass: true }),
        runResult({ fixture: "01", config: "pr7", pass: true }),
        runResult({ fixture: "02", config: "pr7", pass: false }),
        runResult({ fixture: "03", config: "pr7", pass: false }),
      ],
    });
    expect(out).toContain("REGRESSION");
    expect(out).toContain(`tolerance: ${REGRESSION_TOLERANCE}`);
  });

  it("calls out PR 7 improvements", () => {
    const out = renderReport({
      fixtures: ["01"],
      results: [
        runResult({ fixture: "01", config: "defaults", pass: false }),
        runResult({ fixture: "01", config: "pr7", pass: true }),
      ],
    });
    expect(out).toContain("PR 7 IMPROVES");
  });

  it("renders only one column when --config is set", () => {
    const out = renderReport({
      fixtures: ["01"],
      results: [runResult({ fixture: "01", config: "pr7", pass: true })],
    });
    expect(out).not.toContain("defaults pass");
    expect(out).toContain("pr7 pass");
    expect(out).not.toContain("REGRESSION");
    expect(out).not.toContain("OK:");
  });

  it("appends failed soft criteria with the judge's reason", () => {
    const r = runResult({ fixture: "01", config: "pr7", pass: false });
    r.soft.verdicts = [
      { criterion: "tests cover the flag", verdict: "no", reason: "no test file present" },
    ];
    r.soft.pass = false;
    const out = renderReport({ fixtures: ["01"], results: [r] });
    expect(out).toContain("Failed soft criteria");
    expect(out).toContain("tests cover the flag");
    expect(out).toContain("no test file present");
  });

  it("includes the aggregate judge cost line", () => {
    const r = runResult({ fixture: "01", config: "pr7", pass: true });
    r.soft.judgeCost.usd = 0.123;
    const out = renderReport({ fixtures: ["01"], results: [r] });
    expect(out).toContain("JUDGE COST: $0.1230");
  });
});

describe("decideExitCode", () => {
  it("returns 0 when only one config ran", () => {
    expect(
      decideExitCode([runResult({ fixture: "01", config: "pr7", pass: false })]),
    ).toBe(0);
  });

  it("returns 0 when pr7 regresses within tolerance", () => {
    expect(
      decideExitCode([
        runResult({ fixture: "01", config: "defaults", pass: true }),
        runResult({ fixture: "01", config: "pr7", pass: false }),
      ]),
    ).toBe(0);
  });

  it("returns 1 when pr7 regresses past tolerance", () => {
    expect(
      decideExitCode([
        runResult({ fixture: "01", config: "defaults", pass: true }),
        runResult({ fixture: "02", config: "defaults", pass: true }),
        runResult({ fixture: "01", config: "pr7", pass: false }),
        runResult({ fixture: "02", config: "pr7", pass: false }),
      ]),
    ).toBe(1);
  });

  it("returns 0 when pr7 improves on defaults", () => {
    expect(
      decideExitCode([
        runResult({ fixture: "01", config: "defaults", pass: false }),
        runResult({ fixture: "01", config: "pr7", pass: true }),
      ]),
    ).toBe(0);
  });
});

function cost(usd: number) {
  return {
    usd,
    authoritative: true,
    tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    perModel: {},
  };
}
