import { describe, expect, it } from "vitest";
import {
  scoreCase,
  schemaTax,
  verdict,
  recommend,
  renderReport,
  type CaseScore,
} from "./model-bench-score";
import type { BenchResult, BenchTruth } from "./model-bench-schema";

function result(overrides: Partial<BenchResult>): BenchResult {
  return {
    caseId: "c1",
    arm: "n/a",
    model: "model-a",
    repeat: 0,
    warmup: false,
    ran: true,
    response: "",
    ...overrides,
  };
}

describe("scoreCase", () => {
  const truth: BenchTruth = { caseId: "c1", required: ["alpha", "beta"] };

  it("excludes warm-up and ran:false attempts from perModel arithmetic", () => {
    const results: BenchResult[] = [
      result({ model: "m", response: "alpha beta", ran: true }),
      result({ model: "m", response: "", warmup: true, ran: true }), // warmup: excluded
      result({ model: "m", response: "irrelevant", ran: false }), // not ran: excluded
    ];
    const score = scoreCase(results, truth);
    expect(score.perModel.m!.recall).toBe(1); // only the scored attempt counted
    expect(score.perModel.m!.ranAttempts).toBe(1);
    expect(score.perModel.m!.totalAttempts).toBe(2); // ran + not-ran, warmup excluded entirely
  });

  it("marks a case non-discriminating when the model spread is zero", () => {
    const results: BenchResult[] = [
      result({ model: "a", response: "alpha beta" }),
      result({ model: "b", response: "alpha beta" }),
    ];
    const score = scoreCase(results, truth);
    expect(score.spread).toBe(0);
    expect(score.discriminating).toBe(false);
  });

  it("reads latency from durationSeconds and ignores an extraneous durationMs-shaped field", () => {
    const results: BenchResult[] = [
      // durationMs is not part of BenchResult's shape at all — cast to
      // simulate a caller accidentally carrying it through; scoreCase must
      // never read it (LATENCY PROVENANCE pin).
      {
        ...result({ model: "m", response: "alpha", durationSeconds: 3 }),
        durationMs: 999999,
      } as BenchResult,
    ];
    const score = scoreCase(results, truth);
    expect(score.perModel.m!.latency.median).toBe(3);
    expect(score.perModel.m!.latency.min).toBe(3);
    expect(score.perModel.m!.latency.max).toBe(3);
  });
});

describe("verdict — gate order and discrimination", () => {
  function makeCaseScore(
    caseId: string,
    perModel: CaseScore["perModel"],
    discriminating = true,
  ): CaseScore {
    const values = Object.values(perModel).map((m) => m.recall);
    const spread = Math.max(...values) - Math.min(...values);
    return {
      caseId,
      arm: "n/a",
      spread: discriminating ? Math.max(spread, 0.01) : 0,
      discriminating,
      perModel,
    };
  }

  function model(
    overrides: Partial<CaseScore["perModel"][string]> = {},
  ): CaseScore["perModel"][string] {
    return {
      recall: 1,
      precision: 1,
      defectsCaught: [],
      defectsMissed: [],
      falsePositives: [],
      vacuous: 0,
      ranAttempts: 10,
      totalAttempts: 10,
      latency: { median: 5, min: 5, max: 5 },
      ...overrides,
    };
  }

  it("rejects a candidate that is faster but missed a defect the incumbent caught — quality before latency", () => {
    const cs = makeCaseScore("c1", {
      incumbent: model({
        defectsCaught: ["src/a.ts:1:bug"],
        latency: { median: 10, min: 10, max: 10 },
      }),
      candidate: model({
        defectsMissed: ["src/a.ts:1:bug"],
        latency: { median: 1, min: 1, max: 1 },
      }),
    });
    const matrix = verdict([cs], {
      incumbent: "incumbent",
      candidates: ["candidate"],
      caseSurfaces: { c1: "scout" },
    });
    expect(matrix.scout!.candidate!.status).toBe("reject");
    expect(matrix.scout!.candidate!.reason).toMatch(/defect regression/);
  });

  it("a non-discriminating case contributes to no 'clear' verdict", () => {
    const cs = makeCaseScore(
      "c1",
      { incumbent: model(), candidate: model() },
      false,
    );
    const matrix = verdict([cs], {
      incumbent: "incumbent",
      candidates: ["candidate"],
      caseSurfaces: { c1: "scout" },
    });
    expect(matrix.scout!.candidate!.status).toBe("inconclusive");
    expect(matrix.scout!.candidate!.reason).toMatch(/test too easy/);
  });

  it("marks >20% ran:false as inconclusive, not reject", () => {
    const cs = makeCaseScore("c1", {
      incumbent: model(),
      candidate: model({ ranAttempts: 5, totalAttempts: 10 }), // 50% failure
    });
    const matrix = verdict([cs], {
      incumbent: "incumbent",
      candidates: ["candidate"],
      caseSurfaces: { c1: "scout" },
    });
    expect(matrix.scout!.candidate!.status).toBe("inconclusive");
    expect(matrix.scout!.candidate!.reason).toMatch(/reliability/);
  });

  it("a blind 'worse' verdict downgrades a clear to inconclusive", () => {
    const cs = makeCaseScore("c1", {
      incumbent: model(),
      candidate: model({ latency: { median: 2, min: 2, max: 2 } }), // clears the latency gate too
    });
    const matrix = verdict([cs], {
      incumbent: "incumbent",
      candidates: ["candidate"],
      caseSurfaces: { c1: "scout" },
      judged: { candidate: "worse" },
    });
    expect(matrix.scout!.candidate!.status).toBe("inconclusive");
  });

  it("a blind 'better' verdict can never upgrade a reject", () => {
    const cs = makeCaseScore("c1", {
      incumbent: model({ defectsCaught: ["x"] }),
      candidate: model({ defectsMissed: ["x"] }),
    });
    const matrix = verdict([cs], {
      incumbent: "incumbent",
      candidates: ["candidate"],
      caseSurfaces: { c1: "scout" },
      judged: { candidate: "better" },
    });
    expect(matrix.scout!.candidate!.status).toBe("reject");
  });
});

