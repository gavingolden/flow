import { describe, expect, it } from "vitest";
import { compareSemver, isNewerVersion, parseSemver } from "./semver";

describe("parseSemver", () => {
  it("parses a plain x.y.z string", () => {
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
  });

  it("strips a leading v prefix", () => {
    expect(parseSemver("v1.2.3")).toEqual([1, 2, 3]);
  });

  it("returns null with fewer than 3 segments", () => {
    expect(parseSemver("1.0")).toBeNull();
  });

  it("returns null for non-numeric garbage", () => {
    expect(parseSemver("garbage")).toBeNull();
  });

  it("returns null when a segment is non-numeric", () => {
    expect(parseSemver("1.2.x")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("returns 1 when the first is newer", () => {
    expect(compareSemver("1.1.0", "1.0.9")).toBe(1);
  });

  it("returns 0 when equal", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
  });

  it("returns -1 when the first is older", () => {
    expect(compareSemver("0.9.9", "1.0.0")).toBe(-1);
  });

  it("returns 0 when either side is unparseable", () => {
    expect(compareSemver("garbage", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0", "garbage")).toBe(0);
  });
});

describe("isNewerVersion", () => {
  it("is true when the candidate is newer", () => {
    expect(isNewerVersion("1.1.0", "1.0.0")).toBe(true);
  });

  it("is false when equal", () => {
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
  });

  it("is false when the candidate is older", () => {
    expect(isNewerVersion("0.9.0", "1.0.0")).toBe(false);
  });

  it("is false when unparseable", () => {
    expect(isNewerVersion("garbage", "1.0.0")).toBe(false);
  });
});
