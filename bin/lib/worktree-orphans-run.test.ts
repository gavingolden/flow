import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readState, writeState } from "./state";
import {
  findBusyOutsideWorktrees,
  snapshotOrphanDeps,
  sweepBusyLeftovers,
  recordOrphanStops,
  renderOrphanSweepLine,
  stoppedCount,
  sweepWorktreeOrphans,
  type OrphanSweepDeps,
} from "./worktree-orphans-run";
import {
  canonicalizeWorktree,
  parseDurationSec,
  parseLsofCwd,
  parsePsTable,
  stripDeletedSuffix,
} from "./worktree-orphans-ps";
import type { OrphanProc } from "./worktree-orphans";

const WT = "/x/flow-foo";

function proc(over: Partial<OrphanProc> & { pid: number }): OrphanProc {
  return {
    ppid: 1,
    pgid: 9000,
    uid: 501,
    tty: null,
    ageSec: 600,
    cpuSec: 600,
    command: "sleep 100",
    cwd: null,
    ...over,
  };
}

type Harness = {
  deps: OrphanSweepDeps;
  signals: Array<[number, string]>;
  cwdCalls: number[][];
  clock: { ms: number };
};

function harness(
  procs: OrphanProc[] | undefined,
  o: {
    cwd?: Record<number, string>;
    stubborn?: number[];
    recycleAfterTerm?: number[];
    worktrees?: string[];
  } = {},
): Harness {
  const dead = new Set<number>();
  const epoch = new Map<number, number>(
    (procs ?? []).map((p) => [p.pid, 1000 + p.pid]),
  );
  const signals: Array<[number, string]> = [];
  const cwdCalls: number[][] = [];
  const clock = { ms: 0 };
  const deps: OrphanSweepDeps = {
    listProcs: () => procs,
    cwdOf: (pids) => {
      cwdCalls.push(pids);
      return new Map(
        pids.flatMap((p) => (o.cwd?.[p] ? [[p, o.cwd[p]] as const] : [])),
      );
    },
    registered: () => ({ pids: new Set(), pgids: new Set() }),
    worktrees: () => o.worktrees ?? [WT],
    startEpochOf: (pid) => (dead.has(pid) ? null : (epoch.get(pid) ?? null)),
    kill: (pid, sig) => {
      signals.push([pid, sig]);
      if (sig === "SIGKILL" || !o.stubborn?.includes(pid)) dead.add(pid);
      if (o.recycleAfterTerm?.includes(pid)) epoch.set(pid, 5);
    },
    alive: (pid) => !dead.has(pid),
    sleepMs: (ms) => {
      clock.ms += ms;
    },
    nowMs: () => clock.ms,
    selfUid: 501,
  };
  return { deps, signals, cwdCalls, clock };
}

const run = { worktree: WT, act: true, busyOnly: false };

