import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { drain, type WorkerPoolOptions } from "./worker-pool.js";

class MockChild extends EventEmitter {
  readonly id: string;
  pid = Math.floor(Math.random() * 1_000_000) + 1;
  killed = false;
  // Type compatibility seam — `drain` only ever calls `.once("exit", ...)`,
  // not the rest of `ChildProcess`. Casting through `unknown` lets us pass
  // a minimal fake without recreating the whole interface.
  constructor(id: string) {
    super();
    this.id = id;
  }
  exitWith(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function asChildProcess(c: MockChild): ChildProcess {
  return c as unknown as ChildProcess;
}

describe("drain (worker pool)", () => {
  it("limits concurrent in-flight workers to opts.max", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const live = new Set<string>();
    let peak = 0;
    const children = new Map<string, MockChild>();

    const opts: WorkerPoolOptions = {
      max: 2,
      spawn: (id) => {
        const c = new MockChild(id);
        children.set(id, c);
        live.add(id);
        peak = Math.max(peak, live.size);
        // Defer exit so several spawns must overlap before any free.
        setImmediate(() => {
          live.delete(id);
          c.exitWith(0);
        });
        return asChildProcess(c);
      },
    };

    const result = await drain(ids, opts);
    expect(result.workers.map((w) => w.id).sort()).toEqual([...ids].sort());
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
    expect(result.aborted).toBe(false);
  });

  it("collects results for every spawned worker, including non-zero exits", async () => {
    const ids = ["ok", "fail", "signaled"];
    const opts: WorkerPoolOptions = {
      max: 3,
      spawn: (id) => {
        const c = new MockChild(id);
        setImmediate(() => {
          if (id === "ok") c.exitWith(0);
          else if (id === "fail") c.exitWith(1);
          else c.exitWith(null, "SIGTERM");
        });
        return asChildProcess(c);
      },
    };

    const result = await drain(ids, opts);
    const byId = Object.fromEntries(result.workers.map((w) => [w.id, w]));
    expect(byId["ok"]?.exitCode).toBe(0);
    expect(byId["fail"]?.exitCode).toBe(1);
    expect(byId["signaled"]?.signal).toBe("SIGTERM");
    expect(byId["signaled"]?.exitCode).toBeNull();
  });

  it("invokes onSpawn and onExit hooks for every worker", async () => {
    const spawns: string[] = [];
    const exits: string[] = [];
    const opts: WorkerPoolOptions = {
      max: 2,
      spawn: (id) => {
        const c = new MockChild(id);
        setImmediate(() => c.exitWith(0));
        return asChildProcess(c);
      },
      onSpawn: ({ id }) => spawns.push(id),
      onExit: ({ id }) => exits.push(id),
    };
    await drain(["x", "y", "z"], opts);
    expect(spawns.sort()).toEqual(["x", "y", "z"]);
    expect(exits.sort()).toEqual(["x", "y", "z"]);
  });

  it("stops starting new workers when the abort signal fires; in-flight finish", async () => {
    const ids = ["a", "b", "c", "d"];
    const ac = new AbortController();
    const spawned: string[] = [];
    const handles: MockChild[] = [];

    const opts: WorkerPoolOptions = {
      max: 1, // serialize so we can abort between iterations
      signal: ac.signal,
      spawn: (id) => {
        const c = new MockChild(id);
        spawned.push(id);
        handles.push(c);
        // Hold the first child open until we abort, then exit cleanly so
        // the loop can drain.
        if (id === "a") {
          setTimeout(() => {
            ac.abort();
            c.exitWith(0);
          }, 5);
        } else {
          setImmediate(() => c.exitWith(0));
        }
        return asChildProcess(c);
      },
    };

    const result = await drain(ids, opts);
    // Only "a" must have been spawned: abort fires before "b" can start.
    expect(spawned).toEqual(["a"]);
    expect(result.aborted).toBe(true);
    // "a" must have an exit recorded.
    expect(result.workers.map((w) => w.id)).toEqual(["a"]);
  });

  it("returns immediately with an empty result if signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    let spawnCalls = 0;
    const result = await drain(["a", "b"], {
      max: 4,
      signal: ac.signal,
      spawn: (id) => {
        spawnCalls++;
        const c = new MockChild(id);
        setImmediate(() => c.exitWith(0));
        return asChildProcess(c);
      },
    });
    expect(spawnCalls).toBe(0);
    expect(result.workers).toEqual([]);
    expect(result.aborted).toBe(true);
  });

  it("rejects max < 1", async () => {
    await expect(
      drain([], { max: 0, spawn: () => asChildProcess(new MockChild("x")) }),
    ).rejects.toThrow(/max must be >= 1/);
  });

  it("settles the worker promise when the child emits 'error' (no 'exit')", async () => {
    // A pre-fork failure (EAGAIN/ENOENT/EMFILE) fires `'error'` and may
    // never fire `'exit'`. Without the 'error' listener the slot would
    // never free and `Promise.allSettled(inFlight)` would hang the
    // whole drain. Assert the synthetic exit is recorded and the
    // drain resolves.
    const opts: WorkerPoolOptions = {
      max: 1,
      spawn: (id) => {
        const c = new MockChild(id);
        setImmediate(() => {
          c.emit("error", new Error("ENOENT: simulated spawn failure"));
        });
        return asChildProcess(c);
      },
    };
    const result = await drain(["a", "b"], opts);
    expect(result.workers).toHaveLength(2);
    for (const w of result.workers) {
      expect(w.exitCode).toBeNull();
      expect(w.signal).toBeNull();
      expect(w.error?.message).toMatch(/ENOENT/);
    }
  });

  it("handles an empty input list", async () => {
    const result = await drain([], {
      max: 4,
      spawn: () => {
        throw new Error("should not spawn");
      },
    });
    expect(result.workers).toEqual([]);
    expect(result.aborted).toBe(false);
  });
});
