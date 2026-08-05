You are reviewing a small TypeScript codebase for correctness bugs (attached: `src/pagination.ts`, `src/pricing.ts`, `src/cart.ts`, `src/report.ts`). No other files exist in this codebase.

This is a batch cart-pricing pipeline: `pagination.ts` splits a cart's items into pages, `pricing.ts` computes per-item discounts and looks up tax rates, `cart.ts` prices a cart and computes a checkout total, and `report.ts` formats a receipt line per order.

Find every correctness defect in this code — a place where the code does not do what its surrounding context (types, comments, other call sites) implies it should do. For each defect, report:

- the file and line number,
- a one-sentence description of what's wrong,
- what the correct behavior should be.

Do not report style preferences, missing tests, or missing documentation — only genuine correctness bugs that would produce a wrong result or a runtime error on some real input.
