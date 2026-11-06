# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Suggest a title for a saved report

**Goal:** A client asks the reports service for a title for any saved report and gets one model-written suggestion back within eight seconds, or a clear reason why not.

## Problem Statement

Each saved report has a slot for a title, and that slot can be empty. Today a client has no way to ask the service to propose one, so whoever presents the report has to read every section and write a title by hand. The service already has a paid model function that writes titles, but nothing a client can call reaches it.

| Evidence | Anchor |
| --- | --- |
| A report carries a nullable title next to its sections | src/db.ts:5 |
| A title-suggestion model function exists; it takes 1–3 s and costs money per call | src/llm.ts:13 |
| No HTTP route calls it; the service exposes only "read a report" and "mark a report shared" | src/app.ts:11, src/app.ts:16 |
| The service is deployed open to anonymous callers | deploy.sh:3 |
| Reports live in a per-process in-memory map, and no route creates one. Only "mark shared" writes, and only to a report that already exists | src/db.ts:9, src/app.ts:20 |

Who is affected, in the product brief's terms: the person presenting a report. They have one more thing to write by hand (**user experience**, priority 1). Every suggestion is a paid call, so **cost** (priority 2) bounds how the endpoint is built.

## Request vetting

- **Hypothesis:** One inline call to the existing title model, behind an 8 s timeout, returns a usable title inside the 10 s interactive budget. No queue, status resource, or stored state is needed, because the suggestion is returned and not saved.
- **Case against:** This would be the first route that starts a paid model call, and the service accepts anonymous traffic. Every request, scripted repeats included, is billed with no cap or per-caller limit [anchor: deploy.sh:3] [anchor: src/llm.ts:13]. The model client as written also has no timeout, no status check, and an unchecked cast of the reply. A hung or malformed upstream response would hold the caller for up to Cloud Run's request limit, or hand back `undefined` as a title [anchor: src/llm.ts:15].
- **Sources:** no outside source: the case rests on committed repo files; the Cloud Run request-limit figure comes from the flow-system-design GCP reference, not from a fetch made in this pass (web research did not run — not a researchable question).
- **Verdict:** adopt-with-conditions: the model call aborts at 8 s, unknown or section-less reports return without any model call, and bounding anonymous spend ships as a ticked follow-up rather than silently.

## Existing-code assessment

- **src/app.ts (route dispatch in `handle`):** keep — two regex-matched branches sharing one JSON response helper. A third branch fits the same shape [anchor: src/app.ts:9]
- **src/llm.ts `suggestTitle`:** simplify — it has no timeout, no HTTP-status check, and casts the reply's `title` without checking it. Add those three before the first public caller depends on it (Task 2) [anchor: src/llm.ts:14]
- **src/db.ts `getReport`:** keep — a read-only lookup by id serves the new route unchanged [anchor: src/db.ts:11]

## Scope Boundary

**In scope:**

- A new `POST /reports/:id/title` route that returns `{ "title": "<suggestion>" }` built from the report's sections.
- Refusals that cost nothing: an unknown report (404) or a report with no non-blank sections (422) never reaches the model.
- Clear failures: 504 when the model gives no answer within 8 s; 502 when it fails or returns no usable title.
- Hardening the title model call: a timeout, a status check, and reply validation.
- First metrics contract and helper for the service: latency and failure-class metrics for this one operation.

**Out of scope:**

- Writing the suggestion into the report's title. The user asked for an endpoint that "returns a suggested title", and the service has no route to set a title.
- Auth, per-caller rate limits, or a Cloud Run instance ceiling. This is the ticked follow-up "Bound paid model spend on the public service".
- Hardening the section-generation model call. It has no caller (src/llm.ts:2), and its 20–60 s runtime needs the queue design, not this inline one.
- Creating or durably storing reports (unticked candidate).
- Caching suggestions, or a "suggest another" variant.

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| A client wanting a title for a saved report has to write one by hand | The client sends `POST /reports/<id>/title` and gets `{ "title": "…" }`, typically in 1–3 s |
| — | An unknown report id returns 404 `{ "error": "not found" }`, the same response the existing routes give |
| — | A report with no non-blank sections returns 422 at once, with no model call |
| — | A model failure returns 502, and no answer within 8 s returns 504, each with a JSON `error` message |

