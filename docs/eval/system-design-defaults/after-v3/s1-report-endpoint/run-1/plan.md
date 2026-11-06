# PRD

**Goal:** An authorised caller asks for a company report in one request and gets back all five sections in about a minute, with daily model spend held under a fixed cap.

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

## Problem Statement

This service stores and serves company reports, but nothing can create one today. The only write path marks an existing report as shared. So a caller who wants a report has no way to get the service to write one. Each report takes five slow, paid model calls, so how generation runs decides how long callers wait, what a failed call costs, and how much an abusive caller can spend.

| Fact | Evidence |
| --- | --- |
| No create path exists; only GET by id and POST share | [anchor: src/app.ts:9] |
| The report shape already exists: company, sections, nullable title, shared flag | [anchor: src/db.ts:1] |
| A per-section model client exists, "Takes 20-60 s per call and costs money per call" | [anchor: src/llm.ts:1] |
| The model client sets no timeout and does not check the response status, so a failed call returns `undefined` as section text | [anchor: src/llm.ts:6] |
| Storage is a process-local map. Reports do not survive a restart and are not shared between instances | [anchor: src/db.ts:9] |
| The service is deployed publicly with no authentication, so the new endpoint would be the first paid one anyone on the internet can call | [anchor: deploy.sh:3] |

Who is affected: whoever calls this service to get a report (no client code lives in this repo). Brief priorities this lands on: **user experience** (how long they wait, whether a report comes back complete) and **cost** (paid calls per report, and the ceiling on total spend).

## Request vetting

- **Hypothesis:** Five model calls run in parallel return a full report inside one HTTP request, within a deadline below the platform request timeout, and a single in-process cap keeps the spend bounded.
- **Case against:** The default for persisted, paid, multi-section model generation is a durable queue with one task per section and a status resource. Running inline goes over the 10 s interactive budget (20–60 s per call [anchor: src/llm.ts:1]). The work is also lost if the instance dies mid-request, and on Cloud Run's request-based billing nothing can safely keep running after the response (https://docs.cloud.google.com/run/docs/configuring/billing-settings). Sequential calls would total 300 s, which is the default request timeout (https://docs.cloud.google.com/run/docs/configuring/request-timeout).
- **Sources:** https://docs.cloud.google.com/run/docs/configuring/billing-settings, https://docs.cloud.google.com/run/docs/configuring/request-timeout
- **Verdict:** adopt-with-conditions: the five section calls run in parallel under a 160 s report deadline (below a 180 s request timeout), every report passes one concurrency-and-daily cap, and the service runs at most one instance

## Existing-code assessment

- **src/llm.ts (model client):** simplify — add a per-call timeout and a status check before parsing. Today a 429/5xx response or a hang turns into `undefined` section text or an unbounded wait. [anchor: src/llm.ts:6]
- **src/app.ts (router):** keep — the regex-per-route `handle` takes one more branch cleanly. Wrap it in a factory so tests can inject the model client and the cap. [anchor: src/app.ts:9]
- **src/db.ts (report store):** keep — extend the in-memory map with an idempotency-key index. Durability is a separate decision, tracked as a candidate. [anchor: src/db.ts:9]
- **deploy.sh (Cloud Run deploy):** keep — add instance, timeout and secret flags to the existing single command. [anchor: deploy.sh:3]

## Scope Boundary

**In scope:**

- `POST /reports` with body `{"company": "<name>"}` generates five fixed sections, each with one model call (plus at most one retry per section on a transient failure). It saves the report and returns `201` with the full report and a `Location: /reports/{id}` header.
- A bearer API key is required on `POST /reports` only. If no key is configured, the endpoint refuses every request (fail closed).
- An optional `Idempotency-Key` header. A repeat returns the same report and makes no new model calls.
- One cost choke point: at most 4 reports in flight and at most 100 reports per UTC day.
- Model client hardening: a timeout and a status check on both model calls.
- Deploy settings: at most one instance, a 180 s request timeout, and the API key read from Secret Manager.
- Metrics helper (in-memory, no backend yet) and the `.flow/metrics.md` contract.

**Out of scope:**

- Asynchronous generation (202 + status polling), a durable datastore, a task queue (candidate follow-up).
- Calling the title-suggestion model. `title` stays `null`, following the user's "once for each of five sections".
- Caller-chosen section lists, streaming partial sections, per-section resume after a failed report.
- Access rules on the existing `GET /reports/:id` and `POST /reports/:id/share` routes (candidate follow-up).

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| `POST /reports` returns `404 {"error":"not found"}`. No report can be created | `POST /reports` with a valid key and `{"company":"Acme"}` waits ~20–60 s, then returns `201` with the five-section report and its id |
| — | Without the key: `401`. With an empty company: `400`. When 4 reports are already running: `429` with `Retry-After`. When the daily cap is spent: `429` with seconds-until-midnight `Retry-After` |
| — | A section that still fails after one retry returns `502`/`504`. Nothing is saved, so the caller never gets a report with a section missing or reading "undefined" |
| — | Re-sending the same `Idempotency-Key` returns the same report instantly with no new spend |
| `GET /reports/{id}` can only return reports that somehow already exist | `GET /reports/{id}` returns the report just created, until the instance restarts |

