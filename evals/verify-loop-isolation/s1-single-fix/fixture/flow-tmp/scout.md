# Scout report (fixture)

## affected_modules

- `src/slug.ts` — `slugify`'s truncation is off by one; fix the `slice`
  call so the result length equals `MAX_LEN`.

## relevant_tests

- `src/slug.test.ts` — "truncates at the max length" is the failing case.
