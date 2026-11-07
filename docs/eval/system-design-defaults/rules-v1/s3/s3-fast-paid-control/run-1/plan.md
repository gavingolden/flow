# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Suggested title for a saved report

**Goal:** A client can ask for a model-suggested title for any saved report and get one back in a few seconds, without paying twice for an unchanged report.

## Problem Statement

Saved reports in this service carry a title slot, but nothing ever fills it, so every report stays untitled unless a person writes a title by hand. The service already has a model call that can propose a title from a report's sections, but no endpoint calls it, so clients can't use it. Every report a user saves stays nameless until someone takes the time to read it and name it.

| Fact | Evidence |
| --- | --- |
| Reports have a nullable title that nothing sets | `title: string \| null` [anchor: src/db.ts:5]; no handler writes it [anchor: src/app.ts:9-24] |
| A title-suggestion model call exists and is unused | `suggestTitle(sections)`, "1-3 s per call and costs money per call" [anchor: src/llm.ts:13-20] |
| The only routes are read a report and share a report | [anchor: src/app.ts:11-22] |
| The call has no timeout and no failure handling | bare `fetch` + `res.json()` [anchor: src/llm.ts:15-19] |
| The service is publicly callable | `--allow-unauthenticated` [anchor: deploy.sh:3] |

The user's words fix the shape: "add a `POST /reports/:id/title` endpoint that returns a suggested title for a saved report". Read against the product brief, the endpoint serves **user experience** (priority 1: one less thing the user has to do by hand), but each call is a paid model call, so **cost** (priority 2) has to be bounded: anything that adds ongoing cost must say what it buys.

## Request vetting

- **Hypothesis:** returning the model's suggestion inline (not queued, not saved) is enough for clients to offer "suggest a title", and the documented 1-3 s latency fits a synchronous request.
- **Case against:** the service is deployed publicly with no authentication [anchor: deploy.sh:3], so an inline paid endpoint lets any anonymous caller loop requests and run up model spend with no ceiling. The model call also has no timeout [anchor: src/llm.ts:15], so a hung upstream holds the request open until Cloud Run's 5-minute limit. And the suggestion has nowhere to go: no endpoint saves a title [anchor: src/app.ts:9-24].
- **Sources:** no outside source: grounded in-repo (deploy.sh, src/llm.ts, src/app.ts) plus the flow-system-design execution-model table.
- **Verdict:** adopt-with-conditions: every suggestion call is cut off after 5 s, and asking again for a report whose sections have not changed returns the first suggestion without a second paid call.

## Existing-code assessment

- **src/app.ts:** keep — the regex-route + `json()` helper shape fits one more sub-resource route, same shape as the share route [anchor: src/app.ts:16-22]
- **src/llm.ts `suggestTitle`:** simplify — add a timeout, a non-2xx check and a non-empty-title check before the handler depends on it; `generateSection` is not called by any handler today and stays untouched [anchor: src/llm.ts:14-20]
- **src/db.ts:** keep — read-only use of `getReport`; no schema change [anchor: src/db.ts:11-13]

## Scope Boundary

**In scope**

- `POST /reports/:id/title` returns `200 { "suggestedTitle": "<text>" }` for a saved report with at least one section.
- `404` for an unknown report, `422` for a report with no sections (no model call made), `504` when the model does not answer in 5 s, `502` when the model answers with a failure or an empty title. Error bodies use the existing `{ "error": "<message>" }` shape.
- Repeat requests for a report whose sections are unchanged reuse the first suggestion (per instance); concurrent identical requests share one model call.
- Timeout and failure handling on the title model call.
- Metrics for the new endpoint and the model call, plus the repo's first `.flow/metrics.md` contract.

**Out of scope**

- Saving the suggestion as the report's title (see Open Questions).
- An endpoint to set or edit a title.
- Authentication or per-caller rate limiting (filed as a candidate follow-up).
- Multiple alternative suggestions or a "re-roll" flag.
- Changes to `generateSection`.

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| A client has no way to get a title for a saved report; the title stays empty unless a person writes one | A client sends one request and gets a suggested title back, typically in 1-3 s |
| — | Asking again for the same unchanged report returns the same suggestion straight away, at no extra cost |
| — | A model outage or a hang gives a clear error within about 5 s instead of a hanging request |

