import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs, run, type Deps } from "./flow-ci-wait";

/**
 * Logical clock + sleep that advances the clock instantly (no real wall-clock
 * delay). Mirrors the retired run()-integration fixture's `makeFakeClock`,
 * scoped down to what the waiter needs: `now`/`sleep` only, no loop-driving
 * `advance`.
 */
function makeFakeClock() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleep: (ms: number) => {
      nowMs += ms;
      return Promise.resolve();
    },
  };
}

/** A fake `spawnWatch` whose child "exits" after `exitAfterMs` (relative to
 * spawn time) with `exitCode`, or never exits on its own if `exitAfterMs` is
 * null. When `exitAfterMs` is null, `killResolvesExit` (default `false`)
 * controls whether `kill()` itself resolves `exited` — the real `Bun.spawn`
 * child's `.exited` promise resolves once the killed process actually
 * terminates, which is what makes a signal handler that calls `kill()` then
 * `await`s `child.exited` return promptly instead of only being bounded by
 * the --max-sec race. */
function makeFakeSpawnWatch(opts: {
  exitAfterMs: number | null;
  exitCode?: number;
  clock: { now: () => number; sleep: (ms: number) => Promise<void> };
  killResolvesExit?: boolean;
}) {
  const calls: Array<{ pr: number; intervalSec: number }> = [];
  let killCount = 0;
  const spawnWatch = (pr: number, intervalSec: number) => {
    calls.push({ pr, intervalSec });
    let resolveOnKill: ((code: number) => void) | null = null;
    const exited: Promise<number> =
      opts.exitAfterMs === null
        ? new Promise((resolve) => {
            // Never resolves on its own — only `kill()` (simulated
            // externally, e.g. by the max-sec race, or a signal handler)
            // ends this child.
            if (opts.killResolvesExit) resolveOnKill = resolve;
          })
        : opts.clock.sleep(opts.exitAfterMs).then(() => opts.exitCode ?? 0);
    return {
      exited,
      kill: () => {
        killCount++;
        resolveOnKill?.(opts.exitCode ?? 0);
      },
    };
  };
  return {
    spawnWatch,
    calls,
    get killCount() {
      return killCount;
    },
  };
}

// `resolveSlugFromEnv`-driven `registrySelfCheck` reads the REAL `FLOW_SLUG`
// env var by default — sandbox it away for the whole file so a developer
// running this suite from inside a live flow pipeline shell doesn't read the
// real `~/.flow/state/procs/` registry.
let originalFlowSlug: string | undefined;
beforeEach(() => {
  originalFlowSlug = process.env.FLOW_SLUG;
  delete process.env.FLOW_SLUG;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (originalFlowSlug === undefined) delete process.env.FLOW_SLUG;
  else process.env.FLOW_SLUG = originalFlowSlug;
});

// ---------------------------------------------------------------------------
// 1. parseArgs
// ---------------------------------------------------------------------------

describe(parseArgs, () => {
  it("errors when no PR is provided", () => {
    expect(parseArgs([])).toEqual({ error: "PR number is required" });
  });
  it("returns 'help' on --help without requiring a PR", () => {
    expect(parseArgs(["--help"])).toEqual({ error: "help" });
  });
  it("rejects a non-integer PR", () => {
    expect(parseArgs(["abc"])).toEqual({
      error: "PR must be a positive integer, got 'abc'",
    });
  });
  it("errors on an unknown flag", () => {
    expect(parseArgs(["100", "--bogus"])).toEqual({
      error: "unknown flag: --bogus",
    });
  });
  it("defaults min-sec=60, max-sec=540, interval=60", () => {
    expect(parseArgs(["100"])).toEqual({
      pr: 100,
      minSec: 60,
      maxSec: 540,
      intervalSec: 60,
    });
  });
  it("accepts explicit --min-sec / --max-sec / --interval overrides", () => {
    expect(
      parseArgs([
        "100",
        "--min-sec",
        "10",
        "--max-sec",
        "30",
        "--interval",
        "5",
      ]),
    ).toEqual({ pr: 100, minSec: 10, maxSec: 30, intervalSec: 5 });
  });
  it("errors when --min-sec is missing its value", () => {
    expect(parseArgs(["100", "--min-sec"])).toEqual({
      error: "--min-sec requires a value",
    });
  });
  it("errors when --max-sec is zero or negative", () => {
    expect(parseArgs(["100", "--max-sec", "0"])).toEqual({
      error: "--max-sec must be a positive integer, got '0'",
    });
    expect(parseArgs(["100", "--max-sec", "-5"])).toEqual({
      error: "--max-sec must be a positive integer, got '-5'",
    });
  });
  it("errors when --interval is non-numeric", () => {
    expect(parseArgs(["100", "--interval", "abc"])).toEqual({
      error: "--interval must be a positive integer, got 'abc'",
    });
  });
});

// ---------------------------------------------------------------------------
// 2. run() — the waiter's shape (no verdict, no state, no --out)
// ---------------------------------------------------------------------------

