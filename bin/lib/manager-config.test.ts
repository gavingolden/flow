import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_BUDGET_USD,
  DEFAULT_HEARTBEAT_SEC,
  readManagerConfig,
} from "./manager-config";

const cfg = (manager: unknown) => () => ({ manager });

describe("readManagerConfig", () => {
  it("should default to 900 s and $20 when nothing is configured", () => {
    expect(readManagerConfig(() => undefined)).toEqual({
      heartbeatSec: DEFAULT_HEARTBEAT_SEC,
      dailyBudgetUsd: DEFAULT_DAILY_BUDGET_USD,
    });
    expect(DEFAULT_HEARTBEAT_SEC).toBe(900);
    expect(DEFAULT_DAILY_BUDGET_USD).toBe(20);
  });

  it("should read both configured values", () => {
    expect(
      readManagerConfig(cfg({ heartbeatSec: 120, dailyBudgetUsd: 7.5 })),
    ).toEqual({ heartbeatSec: 120, dailyBudgetUsd: 7.5 });
  });

  it("should accept the 60 s minimum and reject anything below it", () => {
    expect(readManagerConfig(cfg({ heartbeatSec: 60 })).heartbeatSec).toBe(60);
    expect(readManagerConfig(cfg({ heartbeatSec: 59 })).heartbeatSec).toBe(900);
    expect(readManagerConfig(cfg({ heartbeatSec: 0 })).heartbeatSec).toBe(900);
  });

  it("should fall back for a non-integer, string or negative heartbeat", () => {
    for (const v of [90.5, "120", -120, null, NaN]) {
      expect(readManagerConfig(cfg({ heartbeatSec: v })).heartbeatSec).toBe(
        900,
      );
    }
  });

  it("should fall back for a zero, negative, string or infinite budget", () => {
    for (const v of [0, -5, "20", null, Infinity, NaN]) {
      expect(readManagerConfig(cfg({ dailyBudgetUsd: v })).dailyBudgetUsd).toBe(
        20,
      );
    }
  });

  it("should judge each key on its own", () => {
    expect(
      readManagerConfig(cfg({ heartbeatSec: "bad", dailyBudgetUsd: 3 })),
    ).toEqual({ heartbeatSec: 900, dailyBudgetUsd: 3 });
  });

  it("should tolerate a missing, non-object or malformed config", () => {
    for (const raw of [null, 5, "x", [], { manager: 5 }, { manager: null }]) {
      expect(readManagerConfig(() => raw)).toEqual({
        heartbeatSec: 900,
        dailyBudgetUsd: 20,
      });
    }
  });
});