### System flow

- **Before:**
  - No HTTP route reaches the paid model API, so anonymous traffic cannot cause model spend.
  - The title model call waits as long as the upstream holds the connection and returns whatever the reply's `title` field holds.
  - The service records no metrics.
- **After:**
  - Each title request for a report with sections makes exactly one paid model call; unknown and empty reports make none.
  - The title model call aborts after 8 s and rejects non-2xx replies and missing or blank titles as typed failures.
  - Every title request records one latency observation (ok/error) and, on failure, one failure-class count, through a new in-memory metrics helper. No backend is chosen yet.

**Lost:** none — the change is additive. The one behaviour change, to a function that has no callers today, makes it fail loudly where it used to hang or return `undefined`.

## User Stories / Acceptance Criteria

### Story 1: Get a suggested title

- [ ] Given a saved report with sections, when a client sends `POST /reports/<id>/title`, then the response is 200 with `{ "title": "<non-empty string>" }` (test: `bun test src/app.test.ts -t "returns a suggested title"` exits 0).
- [ ] Given the same request, when it succeeds, then the saved report's `title` and `shared` fields are unchanged (test: `bun test src/app.test.ts -t "leaves the saved report unchanged"` exits 0).

### Story 2: Refuse without spending

- [ ] Given no report with that id, when a client sends the request, then the response is 404 `{ "error": "not found" }` and the model API is never called (test: `bun test src/app.test.ts -t "returns 404 for an unknown report"` exits 0).
- [ ] Given a report whose sections are empty or all blank, when a client sends the request, then the response is 422 and the model API is never called (test: `bun test src/app.test.ts -t "returns 422 without a model call"` exits 0).

### Story 3: Fail clearly when the model does

- [ ] Given the model API rejects the request or returns a blank title, when a client sends the request, then the response is 502 with a JSON `error` (test: `bun test src/app.test.ts -t "returns 502 when the model API fails"` exits 0).
- [ ] Given the model API does not answer within the deadline, when a client sends the request, then the response is 504 (tests: `bun test src/app.test.ts -t "returns 504 when the model API times out"` and `bun test src/llm.test.ts -t "aborts after the timeout"` exit 0).

### Story 4: The operation is measured

- [ ] Given any title request, when it completes, then exactly one `reports.title_suggestion.duration` observation is recorded with the right `operation.outcome`, and each failure adds one `reports.title_suggestion.failures` count with its `error.type` (test: `bun test src/app.test.ts -t "records"` and `bun test src/metrics.test.ts` exit 0).

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports.title_suggestion.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | title-suggestion route, through the metrics helper |
| `reports.title_suggestion.failures` | Counter | none | `error.type` (`_OTHER`, `internal`, `invalid_input`, `not_found`, `upstream_error`, `upstream_timeout`) | title-suggestion route, through the metrics helper |

Estimated series: 40 per operation per instance (histogram 2 outcomes × (14 bounds + 3) = 34, plus 6 `error.type` values on the failures counter); samples/month not stated — backend is `none yet`.

**Attributes:** new keys `operation.outcome` (`ok`, `error`) and `error.type` (the closed list below), added as `.flow/metrics.md` `## Attributes` rows

### Error types

New (first list for this repo):

- `_OTHER` — fallback; no listed class fits.
- `internal` — unexpected failure inside the service.
- `invalid_input` — the report has no non-blank sections (client-caused; excluded from the SLO).
- `not_found` — no report with that id (client-caused; excluded from the SLO).
- `upstream_error` — the model API returned non-2xx or no usable title.
- `upstream_timeout` — the model API did not answer within 8 s.

### Dashboard panels

On the spec-only "reports-service overview" dashboard (no URL yet), add:

- Title suggestion latency p50 / p95 / p99, read from the histogram.
- Title suggestion volume and error rate, split by `operation.outcome`.
- Title suggestion failures, split by `error.type`.

### Alerts

