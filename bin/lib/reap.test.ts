import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendRow,
  registryPath,
  readRows,
  type ProcRegistryRow,
} from "./proc-registry";
import { reapRow, runRegistryReap, verifyRow, type ReapDeps } from "./reap";

// --- Fixtures -------------------------------------------------------------

function makeRow(overrides: Partial<ProcRegistryRow> = {}): ProcRegistryRow {
  return {
    pgid: 500,
    pid: 500,
    startEpoch: 1_000,
    slug: "reap-test",
    class: "default",
    argv: ["sh", "-c", "sleep 30"],
    recordedAt: 1_700_000_000_000,
    sessionPid: 400,
    sessionStartEpoch: 999,
    ...overrides,
  };
}

/**
 * Single ReapDeps construction site. `kill` defaults to a `vi.fn()` — the
 * recording spy every test inspects via `vi.mocked(deps.kill)` — so no test
 * hand-rolls its own kill-recording array.
 */
function fakeDeps(overrides: Partial<ReapDeps> = {}): ReapDeps {
  return {
    kill: vi.fn(),
    alive: () => false,
    sleepMs: () => {},
    startEpochOf: () => 1_000,
    groupMembers: () => [],
    nowMs: () => 0,
    selfPid: 99_999,
    selfPgid: 88_888,
    ...overrides,
  };
}

function esrchError(): NodeJS.ErrnoException {
  const e = new Error("kill ESRCH") as NodeJS.ErrnoException;
  e.code = "ESRCH";
  return e;
}

// --- verifyRow: unsafe-pgid guard -----------------------------------------

describe("verifyRow — unsafe-pgid guard", () => {
  it("refuses a row with pgid 0", () => {
    const deps = fakeDeps();
    const result = reapRow(makeRow({ pgid: 0 }), deps, { dryRun: false });
    expect(result.outcome).toBe("skipped-unsafe-pgid");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });

  it("refuses a row with pgid 1", () => {
    const deps = fakeDeps();
    const result = reapRow(makeRow({ pgid: 1 }), deps, { dryRun: false });
    expect(result.outcome).toBe("skipped-unsafe-pgid");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });

  it("refuses a row with pgid -1", () => {
    const deps = fakeDeps();
    const result = reapRow(makeRow({ pgid: -1 }), deps, { dryRun: false });
    expect(result.outcome).toBe("skipped-unsafe-pgid");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });

  it("refuses a row whose pgid equals deps.selfPgid", () => {
    const deps = fakeDeps({ selfPgid: 777 });
    const result = reapRow(makeRow({ pgid: 777 }), deps, { dryRun: false });
    expect(result.outcome).toBe("skipped-unsafe-pgid");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });

  it("refuses a row whose pid equals deps.selfPid", () => {
    const deps = fakeDeps({ selfPid: 555 });
    const result = reapRow(makeRow({ pid: 555 }), deps, { dryRun: false });
    expect(result.outcome).toBe("skipped-unsafe-pgid");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });

  it("refuses a row whose pgid equals deps.sessionPgid", () => {
    const deps = fakeDeps({ sessionPgid: 999 });
    const result = reapRow(makeRow({ pgid: 999 }), deps, { dryRun: false });
    expect(result.outcome).toBe("skipped-unsafe-pgid");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });

  it("refuses a row with pid <= 1", () => {
    const deps = fakeDeps();
    const result = reapRow(makeRow({ pid: 1 }), deps, { dryRun: false });
    expect(result.outcome).toBe("skipped-unsafe-pgid");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });

  it("refuses a default-class row when deps.selfPgid is null (the group path cannot be verified safe)", () => {
    const deps = fakeDeps({ selfPgid: null });
    const result = reapRow(makeRow({ class: "default" }), deps, {
      dryRun: false,
    });
    expect(result.outcome).toBe("skipped-unsafe-pgid");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });

  it("does NOT refuse an mcp-server row when deps.selfPgid is null — the guard's last clause is default-class only", () => {
    const deps = fakeDeps({ selfPgid: null, alive: () => true });
    const row = makeRow({
      class: "mcp-server",
      pid: 500,
      pgid: 500,
      startEpoch: 1_000,
    });
    expect(verifyRow(row, deps)).toEqual({ action: "signal" });
  });
});

