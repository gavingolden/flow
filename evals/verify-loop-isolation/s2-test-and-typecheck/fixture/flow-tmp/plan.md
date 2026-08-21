# Plan (fixture)

## Task 1: fix the off-by-one truncation bug in `src/slug.ts`

`slugify` must truncate to exactly `MAX_LEN` characters.

- **Acceptance:** `bun test` passes.

## Task 2: fix the type error in `src/other.ts`

`doubled` is declared `number` but assigned a string literal.

- **Acceptance:** `bun run typecheck` passes.
