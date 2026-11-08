import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBackgroundWorktreeSweep } from "./worktree-sweep-launch";
import { WORKTREE_SWEEP_THROTTLE_MS, writeStamp } from "./worktree-sweep-state";

let stateDir: string;
const NOW = 1_800_000_000_000;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-launch-"));
});
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

function fakeSpawn() {
  const child = { unref: vi.fn(), on: vi.fn() };
  return { spawn: vi.fn(() => child) as never, child };
}

const base = () => ({ stateDir, nowMs: () => NOW, isBun: true });

describe("startBackgroundWorktreeSweep", () => {
  it("spawns a detached silent child without the pipeline identity and never waits for it", () => {
    const { spawn, child } = fakeSpawn();

    const r = startBackgroundWorktreeSweep({
      ...base(),
      spawn,
      readConfig: () => undefined,
      env: { FLOW_SLUG: "parent", TMUX_PANE: "%1", PATH: "/bin" },
      cwd: "/launch/dir",
    });

    expect(r).toBe("spawned");
    const [cmd, args, opts] = (spawn as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(args.slice(1)).toEqual(["reap", "--worktrees", "--yes", "--auto"]);
    expect(path.basename(args[0])).toBe("flow");
    expect(opts).toMatchObject({
      detached: true,
      stdio: "ignore",
      cwd: "/launch/dir",
    });
    expect(opts.env).toEqual({ PATH: "/bin" });
    expect(child.unref).toHaveBeenCalled();
  });

  it("does not spawn when cleanup.worktrees is false", () => {
    const { spawn } = fakeSpawn();
    const r = startBackgroundWorktreeSweep({
      ...base(),
      spawn,
      readConfig: () => ({ cleanup: { worktrees: false } }),
    });
    expect(r).toBe("disabled");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not spawn when a sweep started under an hour ago, and spawns again after", () => {
    writeStamp(NOW - 10 * 60_000, stateDir);
    const { spawn } = fakeSpawn();
    const deps = { ...base(), spawn, readConfig: () => undefined };
    expect(startBackgroundWorktreeSweep(deps)).toBe("throttled");
    expect(spawn).not.toHaveBeenCalled();

    expect(
      startBackgroundWorktreeSweep({
        ...deps,
        nowMs: () => NOW + WORKTREE_SWEEP_THROTTLE_MS,
      }),
    ).toBe("spawned");
  });

  it("is a no-op outside Bun", () => {
    const { spawn } = fakeSpawn();
    expect(
      startBackgroundWorktreeSweep({ ...base(), isBun: false, spawn }),
    ).toBe("unavailable");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("never throws when the spawn itself fails", () => {
    const spawn = vi.fn(() => {
      throw new Error("EAGAIN");
    }) as never;
    expect(
      startBackgroundWorktreeSweep({
        ...base(),
        spawn,
        readConfig: () => undefined,
      }),
    ).toBe("unavailable");
  });
});
