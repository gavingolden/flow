# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Suggested report titles

**Goal:** A caller asks for a title on a saved report and gets a model-written suggestion back within a few seconds, with daily model spend held under a stated ceiling.

## Problem Statement

The reports service stores company reports and lets callers read and share them. Each report has an optional title, but nothing helps a caller write one, even though the service already has a way to ask the language model for a title. Today callers either write every title by hand or leave it blank, and the paid title capability the service already contains goes unused.

| Fact | Evidence |
| --- | --- |
| Reports carry a nullable title | [anchor: src/db.ts:5] |
| A model call that suggests a title from a report's sections already exists, takes 1-3 s and costs money per call | [anchor: src/llm.ts:13] |
| No HTTP route reaches it: only read and share routes exist, and nothing else calls the model client | [anchor: src/app.ts:11] — `grep -rn suggestTitle src` → only the definition |
| The service is deployed open to the public internet, with no caller authentication | [anchor: deploy.sh:3] |
| The model client has no timeout and never checks the response status | [anchor: src/llm.ts:15] |
| Reports live in process memory, per instance | [anchor: src/db.ts:9] |

Who is affected: whoever builds titles for saved reports through this API. Ranked against the product brief, the user-experience priority is served by one call replacing hand-written titles; the cost priority is the live concern, because every request spends money on a public endpoint.

## Request vetting

- **Hypothesis:** A synchronous endpoint that calls the existing title-suggestion model function returns a usable title inside the 10 s interactive budget, and its spend can be bounded without adding a datastore.
- **Case against:** As literally asked, this becomes the first endpoint that triggers a paid model call [anchor: src/llm.ts:13] on a service deployed with public unauthenticated access [anchor: deploy.sh:3], so any anonymous client can loop requests into unbounded spend. The client also has no timeout and no status check [anchor: src/llm.ts:19], so an upstream failure answers 200 with an empty body and a hung upstream holds the request until the platform kills it.
- **Sources:** no outside source: the research gate judged this a wiring change with no external factual question; grounded in the committed repo files above.
- **Verdict:** adopt-with-conditions: the model call carries a 5 s timeout and passes through one per-instance daily call cap, and the deploy sets an instance ceiling, so worst-case model calls per day equal cap × max instances and that number is stated in the PR.

## Existing-code assessment

- **src/app.ts:** keep — the regex-route branch shape fits; the new route mirrors the share branch beside it. [anchor: src/app.ts:16]
- **src/llm.ts:** simplify — two copies of fetch-and-parse with no timeout and no status check; extract one private call helper that owns the timeout, the status check, the spend cap and the outbound timing, then build the new endpoint on it. [anchor: src/llm.ts:19]
- **src/db.ts:** keep — the endpoint only reads a report and never writes. [anchor: src/db.ts:11]
- **deploy.sh:** keep — extend the existing deploy command with an instance ceiling and per-instance concurrency. [anchor: deploy.sh:3]

## Scope Boundary

**In scope:**

- `POST /reports/{id}/title` returns `{ "title": "<suggestion>" }` for an existing report, without changing the stored report.
- Clear failures: unknown report (404), report with no sections (422, no model call), daily cap reached (503 with `Retry-After`), model timeout (504), model error (502).
- Model client hardening: 5 s timeout on the title call, status and shape checks, and one per-instance daily model-call cap that every model call passes through.
- Deploy ceilings: a maximum instance count and per-instance concurrency, so the cap has a fleet-wide meaning.
- The first metrics contract for the service (latency, failures by type, model-call latency), recorded in memory until a backend is chosen.

**Out of scope:**

