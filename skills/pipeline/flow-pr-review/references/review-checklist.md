# Independent Review Checklist

Systematic checks for the independent review step. Walk each category against the changed files.
Not every check applies to every PR — skip categories that don't touch the relevant code.

## Quick Reference

| Category              | Signal to look for                       | What to verify                                           |
| --------------------- | ---------------------------------------- | -------------------------------------------------------- |
| **Security**          | Trust boundaries, user input, auth       | Input validated, secrets absent, injection prevented     |
| **Performance**       | Queries, loops, async, caching           | No N+1, no leaks, appropriate complexity                 |
| **Error Handling**    | try/catch, `.catch()`, boundaries        | All error paths produce meaningful user feedback         |
| **Type Safety**       | `as` casts, `any`, `!` assertions        | Narrowing used instead of assertion where possible       |
| **Consistency**       | Multiple branches handling similar cases | Cross-cutting pattern applied uniformly to all branches  |
| **Lifecycle/Cleanup** | Module-level side effects                | HMR cleanup, unsubscribe, clearInterval                  |
| **Test Environment**  | Tests using browser APIs                 | `@vitest-environment jsdom`, SvelteKit mocks             |
| **Accessibility**     | Interactive elements, custom widgets     | ARIA roles, labels, and state attributes match visual UI |
| **Composition**       | Nested headless UI triggers              | Every trigger uses `child` snippet and forwards props    |

---

# Part 1: Universal Checks

These apply to any codebase, regardless of framework or language.

---

## Security

Code that handles user input, authentication, authorization, or external data needs careful
scrutiny. A single missed validation can become an exploitable vulnerability.

### What to look for

- User input flowing into database queries, shell commands, HTML output, or file paths
- Authentication or authorization checks that could be bypassed
- Hardcoded secrets, API keys, tokens, or passwords in source files
- Sensitive data in logs, error messages, or client-facing responses
- `eval()`, `innerHTML`, `dangerouslySetInnerHTML`, or template literals in SQL
- CORS configuration changes, especially wildcard origins
- File upload handling without type/size/path validation
- Cryptographic operations using weak algorithms or hardcoded keys

### How to check

1. Trace data flow from input to use — is every user-provided value validated and sanitized
   before reaching a sensitive operation?
2. For auth changes: verify the check happens server-side, not just in the UI
3. Search the diff for string literals that look like keys/tokens (high entropy, base64, `sk-`, `pk-`)
4. For SQL: verify parameterized queries are used, not string concatenation
5. For HTML output: verify user content is escaped or rendered through a safe framework API
6. For file operations: verify paths are validated against traversal (`../`)

### Confidence guidance

- Hardcoded secret in source: 95+ (almost always a real issue)
- SQL string concatenation with user input: 90+ (clear injection vector)
- Missing server-side auth check: 85-95 (depends on whether client-side check exists)
- CORS wildcard on a non-public API: 85-90

**General rule:** If user-controlled data reaches a sensitive operation without validation,
that's an `issue (blocking)`. If validation exists but could be stronger, that's a
`suggestion (non-blocking)`.

---

## Performance

Performance issues in hot paths compound quickly. A single N+1 query in a list view can
turn a 50ms page load into a 5-second one.

### What to look for

- Database queries inside loops (N+1 pattern)
- Missing pagination on queries that could return unbounded results
- `addEventListener` / `setInterval` without cleanup (memory leaks)
- Synchronous blocking operations on the main thread or in async contexts
- Unnecessary copies of large data structures (spread on large arrays/objects)
- Sequential awaits that could be parallelized (`Promise.all`)
- Missing or incorrect cache invalidation
- O(n^2) or worse algorithms applied to potentially large datasets

### How to check

1. For each database call in the diff: is it inside a loop? Could it be batched?
2. For list/collection queries: is there a `LIMIT` or pagination mechanism?
3. For event listeners and intervals: is there a corresponding cleanup?
4. For `await` chains: are the operations independent? If so, could they use `Promise.all`?
5. For large data operations: is the algorithm complexity appropriate for the expected data size?

### Confidence guidance

- Query inside a loop with no batching: 90+ (clear N+1)
- Unbounded query on a growing table: 85-90
- Missing cleanup on an interval: 85-90 (leaks over time)
- Sequential awaits on independent operations: 80-85 (perf improvement, not a bug)

**General rule:** Flag concrete, measurable performance issues — not hypothetical slowdowns.
"This loop is O(n^2) over user data that can grow to 10K rows" is actionable. "This could
be slow" is not.

---

## Error Handling

Verify that error paths are not just caught but produce meaningful outcomes.

### What to look for

- Empty `catch` blocks or `catch` blocks that only `console.error`
- Error boundaries without user-facing recovery UI
- Async functions without `.catch()` or try/catch
- Thrown errors that lose the original cause (no `{ cause }` option)

### How to check

1. For each catch: does it surface the error to the user or a monitoring system?
2. For error boundaries: does the fallback UI offer a retry or navigation action?
3. For re-thrown errors: is the original error preserved via `{ cause: originalError }`?

---

## Type Safety

### What to look for

- `as` type assertions, especially `as any`
- Non-null assertions (`!`)
- `// @ts-ignore` or `// @ts-expect-error` without explanation

### How to check

1. Can the assertion be replaced with a type guard or narrowing?
2. If the assertion is necessary, is there a comment explaining why?
3. Does `@ts-expect-error` have a description of the expected error?

---

# Part 2: Project-Specific Checks

These are patterns specific to this project's stack (SvelteKit, bits-ui, Vitest). They were
learned from real PRs and encode hard-won knowledge about subtle failure modes.

---

## Consistency Checks

When code handles multiple cases (switch statements, if-else chains, parallel functions for
different providers/types), verify that cross-cutting patterns are applied uniformly.

### What to look for

- `switch` / `if-else` with 3+ branches
- Multiple functions with the same structure but different types
- Loops or iteration that handle items differently based on type

### How to check

For each cross-cutting behavior (cause-chain walking, retryability, logging, null checks):

1. Confirm it appears in **every** branch, not just some
2. If a branch omits it, determine whether the omission is intentional or accidental
3. If intentional, verify there is a comment explaining why

### Example — cause-chain walking (PR #136)

```typescript
// BAD: FmpError and FredError found via cause chain, but TypeError only
// checked on the outer error. A TypeError wrapped in a cause chain is missed.
while (current) {
  if (current instanceof FmpError) { ... }   // cause-chain ✓
  if (current instanceof FredError) { ... }  // cause-chain ✓
}
if (error instanceof TypeError) { ... }      // cause-chain ✗ (only outer)

// GOOD: TypeError check moved inside the same cause-chain loop.
while (current) {
  if (current instanceof FmpError) { ... }
  if (current instanceof FredError) { ... }
  if (current instanceof TypeError) { ... }  // cause-chain ✓
  current = current.cause;
}
```

**General rule:** If N-1 of N branches use a pattern, the Nth branch probably should too.

---

## Lifecycle / Cleanup

Module-level side effects (event listeners, intervals, subscriptions) in SvelteKit need HMR
cleanup. Without it, hot-reloading re-executes the module and registers duplicate handlers.

### What to look for

- `window.addEventListener` / `document.addEventListener` outside a component `$effect`
- `setInterval` / `setTimeout` at module scope or in singleton constructors
- `.subscribe()` calls on stores or observables in module-level code
- Singleton classes instantiated at module scope

### How to check

For each side effect found:

1. Is there a corresponding removal? (`removeEventListener`, `clearInterval`, `unsubscribe`)
2. For module-level singletons: is there an `import.meta.hot.dispose()` block?
3. For component code: does `$effect` return a cleanup function?

### Example — missing HMR cleanup (PR #136)

```typescript
// BAD: Singleton registers listeners but HMR re-executes the module,
// creating duplicate listeners on each hot reload.
class NetworkStatus {
  constructor() {
    window.addEventListener("online", ...);
    window.addEventListener("offline", ...);
  }
}
export const networkStatus = new NetworkStatus();

// GOOD: AbortController + import.meta.hot.dispose
const controller = new AbortController();

class NetworkStatus {
  constructor() {
    window.addEventListener("online", ..., { signal: controller.signal });
    window.addEventListener("offline", ..., { signal: controller.signal });
  }
}
export const networkStatus = new NetworkStatus();

if (import.meta.hot) {
  import.meta.hot.dispose(() => controller.abort());
}
```

