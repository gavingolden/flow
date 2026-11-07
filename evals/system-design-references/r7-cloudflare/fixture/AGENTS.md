# reports-worker agent guide

- Runtime: Cloudflare Workers, deployed with `npx wrangler deploy`. Run the tests with `npx vitest`.
- Layout: `src/index.ts` the fetch handler, `src/db.ts` D1 persistence (binding `DB`), `src/llm.ts` the model-API client.
- Keep modules small and single-purpose. No new runtime dependencies without a reason.
