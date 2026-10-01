import { describe, expect, it } from "vitest";
import {
  combinations,
  exactPermutationP,
  mean,
  pstdev,
  pvariance,
  round,
} from "./score";
import { aggregateArms, median, shipRule, type CellStat } from "./score-arms";

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
    arm: "pointer",
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

function pair(packed: Partial<CellStat>, pointer: Partial<CellStat>, runs = 2) {
  const out: CellStat[] = [];
  for (let run = 1; run <= runs; run++) {
    out.push(cell({ ...pointer, arm: "pointer", run }));
    out.push(cell({ ...packed, arm: "packed", run }));
  }
  return out;
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
    const { arms } = aggregateArms(pair({ cost: 0.5 }, { cost: 1 }));
    expect(arms.packed!.cost_usd).toEqual({ median: 0.5, mean: 0.5 });
    expect(arms.pointer!.cost_usd.median).toBe(1);
    expect(arms.packed!.num_turns.median).toBe(10);
    expect(arms.pointer!.duration_ms.median).toBe(100000);
    expect(arms.packed!.recall_acted).toBe(0.5);
  });
});

describe("shipRule", () => {
  it("passes when packed is cheaper, no slower and no worse on recall/findings", () => {
    const r = shipRule(pair({ cost: 0.5, duration: 90_000 }, {}));
    expect(r).toEqual({
      cost_ok: true,
      recall_acted_ok: true,
      findings_ok: true,
      wallclock_ok: true,
      pass: true,
    });
  });

  it("fails when packed costs more than 0.85x pointer", () => {
    const r = shipRule(pair({ cost: 0.9 }, { cost: 1 }));
    expect(r?.cost_ok).toBe(false);
    expect(r?.pass).toBe(false);
  });

  it("fails when packed is more than 1.1x slower", () => {
    const r = shipRule(pair({ cost: 0.5, duration: 120_000 }, {}));
    expect(r?.wallclock_ok).toBe(false);
    expect(r?.pass).toBe(false);
  });

  it("fails when acted recall drops by more than one pooled sd", () => {
    const cells = [
      ...pair({ cost: 0.5, recallActed: 0.1 }, { recallActed: 0.5 }),
    ];
    expect(shipRule(cells)?.recall_acted_ok).toBe(false);
  });

  it("tolerates a recall drop within one pooled sd when runs vary", () => {
    const cells = [
      cell({ arm: "packed", run: 1, recallActed: 0.4, cost: 0.5 }),
      cell({ arm: "packed", run: 2, recallActed: 0.6, cost: 0.5 }),
      cell({ arm: "pointer", run: 1, recallActed: 0.5 }),
      cell({ arm: "pointer", run: 2, recallActed: 0.7 }),
    ];
    expect(shipRule(cells)?.recall_acted_ok).toBe(true);
  });

  it("fails a recall drop larger than one pooled sd when runs vary", () => {
    const cells = [
      cell({ arm: "packed", run: 1, recallActed: 0.4, cost: 0.5 }),
      cell({ arm: "packed", run: 2, recallActed: 0.6, cost: 0.5 }),
      cell({ arm: "pointer", run: 1, recallActed: 0.7 }),
      cell({ arm: "pointer", run: 2, recallActed: 0.9 }),
    ];
    expect(shipRule(cells)?.recall_acted_ok).toBe(false);
  });

  it("is insufficient with one run per cell, but still reports cost and wall-clock", () => {
    const r = shipRule(pair({ cost: 0.9, duration: 200_000 }, {}, 1));
    expect(r?.pass).toBe("insufficient");
    expect(r?.cost_ok).toBe(false);
    expect(r?.wallclock_ok).toBe(false);
  });

  it("is insufficient when no reference comment was acted on", () => {
    const r = shipRule(
      pair({ cost: 0.5, recallActed: null }, { recallActed: null }),
    );
    expect(r?.recall_acted_ok).toBeNull();
    expect(r?.pass).toBe("insufficient");
  });

  it("is null without both packed and pointer arms", () => {
    expect(shipRule([cell({ arm: "opus" })])).toBeNull();
  });
});
