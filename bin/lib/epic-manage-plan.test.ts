import { describe, expect, it } from "vitest";
import { watchedPrs } from "./epic-manage-plan";
import type { FeatureRunRecord } from "./epic-run-state";
import type { PipelineState } from "./state";

const LAUNCHED = "2026-08-03T00:00:00.000Z";

const stateOf = (
  slug: string,
  over: Partial<PipelineState> = {},
): PipelineState => ({
  slug,
  phase: "implementing",
  repo: "/repo",
  updatedAt: "2026-11-08T00:00:00Z",
  ...over,
});

describe("watchedPrs", () => {
  it("watches only a live, unmerged, owned binding's PR", () => {
    const features: Record<string, FeatureRunRecord> = {
      latched: {
        slug: "latched",
        launchedAt: LAUNCHED,
        lastStatus: "merged",
        pr: 7,
      },
      external: { external: "PR#8", pr: 8 },
      running: { slug: "running", launchedAt: LAUNCHED },
      merged: { slug: "merged", launchedAt: LAUNCHED },
    };
    const states = [
      stateOf("running", { pr: 9 }),
      stateOf("merged", { phase: "merged", pr: 10 }),
    ];
    expect(watchedPrs(features, states)).toEqual([9]);
  });

  it("ignores a newer same-name pipeline's PR and falls back to the record's", () => {
    const features: Record<string, FeatureRunRecord> = {
      old: { slug: "reused", launchedAt: LAUNCHED, pr: 11 },
    };
    const states = [
      stateOf("reused", { pr: 99, createdAt: "2026-11-08T00:00:00.000Z" }),
    ];
    expect(watchedPrs(features, states)).toEqual([11]);
  });

  it("dedupes a PR shared by two records", () => {
    const features: Record<string, FeatureRunRecord> = {
      a: { slug: "a", launchedAt: LAUNCHED, pr: 3 },
      b: { slug: "b", launchedAt: LAUNCHED, pr: 3 },
    };
    expect(watchedPrs(features, [])).toEqual([3]);
  });
});
