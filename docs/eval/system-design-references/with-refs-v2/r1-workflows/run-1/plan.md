# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Due-diligence report generation

**Goal:** A caller can request a six-section due-diligence report on a company and retrieve it minutes later, with the executive summary drawn from the five finished sections.

## Problem Statement

This service exists to produce and hand out written reports about companies, but today nothing can create one: there is no way to ask for a report, so the read and share features have nothing to work on. The user wants a due-diligence report with six sections, each written by the model, where the executive summary is written from the other five. Done naively, the request is slow and fragile: every model call takes 20-60 seconds and costs money, so a caller would wait up to two minutes, and a dropped connection or a restarted server would throw away paid work with no record of it.

| Fact | Evidence |
| --- | --- |
| No code path creates a report; the store is only read, and written back by the share action | [anchor: src/app.ts:13] [anchor: src/app.ts:20] |
| Reports live in an in-memory map that disappears on every restart and is not shared between server instances | [anchor: src/db.ts:9] |
| A section call takes 20-60 s and is paid; it takes only a company name and section name, so it cannot be given the five sections the summary needs | [anchor: src/llm.ts:1] [anchor: src/llm.ts:2] |
| The model client has no timeout and does not check for a failed response, so an error body would be saved as section text | [anchor: src/llm.ts:6] [anchor: src/llm.ts:10] |
| The service is deployed publicly, so any new "create" action is reachable by anyone and each call spends money | [anchor: deploy.sh:3] |

Priorities this lands on (product brief): **user experience** (the caller should not sit on a two-minute request or re-check whether work was lost), then **cost** (six paid calls per report must have a ceiling), then **architecture** (how a multi-step paid job fails and recovers).

## Request vetting

- **Hypothesis:** Six model calls per report (five independent sections, then one summary call fed the five texts) can be run reliably and within a spend ceiling on the existing Cloud Run service, and the caller gets a usable report.
- **Case against:** Run "as asked" inside one request, the job takes two sequential 20-60 s rounds (up to ~120 s) on a platform that throttles CPU outside a live request, writes into a per-instance memory map, and is publicly triggerable, so paid work is lost on any disconnect or deploy and spend is unbounded [anchor: src/llm.ts:1] [anchor: src/db.ts:9] [anchor: deploy.sh:3]. Separately, the section prompt carries only the company name, so every fact is model recall, not sourced [anchor: src/llm.ts:8].
- **Sources:** https://docs.cloud.google.com/run/docs/configuring/billing-settings (CPU only during requests); https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks (dispatch deadline, named-task dedupe)
- **Verdict:** adopt-with-conditions: generation runs as one queued task per section over a durable shared store with a daily model-call cap, never inside the caller's request, and the executive-summary call receives the finished section texts as input.

## Existing-code assessment

- **src/db.ts:** rewrite — the synchronous in-memory map cannot be shared with a worker service; it becomes an async store interface with an in-memory implementation (tests, local) and a Firestore implementation (production) [anchor: src/db.ts:9]
- **src/llm.ts:** simplify — add a timeout, a failed-response check and typed errors before adding the summary call; the current client saves `undefined` on an error body [anchor: src/llm.ts:10]
- **src/app.ts:** simplify — move from a single exported handler with module-level imports to a handler built from injected dependencies, so the new routes are testable without network calls [anchor: src/app.ts:9]
- **deploy.sh:** rewrite — one public service becomes a public API service plus a private worker service and a Cloud Tasks queue [anchor: deploy.sh:3]

## Scope Boundary

**In scope:**

- Start a report for a company name; get back an id and a status link immediately.
- Five content sections generated in parallel, then an executive summary generated from the finished five.
- Report and per-section status (queued, running, done, failed) readable at the existing "get report" address.
- Reports survive restarts and are visible across server instances.
- A daily cap on model calls, checked before every call; caller authentication on the "start a report" action.
- Failed sections are visible on the report rather than silently dropped; the summary is written from the sections that succeeded.
- Metrics spec and helper for the new operations.

**Out of scope:**

- Grounding sections in real sources (filings, web retrieval) — tracked as a candidate follow-up.
- Auto-generated report titles (the existing title-suggestion call stays unused; title stays empty).
- Per-section regeneration on demand, editing, deleting or listing reports.
- Push updates (SSE / WebSockets); the caller polls.
- Changing access rules on the existing read and share actions — tracked as a candidate follow-up.
- Dashboards or alerts as code (spec-only; no metrics backend chosen yet).

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| There is no way to ask for a report; reading a report id always returns "not found" | The caller sends a company name with the service key and gets back a report id and status link within about a second |
| — | Polling the report shows each of the six sections move from queued to done; the full report is usually ready in 1-2 minutes |
| — | If a section fails after retries, the report ends as `partial`, the failed section says so, and the summary covers the sections that succeeded |
| — | When the day's model-call budget is used up, starting a report is refused with "try again later" before any money is spent |

### System flow

- **Before:**
  - One public Cloud Run service; reports held in process memory; the model client is never called.
