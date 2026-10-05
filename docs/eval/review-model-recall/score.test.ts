import { describe, expect, it } from "vitest";
import {
  combinations,
  exactPermutationP,
  mean,
  pstdev,
  pvariance,
  resolvedModelId,
  round,
  twoArmSeparation,
} from "./score";
import { isCompletedCellOutput } from "./run";
import { aggregateArms, median, type CellStat } from "./score-arms";

// Coverage scope note: this harness is otherwise untested by design (a
// one-off eval script) — EXCEPT this pure, I/O-free scoring math, which
// produced the p-values the PR's headline recall-vs-cost conclusion rests
// on. Everything else in score.ts (file I/O, JSON extraction, CLI parsing)
// stays untested.

describe("round", () => {
  it("rounds to the given decimal place", () => {
    expect(round(1.23456, 2)).toBe(1.23);
    expect(round(1.005, 2)).toBeCloseTo(1.0, 5); // float-repr edge case, not a bug to pin exactly
  });
});

describe("mean", () => {
  it("computes the arithmetic mean", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([5])).toBe(5);
  });
});

describe("pvariance / pstdev", () => {
  it("population variance/stdev of a constant array is 0", () => {
    expect(pvariance([4, 4, 4])).toBe(0);
    expect(pstdev([4, 4, 4])).toBe(0);
  });

  it("matches the hand-computed population variance for a known set", () => {
    // mean=3, deviations [-2,-1,0,1,2], squared [4,1,0,1,4], mean=2
    expect(pvariance([1, 2, 3, 4, 5])).toBe(2);
    expect(pstdev([1, 2, 3, 4, 5])).toBeCloseTo(Math.sqrt(2), 10);
  });
});

describe("combinations", () => {
  it("enumerates all C(n,k) index combinations, in ascending-index order per combo", () => {
    const combos = combinations(4, 2);
    expect(combos.length).toBe(6); // C(4,2) = 6
    expect(combos).toContainEqual([0, 1]);
    expect(combos).toContainEqual([2, 3]);
    for (const c of combos) {
      expect(c).toEqual([...c].sort((a, b) => a - b));
      expect(new Set(c).size).toBe(c.length);
    }
  });

  it("C(12,6) = 924 — the exact size exactPermutationP's docstring assumes", () => {
    expect(combinations(12, 6).length).toBe(924);
  });

  it("k=0 yields exactly one empty combination", () => {
    expect(combinations(5, 0)).toEqual([[]]);
  });
});

describe("exactPermutationP", () => {
  it("returns 1.0 when the two groups are identical (no observed effect can be more extreme)", () => {
    const p = exactPermutationP([1, 1, 1], [1, 1, 1]);
    expect(p).toBeCloseTo(1.0, 10);
  });

  it("returns a small p-value when opus strictly and maximally dominates sonnet", () => {
    // The most extreme possible split — the observed split IS the single
    // most extreme permutation, so p = 1/C(n,k).
    const sonnet = [0, 0, 0];
    const opus = [10, 10, 10];
    const p = exactPermutationP(sonnet, opus);
    const expected = 1 / combinations(6, 3).length;
    expect(p).toBeCloseTo(expected, 10);
  });

  it("is symmetric under relabelling only insofar as the observed-diff sign matters — reversing which group is 'opus' flips the direction tested", () => {
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    // opus dominates when b is opus (b - a diff is positive and extreme)
    const pBHigh = exactPermutationP(a, b);
    // opus does NOT dominate when a is opus (a - b diff is negative, so
    // almost every split is at least as extreme as the observed one)
    const pALow = exactPermutationP(b, a);
    expect(pBHigh).toBeLessThan(pALow);
  });
});

function cell(over: Partial<CellStat>): CellStat {
  return {
    lens: "bug-detection",
    pr: "880",
    arm: "b",
    run: 1,
    cost: 1,
    turns: 10,
    duration: 100_000,
    recallAll: 0.5,
    recallActed: 0.5,
    candidates: 5,
    ...over,
  };
}

