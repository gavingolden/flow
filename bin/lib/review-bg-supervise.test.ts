import { describe, expect, it } from "vitest";
import {
  bgPaths,
  readReviewBgState,
  writeReviewBgState,
  type ReviewBgState,
  type StateIO,
} from "./review-bg-state";
import {
  runSupervise,
  SuperviseRefused,
  type SuperviseDeps,
} from "./review-bg-supervise";

const WT = "/wt";
const P = bgPaths(WT);

function stateFor(
  generation: string,
  over: Partial<Record<"lens" | "guess", "running" | "skipped">> = {},
): ReviewBgState {
  const h = (
    status: "running" | "skipped",
    envelope: string,
    out: string,
    log: string,
    giveUp: number,
  ) => ({
    status,
    startedAtSec: 0,
    giveUpAtSec: status === "running" ? giveUp : null,
    envelope,
    out,
    log,
    outcome: status === "running" ? ("pending" as const) : ("skipped" as const),
  });
  return {
    version: 1,
    generation,
    head_sha: "abc",
    scope: "full",
    review_started_at: null,
    configPath: "/wt/cfg.json",
    watchdog: null,
    diffSnapshot: P.snapshot,
    helpers: {
      "gemini-lens": h(
        over.lens ?? "running",
        P.lensEnvelope,
        P.lensOut,
        P.lensLog,
        1020,
      ),
      "gemini-intent-guess": h(
        over.guess ?? "running",
        P.intentEnvelope,
        P.intentOut,
        P.intentLog,
        900,
      ),
    },
  };
}

type FakeChild = {
  pid: number;
  exit: () => void;
  argv: string[];
};

