import { describe, expect, it } from "vitest";
import { relativeTime } from "./time";

describe(relativeTime, () => {
  const NOW = Date.UTC(2026, 3, 30, 12, 30, 0);

  it("formats sub-minute as seconds (5s boundary)", () => {
    expect(relativeTime(NOW - 5_000, NOW)).toBe("5s ago");
  });
  it("formats sub-hour as minutes (90s → 1m)", () => {
    expect(relativeTime(NOW - 90_000, NOW)).toBe("1m ago");
  });
  it("formats sub-day as hours (2h)", () => {
    expect(relativeTime(NOW - 2 * 60 * 60_000, NOW)).toBe("2h ago");
  });
  it("formats multi-day (3d)", () => {
    expect(relativeTime(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe("3d ago");
  });
  it("clamps negative deltas to 0s", () => {
    expect(relativeTime(NOW + 5_000, NOW)).toBe("0s ago");
  });
});