- **After:**
  - The public API service writes the report to Firestore and enqueues five section tasks on a Cloud Tasks queue.
  - A private worker service (same image, authenticated by the queue's identity) runs one model call per task, records it in a daily spend ledger, and saves the section.
  - The fifth section to finish enqueues the executive-summary task exactly once; that task reads the five texts, writes the summary and sets the final report status.
  - Each report costs six model calls (up to 18 in the worst case, with three attempts per section), all counted against the daily cap.

**Lost:** none in practice — the report's section list changes from plain strings to section objects with a status, but no code path could ever create a report before this change, so no caller can have received the old shape.

## User Stories / Acceptance Criteria

### Story 1: Start a report

- [ ] Given a valid service key and `{"company":"Acme Corp"}`, when the caller posts to `/reports`, then the response is 202 with a `Location: /reports/<id>` header and status `queued`, and exactly five section tasks are enqueued (test: `bun test src/app.test.ts`)
- [ ] Given a missing or wrong key, when the caller posts, then the response is 401 and nothing is stored or enqueued (test: `bun test src/app.test.ts`)
- [ ] Given an empty company or one longer than 200 characters, when the caller posts, then the response is 400 and nothing is enqueued (test: `bun test src/app.test.ts`)
- [ ] Given the same `Idempotency-Key` sent twice with the same company, when the caller posts again, then the same report id is returned and no new tasks are enqueued; with a different company the response is 422 (test: `bun test src/app.test.ts`)
- [ ] Given the daily cap has fewer than six calls left, when the caller posts, then the response is 429 with `Retry-After` and nothing is stored (test: `bun test src/app.test.ts`)

### Story 2: Sections are generated once each

- [ ] Given a queued section, when its task runs, then exactly one model call is made, one ledger reservation is recorded, and the section is saved as `done` (test: `bun test src/report-worker.test.ts`)
- [ ] Given a section already `done`, when its task is redelivered, then no model call is made and the task completes (test: `bun test src/report-worker.test.ts`)
- [ ] Given a model timeout on attempt 1 or 2, when the task runs, then the worker answers 503 so the queue retries; on the last attempt it marks the section `failed` with `upstream_timeout` and answers 200 (test: `bun test src/report-worker.test.ts`)
- [ ] Given the daily cap is exhausted mid-report, when a section task runs, then no model call is made and the section is `failed` with `budget_exhausted` (test: `bun test src/report-worker.test.ts`)

### Story 3: The executive summary is written from the other five

- [ ] Given all five sections reach a final state concurrently, when the last one finishes, then the executive-summary task is enqueued exactly once (test: `bun test src/report-worker.test.ts`)
- [ ] Given five finished sections, when the summary task runs, then the summary model call receives all five section titles and texts, and the report ends `done` (test: `bun test src/report-worker.test.ts`)
- [ ] Given four done and one failed, when the summary runs, then it is written from the four, names the missing section, and the report ends `partial`; given zero done, no summary call is made and the report ends `failed` (test: `bun test src/report-worker.test.ts`)

### Story 4: Read progress

- [ ] Given a report in progress, when the caller gets `/reports/<id>`, then the body carries the report status and all six sections in catalog order with their status and text-or-null (test: `bun test src/app.test.ts`)
- [ ] Given the worker route, when it is called on the public API service, then it answers 404 (test: `bun test src/app.test.ts`)

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports.create.duration` | Histogram (request-scale bounds, 14) | seconds | `operation.outcome` (`ok`, `error`) | start-report handler |
| `reports.create.failures` | Counter | none | `error.type` (`budget_exhausted`, `internal`, `invalid_input`, `unauthorized`, `_OTHER`) | start-report handler |
| `reports.section.duration` | Histogram (bounds 5, 10, 20, 30, 45, 60, 90) | seconds | `operation.stage` (6 section keys), `operation.outcome` (`ok`, `error`) | section worker |
| `reports.section.failures` | Counter | none | `error.type` (full closed list, 9 values) | section worker |
| `reports.generate.duration` | Histogram (bounds 30, 60, 90, 120, 180, 300, 600) | seconds | `operation.outcome` (`ok` = done, `error` = partial or failed) | executive-summary task, at final status |
| `reports.llm.request.duration` | Histogram (bounds 5, 10, 20, 30, 45, 60, 90) | seconds | `server.address` (`api.example-llm.com`), `operation.outcome` | model client |
| `reports.llm.request.failures` | Counter | none | `error.type` (`rate_limited`, `upstream_error`, `upstream_timeout`, `_OTHER`), `server.address` | model client |
| Cloud Tasks queue depth | Gauge | `{message}` | `messaging.destination.name` (`report-sections`) | platform-native (Cloud Tasks `queue/depth`) |
| Worker concurrency and instance count | — | — | — | platform-native (Cloud Run) |

- Estimated series: 39 per operation for `reports.create` (2 x 17 + 5)
- Estimated series: 129 per operation for `reports.section` (6 x 2 x 10 + 9) — over 100, justified: the stage set is the six section keys, fixed by code, and this is the panel that shows which section is slow or failing
- Estimated series: 20 per operation for `reports.generate` (2 x 10)
- Estimated series: 24 per operation for `reports.llm.request` (1 x 2 x 10 + 4)
- Samples per month (Google Cloud Monitoring, 60 s export, per instance): about 212 series x up to 12 samples x 43,200, roughly 110 million worst case, about $6.60 a month per instance at $0.06 per million; in practice far lower because empty buckets are not billed — only relevant once a backend is chosen.

**Attributes:** new registry rows — `error.type` (closed list below), `operation.outcome` (`ok`, `error`), `operation.stage` (`company_overview`, `financials`, `market`, `management`, `risks`, `executive_summary`), `server.address` (`api.example-llm.com`), `messaging.destination.name` (`report-sections`)

### Error types

New list (`.flow/metrics.md` is created by this change):

| Value | Meaning |
| --- | --- |
| `_OTHER` | fallback: no listed class fits |
| `budget_exhausted` | the daily model-call cap is used up (service-side, not client-caused) |
| `internal` | unexpected failure inside this service |
| `invalid_input` | bad company name or idempotency-key mismatch (client-caused) |
| `not_found` | no such report (client-caused) |
| `rate_limited` | the model API answered 429 |
| `unauthorized` | missing or wrong service key (client-caused) |
| `upstream_error` | the model API answered with a failure or an unreadable body |
| `upstream_timeout` | the model API did not answer within 90 s |

### Dashboard panels

On a new "reports-service overview" dashboard (spec-only): request rate, success vs failure, failures by `error.type` and latency p50/p95/p99 for `reports.create`; per-stage p95 and failures by `error.type` for `reports.section`; end-to-end latency p50/p95 for `reports.generate`; model-API latency and failures; Cloud Tasks queue depth (platform-native).

### Alerts

| Signal | Condition | Sustained for | Action | Routes to | Dashboard |
| --- | --- | --- | --- | --- | --- |
| Section failures with `budget_exhausted` | rate above 0 | 5m | notify | `#reports-alerts` | reports-service overview |

Plus the standard burn-rate tiers for the new journey SLO, recorded once in `.flow/metrics.md`.

### SLO

New journey SLO "generate a due-diligence report": availability — 99% of started reports end `done` or `partial` (client-caused failures excluded); latency — 95% of reports reach a final status within 300 s; 30-day window.

**As-code:** spec-only — the repo keeps no dashboard or alert files and no metrics backend is chosen.

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | HTTP handlers, persistence, model-API client, queue integration, deploy config |
| Domain modules | existing: `src/app.ts`, `src/db.ts`, `src/llm.ts`; new: `src/sections.ts` (section catalog), `src/db-firestore.ts`, `src/queue.ts`, `src/report-worker.ts`, `src/metrics.ts` |
| Data flow | caller posts company, API stores the report and enqueues five tasks, worker calls the model and saves each section, the last finisher enqueues the summary, summary task reads five texts and writes the summary, caller polls the report |
| Pattern | parent report plus per-section state with one queued task per section and a guarded fan-in (system-design multi-step pattern); the six section states live inside the one report document because the set is fixed and small, so the fan-in guard is a single-document transaction |
| Binary-framing check | the request is not framed as either/or; the real fork (inline vs one task per report vs one task per section) is in Decision analysis |
| Goal anchor | every decision is checked against "retrieve it minutes later": nothing here makes the caller hold a connection open |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| Start report (public POST) | ~1 s | inline — ~1 s, timeout 10 s (Firestore write 5 s, each enqueue 5 s) | 10 s handler | none server-side; caller retries with `Idempotency-Key` | optional `Idempotency-Key` header, hashed into the report id | new daily spend ledger pre-check (room for 6 calls) + public service max 3 instances |
| Generate one section (worker) | ~65 s | Cloud Tasks queue `report-sections` + private worker invoked synchronously under the dispatch deadline | dispatch deadline 180 s > handler 150 s > model call 90 s | Cloud Tasks only: max attempts 3, backoff 10-300 s, max doublings 4 | `<reportId>:<sectionKey>` — task name + section claim with a 160 s lease in the report document | new daily spend ledger: reserve before each call; queue max 10 concurrent dispatches, 2 per second |
| Executive summary (worker) | ~65 s | same queue and worker; enqueued once by the fan-in guard | same as above | same as above | `<reportId>:executive_summary` | same ledger; skipped entirely when no section succeeded |
| Model API call (outbound) | ~60 s | called only from the worker | 90 s abort | none in the client (one retry layer: the queue) | covered by the section key | counted by the ledger reservation |
| Read report (public GET) | <300 ms | inline — <300 ms, timeout 5 s | 5 s | none | n/a (read) | none needed |

**Platform:** gcp

**Proportionality:** no outbox (if an enqueue fails after the report is written, the report is marked `failed` and the caller gets 503 to retry), no workflow engine, no subcollection per section (six fixed sections fit in one document), no SSE or WebSockets (polling is enough for a 1-2 minute job), no per-caller rate limiter beyond the daily cap (one shared service key), no stale-report sweeper (the queue's last attempt always marks a final state), no Terraform.

**Recovery:** none — every report is a regenerable paid generation (six model calls to rebuild) and the only user input, the company name, is stored on the report itself; losing the store loses at most that day's spend, which the daily cap bounds.

## Technical Constraints

- New runtime dependencies need a stated reason (AGENTS.md "No new runtime dependencies without a reason"): `@google-cloud/firestore` and `@google-cloud/tasks` are added because a shared durable store and an authenticated queue are prerequisites, and hand-written REST plus token handling would be more code to get wrong.
- Tests run with `bun test` (AGENTS.md); no test may reach the network. Store, queue and model client are injected and faked.
- The worker must never be reachable on the public service: Cloud Run request-based CPU throttles post-response work, and a public worker route would bypass the queue's rate and spend caps ([gcp.md: Cloud Tasks OIDC](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks)).
- Cost: each report costs 6 model calls normally, up to 18 if every section uses all three attempts; the daily cap is enforced at one place, before each call.
- Latency: the caller's request stays near 1 s; the report is typically complete in 40-120 s (two rounds of 20-60 s calls) [anchor: src/llm.ts:1].

## Open Questions

- [ ] **Q1** Which five content sections should the report have? Changes the section catalog, prompts and the metrics stage list.
  - **Stakes:** user — the report's content is what the reader pays for; a wrong section set means re-running every report
  - **Needs user input:** a user-held preference — what a due-diligence reader in this product expects to see. Default if unanswered: Company Overview, Financial Performance, Market and Competitive Landscape, Management and Governance, Legal, Regulatory and Operational Risks (plus Executive Summary).
- [ ] **Q2** What daily model-call cap should the service enforce? Changes the ledger default and when starting a report is refused.
  - **Stakes:** both — too low refuses legitimate work (user experience), too high lets a leaked key spend freely (cost)
  - **Needs user input:** a user-held preference — the acceptable daily spend. Default if unanswered: 300 calls a day (50 reports at six calls each).
- [ ] Who may start a report, and how? Changes the auth check on the start action.
  - **Stakes:** both — anyone on the internet could trigger six paid calls per request on a public service
  - **Recommended:** require a shared service key sent as a bearer token, stored in Secret Manager; leave the existing read and share actions as they are — the public deploy is the risk and one key is the smallest gate [confidence: medium] [anchor: weighing: risk — deploy.sh allows unauthenticated callers, so an unguarded start action is open-ended spend]
- [ ] Where are reports stored? Changes the store implementation, dependencies and deploy steps.
  - **Stakes:** system — cost and operational load of the store
  - **Recommended:** Firestore (native mode) — billed per operation, no connection pool, transactions cover the fan-in guard; Cloud SQL is rejected under Alternatives [confidence: medium] [anchor: weighing: footprint — one small document per report does not justify an always-on database instance]
- [ ] What does the executive-summary call receive? Changes the summary prompt and the model client's interface.
  - **Stakes:** user — a summary not built from the sections contradicts them
  - **Recommended:** the titles and full texts of the finished content sections, each capped at 6,000 characters, plus the names of any failed sections [confidence: high] [anchor: user: "the executive summary section is written from the other five sections"]
- [ ] What happens when a content section fails after all retries? Changes whether the summary runs and the final status.
  - **Stakes:** user — all-or-nothing throws away paid sections; partial risks a summary that silently omits something
  - **Recommended:** write the summary from the sections that succeeded, name the missing ones in it, and mark the report `partial`; skip the summary call when none succeeded (see Decision 2) [confidence: medium] [anchor: weighing: reversibility — a partial report can be regenerated later, discarded paid sections cannot be recovered]
- [ ] Should the report get an auto-generated title? Changes whether a seventh paid call is added.
  - **Stakes:** user — reports are listed by title elsewhere only if someone builds that
  - **Recommended:** no — leave the title empty; the title-suggestion call exists but nothing reads a title today, and it adds one paid call per report [confidence: medium] [anchor: weighing: footprint — not requested and no reader of the title exists in the handlers]
- [ ] Should repeated start requests be de-duplicated? Changes the start action's contract.
  - **Stakes:** system — a client retry after a timeout would otherwise pay for a second report
  - **Recommended:** accept an optional `Idempotency-Key` header; the same key and company returns the same report, a different company with the same key is refused [confidence: medium] [anchor: weighing: risk — without it a network retry doubles spend]
- [x] Should the worker poll for progress or push it? — resolved without asking: the caller polls the existing read address.
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision 1 — How is the six-call job executed?** (mutually exclusive)

| Branch | What the caller experiences | What the system does | Interruptions per run |
| --- | --- | --- | --- |
| A. Inline in the request | posts and waits 40-120 s for the full report; a dropped connection loses it | six calls inside one request, results in memory | 1 blocking wait of up to ~120 s |
| B. One queued task per report | posts, gets an id in ~1 s, polls; ready in 1-2 min | one task runs five calls in parallel then the summary; a retry re-runs the whole task, skipping saved sections | 0 — polls only |
| C. One queued task per section plus a guarded fan-in | posts, gets an id in ~1 s, polls and sees each section appear; ready in 1-2 min | five tasks run independently; the last finisher enqueues the summary once | 0 — polls only |

- Ranking: C > B > A. A fails the 10 s interactive budget and loses paid work (closed under Alternatives). B and C give the same user experience; C retries one section at a time with its own attempt count and shows per-section progress, at the cost of a fan-in guard.
- Verdict: **C, one task per section** — matches the house pattern for multi-section generated reports and isolates each paid call's retries [confidence: medium] [anchor: weighing: convention — the system-design guidance prescribes one queued task per section plus a parent status for multi-section generated reports]

**Decision 2 — What does a partly failed report look like?** (mutually exclusive)

| Branch | What the caller sees | Cost |
| --- | --- | --- |
| All-or-nothing | any failed section, the report is `failed`, no summary | the successful sections are paid for and hidden |
| Partial with summary | the report is `partial`; failed sections say so; the summary covers what succeeded and names what is missing | one summary call even when a section failed |

- Verdict: **partial with summary**, and no summary call when zero sections succeeded — keeps paid work visible and degrades gracefully, the product brief's product-quality priority [confidence: medium] [anchor: weighing: reversibility — a partial report can be regenerated, discarded sections cannot]

## Alternatives considered

- **Generate all six sections inside the POST request** — rejected: aggregate p99 is ~120 s against the 10 s interactive budget (src/llm.ts:1), and Cloud Run request-based CPU throttles work outside a live request.
- **Keep the in-memory map as the store** — rejected: the worker runs on a separate service and instances are disposable, so a per-instance map cannot hold shared status (src/db.ts:9).
- **Cloud SQL Postgres as the store** — rejected: an always-on billed instance and a connection pool for one small document per report.

## Recommendation

**Proceed** — build the report as asked, executed as queued per-section work over Firestore with a daily cap and a guarded summary step; the existing-code verdicts (rewrite the store, simplify the model client and handler, rewrite the deploy script) are prerequisites, all bundled. Confirm Q1 (sections) and Q2 (cap). [confidence: medium] [anchor: weighing: risk — the inline alternative loses paid work on any disconnect or deploy]

**Redundancy:** none found — no existing code creates a report; the unused section and title calls in the model client are building blocks this plan consumes, not a duplicate.

## Plan risks

The plan delivers reliable plumbing, but every section is written from the company name alone with no source material, so the weakest assumption is that model-recall content is accurate enough to be useful as due diligence at all (see the grounding candidate below).

## Cut list

- The `reports.generate.duration` end-to-end histogram overlaps the per-section histograms; it is kept only because the journey SLO's latency target needs it — cut it if the SLO is dropped.
- The `Idempotency-Key` support could wait for a second client; kept because a single retry otherwise pays for a whole second report.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Ground due-diligence sections in real source material | High | Large | genuinely novel non-trivial feature: retrieval of filings or web sources and citations per section is its own surface; due-diligence facts are otherwise unsourced model recall | improves the content of every section this plan generates | No |
| Decide and enforce who may read and share a report | Medium | Medium | needs its own design/decision session: the open decision is who may read and share a report (owner key, per-user auth, or share links) once reports exist | the read and share actions become meaningful only once this plan creates reports | No |

- [x] Ground due-diligence sections in real source material — pass retrieved filings or web sources into each section prompt and return citations.
  - **UX:** every reader of a report gets facts they can check against a cited source instead of unsourced model recall [anchor: src/llm.ts:8]
  - **Problem:** the section prompt contains only the company and section name, so financials and risks are whatever the model remembers [anchor: src/llm.ts:8]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk: no wrong report has been observed yet because none has been generated [anchor: src/llm.ts:8]
  - **Complexity:** Large — a retrieval source, prompt changes per section, a citations field on the report
  - **Risk:** Medium — new external data source and prompt-size growth
  - **If never done:** every due-diligence report stays unsourced, and a reader cannot tell recalled facts from invented ones
  - **Verdict:** clears bar — unsourced facts in a due-diligence report undermine the feature's purpose, which outweighs the Large complexity as a separate pipeline
- [ ] Decide and enforce who may read and share a report — today anyone with a report id can read it and mark it shared.
  - **UX:** none
  - **Problem:** the read and share actions take no credentials on a public service [anchor: src/app.ts:17] [anchor: deploy.sh:3]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk; ids are random and nothing reads the shared flag yet [anchor: src/app.ts:20]
  - **Complexity:** Medium — an access model plus checks on two actions
  - **Risk:** Medium — changes who can read existing reports
  - **If never done:** anyone holding a report id can read it and flip its shared flag
  - **Verdict:** below bar — the shared flag has no reader yet and ids are unguessable, so there is no current exposure to fix

# Task breakdown

### Task 1: Metrics helper and metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create the repo-local metrics helper with a swappable recorder (in-memory by default), the closed `ErrorType` union (`_OTHER`, `budget_exhausted`, `internal`, `invalid_input`, `not_found`, `rate_limited`, `unauthorized`, `upstream_error`, `upstream_timeout`), typed attributes per instrument, `instrument(op, fn)` and `recordStage(op, stage, fn)`. Create `.flow/metrics.md` with Backend (`none yet — suggested: Google Cloud Monitoring via OTLP`), Namespace `reports`, Attributes, error.type values, Helper, Dashboard panels, Dashboards (none yet), Alerts, As-code (`spec-only`), SLOs and Coverage, exactly as in the PRD Instrumentation section.
- **Inputs:** none
- **Outputs:** `src/metrics.ts`, `.flow/metrics.md`, emission tests
- **Contract:**
  - **Files:** create `src/metrics.ts`, `src/metrics.test.ts`, `.flow/metrics.md`
  - **Interfaces:** `export type ErrorType = "_OTHER" | "budget_exhausted" | "internal" | "invalid_input" | "not_found" | "rate_limited" | "unauthorized" | "upstream_error" | "upstream_timeout"`; `export interface Recorder { observe(name: string, seconds: number, attrs: Record<string, string>): void; increment(name: string, attrs: Record<string, string>): void }`; `export function setRecorder(r: Recorder): void`; `export function memoryRecorder(): Recorder & { observations: …; increments: … }`; `export async function instrument<T>(op: Operation, fn: () => Promise<T>, classify: (e: unknown) => ErrorType): Promise<T>`; `export function recordStage(stage: SectionKey, seconds: number, outcome: "ok" | "error"): void`; `export function toErrorType(value: string): ErrorType` (unlisted maps to `_OTHER`)
  - **Call-site edits:** none (first use)
- **Acceptance criteria:** `bun test src/metrics.test.ts && test -f .flow/metrics.md && grep -q 'budget_exhausted' .flow/metrics.md`

### Task 2: Harden the model client and add the summary call

- **Skill:** `flow-system-design`
- **Bundled:** the missing timeout and failed-response check in the existing model client, found during discovery
- **Description:** Add a 90 s abort to every model-API call, check the HTTP status and body shape, and throw an `LlmError` with a kind that maps to `rate_limited` (429), `upstream_error` (other non-2xx or unreadable body), `upstream_timeout` (abort) and a `retryable` flag (true for 429, 5xx, timeout). Add `generateExecutiveSummary`, which posts a prompt built from the company name and the finished sections (each capped at 6,000 characters) and the names of failed sections to the same generate endpoint. Record `reports.llm.request.duration` and `reports.llm.request.failures` through the Task 1 helper. No retries inside the client.
- **Inputs:** `src/metrics.ts` (Task 1)
- **Outputs:** hardened client with the summary call
- **Contract:**
  - **Files:** edit `src/llm.ts`; create `src/llm.test.ts`
  - **Interfaces:** `export class LlmError extends Error { kind: "rate_limited" | "upstream_error" | "upstream_timeout"; retryable: boolean }`; `export async function generateSection(company: string, section: string, opts?: { timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<string>`; `export async function generateExecutiveSummary(company: string, sections: { title: string; text: string }[], missing: string[], opts?: { timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<string>`; `suggestTitle` unchanged apart from the same timeout and status check
  - **Call-site edits:** none yet (the worker in Task 6 is the first caller)
- **Acceptance criteria:** `bun test src/llm.test.ts` (covers a 500 response throwing `upstream_error`, a 429 throwing a retryable `rate_limited`, an abort throwing `upstream_timeout`, and the summary prompt containing all supplied section texts)

### Task 3: Report model, section catalog and in-memory store with the spend ledger

- **Skill:** `flow-system-design`
- **Description:** Define the six-section catalog (Q1 default), the report and section types, and an async `ReportStore` interface with a transactional read-modify-write `update`, an idempotent `createIfAbsent`, and the daily spend ledger (`reserveModelCall`, `remainingModelCalls`). Implement it in memory. Move the two existing call sites in the handlers to the async store so the repo stays green.
- **Inputs:** none (new: `src/sections.ts`; new spend ledger in `src/db.ts`)
- **Outputs:** store interface, in-memory implementation, adapted existing handlers
- **Contract:**
  - **Files:** create `src/sections.ts`, `src/db.test.ts`; edit `src/db.ts`, `src/app.ts`
  - **Interfaces:** `export type SectionKey = "company_overview" | "financials" | "market" | "management" | "risks" | "executive_summary"`; `export const CONTENT_SECTIONS: readonly { key: SectionKey; title: string }[]` (five); `export const SUMMARY_SECTION`; `export type SectionStatus = "queued" | "waiting" | "running" | "done" | "failed" | "skipped"`; `export type ReportSection = { key: SectionKey; title: string; status: SectionStatus; text: string | null; error: ErrorType | null; leaseUntil: number | null }`; `export type ReportStatus = "queued" | "running" | "done" | "partial" | "failed"`; `export type Report = { id: string; company: string; title: string | null; shared: boolean; status: ReportStatus; sections: ReportSection[]; terminalCount: number; summaryEnqueued: boolean; createdAt: string; updatedAt: string }`; `export interface ReportStore { get(id: string): Promise<Report | undefined>; createIfAbsent(report: Report): Promise<{ created: boolean; report: Report }>; update(id: string, fn: (r: Report) => Report | null): Promise<Report | undefined>; reserveModelCall(day: string, cap: number): Promise<boolean>; remainingModelCalls(day: string, cap: number): Promise<number> }`; `export function createMemoryStore(): ReportStore`; `export function newReport(id: string, company: string, now: Date): Report`
  - **Call-site edits:** `src/app.ts` GET `/reports/:id` handler — `getReport(id)` becomes `await store.get(id)`; `src/app.ts` POST `/reports/:id/share` handler — `saveReport({ ...report, shared: true })` becomes `await store.update(id, r => ({ ...r, shared: true }))`; `getReport`/`saveReport` exports removed
- **Acceptance criteria:** `bun test src/db.test.ts` (covers `update` returning `null` making no write, `createIfAbsent` returning the existing report on a second call, and `reserveModelCall` refusing at the cap)

### Task 4: Firestore store

- **Skill:** `flow-system-design`
- **Description:** Implement `ReportStore` on Firestore: reports in collection `reports`, `update` as a Firestore transaction, `createIfAbsent` via document `create()` with an already-exists fallback read, the ledger as a transaction on `spend/<yyyy-mm-dd>` incrementing `calls` only below the cap. Select the store from `REPORTS_STORE` (`memory` default, `firestore` in production). Run the same contract tests against Firestore only when `FIRESTORE_EMULATOR_HOST` is set. Add `@google-cloud/firestore` to `package.json` (reason in Technical Constraints).
- **Inputs:** `src/db.ts` store interface (Task 3); new: `src/db-firestore.ts`
- **Outputs:** production store
- **Contract:**
  - **Files:** create `src/db-firestore.ts`, `src/db-firestore.test.ts`; edit `package.json`
  - **Interfaces:** `export function createFirestoreStore(db: Firestore): ReportStore`; `export function storeFromEnv(env: Record<string, string | undefined>): ReportStore`
  - **Call-site edits:** none (wired in Task 7)
- **Acceptance criteria:** `bun test src/db-firestore.test.ts && grep -q '"@google-cloud/firestore"' package.json` (the emulator suite skips cleanly without `FIRESTORE_EMULATOR_HOST`)

### Task 5: Task queue client

- **Skill:** `flow-system-design`
- **Description:** A `TaskQueue` interface with a Cloud Tasks implementation and an in-memory fake. Each task is an HTTP POST to the worker URL with payload `{ "version": 1, "reportId", "sectionKey" }`, an OIDC token for the invoker service account, task name `<reportId>-<sectionKey>` (already-exists is treated as success), and a dispatch deadline of 180 s set on every task. Enqueue timeout 5 s, client-library retries disabled (the caller or the queue is the one retry layer). Add `@google-cloud/tasks` to `package.json`.
- **Inputs:** `src/sections.ts` (Task 3); new: `src/queue.ts`
- **Outputs:** queue client
- **Contract:**
  - **Files:** create `src/queue.ts`, `src/queue.test.ts`; edit `package.json`
  - **Interfaces:** `export type SectionTask = { version: 1; reportId: string; sectionKey: SectionKey }`; `export interface TaskQueue { enqueue(task: SectionTask): Promise<void> }`; `export function createCloudTasksQueue(cfg: { project: string; location: string; queue: string; workerUrl: string; invokerServiceAccount: string }, client?: CloudTasksClient): TaskQueue`; `export function createMemoryQueue(): TaskQueue & { tasks: SectionTask[] }`; `export function taskName(t: SectionTask): string`
  - **Call-site edits:** none (wired in Task 7)
- **Acceptance criteria:** `bun test src/queue.test.ts` (covers the task name, `dispatchDeadline` of 180 s and the OIDC token on the built request using a stub client, and already-exists treated as success)

### Task 6: Section worker and fan-in

- **Skill:** `flow-system-design`
- **Description:** The worker logic for one task. Content section: claim it in a store transaction (queued, or failed-but-retryable, or running with an expired lease becomes running with a 160 s lease; done or a live lease returns early), reserve one ledger call (refused means mark `failed` with `budget_exhausted`), call the model with a 150 s handler deadline, save the text as `done`. On a retryable error before the last attempt (`X-CloudTasks-TaskRetryCount` below 2), return `retry` so the route answers 503; on a permanent error or the last attempt, mark `failed` with the mapped error type. After any final state, in the same transaction increment `terminalCount`; when it reaches 5 and `summaryEnqueued` is false, set it true and then enqueue the summary task. Summary task: zero done sections marks it `skipped` and the report `failed` with no model call; otherwise call `generateExecutiveSummary` with the done sections and the missing titles, then set the report `done` (all five done) or `partial`. Record `reports.section.duration` per stage, `reports.section.failures`, and `reports.generate.duration` at the final status through the Task 1 helper.
- **Inputs:** `src/db.ts` (Task 3, spend ledger), `src/queue.ts` (Task 5), `src/llm.ts` (Task 2), `src/metrics.ts` (Task 1)
- **Outputs:** worker logic with the idempotency key `<reportId>:<sectionKey>` and the 150 s handler timeout
- **Contract:**
  - **Files:** create `src/report-worker.ts`, `src/report-worker.test.ts`
  - **Interfaces:** `export type WorkerDeps = { store: ReportStore; queue: TaskQueue; llm: { generateSection: typeof generateSection; generateExecutiveSummary: typeof generateExecutiveSummary }; dailyCap: number; now: () => Date; maxAttempts: number }`; `export type WorkerResult = "done" | "retry"`; `export async function runSectionTask(deps: WorkerDeps, task: SectionTask, retryCount: number): Promise<WorkerResult>`
  - **Call-site edits:** none (wired in Task 7)
- **Acceptance criteria:** `bun test src/report-worker.test.ts` (covers: a redelivered `done` section makes zero model calls — idempotency key `<reportId>:<sectionKey>`; the 150 s handler timeout is passed to the model call; five concurrent completions enqueue the summary exactly once; summary input contains the five texts; partial and zero-success paths; `budget_exhausted` makes no model call; retry on attempt 1, failed on attempt 3)

### Task 7: HTTP wiring — start report, read progress, worker route

- **Skill:** `flow-system-design`
- **Description:** Replace the module-level handler with `createHandler(deps)`. Add POST `/reports`: check `Authorization: Bearer <REPORTS_API_KEY>` (401), validate `company` (trimmed, 1-200 characters, 400), derive the report id from `Idempotency-Key` when present (SHA-256, mismatch on company returns 422) or a random UUID, refuse with 429 and `Retry-After` when fewer than six ledger calls remain, `createIfAbsent`, enqueue the five content tasks (on enqueue failure mark the report `failed` and answer 503), answer 202 with `Location`. Extend GET `/reports/:id` to return status and sections in catalog order. Add POST `/internal/section-task` only when `SERVICE_ROLE=worker` (404 otherwise), mapping `runSectionTask` to 200 or 503. Instrument the start action with `reports.create.*`. Build real dependencies from the environment in the `import.meta.main` block.
- **Inputs:** Tasks 1-6
- **Outputs:** the complete feature behind HTTP
- **Contract:**
  - **Files:** edit `src/app.ts`; create `src/app.test.ts`
  - **Interfaces:** `export type AppDeps = { store: ReportStore; queue: TaskQueue; worker: WorkerDeps; apiKey: string; dailyCap: number; role: "api" | "worker"; now: () => Date }`; `export function createHandler(deps: AppDeps): (req: Request) => Promise<Response>`; environment: `REPORTS_STORE`, `SERVICE_ROLE`, `REPORTS_API_KEY`, `DAILY_MODEL_CALL_CAP` (default 300), `TASKS_PROJECT`, `TASKS_LOCATION`, `TASKS_QUEUE`, `WORKER_URL`, `TASKS_INVOKER_SA`
  - **Call-site edits:** `src/app.ts` `Bun.serve({ fetch: handle })` becomes `Bun.serve({ fetch: createHandler(depsFromEnv(process.env)) })`; the exported `handle` is removed
- **Acceptance criteria:** `bun test src/app.test.ts` (covers 202 with `Location` and five tasks, 401, 400, idempotent repeat and 422, 429 at the cap, GET section order, worker route 404 on the API role, and 503 on a `retry` result)

### Task 8: Deploy — API service, private worker service, queue

- **Skill:** `flow-system-design`
- **Description:** Rewrite `deploy.sh` to (1) create or update Cloud Tasks queue `report-sections` with `--max-attempts=3 --min-backoff=10s --max-backoff=300s --max-doublings=4 --max-concurrent-dispatches=10 --max-dispatches-per-second=2` (the 180 s dispatch deadline is set per task in Task 5 and stays below the worker's 200 s request timeout); (2) deploy `reports-worker` from the same source with `SERVICE_ROLE=worker`, `--no-allow-unauthenticated`, `--timeout=200`, `--max-instances=3`, and grant the invoker service account `roles/run.invoker`; (3) deploy `reports-service` with `SERVICE_ROLE=api`, `REPORTS_STORE=firestore`, `--max-instances=3`, `REPORTS_API_KEY` mounted from Secret Manager, and the queue and worker settings as environment variables. Update the AGENTS.md runtime line to mention the two services.
- **Inputs:** Task 7
- **Outputs:** reproducible deploy of both services and the queue
- **Contract:**
  - **Files:** edit `deploy.sh`, `AGENTS.md`
  - **Interfaces:** config/infra — `deploy.sh`: single `gcloud run deploy reports-service … --allow-unauthenticated` becomes queue create/update + `gcloud run deploy reports-worker … --no-allow-unauthenticated --timeout=200 --max-instances=3 --set-env-vars SERVICE_ROLE=worker,REPORTS_STORE=firestore` + `gcloud run deploy reports-service … --allow-unauthenticated --max-instances=3 --set-env-vars SERVICE_ROLE=api,REPORTS_STORE=firestore,… --set-secrets REPORTS_API_KEY=reports-api-key:latest`; `AGENTS.md` runtime bullet gains "two Cloud Run services (API and private worker) plus a Cloud Tasks queue"
  - **Call-site edits:** none
- **Acceptance criteria:** `bash -n deploy.sh && grep -q -- '--max-attempts=3' deploy.sh && grep -q -- '--no-allow-unauthenticated' deploy.sh && grep -q -- '--max-instances=3' deploy.sh && grep -q 'roles/run.invoker' deploy.sh`

| Task | Depends on |
| --- | --- |
| 1 | — |
| 2 | 1 |
| 3 | 1 |
| 4 | 3 |
| 5 | 3 |
| 6 | 1, 2, 3, 5 |
| 7 | 1-6 |
| 8 | 7 |

### Skills Summary

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-system-design | Yes (Tasks 2-8) | queued paid multi-section work: timeouts, one retry layer, idempotency, spend cap, private worker |
| flow-metrics | Yes (Task 1) | first instrumented change; creates the helper and `.flow/metrics.md` |
| flow-testing | No (folded into each task) | every task ships its own `bun test` file; no separate test task |
| flow-new-feature | No | it drives implementation of this plan; not a per-task skill |
| flow-ui-ux | No | backend-only, no UI surface |

# PR description draft

## TLDR

You can now start a six-section due-diligence report for a company and fetch it minutes later; before, the service had no way to create reports at all.

## User-facing changes

- New: start a report by sending a company name with the service key; you get a report id and status link back in about a second.
- New: reading a report shows its overall status and each of its six sections (five topic sections plus an executive summary) as they finish.
- New: the executive summary is written from the five finished sections; if a section fails, the report is marked partial and the summary names what is missing.
- New: sending the same idempotency key twice returns the same report instead of paying for a second one.
- New: when the day's model-call budget is spent, starting a report is refused with "try again later" before any money is spent.
- Reading a report now returns section objects with a status:
  - **Before:** sections were a plain list of strings, though no report could ever be created.
  - **After:** each section carries its title, status and text, in a fixed order.

## System changes

- Report generation moves out of the request:
  - **Before:** one public service held reports in process memory and never called the model.
  - **After:** the API stores reports in Firestore and queues one task per section; a private worker service runs each model call under the queue's retry limits.
- New ongoing cost: six model calls per report (up to 18 with retries), capped per day; Firestore and Cloud Tasks are billed per operation, and a second Cloud Run service is deployed.

## Why

The service is meant to produce company reports, but nothing could create one. Each section takes 20-60 seconds and costs money, so a report has to be produced without making the caller wait minutes or risking paid work being thrown away.

## Key decisions

- One queued task per section, not the whole report inside the request: the caller's request stays near one second and a failed section retries on its own.
- Firestore over Cloud SQL: billed per operation, no always-on instance for one small document per report.
- Partial over all-or-nothing: when a section fails, the paid sections stay visible and the summary covers them.
- The start action needs a service key; the existing read and share actions are unchanged (an access model for them is a separate follow-up).
- The worker runs as a private service that only the queue can call, so the spend cap cannot be bypassed.
- Not included: sourced or cited content, auto-generated titles, push updates.
- Bundled: the missing timeout and failed-response check in the existing model client.

## Instrumentation

New metrics for starting a report, each section, the whole report and the model API, plus a "generate a due-diligence report" journey target (99% of reports finish; 95% within five minutes). spec-only: these metrics are recorded but will not show on any graph until a metrics backend is chosen, and the backend choice is recorded in the metrics contract file this change creates.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/app.test.ts` — start-report (202, 401, 400, idempotent repeat, 429 at the cap) and progress-read specs pass.
- [ ] Run `bun test src/report-worker.test.ts` — one-call-per-section, redelivery, retry-then-fail, budget, single summary enqueue, and partial-report specs pass.
- [ ] Run `bun test src/llm.test.ts` — timeout, failed-response and summary-prompt specs pass.
- [ ] Run `bun test src/db.test.ts src/queue.test.ts src/metrics.test.ts` — store, ledger, queue-request and metric-emission specs pass.
- [ ] Run `bash -n deploy.sh && grep -q -- '--no-allow-unauthenticated' deploy.sh && grep -q -- '--max-attempts=3' deploy.sh` — deploy script parses and keeps the worker private with capped retries.
