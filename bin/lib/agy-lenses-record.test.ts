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

describe("parseAgyLensesRecord (older records)", () => {
  it("parses a delegated entry without model / reroutedFrom", () => {
    const r = rec({
      delegated: [
        {
          lens: "bug-detection",
          findingCount: 1,
          decodedVia: "x",
          durationSec: 3,
        },
      ],
    });
    const parsed = parseAgyLensesRecord(JSON.stringify(r));
    expect(parsed?.delegated[0].model).toBeUndefined();
    expect(parsed?.delegated[0].reroutedFrom).toBeUndefined();
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

  it("keeps model / reroutedFrom / rerouteOutcome across a two-wave round-trip", () => {
    const wave1 = rec({
      routes: [
        { lens: "bug-detection", route: "agy" },
        { lens: "security", route: "agy" },
      ],
      delegated: [
        {
          lens: "bug-detection",
          findingCount: 2,
          decodedVia: "structured-output",
          durationSec: 40,
          model: "Gemini 4 Argon (Medium)",
          reroutedFrom: "agy-content-filtered",
        },
      ],
      fallback: [
        {
          lens: "security",
          reason: "agy-content-filtered",
          rerouteOutcome: "skipped-no-time",
        },
      ],
    });
    const wave2 = rec({
      routes: [{ lens: "pattern-consistency", route: "agy" }],
      delegated: [
        {
          lens: "pattern-consistency",
          findingCount: 0,
          decodedVia: "response-parse",
          durationSec: 5,
          model: "Claude Opus 5.5 (High)",
        },
      ],
    });
    const merged = mergeAgyLensesRecord(wave1, wave2);
    const roundTripped = parseAgyLensesRecord(JSON.stringify(merged));
    const bug = roundTripped?.delegated.find((d) => d.lens === "bug-detection");
    expect(bug?.model).toBe("Gemini 4 Argon (Medium)");
    expect(bug?.reroutedFrom).toBe("agy-content-filtered");
    expect(roundTripped?.fallback[0].rerouteOutcome).toBe("skipped-no-time");
    expect(
      roundTripped?.delegated.find((d) => d.lens === "pattern-consistency")
        ?.model,
    ).toBe("Claude Opus 5.5 (High)");
  });
});