burn-rate tiers only — on the new title-suggestion SLO, action `notify`. The routing channel is recorded in `.flow/metrics.md` as unnamed: no alert channel exists in this repo yet.

### SLO

New journey SLO "Title suggestion". SLI: the share of title requests, excluding client-caused `not_found` and `invalid_input`, that return 200 within 5 s. Target: 99% over 28 days.

**As-code:** spec-only — the repo keeps no dashboard or alert config (only `AGENTS.md`, `Dockerfile`, `deploy.sh`, `package.json`, `src/`).

These metrics are recorded in memory but will not appear on any graph until a metrics backend is chosen; `.flow/metrics.md` `## Backend` records `none yet — suggested: Google Cloud Monitoring`.

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | HTTP handler (src/app.ts), model-API client (src/llm.ts), new metrics helper (src/metrics.ts); persistence read-only |
| Domain modules | Existing `getReport` and `suggestTitle`; new zero-dependency metrics helper |
| Data flow | Request → look up report by id → refuse (404/422) or call the model with its sections → return `{ title }`; nothing is written |
| Pattern | Existing regex-matched route branch plus the shared JSON response helper (src/app.ts:16). The one new pattern is the metrics helper, which flow-metrics requires on a repo's first instrumented change |
| Binary-framing check | The request is not framed as a choice. The return-or-save fork is settled by the user's wording ("returns a suggested title") |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| Title suggestion (`POST /reports/:id/title`, one model call) | ~3 s | inline — the caller waits on one bounded paid call | 8 s on the model call (abort signal); inside Cloud Run's 300 s request limit | none server-side; the caller re-sends — one layer, at the client | none — read-only; the suggestion is returned, not stored, so a repeat changes no state | one paid call per request, zero for 404/422; no spend cap exists yet — ticked follow-up |

**Platform:** gcp

**Proportionality:** No queue, status resource, stored `Idempotency-Key`, or server-side retry. The work is one 1–3 s call whose result is returned and not saved, and the system-design rules send generation to a queue only when its result is persisted. There is no in-process rate limiter either: Cloud Run runs several instances, so a per-instance counter caps nothing (see Decision 1).

**Recovery:** none — no table, migration, or bucket is added or changed; the route only reads the existing in-memory store.

**Rollback:** none — an additive route; nothing is cut over, and reverting the commit removes it.

## Technical Constraints

- No new runtime dependencies (AGENTS.md:5). The timeout uses the built-in `AbortSignal.timeout`, tests use the built-in `bun:test`, and the metrics helper is a zero-dependency in-memory recorder.
- Tests run with `bun test` (AGENTS.md:3 and package.json:7). New tests sit next to their modules as `src/*.test.ts`.
- The title model call costs money per call (src/llm.ts:13). The 404 and 422 checks must run before the model call.
- Cost: adds one paid model call per title request that reaches the model, with no cap until the follow-up lands.
- Latency: callers wait inline, typically 1–3 s (src/llm.ts:13) and at most 8 s.

## Open Questions

- [ ] Return the suggestion only, or also write it into the report's title? On redirect to "save it", the route writes the store and the runtime design moves to the queue row.
  - **Stakes:** user — **user experience** (priority 1): if the client expected the title to stick, it would need a save route that does not exist.
  - **Recommended:** return only; the report is never modified — the user specified the outcome [confidence: high] [anchor: user: "returns a suggested title for a saved report"]
- [ ] Ship before any bound on anonymous model spend exists? On redirect to "bound it first", the candidate folds into this plan, which then needs the auth-or-rate-limit decision.
  - **Stakes:** both — **cost** (priority 2): an abusive or buggy client can run up model spend with no ceiling until the follow-up lands.
  - **Recommended:** ship with the 8 s timeout, the zero-call refusals, and the failure metrics; bounding spend is the ticked follow-up — the right bound depends on who calls the service, and an in-process limiter is per-instance on Cloud Run [confidence: medium] [anchor: weighing: risk — a guessed instance ceiling or per-IP limit throttles legitimate callers of the existing routes]