**General rule:** Every module-level `addEventListener` needs an `import.meta.hot.dispose`.
Every component-level `addEventListener` needs a cleanup return in `$effect`.

---

## Test Environment

Tests that use browser APIs need the correct Vitest environment and SvelteKit module mocks.
Missing these causes cryptic failures or false passes.

### What to look for

- Test files that import code using `window`, `navigator`, `document`, `fetch`,
  `matchMedia`, `localStorage`, `sessionStorage`
- Test files that import code using `$app/environment`, `$app/navigation`, `$app/stores`

### How to check

1. Does the test file have `@vitest-environment jsdom` in a doc comment at the top?
2. Does it mock `$app/environment` with `vi.mock("$app/environment", () => ({ browser: true }))`?
3. Are other SvelteKit modules (`$app/navigation`, `$app/stores`) mocked if imported?
4. Are global property stubs (e.g., `navigator.onLine`) scoped to `beforeAll`/`afterAll` or
   save/restore in `beforeEach`/`afterEach`?

### Example — missing jsdom environment (PR #136)

```typescript
// BAD: Test uses navigator.onLine but runs in Node environment.
// navigator is undefined — tests silently skip the offline branch.
describe("offline detection", () => {
  it("should detect offline state", () => {
    Object.defineProperty(navigator, "onLine", { value: false });
  });
});

// GOOD: jsdom environment + $app/environment mock
/**
 * @vitest-environment jsdom
 */
vi.mock("$app/environment", () => ({ browser: true }));

describe("offline detection", () => {
  // navigator exists in jsdom, tests actually exercise the branch
});
```

**General rule:** If the production code has a `browser` guard or touches a browser global, the
test needs jsdom + the corresponding mock.

---

## Accessibility

Interactive UI elements must expose their semantics and state to assistive technologies.
Missing labels and incorrect ARIA roles cause controls to be invisible or misleading to screen readers.

### What to look for

- `<button>`, `<input>`, `<textarea>`, `<select>` without `aria-label`, `aria-labelledby`, or an associated `<label>`
- Custom widgets (star ratings, toggles, tab bars) without appropriate ARIA roles (`radiogroup`, `radio`, `tab`, `tablist`)
- Interactive elements that change visual state (selected, active, expanded) without corresponding `aria-checked`, `aria-selected`, `aria-expanded`
- `placeholder` used as the only accessible name for a form control

### How to check

1. For every interactive element in the diff, verify it has a programmatic accessible name (`aria-label`, `<label>`, or `aria-labelledby`)
2. For custom widgets that mimic native controls (e.g., star buttons acting as radio inputs), verify appropriate ARIA roles and state attributes
3. Confirm that visual state changes (selected, toggled, expanded) have matching ARIA state attributes

### Example — star rating missing radio semantics (PR #142)

```svelte
<!-- BAD: role="group" doesn't convey selection state -->
<div role="group" aria-label="Rating">
  <button aria-label="1 star">...</button>
</div>

<!-- GOOD: radiogroup + radio + aria-checked -->
<div role="radiogroup" aria-label="Rating">
  <button role="radio" aria-checked={selected} aria-label="1 star">...</button>
</div>
```

**General rule:** If a visual state change (color, fill, position) communicates meaning to sighted users, there must be a corresponding ARIA attribute communicating the same meaning to assistive tech.

---

## Component Composition

When composing multiple headless UI primitives (e.g., Tooltip + Popover from bits-ui), each
primitive's trigger must forward its props to the actual rendered element via the `child` snippet
pattern. Missing prop forwarding causes the primitive to silently lose keyboard/screen-reader
behavior.

### What to look for

- Multiple trigger/wrapper primitives nested around a single interactive element
- `child` snippet used on one primitive but not its siblings
- Headless UI components (`Tooltip.Trigger`, `Popover.Trigger`, `Dialog.Trigger`) used without
  the `{#snippet child({ props })}` pattern

### How to check

1. For each headless trigger in the diff, verify it uses `{#snippet child({ props })}` and
   spreads `{...props}` on the rendered element
2. When multiple triggers wrap the same element, verify **all** of them forward props (e.g.,
   `{...tooltipProps}` and `{...popoverProps}` both appear on the `<Button>`)
3. Confirm that prop spreading order puts more-specific props last (popover after tooltip)

### Example — missing tooltip prop forwarding (PR #142)

```svelte
<!-- BAD: TooltipTrigger doesn't forward props — tooltip won't activate on focus -->
<TooltipTrigger>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button {...props}>Click me</Button>
    {/snippet}
  </Popover.Trigger>
</TooltipTrigger>

<!-- GOOD: Both triggers forward props to the button -->
<TooltipTrigger>
  {#snippet child({ props: tooltipProps })}
    <Popover.Trigger>
      {#snippet child({ props: popoverProps })}
        <Button {...tooltipProps} {...popoverProps}>Click me</Button>
      {/snippet}
    </Popover.Trigger>
  {/snippet}
</TooltipTrigger>
```

**General rule:** Every headless trigger wrapping an element must use the `child` snippet to
forward its props. If you see nested triggers, count the `child` snippets — the count must match.

---

# Part 3: Learned Patterns

This section grows automatically from retrospectives. When the retrospective step identifies
a class of issue that human reviewers caught but the independent review missed, a new entry
is appended here. Each entry includes the PR number where the gap was identified.

## npm Lifecycle Script Environment Guards

npm lifecycle scripts (`prepare`, `postinstall`, etc.) run automatically during `npm install`
and `npm ci`. If they assume tools or contexts that aren't universally available (e.g., git,
specific CLIs), they will break installs in environments that lack those prerequisites.

### What to look for

- `prepare`, `postinstall`, `preinstall` scripts in `package.json`
- Commands in those scripts that depend on non-Node tools (`git`, `bun`, `docker`, etc.)
- Commands that assume a specific directory structure (e.g., `.git` exists)

### How to check

1. For each lifecycle script, identify external tool dependencies
2. Verify each dependency is guarded with `command -v` or `which` checks
3. Verify failure is non-fatal (the script should not block `npm install` if the tool is missing)

### Example — unguarded git config in prepare (PR #156)

```json
// BAD: Fails npm install when git is unavailable or outside a repo
"prepare": "git config core.hooksPath .githooks"

// GOOD: Guard with existence checks, non-fatal
"prepare": "if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git config core.hooksPath .githooks; fi"
```

**General rule:** Every npm lifecycle script that calls a non-Node tool must guard the call
and degrade gracefully when the tool is unavailable.

---

## Granularity Mismatch Between Producer and Consumer

When a refactor changes the granularity of a piece of data (e.g. one entry per expression
becomes one entry per rendered series), every downstream consumer that derives a parallel
list from the same source must be updated to the new granularity. Otherwise the producer
and consumer diverge silently — the consumer's name set, length, or order no longer matches
the actual rendered output.

### What to look for

- A data structure being widened from "1 per X" to "N per X" (per-expression → per-series,
  per-row → per-cell, per-user → per-permission, etc.)
- Multiple consumers that build parallel arrays/sets/maps keyed off the old shape
  (e.g. `expressions.map(e => e.name)` alongside the new `seriesEntries.map(s => s.name)`)
- Cross-file consumers — chart components, tooltip formatters, sidebar widgets — that
  may not appear in the diff but reference the changed producer

### How to check

1. After a refactor that changes granularity, grep the entire repo for consumers of the
   _old_ shape (e.g. `expression.name`, `e.name`, `expressions.map(...)`) — not just the
   files in the diff.
2. For each consumer, ask: does it derive a list/set/count that is supposed to mirror the
   chart series? If yes, update it to use the new producer (`seriesEntries`, `chartDataKeys`).
3. Pay special attention to tooltip formatters, missing-data detection, legend builders,
   and any code that compares "what should be visible" against "what is rendered" — these
   silently mis-correlate when the two sides drift.

### Example — tooltip vs chart-key granularity (PR #175)

