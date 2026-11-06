# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Suggested title for a saved report

**Goal:** A client can ask the service for a model-suggested title for any saved report and get one back within about five seconds, without being charged twice for unchanged content.

## Problem Statement

The reports service stores generated company reports, and each one has a title slot that usually sits empty. Nothing in the service can fill it, so whoever uses a report has to write a title by hand or leave it blank. The service already holds a paid model call that produces a title from a report's sections, but nothing exposes it. A client that wants a suggestion today has no way to ask for one.

| Evidence | Anchor |
| --- | --- |
| Reports carry a nullable title | src/db.ts:5 |
| A title-suggesting model call exists, costs money, takes 1-3 s, and nothing calls it | src/llm.ts:13-20 (no import of `suggestTitle` anywhere in `src/`) |
| The only routes are read-a-report and mark-as-shared | src/app.ts:11-23 |
| The service is publicly reachable with no caller authentication | deploy.sh:3 (`--allow-unauthenticated`) |

The user asked for the endpoint to "return a suggested title for a saved report". Read that way, the job is producing a title candidate; deciding whether to keep it is a separate step.

## Request vetting

- **Hypothesis:** One synchronous call to the existing title model per request returns a usable title well inside the 10 s interactive budget, and spend stays bounded even though the endpoint is public.
- **Case against:** Taken literally, every POST becomes an uncapped paid call. The model client has no timeout and never checks the response status [anchor: src/llm.ts:14-19], and the service accepts anonymous traffic [anchor: deploy.sh:3]. A slow upstream would hold the request until Cloud Run's request timeout, and a client that retries or double-clicks pays again each time for the same answer.
- **Sources:** no outside source: grounded in the committed repo files plus the Cloud Run ceilings recorded in flow-system-design's GCP mapping, which were not re-fetched in this pass.
- **Verdict:** adopt-with-conditions: the model call is bounded by a 5 s timeout, and a repeat request for a report whose sections have not changed makes zero additional paid calls (asserted by a test that counts upstream calls).

## Existing-code assessment

- **src/app.ts (route chain):** keep — three regex-matched routes in one function. Adding a fourth that mirrors the share route's lookup-then-404 shape fits without restructuring. [anchor: src/app.ts:16-22]
- **src/llm.ts `suggestTitle`:** simplify — it needs an explicit timeout, a non-2xx check and a body-shape check before a public endpoint can depend on it. As written, a hung upstream or an error body becomes a hang or `undefined` in the response. [anchor: src/llm.ts:14-19]
- **src/db.ts `getReport`:** keep — read-only use. Nothing is written back. [anchor: src/db.ts:11-13]

## Scope Boundary

**In scope:**

- `POST /reports/:id/title` returns `200 {"title": "<suggestion>"}` for an existing report that has at least one section.
- `404` for an unknown report, `422` for a report with no sections (no model call made), `502` when the model answers with a failure, `504` when it does not answer in 5 s.
- A content-keyed, in-process memo so repeat requests for unchanged sections reuse the first answer. Overlapping identical requests share one in-flight call. Failures are not cached.
- Hardening the existing title model call: timeout, status check, body check.
- First-time metrics for this operation (the repo has no metrics contract yet).

**Out of scope:**

- Writing the suggestion into the report's stored title. The user asked for the endpoint to "return" one.
- An endpoint for accepting or setting a title (candidate follow-up).
- Authentication for the service (candidate follow-up; every existing route is equally open).
- Hardening `generateSection`, which this feature does not touch.
- Re-roll or alternative suggestions.

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| `POST /reports/r1/title` → `404 {"error":"not found"}` (no such route) | `POST /reports/r1/title` → `200 {"title":"…"}` within about 3 s on a cache miss, near-instant on a repeat |
| No way to get a title suggestion from the service | A client asks once per report and shows the suggestion to its user |
| — | Unknown report → `404`; report with no sections → `422`; model failure → `502`; model timeout → `504` |

### System flow

