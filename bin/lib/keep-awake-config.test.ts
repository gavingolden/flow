import { describe, expect, it, vi } from "vitest";
import {
  readKeepAwakeSettings,
  resolveKeepAwakeMaxMinutes,
} from "./keep-awake-config";

const cfg = (power: unknown) => () => ({ power });

describe("resolveKeepAwakeMaxMinutes", () => {
  it("should default to 120 built-in when the config is absent", () => {
    expect(resolveKeepAwakeMaxMinutes(() => undefined)).toEqual({
      minutes: 120,
      source: "built-in",
    });
  });

  it("should default when there is no power key", () => {
    expect(resolveKeepAwakeMaxMinutes(() => ({}))).toEqual({
      minutes: 120,
      source: "built-in",
    });
  });

  it("should use the configured minutes when in range", () => {
    expect(
      resolveKeepAwakeMaxMinutes(cfg({ keepAwakeMaxMinutes: 90 })),
    ).toEqual({ minutes: 90, source: "config" });
  });

  it("should clamp to 30 when the value is below the floor", () => {
    expect(
      resolveKeepAwakeMaxMinutes(cfg({ keepAwakeMaxMinutes: 10 })),
    ).toEqual({ minutes: 30, source: "config" });
  });

  it("should clamp to 1440 when the value is above the ceiling", () => {
    expect(
      resolveKeepAwakeMaxMinutes(cfg({ keepAwakeMaxMinutes: 5000 })),
    ).toEqual({ minutes: 1440, source: "config" });
  });

  it.each(["90", 0, -5, 2.5, null])(
    "should fall back to 120 built-in when the value is %j",
    (v) => {
      expect(
        resolveKeepAwakeMaxMinutes(cfg({ keepAwakeMaxMinutes: v })),
      ).toEqual({ minutes: 120, source: "built-in" });
    },
  );

  it("should fall back to 120 built-in when the read throws", () => {
    expect(
      resolveKeepAwakeMaxMinutes(() => {
        throw new Error("boom");
      }),
    ).toEqual({ minutes: 120, source: "built-in" });
  });
});

describe("readKeepAwakeSettings", () => {
  it("should be enabled with 7200 s by default", () => {
    expect(readKeepAwakeSettings(() => undefined)).toEqual({
      enabled: true,
      maxSec: 7200,
    });
  });

  it("should be disabled when power.keepAwake is false", () => {
    expect(readKeepAwakeSettings(cfg({ keepAwake: false })).enabled).toBe(
      false,
    );
  });

  it("should convert configured minutes to seconds", () => {
    expect(readKeepAwakeSettings(cfg({ keepAwakeMaxMinutes: 90 })).maxSec).toBe(
      5400,
    );
  });

  it("should call read exactly once when deriving both fields", () => {
    const read = vi.fn(() => ({ power: { keepAwake: true } }));
    readKeepAwakeSettings(read);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
