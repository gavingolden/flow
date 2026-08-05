// Shared type/contract module. Every retry-capable call site in this
// mini-codebase is built against this one shape — a change here ripples
// out to whoever constructs or consumes a RetryPolicy, directly or not.
export type RetryPolicy = {
  maxAttempts: number;
  backoffMs: number;
  retryable: (err: unknown) => boolean;
};

export function isRetryable(policy: RetryPolicy, err: unknown): boolean {
  return policy.retryable(err);
}
