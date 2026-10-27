import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { managerDir } from "./epic-manager-log";
import {
  claimManager,
  listManagers,
  managerHealth,
  managerWindowName,
  readManager,
  removeManager,
  writeManager,
  type ManagerState,
} from "./epic-manage-state";

let stateDir!: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-manage-state-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-10-26T00:00:00Z");

function state(over: Partial<ManagerState> = {}): ManagerState {
  return {
    version: 1,
    epicSlug: "e",
    repo: "/repo",
    window: "manage-e",
    pid: 4242,
    procStartedAt: 1000,
    startedAt: "2026-10-26T00:00:00Z",
    heartbeatAt: "2026-10-26T00:00:00Z",
    pollMs: 3000,
    autonomy: "observe",
    model: "opus",
    effort: "high",
    featureFallback: {},
    status: "running",
    launching: null,
    ...over,
  };
}

const alive = { isAlive: () => true, pidStartEpoch: () => 1000 };

describe("manager.json round-trip", () => {
  it("names the window manage-<slug>", () => {
    expect(managerWindowName("e")).toBe("manage-e");
  });

  it("writes atomically under <managers>/<slug>/manager.json and reads it back", () => {
    writeManager(state(), stateDir);
    const file = path.join(managerDir("e", stateDir), "manager.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(["manager.json"]);
    expect(readManager("e", stateDir)).toEqual(state());
  });

  it("returns null for a missing, corrupt, or wrong-shaped file", () => {
    expect(readManager("e", stateDir)).toBeNull();
    const dir = managerDir("e", stateDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manager.json"), "{oops");
    expect(readManager("e", stateDir)).toBeNull();
    fs.writeFileSync(path.join(dir, "manager.json"), '{"version":2}');
    expect(readManager("e", stateDir)).toBeNull();
  });

  it("round-trips a null procStartedAt and an in-flight launching marker", () => {
    const s = state({
      procStartedAt: null,
      launching: { featureId: "f1", startedAt: "2026-10-26T00:00:01Z" },
    });
    writeManager(s, stateDir);
    expect(readManager("e", stateDir)).toEqual(s);
  });

  it("removeManager deletes the file and tolerates absence", () => {
    writeManager(state(), stateDir);
    removeManager("e", stateDir);
    expect(readManager("e", stateDir)).toBeNull();
    expect(() => removeManager("e", stateDir)).not.toThrow();
  });

  it("listManagers lists every valid manager and skips junk", () => {
    writeManager(state(), stateDir);
    writeManager(state({ epicSlug: "f", window: "manage-f" }), stateDir);
    fs.mkdirSync(managerDir("junk", stateDir), { recursive: true });
    fs.writeFileSync(
      path.join(managerDir("junk", stateDir), "manager.json"),
      "x",
    );
    expect(
      listManagers(stateDir)
        .map((m) => m.epicSlug)
        .sort(),
    ).toEqual(["e", "f"]);
    expect(listManagers(path.join(stateDir, "absent"))).toEqual([]);
  });
});

describe("claimManager (singleton)", () => {
  it("claims when no record exists", () => {
    expect(claimManager(state(), T0, alive, stateDir)).toEqual({ ok: true });
    expect(readManager("e", stateDir)?.pid).toBe(4242);
  });

  it("refuses while the existing record's process is live", () => {
    writeManager(state({ pid: 1 }), stateDir);
    const r = claimManager(state({ pid: 2 }), T0, alive, stateDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.existing.pid).toBe(1);
    expect(readManager("e", stateDir)?.pid).toBe(1);
  });

  it("replaces a record whose process is gone", () => {
    writeManager(state({ pid: 1 }), stateDir);
    const dead = { isAlive: () => false };
    expect(claimManager(state({ pid: 2 }), T0, dead, stateDir).ok).toBe(true);
    expect(readManager("e", stateDir)?.pid).toBe(2);
  });
});

describe("managerHealth", () => {
  it("live within three poll intervals", () => {
    expect(managerHealth(state(), T0 + 8_000, alive)).toEqual({
      kind: "live",
      heartbeatAgeMs: 8_000,
    });
  });

  it("stalled beyond three poll intervals", () => {
    expect(managerHealth(state(), T0 + 9_001, alive)).toEqual({
      kind: "stalled",
      heartbeatAgeMs: 9_001,
    });
  });

  it("stopped when the pid is gone", () => {
    expect(managerHealth(state(), T0, { isAlive: () => false })).toEqual({
      kind: "stopped",
    });
  });

  it("stopped when the pid was recycled onto another process", () => {
    expect(
      managerHealth(state(), T0, {
        isAlive: () => true,
        pidStartEpoch: () => 5,
      }),
    ).toEqual({ kind: "stopped" });
  });

  it("a done manager parked on its final board is never stalled", () => {
    expect(
      managerHealth(state({ status: "done" }), T0 + 3_600_000, alive).kind,
    ).toBe("live");
  });

  it("a null procStartedAt degrades to a bare pid-alive check", () => {
    const s = state({ procStartedAt: null });
    expect(managerHealth(s, T0, { isAlive: () => true }).kind).toBe("live");
    expect(managerHealth(s, T0, { isAlive: () => false }).kind).toBe("stopped");
  });
});
