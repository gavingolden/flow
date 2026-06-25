import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  entryOutPath,
  entryToDelegateArgv,
  parseFanoutArgs,
  run,
  type DelegateEnvelope,
  type FanoutDeps,
  type ManifestEntry,
} from "./flow-delegate-fanout";

describe("parseFanoutArgs", () => {
  it("requires --manifest", () => {
    expect(parseFanoutArgs([])).toEqual({ error: "--manifest is required" });
  });

  it("rejects unknown flags", () => {
    expect(parseFanoutArgs(["--manifest", "m.json", "--bogus", "x"])).toEqual({
      error: "unknown flag: --bogus",
    });
  });

  it("rejects a value-flag with no value", () => {
    expect(parseFanoutArgs(["--manifest"])).toEqual({
      error: "--manifest requires a value",
    });
  });

  it("rejects a non-positive --concurrency", () => {
    expect(
      parseFanoutArgs(["--manifest", "m.json", "--concurrency", "0"]),
    ).toEqual({ error: "--concurrency must be a positive integer" });
    expect(
      parseFanoutArgs(["--manifest", "m.json", "--concurrency", "-2"]),
    ).toEqual({ error: "--concurrency must be a positive integer" });
  });

  it("rejects a non-positive --max-calls", () => {
    expect(
      parseFanoutArgs(["--manifest", "m.json", "--max-calls", "0"]),
    ).toEqual({ error: "--max-calls must be a positive integer" });
  });

  it("applies defaults (concurrency 4, max-calls 40, default --out)", () => {
    expect(parseFanoutArgs(["--manifest", "m.json"])).toEqual({
      manifest: "m.json",
      concurrency: 4,
      maxCalls: 40,
      out: path.join(".flow-tmp", "research", "fanout-result.json"),
    });
  });

  it("honors explicit flags", () => {
    expect(
      parseFanoutArgs([
        "--manifest",
        "m.json",
        "--concurrency",
        "2",
        "--max-calls",
        "10",
        "--out",
        "/tmp/agg.json",
      ]),
    ).toEqual({
      manifest: "m.json",
      concurrency: 2,
      maxCalls: 10,
      out: "/tmp/agg.json",
    });
  });

  it("accepts --default-entry-timeout and surfaces the value", () => {
    expect(
      parseFanoutArgs([
        "--manifest",
        "m.json",
        "--default-entry-timeout",
        "3m",
      ]),
    ).toMatchObject({ manifest: "m.json", defaultEntryTimeout: "3m" });
  });

  it("rejects --default-entry-timeout with no value", () => {
    expect(
      parseFanoutArgs(["--manifest", "m.json", "--default-entry-timeout"]),
    ).toEqual({ error: "--default-entry-timeout requires a value" });
  });
});

describe("entryToDelegateArgv", () => {
  it("builds a flow-delegate argv with --task/--out and prompt", () => {
    const argv = entryToDelegateArgv(
      { task: "angle-1", model: "Gemini 3.1 Pro (High)", prompt: "go" },
      "/o/a.md",
    );
    expect(argv).toEqual([
      "--task",
      "angle-1",
      "--out",
      "/o/a.md",
      "--model",
      "Gemini 3.1 Pro (High)",
      "--prompt",
      "go",
    ]);
  });

  it("forwards promptFile, timeout, and each addDir", () => {
    const argv = entryToDelegateArgv(
      {
        task: "t",
        promptFile: "/p.txt",
        timeout: "10m",
        addDirs: ["/a", "/b"],
      },
      "/o/t.md",
    );
    expect(argv).toContain("--prompt-file");
    expect(argv).toContain("/p.txt");
    expect(argv[argv.indexOf("--timeout") + 1]).toBe("10m");
    expect(argv.filter((t) => t === "--add-dir").length).toBe(2);
  });
});

