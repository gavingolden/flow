import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteTurnTracking,
  readTurnTracking,
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
  it("turnTrackingPath returns <state-dir>/turns/<slug>.json", () => {
    expect(turnTrackingPath("csv-export", dir)).toBe(
      path.join(dir, "turns", "csv-export.json"),
    );
  });

  it("readTurnTracking returns null on missing file", () => {
    expect(readTurnTracking("missing", dir)).toBeNull();
  });

  it("readTurnTracking returns null when JSON is corrupt", () => {
    fs.mkdirSync(path.join(dir, "turns"), { recursive: true });
    fs.writeFileSync(path.join(dir, "turns", "corrupt.json"), "{not json");
    expect(readTurnTracking("corrupt", dir)).toBeNull();
  });

  it("readTurnTracking returns null when JSON is missing the blockCount field", () => {
    fs.mkdirSync(path.join(dir, "turns"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "turns", "no-count.json"),
      JSON.stringify({
        slug: "no-count",
        turnId: "2026-05-17T00:00:00.000Z",
        lastPhase: "verifying",
        lastStopAt: "2026-05-17T00:00:00.000Z",
      }),
    );
    expect(readTurnTracking("no-count", dir)).toBeNull();
  });

  it("readTurnTracking returns null when blockCount is wrong-type", () => {
    fs.mkdirSync(path.join(dir, "turns"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "turns", "bad-count.json"),
      JSON.stringify({
        slug: "bad-count",
        turnId: "2026-05-17T00:00:00.000Z",
        blockCount: "not-a-number",
        lastPhase: "verifying",
        lastStopAt: "2026-05-17T00:00:00.000Z",
      }),
    );
    expect(readTurnTracking("bad-count", dir)).toBeNull();
  });

  it.each([
    ["slug", 42],
    ["turnId", null],
    ["lastPhase", false],
    ["lastStopAt", 12345],
  ])(
    "readTurnTracking returns null when required field %s has wrong type",
    (field, wrongValue) => {
      // f-coverage-3: predicate guards five required fields but only
      // blockCount had a wrong-type test. Cover the remaining four.
      fs.mkdirSync(path.join(dir, "turns"), { recursive: true });
      const base: Record<string, unknown> = {
        slug: "x",
        turnId: "t",
        blockCount: 0,
        lastPhase: "verifying",
        lastStopAt: "now",
      };
      base[field] = wrongValue;
      fs.writeFileSync(
        path.join(dir, "turns", `bad-${field}.json`),
        JSON.stringify(base),
      );
      expect(readTurnTracking(`bad-${field}`, dir)).toBeNull();
    },
  );

  it("readTurnTracking returns null for a JSON array root", () => {
    // f-coverage-1: `typeof x !== 'object' || x === null || Array.isArray(x)`
    // has three guard branches; cover the Array.isArray branch directly.
    fs.mkdirSync(path.join(dir, "turns"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "turns", "array-root.json"),
      JSON.stringify(["x", "t", 0, "verifying", "now"]),
    );
    expect(readTurnTracking("array-root", dir)).toBeNull();
  });

  it("readTurnTracking returns null for a JSON null root", () => {
    // f-coverage-1: cover the `x === null` guard branch.
    fs.mkdirSync(path.join(dir, "turns"), { recursive: true });
    fs.writeFileSync(path.join(dir, "turns", "null-root.json"), "null");
    expect(readTurnTracking("null-root", dir)).toBeNull();
  });

  it("readTurnTracking returns null for a JSON primitive root", () => {
    // f-coverage-1: cover the `typeof x !== 'object'` guard branch.
    fs.mkdirSync(path.join(dir, "turns"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "turns", "primitive-root.json"),
      JSON.stringify("just-a-string"),
    );
    expect(readTurnTracking("primitive-root", dir)).toBeNull();
  });

  it("writeTurnTracking creates the turns/ subdir on first write and round-trips all five fields", () => {
    const t = fixture("demo", {
      turnId: "2026-05-17T00:00:00.000Z",
      blockCount: 2,
      lastPhase: "verifying",
      lastStopAt: "2026-05-17T00:01:00.000Z",
    });
    expect(fs.existsSync(path.join(dir, "turns"))).toBe(false);
    writeTurnTracking(t, dir);
    expect(fs.existsSync(path.join(dir, "turns"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "turns", "demo.json"))).toBe(true);
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

  it("exports TURN_BLOCK_LIMIT===1", () => {
    expect(TURN_BLOCK_LIMIT).toBe(1);
  });
});
