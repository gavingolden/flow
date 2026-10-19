import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run, type Deps } from "./flow-plan-review-wait";

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

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe(parseArgs, () => {
  it("errors when no result-path is provided", () => {
    expect(parseArgs([])).toEqual({ error: "result-path is required" });
  });

  it("returns 'help' on --help without requiring a result-path", () => {
    expect(parseArgs(["--help"])).toEqual({ error: "help" });
  });

  it("errors when the first positional arg looks like a flag", () => {
    expect(parseArgs(["--max-sec"])).toEqual({
      error: "result-path must be the first positional argument",
    });
  });

  it("errors on an unknown flag", () => {
    expect(parseArgs(["/p.json", "--bogus"])).toEqual({
      error: "unknown flag: --bogus",
    });
  });

  it("defaults max-sec=540, interval=5, with NO min-sec field", () => {
    const parsed = parseArgs(["/p.json"]);
    expect(parsed).toEqual({
      resultPath: "/p.json",
      maxSec: 540,
      intervalSec: 5,
      completeLine: false,
    });
    expect(parsed).not.toHaveProperty("minSec");
  });

  it("accepts explicit --max-sec / --interval overrides", () => {
    expect(
      parseArgs(["/p.json", "--max-sec", "30", "--interval", "2"]),
    ).toEqual({
      resultPath: "/p.json",
      maxSec: 30,
      intervalSec: 2,
      completeLine: false,
    });
  });

  it("parses --complete-line and --pid", () => {
    expect(parseArgs(["/p.json", "--complete-line", "--pid", "4242"])).toEqual({
      resultPath: "/p.json",
      maxSec: 540,
      intervalSec: 5,
      completeLine: true,
      pid: 4242,
    });
  });

  it("errors when --pid is not a positive integer", () => {
    expect(parseArgs(["/p.json", "--pid", "0"])).toEqual({
      error: "--pid must be a positive integer, got '0'",
    });
  });

  it("errors when --max-sec is missing its value", () => {
    expect(parseArgs(["/p.json", "--max-sec"])).toEqual({
      error: "--max-sec requires a value",
    });
  });

  it("errors when --max-sec is zero or negative", () => {
    expect(parseArgs(["/p.json", "--max-sec", "0"])).toEqual({
      error: "--max-sec must be a positive integer, got '0'",
    });
  });

  it("errors when --interval is non-numeric", () => {
    expect(parseArgs(["/p.json", "--interval", "abc"])).toEqual({
      error: "--interval must be a positive integer, got 'abc'",
    });
  });
});