// --- verifyRow: epoch verification ----------------------------------------

describe("verifyRow — epoch verification", () => {
  it("skips with skipped-epoch-mismatch when the row's startEpoch is null", () => {
    const deps = fakeDeps();
    const result = reapRow(makeRow({ startEpoch: null }), deps, {
      dryRun: false,
    });
    expect(result.outcome).toBe("skipped-epoch-mismatch");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });

  it("skips with skipped-epoch-mismatch when the live startEpochOf disagrees with the recorded value", () => {
    const deps = fakeDeps({ alive: () => true, startEpochOf: () => 42 });
    const result = reapRow(makeRow({ startEpoch: 1_000 }), deps, {
      dryRun: false,
    });
    expect(result.outcome).toBe("skipped-epoch-mismatch");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });

  it("skips with skipped-epoch-mismatch when startEpochOf returns null (ps unavailable)", () => {
    const deps = fakeDeps({ alive: () => true, startEpochOf: () => null });
    const result = reapRow(makeRow({ startEpoch: 1_000 }), deps, {
      dryRun: false,
    });
    expect(result.outcome).toBe("skipped-epoch-mismatch");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });
});

// --- verifyRow: already-dead ------------------------------------------------

describe("verifyRow — already-dead", () => {
  it("already-dead: alive(pid) false yields already-dead with zero kill calls", () => {
    const deps = fakeDeps({ alive: () => false });
    const result = reapRow(makeRow(), deps, { dryRun: false });
    expect(result.outcome).toBe("already-dead");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });
});

// --- verifyRow: foreign-member check ---------------------------------------

describe("verifyRow — foreign-member check", () => {
  const baseDeps = { alive: () => true, startEpochOf: () => 1_000 };

  it("skips with skipped-foreign-member when a group member is STRICTLY OLDER than the leader", () => {
    const deps = fakeDeps({
      alive: () => true,
      startEpochOf: (pid) => (pid === 501 ? 500 : 1_000), // leader=1000, member=500 (older)
      groupMembers: () => [500, 501],
    });
    const result = reapRow(makeRow(), deps, { dryRun: false });
    expect(result.outcome).toBe("skipped-foreign-member");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });

  it("skips with skipped-foreign-member when groupMembers returns null", () => {
    const deps = fakeDeps({ ...baseDeps, groupMembers: () => null });
    const result = reapRow(makeRow(), deps, { dryRun: false });
    expect(result.outcome).toBe("skipped-foreign-member");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });

  it("skips with skipped-foreign-member when groupMembers returns an empty array", () => {
    const deps = fakeDeps({ ...baseDeps, groupMembers: () => [] });
    const result = reapRow(makeRow(), deps, { dryRun: false });
    expect(result.outcome).toBe("skipped-foreign-member");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });

  it("skips with skipped-foreign-member when a member's startEpochOf is null", () => {
    const deps = fakeDeps({
      alive: () => true,
      startEpochOf: (pid) => (pid === 502 ? null : 1_000),
      groupMembers: () => [500, 502],
    });
    const result = reapRow(makeRow(), deps, { dryRun: false });
    expect(result.outcome).toBe("skipped-foreign-member");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });

  it("CONTRAST: a group whose only other member is NEWER than the leader is a legitimate descendant, reaped normally", () => {
    const deps = fakeDeps({
      alive: () => true,
      startEpochOf: (pid) => (pid === 501 ? 2_000 : 1_000), // member is newer
      groupMembers: () => [500, 501],
    });
    expect(verifyRow(makeRow(), deps)).toEqual({ action: "signal" });
  });

  it("an mcp-server row is NOT subjected to the foreign-member check even when its group is contaminated", () => {
    const deps = fakeDeps({
      alive: () => true,
      startEpochOf: () => 1_000,
      groupMembers: () => null, // would fail the check if the mcp-server path applied it
    });
    const row = makeRow({
      class: "mcp-server",
      pid: 500,
      pgid: 500,
      startEpoch: 1_000,
    });
    expect(verifyRow(row, deps)).toEqual({ action: "signal" });
  });
});

