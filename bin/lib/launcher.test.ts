import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLAIN_IDLE_HINT,
  PLAIN_RESUME_REFUSAL_NOTICE,
  plainAttachHint,
  plainLaunch,
  plainResume,
  plainTerminate,
} from "./launcher";
import { readState, writeState, nowIso, type PipelineState } from "./state";

let stateDir!: string;
let logSpy!: ReturnType<typeof vi.spyOn>;
let errSpy!: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-launcher-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  logSpy.mockRestore();
  errSpy.mockRestore();
});

function seedState(overrides: Partial<PipelineState> = {}): PipelineState {
  const state: PipelineState = {
    slug: "my-feature",
    phase: "starting",
    repo: "/repo",
    updatedAt: nowIso(),
    ...overrides,
  };
  writeState(state, stateDir);
  return state;
}

function fakeSpawn(opts: { pid?: number; exitCode?: number } = {}) {
  const calls: Array<{ argv: string[]; cwd: string; env: NodeJS.ProcessEnv }> =
    [];
  let release!: (code: number) => void;
  const exited = new Promise<number>((r) => (release = r));
  const spawn = (
    argv: string[],
    o: { cwd: string; env: NodeJS.ProcessEnv },
  ) => {
    calls.push({ argv, cwd: o.cwd, env: o.env });
    if (opts.exitCode !== undefined) release(opts.exitCode);
    return { pid: opts.pid ?? 4242, exited };
  };
  return { spawn, calls, release: (c: number) => release(c) };
}

describe("plainLaunch", () => {
  it("prints flow:<slug> first, then the idle hint, spawns with FLOW_SLUG env + seed as final positional, and records pid/procStartedAt/launcher", async () => {
    seedState();
    const { spawn, calls, release } = fakeSpawn({ pid: 777 });
    const p = plainLaunch(
      {
        slug: "my-feature",
        repo: "/repo",
        command: ["claude", "--settings", "/s.json"],
        seed: "SEED TEXT",
        stateDir,
      },
      { spawn, isTTY: true, pidStartEpoch: () => 1700000000 },
    );
    // wait a tick so the spawn + state write land before releasing exit
    await new Promise((r) => setTimeout(r, 0));

    // ordering: contract line (stdout) before the spawn; idle hint on stderr
    expect(logSpy).toHaveBeenCalledWith("flow:my-feature");
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      PLAIN_IDLE_HINT,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual([
      "claude",
      "--settings",
      "/s.json",
      "SEED TEXT",
    ]);
    expect(calls[0]!.cwd).toBe("/repo");
    expect(calls[0]!.env.FLOW_PIPELINE).toBe("1");
    expect(calls[0]!.env.FLOW_SLUG).toBe("my-feature");

    const mid = readState("my-feature", stateDir);
    expect(mid?.pid).toBe(777);
    expect(mid?.procStartedAt).toBe(1700000000);
    expect(mid?.launcher).toBe("plain");

    // supervisor advanced the phase → normal exit, state survives
    writeState({ ...mid!, phase: "merged" }, stateDir);
    release(0);
    const result = await p;
    expect(result).toEqual({ status: "exited", exitCode: 0, stderr: "" });
    expect(readState("my-feature", stateDir)).not.toBeNull();
  });

  it("deletes state on fast-fail (exit with phase still starting, no seedIngestedAt)", async () => {
    seedState();
    const { spawn } = fakeSpawn({ exitCode: 1 });
    const result = await plainLaunch(
      {
        slug: "my-feature",
        repo: "/repo",
        command: ["claude"],
        seed: "s",
        stateDir,
      },
      { spawn, isTTY: true, pidStartEpoch: () => 1 },
    );
    expect(result.status).toBe("failed");
    expect(readState("my-feature", stateDir)).toBeNull();
  });

  it("keeps state when the seed-ingested marker was stamped even at phase starting", async () => {
    seedState({ seedIngestedAt: nowIso() });
    const { spawn } = fakeSpawn({ exitCode: 0 });
    const result = await plainLaunch(
      {
        slug: "my-feature",
        repo: "/repo",
        command: ["claude"],
        seed: "s",
        stateDir,
      },
      { spawn, isTTY: true, pidStartEpoch: () => 1 },
    );
    expect(result.status).toBe("exited");
    expect(readState("my-feature", stateDir)).not.toBeNull();
  });

  it("refuses without spawning when not a TTY", async () => {
    seedState();
    const { spawn, calls } = fakeSpawn({ exitCode: 0 });
    const result = await plainLaunch(
      {
        slug: "my-feature",
        repo: "/repo",
        command: ["claude"],
        seed: "s",
        stateDir,
      },
      { spawn, isTTY: false },
    );
    expect(result.status).toBe("failed");
    expect(calls).toHaveLength(0);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "needs an interactive terminal",
    );
  });

  it("deletes the orphaned starting-phase state when the TTY guard fires before any spawn", async () => {
    seedState({ phase: "starting" });
    const { spawn, calls } = fakeSpawn({ exitCode: 0 });
    const result = await plainLaunch(
      {
        slug: "my-feature",
        repo: "/repo",
        command: ["claude"],
        seed: "s",
        stateDir,
      },
      { spawn, isTTY: false },
    );
    expect(result.status).toBe("failed");
    expect(calls).toHaveLength(0);
    // Regression: the TTY guard used to return before the delete-on-fast-fail
    // cleanup ran, orphaning the `starting` state file (bug-detection finding
    // on PR #457).
    expect(readState("my-feature", stateDir)).toBeNull();
  });

  it("does not delete state on the TTY guard when seedIngestedAt is already stamped (not an orphan)", async () => {
    seedState({ phase: "starting", seedIngestedAt: nowIso() });
    const { spawn } = fakeSpawn({ exitCode: 0 });
    await plainLaunch(
      {
        slug: "my-feature",
        repo: "/repo",
        command: ["claude"],
        seed: "s",
        stateDir,
      },
      { spawn, isTTY: false },
    );
    expect(readState("my-feature", stateDir)).not.toBeNull();
  });

  it("catches a synchronously-throwing spawn (claude not on PATH), reports an actionable error, and cleans up orphaned state", async () => {
    seedState({ phase: "starting" });
    const spawn = (): never => {
      throw new Error("ENOENT: claude");
    };
    const result = await plainLaunch(
      {
        slug: "my-feature",
        repo: "/repo",
        command: ["claude"],
        seed: "s",
        stateDir,
      },
      { spawn, isTTY: true },
    );
    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("ENOENT: claude");
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "check your Claude Code install",
    );
    expect(readState("my-feature", stateDir)).toBeNull();
  });
});