describe("entryOutPath", () => {
  it("derives <dir-of-aggregate>/artifacts/<index>-<sanitized-task>.md", () => {
    expect(
      entryOutPath(
        { task: "angle 1/contrarian", prompt: "x" },
        "/run/agg.json",
        0,
      ),
    ).toBe(path.join("/run", "artifacts", "0-angle-1-contrarian.md"));
  });

  it("lets a manifest entry's own out override (not index-prefixed)", () => {
    expect(
      entryOutPath(
        { task: "t", prompt: "x", out: "/custom/o.md" },
        "/run/agg.json",
        3,
      ),
    ).toBe("/custom/o.md");
  });

  it("gives two tasks with colliding sanitized names DISTINCT out paths", () => {
    // The task sanitizer is lossy: "climate impact", "climate/impact", and
    // "climate:impact" all collapse to "climate-impact". Without the index
    // prefix these three concurrent entries would share one --out and silently
    // overwrite each other; the 0-based index prefix keeps them distinct.
    const a = entryOutPath(
      { task: "climate impact", prompt: "x" },
      "/r/a.json",
      0,
    );
    const b = entryOutPath(
      { task: "climate/impact", prompt: "x" },
      "/r/a.json",
      1,
    );
    const c = entryOutPath(
      { task: "climate:impact", prompt: "x" },
      "/r/a.json",
      2,
    );
    expect(new Set([a, b, c]).size).toBe(3);
    expect(a).toBe(path.join("/r", "artifacts", "0-climate-impact.md"));
    expect(b).toBe(path.join("/r", "artifacts", "1-climate-impact.md"));
    expect(c).toBe(path.join("/r", "artifacts", "2-climate-impact.md"));
  });
});

// A controlled async runner: each dispatch parks on a deferred promise that the
// test releases. It records a maxDepth counter (increment on entry, decrement
// on resolve) so the concurrency cap is observable. A SYNCHRONOUS stub would
// serialize and observe max-depth 1 regardless of the pool size — so the runner
// being async is load-bearing for the cap assertion.
function deferredRunner(envelopeFor: (e: ManifestEntry) => DelegateEnvelope) {
  let depth = 0;
  let maxDepth = 0;
  const releases: Array<() => void> = [];
  const runDelegate = (entry: ManifestEntry): Promise<DelegateEnvelope> => {
    depth++;
    maxDepth = Math.max(maxDepth, depth);
    return new Promise<DelegateEnvelope>((resolveFn) => {
      releases.push(() => {
        depth--;
        resolveFn(envelopeFor(entry));
      });
    });
  };
  return {
    runDelegate,
    get maxDepth() {
      return maxDepth;
    },
    get inFlight() {
      return releases.length;
    },
    releaseAll() {
      while (releases.length) releases.shift()!();
    },
    releaseOne() {
      const r = releases.shift();
      if (r) r();
    },
  };
}

function makeDeps(overrides: Partial<FanoutDeps> = {}): FanoutDeps & {
  calls: { out: string[]; written: Array<{ path: string; data: string }> };
} {
  const calls = {
    out: [] as string[],
    written: [] as Array<{ path: string; data: string }>,
  };
  return {
    runDelegate: async (entry) => ({
      ran: true,
      task: entry.task,
      artifactPath: "/x.md",
    }),
    readFile: () => "[]",
    fileExists: () => true,
    mkdirp: () => {},
    writeFile: (p, data) => {
      calls.written.push({ path: p, data });
    },
    writeOut: (line) => {
      calls.out.push(line);
    },
    progress: () => {},
    cwd: () => "/work",
    calls,
    ...overrides,
  };
}

const aggregate = (deps: { calls: { out: string[] } }) =>
  JSON.parse(deps.calls.out[0] as string);

const manifestOf = (entries: ManifestEntry[]) => JSON.stringify(entries);

