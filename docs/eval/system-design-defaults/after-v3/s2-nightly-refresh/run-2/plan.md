# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Nightly refresh of saved reports

**Goal:** Every saved report a reader opens in the morning carries content regenerated overnight, with a visible refresh time, inside a fixed nightly model-call budget.

## Problem Statement

Saved reports are generated once, by a slow and paid model, and then never change. A reader who comes back days later gets content as old as the report itself, and nothing tells them how old it is. Today there is a bigger gap underneath that: the service keeps reports only in the memory of whichever server instance happens to be running, so every deploy or scale-down erases them, and a nightly job would find nothing to refresh.

Framed against the product brief's ranked priorities: the win is **user experience** (fresh content without the reader asking or re-checking), and the main cost is **cost** — every refresh is a paid model call per section, every night, for every report, so the plan must state what that spend buys and cap it.

| Fact | Evidence |
| ---- | -------- |
| Reports live in a per-process in-memory map, lost on every restart, deploy or scale-to-zero, and not shared between instances | [anchor: src/db.ts:9] |
| No code path creates a report; the only write re-saves an existing report when it is shared | [anchor: src/app.ts:20] |
| There is no "saved" flag; the existing list helper returns every report in the map | [anchor: src/db.ts:19] |
| A report stores section names only — no generated body, no generated-at time | [anchor: src/db.ts:1] |
| One section generation takes 20-60 s and costs money; a title call takes 1-3 s and costs money | [anchor: src/llm.ts:1] |
| The service is deployed public, with no authenticated internal surface | [anchor: deploy.sh:3] |

**Premise check:** the request assumes saved reports persist overnight and carry content to refresh. The codebase shows neither: storage is in-process memory (src/db.ts:9) and nothing creates a report (src/app.ts:9-24), so a nightly refresh built on the current store would refresh zero reports. The plan therefore bundles durable storage as a prerequisite and asks where reports come from (Q1).

## Request vetting

- **Hypothesis:** a scheduled job that regenerates each stored report's sections once a night gives readers fresher content at a bounded, stated cost, and the stored reports exist when the job runs.
- **Case against:** the store is a per-instance in-memory map [anchor: src/db.ts:9] with no creation path [anchor: src/app.ts:20], so the job has nothing to read; and "every report, every night" scales paid 20-60 s calls [anchor: src/llm.ts:1] with report count, including reports nobody opens — the brief's cost priority says ongoing spend must name what it buys. Cloud Run also freezes CPU outside requests, so an in-process nightly timer cannot run it (https://docs.cloud.google.com/run/docs/configuring/billing-settings).
- **Sources:** https://docs.cloud.google.com/run/docs/configuring/billing-settings; https://12factor.net/disposability
- **Verdict:** adopt-with-conditions: durable report storage lands before the job, and every nightly section call is reserved against one nightly call cap

## Existing-code assessment

- **src/db.ts:** rewrite — an in-process map cannot hold data a nightly job must find; replace with a durable store behind the same small API (prerequisite, bundled as Task 1) [anchor: src/db.ts:9]
- **src/app.ts:** keep — the two handlers stay; they only await the now-async store, and share switches to a field update so it cannot clobber a concurrent refresh [anchor: src/app.ts:20]
- **src/llm.ts:** simplify — both calls have no timeout and no status check, so a hung or failing upstream stalls the worker or stores `undefined` as section text; add both (bundled as Task 2) [anchor: src/llm.ts:6]
- **deploy.sh:** keep — extend with the private worker service deploy [anchor: deploy.sh:3]

## Scope Boundary

**In scope:**

- Durable report storage (Firestore) replacing the in-memory map, with a memory implementation kept for tests and local runs.
- Report record gains generated section bodies, a refreshed-at time and a last-refresh status.
- A nightly clock that enqueues one refresh task per stored report.
- A private worker that regenerates one report's sections, checkpointing each finished section, and swaps the new content in all at once.
- One nightly section-call cap enforced at a single choke point.
- Timeouts and status checks on the model client; metrics for the tick, the worker and the model calls.
- One-time infra setup: database with point-in-time recovery and backups, queue, scheduler, worker service, IAM.

**Out of scope:**

- Creating reports (no endpoint exists today — see Q1 and candidate follow-up).
- Version history of previous report content.
- Re-suggesting titles on refresh (Q5).
- On-demand "refresh now" for one report.
- Choosing a metrics backend (spec-only, recorded in `.flow/metrics.md`).

## Behavioral contrast

### User flow

| Before | After |
| ------ | ----- |
| A report's content is whatever was produced when it was made, with no indication of age | Each morning a report shows content regenerated overnight plus when it was last refreshed |
| Reports disappear after any deploy or scale-down | Reports persist across deploys and instances |
| A failed or skipped generation is invisible | A report carries its last refresh outcome: ok, failed, or skipped because the nightly budget ran out |

### System flow

