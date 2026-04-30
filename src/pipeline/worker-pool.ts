import type { ChildProcess } from "node:child_process";

export interface WorkerSpawnContext {
  id: string;
  child: ChildProcess;
}

export interface WorkerExitInfo {
  id: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  // Populated when the worker's `'error'` event fired before `'exit'`
  // (typically a pre-fork EAGAIN/ENOENT/EMFILE). `exitCode` and `signal`
  // are both null in that case.
  error?: Error;
}

export interface WorkerPoolOptions {
  // Hard cap on concurrent in-flight children. Must be >= 1; the caller
  // is responsible for validating this before calling.
  max: number;
  // Caller-provided spawn function. Returning a `ChildProcess` is the
  // contract — the pool listens for `'exit'` to free a slot. Throwing
  // here aborts the drain and surfaces the error to the caller.
  spawn: (id: string) => ChildProcess;
  // Fired immediately after `spawn(id)` returns, before the next slot is
  // considered. Useful for the scheduler's `worker.spawn` event.
  onSpawn?: (info: WorkerSpawnContext) => void;
  // Fired once per child after it exits. Mirrors the per-worker entry
  // in `DrainResult` but lets the scheduler stream events as they happen
  // rather than waiting for the whole drain.
  onExit?: (info: WorkerExitInfo) => void;
  // When set and aborted, the pool stops *starting* new workers. In-flight
  // children keep running until they exit naturally; the pool awaits all
  // of them before resolving. Escalation to SIGTERM is the caller's job
  // — keeping that out of the pool keeps the abstraction reusable for the
  // single-cohort drain plus future watch-loop refills.
  signal?: AbortSignal;
}

export interface DrainResult {
  // One entry per task id that was actually spawned. A task that was
  // skipped because the abort signal fired before its slot opened is
  // NOT in this list — the scheduler can compute "skipped" from the
  // input minus this set if it cares.
  workers: WorkerExitInfo[];
  // True if any worker was skipped due to the abort signal.
  aborted: boolean;
}

// Bounded worker pool: spawns up to `max` children at once and waits for
// each to exit before starting another. Order of completion is whatever
// the OS reports; `workers` is appended in completion order.
//
// The pool does NOT acquire claims, parse task files, or hold a logger —
// those concerns belong to the scheduler. Keeping the pool dumb makes it
// trivially testable with a fake `spawn` and lets a future caller (e.g.
// the verify retry loop) reuse it.
export async function drain(
  taskIds: readonly string[],
  opts: WorkerPoolOptions,
): Promise<DrainResult> {
  if (opts.max < 1) {
    throw new Error(`drain: max must be >= 1, got ${opts.max}`);
  }

  const workers: WorkerExitInfo[] = [];
  let aborted = opts.signal?.aborted ?? false;

  // Walk the input synchronously, dispatching to slots as they free up.
  // `inFlight` holds the per-worker promise (resolves on `'exit'`); a
  // `Promise.race` over it surfaces the first free slot.
  const inFlight = new Set<Promise<void>>();

  const onAbort = (): void => {
    aborted = true;
  };
  if (opts.signal) {
    if (opts.signal.aborted) aborted = true;
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    for (const id of taskIds) {
      if (aborted) break;
      // Wait for a free slot if we're at capacity.
      while (inFlight.size >= opts.max) {
        await Promise.race(inFlight);
      }
      // The signal may have fired while we waited for a slot. Re-check
      // before paying the cost of `spawn(id)` and the child handshake.
      if (aborted) break;

      const child = opts.spawn(id);
      opts.onSpawn?.({ id, child });

      const promise = new Promise<void>((resolve) => {
        let settled = false;
        const settle = (info: WorkerExitInfo): void => {
          if (settled) return;
          settled = true;
          workers.push(info);
          opts.onExit?.(info);
          resolve();
        };
        const onExit = (
          code: number | null,
          signal: NodeJS.Signals | null,
        ): void => {
          settle({ id, exitCode: code, signal });
        };
        // If `spawn(id)` returned a child whose pre-spawn fork failed
        // (EAGAIN/ENOENT/EMFILE), node fires `'error'` and may never
        // fire `'exit'`. Without this listener the slot would never
        // free and `Promise.allSettled(inFlight)` below would hang the
        // whole scheduler. Synthesise a deterministic exit so the
        // caller sees the failure as a normal worker outcome.
        const onError = (err: Error): void => {
          settle({ id, exitCode: null, signal: null, error: err });
        };
        // `'exit'` fires before stdio streams close — that's fine for
        // the scheduler's bookkeeping; child stdout/stderr is captured
        // by the per-task log files, not piped through the parent.
        child.once("exit", onExit);
        child.once("error", onError);
      }).finally(() => {
        inFlight.delete(promise);
      });
      inFlight.add(promise);
    }

    // Drain any remaining in-flight workers regardless of whether we
    // broke out of the dispatch loop. Allows the caller to observe
    // every spawned worker's outcome, even on abort.
    await Promise.allSettled(inFlight);
  } finally {
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }

  return { workers, aborted };
}
