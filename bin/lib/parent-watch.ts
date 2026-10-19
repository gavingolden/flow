import { pidStartEpoch } from "./liveness";

export const PARENT_WATCH_INTERVAL_MS = 1000;
export const PARENT_WATCH_EPOCH_EVERY = 10;

// Deliberately diverges from the repo's 3-way probes (liveness.ts:117), which
// treat EPERM as alive: a same-user parent never yields EPERM, so EPERM here
// means the pid was reused by another user's process, i.e. the parent is gone.
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type ParentWatchOpts = {
  parentPid: number;
  parentStartEpoch: number | null;
  onGone: () => void;
  intervalMs?: number;
  epochCheckEvery?: number;
  isAlive?: (pid: number) => boolean;
  startEpochOf?: (pid: number) => number | null;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
};

/**
 * Calls `onGone` once when the watched parent pid stops existing or its
 * start time changes (pid reuse). Callers capture `parentPid` once at
 * startup: Bun's `process.ppid` is cached and keeps returning the dead
 * parent's pid after re-parenting. Returns a stop function; the timer is
 * unref'd so it never keeps the process alive.
 */
export function startParentWatch(opts: ParentWatchOpts): () => void {
  const isAlive = opts.isAlive ?? pidExists;
  const startEpochOf = opts.startEpochOf ?? ((pid) => pidStartEpoch(pid));
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
  const every = opts.epochCheckEvery ?? PARENT_WATCH_EPOCH_EVERY;

  let fired = false;
  let ticks = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    if (timer !== undefined) clearIntervalFn(timer);
    timer = undefined;
  };

  const fire = (): void => {
    if (fired) return;
    fired = true;
    stop();
    opts.onGone();
  };

  const tick = (): void => {
    if (fired) return;
    ticks += 1;
    if (opts.parentPid <= 1 || !isAlive(opts.parentPid)) {
      fire();
      return;
    }
    if (opts.parentStartEpoch !== null && ticks % every === 0) {
      const now = startEpochOf(opts.parentPid);
      if (now !== null && now !== opts.parentStartEpoch) fire();
    }
  };

  timer = setIntervalFn(tick, opts.intervalMs ?? PARENT_WATCH_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return stop;
}