- [ ] What happens for a report whose sections are empty or all blank? On redirect to "call the model anyway", the 422 branch and one test go away.
  - **Stakes:** both — **cost** (priority 2) and **product quality** (priority 4): a paid call on empty input returns a title that describes nothing.
  - **Recommended:** 422 `{ "error": "report has no sections" }` with no model call [confidence: medium] [anchor: weighing: risk — a paid call on empty input buys nothing the client can use]
- [ ] How long may the model take before the request gives up? On redirect, only the default timeout constant changes.
  - **Stakes:** user — **user experience** (priority 1): too short drops slow but valid answers; too long leaves the user waiting past the point of attention.
  - **Recommended:** 8 s — about three times the documented worst case and under the 10 s interactive budget [confidence: medium] [anchor: adjacent: src/llm.ts:13]
- [ ] Which status codes signal model failures? On redirect, only the status mapping in the route changes.
  - **Stakes:** user — **product quality** (priority 4): clients that branch on status need to tell "try again later" from "your request is wrong".
  - **Recommended:** 504 for a timeout, 502 for a failed or unusable reply, both with the existing `{ "error": "…" }` body shape — gateway codes are retryable, and 4xx stays reserved for caller faults [confidence: medium] [anchor: weighing: convention — the existing routes already answer with a JSON `error` body]
- [ ] Should the server retry a failed model call? On redirect to "retry once", add one retry with backoff and double the worst-case wait and spend.
  - **Stakes:** system — **cost** (priority 2): a server retry doubles paid calls exactly when the upstream is failing.
  - **Recommended:** no server retry; the caller re-sends [confidence: medium] [anchor: weighing: risk — stacking a server retry under client retries multiplies spend during an upstream outage]
- [ ] Saved reports only enter the store through code. No route creates one, and the store is per-process memory, so a deployed instance answers 404 for every id. Should this plan also add a way to create reports? On redirect, the plan grows a creation route and a storage decision.
  - **Stakes:** user — **user experience** (priority 1): the endpoint works against the store's contract but has nothing to title in production until reports can be created.
  - **Recommended:** build against the existing read lookup, as the read and share routes already do; creating and durably storing reports stays an unticked candidate [confidence: high] [anchor: src/app.ts:18]
- [ ] Ship the metrics helper and contract now, with no backend to graph them? On redirect to "skip metrics", drop Task 1 and the recording calls in Task 3.
  - **Stakes:** system — **architecture** (priority 3): skipping it leaves the first paid route with no failure or latency record when a backend is chosen.
  - **Recommended:** ship it — this is the repo's first instrumented route, and the closed failure-class list is cheapest to fix while there is one caller [confidence: medium] [anchor: weighing: effort — the helper is one small zero-dependency module, and retrofitting it later touches every route]
- [x] A non-POST request to `/reports/:id/title` falls through to the existing 404 like any unmatched route (src/app.ts:23); no 405 is introduced.
  - **Stakes:** none — resolved without asking
- [x] Any request body is ignored; the title is built only from the stored sections.
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision 1 — How much spend bounding ships in this PR?**

| Branch | What a caller and the bill see | Interruptions per run |
| --- | --- | --- |
| A. Timeout, zero-call refusals, and metrics only; bounding is a follow-up | Every legitimate request is served. Each request that reaches the model is one paid call, with no ceiling under abuse; volume shows in metrics once a backend exists | 0 — fully automated |
| B. A plus an in-process per-IP limit (429 when exceeded) | Each Cloud Run instance counts separately, so the fleet-wide cap is the limit × instance count. The client controls the first `X-Forwarded-For` hop and can spoof it, and users behind a shared address see 429s | 0 for most callers; 1 refused request per caller over the limit |
| C. A plus a Cloud Run instance and concurrency ceiling in the deploy script | Caps concurrent model calls fleet-wide. The ceiling number needs traffic figures the repo does not hold, and it also throttles the existing read and share routes | 0 until traffic exceeds the ceiling, then queued or refused requests on every route |

