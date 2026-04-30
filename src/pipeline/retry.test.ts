import { describe, expect, it, vi } from "vitest";
import { retryN, type AttemptResult } from "./retry.js";

describe("retryN", () => {
  it("n = 1 runs once and propagates failure (no implicit retry)", async () => {
    const fn = vi.fn(
      async (_attempt: number, _last?: string): Promise<AttemptResult<string>> => ({
        ok: false,
        error: "boom",
      }),
    );
    const r = await retryN(fn, 1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: false, error: "boom" });
  });

  it("n = 1 returns success after a single invocation", async () => {
    const fn = vi.fn(
      async (_attempt: number): Promise<AttemptResult<number>> => ({
        ok: true,
        value: 42,
      }),
    );
    const r = await retryN(fn, 1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: true, value: 42 });
  });

  it("n = 3 returns the first success and stops invoking fn", async () => {
    const fn = vi.fn(
      async (attempt: number, lastFailure?: string): Promise<AttemptResult<number>> => {
        if (attempt === 1) return { ok: false, error: "first failure" };
        return { ok: true, value: attempt * 10 };
      },
    );
    const r = await retryN(fn, 3);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ ok: true, value: 20 });
    // Attempt 2 receives the prior failure via the lastFailure parameter.
    expect(fn).toHaveBeenNthCalledWith(2, 2, "first failure");
  });

  it("n = 3 with all failures invokes fn exactly 3 times and returns the last error", async () => {
    const fn = vi.fn(
      async (attempt: number, _last?: string): Promise<AttemptResult<string>> => ({
        ok: false,
        error: `failure-${attempt}`,
      }),
    );
    const r = await retryN(fn, 3);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(r).toEqual({ ok: false, error: "failure-3" });
  });

  it("threads the previous failure through lastFailure on each retry", async () => {
    const seen: Array<{ attempt: number; lastFailure?: string }> = [];
    const fn = async (
      attempt: number,
      lastFailure?: string,
    ): Promise<AttemptResult<string>> => {
      seen.push({ attempt, lastFailure });
      if (attempt < 3) return { ok: false, error: `attempt-${attempt}-failed` };
      return { ok: true, value: "done" };
    };
    const r = await retryN(fn, 3);
    expect(r).toEqual({ ok: true, value: "done" });
    expect(seen).toEqual([
      { attempt: 1, lastFailure: undefined },
      { attempt: 2, lastFailure: "attempt-1-failed" },
      { attempt: 3, lastFailure: "attempt-2-failed" },
    ]);
  });
});