```typescript
// BAD: chartDataKeys is now per-rendered-series (e.g. "AAPL - Net Income",
// "MSFT - Net Income") but visibleSeriesNames is still per-expression
// (e.g. "AAPL, MSFT - Net Income"). The tooltip's "missing data" detection
// compares two different granularities and always reports the multi-ticker
// expression as missing, rendering spurious "—" rows.
const visibleSeriesNames = graph.expressions
  .filter((e) => e.isVisible && e.isValid)
  .map((e) => e.name);
const missingSeriesNames = visibleSeriesNames.filter(
  (name) => !presentSeriesNames.has(name),
);

// GOOD: Read from the same producer the chart uses, so granularities match.
const visibleSeriesNames = graph.chartDataKeys;
```

**General rule:** When a refactor changes data granularity, search the whole repo for
consumers of the old shape — including cross-file consumers not in the diff — and verify
each one still mirrors the new shape, not just compiles.

---

## Retry Wrappers Around Non-Idempotent Operations

A generic retry-on-failure wrapper (`retryOnce`, `withBackoff`, hand-rolled retry loops) is
safe only when the wrapped operation is idempotent. When the first attempt may have already
produced an externally visible side effect — opened a PR, posted a comment, charged a card,
mutated a remote resource — a second attempt can corrupt that state instead of recovering
from a transient failure.

### What to look for

- Retry wrappers around functions that open PRs, post comments, call non-idempotent APIs,
  or write to external systems
- Crash-recovery / resume code paths that re-enter a phase whose side effects may already
  exist from a prior run (e.g. PR was created, then the process died)
- Functions that read remote state at the start to decide what to do, but get retried as a
  black box — the retry's second invocation may hit a different branch than the first

### How to check

1. For each retry wrapper, audit the wrapped function for non-idempotent side effects
   (network calls beyond GETs, file writes, state mutations).
2. If any exist, verify either: (a) the operation is genuinely idempotent (checks for
   existing state and short-circuits) or (b) the retry is conditioned on failure classes
   that pre-date the side effect (e.g. validation failures only, not mid-write network errors).
3. On crash-recovery paths, suppress the retry entirely or branch on "did the side effect
   already happen?" before deciding to retry.

### Example — retry mutating an already-open PR (PR #7)

```typescript
// BAD: retryOnce wraps the implement LLM call. If the first run created a PR
// and then crashed, the resumed run hits the "PR already exists" branch — and
// a second LLM call inside retryOnce can mutate that already-open PR.
await retryOnce(() => runImplementPhase(ctx));

// GOOD: detect the recovered-from-crash state up front and skip the retry on
// that path; only retry when the side effect could not yet have happened.
const existingPr = await findOpenPrForBranch(ctx.branch);
if (existingPr) return resumeFromCrash(existingPr, ctx);
await retryOnce(() => runImplementPhase(ctx));
```

**General rule:** Retry wrappers are for failures that happen _before_ side effects, not
after. Anything that crosses a non-idempotent boundary needs a pre-check or an opt-out.

---

## Subprocess Wrapper Non-Throwing Contracts

A function whose return type encodes both success and failure (`{ ok, output }`,
`Result<T, E>`, etc.) is making a contract: callers do not need try/catch. Underlying
primitives — `execa`, `child_process`, `fetch`, `fs/promises` — can still throw on timeout,
abort, spawn failure, or network error. Those throws must be caught and converted to the
failure variant, or the contract breaks on the rare path that matters most (the orchestrator
built around the return value crashes instead of recovering).

### What to look for

- Functions returning `{ ok, ... }` / `Result<T, E>` / any either-like shape whose body
  calls `execa` / `spawn` / `fetch` / `fs.*` without a top-level try/catch
- `execa(..., { reject: false })` — the flag suppresses non-zero exit codes but does **not**
  suppress timeout, EPIPE, abort, or spawn failures (e.g. binary missing from PATH)
- Adapters built specifically so callers can branch on a value rather than catch

### How to check

1. Read the wrapper's return type — what failure variants does it claim to produce?
2. Trace each underlying primitive: which conditions still throw despite any quieting flags?
3. Confirm those throws land in a try/catch that maps onto the failure variant, preserving
   any captured stdout/stderr in the diagnostic.

### Example — execa throw bypassing the result contract (PR #7)

```typescript
// BAD: if `npm` is missing on PATH, or the command hits the timeout, execa
// throws — and the orchestrator's retry/surface logic, built around a
// returned value, crashes the whole phase.
const result = await execa("npm", ["run", "verify"], {
  cwd,
  reject: false,
  timeout: 600_000,
});
return { ok: result.exitCode === 0, output: result.all ?? "" };

// GOOD: try/catch converts spawn/timeout throws into the same shape and
// preserves any partial output captured before the throw.
try {
  const result = await execa("npm", ["run", "verify"], {
    cwd,
    reject: false,
    timeout: 600_000,
  });
  return { ok: result.exitCode === 0, output: result.all ?? "" };
} catch (err) {
  const e = err as { all?: string; shortMessage?: string; message?: string };
  return {
    ok: false,
    output: e.all ?? e.shortMessage ?? e.message ?? String(err),
  };
}
```

**General rule:** If the return type says "this never throws," every primitive inside has
to be wrapped. `reject: false` is not "won't throw."

---

## Error-Message Portability in Cross-Context Code

Code that ships from one repo and runs against another (a CLI invoked in consumer projects,
a generic library, a script symlinked into target repos) must produce diagnostics that make
sense from the target's frame of reference. References to producer-repo file paths, internal
script names, or internal conventions confuse the end user, who has never seen the producer
repo.

### What to look for

- Skill/library code that operates on `cwd` (a foreign repo) but emits error messages
  naming files inside the producer repo
- Error strings hardcoding internal paths (`templates/scripts/...`, `src/cli.ts`),
  internal package names, or implementation-detail file names
- Remediation hints written in producer-repo terms ("re-run `npm run dev install`") when
  the target user installed via a release artifact and has no such command

### How to check

1. Grep cross-context diagnostics for producer-repo paths, internal script names, and
   producer-specific jargon.
2. Rewrite each in target-repo terms — describe the _missing capability_, not the producer's
   implementation. "repository's `verify` npm script" beats "flow's pre-commit-checks.ts".
3. Where remediation truly requires producer-repo action, prefix with the producer's name
   (e.g. `flow:`) so the user knows which tool is asking, instead of dumping a bare path.

### Example — error message naming a producer-repo script (PR #7)

```typescript
// BAD: shipped to consumer repos, but the message points the user at a file
// that only exists inside flow.
if (!scripts.verify) {
  return {
    ok: false,
    output:
      "package.json has no 'verify' script; run flow's pre-commit-checks.ts",
  };
}

// GOOD: describes the missing capability in target-repo terms.
if (!scripts.verify) {
  return {
    ok: false,
    output: `package.json at ${pkgJsonPath} has no 'verify' npm script; add a 'verify' script that runs this repository's required validation checks (typecheck, tests, etc.)`,
  };
}
```

**General rule:** If your code can run against a repo other than the one it ships from,
every user-visible diagnostic must read sensibly to someone who has never seen the
producer repo.

---

## Slurping Append-Only Logs Into Memory

Code that aggregates over append-only log files (jsonl phase logs, ndjson event streams,
audit trails) often grows to hold the full file content in memory at once via
`readFile` + `split("\n")`. Each file is small in isolation, but the aggregator multiplies
the cost: scanning across all tasks (with `--all`, with archive enabled) reads every log
file synchronously into the heap. Phase logs in flow can carry full Anthropic stream
content via `JsonlSink.pipeFrom`, so individual files reach MBs and the aggregate easily
hits hundreds of MBs.

### What to look for

- `fs.readFile` + `.split("\n")` over a file whose growth is unbounded by design (logs,
  event streams, audit trails)
- The same call invoked inside a `for…of` over many files (an aggregator, a roster
  builder)
- A function whose input is a path to a file the rest of the system writes incrementally

### How to check

1. For each `readFile` over a log/jsonl/ndjson path, ask: is the producer append-only
   with no upper bound? If yes, this is the pattern.
2. Verify the consumer truly needs the whole file in memory — most aggregators only need
   per-line state (sum, last-seen, count). If so, `readline` over `createReadStream` is
   the streaming alternative.
3. Trace the worst-case fan-out — if the aggregator runs across N files at once
   (`Promise.all`, `--all`), multiply per-file size by N for the peak.

### Example — slurping per-phase jsonl in a roster aggregator (PR #23)

```typescript
// BAD: loads the full jsonl into memory for every phase, every task, every roster build.
// With archive included this can easily hit hundreds of MB on a long-running repo.
const raw = await fsp.readFile(filePath, "utf8");
for (const line of raw.split("\n")) {
  // …sum per-line state…
}

