import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export interface RespawnDetachedResult {
  pid: number | undefined;
  logPath: string;
}

// The detached child's `createLogger` reads this env var to append to the
// pre-opened log file rather than opening a second one with a slightly
// later stamp. Exported so `runCommand` can read the same env name on the
// child side without duplicating the literal — a drift here would silently
// break the parent/child log sharing the fd-inheritance contract relies on.
export const FLOW_LOG_PATH_ENV = "FLOW_LOG_PATH";

export interface RespawnDetachedDeps {
  spawnFn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
}

// Spawns `flow run <taskId>` as a detached process tree, inheriting a
// pre-opened log fd to runs/<taskId>-<stamp>.log so the caller can print
// the log path immediately. Lifted from the body of `detachAndExit` in
// src/commands/run.ts so `flow approve` and `flow revise` can reuse the
// exact same spawn shape (including fd-inherited logging) without
// duplicating the contract.
export async function respawnDetached(
  taskId: string,
  repoRoot: string,
  deps: RespawnDetachedDeps = {},
): Promise<RespawnDetachedResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeTaskId = taskId.replace(/[^A-Za-z0-9._-]/g, "_");
  const runsDir = path.join(repoRoot, ".orchestrator", "runs");
  await fsp.mkdir(runsDir, { recursive: true });
  const logPath = path.join(runsDir, `${safeTaskId}-${stamp}.log`);
  const logFd = fs.openSync(logPath, "a");
  const entry = process.argv[1];
  if (!entry) {
    throw new Error("respawnDetached: process.argv[1] missing — cannot re-exec");
  }
  const spawnFn = deps.spawnFn ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnFn(
      process.execPath,
      [...process.execArgv, entry, "run", taskId],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        cwd: repoRoot,
        env: { ...process.env, [FLOW_LOG_PATH_ENV]: logPath },
      },
    );
  } catch (err) {
    // The spawn never inherited the fd, so the parent's open copy is the
    // only reference — leak it and any failure path (ENOENT on
    // process.execPath, EACCES, ulimit) accumulates descriptors over the
    // life of the process.
    try { fs.closeSync(logFd); } catch {}
    throw err;
  }
  child.unref?.();
  // Close the parent's copy of the fd so the parent's exit doesn't keep
  // the file open beyond when the child wants to fsync/rotate. The
  // child's own fd (inherited via stdio) keeps the file alive.
  try { fs.closeSync(logFd); } catch {}
  return { pid: child.pid, logPath };
}