- **Exclusivity:** B and C are complementary add-ons to A; neither excludes the other.
- **Ranked combinations:** A+C with an owner-supplied ceiling, then A alone, then A+B, then A+B+C. B ranks last because a spoofable per-instance counter adds code without bounding spend.
- **Verdict:** A — ship A now; C and the auth-or-rate-limit choice go to the ticked follow-up, where the owner supplies the ceiling. A guessed ceiling would trade **user experience** (priority 1) for **cost** (priority 2), the wrong way round under the brief's ranking [confidence: medium] [anchor: weighing: risk — a wrong ceiling throttles the existing routes, which make no paid calls]

## Alternatives considered

- **`GET /reports/:id/title-suggestion`** — rejected: GET is defined as safe and cacheable (RFC 9110 §9.2.1), so link prefetchers, crawlers, or caching proxies could trigger or replay paid model calls. POST, as the user asked, avoids that.
- **Save the suggestion into the report's title** — rejected: the user asked for an endpoint that "returns a suggested title". Storing a generated result would also move this to the queue execution model under the system-design rules.
- **A server-side cache of suggestions per report** — rejected: the store and any cache are per-instance memory on Cloud Run (src/db.ts:9), so hits are unreliable, and a cached answer blocks a client from asking for a fresh suggestion.

## Recommendation

**Proceed** — build the route as asked, under the Request-vetting conditions (8 s timeout, zero-call refusals), with spend bounding filed as a ticked follow-up; `src/llm.ts suggestTitle` is a simplify verdict, and its hardening ships as Task 2 [confidence: high] [anchor: src/llm.ts:14]

**Redundancy:** none found — the model-client title function exists (src/llm.ts:14) but no route exposes it; this request is the missing caller, not a duplicate.

## Plan risks

The plan assumes no one drives the open, unauthenticated route in volume before the spend-bounding follow-up lands. Each request that reaches the model is a paid call with no cap, so that assumption is the one whose failure would show up on the bill.

## Cut list

- nothing — plan is minimal: one route, a three-part hardening of an existing call, and the metrics helper the repo's first instrumented route requires. The queue, retry, cache, and rate limiter were already cut (see Proportionality and Decision 1).

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Bound paid model spend on the public service | Medium | Medium | needs its own design/decision session: the open decision is whether to authenticate callers or rate-limit anonymous ones, and what instance ceiling the real traffic supports | this route is the first that lets anonymous callers trigger paid model calls | No |
| Create and durably store reports | Medium | Large | genuinely novel non-trivial feature: a creation route plus a storage choice for a service whose store is per-process memory | the new route titles saved reports, but no route creates one | No |

- [x] Bound paid model spend on the public service — decide auth vs per-caller rate limit, set a Cloud Run instance and concurrency ceiling, and put one spend cap in front of every paid model call.
  - **UX:** none
  - **Problem:** any anonymous caller can trigger unlimited paid model calls through the new title route, because the service deploys open to unauthenticated traffic [anchor: deploy.sh:3]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk: there is no cap on a paid call path open to anyone, and no abuse has been observed [anchor: deploy.sh:3]
  - **Complexity:** Medium — the deploy script, a new limiter or auth check in the request handler, and a spend cap at the model-client choke point
  - **Risk:** Medium — a wrong ceiling or auth change can refuse legitimate callers on every route
  - **If never done:** model spend stays uncapped for as long as the route is public
  - **Verdict:** clears bar — an uncapped paid path open to anonymous callers is a cost exposure under the brief's priority 2, and it outweighs a Medium change that needs one owner decision
- [ ] Create and durably store reports — add a route that creates a report, and move the store off per-process memory so reports survive restarts and are shared across instances.
  - **UX:** a client of a deployed instance can never find a report, because none can be created over HTTP [anchor: src/app.ts:9]
  - **Problem:** reports live in a per-process in-memory map with no creating route, so each Cloud Run instance starts empty [anchor: src/db.ts:9]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — a gap that affects every read route, and the repo holds no evidence whether the stub is deliberate [anchor: src/db.ts:9]
  - **Complexity:** Large — a new route, a datastore choice, a migration, and backups
  - **Risk:** Medium — a new datastore and a recovery path
  - **If never done:** the read, share, and title routes stay unreachable with real data on a deployed instance
  - **Verdict:** below bar — the owner may already have report creation planned elsewhere, and the repo cannot settle that; file it only if the gap is unintended