- **Before:**
  - Reports are held in one instance's memory; no scheduled work exists.
  - Model calls have no timeout and no failure handling.
- **After:**
  - Reports are stored durably; a nightly clock enqueues one named task per report.
  - A private worker, invoked by the queue, regenerates sections under a per-call timeout and a nightly call cap, and records the outcome on the report.
  - Paid spend grows by at most the nightly cap in section calls per night.

**Lost:** each nightly refresh overwrites the previous section content with no history kept, so a reader of a shared report can no longer see yesterday's version.

## User Stories / Acceptance Criteria

### Story 1: Fresh content each morning

- **Given** a stored report with three sections, **when** the worker refreshes it for a run date, **then** all three section bodies are replaced at once, `refreshedAt` is set and `lastRefresh.status` is `ok` — checked by `bun test src/refresh.test.ts`.

### Story 2: Repeats never double-charge

- **Given** a report already refreshed for a run date, **when** the same task is delivered again, **then** zero section calls are made — checked by `bun test src/refresh.test.ts`.
- **Given** a refresh that failed after two of three sections, **when** the task retries, **then** only the third section is generated — checked by `bun test src/refresh.test.ts`.

### Story 3: Spend is capped

- **Given** the nightly cap is reached, **when** a worker would make another section call, **then** no call is made and the report's `lastRefresh.status` is `skipped_budget` — checked by `bun test src/spend.test.ts src/refresh.test.ts`.

### Story 4: Failures are visible, not silent

- **Given** the model API times out on the final delivery attempt, **when** the worker gives up, **then** the report keeps its previous content and shows `lastRefresh.status: failed` — checked by `bun test src/refresh.test.ts`.

### Story 5: Reports survive deploys

- **Given** a report saved through the store, **when** a fresh store instance reads it, **then** the same report comes back — checked by `bun test src/db.test.ts` against the memory implementation's contract tests, which the Firestore implementation shares.

### Story 6: Paid work cannot be triggered by the public

- **Given** the worker service, **when** it is deployed, **then** it rejects unauthenticated callers — checked by `grep -q -- '--no-allow-unauthenticated' deploy.sh`.

## Instrumentation

**Contract:** .flow/metrics.md create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| ------ | ---------- | ---- | -------------------------- | ---------- |
| `reports.refresh.duration` | Histogram (bounds 1, 5, 15, 30, 60, 120, 240, 480, 600) | seconds | `operation.outcome` (ok, error) | worker, per report |
| `reports.refresh.failures` | Counter | none | `error.type` (6 values below) | worker, per report |
| `reports.refresh.enqueue.duration` | Histogram (bounds 1, 5, 15, 30, 60, 120, 180) | seconds | `operation.outcome` (ok, error) | nightly tick |
| `reports.refresh.enqueue.failures` | Counter | none | `error.type` | nightly tick |
| `reports.refresh.last_success_time` | Gauge | seconds (Unix time) | none | nightly tick, on success |
| `reports.llm.call.duration` | Histogram (bounds 1, 2.5, 5, 10, 20, 30, 45, 60, 90) | seconds | `server.address` (api.example-llm.com), `operation.outcome` (ok, error) | model client |
| `reports.llm.call.failures` | Counter | none | `server.address` (api.example-llm.com), `error.type` | model client |
| Queue backlog | Gauge | `{message}` | queue | platform-native (Cloud Tasks `queue/depth`) |

Estimated series: 30 per operation (refresh: 2 x 12 + 6)
Estimated series: 27 per operation (enqueue: 2 x 10 + 6 + 1)
Estimated series: 30 per operation (model call: 1 x 2 x 12 + 1 x 6)

All counts are per reporting instance; the worker service is capped at 2 instances, so the fleet-wide worst case is under 200 series. No samples-per-month figure: no backend is chosen yet.

No per-stage histogram: the only slow stage is section generation, already covered by the model-call histogram.

**Attributes:** new keys `operation.outcome` (ok, error), `error.type` (closed list below), `server.address` (api.example-llm.com), added as `.flow/metrics.md` `## Attributes` rows from the starter registry.

### Error types

| Value | Meaning |
| ----- | ------- |
| `_OTHER` | fallback: no listed class fits |
| `budget_exhausted` | the nightly section-call cap was reached; the report was skipped |
| `internal` | unexpected failure inside this service |
| `not_found` | the report was removed before its task ran |
| `upstream_error` | the model API answered with a failure |
| `upstream_timeout` | the model API did not answer within the call timeout |

### Dashboard panels

- "Nightly refresh" dashboard (spec-only): refresh outcome rate per night; refresh p50/p95 duration; model-call p95 duration and failures by `error.type`; Cloud Tasks queue depth; hours since last successful tick.

### Alerts

