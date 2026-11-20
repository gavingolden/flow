import { describe, expect, it } from "vitest";
import {
  degradedForOutcome,
  degradedRoutesForSnapshots,
  isDegradedShot,
  summarizeDegraded,
  usableShots,
} from "./ui-capture-health";
import type { SectionShot } from "./ui-driver-schema";

const shot = (route: string, over: Partial<SectionShot> = {}): SectionShot => ({
  route,
  section: "Main",
  viewport: "desktop",
  part: "whole",
  path: ".flow-tmp/ui-evidence/x.png",
  ...over,
});
const fail = (status: number, count = 1) => ({
  failedRequests: [{ url: "api.test/x", status, count }],
});

describe("isDegradedShot", () => {
  it("is degraded for a persisting 429 below the storm threshold", () => {
    expect(isDegradedShot(shot("/", fail(429, 4)))).toBe(true);
  });

  it("is not degraded for a 429 at or above the storm threshold", () => {
    expect(isDegradedShot(shot("/", fail(429, 5)))).toBe(false);
  });

  it.each([0, 500, 502, 503, 504])(
    "is not degraded for status %i",
    (status) => {
      expect(isDegradedShot(shot("/", fail(status)))).toBe(false);
    },
  );

  it("is not degraded without failedRequests", () => {
    expect(isDegradedShot(shot("/"))).toBe(false);
  });
});

describe("usableShots and summarizeDegraded", () => {
  const shots = [
    shot("/a", fail(429)),
    shot("/a", { viewport: "phone", ...fail(429) }),
    shot("/b", fail(429)),
    shot("/b", { viewport: "phone" }),
    shot("/c", fail(500)),
  ];

  it("drops only degraded shots", () => {
    expect(usableShots(shots)).toHaveLength(2);
  });

  it("counts degraded shots and lists only fully degraded routes", () => {
    expect(summarizeDegraded(shots)).toEqual({
      shots: 3,
      of: 5,
      unjudgedRoutes: ["/a"],
    });
  });

  it("reports nothing for an empty capture", () => {
    expect(summarizeDegraded([])).toEqual({
      shots: 0,
      of: 0,
      unjudgedRoutes: [],
    });
  });
});

describe("degradedForOutcome", () => {
  const r0 = { shots: 1, of: 2, unjudgedRoutes: [] };
  const post = { shots: 2, of: 2, unjudgedRoutes: ["/a"] };
  const both = { "round-0": r0, "post-round": post };

  it("picks post-round when the round was kept", () => {
    expect(
      degradedForOutcome({ outcome: "kept", captureDegraded: both }),
    ).toEqual(post);
  });

  it("picks round-0 for any other outcome", () => {
    expect(
      degradedForOutcome({ outcome: "clean", captureDegraded: both }),
    ).toEqual(r0);
  });

  it("is null when no summary was recorded", () => {
    expect(degradedForOutcome({ outcome: "clean" })).toBeNull();
    expect(
      degradedForOutcome({
        outcome: "kept",
        captureDegraded: { "round-0": r0 },
      }),
    ).toBeNull();
  });
});

describe("degradedRoutesForSnapshots", () => {
  it("considers only desktop shots", () => {
    const routes = degradedRoutesForSnapshots([
      shot("/phone-only", { viewport: "phone", ...fail(429) }),
      shot("/desktop", fail(429)),
    ]);
    expect([...routes]).toEqual(["/desktop"]);
  });
});
