import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockTimeoutError, withFileLock } from "./lock";

let scratch!: string;
let lockPath!: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-lock-"));
  lockPath = path.join(scratch, "test.lock");
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe(withFileLock, () => {
  it("runs fn and releases the lock so a second call can acquire it", () => {
    let runs = 0;
    const r1 = withFileLock(lockPath, () => {
      runs++;
      expect(fs.existsSync(lockPath)).toBe(true);
      return "first";
    });
    expect(fs.existsSync(lockPath)).toBe(false);
    const r2 = withFileLock(lockPath, () => {
      runs++;
      return "second";
    });
    expect(r1).toBe("first");
    expect(r2).toBe("second");
    expect(runs).toBe(2);
  });

  it("releases the lock even when fn throws", () => {
    expect(() =>
      withFileLock(lockPath, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("creates the parent directory if it does not exist", () => {
    const nested = path.join(scratch, "a", "b", "c", "deep.lock");
    withFileLock(nested, () => undefined);
    expect(fs.existsSync(path.dirname(nested))).toBe(true);
  });

  it("times out when another live process holds the lock", () => {
    fs.writeFileSync(lockPath, String(process.pid));
    expect(() =>
      withFileLock(lockPath, () => undefined, { timeoutMs: 200, pollMs: 50 }),
    ).toThrow(LockTimeoutError);
    fs.unlinkSync(lockPath);
  });

  it("reclaims a stale lock left by a dead process", () => {
    const deadPid = pickDeadPid();
    fs.writeFileSync(lockPath, String(deadPid));
    let ran = false;
    withFileLock(lockPath, () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("reclaims a lock with garbage contents", () => {
    fs.writeFileSync(lockPath, "not-a-number");
    let ran = false;
    withFileLock(lockPath, () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("serializes nested holds: a non-recursive lock blocks itself if held", () => {
    // Confirms the lock is process-aware, not thread-local: holding it twice
    // in the same process from a re-entered call would self-deadlock until
    // the timeout, so an inner withFileLock must throw rather than nest.
    const result = withFileLock(lockPath, () => {
      try {
        withFileLock(lockPath, () => undefined, { timeoutMs: 100, pollMs: 25 });
        return "no-error";
      } catch (e) {
        if (e instanceof LockTimeoutError) return "timed-out";
        throw e;
      }
    });
    expect(result).toBe("timed-out");
  });
});

function pickDeadPid(): number {
  // PIDs above the kernel's max are guaranteed not to map to a live process.
  // Most Linux defaults are 32768 or 4194304; macOS caps around 99999. 999999
  // is safe across both for a "definitely dead" sentinel.
  for (const candidate of [999999, 998123, 987654]) {
    try {
      process.kill(candidate, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("could not find a dead PID for the test");
}