| Signal | Condition | Sustained for | Action | Routes to | Dashboard |
| ------ | --------- | ------------- | ------ | --------- | --------- |
| Tick staleness | now minus `reports.refresh.last_success_time` > 48 h | 15 min | notify | service owner channel (name to be recorded in `.flow/metrics.md`) | Nightly refresh (spec-only) |
| Budget exhaustion | `reports.refresh.failures{error.type=budget_exhausted}` > 0 in a night | — | notify | service owner channel | Nightly refresh (spec-only) |

### SLO

New journey SLO "Report is refreshed nightly": SLI = reports with `operation.outcome=ok` / all refresh attempts' final outcomes per night, excluding `budget_exhausted` and `not_found`; target 99% over 28 days.

**As-code:** spec-only — the repo keeps no dashboard or alert files and no metrics backend.

## Architecture Decisions

| Aspect | Decision |
| ------ | -------- |
| Layers touched | persistence, model-API client, new background worker, infra/deploy |
| Domain modules | existing: report store, model client, HTTP handlers; new: spend ledger, refresh worker, enqueue tick, metrics helper |
| Data flow | Cloud Scheduler tick enqueues one Cloud Task per stored report; the queue invokes the private worker; the worker reads the report, reserves budget, calls the model per section, stages each body, then swaps all bodies in and writes the outcome |
| Pattern | new — the repo has no background work; follows the flow-system-design "scheduler enqueues, queue drives worker" shape |
| Binary-framing check | not framed as a binary; the real fork is which reports to refresh (all vs recently read vs on read) — see Decision analysis |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --------- | -------- | --------------- | ------------------ | ------- | --------------- | ---------- |
| Nightly tick (enqueue) | ~30 s for 1k reports | scheduler-enqueue: Cloud Scheduler calls the private worker, which only creates one named task per report | Scheduler attempt deadline 180 s; handler budget 150 s; each task create 10 s | Cloud Scheduler only, 1 retry | task name `refresh-<reportId>-<runDate>` | no paid calls |
| Refresh one report | ~4 min (12 sections, 3 at a time, 60 s each) | queue + worker invoked synchronously under the attempt deadline | dispatch deadline 600 s; handler budget 480 s; Cloud Run request timeout 600 s | Cloud Tasks only: max attempts 3, backoff 60-600 s, 3 doublings | `<reportId>:<runDate>` plus per-section staged bodies | new nightly spend ledger, reserved before every section call |
| Section generation (model call) | 60 s | inline in the worker, timeout 90 s | 90 s per call | none at this layer — the queue owns retries | inherits the report's key | new nightly spend ledger |
| Read / share a report | inline — 200 ms, timeout 5 s | inline | 5 s per store call | none | n/a | no paid calls |

**Platform:** gcp

**Proportionality:** one task per report rather than per section (per-section staging gives the same retry savings without a fan-in step); no Pub/Sub, no workflow engine and no dead-letter queue (Cloud Tasks has none — the final attempt writes a visible `failed` status instead); no version history; no per-tenant caps (there are no tenants). The Firestore client's own transient-error retries on single-document reads and writes are accepted as storage-layer retries, separate from the work-level retry the queue owns.

**Recovery:** Firestore point-in-time recovery (7-day window) plus a daily scheduled backup kept 14 days; a restore check restores the latest backup into a scratch database and compares document counts, run once at setup and quarterly. Generated section bodies are regenerable at a known cost (one section call each); report definitions (company, sections, title, shared) are not, which is why backups are on.

## Technical Constraints

- New runtime dependencies (`@google-cloud/firestore`, `@google-cloud/tasks`) need a stated reason — AGENTS.md "No new runtime dependencies without a reason"; the reason is durable storage and named-task de-duplication (Q7).
- Keep modules small and single-purpose — AGENTS.md — so the ledger, worker, tick and metrics helper are separate files, not grown into `src/db.ts`.
- Cloud Run's default request timeout is 5 minutes, below the 10-minute dispatch deadline, so the worker service must be deployed with a 600 s timeout (flow-system-design `references/gcp.md`, Cloud Run services).
- Cloud Tasks dispatch deadline maximum is 30 minutes; the 600 s deadline leaves headroom (flow-system-design `references/gcp.md`, Cloud Tasks).
- **Cost:** adds up to the nightly cap in paid section calls per night — e.g. 50 reports x 6 sections = 300 calls a night. No price per call is recorded in the repo, so the dollar figure is not stated.

## Open Questions

- [ ] Q1. Where do saved reports come from? No code path in this service creates one, and an in-process map cannot be written from outside. On redirect: if another system writes reports, Task 1's store must be the shared database it writes to; if nothing does yet, the verdict becomes Defer until a create path exists.
  - **Stakes:** both — without a creation path the nightly job refreshes nothing, and the user pays for infra that does no work.
  - **Needs user input:** user-held preference — whether and where report creation is planned is a product-roadmap decision the repo cannot answer.