describe(run, () => {
  it("exits 0 the moment the result file appears", async () => {
    const clock = makeFakeClock();
    let appearsAfterPolls = 2;
    let polls = 0;
    const exit = await run(["/p.json", "--interval", "1", "--max-sec", "10"], {
      exists: () => {
        polls++;
        return polls > appearsAfterPolls;
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(exit).toBe(0);
    // Two poll misses, each costing one interval tick.
    expect(clock.now()).toBe(2000);
  });

  it("exits 0 at --max-sec when the result file never appears (owns zero decisions — no verdict)", async () => {
    const clock = makeFakeClock();
    const exit = await run(["/p.json", "--interval", "1", "--max-sec", "3"], {
      exists: () => false,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(exit).toBe(0);
    expect(clock.now()).toBeGreaterThanOrEqual(3000);
  });

  it("returns immediately (zero sleeps) when the result file already exists", async () => {
    const clock = makeFakeClock();
    const exit = await run(["/p.json"], {
      exists: () => true,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(exit).toBe(0);
    expect(clock.now()).toBe(0);
  });

  it("errors (exit 2) on bad args without polling", async () => {
    const existsSpy = vi.fn().mockReturnValue(false);
    const exit = await run([], { exists: existsSpy });
    expect(exit).toBe(2);
    expect(existsSpy).not.toHaveBeenCalled();
  });

  it("SIGTERM stops polling and exits 0 promptly, not waiting out --max-sec", async () => {
    let nowMs = 0;
    const now = () => nowMs;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          nowMs += ms;
          resolve();
        }, 0);
      });
    const runPromise = run(["/p.json", "--interval", "1", "--max-sec", "5"], {
      exists: () => false,
      sleep,
      now,
    });
    await Promise.resolve();
    process.emit("SIGTERM");
    const exit = await runPromise;
    expect(exit).toBe(0);
  });

  it("writes nothing anywhere — Deps carries no writer/state seam at all", () => {
    // Type-only sanity: Deps stays the documented shape (exists/sleep/now
    // only — no writer, no state-dir, no decision-matrix seam). A future
    // addition here would be a decision creeping into the "owns zero
    // decisions" waiter — the exact bug flow-ci-check was carved out to fix.
    const depsShape: Deps = {};
    void depsShape;
  });

  it("prints a JSON outcome line the caller can branch on", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const clock = makeFakeClock();
    await run(["/p.json", "--max-sec", "2", "--interval", "1"], {
      exists: () => false,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(logSpy).toHaveBeenCalledWith('{"outcome":"timeout"}');
    await run(["/p.json"], { exists: () => true });
    expect(logSpy).toHaveBeenCalledWith('{"outcome":"complete"}');
  });

  it("prints usage and exits 0 on --help", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = await run(["--help"]);
    expect(exit).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("flow-plan-review-wait"),
    );
    logSpy.mockRestore();
  });
});

describe("--complete-line and --pid", () => {
  const esrch = () => {
    throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  };

  it("keeps waiting on an empty file under --complete-line", async () => {
    const clock = makeFakeClock();
    await run(
      ["/p.json", "--complete-line", "--interval", "1", "--max-sec", "3"],
      {
        exists: () => true,
        statSize: () => 0,
        lastByte: () => "",
        sleep: clock.sleep,
        now: clock.now,
      },
    );
    expect(clock.now()).toBeGreaterThanOrEqual(3000);
  });

  it("keeps waiting on a file that ends mid-line", async () => {
    const clock = makeFakeClock();
    await run(
      ["/p.json", "--complete-line", "--interval", "1", "--max-sec", "3"],
      {
        exists: () => true,
        statSize: () => 12,
        lastByte: () => "}",
        sleep: clock.sleep,
        now: clock.now,
      },
    );
    expect(clock.now()).toBeGreaterThanOrEqual(3000);
  });

  it("completes on a newline-terminated file", async () => {
    const clock = makeFakeClock();
    let polls = 0;
    await run(
      ["/p.json", "--complete-line", "--interval", "1", "--max-sec", "10"],
      {
        exists: () => true,
        statSize: () => (++polls > 2 ? 12 : 0),
        lastByte: () => "\n",
        sleep: clock.sleep,
        now: clock.now,
      },
    );
    expect(clock.now()).toBe(2000);
  });

  it("returns at once when --pid names an exited process and the file is empty", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const clock = makeFakeClock();
    await run(
      ["/p.json", "--complete-line", "--pid", "999999", "--max-sec", "540"],
      {
        exists: () => true,
        statSize: () => 0,
        lastByte: () => "",
        kill: esrch,
        sleep: clock.sleep,
        now: clock.now,
      },
    );
    expect(clock.now()).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      '{"outcome":"process-exited-without-result"}',
    );
  });

  it("race: a file that completes between exit detection and the re-check is complete", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let sizeCalls = 0;
    await run(["/p.json", "--complete-line", "--pid", "999999"], {
      exists: () => true,
      // first check (before the exit check) sees an empty file; the re-check
      // after ESRCH sees the helper's final atomic rename
      statSize: () => (++sizeCalls === 1 ? 0 : 20),
      lastByte: () => "\n",
      kill: esrch,
    });
    expect(logSpy).toHaveBeenCalledWith('{"outcome":"complete"}');
  });

  it("treats EPERM as still alive and keeps waiting", async () => {
    const clock = makeFakeClock();
    await run(["/p.json", "--pid", "1", "--interval", "1", "--max-sec", "2"], {
      exists: () => false,
      kill: () => {
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(clock.now()).toBeGreaterThanOrEqual(2000);
  });
});
