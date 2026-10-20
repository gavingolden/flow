import { describe, expect, it, vi } from "vitest";
import {
  PARENT_WATCH_EPOCH_EVERY,
  PARENT_WATCH_INTERVAL_MS,
  pidExists,
  startParentWatch,
} from "./parent-watch";

function harness(over: Partial<Parameters<typeof startParentWatch>[0]> = {}) {
  let tick: () => void = () => {};
  const unref = vi.fn();
  const handle = { unref } as unknown as ReturnType<typeof setInterval>;
  const setIntervalFn = vi.fn((cb: () => void) => {
    tick = cb;
    return handle;
  }) as unknown as typeof setInterval;
  const clearIntervalFn = vi.fn() as unknown as typeof clearInterval;
  const onGone = vi.fn();
  const stop = startParentWatch({
    parentPid: 4242,
    parentStartEpoch: 1000,
    onGone,
    isAlive: () => true,
    startEpochOf: () => 1000,
    setIntervalFn,
    clearIntervalFn,
    ...over,
  });
  return {
    tick: () => tick(),
    onGone,
    stop,
    setIntervalFn,
    clearIntervalFn,
    unref,
  };
}

describe("startParentWatch", () => {
  it("polls at the default interval and unrefs the timer", () => {
    const h = harness();
    expect(h.setIntervalFn).toHaveBeenCalledWith(
      expect.any(Function),
      PARENT_WATCH_INTERVAL_MS,
    );
    expect(h.unref).toHaveBeenCalled();
  });

  it("never fires while the parent is alive", () => {
    const h = harness();
    for (let i = 0; i < 25; i++) h.tick();
    expect(h.onGone).not.toHaveBeenCalled();
  });

  it("fires once on the first not-alive tick", () => {
    let alive = true;
    const h = harness({ isAlive: () => alive });
    h.tick();
    alive = false;
    h.tick();
    h.tick();
    expect(h.onGone).toHaveBeenCalledTimes(1);
    expect(h.clearIntervalFn).toHaveBeenCalled();
  });

  it("stop() halts polling", () => {
    const h = harness();
    h.stop();
    expect(h.clearIntervalFn).toHaveBeenCalled();
  });

  it("treats pid <= 1 as gone", () => {
    const h = harness({ parentPid: 1 });
    h.tick();
    expect(h.onGone).toHaveBeenCalledTimes(1);
  });

  it("fires on the 10th tick when the start time changed", () => {
    const h = harness({ startEpochOf: () => 2000 });
    for (let i = 0; i < PARENT_WATCH_EPOCH_EVERY - 1; i++) h.tick();
    expect(h.onGone).not.toHaveBeenCalled();
    h.tick();
    expect(h.onGone).toHaveBeenCalledTimes(1);
  });

  it("does not fire when the start-time read is null", () => {
    const h = harness({ startEpochOf: () => null });
    for (let i = 0; i < 30; i++) h.tick();
    expect(h.onGone).not.toHaveBeenCalled();
  });

  it("never re-reads the start time when the captured one is null", () => {
    const startEpochOf = vi.fn(() => 5);
    const h = harness({ parentStartEpoch: null, startEpochOf });
    for (let i = 0; i < 30; i++) h.tick();
    expect(startEpochOf).not.toHaveBeenCalled();
    expect(h.onGone).not.toHaveBeenCalled();
  });
});

describe("pidExists", () => {
  it("is true for this process and false for an impossible pid", () => {
    expect(pidExists(process.pid)).toBe(true);
    expect(pidExists(2 ** 22 + 12345678)).toBe(false);
  });

  // Deliberately unlike liveness.ts (EPERM = alive): a same-user parent never
  // yields EPERM, so EPERM means the pid was recycled by another user's process.
  it.skipIf(process.getuid?.() === 0)(
    "treats EPERM (another user's pid) as gone",
    () => {
      expect(pidExists(1)).toBe(false);
    },
  );
});
