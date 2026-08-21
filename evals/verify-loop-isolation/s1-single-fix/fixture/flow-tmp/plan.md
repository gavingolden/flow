# Plan (fixture)

## Task 1: fix the off-by-one truncation bug in `src/slug.ts`

`slugify` must truncate to exactly `MAX_LEN` characters. A test currently
fails because the truncation is off by one.

- **Contract:** `slugify(input).length` must equal `MAX_LEN` for any input
  longer than `MAX_LEN`.
- **Acceptance:** `bun test` passes.