- **Before:**
  - The title model client is dead code. Nothing in the service makes paid title calls.
- **After:**
  - Each distinct list of report sections causes at most one paid title call per running instance. Later requests are served from memory until the instance restarts.
  - Every title model call is cut off at 5 s, and upstream failures are classified rather than passed through as `undefined`.
  - The service starts recording latency and failure metrics for this one operation, through a new in-memory recorder (no metrics backend yet).

**Lost:** none — additive. One route that returned 404 now answers, and no existing route or field changes.

## User Stories / Acceptance Criteria

### Story 1: Get a suggestion for a saved report

- [ ] Given a saved report with sections, when a client POSTs `/reports/:id/title`, then it gets `200` with a non-empty string `title` and the report's stored `title` is unchanged — `bun test src/app.test.ts`
- [ ] Given that suggestion was already produced, when the client POSTs again for the same unchanged report, then the upstream model is called exactly once in total — `bun test src/llm.test.ts`
- [ ] Given two overlapping requests for the same sections, when both are in flight, then one upstream call serves both — `bun test src/llm.test.ts`

### Story 2: Failures are clear and bounded

- [ ] Given no report with that id, when POSTed, then `404 {"error":"not found"}` and zero upstream calls — `bun test src/app.test.ts`
- [ ] Given a report with an empty `sections` list, when POSTed, then `422` and zero upstream calls — `bun test src/app.test.ts`
- [ ] Given the model answers non-2xx or without a string `title`, when POSTed, then `502`, and a retry calls the model again (failures are not cached) — `bun test src/app.test.ts src/llm.test.ts`
- [ ] Given the model does not answer within the timeout, when POSTed, then `504` — `bun test src/llm.test.ts src/app.test.ts`

### Story 3: The operation is measured

- [ ] Given a success and each failure branch, when the handler runs, then the in-memory recorder holds one duration observation with the matching `operation.outcome` and, on failure, one failures increment with the matching `error.type` — `bun test src/app.test.ts`

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports.title_suggestion.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | `POST /reports/{id}/title` handler |
| `reports.title_suggestion.failures` | Counter | none | `error.type` (`_OTHER`, `internal`, `invalid_input`, `not_found`, `upstream_error`, `upstream_timeout`) | `POST /reports/{id}/title` handler |
| `reports.model.call.duration` | Histogram | seconds | `server.address` (`api.example-llm.com`), `operation.outcome` (`ok`, `error`) | title model call, cache misses only, so its count is the number of paid calls |

Estimated series: 40 per operation for the title suggestion (histogram 2 × 17 + 6 `error.type` values), per instance
Estimated series: 34 per operation for the model call (1 host × 2 outcomes × 17), per instance

**Attributes:** new keys seeded from the starter registry into `.flow/metrics.md` `## Attributes`: `operation.outcome` (`ok`, `error`), `error.type` (the list below), `server.address` (`api.example-llm.com`)

### Error types

New (first list in the repo): `_OTHER` (fallback), `internal` (unexpected failure in this service), `invalid_input` (report has no sections; client-caused), `not_found` (no such report; client-caused), `upstream_error` (the model answered non-2xx or with no title), `upstream_timeout` (the model did not answer within 5 s). The client-caused values are excluded from the availability SLO.

### Dashboard panels

On a new "reports-service overview" dashboard (spec-only): title-suggestion latency p50/p95/p99, title-suggestion failures by `error.type`, and paid title model calls per hour (count of `reports.model.call.duration`), the panel that shows spend.

### Alerts

burn-rate tiers only

### SLO

New journey SLO "get a title suggestion": 99% of non-client-caused requests succeed over 28 days, with the standard burn-rate tiers recorded once in `.flow/metrics.md`.

