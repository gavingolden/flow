# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Cache report summaries until the report changes

**Goal:** Reopening an unchanged report shows its summary instantly and costs no model call; only the first open after a section changes pays for a fresh summary.

## Problem Statement

Every time someone opens a report's summary, the service asks a paid language model to write it from scratch. That takes 5 to 15 seconds and is billed each time, even though the report hasn't changed since the last person looked at it. Popular reports get opened hundreds of times a day, so the same summary gets bought hundreds of times and every reader waits for it. The brief's top two priorities, user experience and cost, both lose here.

| Fact | Evidence |
| --- | --- |
| The summary route calls the model on every request, with no reuse | [anchor: src/app.ts:14] |
| Each summary call takes 5-15 s and is billed per call | [anchor: src/llm.ts:22] |
| The summary is computed from the report's sections and nothing else (not title, company, or viewer) | [anchor: src/app.ts:14] |
| Reports change rarely ("edited occasionally (sections regenerated)") and are opened "hundreds of times a day" | [anchor: src/app.ts:7] |
| A model-API error today is either a 500 or a 200 with an empty `{}` body, because the client never checks the response status | [anchor: src/llm.ts:28] |

The premise holds as stated: the request says the route "calls the model every time someone opens a report", and the code confirms it.

## Request vetting

- **Hypothesis:** A report's summary depends only on its sections, and reads vastly outnumber section edits. So storing one summary per report, keyed on a fingerprint of its sections, cuts summary model calls from one per open to one per report version per server instance, and no reader ever sees an outdated summary.
- **Case against:** The report store is a plain in-process map on a Cloud Run service. A cache stored next to it is therefore per instance and is lost on every restart or scale-to-zero, so each instance and each cold start pays its own first miss. The approach also leaves the first opener after each edit waiting 5-15 s inside the request, which is over the 10 s interactive budget. [anchor: src/db.ts:9] [anchor: deploy.sh:3] [anchor: src/llm.ts:22]
- **Sources:** no outside source: research gate judged this a pure-internal caching change fully determined by the repo; grounded in the committed code and the flow-system-design caching guidance.
- **Verdict:** adopt-with-conditions: an unchanged report reopened on the same instance makes zero model calls, a section change triggers exactly one new call, concurrent first opens share one call, and a failed call is never stored — each asserted by a `bun test` spec
- **Per-instance caveat:** the cache is exactly as durable and as shared as the reports it summarizes. Once reports move to durable shared storage (candidate follow-up), the cached summary moves with them at no extra work.

## Existing-code assessment

- **src/app.ts summary route:** keep — one route matcher; the summary branch swaps the direct model call for the cache-aware lookup and gains a failure response [anchor: src/app.ts:14]
- **src/llm.ts model client:** simplify — all three calls share one unchecked `fetch` shape with no timeout and no status check, so an error body would become a cached summary; extract one checked, time-bounded request helper first [anchor: src/llm.ts:23]
- **src/db.ts report store:** keep — extend with a summary entry stored next to each report, following the existing map-plus-getter/setter shape [anchor: src/db.ts:9]

## Scope Boundary

**In scope:**

- Store one generated summary per report, tagged with a fingerprint of the sections it was generated from. Reuse it while the sections are unchanged.
- Share one in-flight model call among concurrent first opens of the same report version.
- Never store a failed or malformed model response. Return a clear failure response and let the next open try again.
- Add an explicit timeout and response check to every model-API call.
- Add first-time metrics: summary latency, failures, cache hit/miss, and model-call latency and failures. Create the repo's metrics contract.

**Out of scope:**

- Generating the summary ahead of time when sections are regenerated (candidate follow-up).
- Durable or cross-instance storage for reports or summaries (candidate follow-up).
- HTTP/browser caching headers, TTL expiry, a shared Redis/Memorystore cache, and a spend ledger (see Alternatives considered / Runtime design).
- Any change to the `{ "summary": "<text>" }` success response shape.

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| Every summary open waits 5-15 s for a freshly generated summary | The first open after a report's sections change waits 5-15 s; every later open of that version returns immediately |
| Two readers opening the same report at once each trigger and wait on their own model call | They share one model call and get the same summary |
| A model-API failure shows up as a 500 or as a 200 with an empty `{}` body | A model-API failure returns 502 with `{"error":"summary unavailable"}`, and the next open tries again |
| A hung model call holds the request until the platform's request timeout | A model call that hangs is cut off at 30 s and returns the 502 |

### System flow

