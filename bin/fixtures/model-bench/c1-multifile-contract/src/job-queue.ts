// Consumer A: constructs its own RetryPolicy literal and imports the
// contract type directly — the straightforward, grep-discoverable coupling.
import { withRetry } from "./retry-runner";
import type { RetryPolicy } from "./retry-contract";

const AGGRESSIVE_POLICY: RetryPolicy = {
  maxAttempts: 5,
  backoffMs: 50,
  retryable: () => true,
};

export async function processJob(job: () => Promise<void>): Promise<void> {
  await withRetry(job, AGGRESSIVE_POLICY);
}
