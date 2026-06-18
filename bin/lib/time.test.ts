import { describe, expect, it } from "vitest";
import { formatDuration, relativeTime } from "./time";

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

describe(formatDuration, () => {
  it("formats sub-minute as seconds only", () => {
    expect(formatDuration(45_000)).toBe("45s");
  });
  it("formats minutes with zero-padded seconds", () => {
    expect(formatDuration(192_000)).toBe("3m12s");
  });
  it("zero-pads single-digit seconds in the minutes form", () => {
    expect(formatDuration(68_000)).toBe("1m08s");
  });
  it("formats hours with zero-padded minutes, dropping seconds", () => {
    expect(formatDuration((60 + 4) * 60_000 + 30_000)).toBe("1h04m");
  });
  it("floors sub-second remainders to whole seconds", () => {
    expect(formatDuration(45_900)).toBe("45s");
  });
  it("returns empty string for zero", () => {
    expect(formatDuration(0)).toBe("");
  });
  it("returns empty string for negative input", () => {
    expect(formatDuration(-1_000)).toBe("");
  });
  it("returns empty string for NaN", () => {
    expect(formatDuration(NaN)).toBe("");
  });
  it("returns empty string for non-finite input", () => {
    expect(formatDuration(Infinity)).toBe("");
  });
});
