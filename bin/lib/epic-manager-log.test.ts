import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendManagerLog,
  managerDir,
  readManagerLog,
  SEQUENCER_LOG_LOCK,
  type ManagerLogEntry,
} from "./epic-manager-log";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "emlog-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const entry = (over: Partial<ManagerLogEntry> = {}): ManagerLogEntry => ({
  ts: "2026-10-26T00:00:00.000Z",
  kind: "launch",
  featureId: "f1",
  ...over,
});

describe("epic-manager-log", () => {
  it("places the directory under <state>/managers/<epic>", () => {
    expect(managerDir("e", dir)).toBe(path.join(dir, "managers", "e"));
  });

  it("reads an absent log as empty", () => {
    expect(readManagerLog("e", dir)).toEqual([]);
  });

  it("appends and reads entries in order, creating the directory", () => {
    appendManagerLog("e", entry(), dir);
    appendManagerLog(
      "e",
      entry({ kind: "owner-needed", phase: "ci", window: "w1" }),
      dir,
    );
    const got = readManagerLog("e", dir);
    expect(got.map((e) => e.kind)).toEqual(["launch", "owner-needed"]);
    expect(got[1].phase).toBe("ci");
    expect(got[1].window).toBe("w1");
  });

  it("round-trips an exec payload", () => {
    appendManagerLog(
      "e",
      entry({
        kind: "exec-owner-reply",
        exec: {
          decisionId: "plan-1",
          reviewKind: "plan",
          ownerReply: "redirect",
          wrongApproval: true,
        },
      }),
      dir,
    );
    expect(readManagerLog("e", dir)[0].exec?.wrongApproval).toBe(true);
  });

  it("releases the lock after each append", () => {
    appendManagerLog("e", entry(), dir);
    expect(fs.existsSync(path.join(managerDir("e", dir), "log.lock"))).toBe(
      false,
    );
  });

  it("passes unknown kinds through and skips garbage lines", () => {
    appendManagerLog("e", entry(), dir);
    const file = path.join(managerDir("e", dir), "log.jsonl");
    fs.appendFileSync(
      file,
      'not json\n{"ts":"t","kind":"future-kind"}\n{"no":"shape"}\n\n',
    );
    const kinds = readManagerLog("e", dir).map((e) => e.kind as string);
    expect(kinds).toEqual(["launch", "future-kind"]);
  });

  it("is exported by exactly one non-test module under bin/", () => {
    const binDir = path.resolve(__dirname, "..");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.name === "node_modules" || ent.name === "__fixtures__")
          continue;
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
          if (
            /export function appendManagerLog\b/.test(
              fs.readFileSync(p, "utf8"),
            )
          )
            hits.push(path.relative(binDir, p));
        }
      }
    };
    walk(binDir);
    expect(hits).toEqual(["lib/epic-manager-log.ts"]);
  });
});

describe("sequencer lock wait", () => {
  it("a live foreign lock holder makes a sequencer append fail fast, not hang", () => {
    const d = managerDir("e", dir);
    fs.mkdirSync(d, { recursive: true });
    // PID 1 is always alive, so the lock is never reclaimed as stale.
    fs.writeFileSync(path.join(d, "log.lock"), "1");
    const started = Date.now();
    expect(() =>
      appendManagerLog("e", entry(), dir, SEQUENCER_LOG_LOCK),
    ).toThrow(/lock/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("zero model calls", () => {
  it("no sequencer module names claude or flow-claude-headless as a quoted command string", () => {
    const lib = path.resolve(__dirname);
    const files = fs
      .readdirSync(lib)
      .filter(
        (f) => /^epic-manage(r)?(-.+)?\.ts$/.test(f) && !f.endsWith(".test.ts"),
      );
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const text = fs.readFileSync(path.join(lib, f), "utf8");
      expect(text, f).not.toMatch(/["'](claude|flow-claude-headless)["']/);
    }
  });
});
