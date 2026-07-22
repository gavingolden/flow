import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendLaunchRecord, type LaunchRecord } from "./launch-log";

const record: LaunchRecord = {
  slug: "csv-export",
  at: "2026-07-22T00:00:00.000Z",
  attempts: 2,
  outcome: "started",
  launcher: "tmux",
};

describe("appendLaunchRecord", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-launch-log-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appends exactly one JSON line, creating parent dirs", () => {
    const logPath = path.join(dir, "nested", "launch.jsonl");
    appendLaunchRecord(record, logPath);
    const lines = fs.readFileSync(logPath, "utf8").split("\n");
    expect(lines).toHaveLength(2); // one record + trailing newline
    expect(JSON.parse(lines[0])).toEqual(record);
  });

  it("accumulates lines across multiple appends", () => {
    const logPath = path.join(dir, "launch.jsonl");
    appendLaunchRecord(record, logPath);
    appendLaunchRecord({ ...record, attempts: 1 }, logPath);
    const lines = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).attempts).toBe(1);
  });

  it("fail-open: an unwritable path returns normally without throwing", () => {
    const asFile = path.join(dir, "not-a-dir");
    fs.writeFileSync(asFile, "");
    const logPath = path.join(asFile, "sub", "launch.jsonl");
    expect(() => appendLaunchRecord(record, logPath)).not.toThrow();
  });
});
