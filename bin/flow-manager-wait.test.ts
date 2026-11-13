import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, parseArgs, type WaitDeps } from "./flow-manager-wait";
import { appendManagerLog } from "./lib/manager-log";
import { readProposals } from "./lib/manager-proposals";
import { writeManagerRecord } from "./lib/manager-record";
import { updateScope } from "./lib/manager-scope";
import { ackWake, readWaiter, writeWaiter } from "./lib/manager-waiter";
import { writeState, type PipelineState } from "./lib/state";

const T0 = Date.parse("2026-11-12T10:00:00.000Z");
let dir: string;
let home: string;
let stateDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mwaitcli-"));
  home = path.join(dir, "manager");
  stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  updateScope(
    () => ({
      version: 1,
      scopes: ["repo:flow"],
      updatedAt: new Date(T0).toISOString(),
      source: "owner-words",
    }),
    home,
  );
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const put = (slug: string, phase: string, repo = "/r/flow", at = T0) =>
  writeState(
    {
      slug,
      phase,
      repo,
      updatedAt: new Date(at).toISOString(),
      phaseLog: [{ phase, at: new Date(at).toISOString() }],
    } as PipelineState,
    stateDir,
  );

type Harness = {
  deps: WaitDeps;
  lines: string[];
  notified: string[][];
  recorded: Array<[string, Record<string, unknown>]>;
  tick: number;
  onSleep: Array<(n: number) => void>;
};
function harness(onSleep: (n: number) => void = () => {}, start = T0): Harness {
  let t = start;
  const h: Harness = {
    lines: [],
    notified: [],
    recorded: [],
    tick: 0,
    onSleep: [onSleep],
    deps: {
      home,
      stateDir,
      pid: 4242,
      kill: () => {},
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        h.tick++;
        h.onSleep.forEach((f) => f(h.tick));
      },
      out: (l) => h.lines.push(l),
      notify: (a) => h.notified.push(a),
      exec: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
      record: (e, a) => h.recorded.push([e, a]),
    },
  };
  return h;
}
const result = (h: Harness) => JSON.parse(h.lines.at(-1) ?? "{}");

describe("parseArgs", () => {
  it("defaults to an unbounded 5 s / 10 s waiter and rejects bad values", () => {
    expect(parseArgs([])).toMatchObject({
      intervalSec: 5,
      settleSec: 10,
      maxSec: 0,
      ensure: false,
    });
    expect(parseArgs(["--interval", "x"])).toHaveProperty("error");
    expect(parseArgs(["--bogus"])).toHaveProperty("error");
  });
});

