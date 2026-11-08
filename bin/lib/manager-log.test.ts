import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendManagerLog,
  logPath,
  readManagerLog,
  SEQUENCER_LOG_LOCK,
  type ManagerLogEntry,
} from "./manager-log";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mlog-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const entry = (over: Partial<ManagerLogEntry> = {}): ManagerLogEntry => ({
  ts: "2026-10-26T00:00:00.000Z",
  kind: "launch",
  repo: "flow",
  featureId: "f1",
  ...over,
});

describe("manager-log", () => {
  it("places the log at <home>/log.jsonl", () => {
    expect(logPath(dir)).toBe(path.join(dir, "log.jsonl"));
  });

  it("reads an absent log as empty", () => {
    expect(readManagerLog({ epic: "e" }, dir)).toEqual([]);
  });

  it("appends and reads entries in order, creating the directory", () => {
    const home = path.join(dir, "nested", "manager");
    appendManagerLog(entry({ epic: "e" }), { home });
    appendManagerLog(
      entry({ epic: "e", kind: "owner-needed", phase: "ci", window: "w1" }),
      { home },
    );
    const got = readManagerLog({ epic: "e" }, home);
    expect(got.map((e) => e.kind)).toEqual(["launch", "owner-needed"]);
    expect(got[1].phase).toBe("ci");
    expect(got[1].window).toBe("w1");
  });

  it("filters by epic, slug and repo; every entry carries repo", () => {
    appendManagerLog(entry({ epic: "e", slug: "s1" }), { home: dir });
    appendManagerLog(entry({ epic: "other", slug: "s2" }), { home: dir });
    appendManagerLog(
      entry({ kind: "grant", scope: "repo:flow", repo: "flow" }),
      { home: dir },
    );
    appendManagerLog(entry({ repo: "econ", slug: "s3" }), { home: dir });
    expect(readManagerLog({ epic: "e" }, dir).map((e) => e.slug)).toEqual([
      "s1",
    ]);
    expect(readManagerLog({ slug: "s2" }, dir)).toHaveLength(1);
    expect(readManagerLog({ repo: "econ" }, dir)).toHaveLength(1);
    expect(readManagerLog({ repo: "flow", epic: "e" }, dir)).toHaveLength(1);
    expect(
      readManagerLog({}, dir).every((e) => typeof e.repo === "string"),
    ).toBe(true);
  });

  it("round-trips an exec payload", () => {
    appendManagerLog(
      entry({
        epic: "e",
        kind: "exec-owner-reply",
        exec: {
          decisionId: "plan-1",
          reviewKind: "plan",
          ownerReply: "redirect",
          wrongApproval: true,
        },
      }),
      { home: dir },
    );
    expect(readManagerLog({ epic: "e" }, dir)[0].exec?.wrongApproval).toBe(
      true,
    );
  });

  it("round-trips a rollup line", () => {
    appendManagerLog(
      entry({
        kind: "rollup",
        month: "2026-07",
        counts: { launch: { none: 3 } },
      }),
      { home: dir },
    );
    expect(readManagerLog({ repo: "flow" }, dir)[0].counts).toEqual({
      launch: { none: 3 },
    });
  });

  it("releases the lock after each append", () => {
    appendManagerLog(entry(), { home: dir });
    expect(fs.existsSync(path.join(dir, "log.lock"))).toBe(false);
  });

  it("passes unknown kinds through and skips garbage lines", () => {
    appendManagerLog(entry(), { home: dir });
    fs.appendFileSync(
      logPath(dir),
      'not json\n{"ts":"t","kind":"future-kind"}\n{"no":"shape"}\n\n',
    );
    const kinds = readManagerLog({}, dir).map((e) => e.kind as string);
    expect(kinds).toEqual(["launch", "future-kind"]);
  });

  it("appendManagerLog is exported by exactly one non-test module under bin/", () => {
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
    expect(hits).toEqual(["lib/manager-log.ts"]);
  });
});

describe("sequencer lock wait", () => {
  it("a live foreign lock holder makes a sequencer append fail fast, not hang", () => {
    fs.writeFileSync(path.join(dir, "log.lock"), "1");
    const started = Date.now();
    expect(() =>
      appendManagerLog(entry(), { home: dir, lock: SEQUENCER_LOG_LOCK }),
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
