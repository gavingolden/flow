# reports-service agent guide

- Runtime: Bun, deployed to Cloud Run with `./deploy.sh`. Run the tests with `bun test`.
- Layout: `src/app.ts` holds the HTTP handlers, `src/db.ts` Postgres persistence (Cloud SQL, schema in `migrations/`), `src/queue.ts` Cloud Tasks enqueue, `src/worker.ts` the section worker, `src/llm.ts` the model-API client.
- Keep modules small and single-purpose. No new runtime dependencies without a reason.
