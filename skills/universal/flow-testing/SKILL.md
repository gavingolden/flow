---
name: flow-testing
description: >-
  Write or update unit and integration tests for any language or framework:
  generic test-writing, structure, and coverage guidance. Use when user says
  "write tests", "add test coverage", "test this", "fix failing test", or
  "improve coverage". For Svelte/vitest/Testing Library component specifics,
  defer to flow-testing-svelte.
---

# Goal

Generate comprehensive, isolated tests that cover behavior, not implementation
details — regardless of language or framework. This is the framework-agnostic
core: the testing philosophy, structure, and coverage discipline. Stack-specific
mechanics live in a dedicated skill (Svelte/vitest/Testing Library →
`flow-testing-svelte`).

# When to Use

- User asks to add or update tests for a module, function, or component.
- A refactor has been completed and tests need updating.
- A test is failing and needs debugging.
- Coverage needs to be improved for existing code.

# When NOT to Use

- Writing the implementation itself (defer to the relevant stack skill —
  `flow-svelte`, `flow-tailwind-shadcn`).
- Svelte component / vitest / `@testing-library/svelte` specifics — defer to
  `flow-testing-svelte`.
- Testing database migrations or SQL (defer to `flow-supabase-project`).
- Go backend tests — see `references/go-testing.md`.

# Context

- Test naming and `describe()` conventions: see `AGENTS.md` Testing section.
- Go backend tests: see `references/go-testing.md`.
- For a Svelte/SvelteKit repo, the vitest + `@testing-library/svelte` + MSW
  stack and its component-isolation conventions live in `flow-testing-svelte`.

# Instructions

## 1. File Placement

Create the test file adjacent to the file being tested, following the project's
convention:

- Domain logic: `user-service.ts` → `user-service.test.ts`
- A helper: `bin/foo.ts` → `bin/foo.test.ts`

## 2. Test Structure

- Group tests by: happy paths, empty states, error states, boundary/edge cases.
- Use `it("should <expected behavior>", ...)` (or the language's idiomatic
  equivalent) naming — describe the observable outcome, not the mechanism.

## 3. Arrange-Act-Assert (AAA)

Structure every test body in three clearly separated phases (setup, action,
assertion). Use comments to demarcate each phase when the test is non-trivial.

## 4. Isolation

**Core principle:** Test each unit in isolation from its collaborators. A unit's
tests should only fail when _that_ unit breaks — not when a downstream
dependency changes. Replace heavy or side-effecting collaborators (network,
timers, filesystem, third-party clients) with test doubles at the data
boundary; leave pure/leaf collaborators real. The framework-specific stubbing
mechanics (e.g. `vi.mock()` + stub components for Svelte) live in the stack
skill.

## 5. Behavioral Testing

- Test observable outputs (return values, rendered DOM, emitted events, written
  files), not internal state.
- Prefer the most user-facing / accessible query or assertion the framework
  offers.
- Drive interactions the way a user would, not by poking internals.

## 6. Mocking

- Mock at the data boundary (a client module, an env accessor), not the unit's
  internals.
- Create typed fixtures at the top of the test file.
- Scope global stubs to setup/teardown so they never leak across test files.

## 7. Run and Verify

- Run the project's test command scoped to the file (`npm run test -- <file>`,
  `go test ./...`, etc.) to verify the test passes.
- Confirm no unintended test failures in adjacent files.

# Verification

- All new tests pass when run individually.
- No existing tests are broken.
- Tests cover: happy path, one or more error states, one or more edge cases.

# Constraints

- Do NOT test internal state directly. Test the observable output.
- Do NOT mock the framework's own internals. Mock data boundaries only.
- Do NOT couple a unit's tests to the behavior of its collaborators — isolate
  them.
