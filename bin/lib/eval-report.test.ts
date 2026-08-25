import { describe, expect, it } from "vitest";
import {
  buildReport,
  compareReports,
  foldScenario,
  renderComparison,
  renderSummary,
  scoreRun,
  validateReport,
  type EvalReport,
  type GradeResult,
  type RunRecord,
  type ScenarioRecord,
} from "./eval-report";
import type { SuiteSpec } from "./eval-suite";

function grade(overrides: Partial<GradeResult> = {}): GradeResult {
  return { id: "g", kind: "file", gate: true, pass: true, ...overrides };
}

const runner: EvalReport["runner"] = {
  name: "flow-eval-headless",
  model: "sonnet",
  claudeVersion: "2.1.239",
};
const tree = { gitHead: "abc123", dirty: false };

function makeReport(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    schemaVersion: 1,
    runner,
    tree,
    suite: "s",
    candidate: "c",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:01:00Z",
    scenarios: [],
    summary: {
      score: 1,
      scenarios: 0,
      passed: 0,
      failed: 0,
      errored: 0,
      costUsd: 0,
    },
    ...overrides,
  };
}

describe("scoreRun", () => {
  it("ignores informational (gate: false) graders", () => {
    const grades = [
      grade({ pass: true }),
      grade({ id: "g2", gate: false, pass: false }),
    ];
    expect(scoreRun(grades)).toBe(1);
  });

  it("returns passed / total among gate graders", () => {
    const grades = [grade({ pass: true }), grade({ id: "g2", pass: false })];
    expect(scoreRun(grades)).toBe(0.5);
  });

  it("returns 1 when there are zero gate graders", () => {
    expect(scoreRun([grade({ gate: false })])).toBe(1);
  });
});

describe("foldScenario", () => {
  const run = (overrides: Partial<RunRecord>): RunRecord => ({
    run: 1,
    status: "pass",
    score: 1,
    grades: [],
    metrics: {},
    ...overrides,
  });

  it("computes median/min/max per metric", () => {
    const runs: RunRecord[] = [
      run({
        run: 1,
        metrics: {
          "transcript.finalContextTokens": { value: 100, direction: "lower" },
        },
      }),
      run({
        run: 2,
        metrics: {
          "transcript.finalContextTokens": { value: 200, direction: "lower" },
        },
      }),
      run({
        run: 3,
        metrics: {
          "transcript.finalContextTokens": { value: 150, direction: "lower" },
        },
      }),
    ];
    const record = foldScenario("s1", "S1", runs);
    expect(record.metrics["transcript.finalContextTokens"]).toEqual({
      median: 150,
      min: 100,
      max: 200,
      direction: "lower",
      values: [100, 200, 150],
    });
  });

  it("all pass -> pass status; mean of run scores", () => {
    const runs = [run({ run: 1, score: 1 }), run({ run: 2, score: 0.5 })];
    const record = foldScenario("s1", "S1", runs);
    expect(record.status).toBe("pass");
  });

  it("any error with no pass -> error status", () => {
    const runs = [
      run({ status: "error", score: 0 }),
      run({ status: "error", score: 0 }),
    ];
    const record = foldScenario("s1", "S1", runs);
    expect(record.status).toBe("error");
  });

  it("error mixed with a pass -> fail status", () => {
    const runs = [
      run({ status: "error", score: 0 }),
      run({ status: "pass", score: 1 }),
    ];
    const record = foldScenario("s1", "S1", runs);
    expect(record.status).toBe("fail");
  });

  it("all skipped -> skipped status", () => {
    const runs = [run({ status: "skipped", score: 0 })];
    const record = foldScenario("s1", "S1", runs);
    expect(record.status).toBe("skipped");
  });
});

describe("validateReport", () => {
  it("accepts a well-formed report", () => {
    expect(validateReport(makeReport()).ok).toBe(true);
  });

  it("rejects a bad schemaVersion", () => {
    expect(validateReport(makeReport({ schemaVersion: 2 as 1 })).ok).toBe(
      false,
    );
  });

  it("rejects malformed scenarios", () => {
    const bad = makeReport({
      scenarios: [{ id: "x" } as unknown as ScenarioRecord],
    });
    expect(validateReport(bad).ok).toBe(false);
  });
});

describe("renderSummary", () => {
  it("renders scenario rows with metrics beside the score", () => {
    const scenario: ScenarioRecord = {
      id: "s1",
      title: "S1",
      status: "pass",
      score: 1,
      runs: [
        {
          run: 1,
          status: "pass",
          score: 1,
          grades: [],
          metrics: {},
          costUsd: 0.5,
        },
      ],
      metrics: {
        "transcript.finalContextTokens": {
          median: 1000,
          min: 900,
          max: 1100,
          direction: "lower",
          values: [1000],
        },
      },
    };
    const report = buildReport({
      suite: {
        schemaVersion: 1,
        id: "s",
        candidate: "c",
        description: "d",
        scenarios: ["s1"],
      },
      scenarios: [scenario],
      runner,
      tree,
      startedAt: "t0",
      finishedAt: "t1",
    });
    const md = renderSummary(report);
    expect(md).toContain("s1");
    expect(md).toContain("1000");
    expect(md).toContain("Suite score");
  });

  it("renders the skip notice for a skipped report", () => {
    const report = makeReport({
      skipped: {
        reason: "claude-not-on-path",
        notice: "claude is not on PATH",
      },
    });
    const md = renderSummary(report);
    expect(md).toContain("Skipped");
    expect(md).toContain("claude is not on PATH");
  });
});

