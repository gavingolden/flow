import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CAFFEINATE_PATH,
  holderArgv,
  KEEP_AWAKE_HOLD_PHASES,
  syncKeepAwake,
  type KeepAwakeDeps,
} from "./keep-awake";
import type { ProcRegistryRow } from "./proc-registry";
import { PIPELINE_PHASES, STEP_PHASES, type PipelineState } from "./state";

const state = (
  phase: string,
  extra: Partial<PipelineState> = {},
): PipelineState =>
  ({
    slug: "s",
    phase,
    repo: "r",
    pid: 100,
    procStartedAt: 7,
    ...extra,
  }) as PipelineState;

const row = (pid: number, watch?: number): ProcRegistryRow => ({
  pid,
  pgid: pid,
  startEpoch: 1,
  slug: "s",
  class: "default",
  argv: holderArgv(watch),
  recordedAt: 0,
  sessionPid: 100,
  sessionStartEpoch: 7,
});

function harness(
  rows: ProcRegistryRow[] = [],
  over: Partial<KeepAwakeDeps> = {},
) {
  const alive = new Set(rows.map((r) => r.pid));
  alive.add(100);
  const appended: ProcRegistryRow[] = [];
  const kills: Array<[number, string]> = [];
  const spawnDetached = vi.fn((_argv: string[]) => 555);
  const deps: Partial<KeepAwakeDeps> = {
    platform: "darwin",
    envOff: () => false,
    enabled: () => true,
    hasCaffeinate: () => true,
    pidLive: (p) => alive.has(p),
    spawnDetached,
    startEpoch: () => 1,
    readRows: vi.fn(() => rows),
    appendRow: (_s, r) => {
      appended.push(r);
      return true;
    },
    isLive: (r) => alive.has(r.pid),
    kill: (pid, sig) => {
      kills.push([pid, sig]);
      alive.delete(pid);
    },
    sleepMs: () => {},
    ...over,
  };
  return { deps, appended, kills, spawnDetached };
}

describe("holderArgv", () => {
  it("should build the -s -w -t argv and never -i/-d/-u", () => {
    expect(holderArgv(42)).toEqual([
      CAFFEINATE_PATH,
      "-s",
      "-w",
      "42",
      "-t",
      "14400",
    ]);
    expect(holderArgv(undefined)).toEqual([
      CAFFEINATE_PATH,
      "-s",
      "-t",
      "14400",
    ]);
    for (const a of [...holderArgv(1), ...holderArgv(undefined)]) {
      expect(["-i", "-d", "-u"]).not.toContain(a);
    }
  });
});

describe("syncKeepAwake", () => {
  it("should spawn one holder and register it in a hold phase", () => {
    const h = harness();
    const out = syncKeepAwake(state("implementing"), h.deps);
    expect(out.action).toBe("acquired");
    expect(h.spawnDetached).toHaveBeenCalledTimes(1);
    expect(h.spawnDetached).toHaveBeenCalledWith([
      CAFFEINATE_PATH,
      "-s",
      "-w",
      "100",
      "-t",
      "14400",
    ]);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]).toMatchObject({
      pid: 555,
      sessionPid: 100,
      sessionStartEpoch: 7,
    });
  });

  it("should keep a live holder watching the same pid", () => {
    const h = harness([row(200, 100)]);
    expect(syncKeepAwake(state("implementing"), h.deps).action).toBe("kept");
    expect(h.spawnDetached).not.toHaveBeenCalled();
  });

  it("should replace a holder watching an old pid", () => {
    const h = harness([row(200, 99)]);
    expect(syncKeepAwake(state("implementing"), h.deps).action).toBe(
      "acquired",
    );
    expect(h.kills).toContainEqual([200, "SIGTERM"]);
  });

  it.each([
    "plan-pending-review",
    "gated",
    "needs-human",
    "merged",
    "cancelled",
    "checkpoint-pending-clear",
  ])("should release the holder in %s", (phase) => {
    const h = harness([row(200, 100)]);
    expect(syncKeepAwake(state(phase), h.deps).action).toBe("released");
    expect(h.kills).toContainEqual([200, "SIGTERM"]);
    expect(h.spawnDetached).not.toHaveBeenCalled();
  });

  it.each(["ci-wait-pending", "plan-review-pending"])(
    "should hold in %s",
    (phase) => {
      const h = harness();
      expect(syncKeepAwake(state(phase), h.deps).action).toBe("acquired");
    },
  );

  it.each([
    ["disabled", { enabled: () => false }],
    ["not-darwin", { platform: "linux" as NodeJS.Platform }],
    ["no-caffeinate", { hasCaffeinate: () => false }],
  ] as const)("should spawn nothing and release when %s", (skip, over) => {
    const h = harness([row(200, 100)], over);
    expect(syncKeepAwake(state("implementing"), h.deps).action).toBe(
      "released",
    );
    expect(h.spawnDetached).not.toHaveBeenCalled();
    const none = harness([], over);
    expect(syncKeepAwake(state("implementing"), none.deps)).toEqual({
      action: "none",
      skip,
    });
  });

  it("should read no registry when env-off", () => {
    const h = harness();
    const out = syncKeepAwake(state("implementing"), {
      ...h.deps,
      envOff: () => true,
    });
    expect(out).toEqual({ action: "none", skip: "env-off" });
    expect(h.deps.readRows).not.toHaveBeenCalled();
  });

  it("should kill the child and record nothing when the start epoch is unreadable", () => {
    const h = harness([], { startEpoch: () => null });
    expect(syncKeepAwake(state("implementing"), h.deps).action).toBe("none");
    expect(h.kills).toContainEqual([555, "SIGTERM"]);
    expect(h.appended).toHaveLength(0);
  });

  it("should omit -w when state.pid is absent or dead", () => {
    const absent = harness();
    syncKeepAwake(state("implementing", { pid: undefined }), absent.deps);
    expect(absent.spawnDetached.mock.calls[0]![0]).not.toContain("-w");
    const dead = harness([], { pidLive: () => false });
    syncKeepAwake(state("implementing"), dead.deps);
    expect(dead.spawnDetached.mock.calls[0]![0]).not.toContain("-w");
  });

  it("should never throw when spawning throws", () => {
    const h = harness([], {
      spawnDetached: () => {
        throw new Error("nope");
      },
    });
    expect(syncKeepAwake(state("implementing"), h.deps)).toEqual({
      action: "none",
    });
  });
});