- [ ] Q2. What is the nightly section-call cap? On redirect: the default in the spend ledger and the budget-exhaustion alert threshold change.
  - **Stakes:** both — too low leaves reports stale (user experience, brief priority 1); too high lets spend grow unbounded with report count (cost, brief priority 2).
  - **Needs user input:** user-held preference — the budget is the owner's call; the plan ships a placeholder default of 500 section calls per night behind an environment variable.
- [ ] Q3. Which durable store? On redirect: Task 1's implementation, dependency and the Recovery line change.
  - **Stakes:** system — the wrong store adds connection management or migration tooling the service does not otherwise need.
  - **Recommended:** Firestore — reports are single documents read by id, the service is serverless with no connection pool, and field-level updates let share and refresh write different fields without clobbering each other [confidence: medium] [anchor: weighing: footprint — no instance, pool or migration tool to run, versus Cloud SQL]
- [ ] Q4. Does "every saved report" mean every stored report? On redirect: the tick would filter on a new flag, and the cost estimate shrinks.
  - **Stakes:** user — a narrower meaning would refresh reports the user did not mean to pay for.
  - **Recommended:** yes, every stored report — the repo has no "saved" flag and its existing list helper already treats every stored report as saved [confidence: high] [anchor: src/db.ts:19]
- [ ] Q5. Should refresh re-suggest titles? On redirect: the worker adds one title call per report and may overwrite titles.
  - **Stakes:** user — a re-suggested title could replace one a reader recognises or a person chose.
  - **Recommended:** no — keep the title untouched; it saves one paid call per report per night and avoids surprising readers with a renamed report [confidence: medium] [anchor: weighing: risk — a title is identity, sections are content]
- [ ] Q6. Should readers see a partly refreshed report? On redirect: the worker writes each section as it finishes instead of swapping at the end.
  - **Stakes:** user — a half-old, half-new report reads as inconsistent.
  - **Recommended:** no — stage finished sections and swap them in together; on failure the report keeps its previous content and shows `failed` [confidence: medium] [anchor: weighing: risk — all-or-nothing swap costs nothing extra because staging already exists for retries]
- [ ] Q7. Official Google clients or hand-rolled REST calls? On redirect: Tasks 1, 4 and 6 drop two dependencies and add token and retry handling by hand.
  - **Stakes:** system — hand-rolled auth and paging is more code to get wrong; the clients add two runtime dependencies.
  - **Recommended:** the official `@google-cloud/firestore` and `@google-cloud/tasks` clients — they handle service-account auth and task-name de-duplication, which is the stated reason AGENTS.md asks for [confidence: medium] [anchor: weighing: effort — two well-scoped clients versus re-implementing auth and pagination]
- [ ] Q8. How is the worker protected from public callers? On redirect: Task 6 adds token verification code and Task 7 drops the second service.
  - **Stakes:** system — an open worker route lets anyone trigger paid generation and skip the spend cap.
  - **Recommended:** a separate Cloud Run service from the same image, deployed without public access, invoked only by the queue's and scheduler's service account — IAM enforces it with no auth code [confidence: medium] [anchor: adjacent: deploy.sh:3]
- [ ] Q9. When does "nightly" run? On redirect: one scheduler flag changes.
  - **Stakes:** user — a run that finishes after readers arrive leaves them on yesterday's content.
  - **Recommended:** 03:00 America/Chicago, the time zone of the deploy region [confidence: medium] [anchor: weighing: reversibility — a single scheduler setting, changeable without a code deploy]
- [x] Section names versus bodies: `sections` stays the list of section names (the model client takes a section name), and a new `sectionBodies` field holds generated text — resolved without asking
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision 1 — which reports does the nightly run refresh?** All three branches are fully automated: 0 interruptions per run.

| Branch | What a reader sees | What the system does | Nightly paid calls |
| ------ | ------------------ | -------------------- | ------------------ |
| A. Every stored report (as asked), under the nightly cap | Opens any report in the morning: content is from last night, with its refresh time | Tick enqueues every report; the cap stops runaway spend | sections x reports, capped |
| B. Only reports read in the last 30 days, under the cap | Opens a recently read report: fresh. Opens a dormant one: stale until the next night after it is read | Every read writes a last-read time; tick filters on it | fewer, capped |
| C. Refresh on read when older than a day | Opens a stale report: sees old content plus "refreshing", returns minutes later for new content | Each stale read enqueues one task; no scheduler | only for reports actually opened |

- Exclusivity: A, B and C are mutually exclusive selection rules; the nightly cap is complementary to all three.
- Ranked combinations: 1) A + cap — matches the request and gives every reader fresh content without waiting; 2) B + cap — cheaper, but a dormant report's first reader gets stale content and every read becomes a write; 3) C — cheapest, but puts the wait and the re-check on the reader, which the brief ranks above cost.

Verdict: **A + nightly cap** — user experience outranks cost in the brief, and the cap bounds the cost side; revisit B if Q2's cap is regularly hit [confidence: high] [anchor: user: "refresh every saved report nightly"]