describe(run, () => {
  it("honours the min-sec floor when the watch exits instantly", async () => {
    const clock = makeFakeClock();
    const fake = makeFakeSpawnWatch({ exitAfterMs: 0, clock });
    const exit = await run(["100", "--min-sec", "60", "--max-sec", "540"], {
      spawnWatch: fake.spawnWatch,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(exit).toBe(0);
    // The watch exited at t=0; the waiter must still have slept up to the
    // 60s floor before returning.
    expect(clock.now()).toBeGreaterThanOrEqual(60000);
  });

  it("honours the max-sec bound when the watch never exits (kill invoked)", async () => {
    const clock = makeFakeClock();
    const fake = makeFakeSpawnWatch({ exitAfterMs: null, clock });
    const exit = await run(["100", "--min-sec", "10", "--max-sec", "30"], {
      spawnWatch: fake.spawnWatch,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(exit).toBe(0);
    expect(fake.killCount).toBeGreaterThanOrEqual(1);
    // max-sec (30s) fired before the floor sleep, and the floor (10s) is
    // already satisfied by the 30s race — total elapsed should land at 30s,
    // not stack an additional floor sleep on top.
    expect(clock.now()).toBe(30000);
  });

  it("exits 0 even when the watch child exits non-zero (still 'waiting', not a failure)", async () => {
    const clock = makeFakeClock();
    const fake = makeFakeSpawnWatch({ exitAfterMs: 0, exitCode: 1, clock });
    const exit = await run(["100", "--min-sec", "5", "--max-sec", "540"], {
      spawnWatch: fake.spawnWatch,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(exit).toBe(0);
    // The floor guard applies on every exit path, including a non-zero
    // watch exit — the watch exited at t=0, so the waiter must still have
    // slept up to the 5s floor before returning.
    expect(clock.now()).toBeGreaterThanOrEqual(5000);
  });

  it("passes the PR number and --interval through to spawnWatch", async () => {
    const clock = makeFakeClock();
    const fake = makeFakeSpawnWatch({ exitAfterMs: 0, clock });
    await run(["123", "--interval", "15", "--min-sec", "1"], {
      spawnWatch: fake.spawnWatch,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(fake.calls).toEqual([{ pr: 123, intervalSec: 15 }]);
  });

  it("errors (exit 2) on bad args without spawning a watch child", async () => {
    const fake = makeFakeSpawnWatch({
      exitAfterMs: 0,
      clock: makeFakeClock(),
    });
    const exit = await run([], { spawnWatch: fake.spawnWatch });
    expect(exit).toBe(2);
    expect(fake.calls).toHaveLength(0);
  });

  it("SIGTERM invokes the child's kill() and leaves no file/state side effects", async () => {
    // A macrotask (real setTimeout), not `makeFakeClock`'s instantly-resolved
    // microtask sleep — `makeFakeClock`'s sleep resolves synchronously
    // regardless of the requested duration, so its --max-sec race would
    // always win against the single-microtask-tick SIGTERM below, masking
    // the very ordering this test exists to pin (signal preempts the floor).
    let nowMs = 0;
    const now = () => nowMs;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          nowMs += ms;
          resolve();
        }, 0);
      });
    const fake = makeFakeSpawnWatch({
      exitAfterMs: null,
      clock: { now, sleep },
      killResolvesExit: true,
    });
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ci-wait-sig-"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpCwd);
    try {
      const runPromise = run(["100", "--min-sec", "1", "--max-sec", "5"], {
        spawnWatch: fake.spawnWatch,
        sleep,
        now,
      });
      // Give the SIGTERM listener a tick to attach before firing it.
      await Promise.resolve();
      process.emit("SIGTERM");
      const exit = await runPromise;
      expect(exit).toBe(0);
      expect(fake.killCount).toBeGreaterThanOrEqual(1);
      // A signal is an explicit "stop now" — it must exit promptly rather
      // than still sleeping out the 1s --min-sec floor.
      expect(now()).toBe(0);
      // No verdict file, no state directory — the waiter writes nothing.
      expect(fs.readdirSync(tmpCwd)).toEqual([]);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it("never writes ci-wait-result.json", async () => {
    const clock = makeFakeClock();
    const fake = makeFakeSpawnWatch({ exitAfterMs: 0, clock });
    const tmpCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-ci-wait-nowrite-"),
    );
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpCwd);
    try {
      await run(["100", "--min-sec", "1"], {
        spawnWatch: fake.spawnWatch,
        sleep: clock.sleep,
        now: clock.now,
      });
      expect(
        fs.existsSync(path.join(tmpCwd, ".flow-tmp", "ci-wait-result.json")),
      ).toBe(false);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it("prints usage and exits 0 on --help", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = await run(["--help"]);
    expect(exit).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("flow-ci-wait"),
    );
    logSpy.mockRestore();
  });
});

// Type-only sanity: Deps stays the documented shape (spawnWatch/sleep/now
// only — no `gh`, no `out`, no decision-matrix seams).
const _depsShape: Deps = {};
void _depsShape;
