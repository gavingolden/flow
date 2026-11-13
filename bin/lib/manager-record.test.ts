import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  managerRecordPath,
  readManagerRecord,
  writeManagerRecord,
  type ManagerRecord,
} from "./manager-record";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mrec-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const record: ManagerRecord = {
  version: 1,
  window: "manager",
  startedAt: "2026-11-12T00:00:00.000Z",
  model: "opus",
  effort: "medium",
  heartbeatSec: 900,
  stopWhenIdle: false,
  notices: true,
};

describe("manager record", () => {
  it("should round-trip a written record", () => {
    writeManagerRecord(record, dir);
    expect(readManagerRecord(dir)).toEqual(record);
  });

  it("should keep an optional lastSeenAt", () => {
    const seen = { ...record, lastSeenAt: "2026-11-12T01:00:00.000Z" };
    writeManagerRecord(seen, dir);
    expect(readManagerRecord(dir)).toEqual(seen);
  });

  it("should read a missing file as null", () => {
    expect(readManagerRecord(dir)).toBeNull();
  });

  it("should read malformed JSON and an invalid shape as null", () => {
    fs.writeFileSync(managerRecordPath(dir), "{not json");
    expect(readManagerRecord(dir)).toBeNull();
    fs.writeFileSync(
      managerRecordPath(dir),
      JSON.stringify({ ...record, model: "gpt" }),
    );
    expect(readManagerRecord(dir)).toBeNull();
    fs.writeFileSync(
      managerRecordPath(dir),
      JSON.stringify({ ...record, heartbeatSec: "900" }),
    );
    expect(readManagerRecord(dir)).toBeNull();
  });
});