# Task breakdown

### Task 1: Metrics helper and the repo's metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create the zero-dependency metrics helper with a swappable in-memory recorder, a closed `ErrorType` union (`_OTHER`, `internal`, `invalid_input`, `not_found`, `upstream_error`, `upstream_timeout`), and a typed attribute map for `operation.outcome` and `error.type`. `instrument(op, fn)` records `<op>.duration` in seconds with `operation.outcome`. On a throw it also increments `<op>.failures` with `errorTypeOf(err)`, then rethrows. Create `.flow/metrics.md` with these sections:
  - `## Backend`: `none yet — suggested: Google Cloud Monitoring`
  - `## Namespace`: `reports`
  - `## Attributes`
  - `## error.type values`, marking the client-caused values
  - `## Helper`: `src/metrics.ts`
  - `## Dashboard panels`: the three from the plan
  - `## Dashboards`: reports-service overview, no URL yet
  - `## Alerts`: burn-rate tiers, notify, channel unnamed
  - `## As-code`: spec-only
  - `## SLOs`: Title suggestion
  - `## Coverage`: `reports.title_suggestion`
- **Inputs:** new: src/metrics.ts; new: .flow/metrics.md
- **Outputs:** an importable helper and the committed metrics contract
- **Contract:**
  - **Files:** `src/metrics.ts` (create), `src/metrics.test.ts` (create), `.flow/metrics.md` (create)
  - **Interfaces:**
    - `export type ErrorType = "_OTHER" | "internal" | "invalid_input" | "not_found" | "upstream_error" | "upstream_timeout"`
    - `export type Attributes = { "operation.outcome"?: "ok" | "error"; "error.type"?: ErrorType }`
    - `export interface Recorder { histogram(name: string, seconds: number, attrs: Attributes): void; counter(name: string, attrs: Attributes): void }`
    - `export class OperationError extends Error { constructor(readonly errorType: ErrorType, message?: string) }`
    - `export function errorTypeOf(err: unknown): ErrorType` returns the error's own type for an `OperationError` and `"_OTHER"` for anything else
    - `export const memoryRecorder: Recorder & { histograms: Array<{ name: string; seconds: number; attrs: Attributes }>; counters: Array<{ name: string; attrs: Attributes }>; reset(): void }`
    - `export function setRecorder(r: Recorder): void`
    - `export async function instrument<T>(op: string, fn: () => Promise<T>): Promise<T>`
  - **Call-site edits:** none (first consumer is Task 3)
- **Acceptance criteria:** `bun test src/metrics.test.ts && grep -q 'reports.title_suggestion' .flow/metrics.md`. The tests cover four cases: one `ok` observation and no failure count on success; one `error` observation and one failure count carrying exactly that `error.type` on each `OperationError` path; a non-`OperationError` throw maps to `_OTHER`; and the error is rethrown.

### Task 2: Harden the title model call

- **Skill:** `flow-system-design`
- **Description:** Give `suggestTitle` three behaviours:
  - An explicit timeout: default `TITLE_TIMEOUT_MS = 8000`, passed to `fetch` as `AbortSignal.timeout`, so it also covers reading the body.
  - Non-2xx replies throw `OperationError("upstream_error")`.
  - A missing, non-string, or blank `title` throws `OperationError("upstream_error")`.

  A `TimeoutError` throws `OperationError("upstream_timeout")`. The returned title is trimmed. Leave `generateSection` unchanged (out of scope).
- **Inputs:** src/llm.ts; src/metrics.ts (Task 1, for `OperationError`)
- **Outputs:** a title call that always settles within the timeout and fails with a typed error class
- **Contract:**
  - **Files:** `src/llm.ts` (edit), `src/llm.test.ts` (create)
  - **Interfaces:** `export const TITLE_TIMEOUT_MS = 8000`; `export async function suggestTitle(sections: string[], opts?: { timeoutMs?: number }): Promise<string>`
  - **Call-site edits:** none today (no current caller); Task 3 is the first