// --- verifyRow: dead-leader-live-group -------------------------------------

describe("verifyRow — dead leader with a live group", () => {
  it("a dead default-class leader whose group is still alive is skipped-dead-leader, NOT already-dead — and zero kill calls are made", () => {
    const deps = fakeDeps({
      // row.pid (the leader) is dead; -row.pgid (the group) is alive.
      alive: (target) => target === -500,
    });
    const row = makeRow({ pid: 500, pgid: 500, startEpoch: 1_000 });
    const result = reapRow(row, deps, { dryRun: false });
    expect(result.outcome).toBe("skipped-dead-leader");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });

  it("a dead default-class leader whose group is also dead is already-dead as before", () => {
    const deps = fakeDeps({ alive: () => false });
    const row = makeRow({ pid: 500, pgid: 500, startEpoch: 1_000 });
    const result = reapRow(row, deps, { dryRun: false });
    expect(result.outcome).toBe("already-dead");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });

  it("a dead mcp-server leader is already-dead — mcp-server rows have no group path to fall back to", () => {
    const deps = fakeDeps({ alive: () => false });
    const row = makeRow({
      class: "mcp-server",
      pid: 500,
      pgid: 500,
      startEpoch: 1_000,
    });
    const result = reapRow(row, deps, { dryRun: false });
    expect(result.outcome).toBe("already-dead");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });
});

// --- verifyRow: group-membership identity binding ---------------------------

describe("verifyRow — verified pid must itself be a member of the signalled group", () => {
  it("refuses with skipped-foreign-member when the epoch-verified row.pid is NOT in its own group's current membership", () => {
    const deps = fakeDeps({
      alive: () => true,
      startEpochOf: () => 1_000,
      // A decoy: the group has live, epoch-ordered members, but none of
      // them is the verified leader pid (500) — e.g. a corrupt/hand-edited
      // row pairing a verified pid against an unrelated pgid.
      groupMembers: () => [600, 601],
    });
    const result = reapRow(makeRow({ pid: 500, pgid: 500 }), deps, {
      dryRun: false,
    });
    expect(result.outcome).toBe("skipped-foreign-member");
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });

  it("a group member that merely EXITED between the ps snapshot and the epoch probe does not refuse the row", () => {
    const deps = fakeDeps({
      alive: (target) => target !== 502, // member 502 has exited; everyone else (incl. the leader) is alive
      startEpochOf: (pid) => (pid === 502 ? null : 1_000),
      groupMembers: () => [500, 502],
    });
    expect(verifyRow(makeRow({ pid: 500, pgid: 500 }), deps)).toEqual({
      action: "signal",
    });
  });
});

// --- reapRow: mcp-server class dispatch ------------------------------------

