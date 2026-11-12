import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  holderArgv,
  KEEP_AWAKE_RENEW_AFTER_MS,
  syncKeepAwake,
  type KeepAwakeDeps,
} from "./keep-awake";
import type { ProcRegistryRow } from "./proc-registry";
import type { PipelineState } from "./state";

const describeOnDarwin = describe.skipIf(process.platform !== "darwin");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
};

const ASSERTIONS = ["PreventUserIdleSystemSleep", "PreventSystemSleep"];

// pmset prints the timeout on the `Details:` line after the pid line.
const assertionsListing = (pid: number, name: string, detail = ""): boolean => {
  const lines = spawnSync("pmset", ["-g", "assertions"], {
    encoding: "utf8",
  }).stdout.split("\n");
  return lines.some(
    (l, i) =>
      l.includes(`pid ${pid}(caffeinate)`) &&
      l.includes(name) &&
      (lines[i + 1] ?? "").includes(detail),
  );
};

const hasAll = (pid: number, detail = ""): boolean =>
  ASSERTIONS.every((n) => assertionsListing(pid, n, detail));

const hasNone = (pid: number): boolean =>
  ASSERTIONS.every((n) => !assertionsListing(pid, n));

describeOnDarwin("keep-awake live", () => {
  const spawned: ChildProcess[] = [];
  const holders = new Set<number>();

  afterEach(() => {
    for (const c of spawned) {
      try {
        c.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    spawned.length = 0;
    for (const pid of holders) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    holders.clear();
  });

  const watched = (): ChildProcess => {
    const c = spawn("sleep", ["60"], { stdio: "ignore" });
    spawned.push(c);
    return c;
  };

  const harness = () => {
    const rows: ProcRegistryRow[] = [];
    const clock = { now: Date.now() };
    const deps: Partial<KeepAwakeDeps> = {
      nowMs: () => clock.now,
      envOff: () => false,
      enabled: () => true,
      maxSec: () => 7200,
      // liveness.ts probes `ps` via Bun.spawnSync, which vitest (node) lacks.
      startEpoch: () => 1,
      isLive: (r) => alive(r.pid),
      readRows: () => rows,
      appendRow: (_s, r) => {
        rows.push(r);
        holders.add(r.pid);
        return true;
      },
    };
    return { rows, deps, clock };
  };

  const stateFor = (pid: number): PipelineState =>
    ({
      slug: "live-keep-awake",
      phase: "implementing",
      repo: "r",
      pid,
    }) as PipelineState;

  it("should show the assertions in pmset, drop it on release, and exit when the watched pid dies", async () => {
    const child = watched();
    const { rows, deps } = harness();
    const st = stateFor(child.pid!);

    expect(syncKeepAwake(st, deps).action).toBe("acquired");
    const holder = rows[0]!.pid;
    expect(await waitFor(() => hasAll(holder, "for 7200 secs"), 2000)).toBe(
      true,
    );

    expect(syncKeepAwake({ ...st, phase: "merged" }, deps).action).toBe(
      "released",
    );
    expect(await waitFor(() => !alive(holder), 2000)).toBe(true);
    expect(await waitFor(() => hasNone(holder), 2000)).toBe(true);

    rows.length = 0;
    expect(syncKeepAwake(st, deps).action).toBe("acquired");
    const second = rows[0]!.pid;
    child.kill("SIGKILL");
    expect(await waitFor(() => !alive(second), 2000)).toBe(true);
  });

  it("should replace the holder once it is 15 minutes old", async () => {
    const child = watched();
    const { rows, deps, clock } = harness();
    const st = stateFor(child.pid!);

    expect(syncKeepAwake(st, deps).action).toBe("acquired");
    const first = rows[0]!.pid;
    expect(await waitFor(() => hasAll(first), 2000)).toBe(true);

    clock.now = rows[0]!.recordedAt + KEEP_AWAKE_RENEW_AFTER_MS;
    expect(syncKeepAwake(st, deps).action).toBe("acquired");
    const second = rows[1]!.pid;
    expect(second).not.toBe(first);
    expect(await waitFor(() => hasAll(second), 2000)).toBe(true);
    expect(await waitFor(() => hasNone(first), 2000)).toBe(true);
  });

  it("should exit by itself at the -t deadline", async () => {
    const child = watched();
    const argv = holderArgv(child.pid, 2);
    const holder = spawn(argv[0]!, argv.slice(1), { stdio: "ignore" });
    spawned.push(holder);
    expect(
      await waitFor(
        () => holder.exitCode !== null || holder.signalCode !== null,
        4500,
      ),
    ).toBe(true);
  });
});
