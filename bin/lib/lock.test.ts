import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LockTimeoutError,
  resolveLaunchConcurrency,
  withFileLock,
  withTestSemaphore,
} from "./lock";

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
  it("runs fn and releases the lock so a second call can acquire it", async () => {
    let runs = 0;
    const r1 = await withFileLock(lockPath, () => {
      runs++;
      expect(fs.existsSync(lockPath)).toBe(true);
      return "first";
    });
    expect(fs.existsSync(lockPath)).toBe(false);
    const r2 = await withFileLock(lockPath, () => {
      runs++;
      return "second";
    });
    expect(r1).toBe("first");
    expect(r2).toBe("second");
    expect(runs).toBe(2);
  });

  it("releases the lock even when fn throws", async () => {
    await expect(
      withFileLock(lockPath, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("creates the parent directory if it does not exist", async () => {
    const nested = path.join(scratch, "a", "b", "c", "deep.lock");
    await withFileLock(nested, () => undefined);
    expect(fs.existsSync(path.dirname(nested))).toBe(true);
  });

  it("times out when another live process holds the lock", async () => {
    fs.writeFileSync(lockPath, String(process.pid));
    await expect(
      withFileLock(lockPath, () => undefined, { timeoutMs: 200, pollMs: 50 }),
    ).rejects.toThrow(LockTimeoutError);
    fs.unlinkSync(lockPath);
  });

  it("reclaims a stale lock left by a dead process", async () => {
    const deadPid = pickDeadPid();
    fs.writeFileSync(lockPath, String(deadPid));
    let ran = false;
    await withFileLock(lockPath, () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("reclaims a lock with garbage contents", async () => {
    fs.writeFileSync(lockPath, "not-a-number");
    let ran = false;
    await withFileLock(lockPath, () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("does not publish the lock file in an empty state (atomic-publish via link)", async () => {
    // Regression: previously tryAcquire openSync'd the lock with "wx" then
    // wrote the PID after, leaving a microsecond window where the file was
    // observable to a peer's reclaimIfStale as empty content. Number("") is
    // 0, which tripped the "garbage contents" branch and unlinked the
    // in-flight lock — letting both processes "hold" it. The fix writes the
    // PID into a per-PID temp file and link()s it onto the lock path, so
    // the lock never exists in an empty state.
    //
    // We can't reliably reproduce the race window in a unit test, but we
    // can verify the post-condition: the published lock file always has
    // the PID written into it, never empty.
    await withFileLock(lockPath, () => {
      const contents = fs.readFileSync(lockPath, "utf8");
      expect(contents).toBe(String(process.pid));
    });
  });

  it("serializes nested holds: a non-recursive lock blocks itself if held", async () => {
    // Confirms the lock is process-aware, not thread-local: holding it twice
    // in the same process from a re-entered call would self-deadlock until
    // the timeout, so an inner withFileLock must throw rather than nest.
    const result = await withFileLock(lockPath, async () => {
      try {
        await withFileLock(lockPath, () => undefined, {
          timeoutMs: 100,
          pollMs: 25,
        });
        return "no-error";
      } catch (e) {
        if (e instanceof LockTimeoutError) return "timed-out";
        throw e;
      }
    });
    expect(result).toBe("timed-out");
  });

  it("holds the lock for the full duration of an async fn (does not release before the promise settles)", async () => {
    // Regression guard: the lock must be held until the async callback's
    // promise resolves, not released the instant withFileLock's own
    // synchronous body returns. Assert directly on the lock file's lifetime
    // around the single in-flight call, per the acceptance criteria's first
    // suggested technique.
    const order: string[] = [];

    const first = withFileLock(lockPath, async () => {
      order.push("start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("end");
      return "first";
    });

    // tryAcquire runs synchronously before fn's first await surfaces, so the
    // lock must already be held immediately after calling withFileLock —
    // before this test ever awaits `first`.
    expect(fs.existsSync(lockPath)).toBe(true);

    // Still held partway through the async delay: releasing early would show
    // up as the lock file disappearing before "end" is recorded.
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(order).toEqual(["start"]);

    const result = await first;
    expect(result).toBe("first");
    expect(order).toEqual(["start", "end"]);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe(withTestSemaphore, () => {
  const K = 2;

  function slotPath(i: number): string {
    return path.join(scratch, `slot-${i}`);
  }

  it("falls through unthrottled when all K slots are held by live pids", () => {
    // Pre-fill all K slots with THIS process's (live) pid so reclaimIfStale
    // won't free them — forcing the never-block-a-commit fall-through with a
    // short timeout. fn still runs; throttled is false (held no slot).
    for (let i = 0; i < K; i++) {
      fs.writeFileSync(slotPath(i), String(process.pid));
    }
    let ran = false;
    const { result, throttled } = withTestSemaphore(
      scratch,
      K,
      () => {
        ran = true;
        return "fell-through";
      },
      { timeoutMs: 200, pollMs: 25 },
    );
    expect(ran).toBe(true);
    expect(throttled).toBe(false);
    expect(result).toBe("fell-through");
  });

  it("acquires a slot (throttled:true) once one is freed", () => {
    for (let i = 0; i < K; i++) {
      fs.writeFileSync(slotPath(i), String(process.pid));
    }
    fs.unlinkSync(slotPath(0));
    let ran = false;
    const { throttled } = withTestSemaphore(
      scratch,
      K,
      () => {
        ran = true;
      },
      { timeoutMs: 200, pollMs: 25 },
    );
    expect(ran).toBe(true);
    expect(throttled).toBe(true);
  });

  it("holds K slots simultaneously and denies the K+1th (true counting)", () => {
    // The counting property the PR advertises: K holders fit at once, the
    // (K+1)th falls through. Nested acquisitions (mirroring the withFileLock
    // nested-hold test above) hold their slots LIVE across the inner call,
    // so this proves SIMULTANEOUS holding — it would fail with slots=1,
    // unlike a sequential-acquire loop that releases each slot before the
    // next.
    const outer = withTestSemaphore(scratch, K, () => {
      // First holder won a slot; one slot file must now exist on disk.
      const heldAfterOuter = [0, 1].filter((i) =>
        fs.existsSync(slotPath(i)),
      ).length;
      expect(heldAfterOuter).toBe(1);

      const inner = withTestSemaphore(
        scratch,
        K,
        () => {
          // Both slots held at once: the inner call won the SECOND distinct
          // slot while the outer still holds its own.
          expect(fs.existsSync(slotPath(0))).toBe(true);
          expect(fs.existsSync(slotPath(1))).toBe(true);

          // A third nested acquire with both slots live must fall through
          // (throttled:false) rather than block — never block a commit.
          const third = withTestSemaphore(scratch, K, () => "third-ran", {
            timeoutMs: 100,
            pollMs: 25,
          });
          expect(third.throttled).toBe(false);
          expect(third.result).toBe("third-ran");
          return "inner-ran";
        },
        { timeoutMs: 200, pollMs: 25 },
      );
      expect(inner.throttled).toBe(true);
      expect(inner.result).toBe("inner-ran");
      return "outer-ran";
    });
    expect(outer.throttled).toBe(true);
    expect(outer.result).toBe("outer-ran");
    // Both slots released after the outer call returns.
    expect(fs.existsSync(slotPath(0))).toBe(false);
    expect(fs.existsSync(slotPath(1))).toBe(false);
  });

  it("removes the won slot file after fn returns", () => {
    withTestSemaphore(scratch, K, () => undefined, {
      timeoutMs: 200,
      pollMs: 25,
    });
    // The only slot the call could have won is slot-0 (first free); finally
    // must have removed it.
    expect(fs.existsSync(slotPath(0))).toBe(false);
  });

  it("removes the won slot file even when fn throws (finally-release)", () => {
    expect(() =>
      withTestSemaphore(
        scratch,
        K,
        () => {
          throw new Error("boom");
        },
        { timeoutMs: 200, pollMs: 25 },
      ),
    ).toThrow("boom");
    // No slot file should leak for the holder that won (and then threw).
    expect(fs.existsSync(slotPath(0))).toBe(false);
  });

  it("reclaims slots held by dead pids and acquires throttled:true", () => {
    const deadPid = pickDeadPid();
    // Every slot path exists on disk but holds a guaranteed-dead pid, so the
    // stale-reclaim path must free one and let acquire succeed.
    for (let i = 0; i < K; i++) {
      fs.writeFileSync(slotPath(i), String(deadPid));
    }
    let ran = false;
    const { throttled } = withTestSemaphore(
      scratch,
      K,
      () => {
        ran = true;
      },
      { timeoutMs: 200, pollMs: 25 },
    );
    expect(ran).toBe(true);
    expect(throttled).toBe(true);
  });

  it("reclaims slots with garbage (non-numeric) contents", () => {
    for (let i = 0; i < K; i++) {
      fs.writeFileSync(slotPath(i), "not-a-number");
    }
    let ran = false;
    const { throttled } = withTestSemaphore(
      scratch,
      K,
      () => {
        ran = true;
      },
      { timeoutMs: 200, pollMs: 25 },
    );
    expect(ran).toBe(true);
    expect(throttled).toBe(true);
  });
});

describe(resolveLaunchConcurrency, () => {
  it("defaults to 4 when FLOW_LAUNCH_CONCURRENCY is unset", () => {
    expect(resolveLaunchConcurrency({})).toBe(4);
  });

  it("honors a valid FLOW_LAUNCH_CONCURRENCY override", () => {
    expect(resolveLaunchConcurrency({ FLOW_LAUNCH_CONCURRENCY: "7" })).toBe(7);
    expect(resolveLaunchConcurrency({ FLOW_LAUNCH_CONCURRENCY: "1" })).toBe(1);
  });

  it("falls back to the default for empty / non-numeric / sub-1 values", () => {
    expect(resolveLaunchConcurrency({ FLOW_LAUNCH_CONCURRENCY: "" })).toBe(4);
    expect(resolveLaunchConcurrency({ FLOW_LAUNCH_CONCURRENCY: "   " })).toBe(
      4,
    );
    expect(resolveLaunchConcurrency({ FLOW_LAUNCH_CONCURRENCY: "abc" })).toBe(
      4,
    );
    expect(resolveLaunchConcurrency({ FLOW_LAUNCH_CONCURRENCY: "0" })).toBe(4);
    expect(resolveLaunchConcurrency({ FLOW_LAUNCH_CONCURRENCY: "-3" })).toBe(4);
    expect(resolveLaunchConcurrency({ FLOW_LAUNCH_CONCURRENCY: "2.5" })).toBe(
      4,
    );
  });

  it("never returns below 1 (min slot count)", () => {
    expect(resolveLaunchConcurrency({})).toBeGreaterThanOrEqual(1);
    expect(
      resolveLaunchConcurrency({ FLOW_LAUNCH_CONCURRENCY: "9" }),
    ).toBeGreaterThanOrEqual(1);
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