describe("median", () => {
  it("handles odd, even and empty inputs", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("aggregateArms", () => {
  it("keys per-arm cost/turns/duration/recall by arm name", () => {
    const { arms } = aggregateArms([
      cell({ arm: "a", run: 1, cost: 0.5 }),
      cell({ arm: "a", run: 2, cost: 0.5 }),
      cell({ arm: "b", run: 1, cost: 1 }),
      cell({ arm: "b", run: 2, cost: 1 }),
    ]);
    expect(arms.a!.cost_usd).toEqual({ median: 0.5, mean: 0.5 });
    expect(arms.b!.cost_usd.median).toBe(1);
    expect(arms.a!.num_turns.median).toBe(10);
    expect(arms.b!.duration_ms.median).toBe(100000);
    expect(arms.a!.recall_acted).toBe(0.5);
  });
});

const armCell = (
  arm: string,
  pr: string,
  run: number,
  recallAll: number,
  lens = "bug-detection",
): CellStat => ({
  lens,
  pr,
  arm,
  run,
  cost: 1,
  turns: 10,
  duration: 1000,
  recallAll,
  recallActed: null,
  candidates: 3,
});

describe("twoArmSeparation", () => {
  const fableOpus = [
    armCell("fable", "812", 1, 0.1),
    armCell("fable", "812", 2, 0.3),
    armCell("fable", "756", 1, 0.2),
    armCell("fable", "756", 2, 0.2),
    armCell("fable", "802", 1, 0.4),
    armCell("fable", "802", 2, 0.4),
    armCell("opus", "812", 1, 0.0),
    armCell("opus", "812", 2, 0.1),
    armCell("opus", "756", 1, 0.1),
    armCell("opus", "756", 2, 0.1),
    armCell("opus", "802", 1, 0.2),
    armCell("opus", "802", 2, 0.3),
  ];

  it("picks opus as baseline and reports delta, pooled sd and the exact p", () => {
    const sep = twoArmSeparation(fableOpus)!.separation["bug-detection"] as {
      baseline: string;
      candidate: string;
      delta_mean_recall: number;
      pooled_within_arm_sd: number;
      exact_permutation_p_one_sided: number;
    };
    const f = [0.1, 0.3, 0.2, 0.2, 0.4, 0.4];
    const o = [0.0, 0.1, 0.1, 0.1, 0.2, 0.3];
    expect(sep.baseline).toBe("opus");
    expect(sep.candidate).toBe("fable");
    expect(sep.delta_mean_recall).toBe(round(mean(f) - mean(o), 4));
    expect(sep.pooled_within_arm_sd).toBe(
      round(Math.sqrt((pstdev(f) ** 2 + pstdev(o) ** 2) / 2), 4),
    );
    expect(sep.exact_permutation_p_one_sided).toBe(
      round(exactPermutationP(o, f), 4),
    );
  });

  it("emits per-PR runs, mean recall and variance per arm", () => {
    const pr = twoArmSeparation(fableOpus)!.perPr;
    expect(pr.fable!["bug-detection"]!["pr-812"]).toEqual({
      runs: [0.1, 0.3],
      mean_recall: 0.2,
      variance: 0.01,
    });
    expect(pr.opus!["bug-detection"]!["pr-802"]).toMatchObject({
      mean_recall: 0.25,
    });
  });

  it("omits a lens where one arm has no runs, instead of emitting NaN", () => {
    const sep = twoArmSeparation([
      ...fableOpus,
      armCell("fable", "812", 1, 0.5, "security"),
    ])!.separation;
    expect(Object.keys(sep)).toEqual(["bug-detection"]);
  });

  it("leaves the exact p null once the two arms total more than 20 runs", () => {
    const cells = [];
    for (let r = 1; r <= 11; r++) cells.push(armCell("fable", "812", r, 0.3));
    for (let r = 1; r <= 10; r++) cells.push(armCell("opus", "812", r, 0.1));
    const sep = twoArmSeparation(cells)!.separation["bug-detection"] as {
      exact_permutation_p_one_sided: number | null;
    };
    expect(sep.exact_permutation_p_one_sided).toBeNull();
  });

  it("is null unless exactly two arms were judged", () => {
    expect(twoArmSeparation([armCell("opus", "812", 1, 0.1)])).toBeNull();
    expect(
      twoArmSeparation([
        armCell("a", "812", 1, 0.1),
        armCell("b", "812", 1, 0.1),
        armCell("c", "812", 1, 0.1),
      ]),
    ).toBeNull();
  });
});

describe("resolvedModelId", () => {
  it("returns the dominant non-haiku modelUsage key", () => {
    expect(
      resolvedModelId({
        "claude-haiku-4-5-20251001": { costUSD: 9 },
        "claude-fable-5-1": { costUSD: 2 },
        "claude-opus-5-5": { costUSD: 1 },
      }),
    ).toBe("claude-fable-5-1");
  });

  it("falls back to token totals and tolerates missing usage", () => {
    expect(
      resolvedModelId({
        "claude-haiku-4-5-20251001": { inputTokens: 999 },
        "claude-opus-5-5": { inputTokens: 5, outputTokens: 5 },
      }),
    ).toBe("claude-opus-5-5");
    expect(resolvedModelId({ "claude-haiku-4-5-20251001": {} })).toBeNull();
    expect(resolvedModelId(undefined)).toBeNull();
  });
});

describe("isCompletedCellOutput (resume predicate)", () => {
  it("accepts a successful result and one with no subtype", () => {
    expect(
      isCompletedCellOutput('{"is_error":false,"subtype":"success"}'),
    ).toBe(true);
    expect(isCompletedCellOutput('{"result":"x"}')).toBe(true);
  });

  it("rejects error, budget-killed, malformed and non-object outputs", () => {
    expect(isCompletedCellOutput('{"is_error":true}')).toBe(false);
    expect(
      isCompletedCellOutput(
        '{"is_error":false,"subtype":"error_max_budget_usd"}',
      ),
    ).toBe(false);
    expect(isCompletedCellOutput("{truncated")).toBe(false);
    expect(isCompletedCellOutput("")).toBe(false);
    expect(isCompletedCellOutput("null")).toBe(false);
    expect(isCompletedCellOutput("[1]")).toBe(false);
  });
});
