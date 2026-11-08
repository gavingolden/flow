import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunResult } from "./worktree-sweep-facts";
import { runWorktreeSweep } from "./worktree-sweep";
import {
  isAutoSweepEnabled,
  lastPath,
  lockPath,
  readLastSweep,
  stampAgeMs,
  type SweepDeps,
  WORKTREE_SWEEP_DEADLINE_MS,
  WORKTREE_SWEEP_GH_BACKOFF_MS,
  WORKTREE_SWEEP_THROTTLE_MS,
} from "./worktree-sweep-state";

const OK = (stdout = ""): RunResult => ({
  status: 0,
  stdout,
  stderr: "",
  timedOut: false,
});
const NOW = 1_800_000_000_000;

let tmp: string;
let stateDir: string;
let repo: string;
let wt: string;
let husk: string;
let logPath: string;
let events: string[];
let clock: number;
let ghResult: RunResult;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sweep-run-")));
  stateDir = path.join(tmp, "state");
  fs.mkdirSync(stateDir);
  logPath = path.join(tmp, "logs", "sweep.jsonl");
  repo = path.join(tmp, "repo");
  wt = path.join(tmp, "repo-a");
  husk = path.join(tmp, "repo-husk");
  for (const d of [repo, wt, husk]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: elsewhere");
  const old = new Date(NOW - 5 * 3_600_000);
  fs.utimesSync(husk, old, old);
  events = [];
  clock = NOW;
  ghResult = OK(
    JSON.stringify([
      { number: 5, state: "MERGED", headRefName: "a", headRefOid: "dead" },
    ]),
  );
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function deps(over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    run: (cmd, args) => {
      events.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "git" && args[0] === "worktree" && args[1] === "list") {
        return OK(
          events.includes("removed") || !fs.existsSync(wt)
            ? `worktree ${repo}\n\n`
            : `worktree ${repo}\n\nworktree ${wt}\nbranch refs/heads/a\n\n`,
        );
      }
      if (cmd === "gh") return ghResult;
      if (cmd === "git" && args[0] === "symbolic-ref")
        return OK("refs/remotes/origin/main");
      if (cmd === "git" && args[0] === "check-ignore")
        return { ...OK(), status: 1 };
      return OK();
    },
    listStates: () => [],
    liveness: () => "stale",
    windowOpen: () => false,
    cwd: repo,
    nowMs: () => clock,
    flowSourcePaths: [],
    listProcs: () => [],
    readCwds: () => new Map(),
    selfPids: [process.pid],
    removeWorktree: vi.fn((p: string) => {
      events.push("removeWorktree");
      fs.rmSync(p, { recursive: true, force: true });
      return { ok: true, message: "removed" };
    }),
    removeDir: vi.fn((p: string) =>
      fs.rmSync(p, { recursive: true, force: true }),
    ),
    sizeBytes: () => 2048,
    readConfig: () => undefined,
    stateDir,
    logPath,
    pid: process.pid,
    exists: fs.existsSync,
    ...over,
  };
}

describe("runWorktreeSweep preview", () => {
  it("never removes anything and records nothing, so the last real result survives", () => {
    const d = deps();

    const r = runWorktreeSweep({ act: false, auto: false }, d);

    expect(d.removeWorktree).not.toHaveBeenCalled();
    expect(d.removeDir).not.toHaveBeenCalled();
    expect(r.items.map((i) => [path.basename(i.path), i.outcome])).toEqual([
      ["repo-a", "would-remove"],
      ["repo-husk", "would-remove"],
    ]);
    expect(fs.existsSync(wt)).toBe(true);
    expect(lastPath(stateDir)).toContain(
      `${path.sep}worktree-sweep${path.sep}`,
    );
    expect(readLastSweep(stateDir)).toBeNull();
    expect(fs.existsSync(path.join(stateDir, "last.json"))).toBe(false);
    expect(stampAgeMs(NOW, stateDir)).toBeNull();
  });

  it("does not replace an acted result with a later preview", () => {
    runWorktreeSweep({ act: true, auto: false }, deps());
    const acted = readLastSweep(stateDir);
    expect(acted?.acted).toBe(true);
    clock = NOW + 1000;
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: elsewhere");
    runWorktreeSweep({ act: false, auto: false }, deps());
    expect(readLastSweep(stateDir)).toEqual(acted);
  });

  it("measures the size of a folder it only previews", () => {
    const r = runWorktreeSweep({ act: false, auto: false }, deps());
    expect(r.items.map((i) => i.bytes)).toEqual([2048, 2048]);
  });
});