**As-code:** spec-only — the repo keeps no dashboard or alert config files.

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | HTTP handler (src/app.ts), model-API client (src/llm.ts), new metrics helper (src/metrics.ts); persistence read-only |
| Domain modules | Existing: `handle`, `getReport`, `suggestTitle`. New: a title memo inside the model client, and the metrics helper |
| Data flow | Request → `getReport(id)` → sections → memo lookup → on miss, paid model call with timeout → `{title}` response. Nothing is written back |
| Pattern | Mirrors the share route's lookup-then-404 branch (src/app.ts:16-22) and the `{error: string}` body shape (src/app.ts:14). The memo is new and justified as the cost choke point |
| Binary framing | Not framed as A/B. The implicit fork, "persist the suggestion or only return it", has a middle option: return now and accept through a separate endpoint later (candidate follow-up) |
| Goal anchor | The `422`-before-calling and memo rules exist to serve the goal's "without being charged twice" clause |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| `POST /reports/{id}/title` handler | ~3 s on a miss, <10 ms on a hit | inline — ~3 s, timeout 5 s (inherited from the model call) | 5 s, under the 10 s interactive budget | none server-side; the client is the one retry layer | n/a: read-only, no side effect | new in-process title memo |
| Title model call | 3 s (documented 1-3 s) | inline, single call | 5 s abort on the outbound request | none (one layer: client) | the report's section list (memo key) | new in-process title memo: at most 1 paid call per distinct section list per instance |

**Platform:** gcp

**Proportionality:** No queue or status resource: this is one call of about 3 s that fits the inline row, and the result is not persisted (persisting would move it to the queue row). No `Idempotency-Key` header, because the endpoint has no side effect. No per-caller rate limiter, because spend is already capped by the number of distinct report contents, and callers cannot create reports through this API (src/app.ts has no create route). No shared cache (Memorystore), because reports themselves live in process memory (src/db.ts:9). No memo eviction, because memo growth tracks report content, which is already in memory. No deploy.sh `--max-instances` change.
**Recovery:** none — no table, migration or bucket changes. The memo can be rebuilt by calling the model again.

## Technical Constraints

- No new runtime dependencies (AGENTS.md:5). The timeout uses the built-in `AbortSignal.timeout`, the memo uses a built-in `Map`, and tests use `bun:test`.
- The title call is paid and takes 1-3 s (src/llm.ts:13). Every code path must reach it only through the memo, or the cost bound fails.
- Cloud Run request-based billing (deploy.sh:3) means no work continues after the response. The handler awaits the call inline.
- `suggestTitle` takes only `sections` (src/llm.ts:14), so the section list alone determines the output and is the complete memo key.
- Cost: at most one extra paid title call per distinct report content per running instance. Repeat requests add no spend.

## Open Questions

- [ ] Should the suggestion be written into the report's stored `title`? (Redirect adds a write and, per the persisted-generation rule, moves the call to a queue with a status resource.)
  - **Stakes:** user — if the client expected it saved, the report's title stays empty until something else writes it.
  - **Recommended:** No, return it only. The user's words were "returns a suggested title", and "suggested" implies a separate accept step. [confidence: high] [anchor: user: "returns a suggested title for a saved report"]
- [ ] Should a repeat request for an unchanged report return the same cached suggestion, or make a fresh paid call for a new candidate? (Redirect drops the memo and needs a different cost bound, such as a per-caller rate limit.)
  - **Stakes:** both — user: a "suggest again" button would show the same title. System: without the memo, every click is billed. The brief ranks user experience above cost, but no re-roll was requested.
  - **Recommended:** Return the cached suggestion. It is the only cost bound that holds against anonymous callers without new infrastructure, and re-rolling was not asked for. [confidence: medium] [anchor: weighing: risk — the endpoint is public (deploy.sh:3) and billed per call (src/llm.ts:13)]
- [ ] What should a report with an empty `sections` list return? (Redirect changes the status code and whether a paid call is made.)
  - **Stakes:** system — calling the model with nothing to summarise wastes a paid call on an answer that cannot be meaningful.
  - **Recommended:** `422 {"error":"report has no sections"}` with no model call. [confidence: medium] [anchor: adjacent: src/db.ts:4]
