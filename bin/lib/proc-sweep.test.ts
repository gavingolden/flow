import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listRegistrySlugs,
  selectDeadSessionRows,
  sessionVerdictFor,
  type SweepDeps,
} from "./proc-sweep";
import type { ProcRegistryRow } from "./proc-registry";
import type { PipelineState } from "./state";
import type { Liveness } from "./liveness";

function makeRow(overrides: Partial<ProcRegistryRow> = {}): ProcRegistryRow {
  return {
    pgid: 500,
    pid: 500,
    startEpoch: 1_000,
    slug: "sweep-test",
    class: "default",
    argv: ["sh", "-c", "sleep 30"],
    recordedAt: 1_700_000_000_000,
    sessionPid: 400,
    sessionStartEpoch: 999,
    ...overrides,
  };
}

/** A stub `livenessOf` that returns a per-pid-fixed verdict from a lookup
 * table, keyed by `pid` — lets tests drive the state-channel and
 * wrapper-channel verdicts independently without a real liveness probe. */
function fakeLivenessOf(
  table: Record<number, Liveness>,
): (s: { pid?: number; procStartedAt?: number }) => Liveness {
  return (s) => {
    if (s.pid === undefined || s.procStartedAt === undefined) return "unknown";
    return table[s.pid] ?? "unknown";
  };
}

describe("listRegistrySlugs", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-proc-sweep-test-"));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("enumerates *.jsonl basenames (extension stripped), skipping entries that fail isValidSlug", () => {
    const procs = path.join(baseDir, "procs");
    fs.mkdirSync(procs, { recursive: true });
    fs.writeFileSync(path.join(procs, "valid-slug.jsonl"), "");
    fs.writeFileSync(path.join(procs, "Also_Invalid.jsonl"), "");
    fs.writeFileSync(path.join(procs, "not-a-registry-file.txt"), "");

    const slugs = listRegistrySlugs(baseDir).sort();
    expect(slugs).toEqual(["valid-slug"]);
  });

  it("returns [] on a missing directory without throwing", () => {
    expect(() =>
      listRegistrySlugs(path.join(baseDir, "nonexistent")),
    ).not.toThrow();
    expect(listRegistrySlugs(path.join(baseDir, "nonexistent"))).toEqual([]);
  });

  it("returns [] on an unreadable directory (procsDir resolves through a plain file) without throwing", () => {
    // procsDir(baseDir) joins "procs" onto baseDir. Passing a plain FILE's
    // path as baseDir makes the resolved procs path try to readdir through
    // a non-directory path segment — an ENOTDIR-shaped failure — which must
    // still degrade to [] rather than throw.
    const bogus = path.join(baseDir, "procs-is-a-file");
    fs.writeFileSync(bogus, "not a directory");
    expect(() => listRegistrySlugs(bogus)).not.toThrow();
    expect(listRegistrySlugs(bogus)).toEqual([]);
  });
});

describe("sessionVerdictFor — B4 positive-evidence rule", () => {
  const baseDeps = (
    stateTable: Record<string, PipelineState | null>,
    livenessTable: Record<number, Liveness>,
  ): SweepDeps => ({
    readState: (slug) => stateTable[slug] ?? null,
    livenessOf: fakeLivenessOf(livenessTable) as SweepDeps["livenessOf"],
  });

  const state = (pid: number): PipelineState =>
    ({
      slug: "sweep-test",
      phase: "implementing",
      repo: "/r",
      updatedAt: "2026-01-01T00:00:00Z",
      pid,
      procStartedAt: 1,
    }) as PipelineState;

  it("returns 'alive' when the STATE channel is alive and the WRAPPER channel is dead", () => {
    const row = makeRow({ sessionPid: 400 });
    const deps = baseDeps(
      { "sweep-test": state(300) },
      { 300: "alive", 400: "dead" },
    );
    expect(sessionVerdictFor(row, deps)).toBe("alive");
  });

  it("returns 'alive' when the STATE channel is dead and the WRAPPER channel is alive", () => {
    const row = makeRow({ sessionPid: 400 });
    const deps = baseDeps(
      { "sweep-test": state(300) },
      { 300: "dead", 400: "alive" },
    );
    expect(sessionVerdictFor(row, deps)).toBe("alive");
  });

  it("returns 'dead' when stateVerdict is 'dead' and wrapperVerdict is not 'alive'", () => {
    const row = makeRow({ sessionPid: 400 });
    const deps = baseDeps(
      { "sweep-test": state(300) },
      { 300: "dead", 400: "stale" },
    );
    expect(sessionVerdictFor(row, deps)).toBe("dead");
  });

  it("returns 'dead' when stateVerdict is 'stale' and wrapperVerdict is not 'alive'", () => {
    const row = makeRow({ sessionPid: 400 });
    const deps = baseDeps(
      { "sweep-test": state(300) },
      { 300: "stale", 400: "dead" },
    );
    expect(sessionVerdictFor(row, deps)).toBe("dead");
  });

  it("THE B4 REGRESSION TEST — state 'unknown' (no state file) + wrapper 'stale'/'dead' returns 'unknown', NOT 'dead'. This is the live-session-whose-wrapper-was-killed case the rejected B3 rule (neither-alive-and-at-least-one-dead) would have wrongly signalled.", () => {
    const rowStale = makeRow({ sessionPid: 400 });
    const depsStale = baseDeps({}, { 400: "stale" }); // no state entry at all
    expect(sessionVerdictFor(rowStale, depsStale)).toBe("unknown");

    const rowDead = makeRow({ sessionPid: 401 });
    const depsDead = baseDeps({}, { 401: "dead" });
    expect(sessionVerdictFor(rowDead, depsDead)).toBe("unknown");
  });

  it("returns 'unknown' when both channels are unknown", () => {
    const row = makeRow({ sessionPid: null, sessionStartEpoch: null });
    const deps = baseDeps({}, {});
    expect(sessionVerdictFor(row, deps)).toBe("unknown");
  });
});