// GOOD: streaming line reader, peak memory bounded to one line.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
const rl = createInterface({
  input: createReadStream(filePath, { encoding: "utf8" }),
  crlfDelay: Infinity,
});
for await (const line of rl) {
  // …sum per-line state…
}
```

**General rule:** If a log file's size is bounded only by how long the producer ran,
read it line-by-line. Slurp + split is fine for config files, not for append-only logs.

---

## Single Error Message Hiding Two Root Causes

When a CLI helper short-circuits on a generic `null` / "not found" return value that
collapses several distinct failure modes — typically "tool missing from PATH" vs. "tool
ran but wrong context" — the user gets an error message that's unactionable for the
case the message wasn't written for. Often paired with a try/catch around the spawn
that's actually dead code: `spawnSync` doesn't throw when the binary is missing — it
returns with `r.error.code === "ENOENT"`. The catch never fires, the missing-binary
case silently funnels into the same `null` return as the wrong-cwd case, and only
one error message ships.

### What to look for

- A helper that returns `string | null` (or `T | null`) where `null` covers ≥2 distinct
  failure causes a user could plausibly hit
- `try { spawnSync(...) } catch { /* tool not on PATH */ }` — the catch is dead; check
  `r.error.code` instead
- A single error string at the call site that names only one of the failure modes,
  even though the return-null branch is reached by more

### How to check

1. For each `string | null` / `T | null` returning helper invoked behind a single error
   message, enumerate the distinct ways `null` is reached. If there are 2+ user-actionable
   classes, the call site message will be wrong for at least one of them.
2. Audit `spawnSync` callers: the catch block is dead for ENOENT (and a few others). The
   real signal is `r.error?.code` — check that, not `try/catch`.
3. Replace the boolean `null` with a discriminated union (`{ kind: "ok" | "tool-missing"
| "wrong-cwd" }`) and let the call site branch on the cause. Keep a string-or-null
   adapter for tests that don't need the granularity.

### Example — `findCanonicalRoot` collapsing git-missing into "not a repo" (PR #29)

```typescript
// BAD: try/catch is dead code for ENOENT, and null collapses two failure modes
// into one error message. A user without git installed sees "must be run from
// inside a git repository" and tries to cd into one — which won't help.
export function findCanonicalRoot(cwd: string): string | null {
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch {
    // git not on PATH — but spawnSync doesn't throw on ENOENT, so this never fires.
  }
  return null;
}
// at the call site:
if (!findCanonicalRoot(cwd)) {
  stderr.write("error: must be run from inside a git repository\n");
  return 3;
}

// GOOD: discriminated union surfaces the cause; call site emits a message tailored
// to the actual failure. Read r.error.code for ENOENT — that's where it actually lives.
type RootResult =
  | { kind: "ok"; path: string }
  | { kind: "git-missing" }
  | { kind: "not-a-repo" };

export function findCanonicalRootResult(cwd: string): RootResult {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return { kind: "git-missing" };
  }
  if (r.status === 0 && r.stdout) return { kind: "ok", path: r.stdout.trim() };
  return { kind: "not-a-repo" };
}
// at the call site:
const root = findCanonicalRootResult(cwd);
if (root.kind === "git-missing") {
  stderr.write("error: git not found on PATH; install git and try again\n");
  return 3;
}
if (root.kind === "not-a-repo") {
  stderr.write("error: must be run from inside a git repository\n");
  return 3;
}
```

**General rule:** If a helper's `null` return reaches the call site through more than
one user-actionable cause, the caller's single error message is wrong for at least one
of them. Use a discriminated union and let the cause survive to the message. Audit
`spawnSync` callers separately — `try/catch` around them is dead code for ENOENT.

---

## Replacement-String Metacharacter Expansion in `String.prototype.replace`

When user-supplied (or otherwise externally-sourced) text becomes the _replacement_ argument to a
JavaScript `String.prototype.replace(...)` call with a **string** replacement, the engine
interprets `$&`, `$1`–`$99`, `$$`, `$\``, `$'`, and `$<name>` as substitution patterns. Any
literal occurrence of those sequences in the user input is silently rewritten, corrupting
the output. The bug is invisible until a user happens to type one of the expansion sequences,
at which point the result depends on the surrounding match — typically replacing a small
literal with a large slice of the matched region.

This is distinct from regex injection: the _search_ argument is fine; only the replacement
string is interpreted. The fix is always the same — pass a function replacer
(`replace(re, () => replacement)`) so the replacement string is never re-parsed.

### What to look for

- `someString.replace(searchValue, replacementString)` where `replacementString` interpolates
  any value not constructed from a closed set of internal literals (user input, file
  contents, command output, parsed-from-disk text)
- A function that was previously file-private being newly exported / promoted to the public
  module surface, then reused by a caller that flows user input through it
- Any helper that builds a "replace this section with a new line" or "swap this token for
  the user's input" abstraction and uses string replacement under the hood

### How to check

1. Grep the diff for `\.replace\(` calls. For each, identify whether the second argument is
   a string literal, a template literal that interpolates variables, or a function.
2. For string and template-literal replacements, trace the interpolated variables back to
   their source. If any variable can carry user-supplied or file-supplied text, the call is
   vulnerable.
3. Verify the fix by feeding a literal `$&` (and ideally `$$`, `$1`, `$\``, `$'`) through the
   user-input path and asserting the output preserves them verbatim.
4. When promoting a previously file-private function to a public export, audit every
   `.replace` inside it and downstream — visibility changes can re-classify a "trusted
   internal" call as "exposed to user input" without changing the call itself.

### Example — `$&` in `flow revise --message` corrupted `task.md` (PR #34)

```typescript
// BAD: `line` carries user-supplied text via `flow revise --message`. A
// literal `$&` in the message is expanded to the entire matched section.
const trimmedBlock = block.replace(/\s+$/, "");
task.body = task.body.replace(block, `${trimmedBlock}\n${line}\n`);

// GOOD: function replacer — the replacement string is never re-parsed,
// so user-supplied `$&`, `$1`, `$$`, `$\``, `$'` land in the output verbatim.
const trimmedBlock = block.replace(/\s+$/, "");
const replacement = `${trimmedBlock}\n${line}\n`;
task.body = task.body.replace(block, () => replacement);
```

**General rule:** If externally-sourced text can reach the second argument of a string-form
`String.prototype.replace`, switch to a function replacer. The conversion is always safe and
costs nothing; the bug it prevents is invisible until a user types `$&`.

---

## Stale Comments Referencing Impossible Scenarios

When a phase doc-comment enumerates resume scenarios, crash windows, or branch-reach
conditions, those enumerations age faster than the surrounding code. A refactor that
narrows a branch's `unfinishedStatuses` (or otherwise restricts how the branch can be
reached) leaves the comment claiming a scenario that the new wiring makes unreachable.
The code still works, but the comment now misleads the next maintainer into treating an
impossible case as part of the contract — and into preserving conditional logic that
exists only to satisfy the stale comment.

### What to look for

- Block comments that enumerate "resume cases", "this can happen when…", or "we get here
  via…" inside a branch
- Comments that mention a status, phase, or caller no longer wired to reach that branch
  per the dispatch table (`unfinishedStatuses`, allowlists, route guards)
- Branches whose comment references an upstream phase whose own comment now contradicts
  it — a sign the two drifted independently

### How to check

1. For each enumerated scenario in a comment, trace whether the runner / dispatcher /
   caller can actually produce it. The dispatch table is the authority — if a scenario
   requires `status: X` reaching this branch but `X` is not in the relevant phase's
   `unfinishedStatuses` (or equivalent), the scenario is dead.
2. When a refactor narrows reachability, audit comments on the changed branch and on
   adjacent branches. The refactor's diff often touches the wiring, not the explanatory
   prose downstream of it.
3. Prefer deleting the impossible scenario over hedging it ("merge could have crashed
   post-…"). A short comment that's accurate beats a long one that's partly wrong.

### Example — gate's MERGED branch comment referenced a scenario the runner forbids (PR #33)

```typescript
// BAD: comment claims merge could have crashed post-`gh pr merge` and re-entered
// gate from a stale `reviewing`. With merge's `unfinishedStatuses = ["merging"]`,
// the runner only invokes merge from `merging`, so this scenario is unreachable.
// The real resume cases are user-merged-externally / gated resume.
if (state === "MERGED") {
  // Resume path: gated PR was merged externally, or merge phase crashed
  // post-`gh pr merge` and re-entered gate from a stale `reviewing`. ...
}

