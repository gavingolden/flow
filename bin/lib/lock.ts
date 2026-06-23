/**
 * Cross-process file lock with stale-PID detection, plus a counting
 * semaphore (`withTestSemaphore`) built on the same primitives.
 *
 * Why: `flow setup --upgrade` invoked concurrently from parallel pipelines
 * can race on `~/.claude/skills/` symlinks. Wrap the symlink-creation block
 * in `withFileLock(SETUP_LOCK_PATH, ...)` and the second invocation waits
 * for the first to finish. `withTestSemaphore` reuses the same atomic
 * publish + stale-reclaim path to cap host-wide concurrent test runs.
 *
 * How: `fs.openSync(path, "wx")` is atomic-create-or-fail on POSIX. If the
 * lock exists, read the PID inside; if the process is dead (`process.kill(pid, 0)`
 * throws ESRCH), reclaim. Otherwise sleep `pollMs` and retry until `timeoutMs`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { sleepSync } from "./sleep";

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

export function withFileLock<T>(
  lockPath: string,
  fn: () => T,
  opts: LockOptions = {},
): T {
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

/**
 * Counting semaphore over K slot files in `dir`, built on the same
 * stale-PID-safe primitives as `withFileLock` (tryAcquire / release /
 * reclaimIfStale). Each slot is an independent lock file
 * `dir/slot-<i>`; a caller wins by acquiring ANY one slot.
 *
 * Why a separate entry point rather than reusing `withFileLock`: the
 * semaphore must NEVER block a commit. On acquire-deadline it does NOT
 * throw — it runs `fn()` holding no slot and reports `throttled: false`
 * (over-subscribed but unblocked). `withFileLock` stays the K=1
 * throw-on-timeout sibling, untouched.
 */
export function withTestSemaphore<T>(
  dir: string,
  slots: number,
  fn: () => T,
  opts: LockOptions = {},
): { result: T; throttled: boolean } {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const pollMs = opts.pollMs ?? 100;
  const start = Date.now();

  fs.mkdirSync(dir, { recursive: true });

  const slotPaths = Array.from({ length: slots }, (_, i) =>
    path.join(dir, `slot-${i}`),
  );

  while (true) {
    for (const slotPath of slotPaths) {
      if (tryAcquire(slotPath)) {
        try {
          return { result: fn(), throttled: true };
        } finally {
          release(slotPath);
        }
      }
    }
    // Reclaim any stale slots before checking the deadline so a dir full
    // of dead-PID slots is freed and re-attempted in the next loop pass.
    let reclaimedAny = false;
    for (const slotPath of slotPaths) {
      if (reclaimIfStale(slotPath)) reclaimedAny = true;
    }
    if (reclaimedAny) continue;
    if (Date.now() - start >= timeoutMs) {
      // Never block a commit: run unthrottled, holding no slot.
      return { result: fn(), throttled: false };
    }
    sleepSync(pollMs);
  }
}

function tryAcquire(lockPath: string): boolean {
  try {
    // Atomic publish: write the PID into a per-PID temp file, then link()
    // it onto lockPath. link() is atomic-create-or-fail on POSIX, so the
    // lock file is never observable to another process in an empty state.
    // Without this, a peer's reclaimIfStale that races between our open()
    // and our write() reads "" → Number("") === 0 → "garbage" branch and
    // unlinks our lock mid-acquire, letting both processes "hold" it.
    const tmpPath = `${lockPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, String(process.pid));
    try {
      fs.linkSync(tmpPath, lockPath);
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* best-effort cleanup */
      }
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
    release(lockPath);
    return true;
  }
  if (isProcessAlive(pid)) return false;
  release(lockPath);
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
