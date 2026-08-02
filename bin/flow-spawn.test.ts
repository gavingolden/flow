import { describe, expect, it, vi, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  buildRow,
  forwardSignal,
  main,
  parseCliArgs,
  resolveSlug,
  runLaunch,
  runList,
  usage,
  type SpawnCliArgs,
  type SpawnDeps,
} from "./flow-spawn";
import type { ProcRegistryRow } from "./lib/proc-registry";

function baseArgs(overrides: Partial<SpawnCliArgs> = {}): SpawnCliArgs {
  return {
    json: false,
    procClass: "default",
    stdin: "ignore",
    command: ["sh", "-c", "exit 0"],
    ...overrides,
  };
}

function fakeChild(
  overrides: Partial<{
    pid: number;
    exitCode: number;
    signalCode: NodeJS.Signals | null;
  }> = {},
) {
  const pid = overrides.pid ?? 123;
  const exitCode = overrides.exitCode ?? 0;
  const signalCode = overrides.signalCode ?? null;
  return { pid, exited: Promise.resolve(exitCode), signalCode };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runLaunch — exit code propagation", () => {
  it("resolves the child's own exit code when it exits normally", async () => {
    const spawn = vi.fn().mockReturnValue(fakeChild({ exitCode: 42 }));
    const appendRow = vi.fn().mockReturnValue({ written: true });
    const code = await runLaunch(baseArgs(), {
      spawn,
      appendRow,
      env: { FLOW_SLUG: "csv-export" },
      pidStartEpoch: () => 1,
      selfPid: 1,
      nowMs: () => 0,
    });
    expect(code).toBe(42);
  });
});

describe("runLaunch — signal propagation", () => {
  const deps = (
    signalCode: NodeJS.Signals | null,
  ): SpawnDeps & { spawn: ReturnType<typeof vi.fn> } => ({
    spawn: vi.fn().mockReturnValue(fakeChild({ signalCode })),
    appendRow: vi.fn().mockReturnValue({ written: true }),
    env: { FLOW_SLUG: "csv-export" },
    pidStartEpoch: () => 1,
    selfPid: 1,
    nowMs: () => 0,
  });

  it("maps SIGTERM to 143", async () => {
    expect(await runLaunch(baseArgs(), deps("SIGTERM"))).toBe(143);
  });

  it("maps SIGINT to 130", async () => {
    expect(await runLaunch(baseArgs(), deps("SIGINT"))).toBe(130);
  });

  it("falls back to 1 on an unmapped signal name", async () => {
    expect(
      await runLaunch(baseArgs(), deps("SIGNOTREAL" as NodeJS.Signals)),
    ).toBe(1);
  });
});

describe("parseCliArgs", () => {
  it("splits flags from the command after `--`", () => {
    const args = parseCliArgs([
      "--slug",
      "csv-export",
      "--class",
      "mcp-server",
      "--stdin",
      "inherit",
      "--",
      "sh",
      "-c",
      "sleep 1",
    ]);
    expect(args.usageError).toBeUndefined();
    expect(args.slug).toBe("csv-export");
    expect(args.procClass).toBe("mcp-server");
    expect(args.stdin).toBe("inherit");
    expect(args.command).toEqual(["sh", "-c", "sleep 1"]);
  });

  it("parses --list with and without --json", () => {
    expect(parseCliArgs(["--list", "csv-export"])).toMatchObject({
      list: "csv-export",
      json: false,
    });
    expect(parseCliArgs(["--list", "csv-export", "--json"])).toMatchObject({
      list: "csv-export",
      json: true,
    });
  });

  it("sets usageError on a malformed invocation", () => {
    expect(parseCliArgs(["--slug"]).usageError).toBeTruthy();
    expect(parseCliArgs(["--bogus-flag"]).usageError).toBeTruthy();
    expect(
      parseCliArgs(["--class", "nope", "--", "x"]).usageError,
    ).toBeTruthy();
    expect(parseCliArgs([]).usageError).toBeTruthy();
  });

  it("defaults procClass and stdin when unspecified", () => {
    const args = parseCliArgs(["--", "sh", "-c", "true"]);
    expect(args.procClass).toBe("default");
    expect(args.stdin).toBe("ignore");
  });
});

