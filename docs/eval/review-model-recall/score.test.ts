import { describe, expect, it } from "vitest";
import {
  combinations,
  exactPermutationP,
  mean,
  pstdev,
  pvariance,
  round,
} from "./score";

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
