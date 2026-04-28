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
const missingSeriesNames = visibleSeriesNames.filter((name) => !presentSeriesNames.has(name));

// GOOD: Read from the same producer the chart uses, so granularities match.
const visibleSeriesNames = graph.chartDataKeys;
```

**General rule:** When a refactor changes data granularity, search the whole repo for
consumers of the old shape — including cross-file consumers not in the diff — and verify
each one still mirrors the new shape, not just compiles.

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
