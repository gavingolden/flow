import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLaunch } from "./epic-manage-launch";
import { managerDir, readManagerLog } from "./epic-manager-log";
import {
  abortableSleep,
  afterMergesObserved,
  createLoopContext,
  installStopHandlers,
  orderFrontier,
  runManagerLoop,
  tick,
  type LoopConfig,
  type LoopContext,
  type LoopDeps,
} from "./epic-manage-loop";
import {
  readManager,
  writeManager,
  type ManagerState,
} from "./epic-manage-state";
import type { ExecFn } from "./epic-manage-observe";
import type { EpicManifest, Feature } from "./epic-manifest-schema";
import { writeEpicRunState, type EpicRunState } from "./epic-run-state";
import { writeState, type PipelineState } from "./state";

const EPIC = "my-epic";
const T0 = Date.parse("2026-10-26T12:00:00Z");

let tmp!: string;
let repoDir!: string;
let stateDir!: string;
let epicsDir!: string;
let manifestPath!: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-loop-")));
  repoDir = path.join(tmp, "repo");
  stateDir = path.join(tmp, "state");
  epicsDir = path.join(tmp, "epics");
  manifestPath = path.join(repoDir, ".flow", "epics", EPIC, "manifest.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const feat = (
  id: string,
  dependsOn: string[] = [],
  extra: Partial<Feature> = {},
): Feature => ({
  id,
  title: id,
  description: `build ${id}`,
  dependsOn,
  ...extra,
});

function writeManifest(...features: Feature[]): void {
  const m: EpicManifest = {
    epicId: EPIC,
    prompt: "p",
    createdAt: "2026-10-26",
    features,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(m));
}

function pipeline(
  id: string,
  phase: string,
  over: Partial<PipelineState> = {},
): PipelineState {
  return {
    slug: id,
    phase,
    repo: repoDir,
    updatedAt: "2026-10-26T00:00:00Z",
    epic: { slug: EPIC, featureId: id },
    ...over,
  };
}

/** Bind `id` in run.json and write its pipeline state, as a finished `flow epic launch` would. */
function bind(
  id: string,
  phase = "implementing",
  over: Partial<PipelineState> = {},
): void {
  const existing = (() => {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(epicsDir, EPIC, "run.json"), "utf8"),
      ) as EpicRunState;
    } catch {
      return null;
    }
  })();
  const run: EpicRunState = existing ?? {
    epicSlug: EPIC,
    repo: repoDir,
    manifestPath,
    manifestSha: "s",
    createdAt: "t",
    updatedAt: "t",
    features: {},
  };
  run.features[id] = { slug: id, launchedAt: "2026-10-26T00:00:00Z" };
  writeEpicRunState(run, epicsDir);
  writeState(pipeline(id, phase, over), stateDir);
}

const setPhase = (
  id: string,
  phase: string,
  over: Partial<PipelineState> = {},
): void => writeState(pipeline(id, phase, over), stateDir);

type Harness = {
  cfg: LoopConfig;
  deps: LoopDeps;
  clock: { t: number };
  spawns: string[][];
  notifies: string[][];
  writes: string[];
  execCalls: { cmd: string; args: string[] }[];
  prs: unknown[];
  gh: { fail: boolean; unresolvable: boolean };
  hold: { on: boolean; release: () => void };
  failSpawn: { code: number; output?: string; reject?: boolean };
  ctx: () => LoopContext;
};