describe("selectDeadSessionRows", () => {
  const state = (pid: number): PipelineState =>
    ({
      slug: "irrelevant",
      phase: "implementing",
      repo: "/r",
      updatedAt: "2026-01-01T00:00:00Z",
      pid,
      procStartedAt: 1,
    }) as PipelineState;

  it("partitions rows into dead/alive/unknown and populates reason + ownPidAlive on every row", () => {
    const rows: ProcRegistryRow[] = [
      makeRow({ slug: "alive-slug", pid: 10, sessionPid: 110 }),
      makeRow({ slug: "dead-slug", pid: 20, sessionPid: 120 }),
      makeRow({ slug: "no-state-slug", pid: 30, sessionPid: 130 }),
      makeRow({ slug: "no-wrapper-slug", pid: 40, sessionPid: null }),
    ];
    const deps: SweepDeps = {
      readState: (slug) => {
        if (slug === "alive-slug") return state(210);
        if (slug === "dead-slug") return state(220);
        if (slug === "no-wrapper-slug") return state(240);
        return null;
      },
      livenessOf: fakeLivenessOf({
        210: "alive",
        220: "dead",
        110: "stale",
        120: "stale",
        130: "stale",
        240: "unknown",
      }) as SweepDeps["livenessOf"],
      livenessDeps: {
        isAlive: (pid) => pid === 10 || pid === 20 || pid === 30 || pid === 40,
      },
    };

    const { dead, alive, unknown } = selectDeadSessionRows(rows, deps);

    expect(alive.map((c) => c.row.slug)).toEqual(["alive-slug"]);
    expect(dead.map((c) => c.row.slug)).toEqual(["dead-slug"]);
    expect(unknown.map((c) => c.row.slug).sort()).toEqual(
      ["no-state-slug", "no-wrapper-slug"].sort(),
    );

    for (const c of [...dead, ...alive, ...unknown]) {
      expect(typeof c.ownPidAlive).toBe("boolean");
    }
    const noState = unknown.find((c) => c.row.slug === "no-state-slug")!;
    expect(noState.reason).toBe("no-state-file");
    const noWrapper = unknown.find((c) => c.row.slug === "no-wrapper-slug")!;
    expect(noWrapper.reason).toBe("wrapper-unreadable");
  });

  it("populates reason 'state-unknown' when a state file exists, a sessionPid was recorded, but the state's own liveness is still unknown", () => {
    const rows: ProcRegistryRow[] = [
      makeRow({ slug: "legacy-state-slug", pid: 50, sessionPid: 150 }),
    ];
    const deps: SweepDeps = {
      readState: () => state(0), // present, but this fixture's own pid/procStartedAt resolve "unknown" below
      livenessOf: ((s: { pid?: number; procStartedAt?: number }) =>
        s.pid === 150 ? "stale" : "unknown") as SweepDeps["livenessOf"],
      livenessDeps: { isAlive: () => false },
    };
    const { unknown } = selectDeadSessionRows(rows, deps);
    expect(unknown).toHaveLength(1);
    expect(unknown[0].reason).toBe("state-unknown");
  });

  it("batching: an injected livenessDeps.pidStartEpoch spy is called at most once per distinct LIVE pid across many rows (non-zero denominator: >=2 rows share a pid)", () => {
    const sharedSessionPid = 999;
    const rows: ProcRegistryRow[] = [
      makeRow({ slug: "shared-a", pid: 1, sessionPid: sharedSessionPid }),
      makeRow({ slug: "shared-b", pid: 2, sessionPid: sharedSessionPid }),
      makeRow({ slug: "shared-c", pid: 3, sessionPid: sharedSessionPid }),
    ];
    const pidStartEpochSpy = vi.fn<(pid: number) => number>(() => 42);
    const deps: SweepDeps = {
      readState: () => null,
      // The real livenessOf is used here (not a fake), so it genuinely
      // drives pidStartEpoch only for pids isAlive() reports alive.
      livenessDeps: {
        isAlive: (pid) => pid === sharedSessionPid,
        pidStartEpoch: pidStartEpochSpy,
      },
    };
    selectDeadSessionRows(rows, deps);
    const callsForSharedPid = pidStartEpochSpy.mock.calls.filter(
      (c) => c[0] === sharedSessionPid,
    );
    expect(callsForSharedPid.length).toBeGreaterThanOrEqual(1);
    expect(callsForSharedPid.length).toBe(1);
  });
});
