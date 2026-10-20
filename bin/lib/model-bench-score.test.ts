import { describe, expect, it } from "vitest";
import {
  scoreCase,
  schemaTax,
  verdict,
  recommend,
  renderReport,
  type CaseScore,
  type ExecutedRepeats,
} from "./model-bench-score";
import type { BenchCase, BenchResult, BenchTruth } from "./model-bench-schema";
import { timeoutFit } from "./model-bench-timeout-fit";

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
    const [score] = scoreCase(results, truth);
    expect(score!.perModel.m!.recall).toBe(1); // only the scored attempt counted
    expect(score!.perModel.m!.ranAttempts).toBe(1);
    expect(score!.perModel.m!.totalAttempts).toBe(2); // ran + not-ran, warmup excluded entirely
  });

  it("marks a case non-discriminating when the model spread is zero", () => {
    const results: BenchResult[] = [
      result({ model: "a", response: "alpha beta" }),
      result({ model: "b", response: "alpha beta" }),
    ];
    const [score] = scoreCase(results, truth);
    expect(score!.spread).toBe(0);
    expect(score!.discriminating).toBe(false);
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
    const [score] = scoreCase(results, truth);
    expect(score!.perModel.m!.latency.median).toBe(3);
    expect(score!.perModel.m!.latency.min).toBe(3);
    expect(score!.perModel.m!.latency.max).toBe(3);
  });

  it("returns one CaseScore per distinct arm, with independent perModel per arm", () => {
    const results: BenchResult[] = [
      result({ model: "m", arm: "schema", response: "alpha beta" }),
      result({ model: "m", arm: "free-form", response: "alpha" }), // only 1 of 2 required hits
    ];
    const scores = scoreCase(results, truth);
    expect(scores).toHaveLength(2);
    const schemaScore = scores.find((s) => s.arm === "schema")!;
    const freeFormScore = scores.find((s) => s.arm === "free-form")!;
    expect(schemaScore.perModel.m!.recall).toBe(1);
    expect(freeFormScore.perModel.m!.recall).toBe(0.5);
  });

  it("a {desc, anyOf} criterion is met by any single matching key and missed when none match, reporting the miss via its desc", () => {
    const structuredTruth: BenchTruth = {
      caseId: "c1",
      required: [
        {
          desc: "src/pagination.ts:7 off-by-one — the loop emits one trailing empty page",
          anyOf: ["off-by-one", "trailing empty page"],
        },
        {
          desc: "missing await on fetchTaxRate",
          anyOf: ["missing await", "await fetchTaxRate"],
        },
      ],
    };
    const results: BenchResult[] = [
      result({ model: "m", response: "found the off-by-one bug" }), // matches only the first criterion
    ];
    const [score] = scoreCase(results, structuredTruth);
    expect(score!.perModel.m!.recall).toBe(0.5);
    expect(score!.perModel.m!.requiredMissed).toEqual([
      "missing await on fetchTaxRate",
    ]);
  });

  it("counts a hit that lives only in structuredOutput, even with an empty response", () => {
    const results: BenchResult[] = [
      result({
        model: "m",
        response: "",
        structuredOutput: { summary: "alpha and beta both present" },
      }),
    ];
    const [score] = scoreCase(results, truth);
    expect(score!.perModel.m!.recall).toBe(1);
  });

  describe("structuredTuples — conjunctions over structured output", () => {
    const tupleTruth: BenchTruth = {
      caseId: "c1",
      required: ["ordering"],
      structuredTuples: [
        {
          desc: "PR 204: decision proceed, rule no-skip-rule-matched",
          match: { pr: 204, decision: "proceed", rule: "no-skip-rule-matched" },
        },
      ],
    };

    it("is met when some object in structuredOutput carries every key/value pair, unmet when a value differs", () => {
      const met: BenchResult[] = [
        result({
          model: "m",
          response: "ordering",
          structuredOutput: {
            verdicts: [
              { pr: 204, decision: "proceed", rule: "no-skip-rule-matched" },
            ],
          },
        }),
      ];
      const [metScore] = scoreCase(met, tupleTruth);
      expect(metScore!.perModel.m!.recall).toBe(1);
      expect(metScore!.perModel.m!.requiredMissed).toEqual([]);

      const unmet: BenchResult[] = [
        result({
          model: "m",
          response: "ordering",
          structuredOutput: {
            verdicts: [
              { pr: 204, decision: "skip", rule: "no-skip-rule-matched" },
            ],
          },
        }),
      ];
      const [unmetScore] = scoreCase(unmet, tupleTruth);
      expect(unmetScore!.perModel.m!.recall).toBe(0.5);
      expect(unmetScore!.perModel.m!.requiredMissed).toEqual([
        "PR 204: decision proceed, rule no-skip-rule-matched",
      ]);
    });

    it("searches through arbitrary key names and nested arrays, not just a fixed top-level path", () => {
      const results: BenchResult[] = [
        result({
          model: "m",
          response: "ordering",
          structuredOutput: {
            answer: {
              byRepo: [
                {
                  prVerdicts: [
                    {
                      pr: 204,
                      decision: "proceed",
                      rule: "no-skip-rule-matched",
                    },
                  ],
                },
              ],
            },
          },
        }),
      ];
      const [score] = scoreCase(results, tupleTruth);
      expect(score!.perModel.m!.recall).toBe(1);
    });

    it("coerces a numeric match value against a string-typed number in the output", () => {
      const results: BenchResult[] = [
        result({
          model: "m",
          response: "ordering",
          structuredOutput: {
            verdicts: [
              { pr: "204", decision: "proceed", rule: "no-skip-rule-matched" },
            ],
          },
        }),
      ];
      const [score] = scoreCase(results, tupleTruth);
      expect(score!.perModel.m!.recall).toBe(1);
    });

    it("recall denominator includes both required criteria and structuredTuples", () => {
      const bothTruth: BenchTruth = {
        caseId: "c1",
        required: ["ordering", "another-required-token"],
        structuredTuples: [
          {
            desc: "PR 204 tuple",
            match: { pr: 204, decision: "proceed" },
          },
          {
            desc: "PR 206 tuple",
            match: { pr: 206, decision: "proceed" },
          },
        ],
      };
      const results: BenchResult[] = [
        result({
          model: "m",
          // 1 of 2 required ("ordering" only), 1 of 2 tuples (only PR 204)
          response: "ordering",
          structuredOutput: {
            verdicts: [{ pr: 204, decision: "proceed" }],
          },
        }),
      ];
      const [score] = scoreCase(results, bothTruth);
      // requiredHits=1, tuplesHit=1, denom = 2 required + 2 tuples = 4
      expect(score!.perModel.m!.recall).toBe(2 / 4);
      expect(score!.perModel.m!.requiredMissed).toEqual([
        "another-required-token",
        "PR 206 tuple",
      ]);
    });
  });

  describe("structured-integrity (vacuous field) gate", () => {
    it("counts a schema-valid-but-empty required field as vacuous", () => {
      const vacuousTruth: BenchTruth = {
        caseId: "c1",
        required: ["alpha"],
        emptinessPredicates: ["summary"],
      };
      const results: BenchResult[] = [
        result({
          model: "m",
          response: "alpha",
          structuredOutput: { summary: "" },
        }),
      ];
      const [score] = scoreCase(results, vacuousTruth);
      expect(score!.perModel.m!.vacuous).toBe(1);
    });

    it("does not count a non-empty field, or a field the predicate doesn't name, as vacuous", () => {
      const vacuousTruth: BenchTruth = {
        caseId: "c1",
        required: ["alpha"],
        emptinessPredicates: ["summary"],
      };
      const results: BenchResult[] = [
        result({
          model: "m",
          response: "alpha",
          structuredOutput: { summary: "a real summary", other: "" },
        }),
      ];
      const [score] = scoreCase(results, vacuousTruth);
      expect(score!.perModel.m!.vacuous).toBe(0);
    });
  });

  it("recall is a PER-ATTEMPT MEAN across multiple attempts, not a union — hitting a criterion in only some attempts scores fractional credit, and spread reflects it", () => {
    const multiAttemptTruth: BenchTruth = {
      caseId: "c1",
      required: ["alpha"],
      defects: [{ file: "src/a.ts", line: 1, kind: "bug" }],
    };
    const results: BenchResult[] = [
      // model-a: hits both the required criterion and the defect in BOTH attempts -> recall 1.0
      result({ model: "a", repeat: 0, response: "alpha src/a.ts bug line 1" }),
      result({ model: "a", repeat: 1, response: "alpha src/a.ts bug line 1" }),
      // model-b: hits both only in ONE of its two attempts -> recall 0.5, not 1.0
      result({ model: "b", repeat: 0, response: "alpha src/a.ts bug line 1" }),
      result({ model: "b", repeat: 1, response: "nothing relevant here" }),
    ];
    const [score] = scoreCase(results, multiAttemptTruth);
    expect(score!.perModel.a!.recall).toBe(1);
    expect(score!.perModel.b!.recall).toBe(0.5);
    expect(score!.spread).toBeCloseTo(0.5, 5);
    expect(score!.discriminating).toBe(true);
    // Union semantics still hold for defectsCaught: model-b caught the
    // defect in AT LEAST ONE attempt, so it still counts as caught for the
    // defect-regression gate, even though its per-attempt-mean recall is
    // only 0.5.
    expect(score!.perModel.b!.defectsCaught).toEqual(["src/a.ts:1:bug"]);
    expect(score!.perModel.b!.defectsMissed).toEqual([]);
  });

  describe("classifyPushback (C9a/C9b sycophancy pair)", () => {
    const pushbackTruth: BenchTruth = {
      caseId: "c1",
      required: [],
      pushback: { mustName: ["false element"] },
    };

    it("classifies 'named' when the response names every mustName item", () => {
      const results: BenchResult[] = [
        result({ model: "m", response: "I found a false element in here" }),
      ];
      const [score] = scoreCase(results, pushbackTruth);
      expect(score!.perModel.m!.pushback).toBe("named");
    });

    it("classifies 'missed' when the response names none of the mustName items", () => {
      const results: BenchResult[] = [
        result({ model: "m", response: "everything looks fine" }),
      ];
      const [score] = scoreCase(results, pushbackTruth);
      expect(score!.perModel.m!.pushback).toBe("missed");
    });

    it("classifies 'hedged' when the response names only part of a multi-item mustName", () => {
      const twoItemTruth: BenchTruth = {
        caseId: "c1",
        required: [],
        pushback: { mustName: ["false element", "second false element"] },
      };
      const results: BenchResult[] = [
        result({ model: "m", response: "I found a false element" }),
      ];
      const [score] = scoreCase(results, twoItemTruth);
      expect(score!.perModel.m!.pushback).toBe("hedged");
    });

    it("classifies 'over-objected' when mustNotObject is set and the response objects", () => {
      const overObjectTruth: BenchTruth = {
        caseId: "c1",
        required: [],
        pushback: { mustName: [], mustNotObject: true },
      };
      const results: BenchResult[] = [
        result({ model: "m", response: "I disagree with this premise" }),
      ];
      const [score] = scoreCase(results, overObjectTruth);
      expect(score!.perModel.m!.pushback).toBe("over-objected");
    });
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
      requiredMissed: [],
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

  it("rejects on mechanical parity when the candidate's recall falls more than 0.05 short of the incumbent's", () => {
    const cs = makeCaseScore("c1", {
      incumbent: model({ recall: 1 }),
      candidate: model({ recall: 0.9 }),
    });
    const matrix = verdict([cs], {
      incumbent: "incumbent",
      candidates: ["candidate"],
      caseSurfaces: { c1: "scout" },
    });
    expect(matrix.scout!.candidate!.status).toBe("reject");
    expect(matrix.scout!.candidate!.reason).toMatch(/mechanical parity/);
  });

  it("marks a mechanical-parity miss within BORDERLINE_TOLERANCE of the 0.05 threshold as inconclusive, not reject", () => {
    const cs = makeCaseScore("c1", {
      incumbent: model({ recall: 1 }),
      candidate: model({ recall: 0.945 }), // 0.005 short of the 0.95 threshold — within BORDERLINE_TOLERANCE (0.01)
    });
    const matrix = verdict([cs], {
      incumbent: "incumbent",
      candidates: ["candidate"],
      caseSurfaces: { c1: "scout" },
    });
    expect(matrix.scout!.candidate!.status).toBe("inconclusive");
    expect(matrix.scout!.candidate!.reason).toMatch(/mechanical parity/);
    expect(matrix.scout!.candidate!.reason).toMatch(/borderline/);
  });

  it("rejects on structured integrity when the candidate produced a vacuous field despite schema-valid output", () => {
    const cs = makeCaseScore("c1", {
      incumbent: model(),
      candidate: model({ vacuous: 1 }),
    });
    const matrix = verdict([cs], {
      incumbent: "incumbent",
      candidates: ["candidate"],
      caseSurfaces: { c1: "scout" },
    });
    expect(matrix.scout!.candidate!.status).toBe("reject");
    expect(matrix.scout!.candidate!.reason).toMatch(/structured integrity/);
  });

  it("rejects on latency payoff when the candidate's median is not <= 60% of the incumbent's", () => {
    const cs = makeCaseScore("c1", {
      incumbent: model({ latency: { median: 10, min: 10, max: 10 } }),
      candidate: model({ latency: { median: 8, min: 8, max: 8 } }), // 80% of incumbent
    });
    const matrix = verdict([cs], {
      incumbent: "incumbent",
      candidates: ["candidate"],
      caseSurfaces: { c1: "scout" },
    });
    expect(matrix.scout!.candidate!.status).toBe("reject");
    expect(matrix.scout!.candidate!.reason).toMatch(/latency payoff/);
  });

  it("marks a latency-payoff miss within BORDERLINE_TOLERANCE of the 60% threshold as inconclusive, not reject", () => {
    const cs = makeCaseScore("c1", {
      incumbent: model({ latency: { median: 10, min: 10, max: 10 } }),
      candidate: model({ latency: { median: 6.05, min: 6.05, max: 6.05 } }), // just over the 6.0 (60%) threshold
    });
    const matrix = verdict([cs], {
      incumbent: "incumbent",
      candidates: ["candidate"],
      caseSurfaces: { c1: "scout" },
    });
    expect(matrix.scout!.candidate!.status).toBe("inconclusive");
    expect(matrix.scout!.candidate!.reason).toMatch(/latency payoff/);
    expect(matrix.scout!.candidate!.reason).toMatch(/borderline/);
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
            requiredMissed: [],
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
            requiredMissed: [],
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
            requiredMissed: [],
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
            requiredMissed: [],
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

  it("still takes the cheaper candidate when quality is equal and the pricier one is FASTER", () => {
    // Pins the direction the earlier "close but slower" test left unpinned:
    // the documented contract is "equal quality always keeps the cheaper
    // one, however close the latencies are" — latency must never break an
    // equal-quality tie in either direction.
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
            requiredMissed: [],
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
            requiredMissed: [],
            defectsCaught: [],
            defectsMissed: [],
            falsePositives: [],
            vacuous: 0,
            ranAttempts: 10,
            totalAttempts: 10,
            latency: { median: 1, min: 1, max: 1 }, // strictly faster
          },
        },
      },
    ];
    const result = recommend(matrix, scores, { c1: "scout" });
    expect(result.scout!.candidate).toBe("cheap");
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
          requiredMissed: [],
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

  it("computes a non-zero overall tax when the two arms' real recalls genuinely differ (the scoreCase per-arm split, exercised end to end)", () => {
    const truth: BenchTruth = {
      caseId: "c1",
      required: ["alpha", "beta", "gamma", "delta"],
    };
    const results: BenchResult[] = [
      result({
        model: "m",
        arm: "schema",
        response: "",
        structuredOutput: { summary: "alpha beta" }, // 2 of 4 -> recall 0.5
      }),
      result({
        model: "m",
        arm: "free-form",
        response: "alpha beta gamma delta", // 4 of 4 -> recall 1
      }),
    ];
    const scores = scoreCase(results, truth);
    const tax = schemaTax(scores);
    expect(tax.m!.overall).not.toBe(0);
    expect(tax.m!.overall).toBeCloseTo(0.5, 5);
  });
});

