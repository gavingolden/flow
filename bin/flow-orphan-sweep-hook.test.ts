import { describe, expect, it, vi } from "vitest";
import {
  runHook,
  shouldSweep,
  SWEEP_THROTTLE_MS,
  type HookDeps,
} from "./flow-orphan-sweep-hook";
import type { WorktreeOrphanSweepResult } from "./lib/worktree-orphans-run";

function result(signalled: number[] = [1, 2]): WorktreeOrphanSweepResult {
  return {
    ran: true,
    act: true,
    busyOnly: true,
    found: [
      {
        pid: 1,
        pgid: 9,
        ageSec: 300,
        groupCpuRatio: 1,
        busy: true,
        command0: "sleep",
        descendants: [],
      },
    ],
    signalled,
    killed: [],
    stillAlive: [],
    skippedRecycled: [],
  };
}

function harness(over: Partial<HookDeps> & { last?: number | null } = {}) {
  const calls = {
    loadWorktree: vi.fn((_s: string) => "/w/demo" as string | null),
    readLast: vi.fn((_s: string) =>
      over.last === undefined ? null : over.last,
    ),
    writeLast: vi.fn(),
    sweep: vi.fn((_w: string) => result() as WorktreeOrphanSweepResult | null),
    record: vi.fn(),
  };
  const deps: HookDeps = {
    env: { FLOW_SLUG: "demo" },
    nowMs: () => 1_000_000,
    ...calls,
    ...over,
  };
  return { deps, calls };
}

describe("shouldSweep", () => {
  it("should sweep with no prior timestamp and at the 60 s boundary only", () => {
    expect(shouldSweep(null, 5)).toBe(true);
    expect(shouldSweep(1000, 1000 + SWEEP_THROTTLE_MS - 1)).toBe(false);
    expect(shouldSweep(1000, 1000 + SWEEP_THROTTLE_MS)).toBe(true);
  });
});

describe("runHook", () => {
  it("should read nothing without FLOW_SLUG", () => {
    const { deps, calls } = harness({ env: {} });
    expect(runHook({ tool_name: "Bash" }, deps)).toBeNull();
    expect(calls.readLast).not.toHaveBeenCalled();
    expect(calls.loadWorktree).not.toHaveBeenCalled();
  });

  it("should not sweep within 60 s of the last sweep", () => {
    const { deps, calls } = harness({ last: 1_000_000 - 30_000 });
    expect(runHook({}, deps)).toBeNull();
    expect(calls.sweep).not.toHaveBeenCalled();
    expect(calls.writeLast).not.toHaveBeenCalled();
  });

  it("should sweep once after 60 s and update the timestamp before sweeping", () => {
    const order: string[] = [];
    const { deps, calls } = harness({ last: 1_000_000 - 61_000 });
    calls.writeLast.mockImplementation(() => order.push("write"));
    calls.sweep.mockImplementation(() => {
      order.push("sweep");
      return result([]);
    });
    expect(runHook({}, deps)).toBeNull();
    expect(order).toEqual(["write", "sweep"]);
    expect(calls.writeLast).toHaveBeenCalledWith("demo", 1_000_000);
    expect(calls.sweep).toHaveBeenCalledWith("/w/demo");
  });

  it("should emit additionalContext and record the count when it stops something", () => {
    const { deps, calls } = harness();
    const out = runHook({ tool_name: "Bash" }, deps);
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "flow stopped 2 leftover processes",
    );
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "run_in_background",
    );
    expect(calls.record).toHaveBeenCalledWith("demo", 2);
  });

  it("should do nothing when the state has no worktree", () => {
    const { deps, calls } = harness({ loadWorktree: () => null });
    expect(runHook({}, deps)).toBeNull();
    expect(calls.sweep).not.toHaveBeenCalled();
  });

  it("should stay silent and exit cleanly when the sweep throws", () => {
    const { deps } = harness({
      sweep: () => {
        throw new Error("boom");
      },
    });
    expect(runHook({}, deps)).toBeNull();
  });

  it("should ignore a non-Bash tool payload", () => {
    const { deps, calls } = harness();
    expect(runHook({ tool_name: "Read" }, deps)).toBeNull();
    expect(calls.sweep).not.toHaveBeenCalled();
  });
});