function setup(state: ReviewBgState | null, seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const io: StateIO = {
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => void files.set(p, c),
    rename: (a, b) => {
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    removeFile: (p) => void files.delete(p),
    removeDir: () => {},
    mkdirp: () => {},
    fileExists: (p) => files.has(p),
    copyFile: () => {},
  };
  if (state) writeReviewBgState(WT, state, io);
  let clock = 0;
  let nextPid = 100;
  const children: FakeChild[] = [];
  const exitCbs = new Map<number, Array<() => void>>();
  const kills: Array<[number, string]> = [];
  const alive = new Set<number>();
  const signals = new Map<string, () => void>();
  const hooks: Array<(now: number) => void> = [];
  const deps: Partial<SuperviseDeps> = {
    io,
    spawnChild: (argv) => {
      const pid = nextPid++;
      alive.add(pid);
      const cbs: Array<() => void> = [];
      exitCbs.set(pid, cbs);
      const c: FakeChild = {
        pid,
        argv,
        exit: () => {
          alive.delete(pid);
          cbs.forEach((f) => f());
        },
      };
      children.push(c);
      return { pid, onExit: (cb) => void cbs.push(cb), onError: () => {} };
    },
    killGroup: (pid, sig) => void kills.push([pid, sig]),
    groupAlive: (pid) => alive.has(pid),
    nowSec: () => clock,
    sleep: async (ms) => {
      clock += ms / 1000;
      hooks.forEach((h) => h(clock));
      await Promise.resolve();
    },
    onSignal: (sig, cb) => void signals.set(sig, cb),
    pollMs: 5000,
    graceMs: 5000,
  };
  return {
    files,
    io,
    deps,
    children,
    kills,
    alive,
    signals,
    hooks,
    clock: () => clock,
  };
}

const read = (f: Map<string, string>) => readReviewBgState(f.get(P.state)!)!;

describe("runSupervise startup", () => {
  it("refuses with no state, a foreign generation, or no running helper", async () => {
    for (const s of [
      null,
      stateFor("other"),
      stateFor("g", { lens: "skipped", guess: "skipped" }),
    ]) {
      const t = setup(s);
      await expect(
        runSupervise({ worktree: WT, generation: "g" }, t.deps),
      ).rejects.toBeInstanceOf(SuperviseRefused);
      expect(t.children).toHaveLength(0);
    }
  });

  it("spawns only the running helpers with the snapshot, out and config", async () => {
    const t = setup(stateFor("g", { guess: "skipped" }));
    t.hooks.push(() => t.children.forEach((c) => c.exit()));
    t.children; // exit on first poll
    await runSupervise({ worktree: WT, generation: "g" }, t.deps);
    expect(t.children).toHaveLength(1);
    expect(t.children[0]!.argv).toEqual([
      "flow-gemini-lens",
      "--worktree",
      WT,
      "--diff-file",
      P.snapshot,
      "--out",
      P.lensOut,
      "--config",
      "/wt/cfg.json",
    ]);
  });
});

describe("runSupervise outcomes", () => {
  it("marks an empty-envelope exit helper-exited-without-envelope", async () => {
    const t = setup(stateFor("g", { guess: "skipped" }));
    t.hooks.push(() => t.children.forEach((c) => c.exit()));
    const s = await runSupervise({ worktree: WT, generation: "g" }, t.deps);
    expect(s.helpers["gemini-lens"]).toMatchObject({
      status: "done",
      outcome: "helper-exited-without-envelope",
      skipClass: "ran-unusable",
    });
  });

  it("records complete for a newline-terminated parseable envelope", async () => {
    const t = setup(stateFor("g", { guess: "skipped" }));
    t.hooks.push(() => {
      t.files.set(P.lensEnvelope, '{"ran":true}\n');
      t.children.forEach((c) => c.exit());
    });
    const s = await runSupervise({ worktree: WT, generation: "g" }, t.deps);
    expect(s.helpers["gemini-lens"].outcome).toBe("complete");
    expect(t.files.has(P.snapshot)).toBe(false);
  });

  it("treats a half-written envelope (no newline) as not complete", async () => {
    const t = setup(stateFor("g", { guess: "skipped" }), {
      [P.lensEnvelope]: '{"ran":tr',
    });
    t.hooks.push(() => t.children.forEach((c) => c.exit()));
    const s = await runSupervise({ worktree: WT, generation: "g" }, t.deps);
    expect(s.helpers["gemini-lens"].outcome).toBe(
      "helper-exited-without-envelope",
    );
  });

  it("at give-up: SIGTERMs the group, SIGKILLs after grace, removes partial out, writes lens-timeout", async () => {
    const t = setup(stateFor("g", { guess: "skipped" }), {
      [P.lensOut]: "partial",
    });
    const s = await runSupervise({ worktree: WT, generation: "g" }, t.deps);
    const pid = t.children[0]!.pid;
    expect(t.kills).toEqual([
      [pid, "SIGTERM"],
      [pid, "SIGKILL"],
    ]);
    expect(t.files.has(P.lensOut)).toBe(false);
    expect(JSON.parse(t.files.get(P.lensEnvelope)!)).toEqual({
      ran: false,
      skipReason: "lens-timeout",
      skipClass: "ran-unusable",
    });
    expect(s.helpers["gemini-lens"].outcome).toBe("lens-timeout");
    expect(t.clock()).toBeGreaterThanOrEqual(1020);
  });

  it("does not SIGKILL when the group is gone after the grace", async () => {
    const t = setup(stateFor("g", { guess: "skipped" }));
    t.hooks.push(() => {
      if (t.kills.length > 0) t.children.forEach((c) => c.exit());
    });
    await runSupervise({ worktree: WT, generation: "g" }, t.deps);
    expect(t.kills.map((k) => k[1])).toEqual(["SIGTERM"]);
  });

  it("lets a late real envelope win over the synthesized timeout", async () => {
    const t = setup(stateFor("g", { guess: "skipped" }));
    t.hooks.push((now) => {
      if (now >= 1020) {
        t.files.set(P.lensEnvelope, '{"ran":true}\n');
        t.children.forEach((c) => c.exit());
      }
    });
    const s = await runSupervise({ worktree: WT, generation: "g" }, t.deps);
    expect(s.helpers["gemini-lens"].outcome).toBe("complete");
  });
});

describe("runSupervise signals and ownership", () => {
  it("SIGTERM kills both groups and marks unresolved helpers", async () => {
    const t = setup(stateFor("g"));
    const run = runSupervise({ worktree: WT, generation: "g" }, t.deps);
    t.signals.get("SIGTERM")!();
    const s = await run;
    const pids = t.children.map((c) => c.pid);
    for (const pid of pids) expect(t.kills).toContainEqual([pid, "SIGTERM"]);
    for (const h of Object.values(s.helpers)) {
      expect(h.outcome).toBe("helper-exited-without-envelope");
    }
  });

  it("SIGTERM signals only the helper that has not exited", async () => {
    const t = setup(stateFor("g"));
    const run = runSupervise({ worktree: WT, generation: "g" }, t.deps);
    const [lens, guess] = t.children;
    guess!.exit();
    t.signals.get("SIGTERM")!();
    await run;
    expect(t.kills).toContainEqual([lens!.pid, "SIGTERM"]);
    expect(t.kills.filter(([pid]) => pid === guess!.pid)).toEqual([]);
  });

  it("a superseded generation never overwrites the newer state", async () => {
    const t = setup(stateFor("g", { guess: "skipped" }), {
      [P.snapshot]: "diff",
    });
    t.hooks.push(() => {
      writeReviewBgState(WT, stateFor("newer"), t.io);
    });
    await runSupervise({ worktree: WT, generation: "g" }, t.deps);
    const s = read(t.files);
    expect(s.generation).toBe("newer");
    expect(s.helpers["gemini-lens"].status).toBe("running");
    expect(t.files.get(P.snapshot)).toBe("diff");
    expect(t.kills).toContainEqual([t.children[0]!.pid, "SIGTERM"]);
  });

  it("stops its children and writes nothing when its state file was cleared", async () => {
    const t = setup(stateFor("g", { guess: "skipped" }), {
      [P.snapshot]: "diff",
    });
    t.hooks.push(() => void t.files.delete(P.state));
    await runSupervise({ worktree: WT, generation: "g" }, t.deps);
    expect(t.files.has(P.state)).toBe(false);
    expect(t.files.get(P.snapshot)).toBe("diff");
    expect(t.kills).toContainEqual([t.children[0]!.pid, "SIGTERM"]);
  });

  it("refuses a state whose config path is outside the worktree and the flow config", async () => {
    const st = stateFor("g");
    st.configPath = "/etc/passwd";
    const t = setup(st);
    await expect(
      runSupervise({ worktree: WT, generation: "g" }, t.deps),
    ).rejects.toBeInstanceOf(SuperviseRefused);
    expect(t.children).toHaveLength(0);
  });

  it("ignores helper paths in the state file and uses the worktree layout", async () => {
    const st = stateFor("g", { guess: "skipped" });
    st.helpers["gemini-lens"].envelope = "/victim/envelope";
    st.helpers["gemini-lens"].out = "/victim/out";
    st.helpers["gemini-lens"].giveUpAtSec = 0;
    const t = setup(st, { "/victim/out": "keep", "/victim/envelope": "keep" });
    await runSupervise({ worktree: WT, generation: "g" }, t.deps);
    expect(t.files.get("/victim/out")).toBe("keep");
    expect(t.files.get("/victim/envelope")).toBe("keep");
    expect(t.children[0]!.argv).toContain(P.lensOut);
  });
});