- **Before:**
  - Each `GET /reports/:id/summary` makes one paid summary call, so spend scales with opens.
  - Model-API responses are trusted without status or shape checks, and calls have no timeout.
  - No metrics are emitted anywhere in the service.
- **After:**
  - Each summary request first checks the report store for a summary matching the current sections fingerprint. It calls the model only on a miss, so spend scales with report versions × instances.
  - Every model call has a per-call timeout and fails with a typed upstream error on non-2xx, a timeout, or a missing text field.
  - The service records summary latency, failures by type, cache hit/miss/joined counts, and model-call latency and failures through one in-memory metrics helper. No backend exists yet.

**Lost:** A client that read a 200 `{}` as "no summary" now receives a 502 error body. A model call that takes longer than 30 s, which used to eventually succeed, is now abandoned.

## User Stories / Acceptance Criteria

### Story 1: Reopening an unchanged report is free and instant

- [ ] Given a report whose summary was already generated, when it is opened again with unchanged sections, then the stored summary is returned and the model is called zero more times — `bun test src/summary.test.ts`
- [ ] Given five concurrent first opens of the same report version, when they resolve, then the model was called exactly once and all five got the same text — `bun test src/summary.test.ts`

### Story 2: Edits are reflected immediately

- [ ] Given a stored summary, when the report is saved with different sections and opened, then the model is called exactly once more and the new summary is returned — `bun test src/summary.test.ts`
- [ ] Given a stored summary, when only the report's title or company changes, then no new model call is made — `bun test src/summary.test.ts`

### Story 3: Failures are visible and never pinned

- [ ] Given the model API answers non-2xx, times out, or omits the text field, when the summary is opened, then the response is 502 `{"error":"summary unavailable"}` and nothing is stored — `bun test src/app.test.ts`
- [ ] Given one failed open, when the summary is opened again, then the model is called again (no stored failure, no stuck in-flight entry) — `bun test src/summary.test.ts`
- [ ] Given a missing report id, when the summary is opened, then the response is still 404 `{"error":"not found"}` — `bun test src/app.test.ts`

### Story 4: The saving is measurable

- [ ] Given a miss then a hit, when the in-memory recorder is read, then `reports.summary.cache.lookups` shows one `miss` and one `hit`, and `reports.summary.duration` shows two `ok` observations — `bun test src/app.test.ts`
- [ ] Given a model timeout, when the recorder is read, then `reports.summary.failures` and `reports.model.call.failures` each show one `upstream_timeout` — `bun test src/llm.test.ts`

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports.summary.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | summary route, via the metrics helper |
| `reports.summary.failures` | Counter | none | `error.type` (`_OTHER`, `internal`, `upstream_error`, `upstream_timeout`) | summary route, via the metrics helper |
| `reports.summary.cache.lookups` | Counter | none | `cache.result` (`hit`, `miss`, `joined`) | cached summary lookup |
| `reports.model.call.duration` | Histogram | seconds | `server.address` (`api.example-llm.com`), `operation.outcome` (`ok`, `error`) | model client's shared request helper |
| `reports.model.call.failures` | Counter | none | `server.address` (`api.example-llm.com`), `error.type` (`_OTHER`, `upstream_error`, `upstream_timeout`) | model client's shared request helper |

Histogram boundaries are explicit because a hit is milliseconds and a miss is 5-15 s. Summary: `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30]` (13 bounds). Model call: `[0.5, 1, 2.5, 5, 10, 15, 30, 60, 90]` (9 bounds).

Estimated series: 39 per operation for `reports.summary` (histogram 2 outcomes × 16, plus 4 `error.type` values, plus 3 `cache.result` values), per instance

Estimated series: 27 per operation for `reports.model.call` (histogram 1 host × 2 outcomes × 12, plus 1 host × 3 `error.type` values), per instance

**Attributes:** registers `operation.outcome`, `error.type`, `server.address` (closed list: `api.example-llm.com`) from the starter registry, plus one new key `cache.result` (`hit`, `miss`, `joined`) — whether a summary lookup was served from the store, generated, or joined an in-flight generation

### Error types