### System flow

- Before:
  - The title model call is unused; nothing calls the model API.
- After:
  - The new route looks up the report, rejects missing or empty reports before spending anything, then makes at most one model call per report content version per instance.
  - The model call is cut off at 5 s; failures map to 502/504 and are counted by failure class.
  - The service starts emitting latency and failure metrics for this endpoint and its model dependency (recorded in memory until a metrics backend is chosen).

**Lost:** none — purely additive; no existing route, field or behaviour changes.

## User Stories / Acceptance Criteria

### Story 1: Get a suggested title

- Given a saved report with sections, When a client sends `POST /reports/<id>/title`, Then the response is `200` with a non-empty `suggestedTitle` string — test `returns a suggested title for a saved report` in `src/app.test.ts`.
- Given the same request, Then the saved report is unchanged (its `title` stays as it was) — test `does not change the saved report`.

### Story 2: Clear errors without wasted spend

- Given no report with that id, Then `404` and no model call — test `returns 404 for an unknown report`.
- Given a report with an empty `sections` list, Then `422` and no model call — test `returns 422 without a model call when the report has no sections`.
- Given the model does not answer within 5 s, Then `504` — test `returns 504 when the model call times out`.
- Given the model answers non-2xx or with an empty title, Then `502` — test `returns 502 when the model API fails`.

### Story 3: No double charge for an unchanged report

- Given a suggestion was already produced for a report, When the same report (same sections) is asked again, Then the same title returns and the model is called once in total — test `reuses the suggestion for an unchanged report`.
- Given the report's sections changed since, Then a fresh model call is made — test `makes a fresh call after the report's sections change`.
- Given a model call failed, Then the next request retries the model (failures are not reused) — test `does not reuse a failed suggestion`.

## Instrumentation

**Contract:** .flow/metrics.md create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports.title_suggestion.duration` | Histogram | seconds | `operation.outcome` (ok, error) | `POST /reports/:id/title` handler |
| `reports.title_suggestion.failures` | Counter | none | `error.type` (not_found, invalid_input, upstream_error, upstream_timeout, internal, _OTHER) | `POST /reports/:id/title` handler |
| `reports.llm.call.duration` | Histogram | seconds | `server.address` (api.example-llm.com), `operation.outcome` (ok, error) | title model call |

Estimated series: 40 per operation (title suggestion: 2 x 17 histogram + 6 failure classes), per instance
Estimated series: 34 per operation (model call: 1 host x 2 outcomes x 17), per instance

Reuse rate (what the per-report reuse buys) is read as handler count minus model-call count; no extra metric is added for it.

**Attributes:** new keys with their closed values, added as `.flow/metrics.md` `## Attributes` rows: `operation.outcome` (ok, error), `error.type` (list below), `server.address` (api.example-llm.com)

### Error types

New list (first in the repo): `_OTHER`, `internal`, `invalid_input` (client-caused: report has no sections), `not_found` (client-caused: unknown report id), `upstream_error` (model API answered non-2xx or an empty title), `upstream_timeout` (model API did not answer within 5 s).

### Dashboard panels

On the `reports-service overview` dashboard (spec-only): "Title suggestion latency p50/p99", "Title suggestion failures by error.type", "Model API call latency p99 and error rate".

### Alerts

burn-rate tiers only

### SLO

New journey SLO `title-suggestion`: availability — 99% of non-client-caused requests (excluding `not_found`, `invalid_input`) return 200 over 28 days; latency — 95% under 5 s.

**As-code:** spec-only — the repo keeps no dashboard or alert files and no metrics backend; `## Backend` is `none yet — suggested: Google Cloud Monitoring`.

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | HTTP handler, model-API client, a new small title-suggestion module, a new metrics helper |
| Domain modules | existing `src/app.ts`, `src/llm.ts`, `src/db.ts` (read-only); new `src/title.ts`, `src/metrics.ts` |
| Data flow | request → `getReport` → reuse check → `suggestTitle(sections)` → `{ suggestedTitle }`; nothing is written to the report store |
| Pattern | follows the existing sub-resource POST route (`/reports/:id/share`, src/app.ts:16-22); the reuse map and metrics helper are new, each in its own single-purpose module per AGENTS.md |
| Binary-framing check | not framed as a binary; the middle ground considered for cost was "reuse per unchanged report" between "always call" and "rate-limit callers" (see Decision analysis) |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| `POST /reports/:id/title` | 3 s | inline — 3 s p99, timeout 5 s | 5 s (bounded by the model call) | none server-side; the client re-asks | report id + exact sections content | at most one model call per report content version per instance (new reuse map) |
| title model call | 3 s | inline — 3 s p99, timeout 5 s | 5 s abort | none (one layer: the client) | report id + sections content (via the reuse map; concurrent requests share one call) | new reuse map; overall ceiling is Cloud Run max instances |

