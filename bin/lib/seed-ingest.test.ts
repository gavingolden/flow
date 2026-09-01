import { describe, expect, it } from "vitest";
import {
  isSeedIngest,
  seedIngestConfirmsDelivery,
  seedIngestIsCorrupt,
  unverifiedSeedWarning,
  type SeedIngest,
} from "./seed-ingest";

const AT = "2026-01-01T00:00:00.000Z";

const verified: SeedIngest = { at: AT, outcome: "verified" };
const notApplicable: SeedIngest = {
  at: AT,
  outcome: "not-applicable",
  reason: "no-seed-recorded",
};
const unverified: SeedIngest = {
  at: AT,
  outcome: "unverified",
  reason: "stdin-timeout",
};
const corrupt: SeedIngest = {
  at: AT,
  outcome: "corrupt",
  expectedBytes: 400,
  submittedBytes: 120,
};

describe("isSeedIngest", () => {
  it("accepts every one of the four encoded outcomes", () => {
    for (const rec of [verified, notApplicable, unverified, corrupt]) {
      expect(isSeedIngest(rec)).toBe(true);
    }
  });

  it("round-trips each outcome through JSON", () => {
    for (const rec of [verified, notApplicable, unverified, corrupt]) {
      expect(isSeedIngest(JSON.parse(JSON.stringify(rec)))).toBe(true);
    }
  });

  it("rejects a non-object", () => {
    expect(isSeedIngest(null)).toBe(false);
    expect(isSeedIngest(undefined)).toBe(false);
    expect(isSeedIngest("verified")).toBe(false);
    expect(isSeedIngest([verified])).toBe(false);
  });

  it("rejects an unknown or missing outcome", () => {
    expect(isSeedIngest({ at: AT, outcome: "ingested" })).toBe(false);
    expect(isSeedIngest({ at: AT })).toBe(false);
  });

  it("rejects a missing or non-string `at`", () => {
    expect(isSeedIngest({ outcome: "verified" })).toBe(false);
    expect(isSeedIngest({ at: 17, outcome: "verified" })).toBe(false);
  });

  it("rejects a corrupt record missing expectedBytes", () => {
    expect(
      isSeedIngest({ at: AT, outcome: "corrupt", submittedBytes: 1 }),
    ).toBe(false);
  });

  it("rejects a corrupt record missing submittedBytes", () => {
    expect(isSeedIngest({ at: AT, outcome: "corrupt", expectedBytes: 1 })).toBe(
      false,
    );
  });

  it("rejects a corrupt record whose byte counts are not numbers", () => {
    expect(
      isSeedIngest({
        at: AT,
        outcome: "corrupt",
        expectedBytes: "400",
        submittedBytes: 120,
      }),
    ).toBe(false);
  });

  it("rejects a non-string reason on the two reason-bearing outcomes", () => {
    expect(isSeedIngest({ at: AT, outcome: "unverified", reason: 3 })).toBe(
      false,
    );
    expect(isSeedIngest({ at: AT, outcome: "unverified" })).toBe(false);
    expect(isSeedIngest({ at: AT, outcome: "not-applicable", reason: 3 })).toBe(
      false,
    );
    expect(isSeedIngest({ at: AT, outcome: "not-applicable" })).toBe(false);
  });
});

describe("seedIngestIsCorrupt", () => {
  it("is true only for a corrupt record", () => {
    expect(seedIngestIsCorrupt({ seedIngest: corrupt })).toBe(true);
    expect(seedIngestIsCorrupt({ seedIngest: verified })).toBe(false);
    expect(seedIngestIsCorrupt({ seedIngest: unverified })).toBe(false);
    expect(seedIngestIsCorrupt({ seedIngest: notApplicable })).toBe(false);
  });

  it("is false for an absent record, null, and undefined", () => {
    expect(seedIngestIsCorrupt({})).toBe(false);
    expect(seedIngestIsCorrupt(null)).toBe(false);
    expect(seedIngestIsCorrupt(undefined)).toBe(false);
  });
});

describe("seedIngestConfirmsDelivery", () => {
  it("is true only for a verified record", () => {
    expect(seedIngestConfirmsDelivery({ seedIngest: verified })).toBe(true);
    expect(seedIngestConfirmsDelivery({ seedIngest: corrupt })).toBe(false);
    expect(seedIngestConfirmsDelivery({ seedIngest: unverified })).toBe(false);
    expect(seedIngestConfirmsDelivery({ seedIngest: notApplicable })).toBe(
      false,
    );
  });

  it("is false for an absent record, null, and undefined", () => {
    expect(seedIngestConfirmsDelivery({})).toBe(false);
    expect(seedIngestConfirmsDelivery(null)).toBe(false);
    expect(seedIngestConfirmsDelivery(undefined)).toBe(false);
  });
});

describe("unverifiedSeedWarning", () => {
  it("returns the exact sentence on an unverified record", () => {
    expect(
      unverifiedSeedWarning("flow feature create", { seedIngest: unverified }),
    ).toBe(
      "flow feature create: seed integrity NOT verified (stdin-timeout) — confirm the window's first prompt is the request you typed.",
    );
  });

  it("names the record's own reason", () => {
    expect(
      unverifiedSeedWarning("flow epic create --resume", {
        seedIngest: {
          at: AT,
          outcome: "unverified",
          reason: "no-prompt-field",
        },
      }),
    ).toBe(
      "flow epic create --resume: seed integrity NOT verified (no-prompt-field) — confirm the window's first prompt is the request you typed.",
    );
  });

  it("returns null on every other outcome, an absent record, null, and undefined", () => {
    for (const rec of [verified, notApplicable, corrupt]) {
      expect(
        unverifiedSeedWarning("flow feature create", { seedIngest: rec }),
      ).toBeNull();
    }
    expect(unverifiedSeedWarning("flow feature create", {})).toBeNull();
    expect(unverifiedSeedWarning("flow feature create", null)).toBeNull();
    expect(unverifiedSeedWarning("flow feature create", undefined)).toBeNull();
  });
});
