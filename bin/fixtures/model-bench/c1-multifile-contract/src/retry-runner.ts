// Producer: implements the RetryPolicy contract (withRetry) and ships the
// one default instance most callers reach for.
import { isRetryable, type RetryPolicy } from "./retry-contract";

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: 200,
  retryable: (err) => err instanceof Error && err.message !== "fatal",
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(policy, err) || attempt === policy.maxAttempts) {
        throw err;
      }
      await sleep(policy.backoffMs * attempt);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Generic helper: lets a caller build a retrying wrapper around ANY async
// function without ever importing RetryPolicy itself — the coupling to the
// contract lives entirely in the `P extends RetryPolicy` constraint, not in
// the caller's import list. This is the indirection hop: a caller of
// makeRetrying is bound to the contract's shape without naming it.
export function makeRetrying<
  Args extends unknown[],
  T,
  P extends RetryPolicy = RetryPolicy,
>(fn: (...args: Args) => Promise<T>, policy?: P): (...args: Args) => Promise<T> {
  return (...args: Args) =>
    withRetry(() => fn(...args), policy ?? DEFAULT_RETRY_POLICY);
}
