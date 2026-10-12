import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  computeSchedule,
  loadFactor,
  parseArgs,
  run,
  runPreflight,
  type PreflightDeps,
} from "./flow-ui-preflight";
import type { UiValidationManifest } from "./lib/ui-validation-schema";

type Harness = {
  deps: PreflightDeps;
  clock: { t: number };
  sleeps: number[];
  fetches: Array<{ url: string; timeoutMs: number }>;
  execs: string[][];
  written: Record<string, string>;
};

function harness(
  opts: {
    statuses?: Array<number | "refused">;
    loadavg?: number[];
    cpus?: number;
    startCode?: number;
    manifestRaw?: string | null;
    probesTakeFullTimeout?: boolean;
  } = {},
): Harness {
  const h: Harness = {
    clock: { t: 1_000_000 },
    sleeps: [],
    fetches: [],
    execs: [],
    written: {},
    deps: undefined as unknown as PreflightDeps,
  };
  const statuses = [...(opts.statuses ?? [])];
  h.deps = {
    fetch: async (url, timeoutMs) => {
      h.fetches.push({ url, timeoutMs });
      if (opts.probesTakeFullTimeout) h.clock.t += timeoutMs;
      const next = statuses.length > 1 ? statuses.shift()! : statuses[0];
      if (next === undefined || next === "refused") {
        throw new Error("connection refused");
      }
      return next;
    },
    sleep: async (ms) => {
      h.sleeps.push(ms);
      h.clock.t += ms;
    },
    loadavg: () => opts.loadavg ?? [0.5, 0.5, 0.5],
    cpus: () => opts.cpus ?? 4,
    now: () => h.clock.t,
    exec: async (argv) => {
      h.execs.push(argv);
      if (argv[0] === "git") return { code: 0, stdout: "abc123\n" };
      h.clock.t += 2_000;
      return { code: opts.startCode ?? 0, stdout: "" };
    },
    readFile: () => opts.manifestRaw ?? null,
    writeFile: (p, c) => {
      h.written[p] = c;
    },
  };
  return h;
}

function manifest(
  deps: UiValidationManifest["dependsOn"],
): UiValidationManifest {
  return {
    launch: "npm run dev",
    baseUrl: "http://localhost:5173",
    routes: [{ path: "/" }],
    dependsOn: deps,
  };
}

const DB = { name: "db", url: "http://127.0.0.1:54321/" };

describe("loadFactor / computeSchedule", () => {
  it("clamps load per CPU into [1, 3]", () => {
    expect(loadFactor(0.5, 4)).toBe(1);
    expect(loadFactor(8, 4)).toBe(2);
    expect(loadFactor(400, 4)).toBe(3);
    expect(loadFactor(Number.NaN, 4)).toBe(1);
  });

  it("scales waits, probe timeout and budget; caps the budget at 540 s", () => {
    const s = computeSchedule(2, 100);
    expect(s.waitsMs).toEqual([10_000, 30_000, 60_000, 120_000, 180_000]);
    expect(s.probeTimeoutMs).toBe(10_000);
    expect(s.budgetMs).toBe(200_000);
    expect(computeSchedule(3, 300).budgetMs).toBe(540_000);
  });
});

