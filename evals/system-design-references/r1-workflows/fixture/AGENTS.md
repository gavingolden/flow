# reports-service agent guide

- Runtime: Bun, deployed to Cloud Run with `./deploy.sh`. Run the tests with `bun test`.
- Layout: `src/app.ts` holds the HTTP handlers, `src/db.ts` persistence, `src/llm.ts` the model-API client.
- Keep modules small and single-purpose. No new runtime dependencies without a reason.