describe("reapRow — mcp-server class dispatch", () => {
  it("sends exactly one SIGTERM to the POSITIVE pid and reports reaped once alive() flips false", () => {
    let aliveCalls = 0;
    const deps = fakeDeps({
      alive: () => {
        aliveCalls++;
        return aliveCalls === 1; // alive for verifyRow's check, dead on the post-signal poll
      },
      startEpochOf: () => 1_000,
    });
    const row = makeRow({
      class: "mcp-server",
      pid: 500,
      pgid: 500,
      startEpoch: 1_000,
    });
    const result = reapRow(row, deps, { dryRun: false });
    expect(result.outcome).toBe("reaped");
    expect(result.signals).toEqual(["SIGTERM"]);
    const kill = vi.mocked(deps.kill);
    expect(kill.mock.calls).toEqual([[500, "SIGTERM"]]);
    expect(kill.mock.calls[0][0]).toBeGreaterThan(0);
  });

  // PR #491: a harder signal (or a group kill) skips the MCP server's own
  // shutdown() handler and orphans Chrome to PPID 1. This is the companion
  // assertion to bin/flow-browser-teardown.test.ts's source-text guard
  // ("the source file never contains 'SIGKILL'") — that guard can't be
  // reused verbatim against THIS file, since bin/lib/reap.ts legitimately
  // contains the SIGKILL literal for the unrelated `default` class, so the
  // no-escalation invariant is proven here over the recording kill spy
  // instead of over source text.
  it("never escalates even when alive() stays true through the whole bounded wait — exactly one recorded signal, no SIGKILL", () => {
    let clock = 0;
    const deps = fakeDeps({
      alive: () => true,
      startEpochOf: () => 1_000,
      sleepMs: () => {
        clock += 200;
      },
      nowMs: () => clock,
    });
    const row = makeRow({
      class: "mcp-server",
      pid: 500,
      pgid: 500,
      startEpoch: 1_000,
    });
    const result = reapRow(row, deps, { dryRun: false, graceMs: 500 });
    expect(result.outcome).toBe("still-alive");
    expect(result.signals).toEqual(["SIGTERM"]);
    const kill = vi.mocked(deps.kill);
    expect(kill.mock.calls).toHaveLength(1);
    expect(
      kill.mock.calls.every(
        ([target, signal]) => target > 0 && signal === "SIGTERM",
      ),
    ).toBe(true);
    expect(kill.mock.calls.some(([, signal]) => signal === "SIGKILL")).toBe(
      false,
    );
  });

  it("a non-ESRCH throw on the mcp-server pid yields failed with the message surfaced", () => {
    const deps = fakeDeps({
      alive: () => true,
      startEpochOf: () => 1_000,
      kill: vi.fn(() => {
        throw new Error("kill EPERM");
      }),
    });
    const row = makeRow({
      class: "mcp-server",
      pid: 500,
      pgid: 500,
      startEpoch: 1_000,
    });
    const result = reapRow(row, deps, { dryRun: false });
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("kill EPERM");
    expect(result.signals).toEqual([]);
  });

  it("ESRCH on the mcp-server pid's SIGTERM is a benign race yielding already-dead, not failed", () => {
    const deps = fakeDeps({
      alive: () => true,
      startEpochOf: () => 1_000,
      kill: vi.fn(() => {
        throw esrchError();
      }),
    });
    const row = makeRow({
      class: "mcp-server",
      pid: 500,
      pgid: 500,
      startEpoch: 1_000,
    });
    const result = reapRow(row, deps, { dryRun: false });
    expect(result.outcome).toBe("already-dead");
    expect(result.error).toBeUndefined();
    expect(result.signals).toEqual([]);
  });
});

// --- reapRow: default class dispatch ---------------------------------------