**Platform:** gcp

**Proportionality:** no queue, worker or status resource — a single 1-3 s call that is not persisted fits the inline row of the system-design table; no shared cache (Memorystore) — the report store itself is in-process memory (src/db.ts:9), so a per-instance reuse map matches its lifetime; no server-side retries; no spend ledger and no per-caller rate limit — the service has no caller identity to key on (candidate follow-up).

**Recovery:** none — no table, migration or bucket is added; the reuse map is regenerable by calling the model again.

**Rollback:** none — additive route; reverting the deploy removes it with no data to migrate.

## Technical Constraints

- The model call is documented at 1-3 s and paid per call [anchor: src/llm.ts:13]; the 5 s timeout sits under the 10 s interactive budget in flow-system-design.
- Every request is anonymous (deploy.sh:3), so the reuse key cannot include a caller; it is report-scoped only.
- No new runtime dependencies (AGENTS.md): timeout via `AbortSignal.timeout`, tests via `bun test` with a stubbed `globalThis.fetch`.
- Token spend: adds at most one paid title call per report content version per instance; zero calls for unknown or empty reports.

## Open Questions

- [ ] Should the suggestion be saved as the report's title, or only returned? Redirect adds a write to the report and, per the system-design rule for persisted model output, moves the call to a queue + status resource.
  - **Stakes:** user — if the user expected the title to be saved, reports stay untitled after the call.
  - **Recommended:** return only, never write `report.title` — the request says it "returns a suggested title" [confidence: high] [anchor: user: "returns a suggested title for a saved report"]
- [ ] With no endpoint to set a title, should this PR also add one (for example `PATCH /reports/:id` accepting `title`)? Redirect adds a task and a second route.
  - **Stakes:** user — without it a client can show the suggestion but cannot save it in this service.
  - **Recommended:** leave it out; the open decision is whether titles are free-text user edits or accept-the-suggestion only, which the request does not settle [confidence: medium] [anchor: weighing: footprint — keeps this PR to the one route the user named]
- [ ] Response field name: `suggestedTitle` or `title`? Redirect renames the field in the handler and tests.
  - **Stakes:** user — client integrators read the field name; a rename after release breaks them.
  - **Recommended:** `{ "suggestedTitle": "<text>" }` — keeps it distinct from the saved `title` field on the report [confidence: medium] [anchor: weighing: symmetry — `title` already means the saved value in the Report type (src/db.ts:5)]
- [ ] Reuse the first suggestion for an unchanged report, or call the model every time? Redirect drops `src/title.ts`'s reuse map and changes the cost bound (see Decision analysis).
  - **Stakes:** both — reuse means a user asking again gets the same title; no reuse means every repeat costs one paid call.
  - **Recommended:** reuse per unchanged report — cost is the brief's priority 2 and the only spend bound available without caller identity [confidence: medium] [anchor: weighing: risk — deploy.sh:3 exposes the endpoint anonymously, so repeat calls are otherwise unbounded]
- [ ] A report with no sections: reject with 422, or call the model anyway? Redirect removes the pre-check.
  - **Stakes:** system — calling the model on empty input spends money for a meaningless title.
  - **Recommended:** reject with 422 before any model call [confidence: medium] [anchor: adjacent: src/app.ts:19 — the share route rejects a missing report before any side effect]
- [ ] Timeout for the model call: 5 s? Redirect changes one constant and the 504 test.
  - **Stakes:** user — too short turns slow-but-successful calls into errors; too long leaves users waiting.
  - **Recommended:** 5 s — headroom over the documented 1-3 s while staying under the 10 s interactive budget [confidence: medium] [anchor: weighing: risk — documented latency is 1-3 s (src/llm.ts:13)]