### System flow

- **Before:**
  - The service never calls the model API. It runs on as many instances as Cloud Run likes, with a 300 s default request timeout.
- **After:**
  - Each report makes 5 parallel model calls (≤10 with retries), each bounded at 75 s, inside a 160 s report deadline.
  - At most 4 reports run at once and at most 100 start per UTC day (per instance lifetime). The service is pinned to one instance so the in-memory store, caps and idempotency index are global.
  - The API key is read from Secret Manager at deploy.

**Lost:** horizontal scaling. The service is capped at one Cloud Run instance, so a traffic spike past 80 concurrent requests queues or fails instead of adding instances.

## User Stories / Acceptance Criteria

### Story 1: Generate a report

- [ ] Given a valid key and `{"company":"Acme"}`, when `POST /reports` is called, then it returns `201`, a `Location: /reports/{id}` header and a body whose `sections` has exactly 5 non-empty strings in the configured order, with exactly 5 model calls made — `bun test src/app.test.ts -t "returns 201 with five sections"` exits 0
- [ ] Given a report was just created, when `GET /reports/{id}` is called, then it returns the same body — `bun test src/app.test.ts -t "GET returns a report created by POST"` exits 0
- [ ] Given the five calls are stubbed to take 50 ms each, when a report is generated, then total time is under 200 ms (parallel, not sequential) — `bun test src/reports.test.ts -t "runs sections in parallel"` exits 0

### Story 2: Refuse callers that would burn spend

- [ ] Given no `Authorization` header or a wrong key, when `POST /reports` is called, then it returns `401` and makes 0 model calls — `bun test src/app.test.ts -t "401"` exits 0
- [ ] Given the server started with no key configured, when `POST /reports` is called, then it returns `503` and makes 0 model calls — `bun test src/app.test.ts -t "503 when no API key"` exits 0
- [ ] Given a body with a missing, empty or over-200-character `company`, or invalid JSON, then it returns `400` with 0 model calls — `bun test src/app.test.ts -t "400"` exits 0
- [ ] Given 4 reports in flight, when a fifth starts, then it returns `429` with `Retry-After` — `bun test src/budget.test.ts` and `bun test src/app.test.ts -t "concurrency cap"` exit 0
- [ ] Given 100 reports already started this UTC day, when another starts, then it returns `429` with `Retry-After` equal to the seconds until UTC midnight — `bun test src/budget.test.ts -t "daily cap"` exits 0

### Story 3: Never pay twice or return a broken report