New list, seeded from the starter values the service can actually produce: `_OTHER` (fallback), `internal` (unexpected failure in this service), `upstream_error` (the model API answered non-2xx or without the expected text field), `upstream_timeout` (the model API did not answer within the call's timeout). There are no client-caused values yet; a missing report returns 404 before the instrumented operation starts.

### Dashboard panels

The "reports-service overview" dashboard (spec-only, no URL yet) gets these panels:

- For `reports.summary`: Request rate, Success vs failure, Failures by `error.type`, Latency p50 / p95 / p99.
- Summary cache hit share: `reports.summary.cache.lookups` by `cache.result`, hit / total ratio computed in the query. This is the cost panel that shows the saving.
- Model calls per second and model-call latency p95: from `reports.model.call.duration`. This is the direct spend proxy.

### Alerts

burn-rate tiers only

### SLO

New journey SLO "read a report summary": 99.5% availability over 30 days, from `reports.summary.duration` by `operation.outcome`. The standard burn-rate tiers are recorded once in `.flow/metrics.md`, with routing unassigned until a backend is chosen. There is no latency SLO yet, because a miss legitimately takes 5-15 s.

**As-code:** spec-only — the repo keeps no dashboard or alert config

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | HTTP handler, persistence (report store), model-API client, new metrics helper |
| Domain modules | Existing: request handlers, report store, model client. New: a small cached-summary module (one job: return a report's summary, generating at most once per version) and a metrics helper |
| Data flow | Summary request → look up the report → fingerprint its sections → stored summary with a matching fingerprint? return it : join or start one model call → store `{fingerprint, text}` next to the report → return |
| Pattern | Cache-aside with the result stored alongside its source record. It follows the existing store's map-plus-getter/setter shape and the flow-system-design rule that a paid generation's result row is the cache, keyed on the inputs that determine the output |
| Binary-framing check | The request is goal-only ("make it cheaper"), not A-or-B. The real fork, where the cache lives and what happens on a miss, has a middle option recorded in Decision analysis |
| Invalidation | Content fingerprint (SHA-256 of the JSON-encoded sections, using Bun's built-in hasher), not TTL or delete-on-write. A changed section can never serve an old summary, and unchanged reports never re-bill |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| Summary read, stored hit | ~10 ms | inline — ~10 ms, timeout none (in-memory read, no outbound call) | none | none | report id + sections fingerprint | zero model calls |
| Summary read, miss | ~15 s (documented 5-15 s) | inline in the request, as today (departure: see Proportionality) | 30 s model-call timeout, inside Cloud Run's 300 s request timeout | none in the service; one layer only, the reader reopening | report id + sections fingerprint; concurrent misses join one in-flight call | ≤1 summary call per report version per instance (the store is the cap) |
| Model API call (shared request helper for summary, title, section) | ~15 s summary / ~3 s title / ~60 s section | inline helper | summary 30 s, title 10 s, section 90 s (each about 2× the documented upper bound) | none | n/a (read-only generation) | unchanged for title and section; summary bounded by the row above |

**Platform:** gcp

**Proportionality:**

- **The miss path stays inline.** The skill defaults to a queue plus a status resource for persisted model generation, and the miss p99 exceeds the 10 s interactive budget. This plan departs from both: the repo has no queue, and a 202-plus-poll contract would change every client. Caching already shrinks the inline wait from every open to the first open per version. Ahead-of-time generation is tracked as a candidate follow-up.
- **Left out on purpose:**
  - A shared Redis/Memorystore cache: it would be a new runtime dependency and new infra.
  - A TTL: the content fingerprint makes staleness impossible.
  - A spend ledger: the store bounds summary spend, and an anonymous caller cannot force a miss without changing a report.
  - Retries.

**Recovery:** none — a stored summary is regenerable from the report's sections for one model call, and it lives in the same in-memory store as the reports it summarizes, so it is never less recoverable than its source.

## Technical Constraints

- **Key on sections only.** The summary is computed from `report.sections` alone, so the cache key must include sections and must exclude title, company, and the `shared` flag. Otherwise a title edit re-bills, or a section edit serves a stale summary. [anchor: src/app.ts:14]
- **No new runtime dependency.** The fingerprint uses Bun's built-in `Bun.CryptoHasher("sha256")`, verified locally on Bun 1.3.11 to return a 64-char hex digest. [anchor: AGENTS.md:5]
- **Persistence stays in the report store.** The stored summary lives in the report store module, not in the handler or the model client. [anchor: AGENTS.md:4]
- **Cloud Run deployment.** Instances are independent, scale to zero, and freeze CPU after the response. So the store is per instance, and no background refresh may run after the response returns. [anchor: deploy.sh:3]
- **Shared entries leak nothing new.** The service is deployed unauthenticated and the summary is identical for every viewer, so one entry per report exposes nothing the uncached route did not already return. [anchor: deploy.sh:3]
- **Tests run with `bun test`.** No test files exist today; this plan adds the first four. [anchor: AGENTS.md:3]
- **Cost and latency.** Summary model calls drop from one per open to at most one per report version per instance. For a report opened 300 times a day and edited once, that is about 2 calls per instance instead of 300. That example is illustrative, scaled from the user's "hundreds of times a day", not measured. Repeat-open latency drops from 5-15 s to an in-memory read.

## Open Questions

- [ ] Where should the stored summary live? On redirect to an in-process map inside the summary module, Task 3 drops its report-store edit and keeps the map locally.
  - **Stakes:** system — architecture (priority 3): if it lives outside the report store, it stays per-instance even after reports get durable storage, and the cost saving (priority 2) never reaches across instances
  - **Recommended:** store it in the report store next to the report — the repo's own layout rule puts persistence there, and the caching guidance says a paid generation's result row is the cache [confidence: high] [anchor: AGENTS.md:4]
- [ ] How should a cached summary be invalidated? On redirect to TTL or delete-on-save, Task 3 swaps the fingerprint for an expiry timestamp or a `saveReport` hook.
  - **Stakes:** user — user experience (priority 1): a wrong key shows readers a summary of sections that no longer exist, or re-bills (priority 2) on every title edit
  - **Recommended:** a SHA-256 fingerprint of the sections only, because the summary call receives nothing else [confidence: high] [anchor: src/app.ts:14]
- [ ] Should the first open after an edit keep waiting inline, or should the summary be generated ahead of time? On redirect, a write-path hook and probably a queue join this plan, and the candidate follow-up is pulled in.
  - **Stakes:** user — user experience (priority 1): one reader per report version per instance still waits 5-15 s
  - **Recommended:** keep the miss inline for this change and track ahead-of-time generation as a follow-up. The write path that regenerates sections is not in this repo (the save function has no caller), so a hook here could not be exercised [confidence: medium] [anchor: weighing: footprint — `saveReport` in src/db.ts has zero callers in the repo, so precompute needs a write path this repo does not contain]
- [ ] What should a reader get when the model call fails? On redirect to 503 or to the old 200 `{}`, Task 4's error branch and its test change.
  - **Stakes:** user — product quality (priority 4): a 200 with an empty body hides the failure, and the old behaviour would never be pinned, but it stays silent
  - **Recommended:** 502 with `{"error":"summary unavailable"}`, following the route's existing `json({ error }, status)` error shape, and never stored [confidence: medium] [anchor: adjacent: src/app.ts:13]
- [ ] What is the model-call timeout for summaries? On redirect, Task 2's `MODEL_TIMEOUT_MS.summarize` constant changes.
  - **Stakes:** system — product quality (priority 4): too short cuts off legitimate 15 s calls and re-bills on retry, too long holds requests on a hung upstream
  - **Recommended:** 30 s, about 2× the documented 15 s upper bound and well inside Cloud Run's 300 s request timeout [confidence: medium] [anchor: weighing: risk — 2× the stated upper bound of src/llm.ts:22 absorbs tail latency without holding requests indefinitely]
- [x] Should the hardening also cover the title and section calls, which this repo never invokes? Resolved: yes. They share the same unchecked request shape, so one shared helper fixes all three at no extra design cost.
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision A — where does the stored summary live?** The options are mutually exclusive: pick one location. Single-flight coalescing is complementary to every option.

| Branch | Downstream system flow |
| --- | --- |
| A1 in-process map in the summary module | Today it behaves like A2. When reports later move to durable storage, summaries stay per-instance and are lost on restart, so each new instance re-bills every popular report |
| A2 stored next to the report in the report store | Today it is per-instance, like the reports themselves. When reports move to durable storage, summaries become shared and durable at no extra work |
| A3 shared external cache (Memorystore/Redis) | Shared across instances immediately. Costs a new runtime dependency, new infra and spend, and a cache-down path, while the reports themselves are still per-instance |

Ranked combinations: A2 + single-flight > A1 + single-flight > A3 + single-flight.

Verdict: **A2 + single-flight** — it matches the repo's persistence rule and gets cross-instance sharing for free once the report store becomes durable, without a new dependency [confidence: high] [anchor: AGENTS.md:4]

**Decision B — what happens on a miss?** The options are mutually exclusive for the miss path. All of them are complementary to Decision A.

- **B1, inline as today: 0 interruptions per run.**
  - The first reader after an edit opens the summary, sees the existing 5-15 s wait, then gets the text.
  - Every later reader gets it immediately.
  - Nothing changes for clients.
- **B2, generate when sections are saved: 0 interruptions per run.**
  - Every reader gets an immediate summary.
  - Spend now includes edits nobody opens, and multi-section regenerations may summarize several times.
  - Needs a hook in a write path this repo does not contain.
- **B3, queue plus 202 status: 0 interruptions, but a new client polling loop.**
  - The reader's client gets a 202, polls a status resource, then renders.
  - Every client of the summary route must change.

Ranked combinations: B1 now with B2 as a follow-up > B2 now > B3.

Verdict: **B1 now, B2 tracked as a candidate follow-up** — B1 removes nearly all calls and all repeat waits without changing a client contract; B2 needs the write-path decision first [confidence: medium] [anchor: weighing: footprint — `saveReport` in src/db.ts has no caller in this repo, so B2 cannot be built or tested here]

## Alternatives considered

- **HTTP `Cache-Control`/`ETag` headers instead of a server-side store** — rejected: browser caches are per viewer, so each distinct reader still triggers one paid call. The summary URL also carries no version (src/app.ts:10), so any `max-age` would serve a stale summary after an edit.
- **TTL expiry instead of a sections fingerprint** — rejected: the summary call receives only `report.sections` (src/app.ts:14), so a content fingerprint gives zero staleness. A TTL either serves stale summaries after edits or re-bills unchanged reports on every expiry.
- **Invalidate inside `saveReport` instead of fingerprinting** — rejected: `saveReport` (src/db.ts:15) has no caller in this repo, so the real write path is untestable here. A fingerprint invalidates correctly no matter which writer changed the sections.

## Recommendation

**Proceed** — the change removes repeat model calls and repeat waits (the brief's priorities 1 and 2) with no new dependency and no client-contract change on the success path. It includes a "simplify" of the model client: one checked, time-bounded request helper, so a failure is never stored as a summary. [confidence: high] [anchor: src/app.ts:14]

**Redundancy:** none found — no cache, memoization, or stored-summary field exists anywhere in the service (src/app.ts, src/db.ts, src/llm.ts).

## Plan risks

The weakest assumption is that "hundreds of opens a day" land on a few warm instances. If Cloud Run spreads traffic across many short-lived instances, or scales to zero between bursts, each instance and cold start pays its own miss, and the saving falls well short of the per-version ideal. The cache-hit-share panel is the check, and durable shared report storage is the fix.

## Cut list

- nothing — plan is minimal: every task either removes model calls (store and coalescing), keeps a failure from becoming a stored summary (client hardening), or proves the saving (hit/miss metrics). A shared cache, TTL, HTTP caching, a queue, and a spend ledger were each weighed and left out.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Move reports to durable, shared storage | High | Large | genuinely novel non-trivial feature: every restart or scale-to-zero discards all saved reports, and the open decision is which managed store to adopt | the summary store sits next to reports, so it inherits durability and cross-instance sharing the moment this lands | No |
| Generate the summary when sections are regenerated | Medium | Medium | needs its own design/decision session: the open decision is where the section-regeneration write path lives and whether summary generation joins it synchronously, via a queue, or behind a 202 status contract | removes the last remaining 5-15 s wait this plan leaves on the first open after an edit | No |

- [x] Move reports to durable, shared storage — reports live only in one Cloud Run instance's memory; adopt a managed store so reports (and their stored summaries) survive restarts and are visible on every instance.
  - **UX:** a reader whose request lands on a different instance than the writer's gets "not found" for a report that exists; brief priority 1 (user experience) [anchor: src/db.ts:9]
  - **Problem:** every instance restart, deploy, or scale-to-zero discards every saved report [anchor: src/db.ts:9]
  - **Stability/efficiency:** each instance pays its own first summary call per report version, so the cache saving divides by the instance count [anchor: deploy.sh:3]
  - **Value rank:** 5 — data loss: saved reports exist only in process memory on a platform that restarts and scales to zero [anchor: src/db.ts:9]
  - **Complexity:** Large — new store, schema, client, migration of the report store module and its callers
  - **Risk:** High — data-model and infra decision with its own rollout and recovery plan
  - **If never done:** reports and stored summaries keep vanishing on every restart, and the summary saving stays per-instance
  - **Verdict:** clears bar — a verified data-loss path outweighs the Large complexity and High risk
- [x] Generate the summary when sections are regenerated — so the first reader after an edit never waits on a miss.
  - **UX:** the first reader after each edit still waits 5-15 s for the summary; brief priority 1 (user experience) [anchor: src/llm.ts:22]
  - **Problem:** the miss path runs a 5-15 s paid call inside the request, above the 10 s interactive budget [anchor: src/llm.ts:22]
  - **Stability/efficiency:** none
  - **Value rank:** 3 — a measured inefficiency with a number: a 5-15 s wait on the first open after every edit [anchor: src/llm.ts:22]
  - **Complexity:** Medium — a hook in the section-regeneration write path (not in this repo; `saveReport` has no caller) plus possibly a queue
  - **Risk:** Medium — may bill summaries for edits nobody opens; touches a write path this plan cannot see
  - **If never done:** one reader per report version per instance keeps waiting 5-15 s
  - **Verdict:** clears bar — user experience is the brief's top priority and the wait is documented at 5-15 s, outweighing Medium complexity once the write-path decision is made

# Task breakdown

### Task 1: Metrics helper and metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create the repo-local, zero-dependency metrics helper with a swappable recorder and an in-memory default. It has a closed `ErrorType` union (`_OTHER`, `internal`, `upstream_error`, `upstream_timeout`) and a closed attribute map (`operation.outcome`, `error.type`, `cache.result`, `server.address`). `instrument(op, fn, attrs?)` records `<op>.duration` in seconds by `operation.outcome` and, on throw, `<op>.failures` by `error.type`. It reads an `errorType` property from the thrown value and falls back to `_OTHER`, then re-throws. Create `.flow/metrics.md` with the following sections, filled from the plan's `## Instrumentation`:
  - `## Backend`: `none yet — suggested: Google Cloud Monitoring`
  - `## Namespace`: `reports`
  - `## Attributes`
  - `## error.type values`
  - `## Helper`: `src/metrics.ts`
  - `## Dashboard panels`
  - `## Dashboards`: none yet
  - `## Alerts`: burn-rate tiers, routing unassigned
  - `## As-code`: `spec-only`
  - `## SLOs`: "read a report summary", 99.5% / 30 d
  - `## Coverage`: `reports.summary`, `reports.model.call`
- **Inputs:** new: src/metrics.ts; new: .flow/metrics.md
- **Outputs:** Metrics helper and the committed metrics contract
- **Contract:**
  - **Files:** create `src/metrics.ts`, `src/metrics.test.ts`, `.flow/metrics.md`
  - **Interfaces:** `export type ErrorType = "_OTHER" | "internal" | "upstream_error" | "upstream_timeout"`; `export type Attributes = { "operation.outcome"?: "ok" | "error"; "error.type"?: ErrorType; "cache.result"?: "hit" | "miss" | "joined"; "server.address"?: "api.example-llm.com" }`; `export interface Recorder { histogram(name: string, seconds: number, attrs: Attributes): void; counter(name: string, attrs: Attributes): void }`; `export function createMemoryRecorder(): Recorder & { observations: { name: string; seconds: number; attrs: Attributes }[]; increments: { name: string; attrs: Attributes }[] }`; `export function setRecorder(r: Recorder): void`; `export function count(name: string, attrs: Attributes): void`; `export function toErrorType(e: unknown): ErrorType`; `export function instrument<T>(op: string, fn: () => Promise<T>, attrs?: Pick<Attributes, "server.address">): Promise<T>`
  - **Call-site edits:** none (first task; consumers arrive in Tasks 2-4)
- **Acceptance criteria:** `bun test src/metrics.test.ts && grep -q '^## Coverage' .flow/metrics.md && grep -q 'cache.result' .flow/metrics.md`. The tests must assert one `ok` observation on success, one `error` observation plus one failures increment with the exact `error.type` on failure, and that an unknown thrown value maps to `_OTHER`.

### Task 2: Checked, time-bounded model client

- **Skill:** `flow-system-design`
- **Bundled:** applying the same timeout and status/shape check to the title and section calls, which share the unchecked request shape surfaced during discovery
- **Description:** Replace the three hand-rolled `fetch` calls with one private request helper. It applies `AbortSignal.timeout`, checks `res.ok`, and verifies the expected field is a non-empty string. It throws `ModelCallError` with `errorType` `upstream_timeout` (abort or timeout) or `upstream_error` (non-2xx, unparseable body, or missing or empty field). It wraps each call in `instrument("reports.model.call", …, { "server.address": "api.example-llm.com" })` so `reports.model.call.duration` and `reports.model.call.failures` are emitted. Public function signatures stay unchanged.
- **Inputs:** src/metrics.ts (Task 1)
- **Outputs:** Model client that never returns an error body as text and never waits unbounded
- **Contract:**
  - **Files:** edit `src/llm.ts`; create `src/llm.test.ts`
  - **Interfaces:** `export class ModelCallError extends Error { readonly errorType: "upstream_error" | "upstream_timeout" }`; `export const MODEL_TIMEOUT_MS = { generate: 90_000, title: 10_000, summarize: 30_000 } as const`; `generateSection`, `suggestTitle`, `summarize` keep their existing signatures
  - **Call-site edits:** none outside `src/llm.ts` (exported signatures unchanged)
- **Acceptance criteria:** `bun test src/llm.test.ts`. The tests run against a stubbed `globalThis.fetch` and must cover:
  - a 200 with text returns the text and records one `ok`
  - a 500 throws `ModelCallError` with `upstream_error`
  - a 200 missing `text` throws `upstream_error`
  - an aborted or timed-out call throws `upstream_timeout` and records one `reports.model.call.failures` increment with `upstream_timeout`

### Task 3: Stored summary keyed on a sections fingerprint, with coalescing

- **Skill:** `flow-system-design`
- **Description:** Add a summary entry to the report store, stored next to the report. Add the cached-summary module, which fingerprints `report.sections` (SHA-256 of `JSON.stringify(sections)` via `Bun.CryptoHasher`) and behaves as follows:
  - **Hit:** if the stored entry's fingerprint matches, return it and count `cache.result=hit`.
  - **Joined:** if a call for `${id}:${fingerprint}` is already in flight, await it and count `joined`.
  - **Miss:** otherwise start one generation and count `miss`. On success, save `{ sectionsHash, text }`. On failure, store nothing. Either way, remove the in-flight entry.
- **Inputs:** src/db.ts (existing store), src/llm.ts `summarize` (Task 2), src/metrics.ts `count` (Task 1)
- **Outputs:** At most one summary call per report version per instance
- **Contract:**
  - **Files:** edit `src/db.ts`; create `src/summary.ts`, `src/summary.test.ts`
  - **Interfaces:** in `src/db.ts`: `export type StoredSummary = { sectionsHash: string; text: string }`; `export function getSummary(reportId: string): StoredSummary | undefined`; `export function saveSummary(reportId: string, summary: StoredSummary): void`. In `src/summary.ts`: `export type SummaryResult = { text: string; cache: "hit" | "miss" | "joined" }`; `export function sectionsHash(sections: string[]): string`; `export function getReportSummary(report: Report, generate?: (sections: string[]) => Promise<string>): Promise<SummaryResult>` (default `generate` = `summarize`)
  - **Call-site edits:** none yet (the handler switches over in Task 4)
- **Acceptance criteria:** `bun test src/summary.test.ts`. The tests use a counting stub `generate` and must cover:
  - a second call with the same sections makes 0 extra calls and returns `hit`
  - five concurrent calls make 1 call (one `miss`, four `joined`)
  - changed sections make 1 new call
  - a title-only change makes 0 calls
  - a rejected generate stores nothing, and the next call generates again

### Task 4: Wire the summary route to the cached lookup

- **Skill:** `flow-system-design`
- **Description:** In the summary branch, call `instrument("reports.summary", () => getReportSummary(report))` and return `{ summary: text }`. Catch failures and return 502 `{ "error": "summary unavailable" }`; `instrument` has already recorded the `error.type`. Keep the 404 path and the non-summary path unchanged.
- **Inputs:** src/summary.ts (Task 3), src/metrics.ts (Task 1)
- **Outputs:** Summary route that serves stored summaries and reports failures explicitly
- **Contract:**
  - **Files:** edit `src/app.ts`; create `src/app.test.ts`
  - **Interfaces:** `handle(req: Request): Promise<Response>` keeps its signature; success body stays `{ summary: string }`; failure body `{ error: "summary unavailable" }` with status 502
  - **Call-site edits:** `src/app.ts` `handle` — replace `await summarize(report.sections)` with the instrumented `getReportSummary(report)` call and drop the direct `summarize` import
- **Acceptance criteria:** `bun test src/app.test.ts && bun test`. The app tests seed reports via `saveReport`, stub `globalThis.fetch`, and use the in-memory recorder. They must cover:
  - two GETs of an unchanged report make 1 model fetch, both return 200 with the same `summary`, and the recorder shows one `miss` and one `hit`
  - a model 500 returns 502 with the error body
  - an unknown id returns 404
  - `GET /reports/:id` is unchanged

| Task | Depends on |
| ---- | ---------- |
| 1    | —          |
| 2    | 1          |
| 3    | 1, 2       |
| 4    | 1, 3       |

### Skills Summary

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-metrics | Yes (Task 1) | First instrumented change: creates the helper and `.flow/metrics.md` |
| flow-system-design | Yes (Tasks 2-4) | Paid outbound call timeouts, cache-aside with stampede protection, inline-vs-queue departure |
| flow-testing | Yes (supporting, Tasks 1-4) | First test files in the repo; each task co-locates its `bun test` spec so it lands verify-green on its own |
| flow-refactoring | No | The model-client helper extraction is small and part of Task 2's behaviour change, not a standalone refactor |
| flow-ui-ux | No | No UI surface |

# PR description draft

## TLDR

Reopening an unchanged report now shows its summary instantly with no model charge; before, every open paid for a fresh 5-15 second generation, and now only the first open after an edit does.

## User-facing changes

- Opening a report summary a second time is instant and free while the report is unchanged:
  - **Before:** every open waited 5-15 seconds while a new summary was generated and billed.
  - **After:** only the first open after a report's sections change waits; later opens return the stored summary immediately.
- Readers opening the same report at the same moment share one generation instead of each starting their own.
- A summary that cannot be generated now says so:
  - **Before:** a model failure came back as a server error or as a success with an empty body.
  - **After:** it returns a 502 with `{"error":"summary unavailable"}`, and the next open tries again.
- Editing only a report's title or company no longer triggers a new summary.

## System changes

- Summary spend now scales with report edits, not report opens:
  - **Before:** one paid summary call per open.
  - **After:** at most one paid summary call per report version per server instance. A report opened hundreds of times a day and edited once costs a handful of calls, not hundreds.
- Calls to the model provider are now bounded and checked:
  - **Before:** no timeout, and error responses were passed through as if they were text.
  - **After:** each call has a timeout (30 s for summaries) and fails with a typed upstream error on a bad status, a timeout, or a missing result.
- The service now records its first metrics: summary latency and failures, cache hit/miss share, and model-call latency and failures. No metrics backend exists yet.

## Why

Every reader of a popular report waited 5-15 seconds and the service paid the model provider each time, even though the report had not changed since the last reader. User experience and cost, the two top-ranked priorities, were both being spent on regenerating an identical result.

## Key decisions

- **Invalidate by what the summary is made from.** The stored summary is tied to a fingerprint of the report's sections, the only input the summary uses, rather than to a time-based expiry. Readers never see a summary of outdated sections, and unchanged reports are never re-billed.
- **The stored summary lives with the report, not in a separate cache service.** No new dependency or infrastructure. When reports get durable shared storage, summaries become durable and shared with them at no extra work. The trade-off is that each server instance pays its own first call today.
- **The first open after an edit still waits for generation.** Generating ahead of time needs the section-regeneration write path, which lives outside this service. That work is tracked as a follow-up rather than adding a queue and a polling contract for clients now.
- **Failures are never stored.** A failed or malformed generation returns an explicit error and leaves nothing behind, so a transient provider outage cannot pin a broken summary to a report.
- **No browser caching headers.** They would still bill once per distinct reader, and they could show stale summaries after an edit.
- Bundled: the same timeout and response check is applied to the title and section model calls, which shared the unchecked request shape.

## Instrumentation

- **Metrics:** summary latency (`reports.summary.duration`, split by ok/error), summary failures by type (`upstream_error`, `upstream_timeout`, `internal`, `_OTHER`), summary cache lookups by hit/miss/joined, and model-call latency and failures.
- **Panels:** the "reports-service overview" dashboard gets summary request rate, success vs failure, failures by type, latency p50/p95/p99, cache hit share, and model calls per second. These are spec-only; no dashboard exists yet.
- **SLO:** new journey SLO "read a report summary": 99.5% availability over 30 days, with the standard burn-rate tiers.
- **Backend:** this PR creates the repo's metrics contract with backend `none yet — suggested: Google Cloud Monitoring`. These metrics are recorded in process but will not appear on any graph until a metrics backend is chosen and wired in.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/summary.test.ts` — repeat opens make zero extra model calls, concurrent opens share one call, a section change makes one new call, a title-only change makes none, and a failure is not stored.
- [ ] Run `bun test src/llm.test.ts` — non-2xx, missing-text, and timed-out model responses each fail with the expected upstream error type and record a model-call failure.
- [ ] Run `bun test src/app.test.ts` — two opens of an unchanged report make one model request and return the same summary, a model failure returns 502 with the error body, and an unknown report still returns 404.
- [ ] Run `bun test src/metrics.test.ts` — success, failure, and unknown-error emissions land in the in-memory recorder with the expected outcome and error type.
- [ ] Run `grep -q 'reports.summary.cache.lookups' .flow/metrics.md && grep -q '^## Coverage' .flow/metrics.md` — the metrics contract lists the new cache metric and a coverage section.