## Alternatives considered

- **A nightly timer inside the existing service** — rejected: Cloud Run throttles CPU outside requests and scales to zero, so the timer never fires reliably (https://docs.cloud.google.com/run/docs/configuring/billing-settings).
- **Generating every report inside the scheduler tick** — rejected: one section takes 20-60 s (src/llm.ts:1), so a handful of reports outruns the tick's 180 s attempt deadline and one failure re-runs everything.
- **One queued task per section with a fan-in finalize step** — rejected: per-section staging on the report gives the same retry savings without the finalize step or section-count times more tasks.

## Recommendation

**Reconsider scope** — widen the request to include durable report storage (the premise check shows the current store is empty in production) and bound "every report" with one nightly call cap; if Q1 shows nothing will create reports, Defer instead. [confidence: high] [anchor: src/db.ts:9]

**Redundancy:** none found — the service has no scheduled work, queue, or refresh path today.

## Plan risks

The plan's value rests on reports existing in the new store; if Q1's answer is that reports are created somewhere this plan does not write to, the job, queue and scheduler run nightly and refresh nothing.

## Cut list

- The quarterly restore check could start as a one-time check at setup; it stays because report definitions are irreplaceable once real users create them.
- nothing else — each remaining piece (ledger, staging, private worker) closes a named failure: runaway spend, double-charging on retry, or public triggering of paid work.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --------- | ----- | ---------- | --------- | --------------------------- | ------------------------ |
| Add a report-creation endpoint | High | Medium | genuinely novel non-trivial feature — its own user goal (making a report) and surface; without it the refresh has nothing to refresh | prerequisite for the refresh to do any work; depends on Q1 | No |

- [x] Add a report-creation endpoint — the service can read and share reports but nothing creates one.
  - **UX:** a person can create a report through the service instead of the store being empty for every reader [anchor: src/app.ts:9]
  - **Problem:** no route writes a new report; the only write re-saves an existing one on share [anchor: src/app.ts:20]
  - **Stability/efficiency:** none
  - **Value rank:** 5 — a broken path with no workaround: the service has no way to hold any report at all [anchor: src/app.ts:20]
  - **Complexity:** Medium — a new endpoint that queues the first generation through the worker this plan adds
  - **Risk:** Medium — a new paid, public entry point needing its own per-caller limits
  - **If never done:** the nightly refresh and the read endpoint keep serving an empty store
  - **Verdict:** clears bar — with no creation path the service delivers nothing, which outweighs a medium build and review load

# Task breakdown

### Task 1: Durable report store

- **Skill:** `flow-system-design`
- **Bundled:** the in-memory store rewrite surfaced by the premise check — prerequisite for any job to find reports
- **Description:** Replace the in-process map with a `ReportStore` interface backed by Firestore (collection `reports`, doc id = report id), keeping a memory implementation for tests and local runs (`REPORTS_STORE=memory`). Make the API async. Extend `Report` with `sectionBodies`, `refreshedAt`, `lastRefresh`, `pendingRefresh`. Switch the share handler to a field update so it cannot overwrite a concurrent refresh swap. Every store call gets a 5 s timeout.
- **Inputs:** src/db.ts, src/app.ts; new dependency `@google-cloud/firestore`
- **Outputs:** durable async store, contract tests shared by both implementations
- **Contract:**
  - **Files:** edit `src/db.ts`; edit `src/app.ts`; edit `package.json`; create `src/db.test.ts`
  - **Interfaces:**
    - `export type RefreshStatus = "ok" | "failed" | "skipped_budget"`
    - `export type Report = { id: string; company: string; sections: string[]; title: string | null; shared: boolean; sectionBodies: string[]; refreshedAt: string | null; lastRefresh: { runDate: string; status: RefreshStatus; at: string } | null; pendingRefresh: { runDate: string; bodies: (string | null)[] } | null }`
    - `export interface ReportStore { get(id: string): Promise<Report | undefined>; save(report: Report): Promise<void>; update(id: string, patch: Partial<Omit<Report, "id">>): Promise<void>; listIds(pageSize: number, afterId?: string): Promise<string[]> }`
    - `export function memoryStore(): ReportStore`, `export function firestoreStore(): ReportStore`, `export function store(): ReportStore`, `export function setStore(s: ReportStore): void`
    - `getReport`, `saveReport` keep their names and become async; `listSavedReports` is replaced by `ReportStore.listIds`
  - **Call-site edits:** `src/app.ts` `handle` — `await getReport(...)`; share branch calls `store().update(id, { shared: true })` instead of `saveReport({ ...report, shared: true })`
- **Acceptance criteria:** `bun test src/db.test.ts && bun test`

### Task 2: Model client timeouts and failure handling

- **Skill:** `flow-system-design`
- **Bundled:** the missing timeout and status check on both model calls, surfaced by the existing-code assessment
- **Description:** Add an abort timeout to both calls (90 s section, 10 s title) and throw a typed error on a timeout, a non-2xx status, or a missing text field, so the worker can map failures to `upstream_timeout` / `upstream_error` instead of storing `undefined`.
- **Inputs:** src/llm.ts
- **Outputs:** bounded, typed-failure model client
- **Contract:**
  - **Files:** edit `src/llm.ts`; create `src/llm.test.ts`
  - **Interfaces:** `export class LlmError extends Error { kind: "timeout" | "upstream" }`; `generateSection(company: string, section: string, opts?: { timeoutMs?: number }): Promise<string>`; `suggestTitle(sections: string[], opts?: { timeoutMs?: number }): Promise<string>`
  - **Call-site edits:** none — no current caller
- **Acceptance criteria:** `bun test src/llm.test.ts`

### Task 3: Metrics helper and metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create the repo-local helper with a closed `ErrorType` union (`_OTHER`, `budget_exhausted`, `internal`, `not_found`, `upstream_error`, `upstream_timeout`), a typed attribute map, `instrument`, `recordOutbound`, `setGauge`, and a swappable in-memory recorder. Create `.flow/metrics.md` with Backend `none yet — suggested: Google Cloud Monitoring`, Namespace `reports`, the Attributes, error.type values, Helper, Dashboard panels, Alerts, As-code `spec-only`, SLOs and Coverage sections from this plan's Instrumentation.
- **Inputs:** this plan's `## Instrumentation`
- **Outputs:** helper plus committed metrics contract
- **Contract:**
  - **Files:** create `src/metrics.ts`; create `src/metrics.test.ts`; create `.flow/metrics.md`
  - **Interfaces:** `export type ErrorType = "_OTHER" | "budget_exhausted" | "internal" | "not_found" | "upstream_error" | "upstream_timeout"`; `export function instrument<T>(op: "reports.refresh" | "reports.refresh.enqueue", fn: () => Promise<T>, classify: (e: unknown) => ErrorType): Promise<T>`; `export function recordOutbound<T>(host: "api.example-llm.com", fn: () => Promise<T>, classify: (e: unknown) => ErrorType): Promise<T>`; `export function setGauge(name: "reports.refresh.last_success_time", value: number): void`; `export function memoryRecorder(): Recorder`; `export function setRecorder(r: Recorder): void`
  - **Call-site edits:** none — consumed by Tasks 4-6
- **Acceptance criteria:** `bun test src/metrics.test.ts && test -f .flow/metrics.md && grep -q '## error.type values' .flow/metrics.md`

### Task 4: Nightly spend ledger

- **Skill:** `flow-system-design`
- **Description:** One choke point for paid spend: a transactional counter per run date (Firestore doc `spend/<runDate>`), reserving one section call at a time and refusing once the cap is reached. Cap from `REFRESH_MAX_SECTION_CALLS_PER_NIGHT`, placeholder default 500 (Q2). Memory implementation for tests.
- **Inputs:** Task 1 store setup; new: src/spend.ts
- **Outputs:** `reserveSectionCall` used by the worker before every model call
- **Contract:**
  - **Files:** create `src/spend.ts`; create `src/spend.test.ts`
  - **Interfaces:** `export interface SpendLedger { reserveSectionCall(runDate: string): Promise<boolean> }`; `export function memoryLedger(cap: number): SpendLedger`; `export function firestoreLedger(cap: number): SpendLedger`; `export function nightlyCap(): number`
  - **Call-site edits:** none — consumed by Task 5
- **Acceptance criteria:** `bun test src/spend.test.ts` (asserts the cap+1th reservation returns false and concurrent reservations never exceed the cap)

### Task 5: Refresh worker logic

- **Skill:** `flow-system-design`
- **Description:** `refreshReport` loads the report; returns `already_done` when `lastRefresh.runDate === runDate` with status ok; returns `not_found` for a missing report; generates each section not yet staged in `pendingRefresh` (3 at a time), reserving one budget call before each and staging each body as it finishes; on all staged, swaps `sectionBodies`, sets `refreshedAt`, `lastRefresh: ok`, clears `pendingRefresh` in one update. Budget refused: `skipped_budget`, content untouched. Model failure: `retry` unless this is the final attempt, then `failed` with content untouched. Stops starting new sections after a 480 s handler budget and returns `retry` (staged sections persist). Wraps the run in `instrument("reports.refresh", …)` and each model call in `recordOutbound`.
- **Inputs:** Tasks 1-4 (src/db.ts, src/llm.ts, src/metrics.ts, src/spend.ts)
- **Outputs:** idempotent per-report refresh
- **Contract:**
  - **Files:** create `src/refresh.ts`; create `src/refresh.test.ts`
  - **Interfaces:** `export type RefreshResult = { status: "ok" | "already_done" | "skipped_budget" | "not_found" | "failed" | "retry" }`; `export async function refreshReport(reportId: string, runDate: string, attempt: { retryCount: number; maxAttempts: number }, deps?: { store?: ReportStore; ledger?: SpendLedger; generate?: typeof generateSection; now?: () => Date; budgetMs?: number }): Promise<RefreshResult>`
  - **Call-site edits:** none — consumed by Task 6
- **Acceptance criteria:** `bun test src/refresh.test.ts` — covers idempotency key `<reportId>:<runDate>` (second delivery makes 0 model calls), resume after partial failure (only unstaged sections regenerate), 90 s per-call timeout mapped to `upstream_timeout`, 480 s handler budget returning `retry`, budget refusal, final-attempt `failed`, and emission of `reports.refresh.duration` / `reports.refresh.failures` against the in-memory recorder

### Task 6: Nightly tick and private worker entry point

- **Skill:** `flow-system-design`
- **Description:** `enqueueNightly` pages through report ids (500 per page) and creates one Cloud Task per report on queue `report-refresh`, named `refresh-<reportId>-<runDate>`, with `dispatchDeadline` 600 s and an OIDC token for the worker service account; an already-exists response counts as success. Sets `reports.refresh.last_success_time` on success. `src/worker.ts` serves `POST /tasks/enqueue-nightly` and `POST /tasks/refresh-report` (`{ reportId, runDate }`), reads `X-CloudTasks-TaskRetryCount`, and maps `retry` to 503 and every other result to 200. `runDate` is the UTC date at tick time.
- **Inputs:** Task 5; new dependency `@google-cloud/tasks`
- **Outputs:** worker HTTP surface for the scheduler and the queue
- **Contract:**
  - **Files:** create `src/enqueue.ts`; create `src/worker.ts`; create `src/worker.test.ts`; edit `package.json`
  - **Interfaces:** `export async function enqueueNightly(runDate: string, deps?: { store?: ReportStore; createTask?: (name: string, body: { reportId: string; runDate: string }) => Promise<"created" | "exists"> }): Promise<{ enqueued: number; existing: number }>`; `export async function handleWorker(req: Request): Promise<Response>`
  - **Call-site edits:** none — new entry point, started with `bun src/worker.ts`
- **Acceptance criteria:** `bun test src/worker.test.ts` — asserts task name `refresh-<reportId>-<runDate>`, dispatch deadline 600 s, already-exists counted as success, and 503 on `retry`

### Task 7: Infra — database recovery, queue, scheduler, private worker service

- **Skill:** `flow-system-design`
- **Description:** One-time setup script plus deploy changes. Firestore: create database, enable point-in-time recovery, daily backup schedule with 14-day retention. Queue `report-refresh`: `--max-attempts=3 --min-backoff=60s --max-backoff=600s --max-doublings=3 --max-concurrent-dispatches=4 --max-dispatches-per-second=1` (dispatch deadline 600 s is set per task in Task 6). Scheduler job `reports-nightly-refresh`: `--schedule="0 3 * * *" --time-zone="America/Chicago" --attempt-deadline=180s --max-retry-attempts=1`, OIDC service account. Worker service `reports-refresher`: same source, command `bun src/worker.ts`, `--no-allow-unauthenticated --timeout=600 --max-instances=2 --concurrency=4`; grant the invoker service account `roles/run.invoker`. Restore check script restores the latest backup to a scratch database and compares document counts.
- **Inputs:** Task 6 worker entry point
- **Outputs:** deployable nightly pipeline with recovery in place
- **Contract:**
  - **Files:** edit `deploy.sh`; create `infra/refresh-setup.sh`; create `infra/restore-check.sh`
  - **Interfaces:** config/infra — `deploy.sh` gains a second `gcloud run deploy reports-refresher` with the flags above (existing `reports-service` line unchanged); `infra/refresh-setup.sh` holds the Firestore, PITR, backup-schedule, queue, scheduler and IAM commands with the exact flag values above
  - **Call-site edits:** none
- **Acceptance criteria:** `bash -n deploy.sh && bash -n infra/refresh-setup.sh && bash -n infra/restore-check.sh && grep -q -- '--no-allow-unauthenticated' deploy.sh && grep -q -- '--timeout=600' deploy.sh && grep -q -- '--max-attempts=3' infra/refresh-setup.sh && grep -q -- '--enable-pitr' infra/refresh-setup.sh && grep -q 'backups schedules create' infra/refresh-setup.sh`

| Task | Depends on |
| ---- | ---------- |
| 1 | — |
| 2 | — |
| 3 | — |
| 4 | 1 |
| 5 | 1, 2, 3, 4 |
| 6 | 5 |
| 7 | 6 |

### Skills Summary

| Skill | Recommended? | Reason |
| ----- | ------------ | ------ |
| flow-system-design | Yes (Tasks 1, 2, 4-7) | scheduled, paid, retried background work: execution model, timeouts, idempotency, spend cap |
| flow-metrics | Yes (Task 3) | first instrumented change; creates the helper and `.flow/metrics.md` |
| flow-testing | No (folded in) | each task carries its own `bun test` file; no separate test task |
| flow-ui-ux | No | no UI surface |

# PR description draft

## TLDR

Saved reports now survive deploys and are regenerated every night, showing when they were last refreshed, under a fixed nightly model-call budget; before, reports lived only in server memory and never changed.

## User-facing changes

- Reports keep existing after a deploy or a quiet period:
  - **Before:** every deploy or scale-down erased all stored reports.
  - **After:** reports are kept in a durable database and survive deploys and restarts.
- Each morning, a report's section content is the version regenerated overnight, swapped in all at once so a reader never sees a half-updated report.
- Every report now shows when its content was last refreshed and whether last night's refresh succeeded, failed, or was skipped because the nightly budget ran out.
- A report's title is left as it is during refresh.
- Each refresh replaces the previous section content; earlier versions are not kept.

## System changes

- Report storage moved out of the server process:
  - **Before:** reports were held in one server instance's memory, not shared between instances.
  - **After:** reports live in Firestore with point-in-time recovery and daily backups.
- New nightly pipeline: a scheduler at 03:00 Central enqueues one refresh task per report; a private worker service, reachable only by the queue and scheduler, regenerates the sections.
- Model calls now give up after a fixed time:
  - **Before:** a hung model call could hold the request indefinitely, and a failed call stored empty text.
  - **After:** section calls stop at 90 seconds, title calls at 10 seconds, and failures are reported instead of stored.
- Ongoing cost: adds up to the nightly cap in paid section calls per night (placeholder 500; for example 50 reports with 6 sections each costs 300 calls a night), plus a worker service that scales to zero outside the nightly run, a task queue, a scheduler job and database backups. A repeated task makes no extra calls.

## Why

Readers of saved reports get content as old as the report, with no sign of its age, and the service currently loses every report whenever it restarts, so there is nothing durable to keep fresh. The content comes from slow, paid model calls, so any freshness has to come with a cost ceiling.

## Key decisions

- Every stored report is refreshed, not only recently read ones — the request said "every saved report", and refreshing on read would make the first reader wait and re-check; a nightly call cap bounds the cost instead.
- One queued task per report, with finished sections saved as it goes, rather than one task per section — retries skip finished sections without needing a separate assembly step.
- The worker runs as a separate private service, so public callers cannot trigger paid generation; the existing public service is unchanged.
- Firestore over Cloud SQL — single-document reads by id, no connection pool or migration tool to run.
- Titles are not regenerated — saves one paid call per report and avoids renaming reports readers recognise.
- Out of scope: creating reports (no creation path exists yet and it is filed as a follow-up), version history, and an on-demand "refresh now".
- Bundled: durable report storage, the prerequisite the premise check surfaced.
- Bundled: timeouts and failure handling on the model calls.

## Instrumentation

Metrics: refresh duration and failures per report, nightly tick duration, failures and last-success time, and model-call duration and failures; queue backlog comes from the platform. Planned panels for a "Nightly refresh" dashboard: outcome rate per night, refresh and model-call latency, failures by type, queue depth, hours since the last successful tick. Alerts: no successful tick in 48 hours, and the nightly budget being exhausted. New SLO: 99% of reports refreshed successfully each night over 28 days. Dashboards are spec-only, and the graphs need a metrics backend to be chosen first (suggested: Google Cloud Monitoring, recorded in the metrics contract).

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/db.test.ts` — a saved report reads back intact from a fresh store, and sharing a report does not overwrite its section content.
- [ ] Run `bun test src/llm.test.ts` — a stalled model call fails with a timeout and a non-2xx response fails with an upstream error.
- [ ] Run `bun test src/spend.test.ts` — the reservation after the cap is refused, and concurrent reservations never exceed the cap.
- [ ] Run `bun test src/refresh.test.ts` — a report is refreshed in one swap, a repeated delivery makes zero model calls, a retry regenerates only unfinished sections, and a final-attempt failure leaves content untouched with a failed status.
- [ ] Run `bun test src/worker.test.ts` — the tick creates one task per report with the per-report name, an existing task counts as success, and a retryable result returns 503.
- [ ] Run `bun test src/metrics.test.ts` — refresh and model-call metrics are recorded with the expected outcome and error type.
- [ ] Run `grep -q -- '--no-allow-unauthenticated' deploy.sh && grep -q -- '--timeout=600' deploy.sh` — the worker service is private and its timeout covers the queue's deadline.
- [ ] Run `grep -q -- '--max-attempts=3' infra/refresh-setup.sh && grep -q -- '--enable-pitr' infra/refresh-setup.sh` — the queue's retry limit and database recovery are configured.
- [ ] DECISION: you accept a placeholder nightly cap of 500 section calls until you set your own budget.
