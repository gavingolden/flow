import { describe, expect, it, vi } from "vitest";
import { AGY_SAFETY_PREAMBLE } from "../flow-delegate";
import {
  AGY_PS_ARGS,
  FLOW_DELEGATE_PROMPT_MARKER,
  listAgyProcs,
  renderAgyStrayLine,
  selectAgyStrays,
  sweepAgyStrays,
  type AgyProcRow,
  type AgySweepDeps,
} from "./agy-strays";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const flowAgy = (timeout = "12m"): string =>
  `agy --sandbox --print-timeout ${timeout} -p ## Operating constraints \\012\\012${FLOW_DELEGATE_PROMPT_MARKER} (research). Reply with...`;

const row = (
  pid: number,
  ppid: number,
  command: string,
  pgid = pid,
): AgyProcRow => ({ pid, ppid, pgid, command });

const startsAgo = (ms: number) => NOW - ms;

describe("marker", () => {
  it("is contained in the real safety preamble (drift check)", () => {
    expect(AGY_SAFETY_PREAMBLE).toContain(FLOW_DELEGATE_PROMPT_MARKER);
  });
});

describe("listAgyProcs", () => {
  it("passes exactly AGY_PS_ARGS (with -ww) to ps", () => {
    const spawnPs = vi.fn(
      () => "  PID  PPID  PGID COMMAND\n  5     1     5 agy -p x\n",
    );
    const procs = listAgyProcs(spawnPs);
    expect(spawnPs).toHaveBeenCalledWith(AGY_PS_ARGS);
    expect(AGY_PS_ARGS).toContain("-ww");
    expect(procs).toEqual([{ pid: 5, ppid: 1, pgid: 5, command: "agy -p x" }]);
  });

  it("folds a continuation line into the previous row's command", () => {
    const procs = listAgyProcs(
      () =>
        "PID PPID PGID COMMAND\n 7 1 7 agy -p first\nsecond line\n 8 2 3 vim\n",
    );
    expect(procs).toEqual([
      { pid: 7, ppid: 1, pgid: 7, command: "agy -p first\nsecond line" },
      { pid: 8, ppid: 2, pgid: 3, command: "vim" },
    ]);
  });

  it("returns undefined when ps fails or throws (e.g. Bun undefined under Node)", () => {
    expect(listAgyProcs(() => null)).toBeUndefined();
    expect(
      listAgyProcs(() => {
        throw new ReferenceError("Bun is not defined");
      }),
    ).toBeUndefined();
  });

  it("default spawn is fail-closed under vitest", () => {
    expect(() => listAgyProcs()).not.toThrow();
  });
});

describe("selectAgyStrays", () => {
  const procs: AgyProcRow[] = [
    row(10, 1, flowAgy("12m")), // orphaned, flow-launched, past limit
    row(11, 1, flowAgy("12m")), // orphaned, flow-launched, within limit
    row(20, 1, "agy --sandbox"), // user's interactive agy (no marker)
    row(21, 4242, flowAgy()), // parent alive
    row(22, 1, `grep agy ${FLOW_DELEGATE_PROMPT_MARKER}`),
    row(23, 1, `vim agy-strays.ts ${FLOW_DELEGATE_PROMPT_MARKER}`),
    row(24, 1, `/Users/u/.local/bin/agy -p ${FLOW_DELEGATE_PROMPT_MARKER}`),
  ];
  const starts: Record<number, number> = {
    10: startsAgo(60 * MIN),
    11: startsAgo(5 * MIN),
    24: startsAgo(5 * MIN),
  };

  it("lists only orphaned flow-launched agy and flags overdue by its own limit", () => {
    const out = selectAgyStrays(procs, {
      nowMs: NOW,
      startEpochMsOf: (pid) => starts[pid],
    });
    expect(out.map((s) => s.pid)).toEqual([10, 11, 24]);
    expect(out[0]).toEqual({
      pid: 10,
      pgid: 10,
      startEpochMs: startsAgo(60 * MIN),
      ageMs: 60 * MIN,
      timeLimitSec: 720,
      overdue: true,
    });
    expect(out[1]?.overdue).toBe(false);
  });

  it("falls back to 1 hour when --print-timeout is absent or invalid", () => {
    const noFlag = row(30, 1, `agy -p ${FLOW_DELEGATE_PROMPT_MARKER}`);
    const bad = row(
      31,
      1,
      `agy --print-timeout soon -p ${FLOW_DELEGATE_PROMPT_MARKER}`,
    );
    const out = selectAgyStrays([noFlag, bad], {
      nowMs: NOW,
      startEpochMsOf: () => startsAgo(30 * MIN),
    });
    expect(out.map((s) => s.timeLimitSec)).toEqual([3600, 3600]);
    expect(out.every((s) => !s.overdue)).toBe(true);
  });

  it("is not overdue until the limit plus the 30 s grace has passed", () => {
    const one = [row(40, 1, flowAgy("1m"))];
    const at = (ageMs: number) =>
      selectAgyStrays(one, {
        nowMs: NOW,
        startEpochMsOf: () => startsAgo(ageMs),
      })[0]?.overdue;
    expect(at(60_000 + 30_000)).toBe(false);
    expect(at(60_000 + 30_001)).toBe(true);
  });

  it("omits a row whose start time cannot be read", () => {
    expect(
      selectAgyStrays([row(50, 1, flowAgy())], {
        nowMs: NOW,
        startEpochMsOf: () => undefined,
      }),
    ).toEqual([]);
  });
});