describe("flow-manager-wait", () => {
  it("wakes once for a transition and keeps it in wake.json until acked", async () => {
    put("a", "implementing");
    const h = harness((n) => {
      if (n === 1) put("a", "gated", "/r/flow", T0 + 6000);
    });
    expect(await run([], h.deps)).toBe(0);
    const r = result(h);
    expect(r.outcome).toBe("wake");
    expect(r.reread).toBe("wake-protocol.md");
    expect(r.events).toEqual([
      {
        kind: "transition",
        slug: "a",
        repo: "flow",
        from: "implementing",
        to: "gated",
      },
    ]);
    const wake = JSON.parse(
      fs.readFileSync(path.join(home, "wake.json"), "utf8"),
    );
    expect(wake.events).toHaveLength(1);
  });

  it("re-emits unacknowledged events from a fresh waiter at once", async () => {
    put("a", "implementing");
    const first = harness((n) => {
      if (n === 1) put("a", "gated", "/r/flow", T0 + 6000);
    });
    await run([], first.deps);
    const again = harness();
    await run([], again.deps);
    expect(result(again).events).toEqual(result(first).events);
    expect(again.tick).toBe(0);
    expect(again.recorded.filter(([e]) => e === "manager.wake")).toHaveLength(
      1,
    );
  });

  it("--ensure reports a live waiter without starting one, and start-needed otherwise", async () => {
    const h = harness();
    expect((await run(["--ensure"], h.deps), result(h).outcome)).toBe(
      "start-needed",
    );
    const rec = {
      version: 1 as const,
      pid: 4242,
      startedAt: new Date(T0).toISOString(),
      aliveAt: new Date(T0).toISOString(),
    };
    writeWaiter(rec, home);
    const h2 = harness();
    await run(["--ensure"], h2.deps);
    expect(result(h2).outcome).toBe("already-running");
    expect(readWaiter(home)).toEqual(rec);
    expect(h2.tick).toBe(0);
  });

  it("--ensure does not count a waiter that started before this manager launched", async () => {
    writeManagerRecord(
      {
        version: 1,
        window: "manager",
        startedAt: new Date(T0 + 1000).toISOString(),
        model: "opus",
        effort: "high",
        heartbeatSec: 900,
        stopWhenIdle: false,
        notices: false,
      },
      home,
    );
    writeWaiter(
      {
        version: 1,
        pid: 4242,
        startedAt: new Date(T0).toISOString(),
        aliveAt: new Date(T0).toISOString(),
      },
      home,
    );
    const h = harness();
    await run(["--ensure"], h.deps);
    expect(result(h).outcome).toBe("start-needed");
  });

  it("resumes the heartbeat clock from the previous waiter process", async () => {
    put("a", "implementing");
    await run(["--max-sec", "40", "--heartbeat", "60"], harness().deps);
    const h = harness(() => {}, T0 + 40_000);
    await run(["--max-sec", "40", "--heartbeat", "60"], h.deps);
    expect(h.recorded.filter(([e]) => e === "manager.heartbeat")).toHaveLength(
      1,
    );
  });

  it("a stale waiter record counts as dead", async () => {
    writeWaiter(
      {
        version: 1,
        pid: 4242,
        startedAt: "x",
        aliveAt: new Date(T0 - 600_000).toISOString(),
      },
      home,
    );
    const h = harness();
    await run(["--ensure"], h.deps);
    expect(result(h).outcome).toBe("start-needed");
  });

  it("a newer waiter supersedes the older one", async () => {
    const h = harness((n) => {
      if (n === 1) {
        writeWaiter(
          {
            version: 1,
            pid: 9,
            startedAt: "2099-01-01T00:00:00.000Z",
            aliveAt: "2099-01-01T00:00:00.000Z",
          },
          home,
        );
      }
    });
    await run([], h.deps);
    expect(result(h).outcome).toBe("superseded");
  });

  it("rewrites status.md only on change and shows when the watcher was last alive", async () => {
    put("a", "implementing");
    const generated: string[] = [];
    const read = () =>
      fs
        .readFileSync(path.join(home, "status.md"), "utf8")
        .split("\n")
        .find((l) => l.startsWith("Generated")) ?? "";
    const h = harness(() => generated.push(read()));
    await run(["--max-sec", "20"], h.deps);
    expect(result(h).outcome).toBe("timeout");
    expect(new Set(generated).size).toBe(1);
    expect(generated[0]).toMatch(/watcher last alive at \d\d:\d\d/);
  });

  it("wakes once when a heartbeat finds an in-scope PR merged out of band, and not again after the ack", async () => {
    writeState(
      {
        slug: "a",
        phase: "ci-waiting",
        repo: "/r/flow",
        pr: 7,
        prUrl: "https://github.com/acme/flow/pull/7",
        updatedAt: new Date(T0).toISOString(),
        phaseLog: [{ phase: "ci-waiting", at: new Date(T0).toISOString() }],
      } as PipelineState,
      stateDir,
    );
    const merged = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        data: {
          r0: {
            nameWithOwner: "acme/flow",
            p7: { number: 7, state: "MERGED" },
          },
        },
      }),
      stderr: "",
    });
    const h = harness();
    h.deps.exec = merged;
    await run(
      ["--heartbeat", "60", "--settle", "0", "--max-sec", "130"],
      h.deps,
    );
    expect(result(h).outcome).toBe("wake");
    expect(result(h).events).toEqual([
      { kind: "merged-out-of-band", slug: "a", repo: "flow", to: "MERGED" },
    ]);
    ackWake(home);
    const h2 = harness(() => {}, T0 + 10_000);
    h2.deps.exec = merged;
    await run(
      ["--heartbeat", "60", "--settle", "0", "--max-sec", "130"],
      h2.deps,
    );
    expect(result(h2).outcome).toBe("timeout");
  });

  it("records a heartbeat event each time the heartbeat query runs", async () => {
    put("a", "implementing");
    const h = harness();
    await run(["--max-sec", "130", "--heartbeat", "60"], h.deps);
    expect(h.recorded.filter(([e]) => e === "manager.heartbeat")).toHaveLength(
      2,
    );
  });

  it("with notices off, neither wake.json nor stdout names an out-of-scope slug", async () => {
    put("a", "implementing");
    put("secret-o", "implementing", "/r/other");
    const h = harness((n) => {
      if (n === 1) put("secret-o", "gated", "/r/other", T0 + 6000);
    });
    await run(["--max-sec", "30"], h.deps);
    expect(result(h).outcome).toBe("timeout");
    expect(h.lines.join("")).not.toContain("secret-o");
    expect(fs.existsSync(path.join(home, "wake.json"))).toBe(false);
  });

  it("proposes a stale pipeline once without touching its state, and not an owner-needed one", async () => {
    const old = T0 - 8 * 86_400_000;
    put("stale-one", "implementing", "/r/flow", old);
    put("stale-gated", "gated", "/r/flow", old);
    const before = fs.readFileSync(
      path.join(stateDir, "stale-one.json"),
      "utf8",
    );
    const h = harness();
    await run(["--max-sec", "20"], h.deps);
    const h2 = harness();
    await run(["--max-sec", "10"], h2.deps);
    const props = readProposals(home);
    expect(props.map((p) => p.slug)).toEqual(["stale-one"]);
    expect(fs.readFileSync(path.join(home, "status.md"), "utf8")).toMatch(
      /\| stale-gated \|.*waited 7\+ days on you/,
    );
    expect(fs.readFileSync(path.join(stateDir, "stale-one.json"), "utf8")).toBe(
      before,
    );
  });

  it("notifies once for a new in-scope plan-pending-review and not for gated", async () => {
    put("a", "implementing");
    put("b", "implementing");
    const h = harness((n) => {
      if (n === 1) {
        put("a", "plan-pending-review", "/r/flow", T0 + 6000);
        put("b", "gated", "/r/flow", T0 + 6000);
      }
    });
    await run([], h.deps);
    const sends = h.notified.filter((a) => a.includes("--reason"));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("a");
  });

  it("puts a pipeline back in the needs-you list when its ruling goes unaccepted for 15 minutes, once", async () => {
    put("a", "plan-pending-review");
    appendManagerLog(
      {
        ts: new Date(T0 + 1000).toISOString(),
        kind: "ruling-written",
        repo: "flow",
        slug: "a",
        phase: "plan-pending-review",
        key: "ruling:r-1",
      },
      { home },
    );
    const h = harness();
    await run(["--max-sec", "1200", "--settle", "0"], h.deps);
    const r = result(h);
    expect(r.outcome).toBe("wake");
    expect(r.events).toEqual([
      { kind: "ruling-unpicked", slug: "a", repo: "flow", ruling: "r-1" },
    ]);
    const status = fs.readFileSync(path.join(home, "status.md"), "utf8");
    expect(status).toContain("approval not picked up — answer in window a");
    h.lines.length = 0;
    fs.rmSync(path.join(home, "wake.json"));
    const again = harness(() => {}, T0 + 1_300_000);
    await run(["--max-sec", "30", "--settle", "0"], again.deps);
    expect(result(again).outcome).toBe("timeout");
  });

  it("--stop-when-idle with an empty scope never reports idle", async () => {
    updateScope(
      () => ({
        version: 1,
        scopes: [],
        updatedAt: new Date(T0).toISOString(),
        source: "owner-words",
      }),
      home,
    );
    put("a", "gated");
    const h = harness();
    await run(["--stop-when-idle", "--max-sec", "30"], h.deps);
    expect(result(h).outcome).toBe("timeout");
  });

  it("honours the manager record's stopWhenIdle without the flag", async () => {
    writeManagerRecord(
      {
        version: 1,
        window: "manager",
        startedAt: new Date(T0).toISOString(),
        model: "opus",
        effort: "high",
        heartbeatSec: 900,
        stopWhenIdle: true,
        notices: false,
      },
      home,
    );
    put("a", "implementing");
    const h = harness((n) => {
      if (n === 1) put("a", "gated", "/r/flow", T0 + 6000);
    });
    await run(["--settle", "0"], h.deps);
    const kinds = result(h).events.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain("idle");
  });
});
