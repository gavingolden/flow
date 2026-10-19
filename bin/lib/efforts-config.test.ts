import { describe, expect, it } from "vitest";
import {
  collectEffortConfigWarnings,
  EFFORT_CONFIG_KEYS,
  readEffortsConfig,
} from "./efforts-config";
import type { ReadConfigFile } from "./models-config";

const reader =
  (raw: unknown): ReadConfigFile =>
  () =>
    raw;

describe("readEffortsConfig", () => {
  it("returns {} for an unreadable, empty or efforts-less config", () => {
    expect(readEffortsConfig(reader(undefined))).toEqual({});
    expect(readEffortsConfig(reader({}))).toEqual({});
    expect(readEffortsConfig(reader({ efforts: "high" }))).toEqual({});
  });

  it("keeps valid flat and nested levels", () => {
    const efforts = readEffortsConfig(
      reader({
        efforts: {
          fixApplier: "high",
          scout: "low",
          reviewLenses: { security: "low", product: "max" },
        },
      }),
    );
    expect(efforts).toEqual({
      fixApplier: "high",
      scout: "low",
      reviewLenses: { security: "low", product: "max" },
    });
  });

  it("drops invalid levels, unknown keys and group keys", () => {
    const efforts = readEffortsConfig(
      reader({
        efforts: {
          fixApplier: "hgh",
          coder: 3,
          review: "high",
          implement: "high",
          bogus: "high",
          reviewLenses: { security: "nope", "not-a-lens": "high" },
        },
      }),
    );
    expect(efforts).toEqual({});
  });

  it("names every per-role key it reads", () => {
    expect(EFFORT_CONFIG_KEYS).toEqual([
      "planning",
      "scout",
      "coder",
      "fixApplier",
      "uiDriver",
      "consolidator",
      "mergeResolver",
    ]);
  });
});

describe("collectEffortConfigWarnings", () => {
  it("returns no warnings for a missing or valid config", () => {
    expect(collectEffortConfigWarnings(reader(undefined))).toEqual([]);
    expect(collectEffortConfigWarnings(reader({}))).toEqual([]);
    expect(
      collectEffortConfigWarnings(
        reader({
          efforts: { fixApplier: "low", reviewLenses: { product: "max" } },
        }),
      ),
    ).toEqual([]);
  });

  it("warns once, naming efforts.fixApplier, for an invalid level", () => {
    const w = collectEffortConfigWarnings(
      reader({ efforts: { fixApplier: "hgh" } }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("efforts.fixApplier");
    expect(w[0]).toContain("'hgh'");
  });

  it("warns on an unknown key", () => {
    const w = collectEffortConfigWarnings(
      reader({ efforts: { mystery: "high" } }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("efforts.mystery: unknown key");
  });

  it("names the group keys as unsupported", () => {
    const w = collectEffortConfigWarnings(
      reader({ efforts: { review: "high", implement: "low" } }),
    );
    expect(w).toHaveLength(2);
    expect(w[0]).toContain("efforts.review");
    expect(w[0]).toContain("use per-role keys");
    expect(w[1]).toContain("efforts.implement");
  });

  it("warns on a non-object efforts table and a non-object reviewLenses", () => {
    expect(collectEffortConfigWarnings(reader({ efforts: "high" }))).toEqual([
      "efforts: expected an object mapping role to effort level; ignoring.",
    ]);
    expect(collectEffortConfigWarnings(reader({ efforts: [] }))).toEqual([
      "efforts: expected an object mapping role to effort level; ignoring.",
    ]);
    expect(
      collectEffortConfigWarnings(reader({ efforts: { reviewLenses: [] } })),
    ).toEqual([
      "efforts.reviewLenses: expected an object mapping lens name to effort level; ignoring.",
    ]);
    expect(
      collectEffortConfigWarnings(
        reader({ efforts: { reviewLenses: "high" } }),
      ),
    ).toEqual([
      "efforts.reviewLenses: expected an object mapping lens name to effort level; ignoring.",
    ]);
  });

  it("warns on an unknown lens and an invalid lens level", () => {
    const w = collectEffortConfigWarnings(
      reader({
        efforts: { reviewLenses: { nope: "high", security: "extreme" } },
      }),
    );
    expect(w).toHaveLength(2);
    expect(w[0]).toContain("efforts.reviewLenses.nope: unknown review lens");
    expect(w[1]).toContain("efforts.reviewLenses.security: 'extreme'");
    expect(w[1]).toContain("effort level");
  });
});