function sweepRig(opts: {
  procs?: AgyProcRow[] | undefined;
  starts: (pid: number) => number | undefined;
  aliveAfterTerm?: Set<number>;
  aliveAfterKill?: Set<number>;
  onSleep?: () => void;
}) {
  const events: string[] = [];
  let phase: "start" | "termed" | "killed" = "start";
  const deps: AgySweepDeps = {
    listProcs: () =>
      "procs" in opts
        ? opts.procs
        : [row(10, 1, flowAgy("12m")), row(11, 1, flowAgy("12m"))],
    kill: (pid, sig) => {
      events.push(`${sig}:${pid}`);
      phase = sig === "SIGTERM" ? "termed" : "killed";
    },
    alive: (pid) => {
      if (phase === "start") return true;
      return (
        (phase === "termed" ? opts.aliveAfterTerm : opts.aliveAfterKill)?.has(
          Math.abs(pid),
        ) ?? false
      );
    },
    sleepMs: () => {
      events.push("sleep");
      opts.onSleep?.();
    },
    nowMs: () => NOW,
    startEpochMsOf: (pid) => opts.starts(pid),
  };
  return { deps, events };
}

describe("sweepAgyStrays", () => {
  const base: Record<number, number> = {
    10: startsAgo(60 * MIN),
    11: startsAgo(5 * MIN),
  };
  const starts = (pid: number) => base[pid];

  it("reports ps-unavailable when the listing is undefined", () => {
    const { deps } = sweepRig({ procs: undefined, starts });
    expect(sweepAgyStrays(deps, { yes: true })).toMatchObject({
      ran: false,
      skipReason: "ps-unavailable",
      found: [],
    });
  });

  it("never signals without yes", () => {
    const { deps, events } = sweepRig({ starts });
    const r = sweepAgyStrays(deps, { yes: false });
    expect(r.found.map((s) => s.pid)).toEqual([10, 11]);
    expect(events).toEqual([]);
  });

  it("never signals a stray still within its own time limit", () => {
    const { deps, events } = sweepRig({ starts });
    sweepAgyStrays(deps, { yes: true });
    expect(events.filter((e) => e.endsWith("11"))).toEqual([]);
    expect(events).toContain("SIGTERM:-10");
  });

  it("stops at SIGTERM when the polite stop works (no SIGKILL)", () => {
    const { deps, events } = sweepRig({ starts });
    const r = sweepAgyStrays(deps, { yes: true });
    expect(r.signalled).toEqual([10]);
    expect(r.killed).toEqual([]);
    expect(events).not.toContain("SIGKILL:-10");
  });

  it("escalates TERM -> grace -> KILL for a survivor, in that order", () => {
    const { deps, events } = sweepRig({
      starts,
      aliveAfterTerm: new Set([10]),
    });
    const r = sweepAgyStrays(deps, { yes: true });
    expect(r.signalled).toEqual([10]);
    expect(r.killed).toEqual([10]);
    const t = events.indexOf("SIGTERM:-10");
    const k = events.indexOf("SIGKILL:-10");
    expect(t).toBeGreaterThanOrEqual(0);
    expect(events.slice(t + 1, k)).toContain("sleep");
    expect(k).toBeGreaterThan(t);
    expect(r.stillAlive).toEqual([]);
  });

  it("reports a pid that survives SIGKILL as stillAlive", () => {
    const { deps } = sweepRig({
      starts,
      aliveAfterTerm: new Set([10]),
      aliveAfterKill: new Set([10]),
    });
    const r = sweepAgyStrays(deps, { yes: true });
    expect(r.stillAlive).toEqual([10]);
    expect(renderAgyStrayLine(r)).toBe(
      "  agy runs: 2 found (1 past their own time limit), 0 stopped",
    );
  });

  it("sends no SIGTERM when the start time changed between selection and the polite stop", () => {
    const reads = new Map<number, number>();
    const { deps, events } = sweepRig({
      starts: (pid) => {
        const n = (reads.get(pid) ?? 0) + 1;
        reads.set(pid, n);
        // read 1 = selection; read 2 = the re-check before SIGTERM.
        return n === 1 ? base[pid] : startsAgo(1 * MIN);
      },
    });
    const r = sweepAgyStrays(deps, { yes: true });
    expect(events.filter((e) => e.startsWith("SIG"))).toEqual([]);
    expect(r.signalled).toEqual([]);
  });

  it("sends no SIGKILL when the start time changed during the grace", () => {
    const reads = new Map<number, number>();
    const { deps, events } = sweepRig({
      starts: (pid) => {
        const n = (reads.get(pid) ?? 0) + 1;
        reads.set(pid, n);
        // reads 1-2 = selection + pre-TERM; read 3 = the re-check before SIGKILL.
        return n <= 2 ? base[pid] : startsAgo(1 * MIN);
      },
      aliveAfterTerm: new Set([10]),
    });
    const r = sweepAgyStrays(deps, { yes: true });
    expect(events).toContain("SIGTERM:-10");
    expect(events).not.toContain("SIGKILL:-10");
    expect(r.killed).toEqual([]);
  });
});