describe("resolveSlug", () => {
  it("falls back to a synthetic slug that passes isValidSlug and still yields a written row", async () => {
    const appendRow = vi.fn().mockReturnValue({ written: true });
    const deps: SpawnDeps = {
      env: {},
      selfPid: 4242,
      nowMs: () => 1_700_000_000_000,
    };
    const { slug, synthetic } = resolveSlug(baseArgs(), deps);
    expect(synthetic).toBe(true);
    expect(slug).toBe("untracked-4242-1700000000000");

    await runLaunch(baseArgs(), {
      spawn: vi.fn().mockReturnValue(fakeChild()),
      appendRow,
      pidStartEpoch: () => 1,
      ...deps,
    });
    expect(appendRow).toHaveBeenCalledTimes(1);
    expect(appendRow.mock.calls[0][0].slug).toBe(
      "untracked-4242-1700000000000",
    );
  });

  it("prefers --slug over FLOW_SLUG, and FLOW_SLUG over the synthetic fallback", () => {
    expect(
      resolveSlug(baseArgs({ slug: "explicit-slug" }), {
        env: { FLOW_SLUG: "env-slug" },
      }).slug,
    ).toBe("explicit-slug");

    expect(
      resolveSlug(baseArgs(), { env: { FLOW_SLUG: "env-slug" } }).slug,
    ).toBe("env-slug");

    const fallback = resolveSlug(baseArgs(), {
      env: {},
      selfPid: 1,
      nowMs: () => 1,
    });
    expect(fallback.synthetic).toBe(true);
  });

  it("reports an invalid --slug as rejected instead of discarding it silently", () => {
    const rejected = resolveSlug(baseArgs({ slug: "Bad_Slug" }), {
      env: { FLOW_SLUG: "env-slug" },
    });
    // Falls through to the next resolution source rather than refusing to
    // launch, but names what it threw away so the caller isn't told "no
    // slug resolved" when they in fact passed one.
    expect(rejected.slug).toBe("env-slug");
    expect(rejected.synthetic).toBe(false);
    expect(rejected.rejectedSlug).toBe("Bad_Slug");

    const validSlug = resolveSlug(baseArgs({ slug: "good-slug" }), { env: {} });
    expect(validSlug.rejectedSlug).toBeUndefined();
  });
});

describe("stdin passthrough", () => {
  it("reaches the spawn seam as ignore by default and inherit when requested", async () => {
    const spawn = vi.fn().mockReturnValue(fakeChild());
    await runLaunch(baseArgs(), {
      spawn,
      appendRow: vi.fn().mockReturnValue({ written: true }),
      env: { FLOW_SLUG: "csv-export" },
      pidStartEpoch: () => 1,
    });
    expect(spawn.mock.calls[0][1]).toEqual({ stdin: "ignore" });

    spawn.mockClear();
    await runLaunch(baseArgs({ stdin: "inherit" }), {
      spawn,
      appendRow: vi.fn().mockReturnValue({ written: true }),
      env: { FLOW_SLUG: "csv-export" },
      pidStartEpoch: () => 1,
    });
    expect(spawn.mock.calls[0][1]).toEqual({ stdin: "inherit" });
  });
});