- **Acceptance criteria:** `bun test src/llm.test.ts`. The tests stub `globalThis.fetch` and restore it after each test. They cover a trimmed title on 200; `upstream_error` on 500 and on a blank title; and a test named "aborts after the timeout" that passes `timeoutMs: 20` to a fetch stub that only settles when its signal aborts, asserting `upstream_timeout`.

### Task 3: Add the `POST /reports/:id/title` route

- **Skill:** `flow-new-feature`
- **Description:** In `handle`, add a branch matching `^/reports/([^/]+)/title$` for POST, wrapped in `instrument("reports.title_suggestion", …)`. Steps:
  1. Look up the report.
  2. If the report is missing, return 404 `{ error: "not found" }` and record `not_found`.
  3. If no section is non-blank, return 422 `{ error: "report has no sections" }` and record `invalid_input`.
  4. Otherwise call `suggestTitle(report.sections)` and return 200 `{ title }`.

  On an `upstream_timeout` failure return 504 `{ error: "title suggestion timed out" }`. On `upstream_error` return 502 `{ error: "title suggestion failed" }`. On anything else return 500 `{ error: "internal error" }`, recorded as `internal`. The 404 and 422 checks run before any model call, and the route never calls `saveReport`. Record each refusal as a failure inside the instrumented function by throwing an `OperationError` and mapping it to a response outside, so every request yields exactly one duration observation.
- **Inputs:** src/app.ts; src/db.ts; src/llm.ts (Task 2); src/metrics.ts (Task 1)
- **Outputs:** the live route
- **Contract:**
  - **Files:** `src/app.ts` (edit)
  - **Interfaces:** no new exports; `handle(req: Request): Promise<Response>` keeps its signature. Response bodies: 200 `{ title: string }`; 404/422/502/504/500 `{ error: string }`
  - **Call-site edits:** `src/app.ts` `handle` gains one route branch placed before the final 404 fall-through; it imports `suggestTitle` from `./llm` and `instrument`, `OperationError`, `errorTypeOf` from `./metrics`
- **Acceptance criteria:** `bun build src/app.ts --target=bun --outfile=/tmp/reports-app-build.js && grep -q '/title\$/' src/app.ts`

### Task 4: Route tests

- **Skill:** `flow-testing`
- **Description:** Add handler tests that save fixture reports through `saveReport` and call `handle` directly. They stub `globalThis.fetch` for the model API and restore it after each test, call `memoryRecorder.reset()` before each test, and count stub calls to prove the refusals make zero model calls. A timeout is simulated by a stub that rejects with a `DOMException` named `TimeoutError`.
- **Inputs:** src/app.ts (Task 3); src/metrics.ts (Task 1); src/db.ts
- **Outputs:** regression coverage for every response branch and its metrics
- **Contract:**
  - **Files:** `src/app.test.ts` (create)
  - **Interfaces:** one `describe("POST /reports/:id/title")` with tests named exactly:
    - "returns a suggested title"
    - "leaves the saved report unchanged"
    - "returns 404 for an unknown report"
    - "returns 422 without a model call when the report has no sections"
    - "returns 502 when the model API fails"
    - "returns 504 when the model API times out"
    - "records one duration observation per request"
    - "records the failure class on each refusal"
  - **Call-site edits:** none
- **Acceptance criteria:** `bun test src/app.test.ts && bun test`

| Task | Depends on |
| --- | --- |
| 1 | — |
| 2 | 1 |
| 3 | 1, 2 |
| 4 | 3 |

### Skills Summary

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-metrics | Yes (Task 1) | First instrumented route; the repo has no metrics contract or helper |
| flow-system-design | Yes (Task 2) | Timeout, failure classes, and spend posture for a paid outbound call |
| flow-new-feature | Yes (Task 3) | New user-facing route following the existing branch pattern |
| flow-testing | Yes (Task 4) | Handler tests with a stubbed model API and metrics assertions |
| flow-ui-ux | No | No UI surface; the service is JSON-only |
| flow-refactoring | No | The existing dispatch shape is kept; no restructuring needed |

# PR description draft

## TLDR

Clients can now ask the reports service to suggest a title for a saved report and get one within seconds; before, the only option was writing it by hand.

