import { describe, expect, it } from "vitest";
import {
  renderStaleShellLines,
  staleShellsStopped,
  sweepStaleShells,
  type StaleShellDeps,
} from "./stale-shells-run";
import type { OrphanProc } from "./worktree-orphans";

const HOME = "/Users/me";
const STATE = `${HOME}/.flow/state`;

function proc(over: Partial<OrphanProc> & { pid: number }): OrphanProc {
  return {
    ppid: 1,
    pgid: over.pid,
    uid: 501,
    tty: null,
    ageSec: 7200,
    cpuSec: 0,
    command: "",
    cwd: null,
    ...over,
  };
}

const wrapped = (body: string): string =>
  `/bin/zsh -c source ${HOME}/.claude/shell-snapshots/snapshot-zsh-1-a.sh && eval '${body}' < /dev/null && pwd -P >| /tmp/claude-x-cwd`;

const claude = proc({ pid: 50, command: "claude --x" });
const pane = proc({ pid: 40, command: "-zsh" });
const owner = proc({ pid: 50, ppid: 40, command: "claude --x" });
const shell = proc({
  pid: 200,
  ppid: 50,
  command: wrapped(
    "until grep -q merged ~/.flow/state/foo.json; do sleep 20; done",
  ),
});

type Harness = {
  deps: StaleShellDeps;
  signals: Array<[number, string]>;
  clock: { now: number };
};

function harness(
  procs: OrphanProc[],
  over: Partial<StaleShellDeps> & {
    diesOn?: "SIGTERM" | "SIGKILL" | "never";
  } = {},
): Harness {
  const live = new Set(procs.map((p) => p.pid));
  const signals: Array<[number, string]> = [];
  const clock = { now: 0 };
  const { diesOn = "SIGTERM", ...rest } = over;
  const deps: StaleShellDeps = {
    listProcs: () => procs,
    registeredPids: () => new Set(),
    startEpochOf: () => 1000,
    killGroup: (pgid, sig) => {
      signals.push([pgid, sig]);
      if (sig === diesOn) live.delete(pgid);
    },
    alive: (pid) => live.has(pid),
    sleepMs: (ms) => {
      clock.now += ms;
    },
    nowMs: () => clock.now,
    paneWindows: () => new Map([[40, { id: "@3", name: "foo-pipeline" }]]),
    selfPid: 999,
    selfUid: 501,
    home: HOME,
    stateDir: STATE,
    ...rest,
  };
  return { deps, signals, clock };
}

const TARGETS = [{ slug: "foo" }];

describe("sweepStaleShells", () => {
  it("should report without signalling in report-only mode", () => {
    const h = harness([pane, owner, shell]);
    const r = sweepStaleShells(h.deps, { act: false, targets: TARGETS });
    expect(r.found.map((s) => s.pid)).toEqual([200]);
    expect(h.signals).toEqual([]);
    expect(renderStaleShellLines(r)[0]).toMatch(
      /^would stop background shell 200/,
    );
  });

  it("should SIGTERM the group and stop once it exits", () => {
    const h = harness([pane, owner, shell]);
    const r = sweepStaleShells(h.deps, { act: true, targets: TARGETS });
    expect(h.signals).toEqual([[200, "SIGTERM"]]);
    expect(staleShellsStopped(r)).toBe(1);
    const [line] = renderStaleShellLines(r);
    expect(line).toContain(
      "stopped background shell 200 (live session 50 in tmux window foo-pipeline (@3), 2h 0m)",
    );
    expect(line).toContain(
      `watched ${STATE}/foo.json (pipeline closed): until grep`,
    );
  });

  it("should SIGKILL a group that ignores SIGTERM", () => {
    const h = harness([pane, owner, shell], { diesOn: "SIGKILL" });
    const r = sweepStaleShells(h.deps, { act: true, targets: TARGETS });
    expect(h.signals.map((s) => s[1])).toEqual(["SIGTERM", "SIGKILL"]);
    expect(r.killed).toEqual([200]);
    expect(r.stillAlive).toEqual([]);
  });

  it("should report a group that survives SIGKILL as could-not-stop", () => {
    const h = harness([pane, owner, shell], { diesOn: "never" });
    const r = sweepStaleShells(h.deps, { act: true, targets: TARGETS });
    expect(r.stillAlive).toEqual([200]);
    expect(renderStaleShellLines(r)[0]).toMatch(
      /^could not stop \(still running after SIGKILL; stop pid 200 by hand\)/,
    );
  });

  it("should skip a pid whose start time changed (recycled)", () => {
    let calls = 0;
    const h = harness([pane, owner, shell], {
      startEpochOf: () => 1000 + calls++,
    });
    const r = sweepStaleShells(h.deps, { act: true, targets: TARGETS });
    expect(h.signals).toEqual([]);
    expect(r.skippedRecycled).toEqual([200]);
    expect(renderStaleShellLines(r)[0]).toMatch(
      /^skipped \(process already ended; pid reused\) background shell 200/,
    );
  });

  it("should name the out-of-time case separately from a recycled pid", () => {
    const h = harness([pane, owner, shell]);
    const r = sweepStaleShells(h.deps, { act: true, targets: TARGETS });
    const unsignalled = { ...r, signalled: [], skippedRecycled: [] };
    expect(renderStaleShellLines(unsignalled)[0]).toMatch(
      /^not stopped \(ran out of time; re-run flow done\) background shell 200/,
    );
  });

  it("should never signal when the start time is unreadable", () => {
    const h = harness([pane, owner, shell], { startEpochOf: () => null });
    sweepStaleShells(h.deps, { act: true, targets: TARGETS });
    expect(h.signals).toEqual([]);
  });

  it("should render owner gone and omit the window when no pane matches", () => {
    const orphaned = { ...shell, ppid: 1 };
    const h = harness([claude, orphaned], { paneWindows: () => new Map() });
    const r = sweepStaleShells(h.deps, { act: false, targets: TARGETS });
    expect(renderStaleShellLines(r)[0]).toContain("(owner gone, 2h 0m)");
    const live = harness([claude, shell], { paneWindows: () => new Map() });
    const r2 = sweepStaleShells(live.deps, { act: false, targets: TARGETS });
    expect(renderStaleShellLines(r2)[0]).toContain("(live session 50, 2h 0m)");
  });

  it("should leave registry pids and the caller's own ancestry alone", () => {
    const own = harness([pane, owner, shell], { selfPid: 200 });
    expect(
      sweepStaleShells(own.deps, { act: true, targets: TARGETS }).found,
    ).toEqual([]);
    const reg = harness([pane, owner, shell], {
      registeredPids: () => new Set([200]),
    });
    expect(
      sweepStaleShells(reg.deps, { act: true, targets: TARGETS }).found,
    ).toEqual([]);
  });

  it("should skip the sweep when the process table is unavailable", () => {
    const h = harness([], { listProcs: () => undefined });
    const r = sweepStaleShells(h.deps, { act: true, targets: TARGETS });
    expect(r).toMatchObject({ ran: false, skipReason: "ps-unavailable" });
  });

  it("should stop signalling past the deadline", () => {
    const h = harness([pane, owner, shell]);
    const r = sweepStaleShells(h.deps, {
      act: true,
      targets: TARGETS,
      deadlineMs: 0,
    });
    expect(h.signals).toEqual([]);
    expect(r.signalled).toEqual([]);
  });

  it("should do nothing without targets", () => {
    const h = harness([pane, owner, shell]);
    expect(sweepStaleShells(h.deps, { act: true, targets: [] }).found).toEqual(
      [],
    );
  });
});