- [ ] Which status codes and body shape should model failures use? (Redirect changes the client contract and tests.)
  - **Stakes:** user — clients branch on status to decide whether to retry.
  - **Recommended:** `502` for an upstream failure and `504` for a timeout, both with the existing `{"error": "<message>"}` body. Both are retryable 5xx codes, and the body shape matches the existing routes. [confidence: high] [anchor: src/app.ts:14]
- [ ] Is 5 s the right model-call timeout? (Redirect changes one constant and the 504 threshold.)
  - **Stakes:** user — too short drops slow-but-valid answers, too long makes the caller wait on a hung upstream.
  - **Recommended:** 5 s. It sits above the documented 3 s worst case and inside the 10 s interactive budget. [confidence: medium] [anchor: weighing: risk — documented 1-3 s latency at src/llm.ts:13]
- [ ] Should the endpoint require authentication when the rest of the service does not? (Redirect adds an auth design to this PR.)
  - **Stakes:** system — an anonymous caller can trigger paid calls, bounded by the memo to one per report content.
  - **Recommended:** Match the existing routes (no auth) in this PR and track service-wide auth as a follow-up. [confidence: medium] [anchor: adjacent: deploy.sh:3]
- [ ] Should a report that already has a title still get a suggestion? (Redirect would return the existing title or a `409`.)
  - **Stakes:** user — a client renaming a report would be blocked if suggestions were refused.
  - **Recommended:** Yes, always suggest from the sections, whatever the stored title is. A suggestion is advisory, and the model input does not include the title. [confidence: medium] [anchor: weighing: footprint — `suggestTitle` takes only sections, src/llm.ts:14]
- [x] Response key name — resolved without asking: `{"title": "<suggestion>"}`, mirroring the model client's `title` field (src/llm.ts:19) and the share route's single-key body (src/app.ts:21).
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision A — what bounds paid spend on a public endpoint?**

| Branch | System flow | User flow (client) | Interruptions per run |
| --- | --- | --- | --- |
| A1: no bound | Every POST makes one paid 1-3 s call. A retry loop or double-click bills each time | Always waits about 3 s, and each "suggest" may return a different title | 0 |
| A2: content-keyed memo (chosen) | First POST for a section list bills once. Repeats and overlapping duplicates reuse that call. Failures are not cached, so a retry tries again | Waits about 3 s the first time, then gets the same title instantly | 0 |
| A3: per-instance rate cap (429) | Caps calls per minute but not the total; needs a number nobody has measured; still bills repeats | Gets `429` under bursts and has to wait and retry | 0 automated; the client handles `429` |

- **Exclusivity:** A1 excludes both others. A2 and A3 are complementary: a cap could be layered on the memo later if a report-create route ever lets callers mint new content.
- **Ranked combinations:** A2 > A2+A3 (the cap adds a tuning knob with nothing to drive it today) > A3 > A1.

Verdict: **A2, content-keyed memo** — it is the only branch whose total spend is bounded by data the caller cannot inflate, and it needs no new dependency or config. [confidence: medium] [anchor: weighing: risk — anonymous ingress (deploy.sh:3) with a per-call price (src/llm.ts:13)]

## Alternatives considered

- **`GET /reports/:id/title` instead of POST** — rejected: the user named `POST`, and a GET that triggers a paid call can be fired by link prefetchers and crawlers, whereas every existing state-touching route is POST (src/app.ts:17).
- **Write the suggestion into `report.title` in the same request** — rejected: the user's words were "returns a suggested title", and persisting a model generation moves it to the queue-plus-status execution model (flow-system-design execution table), which is far outside this request's size.

## Recommendation

**Proceed** — ship the endpoint as asked, with the 5 s timeout and content-keyed memo that the Request vetting conditions require, plus the bundled cleanup of the model client named under Existing-code assessment (`simplify`). [confidence: medium] [anchor: weighing: footprint — three source files plus tests, no new dependency]

**Redundancy:** none found — no route in src/app.ts produces a title, and `suggestTitle` has no caller.