describe("runPreflight", () => {
  it("a refused url with a 3 s budget yields dependency-unready and a load snapshot", async () => {
    const h = harness({ statuses: ["refused"], loadavg: [1, 2, 3] });
    const env = await runPreflight(
      manifest([DB]),
      { budgetSec: 3, worktree: "/wt" },
      h.deps,
    );
    expect(env.ready).toBe(false);
    expect(env.skipped_reason).toBe("dependency-unready");
    expect(env.load).toEqual({ loadavg: [1, 2, 3], cpus: 4 });
    expect(env.headSha).toBe("abc123");
    expect(env.dependencies[0].attempts).toBeGreaterThanOrEqual(1);
    expect(env.dependencies[0].lastStatus).toBe("connection refused");
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3_000);
  });

  it("runs start exactly once after the first failed probe, then re-probes", async () => {
    const h = harness({ statuses: ["refused", 200] });
    const env = await runPreflight(
      manifest([{ ...DB, start: "docker compose up -d" }]),
      { budgetSec: 300, worktree: "/wt" },
      h.deps,
    );
    const starts = h.execs.filter((a) => a[0] === "sh");
    expect(starts).toEqual([["sh", "-c", "docker compose up -d"]]);
    expect(env.ready).toBe(true);
    expect(env.skipped_reason).toBeUndefined();
    expect(env.dependencies[0]).toMatchObject({
      attempts: 2,
      startAttempted: true,
      startExitCode: 0,
      startedByFlow: true,
    });
  });

  it("does not claim startedByFlow when start exits non-zero, and never re-runs it", async () => {
    const h = harness({ statuses: ["refused"], startCode: 1 });
    const env = await runPreflight(
      manifest([{ ...DB, start: "false" }]),
      { budgetSec: 300, worktree: "/wt" },
      h.deps,
    );
    expect(h.execs.filter((a) => a[0] === "sh")).toHaveLength(1);
    expect(env.dependencies[0]).toMatchObject({
      ready: false,
      startExitCode: 1,
      startedByFlow: false,
    });
  });

  it("scales waits, probe timeout and budget by the load factor (capped at 3, budget at 540)", async () => {
    const h = harness({ statuses: ["refused"], loadavg: [8, 8, 8], cpus: 4 });
    await runPreflight(
      manifest([DB]),
      { budgetSec: 300, worktree: "/wt" },
      h.deps,
    );
    expect(h.fetches[0].timeoutMs).toBe(10_000);
    expect(h.sleeps.slice(0, 2)).toEqual([10_000, 30_000]);

    const hot = harness({
      statuses: ["refused"],
      loadavg: [400, 400, 400],
      cpus: 4,
    });
    await runPreflight(
      manifest([DB]),
      { budgetSec: 300, worktree: "/wt" },
      hot.deps,
    );
    expect(hot.fetches[0].timeoutMs).toBe(15_000);
    expect(hot.sleeps[0]).toBe(15_000);
    expect(hot.clock.t - 1_000_000).toBe(540_000);
  });

  it("waits out the whole budget on an unreachable dependency, repeating the last wait", async () => {
    const h = harness({ statuses: ["refused"] });
    const env = await runPreflight(
      manifest([DB]),
      { budgetSec: 300, worktree: "/wt" },
      h.deps,
    );
    expect(env.ready).toBe(false);
    expect(h.sleeps.slice(0, 6)).toEqual([
      5_000, 15_000, 30_000, 60_000, 90_000, 90_000,
    ]);
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBe(300_000);
    expect(env.dependencies[0].attempts).toBe(h.sleeps.length);
  });

  it("the 540 s cap is what stops a fully loaded run", async () => {
    const h = harness({
      statuses: ["refused"],
      loadavg: [400, 400, 400],
      cpus: 4,
    });
    await runPreflight(
      manifest([DB]),
      { budgetSec: 300, worktree: "/wt" },
      h.deps,
    );
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBe(540_000);
    expect(h.sleeps.at(-1)).toBeLessThan(270_000);
  });

  it("clamps each probe to the time left, so slow probes never overrun the budget", async () => {
    const h = harness({ statuses: ["refused"], probesTakeFullTimeout: true });
    await runPreflight(
      manifest([DB]),
      { budgetSec: 12, worktree: "/wt" },
      h.deps,
    );
    expect(h.clock.t - 1_000_000).toBe(12_000);
    expect(h.fetches.at(-1)!.timeoutMs).toBe(2_000);
  });

  it("shares one budget across dependencies: a later one still gets a single probe", async () => {
    const h = harness({ statuses: ["refused"] });
    const env = await runPreflight(
      manifest([
        DB,
        { name: "cache", url: "http://127.0.0.1:6379/", start: "x" },
      ]),
      { budgetSec: 10, worktree: "/wt" },
      h.deps,
    );
    expect(env.dependencies[1]).toMatchObject({
      attempts: 1,
      startAttempted: false,
    });
    expect(h.fetches.at(-1)!.timeoutMs).toBe(1_000);
    expect(h.execs.filter((a) => a[0] === "sh")).toEqual([]);
  });

  it("counts 5xx as not ready and 404 as ready", async () => {
    const down = await runPreflight(
      manifest([DB]),
      { budgetSec: 1, worktree: "/wt" },
      harness({ statuses: [503] }).deps,
    );
    expect(down.ready).toBe(false);
    expect(down.dependencies[0].lastStatus).toBe(503);

    const up = await runPreflight(
      manifest([DB]),
      { budgetSec: 1, worktree: "/wt" },
      harness({ statuses: [404] }).deps,
    );
    expect(up.ready).toBe(true);
    expect(up.dependencies[0]).toMatchObject({ attempts: 1, lastStatus: 404 });
  });

  it("a null manifest or one without dependsOn is ready with no dependencies", async () => {
    for (const m of [null, manifest(undefined)]) {
      const env = await runPreflight(
        m,
        { budgetSec: 300, worktree: "/wt" },
        harness().deps,
      );
      expect(env.ready).toBe(true);
      expect(env.dependencies).toEqual([]);
      expect(env.headSha).toBe("abc123");
    }
  });
});

describe("run", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("writes .flow-tmp/ui-preflight.json and exits 0 without a manifest", async () => {
    const h = harness();
    const code = await run(["--worktree", "/wt"], h.deps);
    expect(code).toBe(0);
    const written = h.written["/wt/.flow-tmp/ui-preflight.json"];
    expect(JSON.parse(written)).toMatchObject({
      ready: true,
      dependencies: [],
    });
  });

  it("exits 0 with ready:false for an unreachable declared dependency", async () => {
    const raw = JSON.stringify(manifest([DB]));
    const h = harness({ statuses: ["refused"], manifestRaw: raw });
    const code = await run(["--worktree", "/wt", "--budget-sec", "2"], h.deps);
    expect(code).toBe(0);
    expect(
      JSON.parse(h.written["/wt/.flow-tmp/ui-preflight.json"]).skipped_reason,
    ).toBe("dependency-unready");
  });

  it("exits 2 on an invalid manifest", async () => {
    const raw = JSON.stringify(manifest([{ name: "", url: "http://x/" }]));
    const h = harness({ manifestRaw: raw });
    expect(await run(["--worktree", "/wt"], h.deps)).toBe(2);
    expect(h.written).toEqual({});
  });

  it.each([
    [["--bogus"]],
    [["--budget-sec"]],
    [["--budget-sec", "0"]],
    [["--budget-sec", "abc"]],
    [["--worktree"]],
  ])("exits 2 on bad args %j", async (argv) => {
    expect(await run(argv, harness().deps)).toBe(2);
    expect(parseArgs(argv)).toHaveProperty("error");
  });
});
