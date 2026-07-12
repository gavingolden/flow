import { describe, expect, it, vi } from "vitest";
import { isLive, livenessOf, pidStartEpoch } from "./liveness";

const LSTART_ENGLISH = "Thu Jul  9 14:16:50 2026";
// Self-consistent expected value: built from the same local-time
// components the parser uses, so the assertion holds regardless of the
// test runner's timezone.
const LSTART_ENGLISH_EPOCH = Math.floor(
  new Date(2026, 6, 9, 14, 16, 50).getTime() / 1000,
);

describe("livenessOf", () => {
  it("returns 'alive' when the pid is alive and the start time matches", () => {
    const state = { pid: 4242, procStartedAt: 1_000_000 };
    const isAlive = vi.fn(() => true);
    const pidStartEpochFn = vi.fn(() => 1_000_000);
    expect(livenessOf(state, { isAlive, pidStartEpoch: pidStartEpochFn })).toBe(
      "alive",
    );
    expect(isAlive).toHaveBeenCalledWith(4242);
    expect(pidStartEpochFn).toHaveBeenCalledWith(4242);
  });

  it("returns 'stale' when the pid is not alive (ESRCH-equivalent)", () => {
    const state = { pid: 4242, procStartedAt: 1_000_000 };
    const isAlive = vi.fn(() => false);
    const pidStartEpochFn = vi.fn(() => 1_000_000);
    expect(livenessOf(state, { isAlive, pidStartEpoch: pidStartEpochFn })).toBe(
      "stale",
    );
    // Start time is never even probed once the pid is confirmed not alive.
    expect(pidStartEpochFn).not.toHaveBeenCalled();
  });

  it("returns 'dead' when the pid is alive but the start time doesn't match (recycled pid)", () => {
    const state = { pid: 4242, procStartedAt: 1_000_000 };
    const isAlive = vi.fn(() => true);
    const pidStartEpochFn = vi.fn(() => 2_000_000);
    expect(livenessOf(state, { isAlive, pidStartEpoch: pidStartEpochFn })).toBe(
      "dead",
    );
  });

  it("returns 'unknown' and never throws when pid is missing", () => {
    const state = { procStartedAt: 1_000_000 };
    expect(() => livenessOf(state)).not.toThrow();
    expect(livenessOf(state)).toBe("unknown");
  });

  it("returns 'unknown' and never throws when procStartedAt is missing", () => {
    const state = { pid: 4242 };
    expect(() => livenessOf(state)).not.toThrow();
    expect(livenessOf(state)).toBe("unknown");
  });

  it("returns 'unknown' and never throws when both fields are missing", () => {
    const state = {};
    expect(() => livenessOf(state)).not.toThrow();
    expect(livenessOf(state)).toBe("unknown");
  });
});

describe("isLive", () => {
  it("is true only for the 'alive' verdict", () => {
    const alive = { pid: 1, procStartedAt: 10 };
    expect(
      isLive(alive, { isAlive: () => true, pidStartEpoch: () => 10 }),
    ).toBe(true);
    expect(
      isLive(alive, { isAlive: () => true, pidStartEpoch: () => 99 }),
    ).toBe(false);
    expect(
      isLive(alive, { isAlive: () => false, pidStartEpoch: () => 10 }),
    ).toBe(false);
    expect(isLive({})).toBe(false);
  });
});

describe("pidStartEpoch", () => {
  it("parses an English lstart string to the correct epoch seconds", () => {
    const spawnPs = () => LSTART_ENGLISH;
    expect(pidStartEpoch(4242, { spawnPs })).toBe(LSTART_ENGLISH_EPOCH);
  });

  it("invokes the ps seam with a child env carrying LC_ALL=C", () => {
    let recordedEnv: NodeJS.ProcessEnv | undefined;
    const spawnPs = (_pid: number, env: NodeJS.ProcessEnv) => {
      recordedEnv = env;
      return LSTART_ENGLISH;
    };
    pidStartEpoch(4242, { spawnPs });
    expect(recordedEnv).toBeDefined();
    expect(recordedEnv?.LC_ALL).toBe("C");
  });

  it("returns null for a non-English lstart-shaped string rather than a wrong epoch", () => {
    // French month/weekday names — same overall shape, wrong locale. Must
    // fail closed (null), never silently parse a garbage epoch.
    const spawnPs = () => "jeu. juil.  9 14:16:50 2026";
    expect(pidStartEpoch(4242, { spawnPs })).toBeNull();
  });

  it("returns null when the ps seam reports no matching process", () => {
    const spawnPs = () => null;
    expect(pidStartEpoch(4242, { spawnPs })).toBeNull();
  });
});