describe("KEEP_AWAKE_HOLD_PHASES", () => {
  it("should equal STEP_PHASES plus the three working-pending phases", () => {
    expect(new Set(KEEP_AWAKE_HOLD_PHASES)).toEqual(
      new Set([
        ...STEP_PHASES,
        "ci-wait-pending",
        "plan-review-pending",
        "epic-plan-review-pending",
      ]),
    );
  });

  it("should partition every pipeline phase into hold or release exactly once", () => {
    const RELEASE = new Set<string>([
      "plan-pending-review",
      "plan-pending-interview",
      "triaged-no-change",
      "triage-pending-clarification",
      "triage-pending-interview",
      "approval-pending-clarification",
      "browser-retry-pending",
      "checkpoint-pending-clear",
      "epic-design-pending-review",
      "merged",
      "gated",
      "needs-human",
      "cancelled",
      "epic-approved",
    ]);
    for (const p of PIPELINE_PHASES) {
      expect(KEEP_AWAKE_HOLD_PHASES.has(p) !== RELEASE.has(p)).toBe(true);
    }
    expect(KEEP_AWAKE_HOLD_PHASES.size + RELEASE.size).toBe(
      PIPELINE_PHASES.length,
    );
  });
});

describe("syncKeepAwake edge cases", () => {
  it("should kill the child and report none when the registry append fails", () => {
    const h = harness([], { appendRow: () => false });
    expect(syncKeepAwake(state("implementing"), h.deps)).toEqual({
      action: "none",
    });
    expect(h.kills).toContainEqual([555, "SIGTERM"]);
  });

  it("should release only caffeinate rows and leave other registered processes", () => {
    const other: ProcRegistryRow = {
      ...row(300),
      argv: ["/usr/bin/node", "server.js"],
    };
    const h = harness([row(200, 100), other]);
    expect(syncKeepAwake(state("gated"), h.deps).action).toBe("released");
    expect(h.kills).toContainEqual([200, "SIGTERM"]);
    expect(h.kills.some(([pid]) => pid === 300)).toBe(false);
  });

  it("should not fork the start-epoch probe for a dead holder pid", () => {
    const isLive = vi.fn(() => true);
    const h = harness([row(200, 100)], {
      pidLive: (p) => p === 100,
      isLive,
    });
    syncKeepAwake(state("implementing"), h.deps);
    expect(isLive).not.toHaveBeenCalled();
  });

  it("should honour power.keepAwake=false from the real config file", () => {
    const home = process.env.HOME!;
    const cfg = path.join(home, ".flow", "config.json");
    const had = fs.existsSync(cfg);
    const prev = had ? fs.readFileSync(cfg, "utf8") : null;
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    try {
      fs.writeFileSync(cfg, JSON.stringify({ power: { keepAwake: false } }));
      const h = harness();
      const { enabled: _e, ...deps } = h.deps;
      expect(syncKeepAwake(state("implementing"), deps)).toEqual({
        action: "none",
        skip: "disabled",
      });
      expect(h.spawnDetached).not.toHaveBeenCalled();
      fs.rmSync(cfg);
      const h2 = harness();
      const { enabled: _e2, ...deps2 } = h2.deps;
      expect(syncKeepAwake(state("implementing"), deps2).action).toBe(
        "acquired",
      );
    } finally {
      if (prev !== null) fs.writeFileSync(cfg, prev);
      else fs.rmSync(cfg, { force: true });
    }
  });
});
