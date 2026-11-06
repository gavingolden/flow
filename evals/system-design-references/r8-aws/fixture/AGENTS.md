# reports-api agent guide

- Runtime: Node 20 on AWS Lambda behind API Gateway (REST), deployed with `sam deploy` from `template.yaml`. Run the tests with `npm test`.
- Layout: `src/handlers/` Lambda handlers, `src/db.ts` DynamoDB persistence (table `Reports`), `src/llm.ts` the model-API client.
- Keep modules small and single-purpose. No new runtime dependencies without a reason.
