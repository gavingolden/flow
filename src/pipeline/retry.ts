export type AttemptResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

// Run `fn` up to `n` times, threading the previous attempt's `error` through
// `lastFailure` on retries. Returns the first success, or the last failure
// after `n` attempts. `n = 1` runs exactly once with no implicit retry.
export async function retryN<T>(
  fn: (attempt: number, lastFailure?: string) => Promise<AttemptResult<T>>,
  n: number,
): Promise<AttemptResult<T>> {
  let last: AttemptResult<T> | null = null;
  for (let attempt = 1; attempt <= n; attempt++) {
    const lastFailure = last && !last.ok ? last.error : undefined;
    last = await fn(attempt, lastFailure);
    if (last.ok) return last;
  }
  return last as AttemptResult<T>;
}
