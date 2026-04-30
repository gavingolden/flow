export type AttemptResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

// Run `fn` up to `n` times, threading the previous attempt's `error` through
// `lastFailure` on retries. Returns the first success, or the last failure
// after `n` attempts. `n = 1` runs exactly once with no implicit retry.
//
// `n` must be a positive integer. The signature claims to always return an
// `AttemptResult<T>`; with `n <= 0` the loop never runs and we'd return
// `null` masquerading as the result type, breaking the contract for any
// caller that branches on `.ok`. Throw eagerly so the misuse surfaces at
// the call site rather than as a downstream "cannot read properties of
// null" inside whichever branch the orchestrator was about to take.
export async function retryN<T>(
  fn: (attempt: number, lastFailure?: string) => Promise<AttemptResult<T>>,
  n: number,
): Promise<AttemptResult<T>> {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`retryN: n must be a positive integer, got ${n}`);
  }
  let last: AttemptResult<T> = { ok: false, error: "retryN: no attempt ran" };
  for (let attempt = 1; attempt <= n; attempt++) {
    const lastFailure = last.ok ? undefined : last.error;
    last = await fn(attempt, attempt === 1 ? undefined : lastFailure);
    if (last.ok) return last;
  }
  return last;
}
