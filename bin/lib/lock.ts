/**
 * Cross-process file lock with stale-PID detection.
 *
 * Why: `flow setup --upgrade` invoked concurrently from parallel pipelines
 * can race on `~/.claude/skills/` symlinks. Wrap the symlink-creation block
 * in `withFileLock(SETUP_LOCK_PATH, ...)` and the second invocation waits
 * for the first to finish.
 *
 * How: `fs.openSync(path, "wx")` is atomic-create-or-fail on POSIX. If the
 * lock exists, read the PID inside; if the process is dead (`process.kill(pid, 0)`
 * throws ESRCH), reclaim. Otherwise sleep `pollMs` and retry until `timeoutMs`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type LockOptions = {
  /** Total time to wait for the lock before throwing. Default 30000 (30s). */
  timeoutMs?: number;
  /** Sleep between retries. Default 100. */
  pollMs?: number;
};

export class LockTimeoutError extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(`could not acquire lock at ${lockPath} within ${timeoutMs}ms`);
    this.name = "LockTimeoutError";
  }
}

export function withFileLock<T>(lockPath: string, fn: () => T, opts: LockOptions = {}): T {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 100;
  const start = Date.now();

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    const acquired = tryAcquire(lockPath);
    if (acquired) {
      try {
        return fn();
      } finally {
        release(lockPath);
      }
    }
    if (reclaimIfStale(lockPath)) continue;
    if (Date.now() - start >= timeoutMs) {
      throw new LockTimeoutError(lockPath, timeoutMs);
    }
    sleepSync(pollMs);
  }
}

function tryAcquire(lockPath: string): boolean {
  try {
    const fd = fs.openSync(lockPath, "wx");
    try {
      fs.writeSync(fd, String(process.pid));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

function release(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // best-effort: another caller may have already reclaimed a stale lock.
  }
}

function reclaimIfStale(lockPath: string): boolean {
  let pid: number;
  try {
    pid = Number(fs.readFileSync(lockPath, "utf8").trim());
  } catch {
    // lock file vanished between EEXIST and read — caller will retry tryAcquire
    return true;
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    // garbage contents — treat as stale
    try { fs.unlinkSync(lockPath); } catch { /* race with another reclaimer */ }
    return true;
  }
  if (isProcessAlive(pid)) return false;
  try { fs.unlinkSync(lockPath); } catch { /* race with another reclaimer */ }
  return true;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw e;
  }
}

function sleepSync(ms: number): void {
  // Bun and Node both expose Atomics.wait on a SharedArrayBuffer view as
  // a sync sleep with no spawn. spawnSync sleep would also work but adds
  // a process-fork tax per poll iteration.
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}
