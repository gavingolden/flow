import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteTurnTracking,
  readTurnTracking,
  STAGNATION_THRESHOLD,
  turnTrackingPath,
  TURN_BLOCK_LIMIT,
  writeTurnTracking,
  type TurnTracking,
} from "./stop-turn-tracking";

let dir!: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-turn-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(slug: string, overrides: Partial<TurnTracking> = {}): TurnTracking {
  return {
    slug,
    turnId: "2026-05-17T00:00:00.000Z",
    blockCount: 0,
    lastPhase: "starting",
    lastStopAt: "2026-05-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("stop-turn-tracking", () => {
  it("turnTrackingPath returns <state-dir>/<slug>.turn.json", () => {
    expect(turnTrackingPath("csv-export", dir)).toBe(path.join(dir, "csv-export.turn.json"));
  });

  it("readTurnTracking returns null on missing file", () => {
    expect(readTurnTracking("missing", dir)).toBeNull();
  });

  it("writeTurnTracking then readTurnTracking round-trips all five fields", () => {
    const t = fixture("demo", {
      turnId: "2026-05-17T00:00:00.000Z",
      blockCount: 2,
      lastPhase: "verifying",
      lastStopAt: "2026-05-17T00:01:00.000Z",
    });
    writeTurnTracking(t, dir);
    const got = readTurnTracking("demo", dir);
    expect(got).not.toBeNull();
    expect(got?.slug).toBe("demo");
    expect(got?.turnId).toBe("2026-05-17T00:00:00.000Z");
    expect(got?.blockCount).toBe(2);
    expect(got?.lastPhase).toBe("verifying");
    expect(got?.lastStopAt).toBe("2026-05-17T00:01:00.000Z");
  });

  it("deleteTurnTracking returns true when file exists and false when missing", () => {
    writeTurnTracking(fixture("a"), dir);
    expect(deleteTurnTracking("a", dir)).toBe(true);
    expect(readTurnTracking("a", dir)).toBeNull();
    expect(deleteTurnTracking("a", dir)).toBe(false);
  });

  it("exports TURN_BLOCK_LIMIT===1 and STAGNATION_THRESHOLD===2", () => {
    expect(TURN_BLOCK_LIMIT).toBe(1);
    expect(STAGNATION_THRESHOLD).toBe(2);
  });
});