describe("compareReports", () => {
  function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  function scenarioWith(
    score: number,
    metricValues: number[],
    direction: "lower" | "higher" = "lower",
  ): ScenarioRecord {
    return {
      id: "s1",
      title: "S1",
      status: "pass",
      score,
      runs: metricValues.map((v, i) => ({
        run: i + 1,
        status: "pass",
        score,
        grades: [],
        metrics: { "transcript.finalContextTokens": { value: v, direction } },
      })),
      metrics: {
        "transcript.finalContextTokens": {
          median: median(metricValues),
          min: Math.min(...metricValues),
          max: Math.max(...metricValues),
          direction,
          values: metricValues,
        },
      },
    };
  }

  it("marks worse past tolerance, honouring direction", () => {
    const base = makeReport({ scenarios: [scenarioWith(1, [1000])] });
    const cand = makeReport({ scenarios: [scenarioWith(1, [1300])] }); // +30%, lower-is-better -> worse
    const cmp = compareReports(base, cand, { tolerance: 0.1 });
    expect(cmp.scenarios[0].metrics[0].verdict).toBe("worse");
    expect(cmp.regressions).toContain("s1: transcript.finalContextTokens");
  });

  it("marks better when direction-favourable beyond tolerance", () => {
    const base = makeReport({ scenarios: [scenarioWith(1, [1000])] });
    const cand = makeReport({ scenarios: [scenarioWith(1, [700])] }); // -30%, lower-is-better -> better
    const cmp = compareReports(base, cand, { tolerance: 0.1 });
    expect(cmp.scenarios[0].metrics[0].verdict).toBe("better");
  });

  it("marks noisy instead of worse when base spread exceeds tolerance", () => {
    const base = makeReport({ scenarios: [scenarioWith(1, [700, 1300])] }); // wide spread around median 1000
    const cand = makeReport({ scenarios: [scenarioWith(1, [1400])] });
    const cmp = compareReports(base, cand, { tolerance: 0.1 });
    expect(cmp.scenarios[0].metrics[0].verdict).toBe("noisy");
  });

  it("flags environmentMismatch and pushes a warning on model/claudeVersion drift", () => {
    const base = makeReport({ runner: { ...runner, model: "sonnet" } });
    const cand = makeReport({ runner: { ...runner, model: "haiku" } });
    const cmp = compareReports(base, cand);
    expect(cmp.environmentMismatch).toBe(true);
    expect(cmp.warnings.some((w) => w.includes("runner mismatch"))).toBe(true);
  });

  it("flags environmentMismatch and pushes a warning on effort drift", () => {
    const base = makeReport({ runner: { ...runner, effort: "medium" } });
    const cand = makeReport({ runner: { ...runner, effort: "high" } });
    const cmp = compareReports(base, cand);
    expect(cmp.environmentMismatch).toBe(true);
    expect(
      cmp.warnings.some(
        (w) => w.includes("runner mismatch") && w.includes("effort"),
      ),
    ).toBe(true);
  });

  it("regresses on any candidate score drop", () => {
    const base = makeReport({ scenarios: [scenarioWith(1, [1000])] });
    const cand = makeReport({
      scenarios: [{ ...scenarioWith(1, [1000]), score: 0.5 }],
    });
    const cmp = compareReports(base, cand);
    expect(cmp.regressions).toContain("s1: score");
  });

  it("warns when a scenario is present in only one report", () => {
    const base = makeReport({ scenarios: [scenarioWith(1, [1000])] });
    const cand = makeReport({ scenarios: [] });
    const cmp = compareReports(base, cand);
    expect(cmp.warnings.some((w) => w.includes("only one report"))).toBe(true);
  });
});

describe("renderComparison", () => {
  it("renders one table per scenario plus regressions/warnings sections", () => {
    const base = makeReport({
      scenarios: [
        {
          id: "s1",
          title: "S1",
          status: "pass",
          score: 1,
          runs: [],
          metrics: {
            "transcript.finalContextTokens": {
              median: 1000,
              min: 1000,
              max: 1000,
              direction: "lower",
              values: [1000],
            },
          },
        },
      ],
    });
    const cand = makeReport({
      scenarios: [
        {
          id: "s1",
          title: "S1",
          status: "pass",
          score: 1,
          runs: [],
          metrics: {
            "transcript.finalContextTokens": {
              median: 1300,
              min: 1300,
              max: 1300,
              direction: "lower",
              values: [1300],
            },
          },
        },
      ],
    });
    const cmp = compareReports(base, cand);
    const md = renderComparison(cmp);
    expect(md).toContain("s1");
    expect(md).toContain("Regressions");
    expect(md).toContain("Warnings");
  });
});