describe("run — usage errors (exit 2)", () => {
  it("exits 2 on a missing --manifest flag", async () => {
    const deps = makeDeps();
    await expect(run([], deps)).resolves.toBe(2);
  });

  it("exits 2 on an unknown flag", async () => {
    const deps = makeDeps();
    await expect(
      run(["--manifest", "m.json", "--bogus", "x"], deps),
    ).resolves.toBe(2);
  });

  it("exits 2 on a non-positive --concurrency", async () => {
    const deps = makeDeps();
    await expect(
      run(["--manifest", "m.json", "--concurrency", "0"], deps),
    ).resolves.toBe(2);
  });

  it("exits 2 on a non-positive --max-calls", async () => {
    const deps = makeDeps();
    await expect(
      run(["--manifest", "m.json", "--max-calls", "0"], deps),
    ).resolves.toBe(2);
  });

  it("exits 2 when the manifest file does not exist", async () => {
    const deps = makeDeps({ fileExists: () => false });
    await expect(run(["--manifest", "nope.json"], deps)).resolves.toBe(2);
  });

  it("exits 2 when the manifest is not valid JSON", async () => {
    const deps = makeDeps({ readFile: () => "{not json" });
    await expect(run(["--manifest", "m.json"], deps)).resolves.toBe(2);
  });

  it("exits 2 when the manifest is not an array", async () => {
    const deps = makeDeps({ readFile: () => '{"task":"x"}' });
    await expect(run(["--manifest", "m.json"], deps)).resolves.toBe(2);
  });

  it("exits 2 when an entry lacks exactly one prompt source", async () => {
    const deps = makeDeps({
      readFile: () => manifestOf([{ task: "t" } as ManifestEntry]),
    });
    await expect(run(["--manifest", "m.json"], deps)).resolves.toBe(2);
  });
});

describe("run — aggregation + concurrency", () => {
  it("aggregates the exact shape incl. calls counts and persists to stdout + --out", async () => {
    const deps = makeDeps({
      readFile: () =>
        manifestOf([
          { task: "a", model: "Gemini 3.1 Pro (High)", prompt: "x" },
          { task: "b", prompt: "y" },
        ]),
    });
    await expect(
      run(["--manifest", "m.json", "--out", "/o/agg.json"], deps),
    ).resolves.toBe(0);
    const agg = aggregate(deps);
    expect(agg).toMatchObject({
      anyRan: true,
      allSkipped: false,
      calls: { attempted: 2, ran: 2, skipped: 0, budget: 40 },
    });
    expect(agg.entries).toHaveLength(2);
    expect(agg.entries[0]).toMatchObject({
      task: "a",
      model: "Gemini 3.1 Pro (High)",
      ran: true,
    });
    expect(agg.entries[0]).toHaveProperty("durationMs");
    // Same serialized string to both sinks (emitResult contract).
    expect(deps.calls.written).toHaveLength(1);
    expect(deps.calls.written[0]!.data).toBe(deps.calls.out[0]);
    expect(deps.calls.written[0]!.path).toBe(
      path.resolve("/work", "/o/agg.json"),
    );
  });

  it("never exceeds K concurrent dispatches (async deferred runner)", async () => {
    const runner = deferredRunner((e) => ({
      ran: true,
      task: e.task,
      artifactPath: "/x.md",
    }));
    const entries = Array.from({ length: 9 }, (_, i) => ({
      task: `t${i}`,
      prompt: "x",
    }));
    const deps = makeDeps({
      readFile: () => manifestOf(entries),
      runDelegate: runner.runDelegate,
    });
    const done = run(["--manifest", "m.json", "--concurrency", "3"], deps);
    // Let the pool fill, then drain in waves; the cap must hold throughout.
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.inFlight).toBeLessThanOrEqual(3);
    while (runner.inFlight > 0) {
      runner.releaseOne();
      await Promise.resolve();
      await Promise.resolve();
    }
    await expect(done).resolves.toBe(0);
    expect(runner.maxDepth).toBeLessThanOrEqual(3);
    expect(runner.maxDepth).toBeGreaterThan(1); // proves the pool actually parallelised
  });
});