## User-facing changes

- New endpoint: `POST /reports/<id>/title` returns `{ "title": "…" }`, a model-written suggestion based on the report's sections. The saved report is not changed.
- An unknown report id returns 404 `{ "error": "not found" }`, the same response the existing routes give.
- A report with no written sections returns 422 at once and costs nothing.
- If the model fails or returns no usable title, the response is 502; if it gives no answer within 8 seconds, the response is 504. Both carry a JSON `error` message.

## System changes

- Each title request that reaches the model costs one paid model call. Unknown and empty reports cost nothing. There is no cap on calls yet; bounding it is a tracked follow-up.
- The title model call now fails fast and loudly:
  - **Before:** it waited as long as the model API held the connection and passed through whatever came back, even an empty title.
  - **After:** it gives up after 8 seconds and treats an error status or a blank title as a typed failure.
- The service now records latency and failure-class metrics for title suggestions. It is the first measured operation, and it uses a new committed metrics contract.

## Why

The report data model has room for a title, but anyone presenting a report has to write one by hand after reading every section. The service already holds a paid model function that writes titles, and no client can reach it.

## Key decisions

- **Inline, not queued:** one 1–3 second call whose result is returned and not saved, so the caller simply waits, bounded by an 8-second timeout. A queue and a status resource would add moving parts for no gain.
- **Suggest only, never save:** the request asked for a returned suggestion. Saving would need a write path the service does not have, and would move this to queued work.
- **POST, not GET:** GET is defined as safe and cacheable, so prefetchers or proxies could trigger paid calls.
- **No server-side retry:** the caller re-sends. Retrying on the server would double paid calls exactly when the model API is failing.
- **Spend bounding deferred:** auth or a per-caller limit, plus an instance ceiling, ship as a follow-up. A guessed ceiling would throttle the existing routes, and an in-process limiter caps nothing across Cloud Run instances.
- **Out of scope:** hardening the unused section-generation call, and creating or durably storing reports.

## Instrumentation

- Metrics: title-suggestion latency (split ok/error) and failures by class (not found, no sections, model error, model timeout, internal, other), about 40 series per instance.
- Panels on the reports-service overview dashboard: latency p50/p95/p99, volume and error rate, and failures by class. The dashboard is spec-only; it has no URL yet.
- SLO: a new "Title suggestion" journey. 99% of non-client-caused requests return 200 within 5 seconds over 28 days, alerted by burn-rate tiers (notify).
- This PR creates the repo's metrics contract with no backend chosen (suggested: Google Cloud Monitoring). The metrics are recorded in memory and will not show on any graph until a backend is picked.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/app.test.ts -t "returns a suggested title"` — a saved report with sections gets a 200 with a non-empty title.
- [ ] Run `bun test src/app.test.ts -t "leaves the saved report unchanged"` — the report's title and shared flag are untouched.
- [ ] Run `bun test src/app.test.ts -t "returns 404 for an unknown report"` — 404 with no model call.
- [ ] Run `bun test src/app.test.ts -t "returns 422 without a model call"` — an empty report is refused for free.
- [ ] Run `bun test src/app.test.ts -t "returns 502 when the model API fails"` — upstream failure maps to 502.
- [ ] Run `bun test src/app.test.ts -t "returns 504 when the model API times out"` — upstream timeout maps to 504.
- [ ] Run `bun test src/llm.test.ts -t "aborts after the timeout"` — the model call gives up at its deadline.
- [ ] Run `bun test src/app.test.ts -t "records"` — each request yields one latency observation and refusals carry their failure class.
- [ ] Run `bun test src/metrics.test.ts` — the helper records success, each failure class, and the `_OTHER` fallback.
- [ ] Run `grep -q 'reports.title_suggestion' .flow/metrics.md && grep -q 'none yet' .flow/metrics.md` — the metrics contract lists the new operation and its backend status.
- [ ] Run `PORT=8787 bun src/app.ts & sleep 1; code=$(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:8787/reports/missing/title); kill %1; [ "$code" = 404 ]` — the live server answers an unknown id with 404.