describe("sweepWorktreeOrphans", () => {
  it("should TERM then KILL a process that ignores TERM", () => {
    const h = harness([proc({ pid: 10 })], {
      cwd: { 10: WT },
      stubborn: [10],
    });
    const r = sweepWorktreeOrphans(h.deps, run);
    expect(h.signals).toEqual([
      [10, "SIGTERM"],
      [10, "SIGKILL"],
    ]);
    expect(r.killed).toEqual([10]);
    expect(r.stillAlive).toEqual([]);
    expect(stoppedCount(r)).toBe(1);
  });

  it("should skip a pid whose start time changed (recycled) before KILL", () => {
    const h = harness([proc({ pid: 10 })], {
      cwd: { 10: WT },
      stubborn: [10],
      recycleAfterTerm: [10],
    });
    const r = sweepWorktreeOrphans(h.deps, run);
    expect(h.signals).toEqual([[10, "SIGTERM"]]);
    expect(r.skippedRecycled).toEqual([10]);
  });

  it("should not report a recycled pid as a survivor", () => {
    const h = harness([proc({ pid: 10 })], {
      cwd: { 10: WT },
      stubborn: [10],
      recycleAfterTerm: [10],
    });
    const r = sweepWorktreeOrphans(h.deps, run);
    expect(r.skippedRecycled).toEqual([10]);
    expect(r.stillAlive).toEqual([]);
  });

  it("should never signal a pid whose start time was unreadable at selection", () => {
    const h = harness([proc({ pid: 10 })], { cwd: { 10: WT } });
    h.deps.startEpochOf = () => null;
    const r = sweepWorktreeOrphans(h.deps, run);
    expect(h.signals).toEqual([]);
    expect(r.skippedRecycled).toEqual([10]);
  });

  it("should not read pipeline states when there is no candidate", () => {
    const h = harness([proc({ pid: 10, ppid: 77 })], { cwd: { 10: WT } });
    const wts = vi.fn(() => [WT]);
    h.deps.worktrees = wts;
    sweepWorktreeOrphans(h.deps, run);
    expect(wts).not.toHaveBeenCalled();
  });

  it("should stop reading start times and signalling once the deadline passes", () => {
    const h = harness([proc({ pid: 10 }), proc({ pid: 11 })], {
      cwd: { 10: WT, 11: WT },
    });
    const reads = vi.fn(h.deps.startEpochOf);
    h.deps.startEpochOf = reads;
    h.deps.nowMs = () => h.clock.ms + 1_000;
    sweepWorktreeOrphans(h.deps, { ...run, deadlineMs: 0 });
    expect(reads).not.toHaveBeenCalled();
    expect(h.signals).toEqual([]);
  });

  it("should read the process table, registries and cwds once through a snapshot", () => {
    const h = harness([proc({ pid: 10 })], { cwd: { 10: WT } });
    const listProcs = vi.spyOn(h.deps, "listProcs");
    const snap = snapshotOrphanDeps(h.deps);
    sweepWorktreeOrphans(snap, { ...run, act: false });
    sweepWorktreeOrphans(snap, { ...run, act: false });
    expect(listProcs).toHaveBeenCalledTimes(1);
    expect(h.cwdCalls).toHaveLength(1);
  });

  it("should act on busy leftovers only through sweepBusyLeftovers", () => {
    const busy = proc({ pid: 10, cpuSec: 600 });
    const idle = proc({ pid: 11, pgid: 9100, cpuSec: 1 });
    const h = harness([busy, idle], { cwd: { 10: WT, 11: WT } });
    const r = sweepBusyLeftovers(WT, h.deps);
    expect(r.act).toBe(true);
    expect(r.busyOnly).toBe(true);
    expect(h.signals.map((s) => s[0])).toEqual([10]);
  });

  it("should signal descendants of an owned root", () => {
    const procs = [proc({ pid: 10 }), proc({ pid: 11, ppid: 10 })];
    const h = harness(procs, { cwd: { 10: WT } });
    const r = sweepWorktreeOrphans(h.deps, run);
    expect(r.signalled.sort()).toEqual([10, 11]);
  });

  it("should send zero signals in report mode", () => {
    const h = harness([proc({ pid: 10 })], { cwd: { 10: WT } });
    const r = sweepWorktreeOrphans(h.deps, { ...run, act: false });
    expect(h.signals).toEqual([]);
    expect(r.found).toHaveLength(1);
    expect(renderOrphanSweepLine(r)).toContain("would stop");
    expect(renderOrphanSweepLine(r, { held: true })).not.toContain(
      "would stop",
    );
  });

  it("should report ps unavailable as ran:false", () => {
    const r = sweepWorktreeOrphans(harness(undefined).deps, run);
    expect(r).toMatchObject({ ran: false, skipReason: "ps-unavailable" });
    expect(renderOrphanSweepLine(r)).toContain("did not run");
  });

  it("should report an empty worktree as a named skip", () => {
    const r = sweepWorktreeOrphans(harness([]).deps, { ...run, worktree: "" });
    expect(r).toMatchObject({ ran: false, skipReason: "no-worktree" });
  });

  it("should honour the deadline and leave survivors as stillAlive", () => {
    const h = harness([proc({ pid: 10 })], { cwd: { 10: WT }, stubborn: [10] });
    const r = sweepWorktreeOrphans(h.deps, { ...run, deadlineMs: 1000 });
    expect(h.signals).toEqual([[10, "SIGTERM"]]);
    expect(r.stillAlive).toEqual([10]);
  });

  it("should not read working directories when there is no candidate", () => {
    const h = harness([proc({ pid: 10, tty: "ttys001" })]);
    sweepWorktreeOrphans(h.deps, run);
    expect(h.cwdCalls).toEqual([]);
  });

  it("should read cwds only for busy groups in busy-only mode and skip idle ones", () => {
    const procs = [
      proc({ pid: 10, pgid: 1, cpuSec: 0 }),
      proc({ pid: 20, pgid: 2, cpuSec: 600 }),
    ];
    const h = harness(procs, { cwd: { 10: WT, 20: WT } });
    const r = sweepWorktreeOrphans(h.deps, { ...run, busyOnly: true });
    expect(h.cwdCalls).toEqual([[20]]);
    expect(r.signalled).toEqual([20]);
  });

  it("should not select a process whose cwd is another worktree", () => {
    const h = harness([proc({ pid: 10 })], {
      cwd: { 10: "/x/flow-foo-bar" },
      worktrees: [WT, "/x/flow-foo-bar"],
    });
    expect(sweepWorktreeOrphans(h.deps, run).found).toEqual([]);
    expect(h.signals).toEqual([]);
  });

  it("should match a deleted worktree directory via its canonical parent", () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wo-")));
    try {
      const gone = path.join(tmp, "flow-gone");
      expect(canonicalizeWorktree(gone)).toBe(gone);
      const h = harness([proc({ pid: 10 })], {
        cwd: { 10: path.join(gone, "sub") },
        worktrees: [],
      });
      const r = sweepWorktreeOrphans(h.deps, { ...run, worktree: gone });
      expect(r.signalled).toEqual([10]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("findBusyOutsideWorktrees", () => {
  it("should list a busy leaderless orphan outside every worktree with command0 only", () => {
    const h = harness([proc({ pid: 10, command: "/bin/spin --secret" })], {
      cwd: { 10: "/tmp/elsewhere" },
    });
    const out = findBusyOutsideWorktrees(h.deps);
    expect(out).toHaveLength(1);
    expect(out[0].command0).toBe("spin");
    expect(JSON.stringify(out)).not.toContain("secret");
    expect(h.signals).toEqual([]);
  });

  it("should not list an orphan inside a worktree", () => {
    const h = harness([proc({ pid: 10 })], { cwd: { 10: `${WT}/sub` } });
    expect(findBusyOutsideWorktrees(h.deps)).toEqual([]);
  });
});

describe("ps parsing", () => {
  it("should parse macOS and Linux durations", () => {
    expect(parseDurationSec("01:02")).toBe(62);
    expect(parseDurationSec("1-02:03:04")).toBe(86400 + 7384);
    expect(parseDurationSec("0:00.50")).toBe(0.5);
    expect(parseDurationSec("123:45.10")).toBeCloseTo(7425.1);
    expect(parseDurationSec("01:02:03")).toBe(3723);
    expect(parseDurationSec("garbage")).toBeNull();
  });

  it("should parse rows, map ttys, and join continuation lines", () => {
    const text = [
      "  10     1    10   501 ??       10:00   0:01.00 sleep 5",
      "  11     1     9   501 ttys003  00:05   0:00.00 vim a",
      "  12     1     9   501 ?     1-00:00:00 00:00:01 sh -c 'a",
      "b'",
    ].join("\n");
    const rows = parsePsTable(text);
    expect(rows.map((r) => r.tty)).toEqual([null, "ttys003", null]);
    expect(rows[0]).toMatchObject({ pid: 10, ageSec: 600, cpuSec: 1 });
    expect(rows[2].command).toBe("sh -c 'a\nb'");
  });

  it("should strip a Linux ' (deleted)' cwd suffix", () => {
    expect(stripDeletedSuffix("/a/wt (deleted)")).toBe("/a/wt");
    expect(stripDeletedSuffix("/a/wt")).toBe("/a/wt");
  });

  it("should parse lsof -Fpn output", () => {
    expect(parseLsofCwd("p10\nfcwd\nn/a/b\np11\nfcwd\nn/c\n")).toEqual(
      new Map([
        [10, "/a/b"],
        [11, "/c"],
      ]),
    );
  });
});

describe("recordOrphanStops", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wo-state-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = (slug: string) => ({
    slug,
    phase: "implementing" as const,
    repo: "/r",
    updatedAt: "2026-01-01T00:00:00Z",
  });

  it("should add to its own slug's running count only", () => {
    writeState(base("mine"), dir);
    writeState(base("other"), dir);
    const nowMs = vi.fn(() => Date.parse("2026-02-02T00:00:00Z"));
    recordOrphanStops("mine", 3, { stateDir: dir, nowMs });
    recordOrphanStops("mine", 2, { stateDir: dir, nowMs });
    expect(readState("mine", dir)?.orphanStops).toEqual({
      count: 5,
      lastAt: "2026-02-02T00:00:00.000Z",
    });
    expect(readState("other", dir)?.orphanStops).toBeUndefined();
  });

  it("should no-op for zero stops or a missing state file", () => {
    writeState(base("mine"), dir);
    recordOrphanStops("mine", 0, { stateDir: dir });
    recordOrphanStops("ghost", 4, { stateDir: dir });
    expect(readState("mine", dir)?.orphanStops).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "ghost.json"))).toBe(false);
  });
});
