# Bug-Detection Review Checklist

Checks for the **bug-detection** lens. Soft cap: ~150 lines — condense, merge duplicates, or
move consumer-specific entries to `docs/consumer-review-patterns.md` before adding new
entries. New entries are captured via `flow-pr-review/SKILL.md` step 5 ("Capture the gap") —
see that step for the two-destination contract; never edit this file outside that flow.

---

## Error Handling

Verify error paths produce meaningful outcomes, not just get caught. Look for: empty `catch`
blocks or ones that only `console.error`, error boundaries with no user-facing recovery UI,
async functions without `.catch()`/try-catch, and re-thrown errors that lose the original
cause (no `{ cause }`). For each catch: does it surface the error to the user or a monitoring
system, and does a re-throw preserve `{ cause: originalError }`?

## Type Safety

Look for `as` assertions (especially `as any`), non-null assertions (`!`), and
`// @ts-ignore`/`@ts-expect-error` without explanation. Check whether the assertion can be
replaced with a type guard or narrowing, and whether an unavoidable assertion carries a
comment explaining why.

## Lifecycle / Cleanup

Module-level side effects (event listeners, intervals, subscriptions) need cleanup on
teardown or hot-reload, or re-execution registers duplicate handlers. Look for:
`addEventListener`/`setInterval` outside a component effect hook, `.subscribe()` calls at
module scope, and singleton classes instantiated at module scope. For each: is there a
matching `removeEventListener`/`clearInterval`/`unsubscribe`, and for module-level
singletons, a dispose hook wired to the reload mechanism (e.g. `import.meta.hot.dispose()`)?
**General rule:** every module-level `addEventListener` needs a matching dispose hook; every
component-level one needs a cleanup return in its effect.

## Granularity Mismatch Between Producer and Consumer

When a refactor changes the granularity of a piece of data (one entry per X becomes one
entry per Y), every downstream consumer deriving a parallel list from the same source must
move to the new granularity, or the two sides diverge silently (mismatched name set, length,
order). Grep the whole repo — not just the diff — for consumers of the _old_ shape,
including cross-file consumers (formatters, comparison logic) that reference the changed
producer. Pay special attention to code comparing "what should be visible" against "what is
rendered" — these silently mis-correlate when the two sides drift.

## Retry Wrappers Around Non-Idempotent Operations

A generic retry wrapper (`retryOnce`, `withBackoff`) is safe only when the wrapped operation
is idempotent. If the first attempt may already have produced an externally visible side
effect (opened a PR, posted a comment, mutated remote state), a second attempt can corrupt
that state instead of recovering from a transient failure. Audit the wrapped function for
non-idempotent side effects; verify either the operation short-circuits on existing state, or
the retry is conditioned on failure classes that pre-date the side effect. On crash-recovery
paths, branch on "did the side effect already happen?" before retrying.

## Subprocess Wrapper Non-Throwing Contracts

A function whose return type encodes both success and failure (`{ ok, output }`,
`Result<T, E>`) implies callers don't need try/catch — but underlying primitives (`execa`,
`fetch`, `fs/promises`) can still throw on timeout, abort, spawn failure, or network error.
`execa(..., { reject: false })` suppresses non-zero exit codes but **not** timeout/EPIPE/spawn
failures. Trace each underlying primitive for throw conditions and confirm they land in a
try/catch that maps onto the failure variant, preserving captured stdout/stderr.

## Error-Message Portability in Cross-Context Code

Code that ships from one repo and runs against another (a CLI invoked in consumer projects, a
symlinked script) must produce diagnostics that make sense from the target's frame of
reference — no producer-repo file paths, internal script names, or producer-specific
remediation hints. Grep cross-context diagnostics for producer-repo paths and rewrite each in
target-repo terms, describing the missing capability rather than the producer's
implementation.

## Single Error Message Hiding Two Root Causes

A helper returning `string | null` where `null` collapses ≥2 distinct user-actionable causes
(e.g. "tool missing from PATH" vs. "tool ran but wrong context") gives the caller one message
that's wrong for at least one cause. Often paired with a dead `try/catch` around
`spawnSync` — it doesn't throw on ENOENT, it returns `r.error.code === "ENOENT"`, so check
that field directly, not the catch. Fix: replace the boolean `null` with a discriminated
union (`{ kind: "ok" | "tool-missing" | "wrong-cwd" }`) and let the call site branch on the
cause.

## Replacement-String Metacharacter Expansion in `String.prototype.replace`

When externally-sourced text becomes the _replacement_ argument to a string-form
`.replace(...)`, the engine interprets `$&`, `$1`-`$99`, `$$`, `` $` ``, `$'` as substitution
patterns — a literal occurrence in the input is silently rewritten. Grep the diff for
`.replace(` calls; trace any interpolated replacement-string variable back to its source. If
it can carry user- or file-supplied text, switch to a function replacer
(`replace(re, () => value)`) — always safe, and verify by feeding a literal `$&` through the
path.

## Doc/Wire Mismatch On Optional Fields

A type spec saying `field: T | null` doesn't guarantee the runtime emits `null` for the
absent case — many helpers omit the field entirely on some exit path, so the wire JSON
carries `undefined` while consumers write `x.field === null` checks. Grep every
result-construction site to confirm each sets the documented value (including explicit
`null`), and check test assertions: `toBeUndefined()` next to a doc that says `null` is the
smoking gun. Align the wire shape to the docs (preferred) and update the test in the same
commit.

## path.join With Absolute Segment Discards the Base

`path.join(BASE, p)` with a leading-slash `p` does not anchor under BASE the way authors
assume, and `path.resolve(BASE, p)` with absolute `p` discards BASE entirely. Hand-rolled
static file servers routinely pass URL pathnames (always leading-`/`) into these helpers —
the failure is serving from the wrong root, or a `startsWith(BASE)` check that always fails.
Trace the exact string handed to `join`/`resolve`; confirm a containment check passes for a
known-good path AND fails for `../` traversal, both with concrete strings — never hand a
leading-slash pathname to `join`/`resolve` without stripping/relativizing first.

## `??` Fallback That Trivially Satisfies a Loop's Termination Condition (PR #447)

A pagination/accumulation loop that derives its bound from an API field with a
null-coalescing fallback onto the accumulator itself
(`const total = body.total_count ?? all.length`) makes the termination condition vacuously
true on the first iteration — silently truncating the walk when the field is absent. Look
for `?? <accumulator>.length` (or `?? 0`, `?? count`) feeding a
`while (acc.length < total)`-style bound; require a hard failure on the missing field or an
explicit short-page heuristic, and check the doc comment matches the implemented
termination rule.