describe("run — budget", () => {
  it("dispatches at most B entries and marks the remainder budget-exhausted", async () => {
    const entries = Array.from({ length: 4 }, (_, i) => ({
      task: `t${i}`,
      prompt: "x",
    }));
    const dispatched: string[] = [];
    const deps = makeDeps({
      readFile: () => manifestOf(entries),
      runDelegate: async (entry) => {
        dispatched.push(entry.task);
        return { ran: true, task: entry.task, artifactPath: "/x.md" };
      },
    });
    await expect(
      run(["--manifest", "m.json", "--max-calls", "2"], deps),
    ).resolves.toBe(0);
    expect(dispatched).toEqual(["t0", "t1"]);
    const agg = aggregate(deps);
    expect(agg.calls).toEqual({ attempted: 2, ran: 2, skipped: 2, budget: 2 });
    const exhausted = agg.entries.filter(
      (e: { skipReason?: string }) => e.skipReason === "budget-exhausted",
    );
    expect(exhausted.map((e: { task: string }) => e.task)).toEqual([
      "t2",
      "t3",
    ]);
    expect(exhausted.every((e: { ran: boolean }) => e.ran === false)).toBe(
      true,
    );
  });
});

describe("run — --default-entry-timeout backstop", () => {
  // runDelegate receives the entry AFTER the default has been folded in, so the
  // seam to assert on is each dispatched entry's effective `timeout`.
  const captureTimeouts = (entries: ManifestEntry[], argv: string[]) => {
    const seen: Array<string | undefined> = [];
    const deps = makeDeps({
      readFile: () => manifestOf(entries),
      runDelegate: async (entry) => {
        seen.push(entry.timeout);
        return { ran: true, task: entry.task, artifactPath: "/x.md" };
      },
    });
    return { deps, seen, done: run(["--manifest", "m.json", ...argv], deps) };
  };

  it("applies the default to a no-timeout entry", async () => {
    const { seen, done } = captureTimeouts(
      [{ task: "a", prompt: "x" }],
      ["--default-entry-timeout", "3m"],
    );
    await expect(done).resolves.toBe(0);
    expect(seen).toEqual(["3m"]);
  });

  it("lets a per-entry timeout override the default", async () => {
    const { seen, done } = captureTimeouts(
      [{ task: "a", prompt: "x", timeout: "10m" }],
      ["--default-entry-timeout", "3m"],
    );
    await expect(done).resolves.toBe(0);
    expect(seen).toEqual(["10m"]);
  });

  it("injects no timeout when --default-entry-timeout is absent", async () => {
    const { seen, done } = captureTimeouts([{ task: "a", prompt: "x" }], []);
    await expect(done).resolves.toBe(0);
    expect(seen).toEqual([undefined]);
    // and the built delegate argv carries no --timeout
    expect(
      entryToDelegateArgv({ task: "a", prompt: "x" }, "/o/a.md"),
    ).not.toContain("--timeout");
  });
});

describe("run — skip handling", () => {
  it("mixed run/skip ⇒ anyRan true, allSkipped false, per-entry ran/skipReason intact", async () => {
    const deps = makeDeps({
      readFile: () =>
        manifestOf([
          { task: "ok", prompt: "x" },
          { task: "miss", prompt: "y" },
        ]),
      runDelegate: async (entry) =>
        entry.task === "ok"
          ? { ran: true, task: "ok", artifactPath: "/ok.md" }
          : { ran: false, task: "miss", skipReason: "agy-not-found" },
    });
    await expect(run(["--manifest", "m.json"], deps)).resolves.toBe(0);
    const agg = aggregate(deps);
    expect(agg).toMatchObject({ anyRan: true, allSkipped: false });
    expect(agg.calls).toMatchObject({ attempted: 2, ran: 1, skipped: 1 });
    expect(
      agg.entries.find((e: { task: string }) => e.task === "ok"),
    ).toMatchObject({
      ran: true,
      artifactPath: "/ok.md",
    });
    expect(
      agg.entries.find((e: { task: string }) => e.task === "miss"),
    ).toMatchObject({
      ran: false,
      skipReason: "agy-not-found",
    });
  });

  it("every entry agy-not-found ⇒ allSkipped:true and exit 0", async () => {
    const deps = makeDeps({
      readFile: () =>
        manifestOf([
          { task: "a", prompt: "x" },
          { task: "b", prompt: "y" },
        ]),
      runDelegate: async (entry) => ({
        ran: false,
        task: entry.task,
        skipReason: "agy-not-found",
      }),
    });
    await expect(run(["--manifest", "m.json"], deps)).resolves.toBe(0);
    const agg = aggregate(deps);
    expect(agg.anyRan).toBe(false);
    expect(agg.allSkipped).toBe(true);
    expect(agg.calls).toMatchObject({ attempted: 2, ran: 0, skipped: 2 });
  });

  it("treats a thrown dispatch as a graceful agy-error skip (does not reject)", async () => {
    const deps = makeDeps({
      readFile: () => manifestOf([{ task: "boom", prompt: "x" }]),
      runDelegate: async () => {
        throw new Error("spawn flow-delegate ENOMEM");
      },
    });
    await expect(run(["--manifest", "m.json"], deps)).resolves.toBe(0);
    expect(aggregate(deps).entries[0]).toMatchObject({
      ran: false,
      skipReason: "agy-error",
    });
  });
});