## Plan risks

The weakest assumption is that callers want one stable suggestion per report content. If the client's UI offers "suggest another", the memo makes that button look broken, and the cost bound has to be redesigned (OQ 2).

## Cut list

- nothing — plan is minimal: each piece is either asked for (the route), required by the vetting conditions (timeout, memo), or required for a first runtime surface (metrics helper and contract). Eviction, rate limiting, auth and persistence are already left out.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Authenticate callers of reports-service | Medium | Medium | needs its own design/decision session: the open decision is which caller identity the service trusts (Cloud Run IAM invoker, an API key, or end-user sessions). Today any anonymous caller can read any report and trigger paid calls | The new endpoint adds a paid action to an already-public service | No |
| Endpoint to accept or set a report title | Low | Small | needs its own design/decision session: the open decision is whether a title is set by a generic report update or an explicit accept-suggestion action, and who may write it while the service has no auth | Natural next step after a suggestion is returned | No |

- [x] Authenticate callers of reports-service — the service deploys with anonymous access, so every route, including the new paid title route, is open to anyone with a report id.
  - **UX:** none
  - **Problem:** any anonymous caller can read any report and mark it shared, regardless of the `shared` flag [anchor: src/app.ts:12-15]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk: anonymous ingress is configured, and no misuse has been observed [anchor: deploy.sh:3]
  - **Complexity:** Medium — deploy config plus a check on every route
  - **Risk:** Medium — locking out existing callers whose identity is unknown
  - **If never done:** reports stay world-readable to anyone holding an id, and paid routes stay anonymously triggerable
  - **Verdict:** clears bar — an open read path on a service whose data carries a sharing flag outweighs a medium-sized auth change
- [ ] Endpoint to accept or set a report title — once a suggestion is returned, nothing in this API can save it into the report.
  - **UX:** a client that shows a suggestion has no route to save it through this service [anchor: src/app.ts:9-24]
  - **Problem:** none
  - **Stability/efficiency:** none
  - **Value rank:** 2 — a single-instance gap with no observed caller need; reports are created outside this API [anchor: src/app.ts:9-24]
  - **Complexity:** Small — one route plus tests
  - **Risk:** Low
  - **If never done:** titles stay writable only by whatever creates reports outside this API
  - **Verdict:** below bar — no evidence any caller saves titles through this service, and the write path's authorization depends on the auth candidate

# Task breakdown

### Task 1: Metrics helper and metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create the repo's first metrics helper as a zero-dependency in-memory recorder with a closed `ErrorType` union (`_OTHER`, `internal`, `invalid_input`, `not_found`, `upstream_error`, `upstream_timeout`) and a typed attribute map (`operation.outcome`, `error.type`, `server.address`). Expose `instrument(op, fn, classify)` to record the duration histogram and failures counter, and `recordOutbound(host, outcome, seconds)`. Create `.flow/metrics.md` with `## Backend` = `none yet — suggested: Google Cloud Monitoring`, `## Namespace` = `reports`, and the Attributes, error.type values, Helper, Dashboard panels, Dashboards (none yet), Alerts (burn-rate tiers), As-code (`spec-only`), SLOs ("get a title suggestion", 99% / 28 d) and Coverage (`reports.title_suggestion`, `reports.model.call`) sections, per the plan's `## Instrumentation`.
- **Inputs:** none (first instrumented change); flow-metrics conventions
- **Outputs:** a helper importable by the handler and the model client; a committed metrics contract
- **Contract:**
  - **Files:** `src/metrics.ts` (create), `src/metrics.test.ts` (create), `.flow/metrics.md` (create)
  - **Interfaces:** `export type ErrorType = "_OTHER" | "internal" | "invalid_input" | "not_found" | "upstream_error" | "upstream_timeout"`; `export async function instrument<T>(op: string, fn: () => Promise<T>, classify: (err: unknown) => ErrorType): Promise<T>`; `export function recordOutbound(host: "api.example-llm.com", outcome: "ok" | "error", seconds: number): void`; `export const recorder: { histograms: Array<{ name: string; value: number; attrs: Record<string, string> }>; counters: Array<{ name: string; attrs: Record<string, string> }>; reset(): void }`
  - **Call-site edits:** none (consumers are added in Tasks 2-3)