describe("reapRow — default class dispatch", () => {
  it("escalates SIGTERM then SIGKILL, both against the NEGATIVE pgid, SIGKILL only after the grace wait while still alive", () => {
    let clock = 0;
    const deps = fakeDeps({
      alive: () => true, // stays alive through both bounded waits
      startEpochOf: () => 1_000,
      groupMembers: () => [500],
      sleepMs: () => {
        clock += 200;
      },
      nowMs: () => clock,
    });
    const row = makeRow({ pid: 500, pgid: 500, startEpoch: 1_000 });
    const result = reapRow(row, deps, {
      dryRun: false,
      graceMs: 500,
      killWaitMs: 500,
    });
    expect(result.outcome).toBe("still-alive");
    expect(result.signals).toEqual(["SIGTERM", "SIGKILL"]);
    const kill = vi.mocked(deps.kill);
    expect(kill.mock.calls).toEqual([
      [-500, "SIGTERM"],
      [-500, "SIGKILL"],
    ]);
  });

  it("CONTRAST: a group that dies during the grace wait records SIGTERM only and returns reaped", () => {
    let aliveCalls = 0;
    const deps = fakeDeps({
      alive: () => {
        aliveCalls++;
        return aliveCalls === 1; // alive for verifyRow's liveness check, dead on the post-SIGTERM poll
      },
      startEpochOf: () => 1_000,
      groupMembers: () => [500],
    });
    const row = makeRow({ pid: 500, pgid: 500, startEpoch: 1_000 });
    const result = reapRow(row, deps, { dryRun: false, graceMs: 500 });
    expect(result.outcome).toBe("reaped");
    expect(result.signals).toEqual(["SIGTERM"]);
  });

  it("EPERM-alive on a group target: alive(-pgid) permanently true drives SIGTERM -> SIGKILL -> still-alive and terminates without hanging", () => {
    let clock = 0;
    const deps = fakeDeps({
      alive: () => true, // simulates EPERM-mapped-to-true, permanently
      startEpochOf: () => 1_000,
      groupMembers: () => [500],
      sleepMs: () => {
        clock += 200;
      },
      nowMs: () => clock,
    });
    const row = makeRow({ pid: 500, pgid: 500, startEpoch: 1_000 });
    const result = reapRow(row, deps, {
      dryRun: false,
      graceMs: 400,
      killWaitMs: 400,
    });
    expect(result.outcome).toBe("still-alive");
    expect(result.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

// --- reapRow: dry-run --------------------------------------------------------

describe("reapRow — dry-run", () => {
  it("a signallable row reports would-reap with empty signals and zero kill calls", () => {
    const deps = fakeDeps({
      alive: () => true,
      startEpochOf: () => 1_000,
      groupMembers: () => [500],
    });
    const row = makeRow({ pid: 500, pgid: 500, startEpoch: 1_000 });
    const result = reapRow(row, deps, { dryRun: true });
    expect(result.outcome).toBe("would-reap");
    expect(result.signals).toEqual([]);
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });

  it("a row that would be skipped still reports its skip outcome under dry-run", () => {
    const deps = fakeDeps();
    const result = reapRow(makeRow({ pgid: 0 }), deps, { dryRun: true });
    expect(result.outcome).toBe("skipped-unsafe-pgid");
    expect(result.signals).toEqual([]);
    expect(vi.mocked(deps.kill).mock.calls).toHaveLength(0);
  });
});

// --- reapRow: kill failure handling -----------------------------------------

describe("reapRow — kill failure handling", () => {
  it("ESRCH from the FIRST kill call is a benign race yielding already-dead, not failed", () => {
    const deps = fakeDeps({
      alive: () => true,
      startEpochOf: () => 1_000,
      groupMembers: () => [500],
      kill: vi.fn(() => {
        throw esrchError();
      }),
    });
    const row = makeRow({ pid: 500, pgid: 500, startEpoch: 1_000 });
    const result = reapRow(row, deps, { dryRun: false });
    expect(result.outcome).toBe("already-dead");
    expect(result.signals).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("a non-ESRCH throw yields failed with the message surfaced in error", () => {
    const deps = fakeDeps({
      alive: () => true,
      startEpochOf: () => 1_000,
      groupMembers: () => [500],
      kill: vi.fn(() => {
        throw new Error("kill EPERM");
      }),
    });
    const row = makeRow({ pid: 500, pgid: 500, startEpoch: 1_000 });
    const result = reapRow(row, deps, { dryRun: false });
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("kill EPERM");
  });

  it("ESRCH from the SECOND kill call (the escalation) is benign — the first signal already landed, so the outcome is reaped", () => {
    let callCount = 0;
    const deps = fakeDeps({
      alive: () => true, // stays alive through the (zero-length) grace wait, forcing escalation
      startEpochOf: () => 1_000,
      groupMembers: () => [500],
      kill: vi.fn(() => {
        callCount++;
        if (callCount === 2) throw esrchError();
      }),
    });
    const row = makeRow({ pid: 500, pgid: 500, startEpoch: 1_000 });
    const result = reapRow(row, deps, { dryRun: false, graceMs: 0 });
    expect(result.outcome).toBe("reaped");
    expect(result.signals).toEqual(["SIGTERM"]);
  });
});

// --- runRegistryReap: aggregation -------------------------------------------

describe("runRegistryReap", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-reap-test-"));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("undefined slug yields ran:false with skipReason no-slug", () => {
    const deps = fakeDeps();
    const result = runRegistryReap(undefined, deps, { dryRun: false, baseDir });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("no-slug");
    expect(result.rows).toEqual([]);
    expect(result.malformed).toBe(0);
  });

  it("an absent registry yields ran:false with skipReason no-rows", () => {
    const deps = fakeDeps();
    const result = runRegistryReap("nonexistent-slug", deps, {
      dryRun: false,
      baseDir,
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("no-rows");
  });

  it("a multi-row registry yields ran:true with all ten ReapOutcome keys zero-filled, and malformed propagated from readRows", () => {
    appendRow(
      makeRow({ pid: 500, pgid: 500, startEpoch: 1_000, slug: "multi-row" }),
      baseDir,
    );
    appendRow(
      makeRow({ pid: 1, pgid: 1, startEpoch: 1_000, slug: "multi-row" }),
      baseDir,
    );
    fs.appendFileSync(registryPath("multi-row", baseDir), "not-json-garbage\n");

    const deps = fakeDeps({ alive: () => false });
    const result = runRegistryReap("multi-row", deps, {
      dryRun: false,
      baseDir,
    });
    expect(result.ran).toBe(true);
    expect(result.slug).toBe("multi-row");
    expect(result.malformed).toBe(1);
    expect(Object.keys(result.counts).sort()).toEqual(
      [
        "already-dead",
        "failed",
        "reaped",
        "skipped-epoch-mismatch",
        "skipped-foreign-member",
        "skipped-dead-leader",
        "skipped-unsafe-pgid",
        "still-alive",
        "would-reap",
        "deadline-exceeded",
      ].sort(),
    );
    const total = Object.values(result.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(2);
    expect(result.counts["already-dead"]).toBe(1);
    expect(result.counts["skipped-unsafe-pgid"]).toBe(1);
  });

  it("registryDeadlineMs: rows reached after the aggregate deadline get deadline-exceeded, never signalled or silently dropped", () => {
    appendRow(
      makeRow({
        pid: 500,
        pgid: 500,
        startEpoch: 1_000,
        slug: "deadline-slug",
      }),
      baseDir,
    );
    appendRow(
      makeRow({
        pid: 501,
        pgid: 501,
        startEpoch: 1_000,
        slug: "deadline-slug",
      }),
      baseDir,
    );
    // Both rows are already-dead (alive always false), so verifyRow itself
    // never reads nowMs — the only nowMs calls come from the loop's own
    // per-row deadline check plus the one-time initial deadline calc. The
    // first two calls (init + row0's check) stay under the deadline; the
    // third (row1's check) reports past it.
    let calls = 0;
    const deps = fakeDeps({
      alive: () => false,
      nowMs: () => {
        calls++;
        return calls <= 2 ? 0 : 1_000_000;
      },
    });
    const result = runRegistryReap("deadline-slug", deps, {
      dryRun: false,
      baseDir,
      registryDeadlineMs: 100,
    });
    expect(result.ran).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].outcome).toBe("already-dead");
    expect(result.rows[1].outcome).toBe("deadline-exceeded");
    expect(result.rows[1].signals).toEqual([]);
    expect(result.counts["deadline-exceeded"]).toBe(1);
  });

  it("threads an injected readRows override instead of reading the real filesystem", () => {
    const stubRows: ProcRegistryRow[] = [
      makeRow({ pid: 500, pgid: 500, startEpoch: 1_000 }),
    ];
    const stubReadRows = vi.fn(() => ({ rows: stubRows, malformed: 3 }));
    const deps = fakeDeps({ alive: () => false });
    const result = runRegistryReap("whatever-slug", deps, {
      dryRun: false,
      baseDir,
      readRows: stubReadRows as unknown as typeof readRows,
    });
    expect(stubReadRows).toHaveBeenCalledWith("whatever-slug", baseDir);
    expect(result.ran).toBe(true);
    expect(result.malformed).toBe(3);
    expect(result.rows).toHaveLength(1);
  });
});