describe("forwardSignal", () => {
  it("retries on the bare pid after an ESRCH from the process-group signal", () => {
    const kill = vi
      .fn()
      .mockImplementationOnce(() => {
        const err = new Error("No such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      })
      .mockImplementationOnce(() => undefined);
    forwardSignal(50, 51, "SIGTERM", { kill });
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill.mock.calls[0]).toEqual([-50, "SIGTERM"]);
    expect(kill.mock.calls[1]).toEqual([51, "SIGTERM"]);
  });

  it("swallows a non-ESRCH error without retrying or throwing", () => {
    const kill = vi.fn().mockImplementation(() => {
      const err = new Error("Operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    expect(() => forwardSignal(50, 51, "SIGTERM", { kill })).not.toThrow();
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

describe("runList", () => {
  it("prints the machine-readable shape under --json, including the unknown-slug empty case", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const readRows = vi.fn().mockReturnValue({ rows: [], malformed: 0 });
    const exit = runList("never-seen-slug", true, { readRows });
    expect(exit).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ slug: "never-seen-slug", rows: [], malformed: 0 }),
    );
  });

  it("prints a human-readable table when --json is absent", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const row: ProcRegistryRow = {
      pgid: 1,
      pid: 1,
      startEpoch: 1,
      slug: "csv-export",
      class: "default",
      argv: ["bun", "bin/flow-spawn.ts"],
      recordedAt: 1,
      sessionPid: 2,
      sessionStartEpoch: 1,
    };
    const readRows = vi.fn().mockReturnValue({ rows: [row], malformed: 0 });
    const exit = runList("csv-export", false, { readRows });
    expect(exit).toBe(0);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("rows=1"))).toBe(
      true,
    );
  });
});

describe("runLaunch — appendRow receives a precomputed target (D3 regression)", () => {
  it("passes a resolved target path as the third appendRow argument so the append skips its own path resolution + mkdir", async () => {
    const spawn = vi.fn().mockReturnValue(fakeChild());
    const appendRow = vi.fn().mockReturnValue({ written: true });
    await runLaunch(baseArgs(), {
      spawn,
      appendRow,
      env: { FLOW_SLUG: "csv-export" },
      pidStartEpoch: () => 1,
    });
    expect(appendRow).toHaveBeenCalledTimes(1);
    const target = appendRow.mock.calls[0][2];
    expect(typeof target).toBe("string");
    expect(target).toContain("csv-export.jsonl");
  });
});

describe("registry-write fail-open", () => {
  it("still launches and returns the child's exit code when appendRow fails", async () => {
    const spawn = vi.fn().mockReturnValue(fakeChild({ exitCode: 9 }));
    const appendRow = vi
      .fn()
      .mockReturnValue({ written: false, error: "EACCES" });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runLaunch(baseArgs(), {
      spawn,
      appendRow,
      env: { FLOW_SLUG: "csv-export" },
      pidStartEpoch: () => 1,
    });
    expect(code).toBe(9);
    expect(appendRow).toHaveBeenCalledTimes(1);
  });
});

describe("buildRow", () => {
  it("sets pgid equal to pid and resolves the session fields from the recording session", () => {
    const row = buildRow(
      { pid: 100, slug: "csv-export", procClass: "default", argv: ["a"] },
      {
        pidStartEpoch: (pid) => (pid === 100 ? 500 : 700),
        selfPid: 9,
        nowMs: () => 12,
      },
    );
    expect(row).toEqual({
      pgid: 100,
      pid: 100,
      startEpoch: 500,
      slug: "csv-export",
      class: "default",
      argv: ["a"],
      recordedAt: 12,
      sessionPid: 9,
      sessionStartEpoch: 700,
    });
  });

  it("uses a pre-resolved selfStartEpoch instead of re-probing when given one (D2 regression)", () => {
    const pidStartEpoch = vi.fn((pid: number) => (pid === 100 ? 500 : 999));
    const row = buildRow(
      {
        pid: 100,
        slug: "csv-export",
        procClass: "default",
        argv: ["a"],
        selfStartEpoch: 42,
      },
      { pidStartEpoch, selfPid: 9, nowMs: () => 12 },
    );
    expect(row.sessionStartEpoch).toBe(42);
    // Only the child pid gets probed — the self-pid probe was skipped
    // because a resolved value was supplied.
    expect(pidStartEpoch).toHaveBeenCalledTimes(1);
    expect(pidStartEpoch).toHaveBeenCalledWith(100);
  });
});

describe("runLaunch — launch failure maps to exit 127 (D1 regression)", () => {
  it("catches a synchronous spawn throw (missing/unexecutable command) and reports 127", async () => {
    const spawn = vi.fn().mockImplementation(() => {
      throw new Error("ENOENT: spawn nope");
    });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const code = await runLaunch(baseArgs({ command: ["nope"] }), {
      spawn,
      appendRow: vi.fn(),
      env: { FLOW_SLUG: "csv-export" },
      pidStartEpoch: () => 1,
    });
    expect(code).toBe(127);
    expect(
      stderrSpy.mock.calls.some((c) =>
        String(c[0]).includes("failed to launch"),
      ),
    ).toBe(true);
  });
});

describe("runLaunch — call-order (mkdir -> spawn -> append -> await exited) (G regression)", () => {
  it("appends the row before awaiting the child's exit, not after", async () => {
    const order: string[] = [];
    let resolveExited!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExited = resolve;
    });
    const spawn = vi.fn().mockImplementation(() => {
      order.push("spawn");
      return { pid: 1, exited, signalCode: null };
    });
    const appendRow = vi.fn().mockImplementation(() => {
      order.push("append");
      return { written: true };
    });

    const launchPromise = runLaunch(baseArgs(), {
      spawn,
      appendRow,
      env: { FLOW_SLUG: "csv-export" },
      pidStartEpoch: () => 1,
    });

    // Give the microtask queue a turn so everything synchronous up to the
    // `await child.exited` has run.
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(["spawn", "append"]);
    order.push("child-exit-observed-would-be-here");
    resolveExited(0);
    await launchPromise;
  });
});

