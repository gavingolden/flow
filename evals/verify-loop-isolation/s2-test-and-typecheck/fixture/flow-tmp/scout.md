# Scout report (fixture)

## affected_modules

- `src/slug.ts` — `slugify`'s truncation is off by one.
- `src/other.ts` — a planted type error (a string assigned to a
  `number`-typed export).

## relevant_tests

- `src/slug.test.ts` — "truncates at the max length" is the failing case.
- `tsc --noEmit` (via `bun run typecheck`) fails on `src/other.ts`.
