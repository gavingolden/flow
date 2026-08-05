You are scouting a change to a small TypeScript codebase (attached: `src/retry-contract.ts`, `src/retry-runner.ts`, `src/job-queue.ts`, `src/api-client.ts`). No other files exist in this codebase.

## Proposed change

Add a required `signal: AbortSignal` field to `RetryPolicy` in `src/retry-contract.ts`, and thread it through `withRetry` so every retry loop can be cancelled mid-backoff (e.g. `await sleep(policy.backoffMs * attempt, { signal: policy.signal })`, throwing on abort rather than continuing to retry).

## What to produce

Write a scout report with exactly these six sections, in this order:

1. **affected_modules** — every file whose behavior or type-checking is affected by this change, and why.
2. **relevant_tests** — any existing test files a correct implementation would need to touch (there may be none in this fixture — say so explicitly if so, don't invent files).
3. **public_api_surface** — every exported symbol whose signature or contract changes.
4. **open_questions** — anything a real implementer would need to decide before writing code (e.g. what happens to callers that don't have a signal available).
5. **recommended_strategy** — the order you'd make the edits in and why.
6. **anti_patterns** — anything in the current code that this change would make worse, or that the implementer should avoid replicating.

Base every claim on the four attached files only — do not assume any file exists that hasn't been shown to you.