- **Acceptance criteria:** `bun test src/metrics.test.ts && test -f .flow/metrics.md && grep -q 'upstream_timeout' .flow/metrics.md`

### Task 2: Harden and memoize the title model call

- **Skill:** `flow-system-design`
- **Bundled:** the missing timeout and status check on the title model call, surfaced by the Existing-code assessment (`simplify`)
- **Description:** In the model client, give `suggestTitle` a 5 s `AbortSignal.timeout`, reject a non-2xx response or a body without a non-empty string `title`, and throw a `TitleSuggestionError` whose `kind` is `"upstream_error"` or `"upstream_timeout"`. Record `reports.model.call.duration` via `recordOutbound` on each real call. Add `cachedSuggestTitle(sections)`, which keys a module-level `Map<string, Promise<string>>` on `JSON.stringify(sections)`, stores the in-flight promise so overlapping requests share it, and deletes the entry on rejection so failures are never cached. Leave `generateSection` untouched.
- **Inputs:** Task 1's `src/metrics.ts`; existing `src/llm.ts`; new: in-process title memo in `src/llm.ts`
- **Outputs:** a bounded, classified, memoized title call
- **Contract:**
  - **Files:** `src/llm.ts` (edit), `src/llm.test.ts` (create)
  - **Interfaces:** `export class TitleSuggestionError extends Error { kind: "upstream_error" | "upstream_timeout" }`; `export const TITLE_TIMEOUT_MS = 5000`; `export async function suggestTitle(sections: string[], timeoutMs?: number): Promise<string>` (signature widened, behaviour hardened); `export function cachedSuggestTitle(sections: string[]): Promise<string>`; `export function _resetTitleCache(): void` (test-only)
  - **Call-site edits:** none yet (no current caller of `suggestTitle`; Task 3 adds the first)
- **Acceptance criteria:** `bun test src/llm.test.ts`. The tests stub `globalThis.fetch` and assert: one upstream call across two sequential calls with identical sections; one upstream call across two overlapping calls; a second upstream call after a rejected first call; `kind === "upstream_timeout"` when fetch outlives a shortened timeout; `kind === "upstream_error"` on a 500 status and on a body with no `title`.

### Task 3: `POST /reports/:id/title` route

- **Skill:** `flow-testing`
- **Description:** Add a route branch in `handle` after the share branch. It matches `^/reports/([^/]+)/title$` on POST, looks up the report and returns `404 {"error":"not found"}` when it is missing, returns `422 {"error":"report has no sections"}` for an empty `sections` list without calling the model, and otherwise returns `200 {"title"}` from `cachedSuggestTitle(report.sections)`. It maps `TitleSuggestionError` kind `upstream_error` to `502` and `upstream_timeout` to `504`, both as `{"error": ...}`. It never calls `saveReport`. Wrap the branch in `instrument("reports.title_suggestion", …)`, with a classifier that maps not-found to `not_found`, empty sections to `invalid_input`, the two error kinds to themselves, and anything else to `internal`.
- **Inputs:** Task 1's `src/metrics.ts`; Task 2's `src/llm.ts`
- **Outputs:** the user-facing endpoint
- **Contract:**
  - **Files:** `src/app.ts` (edit), `src/app.test.ts` (create)
  - **Interfaces:** no new exports; `handle(req: Request): Promise<Response>` gains one route
  - **Call-site edits:** `src/app.ts` `handle`: new POST `/title` branch importing `cachedSuggestTitle` and `TitleSuggestionError` from `./llm` and `instrument` from `./metrics`