describe("run — --out write isolation", () => {
  it("a writeFile throw does not change the exit code or suppress stdout", async () => {
    const out: string[] = [];
    const deps = makeDeps({
      readFile: () => manifestOf([{ task: "a", prompt: "x" }]),
      writeOut: (line) => out.push(line),
      writeFile: () => {
        throw new Error("EACCES: permission denied, write");
      },
    });
    await expect(run(["--manifest", "m.json"], deps)).resolves.toBe(0);
    // stdout still carries the aggregate even though persistence failed.
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] as string)).toMatchObject({ anyRan: true });
  });

  it("a mkdirp throw is swallowed (exit 0, stdout intact)", async () => {
    const out: string[] = [];
    const deps = makeDeps({
      readFile: () => manifestOf([{ task: "a", prompt: "x" }]),
      writeOut: (line) => out.push(line),
      mkdirp: () => {
        throw new Error("EACCES: permission denied, mkdir");
      },
    });
    await expect(run(["--manifest", "m.json"], deps)).resolves.toBe(0);
    expect(out).toHaveLength(1);
  });
});

// Real-subprocess spec for the un-injected default runner (the binary-spawn
// seam dependency injection never covers). It runs the built helper against a
// PATH that lacks `agy`, so each delegate child takes the agy-not-found skip
// and the aggregate reports allSkipped — exercising defaultRunDelegate end to
// end. Mirrors flow-delegate.test.ts:354-387's it.skipIf-guarded pattern.
describe("flow-delegate-fanout (subprocess, agy absent from PATH)", () => {
  const HELPER = path.resolve(__dirname, "flow-delegate-fanout.ts");
  const SKIP_PATH = "/usr/local/bin:/usr/bin:/bin";
  const bunPath =
    spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim() || "bun";
  const agyInSkipPath =
    spawnSync("sh", ["-c", "which agy"], {
      encoding: "utf8",
      env: { PATH: SKIP_PATH },
    }).status === 0;

  it.skipIf(agyInSkipPath)(
    "reports allSkipped + exit 0 when agy is off PATH",
    () => {
      const tmpDir = path.join(__dirname, "..", ".flow-tmp");
      spawnSync("mkdir", ["-p", tmpDir]);
      const manifestPath = path.join(tmpDir, "fanout-test-manifest.json");
      const outPath = path.join(tmpDir, "fanout-test-result.json");
      const manifest = JSON.stringify([
        { task: "probe-a", prompt: "x" },
        { task: "probe-b", prompt: "y" },
      ]);
      spawnSync("sh", ["-c", `cat > ${JSON.stringify(manifestPath)}`], {
        input: manifest,
      });
      const r = spawnSync(
        bunPath,
        ["run", HELPER, "--manifest", manifestPath, "--out", outPath],
        { encoding: "utf8", env: { PATH: SKIP_PATH } },
      );
      expect(r.status).toBe(0);
      const agg = JSON.parse(r.stdout.trim());
      expect(agg).toMatchObject({ anyRan: false, allSkipped: true });
      expect(agg.entries.every((e: { ran: boolean }) => e.ran === false)).toBe(
        true,
      );
    },
  );
});