- [ ] Given a completed report created with `Idempotency-Key: k1`, when the same request is repeated, then the same id comes back and the model call count stays at 5 — `bun test src/app.test.ts -t "replays an Idempotency-Key"` exits 0
- [ ] Given `Idempotency-Key: k1` was used for company A, when it is sent with company B, then it returns `422` — `bun test src/app.test.ts -t "422"` exits 0
- [ ] Given one section returns HTTP 500 twice, when a report is generated, then the response is `502`, nothing is saved, and that section was attempted exactly twice — `bun test src/app.test.ts -t "502"` exits 0
- [ ] Given the model API returns 429 or 5xx, or exceeds the timeout, then the client raises a typed error instead of returning `undefined` text — `bun test src/llm.test.ts` exits 0

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports.create.duration` | Histogram (bounds 1, 5, 10, 20, 30, 45, 60, 90, 120, 180 s) | seconds | `operation.outcome` (`ok`, `error`) | `POST /reports` handler |
| `reports.create.failures` | Counter | none | `error.type` (`_OTHER`, `budget_exhausted`, `internal`, `invalid_input`, `rate_limited`, `unauthorized`, `upstream_error`, `upstream_timeout`) | `POST /reports` handler |
| `reports.create.active` | UpDownCounter | `{request}` | none | `POST /reports` handler (helper's `instrument` try/finally) |
| `reports.llm.call.duration` | Histogram (same bounds) | seconds | `server.address` (`api.example-llm.com`), `operation.outcome` (`ok`, `error`) | model client, per section call |
| `reports.llm.call.failures` | Counter | none | `server.address` (`api.example-llm.com`), `error.type` (`_OTHER`, `rate_limited`, `upstream_error`, `upstream_timeout`) | model client, per section call |
| Cloud Run request count / latency | — | — | — | platform-native (`run.googleapis.com/request_count`, `request_latencies`). It does not split by route, which is why the custom `reports.create.duration` exists |

Estimated series: 35 per operation for `reports.create` (2 × 13 histogram + 8 failures + 1 in-flight)
Estimated series: 30 per operation for `reports.llm.call` (1 host × 2 outcomes × 13 + 4 failures)

**Attributes:** new registry rows: `operation.outcome` (`ok`, `error`), `error.type` (the list below), `server.address` (`api.example-llm.com`)

### Error types

New list (first in repo): `_OTHER` (fallback), `budget_exhausted` (daily report cap reached), `internal` (unexpected failure, including a missing API key configuration), `invalid_input` (bad body or reused idempotency key with a different body; client-caused), `rate_limited` (concurrency cap full, or the model API answered 429), `unauthorized` (missing or wrong API key; client-caused), `upstream_error` (model API answered non-2xx), `upstream_timeout` (model call or report deadline exceeded).

### Dashboard panels

On the new "reports-service overview" dashboard (spec-only): request rate, success vs failure, failures by `error.type`, and latency p50/p95/p99 for `reports.create`; latency p95 and failures by `error.type` for `reports.llm.call`; in-flight reports (`reports.create.active`, threshold line at 4).

### Alerts

| Signal | Condition | Sustained for | Action | Routes to | Dashboard |
| --- | --- | --- | --- | --- | --- |
| Daily report cap spent | `reports.create.failures{error.type="budget_exhausted"}` rate > 0 | 5m | notify | owner notification channel (name recorded in `.flow/metrics.md`) | reports-service overview |

Plus the standard burn-rate tiers for the new SLO below.

### SLO

New journey SLO "generate a company report": availability 99% of `POST /reports` calls over 30 days, excluding client-caused `invalid_input` and `unauthorized`; latency 95% under 90 s.

**As-code:** spec-only — the repo keeps no dashboard or alert config and no metrics backend (suggested: Google Cloud Monitoring via OTLP)

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | HTTP handler, report-generation domain, model-API client, in-memory store, deploy config |
| Domain modules | existing `app`, `db`, `llm`; new `reports` (generation + idempotency), `budget` (the one spend choke point), `metrics` (helper) |
| Data flow | caller → handler (auth, validate) → `createReport` (idempotency check → cap reservation → 5 parallel model calls → save) → 201 response |
| Pattern | extends the existing regex router and in-memory store; new small single-purpose modules per AGENTS.md |
| Binary-framing check | inline-sequential / **inline-parallel with caps (chosen)** / durable queue + datastore. The middle option ships now, and the durable path is a ticked candidate |
| Goal anchor | "about a minute" in the Goal holds only with parallel calls. The per-day cap serves the "spend held under a fixed cap" clause |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| `POST /reports` (generate report) | ~65 s (slowest of five parallel calls); ~155 s worst case with one retried section | inline, five-way parallel fan-out (departure from queue default, see Proportionality) | 160 s report deadline; Cloud Run request timeout 180 s | none at this layer (section layer only) | caller's `Idempotency-Key` header, single-flight while in progress | new report cap: ≤4 in flight, ≤100 started per UTC day |
| Section generation (model call) | ~60 s | inline within the report | 75 s per attempt (`AbortSignal.timeout`) | 1 retry on timeout / 5xx / 429, jittered 1–3 s backoff, only if ≥75 s of the report deadline remains | `<report id>:<section>` (the model API offers no idempotency header the repo knows of) | counted in the report reservation; ≤10 calls per report |
| Title suggestion (model call, not called by this feature) | inline — ~3 s, timeout 10 s | inline | 10 s | none | none | not called |

**Platform:** gcp

**Proportionality:** Deliberately no Cloud Tasks queue, worker service, durable datastore or status resource. The repo has no durable store (the in-memory map cannot back a status resource across restarts), and adding a queue plus a datastore brings two runtime dependencies and new IAM wiring, against AGENTS.md's "No new runtime dependencies without a reason". That path is the ticked candidate. Also left out: per-section resume, streaming sections, multi-instance scaling.

**Recovery:** none — reports live in process memory by design today (nothing in this plan makes them durable), each is regenerable at a known cost of 5–10 model calls, and the durable-datastore candidate owns backups and restore checks.

## Technical Constraints

- Cloud Run request timeout defaults to 5 min (max 60 min), so the plan sets 180 s explicitly in `deploy.sh`, and the 160 s report deadline sits below it — https://docs.cloud.google.com/run/docs/configuring/request-timeout
- No work may continue after the response (request-based billing throttles CPU), so generation finishes before `201` is written — https://docs.cloud.google.com/run/docs/configuring/billing-settings
- No new runtime dependencies (AGENTS.md). Timeouts use `AbortSignal.timeout`, IDs use `crypto.randomUUID()`, the metrics helper is an in-memory recorder, and the API-key compare uses `crypto.timingSafeEqual` (Node compat in Bun).
- Model calls take 20–60 s and are paid [anchor: src/llm.ts:1], so every call has a timeout and every report passes the cap first.
- Tests run under `bun test` (package.json `scripts.test`). Model calls are stubbed by injected dependencies, so no test makes a real or paid call.
- Errors keep the existing `{"error": "<message>"}` body shape [anchor: src/app.ts:14].
- Deploy now needs a Secret Manager secret `reports-api-key` to exist. `gcloud run deploy --set-secrets` fails if it is missing, so an unprotected deploy is impossible.
- Cost: each report makes 5 paid generate calls (≤10 with retries). The cap bounds that at ≤1,000 calls per UTC day per instance lifetime and ≤20 concurrent calls. The per-call price of the model API is not known to the repo.

## Open Questions

- [ ] Q1. Which five sections does a report contain? — redirect changes only the `REPORT_SECTIONS` constant and its test fixture.
  - **Stakes:** user — the section list is the whole content of every report a caller receives.
  - **Needs user input:** user-held preference or subjective taste. The plan ships the placeholder list `Company overview`, `Products and services`, `Market and competitors`, `Financial performance`, `Risks and outlook`.
- [ ] Q2. What daily report cap (and concurrency cap) fits your model budget? — redirect changes two constants in `src/budget.ts`.
  - **Stakes:** both — too low refuses legitimate callers with `429`, too high lets a leaked key spend more per day (brief priority 2, cost).
  - **Needs user input:** user-held preference or subjective taste (a spend budget). The plan ships 100 reports/day and 4 in flight, i.e. ≤1,000 model calls/day.
- [ ] Should generation be inline (caller waits ~1 min) or asynchronous (202 + polling)? — redirect to async replaces Tasks 4–6 with a datastore + queue design session.
  - **Stakes:** both — inline makes callers hold a connection up to 160 s and loses in-progress work on a crash. Async adds infrastructure and recurring cost.
  - **Recommended:** inline with five parallel calls for v1. It is the only option that ships without a new datastore, queue and two runtime dependencies, and it meets the "about a minute" goal [confidence: medium] [anchor: weighing: footprint — async needs a durable store the repo does not have (src/db.ts:9 is a process-local map)]
- [ ] How should the paid endpoint be protected? — redirect to Cloud Run IAM changes `deploy.sh` and every existing caller of the public routes.
  - **Stakes:** both — an unauthenticated paid endpoint lets anyone spend the model budget (brief priority 2, cost).
  - **Recommended:** a bearer API key checked on `POST /reports` only, read from Secret Manager, failing closed when unset. This leaves the existing public read and share routes untouched [confidence: medium] [anchor: weighing: risk — flipping the service off `--allow-unauthenticated` in deploy.sh:3 would break every current anonymous caller of GET and share]
- [ ] Should the service be pinned to one instance? — redirect drops `--max-instances 1` and makes the caps and idempotency per-instance.
  - **Stakes:** system — with several instances, `GET` after `POST` can land on another instance and 404, and the spend cap multiplies by instance count.
  - **Recommended:** yes, `--max-instances 1` until the durable-store candidate lands. Model calls are I/O waits, so one instance at concurrency 80 easily holds 4 in-flight reports [confidence: medium] [anchor: weighing: risk — the in-memory map at src/db.ts:9 is only coherent with one instance]
- [ ] If one section fails after its retry, return a partial report or fail the whole request? — redirect to partial changes the `Report` shape to carry a per-section status.
  - **Stakes:** user — a partial report looks complete unless the caller checks each section (brief priority 1, fewer surprises), but failing wastes up to 4 successful paid calls (priority 2).
  - **Recommended:** fail the whole request with `502`/`504` and save nothing. User experience ranks above cost in the brief, and the existing `sections: string[]` shape has no way to mark a missing section [confidence: medium] [anchor: weighing: risk — a silently partial report is the failure the current client already produces via `undefined` text at src/llm.ts:10]
- [ ] Should the report get a model-suggested title? — redirect adds a sixth paid call (1–3 s) after the sections.
  - **Stakes:** user — reports come back with `title: null`.
  - **Recommended:** no. Keep `title` null and make exactly five calls [confidence: high] [anchor: user: "calling the model API once for each of five sections"]
- [x] Keep `sections` as an ordered `string[]` matching the fixed section list rather than `{name, text}[]` — resolved without asking; the existing type already defines it [anchor: src/db.ts:4]
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision A — where does generation run, and how many instances?**

| Branch | End-to-end caller flow | Interruptions / waits | System consequence |
| --- | --- | --- | --- |
| A1: inline parallel + one instance (chosen) | caller sends one `POST`, holds the connection ~20–60 s (≤160 s), gets `201` + report | 0 interruptions; 1 blocking wait of ~1 min | no new infra; store, caps and idempotency are global; work in flight is lost if the instance dies |
| A2: durable queue + datastore, `202` + status | caller sends `POST`, gets `202` + `Location` in <1 s, polls `GET` every ~5 s about 6–12 times until `done` | 0 interruptions; ~6–12 poll requests per report; caller must implement polling | needs a datastore choice, Cloud Tasks queue (dispatch deadline, max attempts), OIDC-authenticated worker route, two runtime deps; survives restarts |
| A3: inline parallel, autoscaling left on | same as A1, but a follow-up `GET` may 404 on another instance and an idempotent retry can re-spend | 0 interruptions; intermittent 404s | spend cap multiplies by instance count |

A1, A2 and A3 are mutually exclusive. The one-instance pin only matters for inline (it is complementary with A1 and moot under A2). Ranked: A1 > A2 (better long-term, blocked on a datastore decision) > A3.

Verdict: **A1** — ships the requested endpoint with a bounded wait and bounded spend and no new infrastructure. A2 is the ticked follow-up once a datastore is chosen [confidence: medium] [anchor: weighing: footprint — A2 adds a datastore, queue and worker route absent from the repo (deploy.sh:3 is the only infra)].

## Alternatives considered

- **Return 202 and keep generating in a detached promise** — rejected: request-based billing throttles CPU after the response (https://docs.cloud.google.com/run/docs/configuring/billing-settings), and the in-memory store (src/db.ts:9) cannot serve a status resource across restarts.
- **Call the five sections sequentially** — rejected: 5 × the documented 60 s upper bound (src/llm.ts:1) is 300 s, exactly Cloud Run's default request timeout.
- **Let the request body choose the sections** — rejected: the user asked for "five sections", and a caller-supplied list makes paid calls per request unbounded.

## Recommendation

**Proceed** — build the endpoint as asked with the conditions in Request vetting (parallel calls, deadlines, one cost choke point, API key, one instance). The model-client `simplify` verdict (timeouts and status checks) is bundled as Task 1. The durable async path is a ticked follow-up rather than v1 scope [confidence: medium] [anchor: adjacent: src/llm.ts:1]

**Redundancy:** none found — no existing route, helper or script creates reports; `saveReport` is only called by the share route (src/app.ts:20).

## Plan risks

The weakest assumption is that the model API accepts five concurrent requests from one caller. If it rate-limits concurrency, every report hits `429`s, burns its single retries and fails with `502`, and the fix would be a lower in-flight cap or sequential calls with a raised request timeout.

## Cut list

- An `Idempotency-Key` that persists across restarts — the index lives in the same in-memory map as the reports it points at, so durability belongs to the datastore follow-up, not here.
- Per-section resume (re-running only the failed section on a client retry) — saves at most 4 calls on a rare failure path and needs per-key partial state. Left out.
- Configurable caps via environment variables — no named reader needs runtime tuning yet. They are constants until Q2 is answered.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Durable async report generation | High | Large | needs its own design/decision session: the open decision is which durable datastore (Firestore vs Cloud SQL) backs reports and their status rows; every deploy currently erases paid reports | replaces this plan's inline execution model and in-memory store | No |
| Decide who may read and share a report | Low | Small | needs its own design/decision session: the open decision is whether the `shared` flag should gate public reads, since today nothing reads it and every report is public by id | this plan makes reports exist for the first time, which makes the open read path matter | No |

- [x] Durable async report generation — move generation to one Cloud Tasks task per section with a durable parent/child status store and `202` + polling, after choosing the datastore.
  - **UX:** a caller who reads a report after a deploy or an idle period gets `404` for a report they already paid for [anchor: src/db.ts:9]
  - **Problem:** reports live only in process memory, so every deploy and every scale-to-zero erases all of them [anchor: src/db.ts:9]
  - **Stability/efficiency:** each erased report cost 5–10 paid model calls of 20–60 s each to produce [anchor: src/llm.ts:1]
  - **Value rank:** 4 — a user-visible loss with a workaround (keep the creation response body), recurring on every deploy and idle scale-to-zero [anchor: src/db.ts:9]
  - **Complexity:** Large — new datastore, queue, OIDC worker route, two runtime dependencies, deploy changes
  - **Risk:** Medium — new infrastructure and IAM wiring
  - **If never done:** every deploy erases all reports, and callers must hold a connection for up to 160 s per report
  - **Verdict:** clears bar — repeated loss of paid output outweighs the Large complexity once the datastore decision is made
- [ ] Decide who may read and share a report — today anyone with a report id can read it and mark it shared without a key.
  - **UX:** none
  - **Problem:** any caller holding a report id can read it and flip `shared` with no credential [anchor: src/app.ts:16]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk; ids are random UUIDs and nothing reads `shared` [anchor: src/app.ts:12]
  - **Complexity:** Small — the two existing routes
  - **Risk:** Low
  - **If never done:** generated reports stay readable by anyone given a link
  - **Verdict:** below bar — no observed exposure, and the right rule depends on what "shared" is meant to grant

# Task breakdown

### Task 1: Harden the model-API client

- **Skill:** `flow-system-design`
- **Bundled:** the missing timeout and response-status check in the existing model client, surfaced during discovery
- **Description:** Give both model calls a timeout and a status check. Raise a typed `LlmError` instead of returning `undefined`. Emit `reports.llm.call.duration` / `reports.llm.call.failures` through the Task 3 helper once it exists (Task 3 wires the emission; this task leaves a single wrapper function that wiring can target).
- **Inputs:** src/llm.ts
- **Outputs:** hardened client + unit tests with stubbed `fetch`
- **Contract:**
  - **Files:** edit `src/llm.ts`; create `src/llm.test.ts`
  - **Interfaces:** `export class LlmError extends Error { readonly kind: "upstream_error" | "upstream_timeout" | "rate_limited"; readonly retryable: boolean }`; `export const SECTION_TIMEOUT_MS = 75_000`; `export const TITLE_TIMEOUT_MS = 10_000`; `export async function generateSection(company: string, section: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string>` (combines the caller's signal with `AbortSignal.timeout`; 429 → `rate_limited` retryable; 5xx → `upstream_error` retryable; other non-2xx → `upstream_error` not retryable; abort/timeout → `upstream_timeout` retryable; missing or non-string `text` → `upstream_error` not retryable); `suggestTitle(sections: string[], opts?: { timeoutMs?: number })` gets the same checks
  - **Call-site edits:** none (no existing callers)
- **Acceptance criteria:** `bun test src/llm.test.ts` exits 0, covering 200, 429, 500, 400, timeout and missing-`text` cases

### Task 2: Add the single spend choke point

- **Skill:** `flow-system-design`
- **Description:** An in-process report budget that admits a report only when fewer than 4 are in flight and fewer than 100 have started this UTC day. Every report reserves here before any model call, and the reservation is released in `finally`. A failed report still counts against the day (its calls were paid).
- **Inputs:** none (`new: src/budget.ts`)
- **Outputs:** budget module + tests
- **Contract:**
  - **Files:** create `src/budget.ts`, `src/budget.test.ts`
  - **Interfaces:** `export const MAX_CONCURRENT_REPORTS = 4`; `export const MAX_REPORTS_PER_DAY = 100`; `export type Reservation = { release(): void }`; `export type BudgetRefusal = { kind: "rate_limited" | "budget_exhausted"; retryAfterSeconds: number }`; `export type Budget = { tryReserve(): Reservation | BudgetRefusal }`; `export function createBudget(opts: { maxConcurrent: number; maxPerDay: number; now?: () => Date }): Budget`; `export const reportBudget: Budget`. `rate_limited` retry-after is 30 s; `budget_exhausted` retry-after is the seconds until the next UTC midnight. `release()` is idempotent.
  - **Call-site edits:** none (consumed by Task 4)
- **Acceptance criteria:** `bun test src/budget.test.ts` exits 0, covering the 5th concurrent refusal, release-then-admit, the daily cap with retry-after to midnight, rollover at UTC midnight via injected `now`, and double `release()` not freeing two slots

### Task 3: Create the metrics helper and contract

- **Skill:** `flow-metrics`
- **Description:** Create a dependency-free metrics helper with an in-memory recorder, plus `.flow/metrics.md`, for `reports.create.duration`, `reports.create.failures`, `reports.create.active`, `reports.llm.call.duration` and `reports.llm.call.failures`. The closed `error.type` list is `_OTHER`, `budget_exhausted`, `internal`, `invalid_input`, `rate_limited`, `unauthorized`, `upstream_error`, `upstream_timeout`. Wrap `generateSection`'s fetch in `instrument("reports.llm.call", …)`.
- **Inputs:** Task 1's `LlmError`
- **Outputs:** helper, metrics contract file, emission tests
- **Contract:**
  - **Files:** create `src/metrics.ts`, `src/metrics.test.ts`, `.flow/metrics.md`; edit `src/llm.ts` (wrap the call)
  - **Interfaces:** `export type ErrorType = "_OTHER" | "budget_exhausted" | "internal" | "invalid_input" | "rate_limited" | "unauthorized" | "upstream_error" | "upstream_timeout"`; `export type Operation = "reports.create" | "reports.llm.call"`; `export type Attributes = { "operation.outcome"?: "ok" | "error"; "error.type"?: ErrorType; "server.address"?: "api.example-llm.com" }`; `export type Recorder = { histogram(name: string, seconds: number, attrs: Attributes): void; counter(name: string, attrs: Attributes): void; upDown(name: string, delta: number): void }`; `export function memoryRecorder(): Recorder & { histograms: Array<{ name: string; seconds: number; attrs: Attributes }>; counters: Array<{ name: string; attrs: Attributes }>; levels: Map<string, number> }`; `export function setRecorder(r: Recorder): void`; `export function toErrorType(value: unknown): ErrorType` (unknown → `_OTHER`); `export async function instrument<T>(op: Operation, fn: () => Promise<T>, classify: (err: unknown) => ErrorType, attrs?: Pick<Attributes, "server.address">): Promise<T>` (records `<op>.duration` with outcome, `<op>.failures` with `error.type` on throw, and `reports.create.active` ±1 in try/finally for `reports.create`)
  - **Call-site edits:** `src/llm.ts` `generateSection` — wrap the fetch in `instrument("reports.llm.call", …, e => e instanceof LlmError ? e.kind : "_OTHER", { "server.address": "api.example-llm.com" })`
  - `.flow/metrics.md` sections: `## Backend` (`none yet — suggested: Google Cloud Monitoring via OTLP`), `## Namespace` (`reports`), `## Attributes`, `## error.type values` (client-caused marked on `invalid_input`, `unauthorized`), `## Helper` (`src/metrics.ts`), `## Dashboard panels`, `## Dashboards` (none yet), `## Alerts` (burn-rate tiers + the daily-cap row), `## As-code` (`spec-only`), `## SLOs` ("generate a company report"), `## Coverage` (`reports.create`, `reports.llm.call`)
- **Acceptance criteria:** `bun test src/metrics.test.ts src/llm.test.ts` exits 0, asserting one `ok` observation on success, one `error` observation plus one failures increment with the exact `error.type` per `LlmError` kind, `_OTHER` for an unknown error, and `reports.create.active` back at 0 after both success and failure; `grep -q "reports.create.duration" .flow/metrics.md` exits 0

### Task 4: Report generation with idempotency

- **Skill:** `flow-system-design`
- **Description:** The domain operation behind the endpoint: idempotency lookup and single-flight, cap reservation, five parallel section calls under a 160 s report deadline with one jittered retry per retryable failure when ≥75 s remain, all-or-nothing save. The idempotency key is the caller's `Idempotency-Key` header. Its index lives in `src/db.ts` beside the reports.
- **Inputs:** src/budget.ts (Task 2), src/llm.ts (Task 1), src/db.ts
- **Outputs:** `src/reports.ts`, idempotency index in the store, tests
- **Contract:**
  - **Files:** create `src/reports.ts`, `src/reports.test.ts`; edit `src/db.ts`
  - **Interfaces:** `export const REPORT_SECTIONS = ["Company overview", "Products and services", "Market and competitors", "Financial performance", "Risks and outlook"] as const`; `export const REPORT_DEADLINE_MS = 160_000`; `export class ReportError extends Error { readonly kind: "rate_limited" | "budget_exhausted" | "invalid_input" | "upstream_error" | "upstream_timeout"; readonly retryAfterSeconds?: number }`; `export type ReportDeps = { generate: (company: string, section: string, opts: { signal: AbortSignal }) => Promise<string>; budget: Budget; sleep: (ms: number) => Promise<void>; newId: () => string }`; `export const defaultReportDeps: ReportDeps`; `export async function createReport(company: string, idempotencyKey: string | undefined, deps?: ReportDeps): Promise<{ report: Report; replayed: boolean }>`. Key seen with the same company → returns the stored report (or awaits the in-flight promise) with `replayed: true` and makes no model calls. Key seen with a different company → `ReportError("invalid_input")`. Report deadline exceeded → abort the remaining calls and raise `upstream_timeout`. db.ts adds `export function getIdempotencyEntry(key: string): { company: string; reportId: string } | undefined` and `export function setIdempotencyEntry(key: string, entry: { company: string; reportId: string }): void`
  - **Call-site edits:** none (consumed by Task 5)
- **Acceptance criteria:** `bun test src/reports.test.ts` exits 0, covering five sections in `REPORT_SECTIONS` order; parallelism (five 50 ms stubs finish in <200 ms, test "runs sections in parallel"); one retry then success; two failures → `upstream_error` with nothing saved; deadline abort → `upstream_timeout` (injected short deadline); idempotent replay with 5 total calls; concurrent same-key requests sharing one generation; key reuse with a different company → `invalid_input`; budget refusal → no model call

### Task 5: Wire `POST /reports` into the router

- **Skill:** `flow-new-feature`
- **Description:** Add the route. It checks the bearer key (constant-time compare against `REPORTS_API_KEY`; `503` when unset), validates `{"company"}` (string, trimmed, 1–200 chars) and maps `ReportError` to HTTP. It records `reports.create.*` through `instrument("reports.create", …)`. Wrap the handler in a factory so tests inject deps and the key. The existing `handle` export and the GET/share routes keep their behaviour.
- **Inputs:** src/reports.ts (Task 4), src/metrics.ts (Task 3), src/app.ts
- **Outputs:** the endpoint + handler tests
- **Contract:**
  - **Files:** edit `src/app.ts`; create `src/app.test.ts`
  - **Interfaces:** `export function createHandler(opts?: { deps?: ReportDeps; apiKey?: string | undefined }): (req: Request) => Promise<Response>` (`apiKey` defaults to `process.env.REPORTS_API_KEY`); `export const handle = createHandler()`. Status map: `201` + `Location` (`200` on replay); `400` invalid body; `401` bad or missing key; `422` key reuse with a different company; `429` + `Retry-After` for `rate_limited` / `budget_exhausted`; `502` `upstream_error`; `504` `upstream_timeout`; `503` no key configured. All error bodies are `{"error": "<message>"}`.
  - **Call-site edits:** `src/app.ts` `Bun.serve({ fetch: handle })` unchanged (still uses the exported `handle`)
- **Acceptance criteria:** `bun test src/app.test.ts` exits 0 with tests named "returns 201 with five sections", "GET returns a report created by POST", "401", "503 when no API key", "400", "concurrency cap", "replays an Idempotency-Key", "422", "502"; then `bun test` exits 0 for the whole suite

### Task 6: Deploy settings for the paid endpoint

- **Skill:** `flow-system-design`
- **Description:** Pin the service to one instance (keeps the in-memory store, caps and idempotency index global), set the request timeout above the report deadline, and inject the API key from Secret Manager.
- **Inputs:** deploy.sh
- **Outputs:** updated deploy command
- **Contract:** _(config/infra surgical form)_
  - **Files:** edit `deploy.sh`
  - **Interfaces:** `gcloud run deploy reports-service` flags. Before: `--source . --region us-central1 --allow-unauthenticated`. After: same, plus `--max-instances 1 --concurrency 80 --timeout 180 --set-secrets REPORTS_API_KEY=reports-api-key:latest`
  - **Call-site edits:** none
- **Acceptance criteria:** `grep -q -- '--max-instances 1' deploy.sh && grep -q -- '--timeout 180' deploy.sh && grep -q -- '--set-secrets REPORTS_API_KEY=reports-api-key:latest' deploy.sh && bash -n deploy.sh` exits 0

| Task | Depends on |
| --- | --- |
| 1 | — |
| 2 | — |
| 3 | 1 |
| 4 | 1, 2 |
| 5 | 3, 4 |
| 6 | — |

### Skills Summary

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-system-design | Yes (Tasks 1, 2, 4, 6) | timeouts, retry layer, idempotency, spend cap and Cloud Run settings |
| flow-metrics | Yes (Task 3) | first instrumented change: helper + `.flow/metrics.md` |
| flow-new-feature | Yes (Task 5) | the user-facing endpoint wiring |
| flow-testing | No (folded into each task) | each task ships its own `bun test` file; no separate test task |
| flow-refactoring | No | no behaviour-preserving restructure |
| flow-ui-ux | No | no UI surface in this service |

# PR description draft

## TLDR

You can now ask the service for a five-section company report in one authenticated request and get it back in about a minute. Before, there was no way to create a report at all.

## User-facing changes

- New endpoint: `POST /reports` with `{"company": "<name>"}` and an `Authorization: Bearer <key>` header returns the finished five-section report (`201`, plus a `Location` header for reading it again).
- Re-sending a request with the same `Idempotency-Key` header returns the same report instantly, at no extra model cost.
- Callers are refused clearly instead of silently charged: `401` without the key, `400` for a missing or over-long company name, `429` with a `Retry-After` when 4 reports are already running or the day's 100-report allowance is spent.
- A report never comes back with a missing or garbled section. If a section still fails after one retry, the request fails (`502`/`504`) and nothing is saved.

## System changes

- The service now makes paid model calls: five per report, run at the same time, at most ten with retries.
  - **Before:** the service made no model calls.
  - **After:** each report costs 5 paid generation calls. Spend is capped at 100 reports (≤1,000 calls) per day and 4 reports in flight.
- The service is pinned to a single instance with a 3-minute request limit.
  - **Before:** Cloud Run scaled instances freely under its 5-minute default limit.
  - **After:** one instance serves all traffic, so stored reports, the caps and repeat detection are consistent. It no longer scales out under load.
- Deploying now needs a `reports-api-key` secret in Secret Manager. The deploy fails if it is missing, and the endpoint refuses all requests if the key is not configured.

## Why

Reports could be read and shared, but nothing could produce one. Each report takes five slow, paid model calls, and the service is publicly reachable, so a create path without limits would leave callers waiting unpredictably and leave model spend open to anyone who finds the URL.

## Key decisions

- **The caller waits for the finished report** instead of getting a ticket and polling. Asynchronous generation needs a durable datastore and a task queue the service does not have. That path is a follow-up once a datastore is chosen.
- **The five sections run at the same time**, so a report takes about as long as its slowest section (~1 min) rather than up to 5 min, which would hit the platform's request limit.
- **One retry per section, and all-or-nothing results.** A report missing a section would look complete; failing costs up to four wasted calls on a rare path.
- **API key on the create endpoint only.** Locking the whole service down would break existing anonymous readers of reports and share links.
- **One instance.** Stored reports live in memory, so a second instance would answer "not found" for reports created on the first and double the spend ceiling.
- **No title.** Reports come back with no title, matching the request for one call per section.
- Bundled: the model client now times out and reports API errors instead of returning blank section text.

## Instrumentation

Spec-only (no metrics backend yet; suggested Google Cloud Monitoring). First instrumented change: it creates the metrics contract with report-creation latency, outcome and failures by type, model-call latency and failures, and in-flight reports. Panels land on a planned "reports-service overview" dashboard, plus a new "generate a company report" SLO (99% availability, 95% under 90 s) and a notify alert when the daily cap is spent. Graphs need a backend choice before they show anything.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/app.test.ts -t "returns 201 with five sections"` — a valid request returns the five-section report with exactly 5 model calls.
- [ ] Run `bun test src/app.test.ts -t "GET returns a report created by POST"` — the created report reads back by id.
- [ ] Run `bun test src/app.test.ts -t "401"` — a missing or wrong key is refused with no model calls.
- [ ] Run `bun test src/app.test.ts -t "503 when no API key"` — an unconfigured key refuses every request.
- [ ] Run `bun test src/app.test.ts -t "400"` — invalid bodies are refused with no model calls.
- [ ] Run `bun test src/budget.test.ts` — the concurrency cap, daily cap and midnight rollover hold.
- [ ] Run `bun test src/app.test.ts -t "replays an Idempotency-Key"` — a repeat returns the same report with no new calls.
- [ ] Run `bun test src/app.test.ts -t "422"` — a reused key with a different company is refused.
- [ ] Run `bun test src/app.test.ts -t "502"` — a section failing twice fails the request and saves nothing.
- [ ] Run `bun test src/reports.test.ts -t "runs sections in parallel"` — five stubbed 50 ms sections finish in under 200 ms.
- [ ] Run `bun test src/llm.test.ts` — 429, 5xx, timeout and malformed replies raise typed errors.
- [ ] Run `grep -q -- '--max-instances 1' deploy.sh && grep -q -- '--timeout 180' deploy.sh && grep -q -- '--set-secrets REPORTS_API_KEY=reports-api-key:latest' deploy.sh` — deploy settings are in place.
- [ ] DECISION: you accept that callers hold one connection for ~20–60 s (up to 160 s on a retried section) per report, instead of getting an immediate ticket and polling.
- [ ] DECISION: you accept pinning the service to one instance (no scale-out) until reports move to a durable store.