// Injected liveness probes: vitest runs under node (no Bun global), so the
// real pidStartEpoch/ps probes are unavailable — every liveness verdict is
// driven through the seam.
const aliveProbes = { isAlive: () => true, pidStartEpoch: () => 123 };

describe("plainResume", () => {
  it("refuses when the recorded process is alive", async () => {
    seedState({ pid: 555, procStartedAt: 123 });
    const { spawn, calls } = fakeSpawn({ exitCode: 0 });
    const result = await plainResume(
      {
        slug: "my-feature",
        repo: "/repo",
        command: ["claude"],
        seed: "s",
        stateDir,
      },
      { spawn, isTTY: true, liveness: aliveProbes },
    );
    expect(result.status).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  it("--force also refuses with the named cannot-reclaim notice", async () => {
    seedState({ pid: 555, procStartedAt: 123 });
    const { spawn, calls } = fakeSpawn({ exitCode: 0 });
    const result = await plainResume(
      {
        slug: "my-feature",
        repo: "/repo",
        command: ["claude"],
        seed: "s",
        stateDir,
      },
      { spawn, isTTY: true, force: true, liveness: aliveProbes },
    );
    expect(result.status).toBe("failed");
    expect(calls).toHaveLength(0);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      PLAIN_RESUME_REFUSAL_NOTICE,
    );
  });

  it("relaunches (no delete-on-fast-fail) when the recorded process is gone", async () => {
    seedState({ pid: 999999, procStartedAt: 1, phase: "implementing" });
    const { spawn, calls } = fakeSpawn({ exitCode: 0, pid: 888 });
    const result = await plainResume(
      {
        slug: "my-feature",
        repo: "/repo",
        command: ["claude"],
        seed: "resume-seed",
        stateDir,
      },
      {
        spawn,
        isTTY: true,
        pidStartEpoch: () => 42,
        liveness: { isAlive: () => false, pidStartEpoch: () => null },
      },
    );
    expect(result.status).toBe("exited");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv.at(-1)).toBe("resume-seed");
    const s = readState("my-feature", stateDir);
    expect(s?.pid).toBe(888);
    expect(s?.launcher).toBe("plain");
  });
});

describe("plainTerminate", () => {
  const base: PipelineState = {
    slug: "x",
    phase: "implementing",
    repo: "/repo",
    updatedAt: nowIso(),
  };

  it("SIGTERMs only on an alive verdict (recycled-PID-safe)", () => {
    const killed: Array<[number, string]> = [];
    const kill = (pid: number, sig: string) => void killed.push([pid, sig]);
    const r = plainTerminate(
      { ...base, pid: 555, procStartedAt: 123 },
      { kill, liveness: { isAlive: () => true, pidStartEpoch: () => 123 } },
    );
    expect(r.terminated).toBe(true);
    expect(killed).toEqual([[555, "SIGTERM"]]);
  });

  it("never signals a recycled or absent pid", () => {
    const kill = vi.fn();
    // unknown: no pid recorded
    expect(plainTerminate(base, { kill }).terminated).toBe(false);
    // dead (recycled): alive pid whose start epoch mismatches the recorded one
    expect(
      plainTerminate(
        { ...base, pid: 555, procStartedAt: 1 },
        {
          kill,
          liveness: { isAlive: () => true, pidStartEpoch: () => 999 },
        },
      ).terminated,
    ).toBe(false);
    // stale: pid no longer alive
    expect(
      plainTerminate(
        { ...base, pid: 555, procStartedAt: 1 },
        {
          kill,
          liveness: { isAlive: () => false, pidStartEpoch: () => null },
        },
      ).terminated,
    ).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("plainAttachHint", () => {
  it("names the slug, the pid, and the resume path", () => {
    const hint = plainAttachHint({
      slug: "my-feature",
      phase: "implementing",
      repo: "/repo",
      pid: 4242,
      updatedAt: nowIso(),
    });
    expect(hint).toContain("my-feature");
    expect(hint).toContain("pid 4242");
    expect(hint).toContain("flow feature resume my-feature");
  });
});
