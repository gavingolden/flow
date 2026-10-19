import { describe, expect, it, vi } from "vitest";
import {
  GUARD_DEADLINE_EXIT,
  GUARD_DEADLINE_MARKER,
  GUARD_LEFTOVER_MARKER,
  GUARD_SPAWN_FAILED_EXIT,
  GUARD_SPAWN_FAILED_MARKER,
  KILL_GRACE_MS,
  parseGuardArgs,
  runGuard,
  type GuardDeps,
} from "./agy-guard";

const PGID = 7777;

function rig(
  opts: { groupAliveAfterExit?: boolean; pid?: number | undefined } = {},
) {
  const events: string[] = [];
  const timers: Array<{
    id: number;
    ms: number;
    fn: () => void;
    live: boolean;
  }> = [];
  let exitCb: (c: number | null, s: NodeJS.Signals | null) => void = () => {};
  let errCb: (e: Error) => void = () => {};
  let watchOnGone: () => void = () => {};
  const signalCbs = new Map<string, () => void>();
  const watchOpts: Array<Parameters<GuardDeps["startParentWatch"]>[0]> = [];
  let writeThrows = false;

  const deps: Partial<GuardDeps> = {
    spawnDetached: (cmd, args) => {
      events.push(`spawn:${cmd} ${args.join(" ")}`);
      return {
        pid: "pid" in opts ? opts.pid : PGID,
        onExit: (cb) => {
          exitCb = cb;
        },
        onError: (cb) => {
          errCb = cb;
        },
      };
    },
    killGroup: (pgid, sig) => {
      events.push(`kill:${pgid}:${sig}`);
      if (sig === 0) return opts.groupAliveAfterExit ?? false;
      return true;
    },
    parentPid: 321,
    parentStartEpoch: 1700000000,
    startParentWatch: (o) => {
      watchOpts.push(o);
      watchOnGone = o.onGone;
      return () => events.push("watch-stopped");
    },
    writeErr: (line) => {
      events.push(`err:${line}`);
      if (writeThrows)
        throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    },
    setTimeoutFn: ((fn: () => void, ms: number) => {
      const t = { id: timers.length + 1, ms, fn, live: true };
      timers.push(t);
      return t.id;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: ((id: number) => {
      const t = timers.find((x) => x.id === id);
      if (t) t.live = false;
    }) as unknown as typeof clearTimeout,
    onSignal: (sig, cb) => {
      signalCbs.set(sig, cb);
    },
  };
  const fire = (ms: number) => {
    const t = timers.find((x) => x.live && x.ms === ms);
    if (!t) throw new Error(`no live timer for ${ms}`);
    t.live = false;
    t.fn();
  };
  return {
    deps,
    events,
    watchOpts,
    exit: (c: number | null, s: NodeJS.Signals | null = null) => exitCb(c, s),
    error: (e: Error) => errCb(e),
    callerGone: () => watchOnGone(),
    signal: (s: string) => signalCbs.get(s)?.(),
    fire,
    setWriteThrows: (v: boolean) => {
      writeThrows = v;
    },
  };
}

const ARGV = ["--deadline-ms", "5000", "--", "agy", "-p", "hi"];

describe("parseGuardArgs", () => {
  it("parses deadline and command", () => {
    expect(parseGuardArgs(ARGV)).toEqual({
      deadlineMs: 5000,
      command: ["agy", "-p", "hi"],
    });
  });
  it.each([
    [[]],
    [["--deadline-ms", "abc", "--", "agy"]],
    [["--deadline-ms", "0", "--", "agy"]],
    [["--deadline-ms", "10", "agy"]],
    [["--deadline-ms", "10", "--"]],
  ])("rejects %j", (argv) => {
    expect(parseGuardArgs(argv)).toHaveProperty("error");
  });
});

describe("runGuard", () => {
  it("bad args exit 2 without spawning", async () => {
    const r = rig();
    expect(await runGuard(["nope"], r.deps)).toBe(2);
    expect(r.events.some((e) => e.startsWith("spawn:"))).toBe(false);
  });

  it("spawns the generic command and passes the captured parent start time to the watch", async () => {
    const r = rig();
    const p = runGuard(ARGV, r.deps);
    r.exit(0);
    await p;
    expect(r.events[0]).toBe("spawn:agy -p hi");
    expect(r.watchOpts[0]).toMatchObject({
      parentPid: 321,
      parentStartEpoch: 1700000000,
    });
  });

  it("(a) clean exit with an empty group exits with agy's code and writes nothing", async () => {
    const r = rig();
    const p = runGuard(ARGV, r.deps);
    r.exit(3);
    expect(await p).toBe(3);
    expect(r.events.some((e) => e.startsWith("err:"))).toBe(false);
    expect(r.events).toContain(`kill:${PGID}:0`);
    expect(r.events).not.toContain(`kill:${PGID}:SIGKILL`);
  });

  it("(a) sweeps leftover group members after a normal exit", async () => {
    const r = rig({ groupAliveAfterExit: true });
    const p = runGuard(ARGV, r.deps);
    r.exit(0);
    expect(await p).toBe(0);
    expect(r.events).toContain(`kill:${PGID}:SIGKILL`);
    expect(r.events).toContain(`err:${GUARD_LEFTOVER_MARKER}`);
  });

  it("(a) agy dying by signal exits 128+signal", async () => {
    const r = rig();
    const p = runGuard(ARGV, r.deps);
    r.exit(null, "SIGKILL");
    expect(await p).toBe(137);
  });

  it("(b) deadline: SIGTERM, wait the kill grace, SIGKILL, marker, exit 124", async () => {
    const r = rig();
    const p = runGuard(ARGV, r.deps);
    r.fire(5000);
    expect(r.events).toContain(`kill:${PGID}:SIGTERM`);
    expect(r.events).not.toContain(`kill:${PGID}:SIGKILL`);
    r.fire(KILL_GRACE_MS);
    expect(await p).toBe(GUARD_DEADLINE_EXIT);
    const term = r.events.indexOf(`kill:${PGID}:SIGTERM`);
    const kill = r.events.indexOf(`kill:${PGID}:SIGKILL`);
    const marker = r.events.indexOf(`err:${GUARD_DEADLINE_MARKER}`);
    expect(term).toBeLessThan(kill);
    expect(kill).toBeLessThan(marker);
    expect(GUARD_DEADLINE_MARKER).toContain("--print-timeout");
  });

  it("(b) agy exiting during the stop grace does not change the outcome", async () => {
    const r = rig({ groupAliveAfterExit: true });
    const p = runGuard(ARGV, r.deps);
    r.fire(5000);
    r.exit(0);
    r.fire(KILL_GRACE_MS);
    expect(await p).toBe(GUARD_DEADLINE_EXIT);
  });

  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ])(
    "(c) %s stops the group politely then forcibly and exits %i",
    async (sig, code) => {
      const r = rig();
      const p = runGuard(ARGV, r.deps);
      r.signal(sig);
      expect(r.events).toContain(`kill:${PGID}:SIGTERM`);
      r.fire(KILL_GRACE_MS);
      expect(await p).toBe(code);
      expect(r.events).toContain(`kill:${PGID}:SIGKILL`);
    },
  );

  it("(d) caller gone: group signalled, no stderr write at all, exit 1", async () => {
    const r = rig();
    const p = runGuard(ARGV, r.deps);
    r.callerGone();
    expect(r.events).toContain(`kill:${PGID}:SIGTERM`);
    r.fire(KILL_GRACE_MS);
    expect(await p).toBe(1);
    expect(r.events).toContain(`kill:${PGID}:SIGKILL`);
    expect(r.events.some((e) => e.startsWith("err:"))).toBe(false);
  });

  it("a throwing writeErr (EPIPE) never prevents the group kill", async () => {
    const r = rig({ groupAliveAfterExit: true });
    r.setWriteThrows(true);
    const p = runGuard(ARGV, r.deps);
    r.exit(0);
    expect(await p).toBe(0);
    expect(r.events).toContain(`kill:${PGID}:SIGKILL`);
  });

  it("a throwing writeErr on the deadline path still yields exit 124", async () => {
    const r = rig();
    r.setWriteThrows(true);
    const p = runGuard(ARGV, r.deps);
    r.fire(5000);
    r.fire(KILL_GRACE_MS);
    expect(await p).toBe(GUARD_DEADLINE_EXIT);
  });

  it("(e) spawn error writes the marker and exits 127", async () => {
    const r = rig({ pid: undefined });
    const p = runGuard(ARGV, r.deps);
    r.error(new Error("spawn agy ENOENT"));
    expect(await p).toBe(GUARD_SPAWN_FAILED_EXIT);
    expect(r.events).toContain(
      `err:${GUARD_SPAWN_FAILED_MARKER}: spawn agy ENOENT`,
    );
    expect(r.events.some((e) => e.startsWith("kill:"))).toBe(false);
  });

  it("stops the parent watch and clears the deadline when agy exits", async () => {
    const r = rig();
    const p = runGuard(ARGV, r.deps);
    r.exit(0);
    await p;
    expect(r.events).toContain("watch-stopped");
    expect(() => r.fire(5000)).toThrow();
  });

  it("ignores a second signal while already stopping", async () => {
    const r = rig();
    const spy = vi.fn();
    const p = runGuard(ARGV, r.deps);
    r.signal("SIGTERM");
    r.signal("SIGINT");
    r.fire(KILL_GRACE_MS);
    spy(await p);
    expect(spy).toHaveBeenCalledWith(143);
    expect(r.events.filter((e) => e === `kill:${PGID}:SIGTERM`)).toHaveLength(
      1,
    );
  });
});