function harness(
  opts: {
    manager?: Partial<ManagerState>;
    maxParallel?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Harness {
  const clock = { t: T0 };
  const spawns: string[][] = [];
  const notifies: string[][] = [];
  const writes: string[] = [];
  const execCalls: { cmd: string; args: string[] }[] = [];
  const state = {
    prs: [] as unknown[],
    gh: { fail: false, unresolvable: false },
    hold: { on: false, release: () => {} },
    failSpawn: { code: 0 } as {
      code: number;
      output?: string;
      reject?: boolean;
    },
  };
  const manager: ManagerState = {
    version: 1,
    epicSlug: EPIC,
    repo: repoDir,
    window: `manage-${EPIC}`,
    pid: process.pid,
    procStartedAt: null,
    startedAt: new Date(T0).toISOString(),
    heartbeatAt: new Date(T0).toISOString(),
    pollMs: 3000,
    autonomy: "observe",
    model: "opus",
    effort: "high",
    featureFallback: {},
    status: "running",
    launching: null,
    ...opts.manager,
  };
  const exec: ExecFn = async (cmd, args) => {
    execCalls.push({ cmd, args });
    if (cmd === "gh" && args[0] === "repo") {
      return state.gh.unresolvable
        ? { exitCode: 1, stdout: "", stderr: "no" }
        : {
            exitCode: 0,
            stdout: '{"owner":{"login":"me"},"name":"flow"}',
            stderr: "",
          };
    }
    if (cmd === "gh" && args[0] === "api") {
      return state.gh.fail
        ? { exitCode: 1, stdout: "", stderr: "HTTP 502 Bad Gateway\nmore" }
        : {
            exitCode: 0,
            stdout: JSON.stringify({
              data: { repository: { open: { nodes: state.prs } } },
            }),
            stderr: "",
          };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const deps: LoopDeps = {
    exec,
    spawnLaunch: async (args, outPath) => {
      spawns.push(args);
      if (state.hold.on)
        await new Promise<void>((r) => (state.hold.release = r));
      if (state.failSpawn.output !== undefined)
        fs.writeFileSync(outPath, state.failSpawn.output);
      if (state.failSpawn.reject) throw new Error("spawn exploded");
      if (state.failSpawn.code === 0) bind(args[3]!);
      return { exitCode: state.failSpawn.code };
    },
    notify: (args) => void notifies.push(args),
    now: () => clock.t,
    sleep: async (ms, signal) => {
      if (!signal.aborted) clock.t += ms;
    },
    write: (text) => void writes.push(text),
    isTty: false,
    stateDir,
    epicsDir,
    readMaxParallel: () => opts.maxParallel ?? 3,
    headSha: async () => "abc1234",
    sameRepo: (p) => p === repoDir,
    env: opts.env ?? { FLOW_NOTIFY: "1" },
  };
  const cfg: LoopConfig = {
    manager,
    manifestPath,
    statePollMs: 3000,
    githubPollMs: 90_000,
  };
  let ctx: LoopContext | null = null;
  return {
    cfg,
    deps,
    clock,
    spawns,
    notifies,
    writes,
    execCalls,
    ...state,
    ctx: () => (ctx ??= createLoopContext(cfg, deps)),
  } as Harness;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Tick until the harness reaches quiescence (no launch started for two ticks). */
async function quiesce(h: Harness, max = 30): Promise<void> {
  let idle = 0;
  for (let i = 0; i < max && idle < 2; i++) {
    const r = await tick(h.ctx(), h.deps);
    await flush();
    h.clock.t += 3000;
    idle = r.launched ? 0 : idle + 1;
  }
}

describe("tick — launch matrix", () => {
  it("launches exactly one ready frontier node per tick, serially, carrying no flags when hints are absent", async () => {
    writeManifest(feat("alpha"), feat("beta"), feat("gamma", ["alpha"]));
    const h = harness();
    const first = await tick(h.ctx(), h.deps);
    expect(first.launched).toBe("alpha");
    expect(h.spawns).toEqual([["epic", "launch", EPIC, "alpha"]]);
    await flush();
    const second = await tick(h.ctx(), h.deps);
    expect(second.launched).toBe("beta");
    expect(h.spawns).toHaveLength(2);
    expect(h.spawns.every((a) => !a.includes("--model"))).toBe(true);
  });

  it("carries --model/--effort only for hints the manifest lacks", async () => {
    writeManifest(
      feat("alpha", [], { flowNewHints: { model: "opus" } }),
      feat("beta", ["alpha"]),
    );
    const h = harness({
      manager: { featureFallback: { model: "haiku", effort: "low" } },
    });
    await tick(h.ctx(), h.deps);
    expect(h.spawns[0]).toEqual([
      "epic",
      "launch",
      EPIC,
      "alpha",
      "--effort",
      "low",
    ]);
  });

  it("never launches a second feature while one launch child is still running", async () => {
    writeManifest(feat("alpha"), feat("beta"));
    const h = harness();
    h.hold.on = true;
    await tick(h.ctx(), h.deps);
    for (let i = 0; i < 3; i++) {
      await tick(h.ctx(), h.deps);
      h.clock.t += 3000;
    }
    expect(h.spawns).toHaveLength(1);
    expect(h.writes.at(-1)).toContain("launching: alpha");
    h.hold.release();
    await flush();
    const next = await tick(h.ctx(), h.deps);
    expect(next.launched).toBe("beta");
  });

  it("respects the cap: three ready, cap two, one running — exactly one launch, the rest wait for capacity", async () => {
    writeManifest(feat("run1"), feat("alpha"), feat("beta"), feat("gamma"));
    bind("run1");
    const h = harness({ maxParallel: 2 });
    await quiesce(h);
    expect(h.spawns).toHaveLength(1);
    expect(h.writes.at(-1)).toMatch(
      /hold: (beta|gamma) — waiting for a free slot/,
    );
  });

  it("flags a failed launch with its output, never retries it, and notifies once", async () => {
    writeManifest(feat("alpha"));
    const h = harness();
    h.failSpawn.code = 2;
    await quiesce(h);
    expect(h.spawns).toHaveLength(1);
    expect(h.writes.at(-1)).toContain("launch failed: alpha");
    const failedNotes = h.notifies.filter((n) =>
      n.join(" ").includes("launch of alpha failed"),
    );
    expect(failedNotes).toEqual([
      [
        "--status",
        "waiting",
        "--slug",
        "manage-my-epic",
        "--reason",
        expect.stringContaining("launch of alpha failed"),
      ],
    ]);
    expect(readManagerLog(EPIC, stateDir).map((e) => e.kind)).toContain(
      "launch-failed",
    );
  });
});

describe("tick — failed launch reasons", () => {
  it("takes the failure reason from the last line of the child's output, on the board and in the notification", async () => {
    writeManifest(feat("alpha"));
    const h = harness();
    h.failSpawn.code = 2;
    h.failSpawn.output =
      "starting\nflow feature create: window alpha already exists\n";
    await quiesce(h);
    expect(h.writes.at(-1)).toContain(
      "launch failed: alpha — flow feature create: window alpha already exists",
    );
    expect(
      h.notifies.some((n) =>
        n
          .join(" ")
          .includes("flow feature create: window alpha already exists"),
      ),
    ).toBe(true);
  });

  it("falls back to the exit code when the launch child rejects", async () => {
    writeManifest(feat("alpha"));
    const h = harness();
    h.failSpawn.reject = true;
    await quiesce(h);
    expect(h.writes.at(-1)).toContain(
      "launch failed: alpha — flow epic launch exited -1",
    );
  });
});

describe("startLaunch — log path", () => {
  it("keeps the launch log inside the manager directory for any feature id", () => {
    const state = {
      epic: EPIC,
      failed: new Map(),
      launching: new Map(),
      inFlight: null,
    } as unknown as Parameters<typeof startLaunch>[0];
    const outs: string[] = [];
    startLaunch(
      state,
      {
        stateDir,
        now: () => T0,
        spawnLaunch: async (_a: string[], outPath: string) => {
          outs.push(outPath);
          return { exitCode: 0 };
        },
      } as unknown as Parameters<typeof startLaunch>[1],
      "x/../../../evil",
      [],
    );
    const dir = managerDir(EPIC, stateDir);
    expect(path.dirname(outs[0]!)).toBe(dir);
    expect(fs.existsSync(path.join(tmp, "evil.log"))).toBe(false);
  });
});

describe("tick — stop signal", () => {
  it("does not start a launch once the stop signal has fired", async () => {
    writeManifest(feat("alpha"));
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const r = await tick(h.ctx(), h.deps, controller.signal);
    expect(r.launched).toBeUndefined();
    expect(h.spawns).toEqual([]);
  });
});

describe("tick — git ref probing", () => {
  const gitProbes = (h: Harness): number =>
    h.execCalls.filter((c) => c.cmd === "git" && c.args[0] === "for-each-ref")
      .length;

  it("serves cached refs between GitHub polls while a node is only held for capacity", async () => {
    writeManifest(feat("run1"), feat("alpha"), feat("beta"));
    bind("run1");
    const h = harness({ maxParallel: 1 });
    for (let i = 0; i < 10; i++) {
      await tick(h.ctx(), h.deps);
      h.clock.t += 3000;
    }
    expect(h.spawns).toEqual([]);
    expect(gitProbes(h)).toBe(1);
    h.clock.t += 90_000;
    await tick(h.ctx(), h.deps);
    expect(gitProbes(h)).toBe(2);
  });

  it("re-probes fresh right before a launch even when the cache is warm", async () => {
    writeManifest(feat("alpha"), feat("beta"));
    const h = harness();
    h.hold.on = true;
    await tick(h.ctx(), h.deps);
    const afterFirst = gitProbes(h);
    h.hold.release();
    h.hold.on = false;
    await flush();
    h.clock.t += 3000;
    const next = await tick(h.ctx(), h.deps);
    expect(next.launched).toBe("beta");
    expect(gitProbes(h)).toBe(afterFirst + 1);
  });

  it("keeps probing for bound-branch drift while no node is ready", async () => {
    writeManifest(feat("alpha"));
    bind("alpha", "implementing", { pr: 5, worktree: "/wt/alpha" });
    const h = harness();
    await tick(h.ctx(), h.deps);
    expect(gitProbes(h)).toBe(1);
  });
});

describe("tick — redraw", () => {
  it("redraws within one tick of a pipeline phase change, and not at all when nothing changed", async () => {
    writeManifest(feat("alpha"));
    bind("alpha", "implementing");
    const h = harness();
    await tick(h.ctx(), h.deps);
    const initial = h.writes.length;
    await tick(h.ctx(), h.deps);
    h.clock.t += 3000;
    expect(h.writes).toHaveLength(initial);
    setPhase("alpha", "reviewing");
    await tick(h.ctx(), h.deps);
    expect(h.writes).toHaveLength(initial + 1);
    expect(h.writes.at(-1)).toContain("reviewing");
  });

  it("clears the screen only on a TTY", async () => {
    writeManifest(feat("alpha"));
    bind("alpha");
    const h = harness();
    h.deps.isTty = true;
    await tick(h.ctx(), h.deps);
    expect(h.writes[0]!.startsWith("\x1b[2J\x1b[H")).toBe(true);
  });
});

describe("runManagerLoop — zero model calls", () => {
  it("an idle epic over a fake hour records no claude / flow-claude-headless invocation and no launch", async () => {
    writeManifest(feat("alpha"));
    bind("alpha", "implementing");
    const h = harness();
    const controller = new AbortController();
    const realSleep = h.deps.sleep;
    h.deps.sleep = async (ms, signal) => {
      await realSleep(ms, signal);
      if (h.clock.t >= T0 + 3_600_000) controller.abort();
    };
    const code = await runManagerLoop(h.cfg, h.deps, controller.signal);
    expect(code).toBe(0);
    expect(h.clock.t - T0).toBeGreaterThanOrEqual(3_600_000);
    expect(h.spawns).toEqual([]);
    const spawned = h.execCalls
      .map((c) => `${c.cmd} ${c.args.join(" ")}`)
      .join("\n");
    expect(spawned).not.toMatch(/claude|flow-claude-headless/);
    expect(
      h.execCalls.filter((c) => c.args[0] === "api").length,
    ).toBeGreaterThanOrEqual(30);
  });
});

describe("tick — GitHub pause", () => {
  it("pauses launches once GitHub has not answered for two poll intervals, with a named board line", async () => {
    writeManifest(feat("alpha"), feat("beta", ["alpha"]));
    bind("alpha");
    const h = harness();
    await tick(h.ctx(), h.deps);
    h.gh.fail = true;
    h.clock.t += 91_000;
    await tick(h.ctx(), h.deps);
    // The last good snapshot is still fresh enough: not paused yet.
    expect(h.writes.at(-1)).not.toContain("GitHub unreachable");
    h.clock.t += 200_000;
    setPhase("alpha", "merged");
    await tick(h.ctx(), h.deps);
    expect(h.spawns).toHaveLength(0);
    expect(h.writes.at(-1)).toContain("GitHub unreachable");
    expect(h.writes.at(-1)).toContain("HTTP 502 Bad Gateway");
    expect(h.writes.at(-1)).not.toContain("(window manage-");
    h.gh.fail = false;
    h.clock.t += 91_000;
    const resumed = await tick(h.ctx(), h.deps);
    expect(resumed.launched).toBe("beta");
  });

  it("never launches before the first GitHub snapshot arrives", async () => {
    writeManifest(feat("alpha"));
    const h = harness();
    h.gh.unresolvable = true;
    await tick(h.ctx(), h.deps);
    expect(h.spawns).toHaveLength(0);
    expect(h.writes.at(-1)).toContain(
      "could not resolve the GitHub repository",
    );
  });

  it("notifies the GitHub pause once, and again only after it recovers and recurs", async () => {
    writeManifest(feat("alpha"));
    bind("alpha");
    const h = harness();
    h.gh.fail = true;
    for (let i = 0; i < 3; i++) {
      await tick(h.ctx(), h.deps);
      h.clock.t += 100_000;
    }
    const pauses = () =>
      h.notifies.filter((n) => n.join(" ").includes("GitHub unreachable"));
    expect(pauses()).toHaveLength(1);
    h.gh.fail = false;
    await tick(h.ctx(), h.deps);
    h.clock.t += 100_000;
    h.gh.fail = true;
    for (let i = 0; i < 4; i++) {
      await tick(h.ctx(), h.deps);
      h.clock.t += 100_000;
    }
    expect(pauses()).toHaveLength(2);
  });
});

describe("tick — notifications", () => {
  it("notifies once for plan-pending-review under the feature's window, and not again on restart", async () => {
    writeManifest(feat("alpha"));
    bind("alpha", "plan-pending-review");
    const h = harness();
    await tick(h.ctx(), h.deps);
    await tick(h.ctx(), h.deps);
    expect(h.notifies).toEqual([
      [
        "--status",
        "waiting",
        "--slug",
        "alpha",
        "--reason",
        expect.stringContaining("plan is waiting for your approval"),
      ],
    ]);
    expect(h.writes.at(-1)).toContain("answer in window alpha");
    const log = readManagerLog(EPIC, stateDir).find(
      (e) => e.kind === "owner-needed",
    )!;
    expect(log).toMatchObject({
      slug: "alpha",
      phase: "plan-pending-review",
      window: "alpha",
    });
    expect(log.reason).toBeTruthy();

    const restarted = harness();
    await tick(restarted.ctx(), restarted.deps);
    expect(restarted.notifies).toEqual([]);
  });

  it.each(["gated", "needs-human"])(
    "shows a board line but sends no notification for %s",
    async (phase) => {
      writeManifest(feat("alpha"));
      bind("alpha", phase, { pr: 4 });
      const h = harness();
      await tick(h.ctx(), h.deps);
      expect(h.writes.at(-1)).toContain("answer in window alpha");
      expect(h.notifies).toEqual([]);
      const log = readManagerLog(EPIC, stateDir).find(
        (e) => e.kind === "owner-needed",
      )!;
      expect(log).toMatchObject({ phase, pr: 4, slug: "alpha" });
    },
  );

  it("a drift halt notifies once under the manage window, naming the pointer", async () => {
    writeManifest(feat("alpha"), feat("beta"));
    fs.mkdirSync(path.join(epicsDir, EPIC), { recursive: true });
    const h = harness();
    // run.json names an id the manifest no longer has -> halts every launch.
    writeEpicRunState(
      {
        epicSlug: EPIC,
        repo: repoDir,
        manifestPath,
        manifestSha: "s",
        createdAt: "t",
        updatedAt: "t",
        features: { ghost: { slug: "ghost", launchedAt: "x" } },
      },
      epicsDir,
    );
    await tick(h.ctx(), h.deps);
    await tick(h.ctx(), h.deps);
    expect(h.spawns).toEqual([]);
    expect(h.notifies).toHaveLength(1);
    expect(h.notifies[0]).toEqual([
      "--status",
      "waiting",
      "--slug",
      "manage-my-epic",
      "--reason",
      expect.stringContaining("/flow-epic-run reconcile-drift"),
    ]);
    expect(h.writes.at(-1)).toContain("run /flow-epic-run reconcile-drift");
    expect(
      readManagerLog(EPIC, stateDir).some((e) => e.kind === "drift-halt"),
    ).toBe(true);
  });

  it("an out-of-band merge (merged PR on the unbound feature's branch) halts that node only", async () => {
    writeManifest(feat("alpha"), feat("beta"));
    const h = harness();
    h.prs.push({
      number: 9,
      headRefName: "alpha",
      state: "MERGED",
      mergedAt: "2026-10-25T00:00:00Z",
    });
    const r = await tick(h.ctx(), h.deps);
    expect(r.launched).toBe("beta");
    expect(h.writes.at(-1)).toContain("drift: alpha");
  });

  it("a bound feature merged in the GitHub UI is observed, logged, and unblocks its dependent", async () => {
    writeManifest(feat("alpha"), feat("beta", ["alpha"]));
    bind("alpha", "gated", { pr: 7 });
    const h = harness();
    h.prs.push({
      number: 7,
      headRefName: "alpha",
      state: "MERGED",
      mergedAt: "2026-10-26T11:00:00Z",
    });
    const r = await tick(h.ctx(), h.deps);
    expect(r.launched).toBe("beta");
    expect(
      readManagerLog(EPIC, stateDir).some(
        (e) => e.kind === "merged-observed" && e.featureId === "alpha",
      ),
    ).toBe(true);
    const run = JSON.parse(
      fs.readFileSync(path.join(epicsDir, EPIC, "run.json"), "utf8"),
    );
    expect(run.features.alpha).toEqual({
      slug: "alpha",
      launchedAt: "2026-10-26T00:00:00Z",
    });
  });

  it("a merged-on-GitHub feature with a binding PR but no state file unblocks its dependent instead of halting as orphan", async () => {
    writeManifest(feat("alpha"), feat("beta", ["alpha"]));
    writeEpicRunState(
      {
        epicSlug: EPIC,
        repo: repoDir,
        manifestPath,
        manifestSha: "s",
        createdAt: "t",
        updatedAt: "t",
        features: { alpha: { slug: "alpha", launchedAt: "x", pr: 7 } },
      },
      epicsDir,
    );
    const h = harness();
    h.prs.push({
      number: 7,
      headRefName: "alpha",
      state: "MERGED",
      mergedAt: "2026-10-26T11:00:00Z",
    });
    const r = await tick(h.ctx(), h.deps);
    expect(r.launched).toBe("beta");
    expect(h.writes.at(-1)).not.toContain("drift: alpha");
  });

  it("header says notifications are off when FLOW_NOTIFY is not 1", async () => {
    writeManifest(feat("alpha"));
    bind("alpha");
    const h = harness({ env: {} });
    await tick(h.ctx(), h.deps);
    expect(h.writes[0]).toContain("notifications off — set FLOW_NOTIFY=1");
  });
});

describe("tick — outage redraw", () => {
  it("leaves the board untouched across ticks of a steady GitHub outage", async () => {
    writeManifest(feat("alpha"));
    bind("alpha");
    const h = harness();
    h.gh.fail = true;
    await tick(h.ctx(), h.deps);
    const n = h.writes.length;
    for (let i = 0; i < 5; i++) {
      h.clock.t += 3000;
      await tick(h.ctx(), h.deps);
    }
    expect(h.writes).toHaveLength(n);
  });
});

describe("restart", () => {
  it("rebuilds an identical board from disk", async () => {
    writeManifest(feat("alpha"), feat("beta", ["alpha"]));
    bind("alpha", "plan-pending-review");
    const first = harness();
    await tick(first.ctx(), first.deps);
    const second = harness();
    await tick(second.ctx(), second.deps);
    expect(second.writes[0]).toBe(first.writes[0]);
  });

  it("holds a mid-launch node (state file present, no binding) instead of reading it as drift", async () => {
    writeManifest(feat("alpha"), feat("beta"));
    writeState(pipeline("alpha", "starting"), stateDir);
    const h = harness({
      manager: {
        launching: {
          featureId: "alpha",
          startedAt: new Date(T0 - 60_000).toISOString(),
        },
      },
    });
    const r = await tick(h.ctx(), h.deps);
    expect(r.launched).toBe("beta");
    expect(h.spawns).toEqual([["epic", "launch", EPIC, "beta"]]);
    expect(h.writes.at(-1)).toContain("launching: alpha");
    expect(h.writes.at(-1)).not.toContain("drift: alpha");
  });

  it("stops holding after the restart bound, then reports the half-created pipeline as drift", async () => {
    writeManifest(feat("alpha"));
    writeState(pipeline("alpha", "starting"), stateDir);
    const h = harness({
      manager: {
        launching: {
          featureId: "alpha",
          startedAt: new Date(T0 - 500_000).toISOString(),
        },
      },
    });
    await tick(h.ctx(), h.deps);
    expect(h.writes.at(-1)).toContain("drift: alpha");
    expect(h.spawns).toEqual([]);
  });

  it("a graceful stop mid-launch leaves a marker that the next start holds on", async () => {
    writeManifest(feat("alpha"));
    const h = harness();
    h.hold.on = true;
    const controller = new AbortController();
    h.deps.sleep = async () => controller.abort();
    await runManagerLoop(h.cfg, h.deps, controller.signal);
    expect(
      fs.existsSync(path.join(managerDir(EPIC, stateDir), "launching.json")),
    ).toBe(true);
    writeState(pipeline("alpha", "starting"), stateDir);
    const restarted = harness();
    await tick(restarted.ctx(), restarted.deps);
    expect(restarted.writes.at(-1)).toContain("launching: alpha");
    expect(restarted.spawns).toEqual([]);
  });
});

describe("done", () => {
  it("renders the final board, marks manager.json done, notifies once, and stops launching", async () => {
    writeManifest(feat("alpha"));
    bind("alpha", "merged");
    const h = harness();
    writeManager(h.cfg.manager, stateDir);
    const r = await tick(h.ctx(), h.deps);
    expect(r.done).toBe(true);
    expect(h.writes.at(-1)).toContain("DONE");
    expect(readManager(EPIC, stateDir)?.status).toBe("done");
    await tick(h.ctx(), h.deps);
    expect(h.notifies).toEqual([
      [
        "--status",
        "waiting",
        "--slug",
        "manage-my-epic",
        "--reason",
        expect.stringContaining("is done"),
      ],
    ]);
    expect(h.spawns).toEqual([]);
  });

  it("runManagerLoop parks on the final board until stopped, then removes manager.json", async () => {
    writeManifest(feat("alpha"));
    bind("alpha", "merged");
    const h = harness();
    writeManager(h.cfg.manager, stateDir);
    let waited = false;
    h.deps.waitForEnter = async () => void (waited = true);
    const code = await runManagerLoop(
      h.cfg,
      h.deps,
      new AbortController().signal,
    );
    expect(code).toBe(0);
    expect(waited).toBe(true);
    expect(readManager(EPIC, stateDir)).toBeNull();
    expect(readManagerLog(EPIC, stateDir).map((e) => e.kind)).toContain(
      "stopped",
    );
  });
});

describe("stopping", () => {
  it("exits promptly on abort: log stopped, remove manager.json, never launch", async () => {
    writeManifest(feat("alpha"));
    bind("alpha");
    const h = harness();
    writeManager(h.cfg.manager, stateDir);
    h.deps.sleep = abortableSleep;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    const code = await runManagerLoop(h.cfg, h.deps, controller.signal);
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(readManager(EPIC, stateDir)).toBeNull();
    expect(readManagerLog(EPIC, stateDir).at(-1)?.kind).toBe("stopped");
    expect(h.spawns).toEqual([]);
  });

  it("a tick error is reported once and the loop keeps going", async () => {
    fs.writeFileSync(manifestPath, "{nope");
    const h = harness();
    const controller = new AbortController();
    let n = 0;
    h.deps.sleep = async () => {
      if (++n >= 3) controller.abort();
    };
    await runManagerLoop(h.cfg, h.deps, controller.signal);
    expect(
      h.writes.filter((w) => w.includes("manifest is not valid JSON")),
    ).toHaveLength(1);
  });

  it("installStopHandlers aborts the controller and the disposer removes the listeners", () => {
    const before = process.listenerCount("SIGINT");
    const controller = new AbortController();
    let stopped = 0;
    const dispose = installStopHandlers(controller, () => stopped++);
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(0);
    process.listeners("SIGINT").at(-1)!("SIGINT");
    expect(stopped).toBe(1);
    expect(controller.signal.aborted).toBe(true);
    dispose();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});

describe("heartbeat during a slow probe", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps manager.json fresh while a slow GitHub probe is awaited, so a slow gh never reads as stalled", async () => {
    vi.useFakeTimers();
    writeManifest(feat("alpha"));
    bind("alpha");
    const h = harness();
    writeManager(h.cfg.manager, stateDir);
    let release: () => void = () => {};
    const baseExec = h.deps.exec;
    h.deps.exec = async (cmd, args, cwd, timeout) => {
      if (cmd === "gh" && args[0] === "api") {
        await new Promise<void>((r) => (release = r));
      }
      return baseExec(cmd, args, cwd, timeout);
    };
    const pending = tick(h.ctx(), h.deps);
    await vi.advanceTimersByTimeAsync(0);
    h.clock.t += 20_000;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(Date.parse(readManager(EPIC, stateDir)!.heartbeatAt)).toBe(
      T0 + 20_000,
    );
    release();
    await pending;
  });
});

describe("tmux badge", () => {
  it("sets @flow-phase to managing once at start inside tmux, and never outside it", async () => {
    writeManifest(feat("alpha"));
    bind("alpha");
    const inside = harness({
      env: { FLOW_NOTIFY: "1", TMUX: "/tmp/tmux-1/default,1,0" },
    });
    const controller = new AbortController();
    inside.deps.sleep = async () => controller.abort();
    await runManagerLoop(inside.cfg, inside.deps, controller.signal);
    const sets = inside.execCalls.filter((c) => c.cmd === "tmux");
    expect(sets.map((c) => c.args)).toEqual([
      [
        "set-option",
        "-w",
        "-t",
        "flow:manage-my-epic",
        "@flow-phase",
        "managing",
      ],
      [
        "set-option",
        "-w",
        "-t",
        "flow:manage-my-epic",
        "@flow-phase-short",
        "managing",
      ],
    ]);
    const outside = harness();
    const c2 = new AbortController();
    outside.deps.sleep = async () => c2.abort();
    await runManagerLoop(outside.cfg, outside.deps, c2.signal);
    expect(outside.execCalls.some((c) => c.cmd === "tmux")).toBe(false);
  });
});

describe("extension points", () => {
  it("orderFrontier is the identity and afterMergesObserved a no-op today", async () => {
    expect(orderFrontier(["b", "a"])).toEqual(["b", "a"]);
    writeManifest(feat("alpha"));
    await expect(
      afterMergesObserved(harness().ctx(), ["alpha"]),
    ).resolves.toBeUndefined();
  });
});
