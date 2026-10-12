import { describe, expect, it } from "vitest";
import {
  mergeAgyLensesRecord,
  parseAgyLensesRecord,
  type AgyLensesRecord,
} from "./agy-lenses-record";

const rec = (over: Partial<AgyLensesRecord> = {}): AgyLensesRecord => ({
  review_started_at: "2026-10-06T10:00:00Z",
  model: "Claude Opus 5.5 (High)",
  routes: [],
  delegated: [],
  fallback: [],
  cooldownArmed: false,
  ...over,
});

describe("parseAgyLensesRecord", () => {
  it("reads absent, garbage and wrong-shaped text as null", () => {
    expect(parseAgyLensesRecord(null)).toBeNull();
    expect(parseAgyLensesRecord("nope")).toBeNull();
    expect(parseAgyLensesRecord("{}")).toBeNull();
    expect(parseAgyLensesRecord('{"routes":1}')).toBeNull();
  });

  it("round-trips a record", () => {
    const r = rec({ cooldownArmed: true });
    expect(parseAgyLensesRecord(JSON.stringify(r))).toEqual(r);
  });
});

describe("mergeAgyLensesRecord", () => {
  const first = rec({
    routes: [
      { lens: "bug-detection", route: "agy" },
      { lens: "security", route: "agy" },
    ],
    delegated: [
      {
        lens: "bug-detection",
        findingCount: 1,
        decodedVia: "structured-output",
        durationSec: 9,
      },
    ],
    fallback: [{ lens: "security", reason: "agy-timeout" }],
  });

  it("returns the new record when there is no previous one", () => {
    expect(mergeAgyLensesRecord(null, first)).toEqual(first);
  });

  it("replaces only the re-fanned lens within the same review window", () => {
    const wave2 = rec({
      routes: [{ lens: "security", route: "agy" }],
      delegated: [
        {
          lens: "security",
          findingCount: 0,
          decodedVia: "response-parse",
          durationSec: 4,
        },
      ],
      cooldownArmed: true,
    });
    const merged = mergeAgyLensesRecord(first, wave2);
    expect(merged.delegated.map((d) => d.lens).sort()).toEqual([
      "bug-detection",
      "security",
    ]);
    expect(merged.fallback).toEqual([]);
    expect(merged.routes).toHaveLength(2);
    expect(merged.cooldownArmed).toBe(true);
  });

  it("starts fresh for a different review window or an unknown one", () => {
    const next = rec({ review_started_at: "2026-10-07T10:00:00Z" });
    expect(mergeAgyLensesRecord(first, next)).toEqual(next);
    const unknown = rec({ review_started_at: null });
    expect(mergeAgyLensesRecord(first, unknown)).toEqual(unknown);
  });
});
