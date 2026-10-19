import { describe, expect, it } from "vitest";
import {
  chunked,
  mergeResults,
  parseResetsIn,
  pendingSlots,
  quotaHalt,
  slotKey,
} from "./model-bench-resume";
import type { ManifestEntry } from "./model-bench-manifest";
import type { BenchResult } from "./model-bench-schema";

const slot = (caseId: string, repeat: number, model = "m"): ManifestEntry => ({
  caseId,
  arm: "n/a",
  model,
  repeat,
  warmup: false,
});

const row = (
  e: ManifestEntry,
  over: Partial<BenchResult> = {},
): BenchResult => ({
  ...e,
  ran: true,
  response: `r-${e.caseId}-${e.repeat}`,
  ...over,
});

describe("slotKey", () => {
  it("is stable per (case, arm, model, repeat|warmup, size)", () => {
    expect(slotKey(slot("c", 0))).toBe(slotKey(slot("c", 0)));
    expect(slotKey(slot("c", 0))).not.toBe(slotKey(slot("c", 1)));
    expect(slotKey({ ...slot("c", 0), size: 10 })).not.toBe(
      slotKey(slot("c", 0)),
    );
    expect(slotKey({ ...slot("c", -1), warmup: true })).toContain("warmup");
  });
});

describe("pendingSlots", () => {
  const manifest = [0, 1, 2, 3].map((r) => slot("c", r));

  it("returns every slot when there are no prior rows", () => {
    expect(pendingSlots(manifest, [])).toEqual(manifest);
  });

  it("drops slots with a successful row, keeps failed and absent ones", () => {
    const prior = [
      row(manifest[0]!),
      row(manifest[1]!, { ran: false, failureClass: "quota-exhausted" }),
    ];
    expect(pendingSlots(manifest, prior)).toEqual(manifest.slice(1));
  });

  it("selects pending slots BEFORE a cap, so a second tranche reaches new slots", () => {
    const tranche1 = pendingSlots(manifest, []).slice(0, 2);
    const prior = tranche1.map((e) => row(e));
    const tranche2 = pendingSlots(manifest, prior).slice(0, 2);
    expect(tranche2.map((e) => e.repeat)).toEqual([2, 3]);
  });
});

describe("mergeResults", () => {
  const [a, b, c] = [0, 1, 2].map((r) => slot("c", r));

  it("keeps prior rows in place and appends fresh successes", () => {
    const prior = [row(a!), row(b!)];
    const merged = mergeResults(prior, [row(c!)]);
    expect(merged.map((r) => r.repeat)).toEqual([0, 1, 2]);
    expect(merged.slice(0, 2)).toEqual(prior);
  });

  it("a fresh success supersedes a same-key prior failure without moving earlier rows", () => {
    const failed = row(b!, {
      ran: false,
      failureClass: "quota-exhausted",
      response: undefined,
    });
    const prior = [row(a!), failed, row(c!)];
    const fresh = row(b!, { response: "retried" });
    const merged = mergeResults(prior, [fresh]);
    expect(merged.filter((r) => r.ran).map((r) => r.repeat)).toEqual([0, 2, 1]);
    expect(merged.filter((r) => !r.ran)).toHaveLength(0);
    // earlier ran rows keep their relative order, so blinded ids never move
    expect(merged[0]).toEqual(prior[0]);
    expect(merged[1]).toEqual(prior[2]);
  });

  it("keeps blinded ids stable: ids index the ran, non-warm-up rows and only failures are dropped", () => {
    const prior = [row(a!), row(b!, { ran: false }), row(c!)];
    const merged = mergeResults(prior, [row(b!)]);
    const ids = (rows: BenchResult[]) =>
      rows.filter((r) => r.ran && !r.warmup).map((r) => r.response);
    expect(ids(merged).slice(0, ids(prior).length)).toEqual(ids(prior));
  });

  it("ignores a fresh row for a key that already succeeded", () => {
    const prior = [row(a!, { response: "first" })];
    const merged = mergeResults(prior, [row(a!, { response: "dup" })]);
    expect(merged).toEqual(prior);
  });

  it("a fresh failure replaces a prior failure for the same key", () => {
    const merged = mergeResults(
      [row(a!, { ran: false, skipReason: "old" })],
      [row(a!, { ran: false, skipReason: "new" })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.skipReason).toBe("new");
  });
});

describe("quotaHalt", () => {
  it("is not halted for a clean chunk or a non-quota failure", () => {
    expect(quotaHalt([row(slot("c", 0))])).toEqual({ halted: false });
    expect(
      quotaHalt([row(slot("c", 0), { ran: false, failureClass: "timeout" })]),
    ).toEqual({ halted: false });
  });

  it("detects quota-exhausted and carries its reset", () => {
    expect(
      quotaHalt([
        row(slot("c", 0)),
        row(slot("c", 1), {
          ran: false,
          failureClass: "quota-exhausted",
          resetsIn: "92h31m22s",
        }),
      ]),
    ).toEqual({ halted: true, resetsIn: "92h31m22s" });
  });

  it("halts without a reset when the refusal names none", () => {
    expect(
      quotaHalt([
        row(slot("c", 0), { ran: false, failureClass: "quota-exhausted" }),
      ]),
    ).toEqual({ halted: true });
  });

  it("does not halt on a rate limit", () => {
    expect(
      quotaHalt([
        row(slot("c", 0), { ran: false, failureClass: "rate-limited" }),
      ]).halted,
    ).toBe(false);
  });
});

describe("parseResetsIn", () => {
  it("reads the duration out of agy's refusal text", () => {
    expect(
      parseResetsIn(
        "Individual quota reached (claude-opus). Resets in 92h31m22s.",
      ),
    ).toBe("92h31m22s");
    expect(parseResetsIn("quota exceeded, resets in 4h")).toBe("4h");
    expect(parseResetsIn("some other error")).toBeUndefined();
    expect(parseResetsIn(undefined)).toBeUndefined();
  });
});

describe("chunked", () => {
  it("splits into runs of at most `size`", () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunked([], 3)).toEqual([]);
  });
});