// GOOD: comment lists only scenarios the dispatch table can produce.
if (state === "MERGED") {
  // Resume path: the PR was merged externally, or gate resumed and found
  // it already merged. Capture the SHA if we don't already have it and
  // hand off to merge for cleanup + archive.
}
```

**General rule:** When you change `unfinishedStatuses` or any other reachability
constraint, grep the touched files for "resume", "crashed", "re-entered", and "via" and
audit each enumerated scenario against the new wiring. Reviewers should treat any branch
comment that lists scenarios as a candidate for staleness whenever the dispatch wiring
changes in the same PR.

---

## Branch Staleness vs. Main Across Cross-Phase Refactors

When a feature branch has been open for several days against a main branch that has
gained commits in unrelated phases of the same orchestrator (e.g. main lands a fix to
`plan.ts` while the open PR adds `gate.ts` + `merge.ts`), the branch's CI never exercises
the new phase against the integrated tree. The squash-merge will not silently revert the
plan-phase commits — git's three-way merge handles disjoint files cleanly — but the
branch's runner-pipeline-walk test (which mocks `runPlanPhase` and friends) won't catch a
behaviour change in the real `plan` phase that interacts with the new `gate`/`merge`
phases on a fresh tree.

### What to look for

- Open PRs introducing a new pipeline phase or wiring change while main has shipped fixes
  to other phases the runner integrates with
- Branches cut from a base SHA that's >2 commits behind `origin/main` at review time
- Runner-level dispatch tests that mock the very phases that have changed on main —
  passing locally tells you nothing about post-rebase behaviour

### How to check

1. `git log <branch>..origin/main --oneline` — if more than a couple of commits and any
   touch files the new phase integrates with, recommend a rebase before merge.
2. After rebase, re-run the full suite (`npm run test`, `npm run typecheck`) against the
   integrated tree, paying attention to runner pipeline-walk tests where the previously-
   mocked phases now return a slightly different shape.
3. Don't escalate to `issue` unless there's a concrete file-level conflict or a known
   contract change. The bar is `suggestion (non-blocking)` — the author can decide
   whether the integration risk warrants the rebase round-trip.

### Example — PR 8 cut from `ecc8999`; main gained 3 commits including a plan-phase contract change (PR #33)

The PR's diff didn't touch `plan.ts` / `headless.ts` / `start.ts`, so the squash-merge
silently reverting them was a false alarm. But the runner pipeline-walk test
(`runner.test.ts`) mocks `runPlanPhase`, so a plan-vs-gate interaction on the integrated
tree wouldn't show up there either. The author flagged this as a `suggestion
(non-blocking)` to rebase and re-run the suite before merging.

**General rule:** A clean diff against base doesn't certify a clean merge into the
current main — if the runner integrates phases that have changed on main, recommend a
rebase before merge so the open branch's CI exercises the integrated tree at least once.

---

## `process.exit` Inside Result-Returning Primitives

A function whose return type encodes both success and failure
(`Promise<InstallScriptsResult>`, `{ ok, output }`, etc.) is making a contract that
callers can wrap it in try/catch and translate every failure mode into a domain
result. CLI primitives often grew up handling validation by calling `process.exit(1)`
directly, on the assumption they only ever run from `main()`. When such a primitive
is later **reused from a non-CLI caller** — a phase, a long-running orchestrator, a
test harness — those exits bypass the caller's try/catch and terminate the entire
host process. This is distinct from the "Subprocess Wrapper Non-Throwing Contracts"
pattern: that one is about throws bypassing a Result variant, this one is about
_process termination_ bypassing it. A try/catch can't catch `process.exit`.

The bug is invisible while the unreachable-from-here analysis happens to hold (the
specific arguments a phase passes never trip the validation). It surfaces the moment
a future change makes one of the validation branches reachable: a new CLI flag flows
through, a new caller passes user input, a refactor consolidates two paths.

### What to look for

- A function returning `Promise<Result>` / `{ ok, ... }` / domain enum, whose body
  contains a `process.exit(...)` call (typically inside a validation early-return)
- The same function being newly invoked from a non-CLI context (a phase, a runner,
  a long-running process) where the caller relies on the return value to decide
  what to do next
- A try/catch around such a call where the catch was added "just in case" — the
  catch handles thrown errors but a reader might assume it also handles `exit`

### How to check

1. For each result-returning primitive newly used outside a CLI entry point, grep
   the primitive (and its helpers) for `process.exit`. Every hit is a path that
   bypasses the caller's failure boundary.
2. For each `process.exit` site, enumerate the input conditions that reach it.
   Compare against the new caller's call shape — if any condition is reachable from
   the caller's argument set, this is a real bug. If none are reachable today, it
   is a `suggestion (non-blocking)` defense-in-depth note: a later call-site change
   can make it reachable, and the change won't surface in code review of the
   primitive.
3. The fix is not "wrap in try/catch" — that doesn't catch exits. The fix is to
   refactor the primitive to throw or return a failure variant, optionally behind
   an explicit `nonExitingMode` flag so the CLI entry point keeps its top-level
   exit behaviour.

### Example — `installScripts` exit reused from `worktree` phase (PR #35)

```typescript
// BAD-IF-REACHABLE: installScripts.ts
if (path.resolve(scriptsRoot) === path.resolve(targetDir)) {
  console.error("error: source and target are the same directory ...");
  process.exit(1);                    // bypasses any caller's try/catch
}

// Caller in worktree.ts:
try {
  await installScripts(worktreePath, {});   // try/catch can't catch the exit
  return { status: "ok" };
} catch (error) {
  return { status: "failed", reason: ... }; // never fires for the exit branch
}

