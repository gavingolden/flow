import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendManagerLog,
  managerDir,
  readManagerLog,
  type ManagerLogEntry,
} from "./epic-manager-log";

let stateDir!: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-manager-log-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const entry = (over: Partial<ManagerLogEntry> = {}): ManagerLogEntry => ({
  ts: "2026-10-26T00:00:00Z",
  kind: "started",
  ...over,
});

describe("managerDir", () => {
  it("is <stateDir>/managers/<epic>", () => {
    expect(managerDir("my-epic", "/s")).toBe(
      path.join("/s", "managers", "my-epic"),
    );
  });
});

describe("appendManagerLog / readManagerLog", () => {
  it("round-trips entries in append order", () => {
    appendManagerLog("e", entry(), stateDir);
    appendManagerLog(
      "e",
      entry({ kind: "launch", featureId: "f1", slug: "f1", pr: 3 }),
      stateDir,
    );
    const got = readManagerLog("e", stateDir);
    expect(got.map((g) => g.kind)).toEqual(["started", "launch"]);
    expect(got[1]).toMatchObject({ featureId: "f1", slug: "f1", pr: 3 });
  });

  it("returns [] when no log exists", () => {
    expect(readManagerLog("nope", stateDir)).toEqual([]);
  });

  it("skips unparseable and shapeless lines", () => {
    appendManagerLog("e", entry(), stateDir);
    const file = path.join(managerDir("e", stateDir), "log.jsonl");
    fs.appendFileSync(file, '{not json\n[1,2]\n{"kind":"started"}\n\n');
    appendManagerLog("e", entry({ kind: "stopped" }), stateDir);
    expect(readManagerLog("e", stateDir).map((g) => g.kind)).toEqual([
      "started",
      "stopped",
    ]);
  });

  it("passes an unknown kind through unchanged", () => {
    const file = path.join(managerDir("e", stateDir), "log.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ ts: "t", kind: "future-kind", extra: 1 }) + "\n",
    );
    expect(readManagerLog("e", stateDir)).toEqual([
      { ts: "t", kind: "future-kind", extra: 1 },
    ]);
  });

  it("locks on <dir>/log.lock and leaves no lock file behind", () => {
    appendManagerLog("e", entry(), stateDir);
    expect(
      fs.existsSync(path.join(managerDir("e", stateDir), "log.lock")),
    ).toBe(false);
  });

  it("a live foreign lock holder makes the append fail fast (short timeout), not hang", () => {
    const dir = managerDir("e", stateDir);
    fs.mkdirSync(dir, { recursive: true });
    // PID 1 is always alive, so the lock is never reclaimed as stale.
    fs.writeFileSync(path.join(dir, "log.lock"), "1");
    const started = Date.now();
    expect(() => appendManagerLog("e", entry(), stateDir)).toThrow(/lock/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("single log module", () => {
  it("exactly one non-test module under bin/ exports appendManagerLog", () => {
    const binDir = path.resolve(__dirname, "..");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules" && e.name !== "__snapshots__") walk(p);
        } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
          const text = fs.readFileSync(p, "utf8");
          if (/export (function|const) appendManagerLog\b/.test(text)) {
            hits.push(path.relative(binDir, p));
          }
        }
      }
    };
    walk(binDir);
    expect(hits).toEqual([path.join("lib", "epic-manager-log.ts")]);
  });
});