- **Acceptance criteria:** `bun test src/app.test.ts`. The tests seed reports via `saveReport`, stub `globalThis.fetch`, and assert: 200 plus the title, with the stored `title` unchanged; 404 with zero fetches; 422 with zero fetches; 502; 504; and one recorder duration observation per request with the correct `operation.outcome` and failures `error.type`.

| Task | Depends on |
| --- | --- |
| 1 | — |
| 2 | 1 |
| 3 | 1, 2 |

### Skills Summary

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-metrics | Yes (Task 1) | First runtime surface with no metrics contract; creates the helper and `.flow/metrics.md` |
| flow-system-design | Yes (Task 2) | Timeout, failure classification and the cost-bounding memo on a paid outbound call |
| flow-testing | Yes (Task 3) | The route's contract is mostly status-code and zero-upstream-call assertions |
| flow-new-feature | No | The supervisor's implement phase drives tasks, so no separate scaffold is needed |
| flow-ui-ux | No | No UI surface; the service is HTTP JSON only |

# PR description draft

## TLDR

Clients can now get a model-suggested title for any saved report in about three seconds; previously the service could not produce one, and repeat requests for unchanged content now cost nothing.

## User-facing changes

- New endpoint: `POST /reports/{id}/title` returns `{"title": "…"}`, a suggested title built from the report's sections. The report's stored title is not changed.
- Asking again for a report whose sections have not changed returns the same suggestion instantly, with no extra paid model call.
- Clear failure answers: `404` for an unknown report, `422` for a report with no sections (no model call made), `502` when the model fails, `504` when it takes longer than 5 seconds.

## System changes

- The title model call is now bounded and classified:
  - **Before:** the call had no timeout and passed upstream errors through unchecked.
  - **After:** the call gives up after 5 seconds and reports either an upstream failure or a timeout.
- Paid title calls are now capped by report content: at most one call per distinct set of report sections per running instance. That is about one extra paid call per report, plus one per instance restart.
- The service records its first metrics: latency and failures for title suggestions, plus a count of paid model calls. They go into an in-memory recorder only.

## Why

Saved reports have a title slot that nothing in the service can fill, so titles get typed by hand or left blank, even though the service already pays for a model that can write them. The service is publicly reachable, so any new paid action has to be safe against repeated or anonymous calls.

## Key decisions

- Return the suggestion without saving it. The request asked for a "suggested" title, and saving a model generation would call for a queued, status-tracked design.
- Cap spend by remembering the answer for unchanged content, instead of rate-limiting callers. Callers cannot create reports through this service, so total spend stays bounded no matter who calls. The trade-off is no re-roll.
- 5 second limit on the model call: above its documented 1-3 second range, inside the 10 second interactive budget.
- No authentication added; this matches every existing route. Service-wide authentication is filed as a follow-up.
- Bundled: the missing timeout and status check on the existing title model call.

## Instrumentation

- Metrics: title-suggestion latency (split by success or failure), title-suggestion failures by failure type, and paid model-call latency, whose count is the number of paid calls.
- Panels (spec-only, on a new "reports-service overview" dashboard): suggestion latency p50/p95/p99, failures by type, paid model calls per hour.
- SLO: new "get a title suggestion" journey, 99% of non-client-caused requests succeed over 28 days, with burn-rate alert tiers only.
- This PR creates the repo's metrics contract with no metrics backend yet (suggested: Google Cloud Monitoring). These metrics are recorded in memory and will not show on any graph until a backend is chosen.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/app.test.ts` — the 200, 404, 422, 502 and 504 cases pass, and the stored title stays unchanged.
- [ ] Run `bun test src/llm.test.ts` — the repeat-request, overlapping-request, failure-not-cached and timeout cases pass, each asserting the upstream call count.
- [ ] Run `bun test src/metrics.test.ts` — the duration and failure-type emission cases pass.
- [ ] Run `grep -q 'upstream_timeout' .flow/metrics.md && grep -q 'reports.title_suggestion' .flow/metrics.md` — the metrics contract lists the new failure types and the instrumented operation.