// GOOD: primitive throws (or returns a failure variant); CLI entry point owns exit.
if (path.resolve(scriptsRoot) === path.resolve(targetDir)) {
  throw new Error(`source and target are the same directory (${targetDir}); refusing to install`);
}
// CLI entry point catches and exits at the top level.
```

For PR #35 the exit branches turned out to be unreachable from `ensureWorktreeInstalls`'s
call shape (`scriptsRoot` is `templates/scripts` under flow's install, target is the
worktree's `scripts/`; `installSkills` exits only on unknown stack names and the caller
passes no `--stack`). Reachability analysis closed it as `suggestion (non-blocking)`
rather than `issue (blocking)`. The pattern stays in the checklist because the next
caller might not have the same luck.

**General rule:** A try/catch boundary cannot catch `process.exit`. When you reuse
a CLI primitive from a non-CLI caller, audit the primitive (and its helpers) for
`process.exit`, enumerate reachability for the new call shape, and prefer pushing
the exit decision back up to the CLI entry point.

---

## Branch Staleness vs Main-Integrated Behaviour

A PR's branch can be cut from a stale `main` and still pass its own CI, because CI
exercises the branch in isolation, not the post-squash-merge tree. If the PR touches
or wires into modules that have changed on `main` since the cut, the merged tree may
behave differently than either side did individually. The diff alone won't reveal this
— the integration only manifests after squash. Even when the PR's own files don't
overlap with `main`'s new commits, a runtime-integration concern (e.g. a runner that
calls into both `runPlanPhase` and `runGatePhase`) can surface only post-merge.

### What to look for

- The PR's base SHA differs materially from current `origin/main` (multiple commits
  behind, especially feat/fix commits that touch modules the PR integrates with)
- The PR adds a new phase, hook, middleware, or pipeline step that _composes_ with
  existing modules — even if the PR's diff doesn't touch those modules' files
- Mocks in tests stub out the very modules that have changed on `main` (so the test
  cannot detect a contract drift)

### How to check

1. `git log --oneline <pr-base-sha>..origin/main` — list commits added to main since
   the branch was cut. Skim subjects/bodies for changes to modules the PR integrates with.
2. For each main-side commit that touches an integration partner, ask: would the PR's
   tests catch a contract change? If the test mocks the partner, the answer is no.
3. If the PR is squash-merge-bound, recommend a rebase (or merge-from-main) plus a fresh
   `npm run test` / `npm run typecheck` run before merge — particularly when the PR's
   pipeline-walk tests mock the changed-on-main module.

### Example — pipeline-walk test mocks the changed-on-main module (PR #33)

The PR adds gate + merge phases and wires them into `runPipeline` via `M2_PIPELINE`.
Three commits landed on `main` after the branch was cut, including a change to
`runPlanPhase`'s success semantics on subprocess failure. The PR's `runner.test.ts`
mocks `runPlanPhase`, so a plan-vs-gate dispatch interaction would not surface in CI.
The diff is non-overlapping (the PR doesn't touch `plan.ts`), so static analysis says
"safe to merge"; only a rebase + re-run reveals whether `runPipeline`'s walk still
holds end-to-end against the new plan-success branch.

**General rule:** A non-overlapping diff doesn't imply a non-overlapping behaviour. When
a PR composes with modules that have moved on `main` since the branch was cut, recommend
rebase + re-run before merge — and explicitly check whether the PR's tests mock the
changed-on-main partner (which would suppress the only signal that would catch drift).

---

## Markdown Inline Code Spans Split Across Newlines

CommonMark/GFM inline code spans (delimited by single backticks) cannot
contain unescaped line breaks. When prose authors hard-wrap a long line
mid-`code span`, the renderer either treats the closing backtick as
literal text or merges the surrounding tokens, producing garbled output.
The bug is invisible until the markdown ships to a renderer that
strictly follows the spec — common for SKILL.md docs, PR descriptions,
and READMEs.

### What to look for

- `.md` / `.mdx` diffs where a hard-wrap falls inside `` ` `` … `` ` ``
- Prose paragraphs in skill docs / READMEs that cite a long shell command,
  variable, or file path inside backticks
- Blockquoted hard rules (the supervisor SKILL.md style: `> **rule.**
body…`) where the rule text wraps mid-code-span

### How to check

1. Grep changed `.md` files for backticks. For each pair, ensure the
   opening and closing backticks fall on the same line.
2. If the code span is long, use one of: (a) keep the entire span on a
   single (un-wrapped) line, accepting the long line; (b) split the
   intent into two adjacent code spans (`` `git branch -m` `` and
   `` `git switch <other-branch>` ``); (c) escape with backslash if the
   surrounding renderer supports continuation (rare — prefer (a)/(b)).
3. Preview the file in the target renderer (GitHub for repo docs,
   Claude Code's renderer for SKILL.md) to confirm.

### Example — supervisor hard rule code span split mid-prose (PR #53)

```markdown
<!-- BAD: code span split across newline; renderers may treat the
     closing backtick + angle-bracket text as literal. -->

> **You never run `git branch -m` or `git switch
<other-pipeline-branch>`.** Branch renames and ...

<!-- GOOD: keep the code span on one line, wrap the surrounding
     prose around it. -->

> **You never run `git branch -m` or `git switch <other-pipeline-branch>`.**
> Branch renames and ...
```

**General rule:** When hard-wrapping markdown prose, line breaks must
fall _outside_ every backtick pair. If a single code span is too long
to keep on one line, split it into two adjacent spans — never wrap
mid-span.

---

## Removing a Top-Level `package.json` Field Breaks an Install Pathway

When a PR drops a top-level field from `package.json` (`bin`, `main`,
`exports`, `types`, `engines`, `files`, `scripts.prepare`,
`scripts.postinstall`, etc.), check that no documented user-facing
install or invocation path silently breaks. The deletion is often the
_intent_ — but the docs and any external onboarding flows must be
consistent with the new world. A reader still typing `npm i -g <pkg>`
or `npm link` will get a successful install with no executable shim.

### What to look for

- A `package.json` diff that removes a top-level field, especially
  `bin`, `main`, `exports`, or a lifecycle hook (`prepare`,
  `postinstall`).
- The same PR removing the only consumer of that field (e.g. deleting
  `dist/cli.js` along with `bin: { "<cmd>": "./dist/cli.js" }`).
- Onboarding docs (`README.md`, install guides) that still mention
  `npm link` / `npm i -g` / `node_modules/.bin/<cmd>`.

### How to check

1. List every top-level field removed in the `package.json` diff.
2. For each, identify what install/invocation pathway it enabled
   (`bin` → `npm i -g`, `main` → bare imports, `prepare` → fresh-clone
   build, etc.).
3. `grep -rn 'npm link\|npm i -g\|npm install -g\|node_modules/.bin'`
   across `README.md`, `docs/`, and onboarding scripts.
4. Confirm any remaining references are explicitly historical /
   migration text, not "do this to install".
5. If the new install path requires a separate command (e.g.
   `flow install`), confirm the README's "Install" section is the
   single source of truth and reads cleanly without the deleted
   field.

### Example — `bin` removal without README sync (PR #56)

```json
// BAD: package.json drops the bin entry, but README.md still says
//        npm install     # `prepare` builds dist/ for the legacy `install` verb
//        npm link        # makes flow available on PATH
//      so a reader pastes those commands and gets no `flow` shim.
{
  "name": "flow",
  "type": "module",
  "files": ["bin", "templates"]
  // (no "bin" field)
}

// GOOD: drop the field AND scrub the README's "Install" section so
// the documented path is the only path that still works.
//   git clone <repo>
//   npm install
//   bun bin/flow install
```

**General rule:** A `package.json` field deletion is half a change.
The other half is the docs that previously assumed it. Cross-check
every removed field against `README.md` install / quick-start
sections before approving.

---

## Agent Prompt Cites A Confidence Range That Diverges From The Helper's Filter Default

Agent role prompts that describe a pre-digest lens's payload sometimes
restate the lens's _internal_ confidence-score range (e.g., "biome
diagnostics 75–90") rather than the _filtered_ range the agent actually
receives. The helper applies `confidence >= min_confidence` (default 80)
before emitting findings, so any range whose lower bound is below the
default is a lie about what shows up in the agent's
`{{STATIC_ANALYSIS_FACTS}}` block. Reviewers reading the prompt expect
to see confidence-77 findings; they never will.

### What to look for

- Agent prompts in `references/agent-prompts.md` that name a numeric
  confidence range for a static-analysis lens's input (e.g., "confidence
  N–M", "scores N to M").
- A divergence between that range's lower bound and the helper's
  `min_confidence` default in the matching CLI parser
  (`bin/flow-pr-static-analysis/cli.ts:37`).
- Multiple agent sections that share a lens (e.g., Performance and
  Pattern/Consistency both consume `lint`) — drift risk multiplies
  across sites.

### How to check

1. For each agent prompt's Process step 1, identify any numeric
   confidence range it cites for its lens payload.
2. Grep the static-analysis helper for the matching `min_confidence`
   default: `grep -n 'minConfidence:' bin/flow-pr-static-analysis/cli.ts`.
3. If the prompt's lower bound is below the default, the cite is wrong
   — the agent will never see findings in that lower band. Prefer prose
   that names `min_confidence` directly over a baked-in range.

### Example — Performance agent prompt cites 75–90 (PR #169)

```markdown
BAD: claims findings the agent will never see, because the helper
filters to confidence >= 80 before emitting.

1. Your `{{STATIC_ANALYSIS_FACTS}}` block contains the **`lint`** lens —
   biome or eslint diagnostics (confidence 75–90, source `biome` or
   `eslint`) on PR-touched lines.

GOOD: references the filter default by name; the prose stays true even
if the default moves.

1. Your `{{STATIC_ANALYSIS_FACTS}}` block contains the **`lint`** lens —
   biome or eslint diagnostics (source `biome` or `eslint`) on
   PR-touched lines, already filtered to `confidence >= min_confidence`
   (default 80) by the static-analysis helper.