- Saving the suggestion as the report's title (see Open Questions), and any endpoint to set a title.
- Caller authentication for the service (candidate follow-up).
- Durable report storage (candidate follow-up).
- Caching suggestions, multiple suggestions per call, and request bodies such as tone or length hints.

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| No way to get a title suggestion; `POST /reports/{id}/title` answers 404 `{"error":"not found"}` for every id | The same request answers 200 `{"title":"…"}` for an existing report in about 1-3 s |
| — | An unknown report still answers 404; a report with no sections answers 422 and costs nothing |
| — | When the day's model-call budget is used up, the caller gets 503 with a `Retry-After` until the next UTC day |
| — | A slow or failing model answers 504 or 502 within about 5 s instead of hanging or returning an empty 200 |

### System flow

- **Before:**
  - No request path spends money; the model client is dead code with no timeout and no budget.
  - The deploy sets no instance ceiling, and the service emits no custom metrics.
- **After:**
  - One request path makes at most one paid model call, bounded by a 5 s timeout and a per-instance daily cap.
  - The deploy caps instances and per-instance concurrency, so worst-case daily model calls = cap × max instances.
  - Title-request latency, failures by type and model-call latency are recorded through one metrics helper.

**Lost:** the service can no longer scale past the new instance ceiling, which limits read and share traffic too; and after the daily cap is hit, title requests are refused until the next UTC day.

## User Stories / Acceptance Criteria

### Story 1: Get a suggested title

- [ ] Given a saved report with at least one section, when a caller sends `POST /reports/{id}/title`, then the response is 200 `{"title": "<model title>"}` — asserted by `bun test src/app.test.ts` with the model call stubbed
- [ ] Given that request succeeds, when the caller then reads `GET /reports/{id}`, then the stored title is unchanged — asserted in `src/app.test.ts`
- [ ] Given no report with that id, when the caller sends the request, then the response is 404 `{"error":"not found"}` and no model call is made — asserted in `src/app.test.ts`
- [ ] Given a report with zero sections, when the caller sends the request, then the response is 422 and no model call is made — asserted in `src/app.test.ts`

### Story 2: Bounded failure and spend

- [ ] Given the model does not answer within 5 s, when the caller sends the request, then the response is 504 — asserted by `bun test src/llm.test.ts src/app.test.ts` with a hanging stub
- [ ] Given the model answers non-2xx or without a string title, when the caller sends the request, then the response is 502 — asserted in `src/app.test.ts`
- [ ] Given the instance has made its daily cap of model calls, when the caller sends the request, then the response is 503 with a numeric `Retry-After` header and no model call is made — asserted in `src/llm.test.ts` and `src/app.test.ts`
- [ ] Given the deploy script, when it is read, then it sets an instance ceiling and per-instance concurrency — `grep -q -- '--max-instances' deploy.sh && grep -q -- '--concurrency' deploy.sh`

### Story 3: Observable

- [ ] Given any title request, when it completes, then one `reports.title_suggest.duration` observation is recorded with the right `operation.outcome`, and each failure adds one `reports.title_suggest.failures` increment with exactly its `error.type` — asserted by `bun test src/metrics.test.ts src/app.test.ts` against the in-memory recorder

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports.title_suggest.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | title request handler |
| `reports.title_suggest.failures` | Counter | none | `error.type` (`_OTHER`, `internal`, `invalid_input`, `not_found`, `rate_limited`, `upstream_error`, `upstream_timeout`) | title request handler |
| `reports.model_api.duration` | Histogram | seconds | `server.address` (`api.example-llm.com`), `operation.outcome` (`ok`, `error`) | model client call helper |

Estimated series: 41 per operation for the title request (histogram 2 outcomes × 17, plus 7 `error.type` values); samples/month: about 1.77 million per instance at a 60 s export interval (41 series, up to 17 samples per histogram point, × 43,200), about $0.11 a month per instance on the OTLP route.

Estimated series: 34 per operation for the model call (1 host × 2 outcomes × 17); samples/month: about 1.47 million per instance at 60 s, about $0.09 a month per instance.

These are recorded in memory only until a metrics backend is chosen, so they cost nothing today.