- [x] Use the existing `{ error: "<message>" }` body for errors rather than Problem Details — resolved without asking
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision A — how is spend bounded on an anonymous, paid endpoint?**

| Branch | User flow | System flow | Interruptions |
| --- | --- | --- | --- |
| A1: call the model every time | every click returns a possibly different title in 1-3 s | one paid call per request; a looping caller spends without limit | 0 interruptions |
| A2: reuse per unchanged report (recommended) | first click 1-3 s; repeat clicks return the same title instantly; editing sections gives a fresh suggestion | at most one paid call per report content version per instance; concurrent requests share one call | 0 interruptions |
| A3: per-caller rate limit | callers over the limit get 429 and wait | needs caller identity the service does not have (deploy.sh:3), or IP-based limits that per-instance memory cannot enforce across instances | 1 interruption per throttled caller |

A1 and A2 are mutually exclusive; A3 is complementary to A2 but depends on the authentication decision in the candidate follow-up. Ranked: A2 > A2+A3 (later) > A1 > A3 alone. Verdict: **A2** — the only branch that bounds repeat spend today without new infrastructure, at the cost of no "re-roll" [confidence: medium] [anchor: weighing: risk — anonymous access at deploy.sh:3 makes A1's spend unbounded].

## Alternatives considered

- **`GET /reports/:id/title`** — rejected: the user named `POST`, and a GET that triggers a paid call on a public service can be fired by prefetchers and crawlers (deploy.sh:3 `--allow-unauthenticated`).
- **Queue + `202` + status resource** — rejected: the call is documented at 1-3 s (src/llm.ts:13) and is not persisted, which puts it in the inline row of the flow-system-design execution-model table.
- **Shared cache (Memorystore) for suggestions** — rejected: reports themselves live in per-instance memory (src/db.ts:9), so a cross-instance cache would outlive the data it describes.

## Recommendation

**Proceed** — build the endpoint as asked, return-only, with the 5 s cut-off and per-report reuse from the Request vetting conditions; the one bundled change, a simplified model call, is named in Existing-code assessment [confidence: medium] [anchor: weighing: footprint — one route, one small module, existing patterns at src/app.ts:16-22]

**Redundancy:** none found — no existing route calls `suggestTitle` (src/app.ts:9-24).

## Plan risks

The only latency evidence is a code comment claiming 1-3 s (src/llm.ts:13); if the real model p99 is above 5 s, the endpoint will return 504s on calls that would have succeeded, and the timeout constant needs to change.

## Cut list

- The `.flow/metrics.md` dashboard, alert and SLO entries are spec-only text; no backend, exporter or dashboard files are built, and nothing else should be added before a backend is chosen.
- No in-flight counter or reuse-hit metric: reuse rate is derived from the two histograms' counts instead.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Close anonymous access to reports-service | High | Medium | needs its own design/decision session: the open decision is Cloud Run IAM (`--no-allow-unauthenticated`) versus app-level API keys with per-caller rate limits, which changes every existing client | this PR adds a third anonymous route and the first paid one; the reuse map bounds repeats but not distinct reports | No |

- [x] Close anonymous access to reports-service — any caller can read any report, share any report, and now trigger paid title calls.
  - **UX:** none
  - **Problem:** every route, including the share write and the new paid route, accepts anonymous callers from the public internet [anchor: deploy.sh:3]
  - **Stability/efficiency:** none
  - **Value rank:** 5 — security exposure: any report can be read or marked shared by anyone who knows or guesses its id [anchor: src/app.ts:11-22]
  - **Complexity:** Medium — deploy config plus every client's auth path
  - **Risk:** Medium — breaks any existing anonymous client on cut-over
  - **If never done:** reports stay world-readable and paid model spend stays exposed to anonymous callers
  - **Verdict:** clears bar — a live security exposure on every route outweighs a Medium change that needs its own decision

# Task breakdown

### Task 1: Metrics helper and the repo's metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create a zero-dependency metrics helper with an in-memory recorder and a closed `ErrorType` union (`_OTHER`, `internal`, `invalid_input`, `not_found`, `upstream_error`, `upstream_timeout`), and create `.flow/metrics.md` with `## Backend` (`none yet — suggested: Google Cloud Monitoring`), `## Namespace` (`reports`), `## Attributes`, `## error.type values`, `## Helper`, `## Dashboard panels`, `## Dashboards`, `## Alerts` (burn-rate tiers only), `## As-code` (spec-only), `## SLOs` (`title-suggestion`), `## Coverage` (title suggestion, model call). Metrics as specced in the PRD's Instrumentation section.
- **Inputs:** new: src/metrics.ts; new: .flow/metrics.md
- **Outputs:** the helper the handler and model client record through; the committed metrics contract
- **Contract:**
  - **Files:** create `src/metrics.ts`; create `src/metrics.test.ts`; create `.flow/metrics.md`
  - **Interfaces:** `export type ErrorType = "_OTHER" | "internal" | "invalid_input" | "not_found" | "upstream_error" | "upstream_timeout"`; `export type Outcome = "ok" | "error"`; `export function recordDuration(metric: "reports.title_suggestion.duration" | "reports.llm.call.duration", seconds: number, attrs: { "operation.outcome": Outcome; "server.address"?: "api.example-llm.com" }): void`; `export function recordFailure(metric: "reports.title_suggestion.failures", errorType: ErrorType): void`; `export function toErrorType(value: string): ErrorType` (unlisted → `_OTHER`); `export const recorder: { observations: Array<{ metric: string; value: number; attrs: Record<string, string> }>; reset(): void }`
  - **Call-site edits:** none (consumers added in Tasks 2-3)
- **Acceptance criteria:** `bun test src/metrics.test.ts && grep -q '^## error.type values' .flow/metrics.md && grep -q 'upstream_timeout' .flow/metrics.md`

### Task 2: Bound the title model call

- **Skill:** `flow-system-design`
- **Bundled:** the missing timeout and failure handling on the existing title model call, surfaced during discovery
- **Description:** Give `suggestTitle` a 5 s abort timeout, reject non-2xx responses and empty or non-string titles, trim the title, and record `reports.llm.call.duration` with `server.address=api.example-llm.com`. Failures throw `LlmError` carrying the matching `error.type`. No retries. Tests stub `globalThis.fetch`.
- **Inputs:** src/metrics.ts (Task 1); src/llm.ts
- **Outputs:** a title call that always settles within about 5 s with a classified failure
- **Contract:**
  - **Files:** edit `src/llm.ts`; create `src/llm.test.ts`
  - **Interfaces:** `export class LlmError extends Error { readonly errorType: "upstream_error" | "upstream_timeout" }`; `export const TITLE_TIMEOUT_MS = 5000`; `export async function suggestTitle(sections: string[], timeoutMs = TITLE_TIMEOUT_MS): Promise<string>` (unchanged call shape for existing callers)
  - **Call-site edits:** none (no current caller of `suggestTitle`); `generateSection` untouched
- **Acceptance criteria:** `bun test src/llm.test.ts` (cases: trimmed title on 200; `upstream_error` on non-2xx; `upstream_error` on empty title; `upstream_timeout` when fetch never resolves within a 50 ms test timeout; one `reports.llm.call.duration` observation per call)

### Task 3: `POST /reports/:id/title` with per-report reuse

- **Skill:** `flow-new-feature`
- **Description:** Add `src/title.ts` holding an in-process reuse map keyed by report id that stores the sections fingerprint (`JSON.stringify(sections)`) and the in-flight or settled promise; reuse it when the fingerprint matches, drop the entry when the promise rejects. Add the route to `handle()`: unknown id → 404 `not_found`; empty `sections` → 422 `invalid_input` with no model call; `LlmError` `upstream_timeout` → 504, `upstream_error` → 502; anything else → 500 `internal`; success → 200 `{ suggestedTitle }`. Never call `saveReport`. Record `reports.title_suggestion.duration` and `reports.title_suggestion.failures` through the helper. The 9 test names in the PRD's User Stories are used verbatim.
- **Inputs:** src/metrics.ts (Task 1); src/llm.ts `suggestTitle`, `LlmError` (Task 2); src/db.ts `getReport`, `saveReport`, `Report`; new: src/title.ts
- **Outputs:** the live endpoint
- **Contract:**
  - **Files:** create `src/title.ts`; edit `src/app.ts`; create `src/app.test.ts`
  - **Interfaces:** `export async function suggestReportTitle(report: Report): Promise<string>`; `export function resetTitleReuse(): void` (tests only); route regex `/^\/reports\/([^/]+)\/title$/` on `POST`
  - **Call-site edits:** `src/app.ts` `handle` — new branch after the share route, before the final 404
- **Acceptance criteria:** `bun test src/app.test.ts && bun test`

| Task | Depends on |
| --- | --- |
| 1 | — |
| 2 | 1 |
| 3 | 1, 2 |

### Skills Summary

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-metrics | Yes (Task 1) | first instrumented route; creates the helper and `.flow/metrics.md` |
| flow-system-design | Yes (Task 2) | timeout and failure classification on a paid outbound call |
| flow-new-feature | Yes (Task 3) | the user-facing route and its acceptance tests |
| flow-testing | No | tests ride inside each task; no standalone test task needed |
| flow-ui-ux | No | no UI surface |

# PR description draft

## TLDR

Clients can now ask the reports service for a suggested title for any saved report; before, reports had a title slot nothing could fill, and now one request returns a title in a few seconds.

## User-facing changes

- New endpoint: sending `POST /reports/<id>/title` returns `{ "suggestedTitle": "<text>" }` for a saved report, typically within 1-3 seconds.
- Asking again for a report whose sections haven't changed returns the same suggestion immediately, with no extra model cost.
- Unknown reports return 404, reports with no sections return 422, and a slow or failing model returns 504 or 502 within about 5 seconds instead of hanging.
- The suggestion is not saved; the report's own title is unchanged.

## System changes

- The service now makes paid model calls on request:
  - **Before:** no route called the model API.
  - **After:** at most one title call per report content version per instance; none for unknown or empty reports.
- The title model call now gives up after 5 seconds and reports its failures by class instead of hanging or throwing raw errors.
- The service records latency and failure metrics for the new endpoint and its model dependency, and the repo gains its first metrics contract; the metrics are recorded but won't show on any graph until a metrics backend is chosen.

## Why

Saved reports have a title slot that nothing fills, so they stay unnamed unless someone writes a title by hand. The service can already ask the model for a title, but clients have no way to get it.

## Key decisions

- Return-only: the suggestion is not saved. The user asked for an endpoint that "returns a suggested title", and saving model output would push the call onto a queue.
- Reuse over re-roll: an unchanged report gets the same suggestion back rather than a new paid call. The service is publicly callable with no caller identity, so this is the only spend bound available today. The cost is that a user can't ask for a different title.
- Inline with a 5-second cut-off, not a background job: the call is documented at 1-3 seconds and nothing is persisted.
- Out of scope: an endpoint to save a title, and authentication or rate limiting (tracked as a follow-up).
- Bundled: the missing timeout and failure handling on the existing title model call.

## Instrumentation

New metrics: title-suggestion latency (by outcome), title-suggestion failures (by failure class), and model-call latency (by outcome). Planned panels on the reports-service overview dashboard: title suggestion latency p50/p99, failures by class, model call latency and error rate. New journey SLO `title-suggestion`: 99% availability excluding client errors, 95% under 5 s. Spec-only: no metrics backend is chosen yet (suggested: Google Cloud Monitoring), so graphs need a backend choice first.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/app.test.ts -t "returns a suggested title for a saved report"` — passes.
- [ ] Run `bun test src/app.test.ts -t "does not change the saved report"` — passes.
- [ ] Run `bun test src/app.test.ts -t "returns 404 for an unknown report"` — passes.
- [ ] Run `bun test src/app.test.ts -t "returns 422 without a model call when the report has no sections"` — passes.
- [ ] Run `bun test src/app.test.ts -t "returns 504 when the model call times out"` — passes.
- [ ] Run `bun test src/app.test.ts -t "returns 502 when the model API fails"` — passes.
- [ ] Run `bun test src/app.test.ts -t "reuses the suggestion for an unchanged report"` — passes.
- [ ] Run `bun test src/app.test.ts -t "makes a fresh call after the report's sections change"` — passes.
- [ ] Run `bun test src/app.test.ts -t "does not reuse a failed suggestion"` — passes.
- [ ] Run `bun test src/llm.test.ts` — all specs pass.
- [ ] Run `bun test src/metrics.test.ts` — all specs pass.