describe("SIGINT/SIGTERM forwarder registration and de-registration", () => {
  it("registers a listener for each signal during the launch and removes both after exit", async () => {
    const onSpy = vi.spyOn(process, "on");
    const offSpy = vi.spyOn(process, "off");
    const spawn = vi.fn().mockReturnValue(fakeChild({ exitCode: 0 }));
    await runLaunch(baseArgs(), {
      spawn,
      appendRow: vi.fn().mockReturnValue({ written: true }),
      env: { FLOW_SLUG: "csv-export" },
      pidStartEpoch: () => 1,
    });

    const registeredSignals = onSpy.mock.calls
      .filter((c) => c[0] === "SIGINT" || c[0] === "SIGTERM")
      .map((c) => c[0]);
    expect(registeredSignals.sort()).toEqual(["SIGINT", "SIGTERM"]);

    const deregisteredSignals = offSpy.mock.calls
      .filter((c) => c[0] === "SIGINT" || c[0] === "SIGTERM")
      .map((c) => c[0]);
    expect(deregisteredSignals.sort()).toEqual(["SIGINT", "SIGTERM"]);

    onSpy.mockRestore();
    offSpy.mockRestore();
  });
});

describe("parseCliArgs — missing-value messages (D4 regression)", () => {
  it("reports '--class requires a value' (not the enum-mismatch message) when the value is missing", () => {
    expect(parseCliArgs(["--class"]).usageError).toBe(
      "--class requires a value",
    );
  });

  it("reports '--stdin requires a value' (not the enum-mismatch message) when the value is missing", () => {
    expect(parseCliArgs(["--stdin"]).usageError).toBe(
      "--stdin requires a value",
    );
  });

  it("still reports the enum-mismatch message when a value IS given but invalid", () => {
    expect(parseCliArgs(["--class", "bogus"]).usageError).toBe(
      '--class must be "default" or "mcp-server"',
    );
    expect(parseCliArgs(["--stdin", "bogus"]).usageError).toBe(
      '--stdin must be "inherit" or "ignore"',
    );
  });
});

describe("main()", () => {
  it("returns exit code 2 and prints usage on a malformed invocation", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const code = await main([]);
    expect(code).toBe(2);
    expect(
      stderrSpy.mock.calls.some((c) => String(c[0]).includes(usage())),
    ).toBe(true);
  });

  it("dispatches to --list", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await main(["--list", "never-seen-slug", "--json"]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ slug: "never-seen-slug", rows: [], malformed: 0 }),
    );
  });
});

describe("bin/flow-spawn.ts exec bit", () => {
  it("is tracked executable (100755) in the committed tree — a 100644 helper passes `verify` but dies `permission denied` at the bare PATH command", () => {
    const r = spawnSync("git", ["ls-files", "-s", "bin/flow-spawn.ts"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^100755\b/);
  });
});

describe("--list per-row output format (not just the header line)", () => {
  it("prints each row's pid/pgid/class/argv, not just the summary header", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const rows: ProcRegistryRow[] = [
      {
        pgid: 5,
        pid: 5,
        startEpoch: 1,
        slug: "csv-export",
        class: "mcp-server",
        argv: ["bun", "server.ts"],
        recordedAt: 1,
        sessionPid: 2,
        sessionStartEpoch: 1,
      },
    ];
    const readRows = vi.fn().mockReturnValue({ rows, malformed: 0 });
    runList("csv-export", false, { readRows });
    const rowLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.includes("pid=5"));
    expect(rowLine).toBeDefined();
    expect(rowLine).toContain("pgid=5");
    expect(rowLine).toContain("class=mcp-server");
    expect(rowLine).toContain("argv=bun server.ts");
  });
});
