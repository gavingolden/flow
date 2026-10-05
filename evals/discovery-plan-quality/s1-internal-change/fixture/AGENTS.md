# todo-cli agent guide

- Runtime: Bun. Run the tests with `bun test`.
- Layout: `src/index.ts` is the entry point; one module per command under
  `src/commands/`; persistence lives in `src/store.ts`; the `Todo` type and
  its helpers live in `src/todo.ts`.
- Keep modules small and single-purpose. No new runtime dependencies without a
  reason.
