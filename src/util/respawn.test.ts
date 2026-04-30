import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { respawnDetached } from "./respawn.js";

interface FakeSpawn {
  command: string;
  args: readonly string[];
  options: { detached?: boolean; cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown };
}

describe("respawnDetached", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-respawn-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("opens a runs/<task>-<stamp>.log file and returns the path", async () => {
    const calls: FakeSpawn[] = [];
    const fakeSpawn = vi.fn((cmd: string, args: readonly string[], options) => {
      calls.push({ command: cmd, args, options });
      return { pid: 12345, unref: vi.fn() } as unknown as ChildProcess;
    });
    const result = await respawnDetached("2026-04-30-x", tmp, { spawnFn: fakeSpawn });
    expect(result.pid).toBe(12345);
    expect(result.logPath.startsWith(path.join(tmp, ".orchestrator", "runs"))).toBe(true);
    expect(result.logPath).toMatch(/2026-04-30-x-.*\.log$/);
    // The log file was actually opened on disk.
    await expect(fs.access(result.logPath)).resolves.toBeUndefined();
  });

  it("spawns process.execPath with [entry, 'run', taskId] and detached: true", async () => {
    const calls: FakeSpawn[] = [];
    const fakeSpawn = vi.fn((cmd: string, args: readonly string[], options) => {
      calls.push({ command: cmd, args, options });
      return { pid: 7, unref: vi.fn() } as unknown as ChildProcess;
    });
    await respawnDetached("task-x", tmp, { spawnFn: fakeSpawn });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.command).toBe(process.execPath);
    expect(c.args).toContain("run");
    expect(c.args).toContain("task-x");
    expect(c.options.detached).toBe(true);
    expect(c.options.cwd).toBe(tmp);
    // FLOW_LOG_PATH env var carries the log path so the child appends.
    const env = c.options.env as NodeJS.ProcessEnv;
    expect(env?.FLOW_LOG_PATH).toBeDefined();
  });

  it("calls unref() on the spawned child to detach it from the event loop", async () => {
    const unrefMock = vi.fn();
    const fakeSpawn = vi.fn(
      () => ({ pid: 1, unref: unrefMock }) as unknown as ChildProcess,
    );
    await respawnDetached("t", tmp, { spawnFn: fakeSpawn });
    expect(unrefMock).toHaveBeenCalledTimes(1);
  });

  it("sanitises task ids that contain shell-unfriendly chars in the log file name", async () => {
    const fakeSpawn = vi.fn(
      () => ({ pid: 1, unref: vi.fn() }) as unknown as ChildProcess,
    );
    const result = await respawnDetached(
      "weird id/with*chars",
      tmp,
      { spawnFn: fakeSpawn },
    );
    expect(path.basename(result.logPath)).toMatch(/^weird_id_with_chars-/);
  });

  it("closes the pre-opened log fd when spawnFn throws (no descriptor leak on the failure path)", async () => {
    // Spy on closeSync to count exactly how many times the fd is released.
    // The success path closes once (parent's copy after the child inherits);
    // the failure path must also close exactly once (the spawn never
    // happened, so only the parent's copy exists).
    const closeSpy = vi.spyOn(fsSync, "closeSync");
    const spawnError = new Error("ENOENT: synthetic spawn failure");
    const fakeSpawn = vi.fn(() => {
      throw spawnError;
    });

    await expect(
      respawnDetached("task-fail", tmp, { spawnFn: fakeSpawn }),
    ).rejects.toBe(spawnError);

    // closeSync was invoked at least once with a numeric fd (the one
    // openSync returned). Filtering on `typeof === "number"` keeps the
    // assertion robust to incidental closeSync calls from the test runner.
    const fdCloses = closeSpy.mock.calls.filter(
      ([fd]) => typeof fd === "number",
    );
    expect(fdCloses.length).toBeGreaterThanOrEqual(1);
    closeSpy.mockRestore();
  });
});