describe("runWorktreeSweep act", () => {
  it("logs `removing` before it removes and `removed` after, deleting the branch for a merged PR", () => {
    let loggedBefore = "";
    const d = deps({
      removeWorktree: vi.fn((p: string, _primary: string, del: boolean) => {
        loggedBefore = fs.readFileSync(logPath, "utf8");
        events.push(`remove del=${del}`);
        fs.rmSync(p, { recursive: true, force: true });
        return { ok: true, message: "removed" };
      }),
    });

    const r = runWorktreeSweep({ act: true, auto: false }, d);

    expect(
      loggedBefore
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).event),
    ).toEqual(["removing"]);
    expect(events).toContain("remove del=true");
    const log = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(log.map((l) => l.event)).toEqual([
      "removing",
      "removed",
      "removing",
      "removed",
    ]);
    expect(log[0]).toMatchObject({
      pr: 5,
      headOid: "dead",
      branch: "a",
      bytes: 2048,
    });
    expect(r.totals).toEqual({
      removed: 2,
      held: 0,
      failed: 0,
      bytesFreed: 4096,
    });
    expect(d.removeDir).toHaveBeenCalledWith(husk);
    expect(events).toContain("git worktree prune");
  });

  it("refuses to remove when the removal log cannot be written", () => {
    fs.writeFileSync(
      path.join(tmp, "logs"),
      "a file where the log dir should be",
    );
    const d = deps();
    const r = runWorktreeSweep({ act: true, auto: false }, d);
    expect(d.removeWorktree).not.toHaveBeenCalled();
    expect(r.items.every((i) => i.outcome === "failed")).toBe(true);
  });

  it("records a failed removal and keeps going", () => {
    const d = deps({
      removeWorktree: vi.fn(() => ({ ok: false, message: "has changes" })),
    });
    const r = runWorktreeSweep({ act: true, auto: false }, d);
    expect(r.items[0]).toMatchObject({
      outcome: "failed",
      detail: "has changes",
    });
    expect(r.totals.failed).toBe(1);
    expect(r.totals.removed).toBe(1);
  });

  it("is a no-op the second time once the folder is gone", () => {
    runWorktreeSweep({ act: true, auto: false }, deps());
    const d = deps();
    const r = runWorktreeSweep({ act: true, auto: false }, d);
    expect(r.items).toEqual([]);
    expect(d.removeWorktree).not.toHaveBeenCalled();
  });

  it("holds the remaining folders once the 5 minute deadline passes", () => {
    const d = deps({
      sizeBytes: vi.fn(() => 2048),
      removeWorktree: vi.fn((p: string) => {
        clock += WORKTREE_SWEEP_DEADLINE_MS + 1;
        fs.rmSync(p, { recursive: true, force: true });
        return { ok: true, message: "removed" };
      }),
    });
    const r = runWorktreeSweep({ act: true, auto: false }, d);
    expect(r.deadlineHit).toBe(true);
    expect(r.items.map((i) => [i.outcome, i.reason])).toEqual([
      ["removed", "pr-merged"],
      ["held", "deadline-reached"],
    ]);
    expect(d.removeDir).not.toHaveBeenCalled();
    expect(d.sizeBytes).toHaveBeenCalledTimes(1);
  });

  it("keeps a finished folder a running program is working in and never removes it", () => {
    const d = deps({
      listProcs: () => [
        {
          pid: 4242,
          ppid: 1,
          pgid: 4242,
          uid: 1,
          tty: null,
          ageSec: 1,
          cpuSec: 1,
          command: "vite dev",
          cwd: null,
        },
      ],
      readCwds: () => new Map([[4242, wt]]),
    });
    const r = runWorktreeSweep({ act: true, auto: false }, d);
    const item = r.items.find((i) => i.path === wt);
    expect(item).toMatchObject({ outcome: "held", reason: "in-use-process" });
    expect(d.removeWorktree).not.toHaveBeenCalled();
    expect(fs.existsSync(wt)).toBe(true);
  });

  it("keeps a finished folder when Docker hangs, and sweeps normally when its daemon is down", () => {
    const withDocker = (stderr: string, timedOut: boolean) =>
      deps({
        run: (cmd, args, opts) => {
          if (cmd === "docker")
            return {
              status: timedOut ? null : 1,
              stdout: "",
              stderr,
              timedOut,
            };
          return deps().run(cmd, args, opts);
        },
      });
    const hung = withDocker("", true);
    const held = runWorktreeSweep({ act: true, auto: false }, hung);
    expect(held.items.map((i) => [i.outcome, i.reason])).toEqual([
      ["held", "in-use-container"],
      ["held", "in-use-container"],
    ]);
    expect(hung.removeWorktree).not.toHaveBeenCalled();
    expect(hung.removeDir).not.toHaveBeenCalled();

    const down = withDocker("Cannot connect to the Docker daemon", false);
    const swept = runWorktreeSweep({ act: true, auto: false }, down);
    expect(swept.items.map((i) => i.outcome)).toEqual(["removed", "removed"]);
  });

  it("keeps the folder the sweep was launched from even though its shell is excluded as an ancestor", () => {
    const d = deps({ cwd: wt });
    const r = runWorktreeSweep({ act: true, auto: false }, d);
    expect(r.items.find((i) => i.path === wt)).toMatchObject({
      outcome: "held",
      reason: "contains-launch-dir",
    });
    expect(d.removeWorktree).not.toHaveBeenCalled();
  });

  it("moves the next eligible run 5 minutes out when the PR listing was unreachable", () => {
    ghResult = { status: null, stdout: "", stderr: "", timedOut: true };
    const r = runWorktreeSweep({ act: true, auto: true }, deps());
    expect(r.ghUnreachable).toBe(true);
    expect(r.items[0]).toMatchObject({
      outcome: "held",
      reason: "gh-unreachable",
    });
    const age = stampAgeMs(NOW, stateDir) as number;
    expect(WORKTREE_SWEEP_THROTTLE_MS - age).toBe(WORKTREE_SWEEP_GH_BACKOFF_MS);
  });
});

