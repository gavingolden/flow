import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, REARM_MESSAGE, shouldBlock } from "./flow-manager-stop-guard";
import { writeManagerRecord } from "./lib/manager-record";
import { writeWaiter } from "./lib/manager-waiter";

let home: string;
const MGR = "2026-11-12T10:00:00.000Z";
const NOW = Date.parse("2026-11-12T10:05:00.000Z");
const env = { FLOW_MANAGER: "1" };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mstop-"));
  writeManagerRecord(
    {
      version: 1,
      window: "manager",
      startedAt: MGR,
      model: "opus",
      effort: "high",
      heartbeatSec: 900,
      stopWhenIdle: false,
      notices: false,
    },
    home,
  );
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const deps = (kill: (pid: number, s: 0) => void = () => {}) => ({
  home,
  now: () => NOW,
  kill,
});
const waiter = (
  startedAt: string,
  aliveAt = new Date(NOW - 5000).toISOString(),
) => writeWaiter({ version: 1, pid: 77, startedAt, aliveAt }, home);

describe("shouldBlock", () => {
  it("blocks when no waiter is recorded", () => {
    expect(shouldBlock({}, env, deps())).toBe(true);
  });

  it("allows a live waiter that started after the manager launched", () => {
    waiter("2026-11-12T10:01:00.000Z");
    expect(shouldBlock({}, env, deps())).toBe(false);
  });

  it("blocks a live waiter left over from before this manager launched", () => {
    waiter("2026-11-12T09:00:00.000Z");
    expect(shouldBlock({}, env, deps())).toBe(true);
  });

  it("blocks when the waiter pid is gone or its last pass is old", () => {
    waiter("2026-11-12T10:01:00.000Z");
    const gone = () => {
      throw Object.assign(new Error("x"), { code: "ESRCH" });
    };
    expect(shouldBlock({}, env, deps(gone))).toBe(true);
    waiter("2026-11-12T10:01:00.000Z", new Date(NOW - 600_000).toISOString());
    expect(shouldBlock({}, env, deps())).toBe(true);
  });

  it("does nothing outside the manager, without a record, or on the second stop of a turn", () => {
    expect(shouldBlock({}, {}, deps())).toBe(false);
    expect(shouldBlock({ stop_hook_active: true }, env, deps())).toBe(false);
    fs.rmSync(path.join(home, "manager.json"));
    expect(shouldBlock({}, env, deps())).toBe(false);
  });
});

describe("main", () => {
  it("exits 2 with the re-arm reminder", async () => {
    const errs: string[] = [];
    const code = await main(
      async () => "{}",
      env,
      deps(),
      (s) => errs.push(s),
    );
    expect(code).toBe(2);
    expect(errs.join("")).toContain(REARM_MESSAGE);
  });

  it("exits 0 for a manager with a live waiter", async () => {
    waiter("2026-11-12T10:01:00.000Z");
    expect(await main(async () => "{}", env, deps())).toBe(0);
  });
});