describe("recommend — quality-gated tie-break", () => {
  it("takes the cheaper candidate when quality is equal, even when latencies are close", () => {
    const matrix = {
      scout: {
        cheap: { status: "clear" as const, reason: "" },
        pricey: { status: "clear" as const, reason: "" },
      },
    };
    const scores: CaseScore[] = [
      {
        caseId: "c1",
        arm: "n/a",
        spread: 0.1,
        discriminating: true,
        perModel: {
          cheap: {
            recall: 0.9,
            precision: 1,
            defectsCaught: [],
            defectsMissed: [],
            falsePositives: [],
            vacuous: 0,
            ranAttempts: 10,
            totalAttempts: 10,
            latency: { median: 5, min: 5, max: 5 },
          },
          pricey: {
            recall: 0.9, // same quality
            precision: 1,
            defectsCaught: [],
            defectsMissed: [],
            falsePositives: [],
            vacuous: 0,
            ranAttempts: 10,
            totalAttempts: 10,
            latency: { median: 5.5, min: 5.5, max: 5.5 }, // close but slower
          },
        },
      },
    ];
    const result = recommend(matrix, scores, { c1: "scout" });
    expect(result.scout!.candidate).toBe("cheap");
  });

  it("takes the more expensive candidate only when its quality is strictly greater", () => {
    const matrix = {
      scout: {
        cheap: { status: "clear" as const, reason: "" },
        pricey: { status: "clear" as const, reason: "" },
      },
    };
    const scores: CaseScore[] = [
      {
        caseId: "c1",
        arm: "n/a",
        spread: 0.1,
        discriminating: true,
        perModel: {
          cheap: {
            recall: 0.8,
            precision: 1,
            defectsCaught: [],
            defectsMissed: [],
            falsePositives: [],
            vacuous: 0,
            ranAttempts: 10,
            totalAttempts: 10,
            latency: { median: 2, min: 2, max: 2 },
          },
          pricey: {
            recall: 0.95, // strictly higher quality
            precision: 1,
            defectsCaught: [],
            defectsMissed: [],
            falsePositives: [],
            vacuous: 0,
            ranAttempts: 10,
            totalAttempts: 10,
            latency: { median: 10, min: 10, max: 10 },
          },
        },
      },
    ];
    const result = recommend(matrix, scores, { c1: "scout" });
    expect(result.scout!.candidate).toBe("pricey");
  });
});

describe("schemaTax", () => {
  function scoreFor(arm: "schema" | "free-form", recall: number): CaseScore {
    return {
      caseId: "c1",
      arm,
      spread: 0,
      discriminating: false,
      perModel: {
        m: {
          recall,
          precision: 1,
          defectsCaught: [],
          defectsMissed: [],
          falsePositives: [],
          vacuous: 0,
          ranAttempts: 10,
          totalAttempts: 10,
          latency: { median: 1, min: 1, max: 1 },
        },
      },
    };
  }

  it("recommends free-form when the tax exceeds the threshold", () => {
    const tax = schemaTax([
      scoreFor("schema", 0.5),
      scoreFor("free-form", 0.9),
    ]);
    expect(tax.m!.recommendedArm).toBe("free-form");
  });

  it("recommends schema when the tax does not exceed the threshold", () => {
    const tax = schemaTax([
      scoreFor("schema", 0.9),
      scoreFor("free-form", 0.91),
    ]);
    expect(tax.m!.recommendedArm).toBe("schema");
  });
});

describe("renderReport", () => {
  const meta = {
    commit: "abc1234",
    repeatTiers: { c1: 3 },
    models: ["m1", "m2"],
    incumbent: "m1",
    agyVersion: "1.0.0",
    runDate: "2026-08-04",
  };

  it("emits all seven mandatory headings", () => {
    const report = renderReport([], {}, {}, meta);
    for (const heading of [
      "## Per-surface verdicts",
      "## Where each candidate was worse",
      "## Surfaces no candidate should take",
      "## Case discrimination",
      "## Schema tax",
      "## Run provenance",
      "## Limitations",
    ]) {
      expect(report).toContain(heading);
    }
  });

  it("carries an explicit 'none' affirmation in the two negative-findings sections when there are no negatives", () => {
    const matrix = { scout: { m: { status: "clear" as const, reason: "ok" } } };
    const report = renderReport([], matrix, {}, meta);
    const worseSection = report.split(
      "## Surfaces no candidate should take",
    )[0]!;
    expect(worseSection).toMatch(/none — no candidate was rejected/);
    const noCandidateSection = report.split("## Case discrimination")[0]!;
    expect(noCandidateSection).toMatch(
      /none — every surface has at least one clearing candidate/,
    );
  });
});