```

**General rule:** Agent prompts describing a lens payload must name
the helper's filter defaults rather than restate the lens's internal
score range — the helper's output, not its input, is what the agent
actually sees.

---

## Doc Arithmetic Drift From Code Constants

Prose budgets ("capped at 200 lines", "head 200 + marker + tail 100 =
300") derive from code constants and drift from them — either through
a refactor that updates the constant but not the four SKILL.md sites
quoting it, or through an author who writes "300 (head 200 + marker +
tail 100)" without checking that 200 + 1 + 100 = 301. Treat any prose
number that sums components as a derivation reviewers must re-do.

### What to look for

- SKILL.md / README / agent-prompts citing a numeric budget,
  especially when prose decomposes it ("head N + tail M + marker")
- Multiple doc sites quoting the same number — drift risk scales with
  site count
- A code constant (`HEAD_LINES = 100`) whose value is restated
  verbatim in prose rather than named

### How to check

1. For each cited budget, locate the constant(s) it derives from. If
   the prose decomposes, sum the parts and confirm the total —
   including any marker / separator overhead.
2. Grep the repo for the exact number. Every site must agree with the
   code. Prefer prose that names the constant
   (`HEAD_LINES + TAIL_LINES`) over a bare number.
3. If a changeset edits a budget constant without touching SKILL/
   README sites that quote it, flag the missing doc updates.

### Example — diff cap arithmetic mismatch (PR #96)

```markdown
BAD: 200 + 1 + 100 = 301, not 300; flow-pr-diff.test.ts:90 asserts 301.

- `flow-pr-diff` per-file caps each block at 300 lines (head 200 +
  truncation marker + tail 100).

GOOD: budget and wire size separated so the marker is accounted for.

- `flow-pr-diff` per-file caps each block at 300 source lines
  (head 200 + tail 100); truncated files emit one extra marker line,
  for at most 301 lines on the wire.
```

---

## Doc/Wire Mismatch On Optional Fields

A TypeScript type spec saying `field: T | null` does not guarantee the runtime emits `null`
for the absent case. Many helpers build their result object conditionally and omit optional
fields entirely, so the wire JSON carries `undefined` (effectively absent) rather than the
documented `null` literal. Downstream consumers that read the docs and write
`x.field === null` checks then silently miss the case.

### What to look for

- A JSON helper whose result type declares `field?: T | null` or `field: T | null` and
  whose docs / SKILL.md / protocol reference quote `field: null` literally for some path.
- The helper's result-construction code uses an object literal that only adds the field on
  the non-null branch (`if (x !== null) result.field = x;`) or omits it from one of several
  exit-path object literals.
- Tests for the "null" path that assert `toBeUndefined()` rather than `toBeNull()` —
  smoking-gun signal that the docs and the wire disagree.

### How to check

1. Grep the helper's source for every site that constructs the result object. Confirm
   each one either sets the field to its documented value (including an explicit `null`)
   or follows a documented "absent" contract that the docs match.
2. Grep the test file for the field name plus `toBeUndefined` / `toBeNull`. The assertion
   shape is the canonical wire-shape check; if the docs say `null` and the test says
   `toBeUndefined`, the docs lose.
3. Decide which side to align: either change the helper to emit the documented value
   (preferred — stable wire shape, downstream consumers can trust the docs), or change the
   docs to say "absent" (acceptable for genuinely-optional fields that never appear on
   most paths). Update the test in the same commit.

### Example — `copilotSkipReason` doc/wire mismatch (PR #224)

```typescript
// BAD: type says `... | null`, docs quote `null`, helper omits the field
//      on every normal-exit path, test asserts toBeUndefined.
export type RunResult = {
  // ...
  copilotSkipReason?: "unclaimed-after-deadline" | "self-dismissed" | null;
};

if (verdict.verdict === "exit") {
  const result: RunResult = {
    decision: verdict.decision,
    // ... copilotSkipReason omitted on this path
  };
  emitResult(result);
}

// In tests:
expect(result.copilotSkipReason).toBeUndefined(); // ← contradicts the docs

// GOOD: every exit path emits the documented value; field is always
//       present so downstream `=== null` checks behave as documented.
copilotSkipReason: "unclaimed-after-deadline" | "self-dismissed" | null;

if (verdict.verdict === "exit") {
  const result: RunResult = {
    decision: verdict.decision,
    // ... explicit null on every normal-exit path
    copilotSkipReason: null,
  };
  emitResult(result);
}

expect(result.copilotSkipReason).toBeNull();
```

**General rule:** When reviewing helpers that document `null` literals in their JSON
contract, verify the wire shape via the test fixtures (`toBeNull` vs `toBeUndefined`) and
the result-construction sites — a TypeScript type spec alone does not enforce the
documented contract.

---

## Exact-string anchor gating between producer and consumer docs

A producer doc authors a specific artifact (a heading, a sentinel literal, a field name)
and one or more consumer docs gate behavior on matching that exact string. When the
gate is a byte-exact match and the design is "tolerant of absence" (a missing/renamed
anchor degrades gracefully rather than erroring loudly), a one-sided rename on the
producer side silently degrades the whole feature the gate exists to guard — the
consumer falls back to its no-anchor behavior instead of failing.

### What to look for

- Prose like `contains a \`# Heading\` heading`or`matches the literal string
  \`sentinel\`` gating a conditional branch, paired with "tolerant of absence"
  framing elsewhere in the same doc.
- The same literal string repeated verbatim across producer and 2+ consumer files
  with no shared constant (prose-only pipelines have no compiler to catch drift).
- No lint/test asserting the literal appears in all the sites that gate on it.

### How to check

1. Grep the exact literal across every file in the hop chain (producer + all
   consumers); confirm it's byte-identical everywhere it's used as a gate.
2. Ask whether heading level / casing variations at any hop would silently
   degrade rather than error — if so, either pin the anchor with a lint that
   checks all sites in lock-step, or make the consumer match tolerantly
   (case-insensitive, any heading level) and pin only the producer's exact
   emission.
3. Verify the lint/test actually asserts on the anchor itself, not just a
   loosely-related substring that survives the anchor's deletion.

### Example — `# Task breakdown` heading gating plan-contract wiring (PR #424)

```markdown
<!-- BAD: consumer gates on exact-match; producer heading text has no lint
     pinning it in lock-step with the consumers -->

`PLAN_PATH` — ... AND that file exists AND contains a
`# Task breakdown` heading; the literal string `absent` otherwise.

<!-- GOOD: consumer gate is tolerant of heading level/casing; the producer's
     exact emission is separately pinned by a lint so the tolerant match has
     something reliable to find -->

`PLAN_PATH` — ... AND that file exists AND contains a heading (any level,
case-insensitive) matching `Task breakdown`; the literal string `absent`
otherwise.
```

**General rule:** When a consumer contract gates on an exact-match anchor authored by
a separate producer doc, either match the anchor tolerantly (heading level/casing) or
pin the anchor with a lint that checks producer and every consumer in lock-step — a
strict-match gate on a "tolerant of absence" design silently degrades the very feature
it guards, with nothing failing in CI.

---

## SECURITY DEFINER `search_path` Pinning Judged Against the Copied File, Not the Repo

A new `SECURITY DEFINER` function copied from one precedent migration can silently omit a
hardening convention (`SET search_path = public`) that other migrations in the same repo do
apply. Schema-qualifying the statements inside the function reduces the risk but does not
replace pinning — and "the file I copied didn't pin it" is not evidence the repo lacks the
convention.

### What to look for

- Any new `CREATE [OR REPLACE] FUNCTION ... SECURITY DEFINER` in a migration without
  `SET search_path`.
- Unqualified table names (`billing_accounts` vs `public.billing_accounts`) inside migration
  SQL that otherwise qualifies names — especially backfill DML and trigger bodies.

### How to check

1. `grep -rn "SECURITY DEFINER" supabase/migrations/` and compare: do OTHER migrations append
   `SET search_path = public` (or similar)? If any do, the convention exists — flag the new
   function for pinning even when the nearest-copied precedent omits it.
2. Inside the new function/backfill, check every table reference is schema-qualified
   consistently with the rest of the same file.

### Example — billing signup trigger omitted the pin (econ-data PR #423)

```sql
-- BAD: copied handle_new_user's shape (create_profiles_schema.sql), which
--      predates the convention
CREATE OR REPLACE FUNCTION handle_new_user_billing()
...
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- GOOD: matches the repo's hardened precedent (create_dashboard_shares.sql)
CREATE OR REPLACE FUNCTION handle_new_user_billing()
...
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
```

**General rule:** For security-hardening conventions, the standard is the strictest precedent
in the repo, not the file the author happened to copy — dropping a candidate finding because
"the copied pattern also lacks it" requires checking that NO sibling applies the convention.

---

# Adding New Patterns

This checklist is a living document. When the retrospective step identifies a class of issue
that reviewers caught but the independent review missed, append a new entry to Part 3
following this template:

```markdown
## <Category Name>