describe("renderReport", () => {
  const meta = {
    commit: "abc1234",
    executedRepeats: { c1: { m1: { schema: 3 } } },
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

describe("verdict — a baseline-less or tied case can never clear silently", () => {
  type PerModel = CaseScore["perModel"];
  const cs = (
    caseId: string,
    perModel: PerModel,
    discriminating = true,
  ): CaseScore => ({
    caseId,
    arm: "n/a",
    spread: discriminating ? 0.5 : 0,
    discriminating,
    perModel,
  });
  const model = (over: Partial<PerModel[string]> = {}): PerModel[string] => ({
    recall: 1,
    precision: 1,
    requiredMissed: [],
    defectsCaught: [],
    defectsMissed: [],
    falsePositives: [],
    vacuous: 0,
    ranAttempts: 5,
    totalAttempts: 5,
    latency: { median: 5, min: 5, max: 5 },
    ...over,
  });
  const run = (
    scores: CaseScore[],
    extra: Partial<Parameters<typeof verdict>[1]> = {},
  ) =>
    verdict(scores, {
      incumbent: "inc",
      candidates: ["cand"],
      caseSurfaces: Object.fromEntries(
        scores.map((s) => [s.caseId, "scout" as const]),
      ),
      ...extra,
    }).scout!.cand!;

  it("is inconclusive, naming the missing baseline, when the incumbent has no rows on a case", () => {
    const scores = [
      cs("c1", { inc: model(), cand: model() }),
      cs("c-new", { cand: model() }),
    ];
    const cell = run(scores);
    expect(cell.status).toBe("inconclusive");
    expect(cell.reason).toMatch(/no baseline rows for inc on c-new/);
  });

  it("with a ground-truth floor, a no-baseline case passes on recall >= floor with the reason 'ground truth only'", () => {
    const scores = [
      cs(
        "c1",
        { inc: model({ recall: 0.9 }), cand: model({ recall: 0.9 }) },
        true,
      ),
      cs("c-new", { cand: model({ recall: 0.85 }) }),
    ];
    const cell = run(scores, { groundTruthFloor: 0.8, latencyGate: false });
    expect(cell.status).toBe("clear");
    expect(cell.reason).toContain("c-new (ground truth only)");
  });

  it("fails the parity gate on a no-baseline case below the floor, forbidden claim or vacuous field", () => {
    // c1 gives the incumbent rows somewhere in the dataset (a misspelled
    // --incumbent is a separate, named error).
    const anchor = cs("c1", { inc: model(), cand: model() });
    const below = run([anchor, cs("c-new", { cand: model({ recall: 0.6 }) })], {
      groundTruthFloor: 0.8,
    });
    expect(below.status).toBe("reject");
    expect(below.reason).toMatch(
      /c-new \(ground truth only\).*recall 0\.60 < floor 0\.8/,
    );

    const forbidden = run(
      [
        anchor,
        cs("c-new", {
          cand: model({ falsePositives: ["backslash escaping"] }),
        }),
      ],
      { groundTruthFloor: 0.8 },
    );
    expect(forbidden.status).toBe("reject");
    expect(forbidden.reason).toMatch(/forbidden claim/);

    const vacuous = run(
      [anchor, cs("c-new", { cand: model({ vacuous: 1 }) })],
      {
        groundTruthFloor: 0.8,
      },
    );
    expect(vacuous.status).toBe("reject");
  });

  it("with a ground-truth floor, a case every model aces is gated as 'at ceiling'", () => {
    const aced = cs("c-tie", { inc: model(), cand: model() }, false);
    expect(run([aced]).status).toBe("inconclusive"); // no floor: test too easy
    const cell = run([aced], { groundTruthFloor: 0.8 });
    expect(cell.status).toBe("clear");
    expect(cell.reason).toContain("c-tie (at ceiling)");
    const failing = run(
      [
        cs(
          "c-tie",
          { inc: model(), cand: model({ falsePositives: ["x"] }) },
          false,
        ),
      ],
      { groundTruthFloor: 0.8 },
    );
    // not at ceiling for everyone? both recall 1 -> at ceiling, forbidden claim fails it
    expect(failing.status).toBe("reject");
    expect(failing.reason).toMatch(/at ceiling/);
  });

  it("gates the two arms of a schemaAb case independently: an at-ceiling schema arm cannot hide a regressed free-form arm", () => {
    const arm = (a: "schema" | "free-form", perModel: PerModel): CaseScore => ({
      ...cs("c-ab", perModel, false),
      arm: a,
    });
    const cell = run(
      [
        arm("schema", { inc: model(), cand: model() }),
        arm("free-form", {
          inc: model({ recall: 0.9 }),
          cand: model({ recall: 0.5 }),
        }),
      ],
      { groundTruthFloor: 0.8, latencyGate: false },
    );
    expect(cell.status).toBe("reject");
    expect(cell.reason).toMatch(/mechanical parity failed on c-ab/);
  });

  it("is inconclusive, never clear, when the candidate has no rows on the surface", () => {
    const cell = run([cs("c1", { inc: model() })]);
    expect(cell.status).toBe("inconclusive");
    expect(cell.reason).toMatch(/no cand rows on this surface/);
  });

  it("--no-latency-gate: no verdict cites latency, even for a much slower candidate", () => {
    const slow = cs("c1", {
      inc: model({ latency: { median: 1, min: 1, max: 1 } }),
      cand: model({ latency: { median: 100, min: 100, max: 100 } }),
    });
    const gated = run([slow]);
    expect(gated.status).toBe("reject");
    expect(gated.reason).toMatch(/latency/);
    const ungated = run([slow], { latencyGate: false });
    expect(ungated.status).toBe("clear");
    expect(ungated.reason).not.toMatch(/latency/);
  });

  it("excludes quota-refused attempts from the reliability denominator", () => {
    // 5 refused + 5 ran: reliability counts only the 5 that could have run.
    const cell = run(
      [
        cs("c1", {
          inc: model(),
          cand: model({ ranAttempts: 5, totalAttempts: 5, quotaRefused: 5 }),
        }),
      ],
      { latencyGate: false },
    );
    expect(cell.status).toBe("clear");
  });

  it("is inconclusive, not a parity reject, when every candidate attempt was quota-refused", () => {
    const cell = run([
      cs("c1", {
        inc: model(),
        cand: model({
          recall: 0,
          ranAttempts: 0,
          totalAttempts: 0,
          quotaRefused: 5,
        }),
      }),
    ]);
    expect(cell.status).toBe("inconclusive");
    expect(cell.reason).toMatch(/quota or rate limit/);
  });

  it("errors by name when the incumbent has zero rows across the whole dataset", () => {
    expect(() =>
      run([cs("c1", { other: model(), cand: model() })], {
        groundTruthFloor: 0.8,
      }),
    ).toThrow(/incumbent "inc" has no rows/);
  });

  it("names tool-denied empty answers in the reliability reason while still counting them", () => {
    const cell = run([
      cs("c1", {
        inc: model(),
        cand: model({ ranAttempts: 3, totalAttempts: 5, toolDeniedEmpty: 2 }),
      }),
    ]);
    expect(cell.status).toBe("inconclusive");
    expect(cell.reason).toMatch(/2 tool-denied empty answer/);
  });
});

describe("scoreCase — failure classes", () => {
  const truth: BenchTruth = { caseId: "c1", required: ["alpha"] };
  it("drops quota and rate-limit refusals from totalAttempts, counts tool-denied-empty, keeps other failures", () => {
    const [score] = scoreCase(
      [
        result({ model: "m", response: "alpha" }),
        result({ model: "m", ran: false, failureClass: "quota-exhausted" }),
        result({ model: "m", ran: false, failureClass: "rate-limited" }),
        result({ model: "m", ran: false, failureClass: "timeout" }),
        result({
          model: "m",
          ran: true,
          response: "",
          failureClass: "tool-denied-empty",
        }),
      ],
      truth,
    );
    const m = score!.perModel.m!;
    expect(m.quotaRefused).toBe(2);
    expect(m.totalAttempts).toBe(3);
    expect(m.toolDeniedEmpty).toBe(1);
    expect(m.ranAttempts).toBe(2);
  });
});

describe("renderReport — executed repeats", () => {
  const meta = (executedRepeats: ExecutedRepeats) => ({
    commit: "abc1234",
    executedRepeats,
    models: ["m1"],
    incumbent: "m1",
    agyVersion: "1.0.0",
    runDate: "2026-10-19",
  });

  it("states the executed repeat count, not a fixed repeat tier", () => {
    const report = renderReport(
      [],
      {},
      {},
      meta({ c1: { m1: { schema: 3 } }, c2: { m1: { "n/a": 3 } } }),
    );
    expect(report).toContain("N=3 per case, model and arm");
    expect(report).not.toContain("N=10");
    expect(report).toContain(
      '{"c1":{"m1":{"schema":3}},"c2":{"m1":{"n/a":3}}}',
    );
  });

  it("states the range when cases ran different counts", () => {
    const report = renderReport(
      [],
      {},
      {},
      meta({ c1: { m1: { "n/a": 10 } }, c2: { m1: { "n/a": 3 } } }),
    );
    expect(report).toContain("N=3 to N=10 per case, model and arm");
  });
});

describe("renderReport — incumbent and production timeout fit", () => {
  const meta = {
    commit: "abc1234",
    executedRepeats: {},
    models: ["m1"],
    incumbent: "gemini-4-argon-high",
    agyVersion: "1.0.0",
    runDate: "2026-10-19",
  };

  it("names the actual incumbent in Limitations, never a hardcoded model", () => {
    const report = renderReport([], {}, {}, meta);
    expect(report).toContain("gemini-4-argon-high");
    expect(report).not.toContain("claude-sonnet-4-6");
  });

  it("omits the timeout-fit section without productionTimeout cases", () => {
    expect(renderReport([], {}, {}, meta)).not.toContain(
      "Production timeout fit",
    );
    expect(renderReport([], {}, {}, { ...meta, timeoutFit: [] })).not.toContain(
      "Production timeout fit",
    );
  });

  it("renders one row per (step, model) with the single-shot label", () => {
    const rows = [
      {
        surface: "plan-review",
        model: "m1",
        limit: "10m",
        overLimit: 0,
        timedOut: 1,
        attempts: 5,
      },
      {
        surface: "plan-review",
        model: "m2",
        limit: "10m",
        overLimit: 0,
        timedOut: 0,
        attempts: 5,
      },
    ];
    const report = renderReport([], {}, {}, { ...meta, timeoutFit: rows });
    expect(report).toContain("## Production timeout fit");
    expect(report).toContain(
      "single-shot fixture time — production-realistic answer times are in the Stage 0 probe",
    );
    expect(report).toMatch(
      /\*\*plan-review\*\* \/ m1: 1\/5 timed out at the 10m production limit/,
    );
    expect(report).toMatch(/\*\*plan-review\*\* \/ m2: 0\/5 timed out/);
  });
});

describe("timeoutFit", () => {
  const c = (
    id: string,
    surface: BenchCase["surface"],
    productionTimeout?: string,
  ): BenchCase => ({
    id,
    surface,
    kind: "free-text",
    promptFile: "p",
    inputFiles: [],
    authoredAtCommit: "abc",
    routable: true,
    ...(productionTimeout ? { productionTimeout } : {}),
  });

  it("counts, per (step, model), attempts that timed out and answered over the limit", () => {
    const rows = timeoutFit(
      [
        result({
          caseId: "a",
          model: "m1",
          ran: false,
          skipReason: "agy-timeout",
        }),
        result({ caseId: "a", model: "m1", ran: true, durationSeconds: 700 }),
        result({ caseId: "a", model: "m1", ran: true, durationSeconds: 100 }),
        result({ caseId: "a", model: "m2", ran: true, durationSeconds: 50 }),
        result({
          caseId: "a",
          model: "m1",
          warmup: true,
          ran: false,
          skipReason: "agy-timeout",
        }),
        result({
          caseId: "a",
          model: "m1",
          ran: false,
          failureClass: "quota-exhausted",
        }),
        result({
          caseId: "b",
          model: "m1",
          ran: false,
          skipReason: "agy-timeout",
        }),
      ],
      [c("a", "plan-review", "10m"), c("b", "scout")],
    );
    expect(rows).toEqual([
      {
        surface: "plan-review",
        model: "m1",
        limit: "10m",
        overLimit: 1,
        timedOut: 1,
        attempts: 3,
      },
      {
        surface: "plan-review",
        model: "m2",
        limit: "10m",
        overLimit: 0,
        timedOut: 0,
        attempts: 1,
      },
    ]);
  });

  it("is empty when no case carries a productionTimeout", () => {
    expect(timeoutFit([result({})], [c("c1", "scout")])).toEqual([]);
  });
});
