---
name: testing
description: >-
  Write or update unit and integration tests for Svelte components and domain
  logic. Use when user says "write tests", "add test coverage", "test this
  component", "fix failing test", "vitest", or "testing library".
---

# Goal

Generate comprehensive, isolated unit tests using Vitest and Testing Library that cover behavior, not implementation
details.

# When to Use

- User asks to add or update tests for a Svelte component or domain module
- The `ui` skill hands off a completed component for testing
- A refactor has been completed and tests need updating
- A test is failing and needs debugging

# When NOT to Use

- Writing the component itself (defer to `svelte` or `tailwind-shadcn`)
- End-to-end or browser-based testing
- Testing database migrations or SQL (defer to `supabase`)

# Context

- Testing stack: Vitest + `@testing-library/svelte` + `@testing-library/user-event`
- MSW is configured globally via the project's vitest setup (commonly `vitest-setup.ts`) for API mocking
- Mock handlers live in the project's mocks directory (commonly `src/mocks/handlers.ts`)
- Test naming and `describe()` conventions: see `AGENTS.md` Testing section
- Go backend tests: see `references/go-testing.md`

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