describe("sweepAgyStrays process-group targeting", () => {
  const base: Record<number, number> = { 10: startsAgo(60 * MIN) };

  it("signals the whole group (negative pid) for a group leader", () => {
    const { deps, events } = sweepRig({
      procs: [row(10, 1, flowAgy("12m"), 10)],
      starts: (pid) => base[pid],
      aliveAfterTerm: new Set([10]),
    });
    const r = sweepAgyStrays(deps, { yes: true });
    expect(events.filter((e) => e.startsWith("SIG"))).toEqual([
      "SIGTERM:-10",
      "SIGKILL:-10",
    ]);
    expect(r.signalled).toEqual([10]);
    expect(r.killed).toEqual([10]);
  });

  it("falls back to the single pid when the stray is not a group leader", () => {
    const { deps, events } = sweepRig({
      procs: [row(10, 1, flowAgy("12m"), 77)],
      starts: (pid) => base[pid],
      aliveAfterTerm: new Set([10]),
    });
    sweepAgyStrays(deps, { yes: true });
    expect(events.filter((e) => e.startsWith("SIG"))).toEqual([
      "SIGTERM:10",
      "SIGKILL:10",
    ]);
  });

  it("still SIGKILLs the group when the leader died on SIGTERM but helpers live", () => {
    const reads = new Map<number, number>();
    const { deps, events } = sweepRig({
      procs: [row(10, 1, flowAgy("12m"), 10)],
      // reads 1-2 = selection + pre-TERM; the leader is gone afterwards.
      starts: (pid) => {
        const n = (reads.get(pid) ?? 0) + 1;
        reads.set(pid, n);
        return n <= 2 ? base[pid] : undefined;
      },
      aliveAfterTerm: new Set([10]),
    });
    const r = sweepAgyStrays(deps, { yes: true });
    expect(events).toContain("SIGKILL:-10");
    expect(r.killed).toEqual([10]);
  });

  it("does not SIGKILL when the leader is gone and no group member remains", () => {
    const reads = new Map<number, number>();
    const { deps, events } = sweepRig({
      procs: [row(10, 1, flowAgy("12m"), 10)],
      starts: (pid) => {
        const n = (reads.get(pid) ?? 0) + 1;
        reads.set(pid, n);
        return n <= 2 ? base[pid] : undefined;
      },
    });
    const r = sweepAgyStrays(deps, { yes: true });
    expect(events).not.toContain("SIGKILL:-10");
    expect(r.killed).toEqual([]);
  });
});

describe("renderAgyStrayLine", () => {
  it("renders counts", () => {
    expect(
      renderAgyStrayLine({
        ran: true,
        found: [
          {
            pid: 1,
            pgid: 1,
            startEpochMs: 1,
            ageMs: 9,
            timeLimitSec: 1,
            overdue: true,
          },
          {
            pid: 2,
            pgid: 2,
            startEpochMs: 1,
            ageMs: 9,
            timeLimitSec: 1,
            overdue: false,
          },
        ],
        signalled: [1],
        killed: [],
        stillAlive: [],
      }),
    ).toBe("  agy runs: 2 found (1 past their own time limit), 1 stopped");
  });

  it("says so when ps was unavailable", () => {
    expect(
      renderAgyStrayLine({
        ran: false,
        skipReason: "ps-unavailable",
        found: [],
        signalled: [],
        killed: [],
        stillAlive: [],
      }),
    ).toContain("ps unavailable");
  });
});
