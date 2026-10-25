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

  it("counts a withOnly gate in the 'with' arm (default) same as any other gate", () => {
    const grades = [
      grade({ id: "plugin-loaded", pass: false }),
      grade({ id: "g2", pass: true }),
    ];
    expect(scoreRun(grades, "with", new Set(["plugin-loaded"]))).toBe(0.5);
    // Omitting arm/withOnlyIds entirely is the same as explicit "with".
    expect(scoreRun(grades)).toBe(0.5);
  });

  it("skips a withOnly gate entirely (both numerator and denominator) in the 'without' arm", () => {
    const grades = [
      grade({ id: "plugin-loaded", pass: false }),
      grade({ id: "g2", pass: true }),
    ];
    // Without the withOnly exclusion this would be 0.5 (1/2); with it,
    // the failing plugin-loaded gate is dropped and only g2 (passing)
    // remains, so the score is 1 (1/1) — never a fixed near-zero
    // constant purely because the plugin is absent.
    expect(scoreRun(grades, "without", new Set(["plugin-loaded"]))).toBe(1);
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

  it("accepts a skipped report with reason flow-agents-missing", () => {
    const r = makeReport({
      skipped: { reason: "flow-agents-missing", notice: "missing flow-x.md" },
    });
    expect(validateReport(r).ok).toBe(true);
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

  it("accepts a report with no ablation field at all (additive, optional)", () => {
    const scenario: ScenarioRecord = {
      id: "s1",
      title: "S1",
      status: "pass",
      score: 1,
      runs: [],
      metrics: {},
    };
    expect(validateReport(makeReport({ scenarios: [scenario] })).ok).toBe(true);
  });

  it("accepts a well-formed ablation field, and a well-formed runner.childArgvDigest/summary.scoreDelta", () => {
    const scenario: ScenarioRecord = {
      id: "s1",
      title: "S1",
      status: "pass",
      score: 1,
      runs: [],
      metrics: {},
      ablation: {
        with: { score: 1, metrics: {}, avgCostUsd: 0.1 },
        without: { score: 0.5, metrics: {}, avgCostUsd: 0.08 },
        scoreDelta: 0.5,
        metricDeltas: { "transcript.finalContextTokens": -200 },
      },
    };
    const report = makeReport({
      runner: { ...runner, childArgvDigest: "abcd1234" },
      scenarios: [scenario],
      summary: {
        score: 1,
        scenarios: 1,
        passed: 1,
        failed: 0,
        errored: 0,
        costUsd: 0.1,
        scoreDelta: 0.5,
      },
    });
    expect(validateReport(report).ok).toBe(true);
  });

  it("rejects a malformed ablation object", () => {
    const scenario = {
      id: "s1",
      title: "S1",
      status: "pass",
      score: 1,
      runs: [],
      metrics: {},
      ablation: { with: { score: "not-a-number" } },
    } as unknown as ScenarioRecord;
    expect(validateReport(makeReport({ scenarios: [scenario] })).ok).toBe(
      false,
    );
  });

  it("rejects a non-string runner.childArgvDigest", () => {
    const report = makeReport({
      runner: { ...runner, childArgvDigest: 123 as unknown as string },
    });
    expect(validateReport(report).ok).toBe(false);
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

  // OFF-LIMITS invariant (docs/eval/baseline/README.md:14-19 forbids a
  // feature PR regenerating the committed *.summary.md files): a report
  // whose scenarios carry no `ablation` field must render BYTE-IDENTICAL
  // output to before ablation existed — asserted here against a full
  // hand-computed expected string, not a substring check, so a stray
  // trailing character or reordered line would fail this test too.
  it("renders byte-identical output when no scenario carries an ablation field", () => {
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
    const expected = [
      "# flow-eval — s",
      "",
      "Candidate: `c` · Tree: `abc123` · Model: `sonnet` · Effort: `n/a`",
      "",
      "| Scenario | Status | Score | Runs | finalContextTokens | costUsd | numTurns | subagentsSpawned | durationMs |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      "| s1 | pass | 1 | 1 | 1000 | 0.500 | n/a | n/a | n/a |",
      "",
      "Suite score: **1** (1/1 passed, 0 failed, 0 errored, $0.500)",
    ].join("\n");
    expect(renderSummary(report)).toBe(expected);
    expect(report.summary.scoreDelta).toBeUndefined();
  });

  it("renders an additional 'Plugin ablation' section, leading with per-metric deltas, only when a scenario carries ablation", () => {
    const scenario: ScenarioRecord = {
      id: "s1",
      title: "S1",
      status: "pass",
      score: 0.9,
      runs: [],
      metrics: {},
      ablation: {
        with: {
          score: 0.9,
          metrics: {
            "transcript.finalContextTokens": {
              median: 800,
              min: 800,
              max: 800,
              direction: "lower",
              values: [800],
            },
          },
          avgCostUsd: 0.05,
        },
        without: {
          score: 0.4,
          metrics: {
            "transcript.finalContextTokens": {
              median: 1000,
              min: 1000,
              max: 1000,
              direction: "lower",
              values: [1000],
            },
          },
          avgCostUsd: 0.09,
        },
        scoreDelta: 0.5,
        metricDeltas: { "transcript.finalContextTokens": -200 },
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
      summaryScoreDelta: 0.5,
    });
    const md = renderSummary(report);
    expect(md).toContain("## Plugin ablation");
    // Headline rule: the per-metric delta table appears before the
    // scoreDelta line, never as the sole/primary number.
    const ablationIdx = md.indexOf("## Plugin ablation");
    const metricRowIdx = md.indexOf(
      "transcript.finalContextTokens",
      ablationIdx,
    );
    const scoreDeltaIdx = md.indexOf("Suite scoreDelta");
    expect(metricRowIdx).toBeGreaterThan(ablationIdx);
    expect(scoreDeltaIdx).toBeGreaterThan(metricRowIdx);
    expect(md).toContain("costUsd");
  });
});

describe("compareReports", () => {
  const COST = "result.total_cost_usd";
  const DURATION = "result.duration_ms";

  function metricsScenario(
    metrics: Record<string, number[]>,
    opts: {
      score?: number;
      statuses?: RunRecord["status"][];
      direction?: "lower" | "higher";
    } = {},
  ): ScenarioRecord {
    const score = opts.score ?? 1;
    const names = Object.keys(metrics);
    const statuses = opts.statuses ?? ["pass"];
    return {
      id: "s1",
      title: "S1",
      status: "pass",
      score,
      runs: statuses.map((status, i) => ({
        run: i + 1,
        status,
        score,
        grades: [],
        metrics: {},
      })),
      metrics: Object.fromEntries(
        names.map((n) => {
          const v = metrics[n];
          const sorted = [...v].sort((a, b) => a - b);
          return [
            n,
            {
              median: median(v),
              min: sorted[0],
              max: sorted[sorted.length - 1],
              direction: opts.direction ?? ("lower" as const),
              values: v,
            },
          ];
        }),
      ),
    };
  }

  function cmpOf(
    base: Record<string, number[]>,
    cand: Record<string, number[]>,
    opts: Parameters<typeof compareReports>[2] = {},
  ) {
    return compareReports(
      makeReport({ scenarios: [metricsScenario(base)] }),
      makeReport({ scenarios: [metricsScenario(cand)] }),
      opts,
    );
  }

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

  it("marks noisy instead of worse when the shift is within the base spread", () => {
    const base = makeReport({ scenarios: [scenarioWith(1, [700, 1300])] }); // wide spread around median 1000
    const cand = makeReport({ scenarios: [scenarioWith(1, [1400])] });
    const cmp = compareReports(base, cand, { tolerance: 0.1 });
    expect(cmp.scenarios[0].metrics[0].verdict).toBe("noisy");
  });

  describe("gate policy", () => {
    it("cost +30% is worse but non-failing; +60% is a regression", () => {
      const mild = cmpOf({ [COST]: [1] }, { [COST]: [1.3] });
      expect(mild.scenarios[0].metrics[0].verdict).toBe("worse");
      expect(mild.scenarios[0].metrics[0].gateBand).toBe(0.5);
      expect(mild.regressions).toEqual([]);
      expect(mild.nonFailingShifts).toEqual([`s1: ${COST}`]);
      const big = cmpOf({ [COST]: [1] }, { [COST]: [1.6] });
      expect(big.regressions).toEqual([`s1: ${COST}`]);
      expect(big.nonFailingShifts).toEqual([]);
    });

    it("an ungated metric is recorded with no band and never regresses", () => {
      const cmp = cmpOf({ [DURATION]: [1000] }, { [DURATION]: [1500] });
      expect(cmp.scenarios[0].metrics[0].verdict).toBe("worse");
      expect(cmp.scenarios[0].metrics[0].gateBand).toBeNull();
      expect(cmp.regressions).toEqual([]);
      expect(cmp.nonFailingShifts).toEqual([`s1: ${DURATION}`]);
    });

    it("a null-band default gate uses the run-wide tolerance", () => {
      const cmp = cmpOf(
        { "transcript.finalContextTokens": [1000] },
        { "transcript.finalContextTokens": [1300] },
        { tolerance: 0.2 },
      );
      expect(cmp.scenarios[0].metrics[0].gateBand).toBe(0.2);
      expect(cmp.regressions).toEqual(["s1: transcript.finalContextTokens"]);
    });

    it("base spread of 11% does not make a +560% shift noisy", () => {
      const cmp = cmpOf({ [COST]: [0.95, 1, 1.06] }, { [COST]: [6.6] });
      expect(cmp.scenarios[0].metrics[0].verdict).toBe("worse");
      expect(cmp.regressions).toEqual([`s1: ${COST}`]);
    });

    it("a null override re-bands a default gated metric to --tolerance", () => {
      const cmp = cmpOf(
        { [COST]: [1] },
        { [COST]: [1.3] },
        { gateMetrics: { [COST]: null } },
      );
      expect(cmp.scenarios[0].metrics[0].gateBand).toBe(0.1);
      expect(cmp.regressions).toEqual([`s1: ${COST}`]);
    });

    it("a gated higher-is-better metric regresses on a drop past the band", () => {
      const M = "custom.hits";
      const run = (cand: number) =>
        compareReports(
          makeReport({
            scenarios: [
              metricsScenario({ [M]: [10] }, { direction: "higher" }),
            ],
          }),
          makeReport({
            scenarios: [
              metricsScenario({ [M]: [cand] }, { direction: "higher" }),
            ],
          }),
          { gateMetrics: { [M]: 0.2 } },
        );
      expect(run(5).regressions).toEqual([`s1: ${M}`]);
      expect(run(9).regressions).toEqual([]);
    });

    it("--gate-metric style override gates an otherwise ungated metric", () => {
      const cmp = cmpOf(
        { [DURATION]: [1000] },
        { [DURATION]: [1500] },
        { gateMetrics: { [DURATION]: null } },
      );
      expect(cmp.regressions).toEqual([`s1: ${DURATION}`]);
      expect(cmp.nonFailingShifts).toEqual([]);
      expect(cmp.unknownGateMetrics).toEqual([]);
    });

    it("reports a caller-supplied gate metric found in neither report", () => {
      const cmp = cmpOf(
        { [DURATION]: [1000] },
        { [DURATION]: [1000] },
        { gateMetrics: { "result.duration": null } },
      );
      expect(cmp.unknownGateMetrics).toEqual(["result.duration"]);
    });

    it("default gated metrics absent from both reports are not unknown", () => {
      const cmp = cmpOf({ [DURATION]: [1] }, { [DURATION]: [1] });
      expect(cmp.unknownGateMetrics).toEqual([]);
    });

    it("regresses when a gated metric present in base is missing from the candidate", () => {
      const cmp = cmpOf({ [COST]: [1], [DURATION]: [1] }, { [DURATION]: [1] });
      expect(cmp.regressions).toEqual([`s1: ${COST} missing from candidate`]);
    });

    it("does not regress when an ungated metric is missing from the candidate", () => {
      const cmp = cmpOf({ [DURATION]: [1], [COST]: [1] }, { [COST]: [1] });
      expect(cmp.regressions).toEqual([]);
    });

    it("a gated metric with base median 0 that rises is a regression", () => {
      const cmp = cmpOf({ [COST]: [0] }, { [COST]: [0.2] });
      expect(cmp.scenarios[0].metrics[0].pct).toBeNull();
      expect(cmp.regressions).toEqual([`s1: ${COST}`]);
    });

    it("counts non-passing candidate runs, excluding the without arm", () => {
      const cand = metricsScenario(
        {},
        { score: 0.5, statuses: ["pass", "fail"] },
      );
      cand.runs.push({
        ...cand.runs[0],
        run: 3,
        arm: "without",
        status: "fail",
      });
      const cmp = compareReports(
        makeReport({ scenarios: [metricsScenario({})] }),
        makeReport({ scenarios: [cand] }),
      );
      expect(cmp.scenarios[0].candidateRuns).toEqual({
        total: 2,
        notPassing: 1,
      });
    });
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

  it("flags environmentMismatch and pushes a warning on autocompact drift", () => {
    const base = makeReport({ runner: { ...runner, autocompact: "auto" } });
    const cand = makeReport({ runner: { ...runner, autocompact: "150k" } });
    const cmp = compareReports(base, cand);
    expect(cmp.environmentMismatch).toBe(true);
    expect(
      cmp.warnings.some(
        (w) => w.includes("runner mismatch") && w.includes("autocompact"),
      ),
    ).toBe(true);
  });

  it("does not warn when autocompact is identical between reports", () => {
    const base = makeReport({ runner: { ...runner, autocompact: "150k" } });
    const cand = makeReport({ runner: { ...runner, autocompact: "150k" } });
    const cmp = compareReports(base, cand);
    expect(cmp.warnings.some((w) => w.includes("autocompact"))).toBe(false);
  });

  it("regresses on any candidate score drop", () => {
    const base = makeReport({ scenarios: [scenarioWith(1, [1000])] });
    const cand = makeReport({
      scenarios: [{ ...scenarioWith(1, [1000]), score: 0.5 }],
    });
    const cmp = compareReports(base, cand);
    expect(cmp.regressions).toContain("s1: score");
  });

  it("regresses on a base-only scenario and only warns on a candidate-only one", () => {
    const withS1 = makeReport({ scenarios: [scenarioWith(1, [1000])] });
    const empty = makeReport({ scenarios: [] });
    const baseOnly = compareReports(withS1, empty);
    expect(baseOnly.regressions).toContain("s1: missing from candidate");
    const candOnly = compareReports(empty, withS1);
    expect(candOnly.regressions).toEqual([]);
    expect(candOnly.warnings.some((w) => w.includes("'s1'"))).toBe(true);
  });

  it("flags environmentMismatch and warns on childArgvDigest drift between two reports", () => {
    const base = makeReport({
      runner: { ...runner, childArgvDigest: "digest-a" },
    });
    const cand = makeReport({
      runner: { ...runner, childArgvDigest: "digest-b" },
    });
    const cmp = compareReports(base, cand);
    expect(cmp.environmentMismatch).toBe(true);
    expect(
      cmp.warnings.some(
        (w) => w.includes("runner mismatch") && w.includes("childArgvDigest"),
      ),
    ).toBe(true);
  });

  it("does not flag childArgvDigest drift when either report lacks a digest (nothing to compare)", () => {
    const base = makeReport(); // no childArgvDigest at all
    const cand = makeReport({
      runner: { ...runner, childArgvDigest: "digest-b" },
    });
    const cmp = compareReports(base, cand);
    expect(cmp.warnings.some((w) => w.includes("childArgvDigest"))).toBe(false);
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

  it("renders the Gated column, Non-failing shifts section, and not-passing note", () => {
    const base = makeReport({
      scenarios: [
        {
          id: "s1",
          title: "S1",
          status: "pass",
          score: 1,
          runs: [],
          metrics: {
            "result.total_cost_usd": {
              median: 1,
              min: 1,
              max: 1,
              direction: "lower",
              values: [1],
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
          status: "fail",
          score: 0.5,
          runs: [
            { run: 1, status: "pass", score: 1, grades: [], metrics: {} },
            { run: 2, status: "fail", score: 0, grades: [], metrics: {} },
          ],
          metrics: {
            "result.total_cost_usd": {
              median: 1.3,
              min: 1.3,
              max: 1.3,
              direction: "lower",
              values: [1.3],
            },
          },
        },
      ],
    });
    const md = renderComparison(compareReports(base, cand));
    expect(md).toContain("| Verdict | Gated |");
    expect(md).toContain("| worse | 50% |");
    expect(md).toContain("## Non-failing shifts (1)");
    expect(md).toContain("- s1: result.total_cost_usd");
    expect(md).toContain("1 of 2 candidate runs did not pass");
    expect(md.indexOf("## Regressions")).toBeLessThan(
      md.indexOf("## Non-failing shifts"),
    );
    expect(md.indexOf("## Non-failing shifts")).toBeLessThan(
      md.indexOf("## Warnings"),
    );
    base.scenarios[0].score = 0.5;
    const noDrop = renderComparison(compareReports(base, cand));
    expect(noDrop).not.toContain("candidate runs did not pass");
  });
});