describe("runWorktreeSweep auto gating", () => {
  it("skips as disabled when cleanup.worktrees is false", () => {
    const d = deps({ readConfig: () => ({ cleanup: { worktrees: false } }) });
    const r = runWorktreeSweep({ act: true, auto: true }, d);
    expect(r.skipped).toBe("disabled");
    expect(d.removeWorktree).not.toHaveBeenCalled();
  });

  it("ignores the config switch and the throttle for a manual run", () => {
    runWorktreeSweep({ act: true, auto: true }, deps());
    const d = deps({ readConfig: () => ({ cleanup: { worktrees: false } }) });
    expect(
      runWorktreeSweep({ act: false, auto: false }, d).skipped,
    ).toBeUndefined();
  });

  it("skips as throttled when a sweep started under an hour ago", () => {
    runWorktreeSweep({ act: true, auto: true }, deps());
    clock = NOW + WORKTREE_SWEEP_THROTTLE_MS - 1000;
    const d = deps();
    expect(runWorktreeSweep({ act: true, auto: true }, d).skipped).toBe(
      "throttled",
    );
    clock = NOW + WORKTREE_SWEEP_THROTTLE_MS + 1000;
    expect(
      runWorktreeSweep({ act: true, auto: true }, deps()).skipped,
    ).toBeUndefined();
  });

  it("skips as locked when a live process holds the lock, and reclaims a dead holder's lock", () => {
    fs.mkdirSync(path.dirname(lockPath(stateDir)), { recursive: true });
    fs.writeFileSync(lockPath(stateDir), String(process.pid));
    expect(runWorktreeSweep({ act: false, auto: false }, deps()).skipped).toBe(
      "locked",
    );

    fs.writeFileSync(lockPath(stateDir), "2147483646");
    expect(
      runWorktreeSweep({ act: false, auto: false }, deps()).skipped,
    ).toBeUndefined();
  });

  it("does not overwrite the last real result with a skipped run", () => {
    runWorktreeSweep({ act: true, auto: false }, deps());
    const before = readLastSweep(stateDir);
    runWorktreeSweep(
      { act: true, auto: true },
      deps({ readConfig: () => ({ cleanup: { worktrees: false } }) }),
    );
    expect(readLastSweep(stateDir)).toEqual(before);
    expect(before?.items).toHaveLength(2);
  });
});

describe("isAutoSweepEnabled", () => {
  it.each([
    [undefined, true],
    [{}, true],
    [{ cleanup: { worktrees: true } }, true],
    [{ cleanup: { worktrees: "false" } }, true],
    [{ cleanup: { worktrees: false } }, false],
  ])("reads %j as %s", (cfg, want) => {
    expect(isAutoSweepEnabled(() => cfg)).toBe(want);
  });
});
