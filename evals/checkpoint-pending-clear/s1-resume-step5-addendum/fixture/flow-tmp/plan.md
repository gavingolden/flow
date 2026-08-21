# Plan (fixture)

## Task 1: add the `--foo` CLI flag

- **Contract:** `parseArgs` accepts `--foo <value>`.
- **Acceptance:** `bun test` passes.

## Task 2: wire `--foo` into the request builder

- **Contract:** the built request carries the `foo` field when `--foo` is set.
- **Acceptance:** `bun test` passes.

## Task 3: document `--foo` in the README

- **Contract:** the README's flag table lists `--foo`.
- **Acceptance:** manual review.
