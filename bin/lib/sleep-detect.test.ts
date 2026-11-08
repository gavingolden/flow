import { describe, expect, it, vi } from "vitest";
import {
  parseKernTime,
  sleepSince,
  withSleepRerun,
  type SleepSpan,
} from "./sleep-detect";

const REAL = "{ sec = 1794148449, usec = 139153 } Sun Nov  8 08:34:09 2026";
const REAL_MS = 1794148449 * 1000 + 139;

describe("parseKernTime", () => {
  it("should parse the real sysctl line with usec precision", () => {
    expect(parseKernTime(REAL)).toBe(REAL_MS);
  });

  it("should return null when sec is 0", () => {
    expect(
      parseKernTime("{ sec = 0, usec = 0 } Thu Jan  1 00:00:00 1970"),
    ).toBeNull();
  });

  it("should return null for garbage", () => {
    expect(parseKernTime("nonsense")).toBeNull();
  });
});

describe("sleepSince", () => {
  const reader =
    (sleep: string | null, wake: string | null = null) =>
    (name: string) =>
      name === "kern.sleeptime" ? sleep : wake;

  it("should return a span when the last sleep is at or after startMs", () => {
    const wake = "{ sec = 1794148500, usec = 0 }";
    const span = sleepSince(REAL_MS - 1, {
      platform: "darwin",
      readSysctl: reader(REAL, wake),
    });
    expect(span?.sleptAt).toBe(new Date(REAL_MS).toISOString());
    expect(span?.wokeAt).toBe(new Date(1794148500000).toISOString());
  });

  it("should return null off darwin", () => {
    expect(
      sleepSince(0, { platform: "linux", readSysctl: reader(REAL) }),
    ).toBeNull();
  });

  it("should return null when the reader returns null", () => {
    expect(
      sleepSince(0, { platform: "darwin", readSysctl: reader(null) }),
    ).toBeNull();
  });

  it("should leave wokeAt null when waketime precedes sleeptime", () => {
    const wake = "{ sec = 1794148000, usec = 0 }";
    const span = sleepSince(0, {
      platform: "darwin",
      readSysctl: reader(REAL, wake),
    });
    expect(span?.wokeAt).toBeNull();
  });

  it("should return null when the last sleep predates startMs", () => {
    expect(
      sleepSince(REAL_MS + 1, { platform: "darwin", readSysctl: reader(REAL) }),
    ).toBeNull();
  });
});

describe("withSleepRerun", () => {
  const span: SleepSpan = { sleptAt: "2026-01-01T00:00:00.000Z", wokeAt: null };
  const failed = { passed: false, durationMs: 9000 };

  it("should return null for a passed first run", () => {
    const rerun = vi.fn();
    expect(
      withSleepRerun({ passed: true, durationMs: 1 }, 0, rerun),
    ).toBeNull();
    expect(rerun).not.toHaveBeenCalled();
  });

  it("should not re-run when no sleep fell in the window", () => {
    const rerun = vi.fn();
    const out = withSleepRerun(failed, 0, rerun, { sleepSince: () => null });
    expect(out).toBeNull();
    expect(rerun).not.toHaveBeenCalled();
  });

  it("should record passed with the re-run's own duration", () => {
    const out = withSleepRerun(
      failed,
      0,
      () => ({ passed: true, durationMs: 50 }),
      { sleepSince: vi.fn().mockReturnValueOnce(span), now: () => 5 },
    );
    expect(out?.slept.rerun).toBe("passed");
    expect(out?.durationMs).toBe(50);
    expect(out?.slept.sleptAt).toBe(span.sleptAt);
  });

  it("should record failed when the re-run fails awake", () => {
    const out = withSleepRerun(
      failed,
      0,
      () => ({ passed: false, durationMs: 60 }),
      {
        sleepSince: vi.fn().mockReturnValueOnce(span).mockReturnValueOnce(null),
      },
    );
    expect(out?.slept.rerun).toBe("failed");
  });

  it("should record slept-again when the re-run fails and slept again", () => {
    const out = withSleepRerun(
      failed,
      0,
      () => ({ passed: false, durationMs: 60 }),
      { sleepSince: () => span },
    );
    expect(out?.slept.rerun).toBe("slept-again");
  });

  it("should treat a throwing sleepSince as no sleep", () => {
    const out = withSleepRerun(failed, 0, () => failed, {
      sleepSince: () => {
        throw new Error("boom");
      },
    });
    expect(out).toBeNull();
  });
});