**Attributes:** registers `operation.outcome` (`ok`, `error`), `error.type` (the closed list below), `server.address` (`api.example-llm.com`), added as `.flow/metrics.md` `## Attributes` rows.

### Error types

New list, seeded from the starter values: `_OTHER` (fallback), `internal` (unexpected failure in this service), `invalid_input` (the report has no sections; client-caused), `not_found` (no report with that id; client-caused), `rate_limited` (this instance's daily model-call cap is used up), `upstream_error` (the model answered non-2xx or without a title), `upstream_timeout` (the model did not answer within 5 s).

### Dashboard panels

On a new "Reports service overview" dashboard: title-request rate and success vs failure, failures by `error.type`, title-request latency p50/p95/p99, and model-call latency p50/p95/p99.

### Alerts

| Signal | Condition | Sustained for | Action | Routes to | Dashboard |
| --- | --- | --- | --- | --- | --- |
| `reports.title_suggest.failures` with `error.type=rate_limited` | > 0 | 5 min | notify | reports-service owner channel (named in `.flow/metrics.md` when a backend is chosen) | Reports service overview |

Plus the standard burn-rate tiers for the SLO below.

### SLO

New journey SLO "get a title suggestion": 99% of title requests, excluding client-caused (`not_found`, `invalid_input`) and deliberate cap refusals (`rate_limited`), succeed within 5 s over 30 days.

**As-code:** spec-only — the repo keeps no dashboard or alert config and has no metrics backend yet.

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | HTTP handler, model-API client, deploy config; no persistence change |
| Domain modules | existing `src/app.ts`, `src/llm.ts`, `src/db.ts` (read only); new single-purpose `src/spend-cap.ts` and `src/metrics.ts` |
| Data flow | request → read report from memory → one paid model call with the report's sections → return the title; nothing is written |
| Pattern | the existing regex-route handler pattern (share route); new: one spend-cap choke point inside the model client, justified by the public paid endpoint |
| Binary-framing check | the request is not framed as A-or-B; the real fork (return vs persist) is in Open Questions |
| Goal anchor | every decision is checked against "suggestion back within a few seconds, spend under a stated ceiling" — this is why the result is not persisted (that would force a queue) and why the cap is mandatory |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| Title request (`POST /reports/{id}/title`) | ~3 s | inline — ~3 s, timeout 5 s on its one model call, inside the 10 s interactive budget | 5 s (model call); handler adds only an in-memory read | none server-side; the caller may re-send, and each re-send is a new paid call counted by the cap | none — the request writes nothing, and a repeat is a deliberate new suggestion | new per-instance daily model-call cap, plus the deploy instance ceiling |
| Model title call | ~3 s | inline outbound call through the shared call helper | 5 s | none | none — no side effect besides spend | the same cap, enforced once in the shared call helper |

**Platform:** gcp

**Proportionality:** no queue, status resource or worker — the result is not persisted and the stated 1-3 s call fits the inline row; no shared spend ledger — the service has no datastore, so the cap is per instance and made fleet-wide by the instance ceiling; no idempotency-key header, because nothing is created or charged beyond the counted call; no cache.

**Recovery:** none — no table, migration or bucket is added; the cap counter is regenerable and resets each UTC day.

## Technical Constraints

- No new runtime dependencies (AGENTS.md "No new runtime dependencies without a reason"): the timeout uses the built-in `AbortSignal.timeout`, and the metrics helper is a zero-dependency in-memory recorder.
- Keep modules single-purpose (AGENTS.md): the cap and the metrics helper are their own modules; the handler stays in `src/app.ts`, the model call in `src/llm.ts`.
- Nothing may continue after the response: Cloud Run request-based billing throttles CPU once the response is sent (https://docs.cloud.google.com/run/docs/configuring/billing-settings), so the model call completes before the handler answers.
- Cost: every successful or failed title request that reaches the model is one paid call [anchor: src/llm.ts:13]; worst case per day = cap × max instances, and a restarted instance starts a fresh count.
- Latency: the title request adds a 1-3 s model wait, bounded at 5 s.

## Open Questions

- [ ] Should the suggestion also be saved as the report's title? — redirect to "save it" moves model generation whose result is persisted onto a queue with a status resource (the system-design rule for persisted generation), adding a queue, a worker and a status read, and turns this into a multi-task async design
  - **Stakes:** both — saving silently overwrites a title the user may have written, and it changes the runtime shape and the cost of every request
  - **Recommended:** return only, never write — the user asked for an endpoint that "returns a suggested title", and a suggestion the caller has not accepted should not overwrite their data [confidence: high] [anchor: user: "returns a suggested title for a saved report"]
- [ ] **Q1** What daily ceiling on model calls, and what instance ceiling, should the service run under? — the plan ships placeholders of 500 calls per instance per UTC day, 2 max instances and 20 concurrent requests per instance, so worst case 1,000 title calls a day; an answer changes one constant and two deploy flags
  - **Stakes:** both — too low and callers see 503s on normal days; too high and an anonymous loop spends up to the ceiling every day
  - **Needs user input:** user-held preference — the spend budget per day and the per-call price of the model API are the owner's to set
- [ ] What should a report with no sections return? — redirect changes one branch in the handler and its test
  - **Stakes:** user — the caller gets a clear refusal instead of a billed, meaningless title
  - **Recommended:** 422 `{"error":"report has no sections"}` with no model call — a paid call on empty input buys a title with nothing behind it, and 422 marks it permanent so clients do not retry [confidence: medium] [anchor: weighing: risk — a billed call on empty input returns a title unrelated to any content]
- [ ] Which statuses for cap reached, model timeout and model error? — redirect changes status mapping in the handler and its tests
  - **Stakes:** user — clients decide whether to retry from the status code
  - **Recommended:** 503 with `Retry-After` (seconds to the next UTC day) for the cap, 504 for timeout, 502 for model error, all in the existing `{ "error": "<message>" }` body shape — retryable vs permanent stays distinguishable and the body matches the other routes [confidence: medium] [anchor: adjacent: src/app.ts:14]
- [x] Route shape and method — resolved without asking: `POST /reports/{id}/title` as the user wrote it; POST fits because each call spends money and is not safe to repeat blindly
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision A — How is spend bounded on a public endpoint that makes a paid call per request?**

| Branch | End-to-end flow | Interruptions per run | Worst-case daily model calls |
| --- | --- | --- | --- |
| A1: timeout only, no cap | A caller sends a request and gets a title in ~3 s; an anonymous loop gets a title for every request | 0 | unbounded — capped only by how fast the platform scales |
| A2: per-instance daily cap at the model-client choke point, plus deploy instance ceiling | A caller sends a request and gets a title in ~3 s; once the day's budget is used, the caller gets 503 with `Retry-After` and waits until the next UTC day | 0 on normal days; 1 refusal per request after the cap | cap × max instances (1,000 with the Q1 placeholders), plus one fresh count per instance restart |
| A3: require caller authentication | Every existing caller of read and share must now present credentials; anonymous callers are refused | 1 credential setup per caller, once | unbounded per authenticated caller unless A2 is also applied |

- **Exclusivity:** A1 and A2 are mutually exclusive; A2 and A3 are complementary; A3 changes access to every existing route, because the deploy flag is service-wide [anchor: deploy.sh:3].
- **Ranked combinations:** 1. A2 alone — bounds cost now with no change for existing callers; 2. A2 + A3 — strongest, but A3 needs its own decision on caller identity (candidate follow-up); 3. A3 alone — still unbounded per caller; 4. A1 — no ceiling at all.

Verdict: **A2** — the cost priority wins over the zero-friction of A1, and A3's effect on every existing caller needs its own session [confidence: medium] [anchor: weighing: risk — deploy.sh:3 makes the service public, so without a cap one anonymous loop sets the day's spend].

## Alternatives considered

- **Queue the suggestion and answer 202 with a status resource** — rejected: the result is not persisted and the stated model latency is 1-3 s (src/llm.ts:13), inside the 10 s interactive budget, which is the inline row of the system-design execution table.
- **Cache suggestions per report** — rejected: reports live in a per-instance in-memory map (src/db.ts:9), so a cache would also be per instance and empty after every restart, and the daily cap already bounds spend.

## Recommendation

**Proceed** — the feature reuses an existing model call behind one new route; it ships with Request vetting's conditions (5 s timeout, daily cap, instance ceiling), plus the bundled simplification of the model client (one shared call helper), with the budget numbers left to Q1 [confidence: medium] [anchor: adjacent: src/app.ts:16].

**Redundancy:** none found — the existing model-client title function is reused, not duplicated; no route exposes it today.

## Plan risks

The spend bound rests on an in-memory per-instance counter: every instance restart or scale-out starts a fresh count, so if the platform churns instances under a flood the real daily ceiling is cap × instances × restarts, not the stated cap × instances.

## Cut list

- No environment-variable knob for the cap — a code constant changed with the same deploy is enough until a second reader needs to tune it.
- No outbound failures counter for the model call — the title-request failures counter already splits `upstream_error` and `upstream_timeout`, and the model call has one caller.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Durable report storage | High | Medium | needs its own design/decision session: the open decision is which durable store backs reports; reports in process memory are lost on every restart or deploy and not visible across instances | the title route reads reports, so a report saved on one instance 404s on another | No |
| Caller authentication for the reports service | Medium | Medium | needs its own design/decision session: the open decision is which caller identity to require (platform IAM invoker, API key, or end-user login), and it changes access to every existing route | the daily cap here bounds spend, but anyone can still use up the day's budget | No |

- [x] Durable report storage — reports are held in process memory, so every deploy or restart loses all of them and each instance sees a different set.
  - **UX:** a caller who saved a report gets 404 after the next deploy, or from a different instance [anchor: src/db.ts:9]
  - **Problem:** saved reports do not survive a restart and are not shared across instances [anchor: src/db.ts:9]
  - **Stability/efficiency:** none
  - **Value rank:** 5 — data loss on every deploy, with no workaround inside the service [anchor: src/db.ts:9]
  - **Complexity:** Medium — the persistence module and the deploy config, plus a datastore choice
  - **Risk:** Medium — the store choice and its migration need their own review
  - **If never done:** every deploy keeps erasing every saved report
  - **Verdict:** clears bar — losing all reports on each deploy outweighs a Medium change with its own design session
- [ ] Caller authentication for the reports service — the service is deployed open to anyone, so any client can read, share or request titles for any report id.
  - **UX:** none
  - **Problem:** any anonymous client can call every route, including the paid title route [anchor: deploy.sh:3]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk; nothing in the repo shows whether public access is intended [anchor: deploy.sh:3]
  - **Complexity:** Medium — deploy config, a check on every route, and every existing caller's setup
  - **Risk:** Medium — breaks any current anonymous caller
  - **If never done:** anyone can use up the day's model-call budget and read any report by id
  - **Verdict:** below bar — whether public access is intended is not knowable from the repo, and this PR's cap already bounds the cost exposure

# Task breakdown

### Task 1: Metrics helper and metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create the zero-dependency metrics helper with a swappable recorder (in-memory by default) and the closed `ErrorType` and attribute types that mirror the new `.flow/metrics.md`. Create `.flow/metrics.md` with `## Backend` = `none yet — suggested: Google Cloud Monitoring via OTLP, export interval 60 s` (route rules per the flow-metrics backends reference), `## Namespace` = `reports`, the `## Attributes` and `## error.type values` rows from the plan's Instrumentation section, `## Helper` = `src/metrics.ts`, the dashboard panel, alert and SLO rows, `## As-code` = `spec-only`, and `## Coverage` listing `reports.title_suggest` and `reports.model_api`.
- **Inputs:** none
- **Outputs:** importable metrics helper; committed metrics contract
- **Contract:**
  - **Files:** create `src/metrics.ts`, create `src/metrics.test.ts`, create `.flow/metrics.md`
  - **Interfaces:** `export type ErrorType = "_OTHER" | "internal" | "invalid_input" | "not_found" | "rate_limited" | "upstream_error" | "upstream_timeout"`; `export type ServerAddress = "api.example-llm.com"`; `export type Attributes = { "operation.outcome"?: "ok" | "error"; "error.type"?: ErrorType; "server.address"?: ServerAddress }`; `export interface Recorder { histogram(name: string, seconds: number, attrs: Attributes): void; counter(name: string, attrs: Attributes): void }`; `export function createInMemoryRecorder(): Recorder & { histograms: Array<{ name: string; seconds: number; attrs: Attributes }>; counters: Array<{ name: string; attrs: Attributes }> }`; `export function setRecorder(r: Recorder): void`; `export function recordOperation(op: string, seconds: number, errorType?: ErrorType): void` (records `<op>.duration` with outcome `error` when `errorType` is set, else `ok`, and one `<op>.failures` increment when set); `export async function timeOutbound<T>(op: string, host: ServerAddress, fn: () => Promise<T>): Promise<T>` (records `<op>.duration` with `server.address` and outcome)
  - **Call-site edits:** none (consumers arrive in Tasks 2 and 3)
- **Acceptance criteria:** `bun test src/metrics.test.ts && test -f .flow/metrics.md && grep -q 'upstream_timeout' .flow/metrics.md` — success, failure-per-type and outbound-timing emission specs pass against the in-memory recorder

### Task 2: Harden the model client and add the daily call cap

- **Skill:** `flow-system-design`
- **Bundled:** the model client's missing timeout and missing status/shape check, found during discovery
- **Description:** Add a single-purpose per-instance daily model-call cap (resets at UTC midnight; placeholder 500, see Q1). In the model client, extract one private call helper used by both model functions: it consumes the cap first (throwing `cap_exhausted` without calling out), fetches with `AbortSignal.timeout(timeoutMs)`, maps an abort to `timeout`, a non-2xx status or a missing string field to `upstream`, and times the call via `timeOutbound("reports.model_api", "api.example-llm.com", …)`. The title call uses a 5 s timeout; the unused section call uses 90 s (above its stated 60 s worst case).
- **Inputs:** `src/metrics.ts` from Task 1; existing `src/llm.ts`
- **Outputs:** a model client that always fails fast with a typed error and never exceeds the daily cap
- **Contract:**
  - **Files:** create `src/spend-cap.ts`, edit `src/llm.ts`, create `src/llm.test.ts`
  - **Interfaces:** `export const MODEL_CALLS_PER_INSTANCE_PER_DAY = 500`; `export function tryConsumeModelCall(now?: Date): boolean`; `export function secondsUntilCapReset(now?: Date): number`; `export function resetModelCallCapForTests(): void`; in `src/llm.ts`: `export type ModelCallFailure = "timeout" | "upstream" | "cap_exhausted"`; `export class ModelCallError extends Error { readonly kind: ModelCallFailure }`; `export const TITLE_TIMEOUT_MS = 5_000`; `suggestTitle(sections: string[]): Promise<string>` and `generateSection(company: string, section: string): Promise<string>` keep their signatures and now throw `ModelCallError`
  - **Call-site edits:** none outside `src/llm.ts` (neither model function has a caller yet)
- **Acceptance criteria:** `bun test src/llm.test.ts` — specs with a stubbed `fetch` pass: success returns the title; a hanging stub rejects with `kind: "timeout"` after 5 s (fake timers or a short injected timeout); a 500 or a body without `title` rejects with `kind: "upstream"`; after the cap is consumed the call rejects with `kind: "cap_exhausted"` and `fetch` is not called; the cap resets on the next UTC day

### Task 3: Add the title-suggestion route

- **Skill:** `flow-testing`
- **Description:** Add a `POST /reports/{id}/title` branch beside the share branch. It reads the report, answers 404 when absent and 422 `{"error":"report has no sections"}` when `sections` is empty (no model call in either case), otherwise calls `suggestTitle(report.sections)` and answers 200 `{"title": …}` without saving anything. It maps `ModelCallError` kinds to 503 with `Retry-After: secondsUntilCapReset()`, 504 and 502, and any other error to 500, all in the `{ "error": "<message>" }` shape. Every path calls `recordOperation("reports.title_suggest", seconds, errorType?)` with `not_found`, `invalid_input`, `rate_limited`, `upstream_timeout`, `upstream_error` or `internal`.
- **Inputs:** Tasks 1 and 2
- **Outputs:** the working endpoint with route tests
- **Contract:**
  - **Files:** edit `src/app.ts`, create `src/app.test.ts`
  - **Interfaces:** no new exports; `handle(req: Request): Promise<Response>` gains the route; tests seed reports with `saveReport` and stub `fetch`
  - **Call-site edits:** `src/app.ts` `handle` — new branch matching `/^\/reports\/([^/]+)\/title$/` for `POST`, placed before the final 404
- **Acceptance criteria:** `bun test src/app.test.ts` — specs for 200 with title, stored title unchanged afterwards, 404, 422, 503 with numeric `Retry-After`, 504, 502, no model call on 404/422/503, and one duration observation plus the exact failures increment per path, all pass

### Task 4: Deploy ceilings and module docs

- **Skill:** `flow-system-design`
- **Bundled:** the agent guide's module list, updated so it names the two new modules
- **Description:** Give the deploy an instance ceiling and per-instance concurrency so the per-instance cap bounds fleet spend, and list the new modules in the agent guide's layout line.
- **Inputs:** Task 2 (the cap value the ceiling multiplies)
- **Outputs:** bounded deploy; current agent guide
- **Contract:** _(config/infra + docs change types)_
  - **Files:** edit `deploy.sh`, edit `AGENTS.md`
  - **Interfaces:** `deploy.sh` line 3: `gcloud run deploy reports-service --source . --region us-central1 --allow-unauthenticated` → the same command plus `--max-instances 2 --concurrency 20` (placeholders, see Q1); `AGENTS.md` "Layout:" bullet — append ``, `src/spend-cap.ts` the daily model-call cap, `src/metrics.ts` the metrics helper``
  - **Call-site edits:** none
- **Acceptance criteria:** `grep -q -- '--max-instances 2' deploy.sh && grep -q -- '--concurrency 20' deploy.sh && grep -q 'spend-cap.ts' AGENTS.md && bash -n deploy.sh`

| Task | Depends on |
| --- | --- |
| 1 | — |
| 2 | 1 |
| 3 | 1, 2 |
| 4 | 2 |

Each code task carries its own test file: every task must leave `bun test` green on its own, so cohesion wins over splitting tests into a separate task.

### Skills Summary

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-metrics | Yes (Task 1) | first instrumented change; creates the helper and `.flow/metrics.md` |
| flow-system-design | Yes (Tasks 2, 4) | timeout, spend cap and deploy ceilings on a paid outbound call |
| flow-testing | Yes (Task 3) | route behaviour is mostly test-asserted status mapping |
| flow-new-feature | No (implicit) | drives the implement phase, not a task |
| flow-refactoring | No | the model-client simplification is bundled into Task 2 rather than a behaviour-preserving pass |
| flow-ui-ux | No | no UI surface |

# PR description draft

## TLDR

Callers can now get a suggested title for any saved report in a few seconds; before, nothing offered titles, and the paid model calls behind it now stop at a daily cap.

## User-facing changes

- New endpoint: `POST /reports/{id}/title` returns `{"title": "<suggestion>"}` for a saved report in about 1-3 seconds, and leaves the report's stored title unchanged.
- An unknown report answers 404, and a report with no sections answers 422. Neither one calls the model or costs anything.
- When the day's model-call budget is used up, the endpoint answers 503 with a `Retry-After` header that counts down to the next UTC day.
- A slow model answers 504 within about 5 seconds and a failing model answers 502. Neither one hangs or returns an empty success.

## System changes

- The service can now spend money on requests, with a bound:
  - **Before:** no request triggered a paid model call, and the model client had no timeout and no budget.
  - **After:** each title request makes at most one paid model call, with a 5 second timeout, under a cap of 500 calls per instance per UTC day. That is 1,000 calls a day at most across the new 2-instance ceiling, and each instance restart starts a fresh count.
- The service now has a size limit:
  - **Before:** the deploy set no instance ceiling.
  - **After:** the deploy caps the service at 2 instances and 20 concurrent requests per instance. The limit applies to read and share traffic too.
- The service now has its first metrics contract: title-request latency, failures by type, and model-call latency. They are recorded in memory only until a metrics backend is chosen.

## Why

Saved reports have an optional title, but callers have nothing to help them write one. So titles get written by hand or left blank, even though the service already contains a paid capability that suggests a title from a report's content.

## Key decisions

- The suggestion is returned and never saved. The request asks for a route that "returns a suggested title". Saving model output would also mean a queued, asynchronous design.
- The endpoint answers inline instead of using a queue with a status check. The model answers in 1-3 seconds, well inside the 10 second interactive budget, and nothing is persisted.
- Spend is bounded by a per-instance daily cap plus a deploy instance ceiling, not by adding caller authentication. The service is publicly reachable, and authentication would change access for every existing caller, so it is tracked as its own follow-up. The 500-call and 2-instance figures are placeholders waiting on the owner's budget.
- Suggestions are not cached. Reports live in per-instance memory, so a cache would miss most of the time, and the cap already bounds spend.
- Bundled: the model client gets a timeout and a status check. Before, a model failure returned an empty success and a hung model held the request open.
- Bundled: the agent guide's module list now names the two new modules.

## Instrumentation

- Metrics: title-request latency split by outcome, title-request failures split by failure type (unknown report, empty report, budget used up, model timeout, model error, internal), and model-call latency.
- Panels (spec-only, no dashboard URL yet): title-request rate and success vs failure, failures by type, title-request latency p50/p95/p99, and model-call latency p50/p95/p99, on a new "Reports service overview" dashboard.
- Alert: notify when any title request is refused for budget in a 5 minute window, plus the standard burn-rate tiers.
- SLO: new "get a title suggestion" journey. 99% of title requests succeed within 5 seconds over 30 days, not counting caller mistakes and budget refusals.
- These metrics are recorded, but no graph will show them until a metrics backend is chosen. The full note is in the new metrics contract's Backend section.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/app.test.ts` — the route specs pass (200 with a title, stored title unchanged, 404, 422, 503 with `Retry-After`, 504, 502).
- [ ] Run `bun test src/llm.test.ts` — the timeout, model-error and daily-cap specs pass, including no model call once the cap is used up.
- [ ] Run `bun test src/metrics.test.ts` — the emission specs pass for success, each failure type, and model-call timing.
- [ ] Run `PORT=8791 bun src/app.ts & sleep 1; [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:8791/reports/does-not-exist/title)" = "404" ]; kill %1` — a missing report answers 404 without a model call.
- [ ] Run `grep -q -- '--max-instances 2' deploy.sh && grep -q -- '--concurrency 20' deploy.sh` — the deploy ceilings are set.
- [ ] DECISION: you accept the placeholder budget of 500 model calls per instance per UTC day with at most 2 instances, which allows at most 1,000 title calls a day, or you reply with your own figures.
