import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendRunAttribution,
  mergeWithPrior,
  readLatestRunAttributions,
  type RunAttributionRow,
} from "./run-attribution-record";
import type {
  DelegatedCall,
  RunAttribution,
  SpawnAttribution,
  UnitAttribution,
} from "./run-attribution-types";
import { computeTotals } from "./run-attribution-unit";

let dir: string;
let log: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-attr-record-test-"));
  log = path.join(dir, "telemetry", "run-attribution.jsonl");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function unit(id: string, cost: number): UnitAttribution {
  return {
    session_id: id,
    model: "claude-opus-5-5",
    runs: [["claude-opus-5-5", "low", 2]],
    run_costs: [cost],
    turns: 2,
    tokens: { input: 1, cache_creation: 0, cache_read: 0, output: 0, total: 1 },
    cost_usd: cost,
  };
}

function spawn(id: string, parent: string, cost: number): SpawnAttribution {
  return {
    ...unit(id, cost),
    role: "coder",
    agent_type: null,
    parent_session_id: parent,
  };
}

function attribution(
  slug: string,
  sessions: UnitAttribution[],
  spawns: SpawnAttribution[] = [],
): RunAttribution {
  return {
    version: 1,
    slug,
    pr: null,
    repo: "/r",
    sessions,
    spawns,
    delegated: [],
    totals: computeTotals([...sessions, ...spawns], [], 0),
  };
}

const row = (a: RunAttribution, status = "merged"): RunAttributionRow => ({
  ...a,
  ts: "2026-11-06T00:00:00Z",
  status,
});

describe("run-attribution log", () => {
  it("appends rows and the latest row per slug wins", () => {
    appendRunAttribution(row(attribution("a", [unit("s1", 1)])), {
      logPath: log,
    });
    appendRunAttribution(row(attribution("b", [unit("s2", 2)])), {
      logPath: log,
    });
    appendRunAttribution(row(attribution("a", [unit("s3", 3)]), "gated"), {
      logPath: log,
    });
    const latest = readLatestRunAttributions({ logPath: log });
    expect([...latest.keys()].sort()).toEqual(["a", "b"]);
    expect(latest.get("a")?.sessions[0].session_id).toBe("s3");
    expect(latest.get("a")?.status).toBe("gated");
  });

  it("skips empty and garbled lines and reads a missing file as empty", () => {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(
      log,
      `\n{garbled\n${JSON.stringify({ version: 2, slug: "x" })}\n${JSON.stringify(row(attribution("ok", [unit("s", 1)])))}\n`,
    );
    expect([...readLatestRunAttributions({ logPath: log }).keys()]).toEqual([
      "ok",
    ]);
    expect(
      readLatestRunAttributions({ logPath: path.join(dir, "none.jsonl") }).size,
    ).toBe(0);
  });

  it("fails open when the log directory is unwritable", () => {
    const blocker = path.join(dir, "file");
    fs.writeFileSync(blocker, "x");
    expect(() =>
      appendRunAttribution(row(attribution("a", [])), {
        logPath: path.join(blocker, "sub", "log.jsonl"),
      }),
    ).not.toThrow();
  });
});

describe(mergeWithPrior, () => {
  it("returns the fresh attribution when there is no prior row", () => {
    const fresh = attribution("a", [unit("s1", 1)]);
    expect(mergeWithPrior(fresh, null)).toBe(fresh);
  });

  it("carries pruned sessions and their spawns over and recomputes totals", () => {
    const prior = attribution(
      "a",
      [unit("old", 10), unit("live", 1)],
      [spawn("agent-old", "old", 5), spawn("agent-live", "live", 2)],
    );
    const fresh = attribution(
      "a",
      [unit("live", 1)],
      [spawn("agent-live", "live", 2)],
    );
    const merged = mergeWithPrior(fresh, prior);
    expect(merged.sessions.map((s) => s.session_id)).toEqual(["old", "live"]);
    expect(merged.spawns.map((s) => s.session_id).sort()).toEqual([
      "agent-live",
      "agent-old",
    ]);
    expect(merged.totals.cost_usd).toBeCloseTo(18, 6);
    expect(merged.totals.by_model_effort[0].turns).toBe(8);
  });

  it("reads only the requested slugs", () => {
    appendRunAttribution(row(attribution("a", [unit("s1", 1)])), {
      logPath: log,
    });
    appendRunAttribution(row(attribution("b", [unit("s2", 2)])), {
      logPath: log,
    });
    const got = readLatestRunAttributions({
      logPath: log,
      slugs: new Set(["b"]),
    });
    expect([...got.keys()]).toEqual(["b"]);
  });

  it("does not double count a session present in both", () => {
    const a = attribution("a", [unit("s1", 1)]);
    expect(mergeWithPrior(a, a).totals.cost_usd).toBeCloseTo(1, 6);
  });

  it("ignores a prior row from an earlier run of a reused slug", () => {
    const prior = {
      ...attribution("a", [unit("old", 10)]),
      ts: "2026-10-01T00:00:00Z",
    };
    const fresh = attribution("a", [unit("new", 1)]);
    const merged = mergeWithPrior(fresh, prior, "2026-11-01T00:00:00Z");
    expect(merged.sessions.map((s) => s.session_id)).toEqual(["new"]);
    expect(merged.totals.cost_usd).toBeCloseTo(1, 6);
    const same = mergeWithPrior(fresh, prior, "2026-09-01T00:00:00Z");
    expect(same.sessions.map((s) => s.session_id)).toEqual(["old", "new"]);
  });

  it("ignores a prior row for a different PR", () => {
    const prior = { ...attribution("a", [unit("old", 10)]), pr: 1 };
    const fresh = { ...attribution("a", [unit("new", 1)]), pr: 2 };
    expect(mergeWithPrior(fresh, prior).sessions).toHaveLength(1);
  });

  it("carries a prior-only delegated call and does not double count a shared one", () => {
    const call = (ts: string, cost: number): DelegatedCall => ({
      event: "deliberate.call",
      task: null,
      model: "opus",
      effort: "high",
      ran: true,
      skip_reason: null,
      ts,
      cost_usd: cost,
    });
    const fresh = {
      ...attribution("a", [unit("s1", 1)]),
      delegated: [call("2026-11-06T01:00:00Z", 0.5)],
    };
    const prior = {
      ...fresh,
      delegated: [
        call("2026-11-06T01:00:00Z", 0.5),
        call("2026-11-06T00:00:00Z", 2),
      ],
    };
    const merged = mergeWithPrior(fresh, prior);
    expect(merged.delegated).toHaveLength(2);
    expect(merged.totals.cost_usd).toBeCloseTo(1 + 0.5 + 2, 6);
  });
});
