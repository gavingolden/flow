---
name: flow-testing-svelte
description: >-
  Write or update unit tests for Svelte 5 components using Vitest,
  @testing-library/svelte, user-event, and MSW. TRIGGER when: `.svelte` /
  `.svelte.ts` component tests, `vi.mock()` stubbing, runes-component
  rendering, testing-library queries. SKIP when the unit under test is not a
  Svelte component (plain TS/JS logic, a non-Svelte framework, backend code) —
  defer generic test-writing/coverage guidance to flow-testing.
---

# Goal

Generate comprehensive, isolated Svelte component tests using Vitest and
Testing Library that cover behavior, not implementation details. This skill
owns the Svelte/vitest stack mechanics; the framework-agnostic testing
philosophy (structure, AAA, coverage discipline) lives in `flow-testing`.

# When to Use

- User asks to add or update tests for a Svelte component.
- The `flow-svelte` skill hands off a completed component for testing.
- A Svelte component test is failing and needs debugging.

# When NOT to Use

- Generic test-writing / coverage guidance for non-Svelte units — defer to
  `flow-testing`.
- Writing the component itself (defer to `flow-svelte` or
  `flow-tailwind-shadcn`).
- End-to-end or browser-based testing.
- Testing database migrations or SQL (defer to `flow-supabase-project`).
- Go backend tests — see `flow-testing`'s `references/go-testing.md`.

# Context

- Testing stack: Vitest + `@testing-library/svelte` + `@testing-library/user-event`
- MSW is configured globally via the project's vitest setup (commonly `vitest-setup.ts`) for API mocking
- Mock handlers live in the project's mocks directory (commonly `src/mocks/handlers.ts`)
- Test naming and `describe()` conventions: see `AGENTS.md` Testing section
- The generic structure/AAA/coverage discipline: see `flow-testing`

# Instructions

## 1. File Placement

Create the test file adjacent to the file being tested:

- Svelte component: `Button.svelte` → `Button.svelte.test.ts`
- Domain logic: `user-service.ts` → `user-service.test.ts`

## 2. Test Structure

- Group tests by: happy paths, empty states, error states, loading states.
- Use `it("should <expected behavior>", ...)` naming.

## 3. Arrange-Act-Assert (AAA)

Structure every test body in three clearly separated phases (setup, action, assertion). Use
comments to demarcate each phase when the test is non-trivial.

## 4. Component Isolation (Shallow Rendering)

**Core principle:** Test each component in isolation by stubbing its child components. This
ensures that a component's tests only fail when _that_ component breaks — not when a deeply
nested child changes.

### Stub Convention

1. Create a `__stubs__/` directory adjacent to the test file.
2. Write minimal Svelte stub components that render a `data-testid` element.
3. Use `vi.mock()` at the top of the test file to swap real children with stubs.
4. Use dynamic `import()` for the component under test — **after** the `vi.mock()` calls — so
   Vitest can intercept the imports.

### Stub Example

```svelte
<!-- __stubs__/ExpensiveChildStub.svelte -->
<script lang="ts">
  /** Stub component for testing — replaces ExpensiveChild */
</script>

<div data-testid="expensive-child-stub">Stub</div>
```

```typescript
// MyComponent.svelte.test.ts
import { render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

// Stub child components BEFORE importing the component under test
vi.mock("$lib/components/ExpensiveChild.svelte", async () => {
  const stub = await import("./__stubs__/ExpensiveChildStub.svelte");
  return { default: stub.default };
});

describe("MyComponent", () => {
  it("should render the child component slot", async () => {
    const { default: MyComponent } = await import("./MyComponent.svelte");
    render(MyComponent, { props: { title: "Test" } });
    expect(screen.getByTestId("expensive-child-stub")).toBeTruthy();
  });
});
```

### What to Stub

- **Always stub:** Heavy rendering children (charts, maps, complex modals), components with their
  own side effects (API calls, timers), third-party library wrappers (ECharts, etc.).
- **Don't stub:** Primitive/leaf components with no children or side effects (a plain `<Button>`
  that just renders text and fires an `onclick`).
- **Mock with `vi.mock()`:** Non-component modules like `$lib/database/client`, `$app/environment`,
  or Supabase client.

## 5. Behavioral Testing

- Test what renders in the DOM, not internal state.
- Use accessible queries: `getByRole`, `getByText`, `getByLabelText`.
- Prefer `userEvent` over `fireEvent` for user interactions.

## 6. Mocking

- Use `vi.mock()` for module-level mocks (e.g., `$lib/database/client.ts`).
- Use MSW `server.use()` for API request overrides within specific tests.
- Create typed fixtures at the top of the test file.
- **Global stubs (`vi.stubGlobal`):** Always scope to `beforeAll`/`afterAll` with
  `vi.unstubAllGlobals()` in teardown. Never stub globals at module scope — this leaks into other
  test files if worker isolation changes.

```typescript
// BAD: module-scope stubs leak globals
vi.stubGlobal("localStorage", fakeStorage);

// GOOD: scoped stubs with teardown
beforeAll(() => vi.stubGlobal("localStorage", fakeStorage));
afterAll(() => vi.unstubAllGlobals());
```

## 7. Run and Verify

- Run `npm run test -- <test-file>` to verify the test passes.
- Confirm no unintended test failures in adjacent files.

# Troubleshooting

**Svelte component import errors in tests:**

- Ensure `vi.mock()` calls are at the top level (not inside `describe` or `it`). Vitest hoists
  them, but only if they're at the module scope.

**MSW handler not matching requests:**

- Check that the handler URL and HTTP method match exactly. MSW is strict about trailing slashes
  and query parameters. Use `server.use()` inside the specific test to add one-off overrides.

**`vi.mock()` not intercepting imports:**

- The component under test must be imported with dynamic `import()` **after** `vi.mock()` calls.
  Static `import` at the top of the file bypasses the mock.

**`vi.resetModules()` breaks Svelte 5 component renders (`effect_orphan`):**

- Symptom: `Svelte error: effect_orphan` at render time after adding `vi.resetModules()`
  between tests.
- Root cause: `vi.resetModules()` hands the component-under-test a fresh `svelte` runtime
  through its re-evaluated imports, while `@testing-library/svelte` keeps its original
  runtime — `$effect` calls register against the wrong runtime instance.
- Workaround: one test per file with module-level setup before the harness import, no
  `vi.resetModules()` between tests. Loses cross-test isolation but sidesteps the
  runtime mismatch. Reproduced in `gavingolden/pokemon` PR #39 (commit `af5c5f7`).

**`userEvent` interactions not reflecting in DOM:**

- Ensure you `await` user event calls. `userEvent.setup()` returns an async API — every
  interaction (`.click()`, `.type()`, etc.) must be awaited.

**Flaky tests with timers:**

- Use `vi.useFakeTimers()` in `beforeEach` and `vi.useRealTimers()` in `afterEach`. Advance
  time with `vi.advanceTimersByTime()` instead of relying on real delays.

# Verification

- All new tests pass when run individually.
- No existing tests are broken.
- Tests cover: happy path, one or more error states, one or more edge cases.

# Constraints

- Do NOT test internal component state variables directly. Test the rendered DOM output.
- Do NOT mock Svelte internals (runes, lifecycle). Mock data boundaries only.
- Do NOT render child component trees in unit tests — stub them (see Component Isolation above).