<1-2 sentence description of what this class of issue is.>

### What to look for

- <Observable signals in the code that indicate this pattern might apply>

### How to check

1. <Concrete verification step>
2. <Concrete verification step>

### Example — <brief description> (PR #<number>)

\`\`\`typescript
// BAD: ...
// GOOD: ...
\`\`\`

**General rule:** <One-sentence heuristic>
```

## HTTP Freshness Intent vs SW Precache Membership

A file given a `Cache-Control: no-cache` / revalidate-always rule (via `_headers`, server
config, or meta headers) that is simultaneously swept into a service worker's precache and
served cache-first has its freshness intent silently defeated: once the SW controls the page,
the HTTP rule never fires.

### What to look for

- A PR that both (a) adds/edits an HTTP caching rule for a specific asset (e.g. `_headers`
  entries for `/manifest.webmanifest`, `/service-worker.js`) and (b) builds a SW precache list
  from a wholesale `files`/static directory sweep.
- Exclusion lists (`PRECACHE_EXCLUDED_FILES` or similar) that name some always-revalidate
  assets but not all of them.

### How to check

1. List every path named in the PR's HTTP caching rules (`_headers`, headers config).
2. For each, check whether the SW precache-list builder includes it (directory sweeps include
   everything not explicitly excluded).
3. Any path with a revalidate-always HTTP rule that is also precached+served-cache-first is a
   finding — exclude it from the precache or intentionally document the override.

### Example — manifest.webmanifest precached despite `_headers` no-cache (PR #353)

```typescript
// BAD: _headers says "/manifest.webmanifest: Cache-Control: no-cache", but
const PRECACHE_EXCLUDED_FILES = ["mockServiceWorker.js", "_headers"]; // manifest still swept in
// GOOD:
const PRECACHE_EXCLUDED_FILES = [
  "mockServiceWorker.js",
  "_headers",
  "manifest.webmanifest",
];
```

**General rule:** every asset the PR marks revalidate-always over HTTP must be absent from any
cache-first SW layer the same PR ships — the two mechanisms contradict each other silently.

## path.join With Absolute Segment Discards the Base

`path.join(BASE, p)` where `p` begins with `/` does NOT escape-check or anchor under BASE the
way authors assume — `join` normalizes but keeps the leading-slash segment rooted, e.g.
`path.join("/base", "/a")` → `/base/a` BUT `path.resolve(BASE, p)` with absolute `p` discards
BASE entirely. Hand-rolled static file servers routinely pass URL pathnames (always
leading-`/`) into these helpers; the failure mode is either serving from the wrong root or a
prefix check that always fails and routes everything to the fallback.

### What to look for

- `path.join(...)` / `path.resolve(...)` receiving a raw `url.pathname` (or any
  user-controlled path that can start with `/` or contain `..`).
- A `startsWith(BASE)` containment check downstream of such a join — verify with actual values
  which branch actually executes.

### How to check

1. Trace the exact string handed to `join`/`resolve` (does the caller strip the leading `/`?).
2. Evaluate the helper's semantics for that shape (`node -e 'console.log(require("path").join("/b","/a"), require("path").resolve("/b","/a"))'`).
3. Confirm the containment check passes for a known-good asset path AND fails for `../`
   traversal — both directions, with concrete strings.

### Example — e2e static server pathname handling (PR #353)

```typescript
// BAD (resolve): candidate = path.resolve(BUILD_DIR, url.pathname) // "/foo" discards BUILD_DIR
// GOOD: const rel = url.pathname.replace(/^\/+/, ""); path.resolve(BUILD_DIR, rel)
```

**General rule:** never hand a leading-slash URL pathname to path.join/resolve against a base
dir — strip/relativize first, then assert containment with a trailing-separator prefix check.

## New Top-Level Landmark Must Match Sibling Landmark Container Styling

A PR that introduces a new top-level landmark (`<main>`, `<header>`, a page-owning wrapper)
on a route that previously delegated to a shared layout must carry over the shared layout's
container guards (`overflow-x-hidden`, safe-area padding, scroll containment) — not just its
visual vocabulary. A decorative child that deliberately overflows (full-bleed SVG, marquee
band) makes the missing guard user-visible as horizontal scroll on narrow viewports even
when an inner wrapper clips, because the guard also protects against FUTURE children.

### What to look for

- A new `<main>`/landmark element whose class list lacks guards its siblings
  (`AuthenticatedLayout`, shared layouts) consistently apply.
- Children that rely on `overflow: visible` (full-bleed SVG tricks) under a landmark with no
  explicit overflow containment.

### How to check

1. `grep -rn '<main' apps/web/src` and diff the class lists of every `main` landmark.
2. If the new landmark omits a guard the others share, flag as `suggestion (non-blocking)` —
   consistency-by-default unless the omission is explained.

### Example — SignInGate full-viewport recomposition (PR #356)

Copilot caught that the recomposed `SignInGate` `<main>` lacked `overflow-x-hidden` while
`AuthenticatedLayout`/`SharedLayout` mains carry it, and the new `GateHeroScene` child relies
on SVG overflow for its full-bleed ground strip.

**General rule:** when adding a landmark that peers with existing shared-layout landmarks,
diff the class lists and inherit every containment guard, or document why not.

## Git-Grep Audit Guards Must Use Deterministic Pathspec Magic

An audit-guard test that shells out to `git grep` with a bare `'apps/web/src/**/*.svelte'`
pathspec relies on git's default glob interpretation, which differs by pathspec settings and
silently false-passes when the pattern matches nothing. Guards exist to fail loudly; a guard
whose selector can quietly select zero files is a change-detector that never detects.

### What to look for

- Test files invoking `git grep`/`git ls-files` with `**` glob pathspecs and asserting on
  the match set (zero-hits invariants, frozen keep-lists, exact file arrays).
- Any grep-based invariant with no companion assertion that the selector itself matched a
  known-present sentinel file.

### How to check

1. In new/changed test files, grep for `git grep` / `execSync(.*grep`.
2. If the pathspec uses bare `**`, flag `suggestion (non-blocking)`: use explicit
   `:(glob)` pathspec magic (`':(glob)apps/web/src/**/*.svelte'`) or assert a sentinel match
   so an empty selection fails.

### Example — delight-audit lucide keep-list (PR #360)

Copilot caught that the keep-list grep relied on bare `**` glob behavior; agents missed it.

**General rule:** a grep-shaped guard must be deterministic about its file selection — use
`:(glob)` magic and/or assert the selector matches a known sentinel.

## Real-Time Waits in Specs Where a Fake-Timers Idiom Exists

A spec that waits on real wall-clock time (`waitFor` with a seconds-scale timeout around a
`setTimeout`-driven behavior) is slower and CI-flaky when the repo already uses
`vi.useFakeTimers()` for timer-driven behavior elsewhere. Agents tend to suppress this as
"style"; reviewers flag it because it compounds across suites.

### What to look for

- New specs asserting on state that a production `setTimeout`/interval mutates, using
  real-time `waitFor`/sleeps rather than advancing fake timers.
- Imports (`waitFor`) that become unused once the spec switches to fake timers.

### How to check

1. In changed test files, find `waitFor(..., { timeout:` with timeout ≥ 1000ms.
2. Check whether the awaited behavior is a deterministic in-process timer (not network/IO).
3. If yes and the repo uses `vi.useFakeTimers()` elsewhere, flag `suggestion (non-blocking)`
   at ≥80 confidence — this is determinism, not style.

### Example — gotcha self-clear spec (PR #360)

Copilot flagged the 2s real-time `waitFor` on the gotcha self-clear; the test-coverage agent
had considered it and suppressed it below threshold as style. Treat deterministic-timer
real-time waits as a surfaceable determinism finding, not style.

**General rule:** when production behavior is a deterministic in-process timer, the spec
advances fake timers; real-time waits are reserved for genuinely async boundaries.
