# PRD

# Nightly refresh of saved reports

**Goal:** Every saved report keeps its content current: its sections are regenerated each night within a fixed spend cap, and a failed night never blanks or corrupts what readers see.

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

## Problem Statement

The reports service holds company reports made of model-written sections, and people read or share them by link. The request is to regenerate every saved report's sections each night, so a report someone opens is never older than about a day. Today a report is never regenerated, and it isn't actually saved either: it sits in one server's memory and is gone after any deploy, restart or scale-down. So there is nothing durable to refresh yet. The work has to start by making reports survive, then add a nightly refresh with a firm ceiling on what it can spend.

**Premise check:** the request assumes a durable set of "saved" reports. The codebase shows otherwise:

| Assumed by the request | What the codebase shows |
| --- | --- |
| Saved reports persist between nights | Reports live only in a process-local map, lost on every restart or scale-down, and each Cloud Run instance has its own copy [anchor: src/db.ts:9] |
| Something creates the reports being refreshed | No route creates a report; the only write is the share toggle, and nothing calls the section or title generators [anchor: src/app.ts:9-24] |
| "Refresh" re-uses an existing generation path | `generateSection` exists but has no caller, no timeout and no error check; each call takes 20-60 s and is billed [anchor: src/llm.ts:1-11] |
| A report stores what it needs to regenerate itself | A report stores one `sections: string[]` list with no separate section name, so regenerating from it is ambiguous [anchor: src/db.ts:4] |

Who is affected, in the product brief's terms: the reader of a report (priority 1, user experience — they want current content with no surprises), and the owner paying for model calls (priority 2, cost — a nightly loop over every section of every report is the largest ongoing spend this service would have).

## Request vetting

- **Hypothesis:** Regenerating each saved report's sections once a night, with the same prompt, gives readers materially more current content, and that is worth one paid 20-60 s model call per section per night.
- **Case against:** The prompt carries no date and no source documents, so unless the model provider grounds its answers on live data, each night buys a paid rewording of the same facts and silently changes the wording of reports people have already shared [anchor: src/llm.ts:6-9]. Separately, the reports it would refresh do not survive a restart today [anchor: src/db.ts:9], and the service is public with no authentication, so any refresh trigger placed on it is open to anyone [anchor: deploy.sh:3].
- **Sources:** no outside source: research pre-check judged this not researchable; the case rests on the repo files cited and the blind judge's read of the same prompt.
- **Verdict:** adopt-with-conditions: reports move to durable storage first, every nightly model call passes one nightly cap (default 100 section regenerations), a failed regeneration keeps the previous content, and the nightly schedule ships paused until the owner confirms the provider returns current information.

## Existing-code assessment

- **src/db.ts (report storage):** rewrite — an in-memory map cannot hold anything across nights or instances, which is the feature's precondition; it becomes an async store with a durable adapter and an in-memory adapter for tests [anchor: src/db.ts:9]
- **src/app.ts (HTTP handlers):** simplify — the share handler re-saves the whole report it read, which would overwrite a section a concurrent refresh just wrote; it becomes a single-field update, and handlers await the async store [anchor: src/app.ts:20]
- **src/llm.ts (model client):** simplify — add a per-call timeout and a status check so a hung or failed call cannot hang a worker or store an undefined section [anchor: src/llm.ts:6-10]
- **deploy.sh (deploy):** keep — extend with a second, private deploy of the same image for the refresh worker; the public deploy line is unchanged [anchor: deploy.sh:3]

## Scope Boundary

**In scope:**

- Durable report storage that survives deploys, restarts and scale-down, with point-in-time recovery and a scheduled backup.
- A nightly schedule that queues one regeneration per report section, ordered shared reports first, then least recently refreshed.
- One nightly cap on paid section regenerations, enforced at a single choke point; units over the cap wait for the next night.
- A private worker that regenerates a section, keeps the previous content on failure, and records when each section was last refreshed.
- The report response gains a `refreshedAt` timestamp; its existing fields keep their shape.
- Timeout and failure handling on the model client.
- Metrics, alert and SLO spec for the nightly run.

**Out of scope:**

- Creating reports (no create route exists; tracked as a candidate follow-up).
- Regenerating titles (no extra title call per report; titles stay as they are).
- An on-demand "refresh now" action.
- Changing the generation prompt (for example adding a date or sources).
- Multi-region, canary rollout, or a workflow engine.

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| A report disappears after any deploy, restart or scale-down | A report persists until deleted |
| A report's sections never change after they are written | Each section is regenerated once a night (once the schedule is resumed) |
| A reader cannot tell how old a report's content is | The report response carries `refreshedAt`, the time its oldest section was last regenerated |
| — | A section whose regeneration fails keeps its previous text; the reader sees no gap |
| — | On a night with more sections than the cap allows, the rest wait for the next night, shared reports first |

### System flow

- **Before:**
  - Reports are held in each instance's memory; nothing runs on a schedule; the model client has no caller.
- **After:**
  - Reports are stored in a durable database shared by every instance.
  - A nightly clock calls a private worker, which queues one task per report section, up to the nightly cap.
  - The queue calls the private worker once per section; the worker reserves budget, regenerates, and writes the section.
  - Ongoing cost: up to the cap (default 100) paid section calls per night, plus small database and queue charges.

**Lost:** a shared report's wording is no longer stable — readers who return to it may find its text rewritten overnight with no notice; and the service gains a new ongoing model-call spend of up to the nightly cap.

## User Stories / Acceptance Criteria

### Story 1: Reports survive restarts

- [ ] Given a report saved through the store, when a new store instance reads it, then the same report comes back — `bun test src/db-firestore.test.ts` against the Firestore emulator.
- [ ] Given a shared toggle and a section write on the same report, when both run, then neither overwrites the other — `bun test src/db.test.ts` (setShared leaves sections untouched).
- [ ] Given a stored report, when `GET /reports/:id` runs, then the response keeps `id`, `company`, `title`, `shared`, `sections` as a list of strings and adds `refreshedAt` — `bun test src/app.test.ts`.

### Story 2: Nightly regeneration within a cap

- [ ] Given 3 reports with 2 sections each and a cap of 4, when the nightly tick runs, then exactly 4 tasks are queued, shared reports' sections first, and 2 units are counted as deferred — `bun test src/tick.test.ts`.
- [ ] Given the tick runs twice for the same night, when the second run enqueues, then every task reports "already exists" and no extra task is created — `bun test src/tick.test.ts`.
- [ ] Given the ledger already holds the cap for tonight, when a section task arrives, then no model call is made and the section is unchanged — `bun test src/refresh.test.ts`.

### Story 3: Failed regeneration is safe and visible

- [ ] Given the model call times out, when the worker handles the task, then the previous content is kept, the section records `upstream_timeout`, and the response is retryable (503) — `bun test src/refresh.test.ts`.
- [ ] Given a section already refreshed for tonight, when its task is redelivered, then the worker returns 200 without a model call — `bun test src/refresh.test.ts`.
- [ ] Given the public service, when anyone calls `/internal/refresh/tick` on it, then it answers 404 — `bun test src/app.test.ts`.

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports.refresh.section.duration` | Histogram (bounds 1, 5, 10, 20, 30, 45, 60, 90, 120 s) | seconds | `operation.outcome` (ok, error) | section worker |
| `reports.refresh.section.failures` | Counter | none | `error.type` (closed list below) | section worker |
| `reports.llm.call.duration` | Histogram (same bounds) | seconds | `server.address` (api.example-llm.com), `operation.outcome` (ok, error) | model client |
| `reports.llm.call.failures` | Counter | none | `error.type`, `server.address` (api.example-llm.com) | model client |
| `reports.refresh.tick.duration` | Histogram (bounds 0.5, 1, 2.5, 5, 10, 30, 60, 120 s) | seconds | `operation.outcome` (ok, error) | nightly tick |
| `reports.refresh.tick.failures` | Counter | none | `error.type` | nightly tick |
| `reports.refresh.tick.units` | Counter | `{unit}` | `refresh.disposition` (enqueued, already_queued, deferred_by_cap) | nightly tick |
| `reports.refresh.last_success` | Gauge | seconds (Unix time) | none | nightly tick, on success |
| `reports.refresh.budget.used` | Gauge | `{call}` | none | section worker, after each reservation |
| Cloud Tasks queue depth and oldest-task age | Gauge | `{message}`, seconds | queue name | platform-native (Cloud Tasks `queue/depth`) |

Estimated series: 31 per operation for the section refresh (2 × 12 histogram + 7 failures)
Estimated series: 31 per operation for the model call (1 × 2 × 12 histogram + 7 failures)
Estimated series: 34 per operation for the nightly tick (2 × 11 histogram + 7 failures + 3 units + 1 staleness gauge + 1 budget gauge)

**Attributes:** reuses registered `operation.outcome`, `error.type`, `server.address`; new key `refresh.disposition` with closed values `enqueued`, `already_queued`, `deferred_by_cap`, added as a `.flow/metrics.md` `## Attributes` row.

### Error types

| Value | Meaning |
| --- | --- |
| `_OTHER` | fallback: no listed class fits |
| `budget_exhausted` | tonight's cap was already spent; the section waits for the next night |
| `internal` | unexpected failure inside this service |
| `not_found` | the report or section was deleted after it was queued |
| `rate_limited` | the model provider answered 429 |
| `upstream_error` | the model provider answered non-2xx or a malformed body |
| `upstream_timeout` | the model provider did not answer within 90 s |

### Dashboard panels

- "Nightly refresh" on the Reports overview dashboard: section refresh p50/p99 and error rate; units by disposition per night; budget used vs cap; hours since last successful tick; Cloud Tasks queue depth.

### Alerts

| Signal | Condition | Sustained for | Action | Routes to | Dashboard |
| --- | --- | --- | --- | --- | --- |
| Refresh stale | now − `reports.refresh.last_success` > 48 h (twice the schedule) | 10 min | notify | owner notification channel (not yet created; named in `.flow/metrics.md`) | Reports overview (spec-only) |
| Cap biting | `reports.refresh.tick.units{refresh.disposition=deferred_by_cap}` > 0 on 2 consecutive nights | 2 runs | notify | owner notification channel | Reports overview (spec-only) |
| Section failures | `reports.refresh.section.failures` / section count > 20 % within one night | 1 run | notify | owner notification channel | Reports overview (spec-only) |
| Queue not draining | Cloud Tasks oldest-task age > 6 h | 30 min | notify | owner notification channel | Reports overview (spec-only) |

### SLO

New journey SLO "report content is current": SLI = share of section refresh tasks whose final outcome is `ok` (excluding `budget_exhausted` and `not_found`); target 95 % over 28 days. It is a new journey because the repo has no SLOs yet.

**As-code:** spec-only — the repo keeps no dashboard or alert files and no metrics backend (`## Backend` is `none yet — suggested: Google Cloud Monitoring via OTLP`); these metrics are recorded in memory but will not show on any graph until a backend is chosen.

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | Persistence (durable store, spend ledger), integration (model client, queue client), HTTP handlers (public read/share, private internal routes), infra (deploy, queue, schedule, backups) |
| Domain modules | Rewritten: report store. Simplified: model client, handlers. New: Firestore adapter, spend ledger, section worker, nightly tick, queue client, metrics helper, internal routes |
| Data flow | Scheduler tick → reads reports → queues one task per section → worker reserves budget → calls the model → writes the section → readers see the new text and `refreshedAt` |
| Pattern | New: scheduler-enqueue plus one queued task per section, the shape the system-design skill prescribes for periodic multi-section paid work; no existing pattern in the repo to follow |
| Binary-framing check | The request reads as "refresh every report nightly" vs today's "never". Middle ground adopted: every report, but under a nightly cap with priority ordering, and the schedule ships paused until the provider-freshness question is answered |
| Goal-anchor check | "every saved report" is kept literally; the cap only defers, never drops, so every report is still refreshed within a few nights at most when volume exceeds the cap |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| Nightly tick (select units, enqueue) | ~10 s for ≤100 units | scheduler-enqueue: Cloud Scheduler calls the private worker, which enqueues one named Cloud Tasks task per (report, section) and returns | handler budget 60 s; each enqueue call 10 s; Scheduler attempt deadline 120 s | Cloud Scheduler only: max 2 retries, backoff 60-300 s; none in the handler | task name `r-<sha256(reportId, sectionName) prefix>-<runDate>` | enqueues at most (cap − budget already used tonight) units |
| Section refresh (worker) | ~65 s | queue: Cloud Tasks HTTP target with OIDC, worker invoked synchronously under the dispatch deadline; responds 2xx on done or permanent failure, 503 on transient | dispatch deadline 150 s > worker budget 120 s > model call 90 s; worker service request timeout 180 s | Cloud Tasks only: max attempts 3, min backoff 60 s, max backoff 600 s, max doublings 3 | `<reportId>:<sectionName>:<runDate>`, checked against the section's `refreshedFor` and a lease, written in the same update as the content | new spend ledger: one reservation per model call, refused at the cap |
| Model call (`generateSection`) | 60 s | inline within the worker | 90 s abort timeout | none at this layer | inherits the worker key | reserved in the ledger before the call |
| Spend reservation | ~50 ms | inline, one Firestore transaction on `spend/<runDate>` | 5 s | none beyond the database client's own transaction-contention retry | `spend/<runDate>` document | is the cap (default 100 calls per night) |
| `GET /reports/:id` (changed: reads the durable store) | inline — ~100 ms, timeout 5 s | | | | | |
| `POST /reports/:id/share` (changed: single-field update) | inline — ~150 ms, timeout 5 s | | | | | |

**Platform:** gcp

**Proportionality:** no workflow engine and no finalize step (each section stands alone, nothing assembles them); no dead-letter queue (Cloud Tasks drops after max attempts, and the section's recorded error is the visible failed state); no title regeneration; no canary or traffic split (no live users yet, rollback is redeploying the previous revision); the tick loads every report into memory to sort, deliberately left unpaginated until report count makes the 60 s budget tight; worker capped at 2 instances × 5 concurrent requests and the queue at 5 concurrent dispatches, 1 per second.

**Recovery:** Firestore holds report definitions (company, section names, shared flag) that are user input and cannot be regenerated, and section text that can be regenerated at one paid call per section. Enable point-in-time recovery (7-day window) and a daily scheduled backup kept 7 days; a scripted restore check restores the latest backup to a scratch database and compares document counts, run once at setup and quarterly after.

## Technical Constraints

- New runtime dependency `@google-cloud/firestore` needs a stated reason [anchor: AGENTS.md:5]; the reason is durable storage with transactional conditional writes, which a hand-rolled REST client would have to re-implement. The Cloud Tasks and metadata-token calls stay plain `fetch` with no new dependency.
- Internal routes must not be reachable on the public service, because it deploys with `--allow-unauthenticated` [anchor: deploy.sh:3]; they are mounted only when `SERVICE_ROLE=worker` and that service deploys with `--no-allow-unauthenticated`.
- Report response shape is a public contract: `sections` stays a list of strings (the section text); `refreshedAt` is additive [anchor: src/app.ts:13-14].
- Cost: each regeneration is 20-60 s and billed per call [anchor: src/llm.ts:1]; ongoing spend is bounded by the nightly cap (default 100 calls per night) and moves from zero to that ceiling once the schedule is resumed.
- Tests run under `bun test` [anchor: package.json:7]; Firestore adapter tests run only when `FIRESTORE_EMULATOR_HOST` is set and skip otherwise.

## Open Questions

- [ ] Does a nightly regeneration give readers newer information, or a rewording of the same facts? If the provider does not ground on current data, the nightly schedule should stay off and the feature reduces to durable storage.
  - **Stakes:** both — if wrong, the owner pays up to the cap every night for rewordings, and shared reports change wording with no new information.
  - **Recommended:** deliberated (high): the repository cannot determine this — the request carries no date or sources, so any freshness depends on undocumented provider behaviour; plan as if it is a rewording until the provider is checked, which is why the schedule ships paused [confidence: high] [anchor: src/llm.ts:6-9]
- [ ] Q1. How many paid section regenerations per night are you willing to fund? The cap's value sets both the ongoing cost ceiling and how many nights a large backlog takes to cycle.
  - **Stakes:** both — too low leaves reports stale for several nights; too high raises the monthly model bill.
  - **Needs user input:** user-held preference — the spend you accept per night; the plan defaults to 100 section regenerations per night (each 20-60 s, billed per call) until you set `REFRESH_DAILY_CALL_CAP`.
- [ ] What does a report's `sections` list hold — section names or generated text? The store needs both to regenerate, and the answer decides the stored shape.
  - **Stakes:** system — the wrong reading means refresh sends section text back as a section name.
  - **Recommended:** store each section as a name plus its text, and keep the response's `sections` as the list of texts — the generator takes a section name and returns text, so a report needs both [confidence: medium] [anchor: adjacent: src/llm.ts:2-5]
- [ ] Should a refresh also regenerate the title? Yes adds one paid 1-3 s call per report per night and can change a shared report's headline.
  - **Stakes:** user — a title rewritten overnight surprises readers; a stale title on fresh sections is a small mismatch.
  - **Recommended:** leave titles unchanged; refresh sections only [confidence: medium] [anchor: weighing: risk — a headline changing on a shared link is the most visible surprise, and it adds a paid call per report]
- [ ] Which reports count as "saved"? Narrowing to shared reports would cut cost but leave unshared reports stale.
  - **Stakes:** both — narrower saves spend but contradicts "every"; wider costs more.
  - **Recommended:** every stored report, with shared reports first in the nightly order [confidence: high] [anchor: user: "refresh every saved report nightly"]
- [ ] When one section of a report fails and the others succeed, does the report show a mix of new and old sections, or roll back to all-old?
  - **Stakes:** user — a mixed report has sections of different ages; all-or-nothing throws away paid work and shows nothing new.
  - **Recommended:** replace per section and keep the previous text for any failed section; `refreshedAt` reports the oldest section's time so the mix is never hidden [confidence: medium] [anchor: weighing: reversibility — per-section writes never lose paid output and the failed section retries next night]
- [ ] What time and time zone is "nightly"?
  - **Stakes:** user — a run during readers' working hours changes text while they read.
  - **Recommended:** 03:00 America/Chicago [confidence: medium] [anchor: weighing: convention — deploy.sh:3 pins us-central1, so the service's home time zone is US Central]
- [ ] Where do reports live durably — Firestore or Cloud SQL Postgres? See Decision analysis D1.
  - **Stakes:** system — the choice sets the fixed monthly cost and the client dependency.
  - **Recommended:** Firestore [confidence: medium] [anchor: weighing: footprint — a report is a flat document and Firestore has no always-on instance or connection pool to run]
- [ ] Should the refresh endpoints live on the public service behind token checks, or on a separate private service? See Decision analysis D2.
  - **Stakes:** system — a mistake exposes paid work to anyone on the internet.
  - **Recommended:** a separate private service from the same image [confidence: medium] [anchor: weighing: risk — deploy.sh:3 makes every route on the existing service public, while a private service is guarded by Cloud Run IAM with no token code to get wrong]
- [ ] Should report creation be built here? Without it nothing creates a report to refresh, but it is its own feature with its own decisions.
  - **Stakes:** user — until creation exists, the nightly run has nothing to refresh in production.
  - **Recommended:** no — keep it a candidate follow-up; this plan's store interface is what creation will write to [confidence: high] [anchor: src/app.ts:9-24]

## Decision analysis

**Decision D1 — where do reports live durably?** Mutually exclusive.

| Branch | System flow | Fixed cost | Friction |
| --- | --- | --- | --- |
| Firestore | Each instance reads and writes report documents; conditional updates via transactions; no pool to size | pay per read/write, nothing when idle | 0 interruptions per run — fully automated |
| Cloud SQL Postgres (Bun's built-in client) | Each instance holds connections to one database instance; a reports table with a JSON sections column | an always-on database instance billed whether or not anyone reads | 0 interruptions per run — fully automated |

Ranked: Firestore > Cloud SQL. Verdict: **Firestore** — fits the flat report document and the brief's cost priority (no idle bill) at the price of one client dependency [confidence: medium] [anchor: weighing: footprint — src/db.ts:1-7 is a single document shape with no joins].

**Decision D2 — where do the refresh endpoints run?** Mutually exclusive.

| Branch | System flow | Risk | Friction |
| --- | --- | --- | --- |
| Separate private worker service, same image | Scheduler and queue call it with OIDC; Cloud Run IAM rejects anyone else before the code runs; the public service never mounts the routes | a second service to deploy | 0 interruptions per run — fully automated |
| Public service, verify the OIDC token in code | One service; the handler fetches Google's signing keys and checks audience and email on each call | a bug in hand-written token checks exposes paid work to the internet | 0 interruptions per run — fully automated |

Ranked: private service > in-code check. Verdict: **private worker service** — authentication enforced by the platform rather than by code this plan would write [confidence: medium] [anchor: weighing: risk — deploy.sh:3 deploys the existing service with --allow-unauthenticated].

**Decision D3 — does the nightly schedule start running on deploy?** Complementary with D1/D2.

| Branch | User-flow walkthrough | Friction |
| --- | --- | --- |
| Ship paused | After merge the owner checks the provider's freshness, then runs one resume command; refresh starts that night | 1 interruption per rollout (one-time), 0 per night |
| Ship running | Refresh starts the first night after deploy, spending up to the cap whether or not the output is newer | 0 interruptions |

Verdict: **ship paused** — the provider-freshness answer is unknown and the cost is recurring, so one resume command is cheaper than paying for rewordings [confidence: high] [anchor: src/llm.ts:6-9].

## Alternatives considered

- **An in-process nightly timer on the existing service** — rejected: the store is per-process memory [src/db.ts:9], and Cloud Run throttles CPU outside requests and scales to zero, so a timer neither fires reliably nor sees every report.
- **One scheduled request that regenerates every section in a loop** — rejected: at 20-60 s per call [src/llm.ts:1], 60 sections already reach the 60-minute Cloud Run request ceiling, and a crash or retry re-pays every finished section.

## Recommendation

**Reconsider scope** — widen the request to include durable report storage (its precondition, per the Problem Statement's premise check), refresh under a nightly cap, and ship the schedule paused until the provider-freshness question is settled [confidence: high] [anchor: src/db.ts:9]

**Redundancy:** none found — nothing in the service schedules work or regenerates sections today.

## Plan risks

The plan's value rests on the provider returning newer information on each regeneration; if it only rewords, the nightly run is pure recurring cost and the useful part of this PR is durable storage alone.

## Cut list

- The per-section lease in the worker guards only against a task being redelivered while its first attempt is still running; named tasks and the queue's concurrency cap already make that rare — a reviewer may cut it if the double-spend risk is accepted.
- The `reports.refresh.budget.used` gauge can be derived from the units counter plus the cap; keep only if the dashboard panel needs a live reading.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Add a report-creation endpoint | High | Medium | genuinely novel non-trivial feature: no route creates a report, so the nightly refresh has nothing to work on in production | supplies the reports this plan refreshes | No |

- [x] Add a report-creation endpoint — generates a new report's sections through the queued worker this plan adds.
  - **UX:** none
  - **Problem:** no route in the service creates a report, and neither model generator has a caller [anchor: src/app.ts:9-24]
  - **Stability/efficiency:** none
  - **Value rank:** 5 — creating a report is a broken path with no workaround in this service [anchor: src/app.ts:9-24]
  - **Complexity:** Medium — a new route, request validation, and reuse of the section worker
  - **Risk:** Medium — opens a public paid-work entry point that needs its own caller limits
  - **If never done:** the service can only serve and share reports that nothing can create
  - **Verdict:** clears bar — a missing core path outweighs Medium complexity and risk

# Task breakdown

### Task 1: Async report store with in-memory adapter

- **Skill:** `flow-system-design`
- **Description:** Replace the module-level map with an async `ReportStore` interface and an in-memory adapter. Sections become `{ name, content, refreshedAt, refreshedFor, lease, lastError }`. Add `toView()` producing the unchanged public shape plus `refreshedAt` (oldest section's time). Replace the share handler's whole-report re-save with `setShared`, so it can never overwrite a section write. Handlers await the store.
- **Inputs:** src/db.ts, src/app.ts
- **Outputs:** async store contract every later task writes through; share race fixed
- **Contract:**
  - **Files:** edit `src/db.ts`; edit `src/app.ts`; create `src/db.test.ts`; create `src/app.test.ts`
  - **Interfaces:** `type Section = { name: string; content: string; refreshedAt: string | null; refreshedFor: string | null; lease: { runDate: string; expiresAt: string } | null; lastError: ErrorTypeName | null }`; `type Report = { id: string; company: string; sections: Section[]; title: string | null; shared: boolean }`; `type ReportView = { id: string; company: string; title: string | null; shared: boolean; sections: string[]; refreshedAt: string | null }`; `interface ReportStore { getReport(id: string): Promise<Report | undefined>; saveReport(r: Report): Promise<void>; setShared(id: string, shared: boolean): Promise<boolean>; listSavedReports(): Promise<Report[]>; claimSection(id: string, name: string, runDate: string, leaseMs: number): Promise<"claimed" | "done" | "leased" | "missing">; completeSection(id: string, name: string, runDate: string, content: string, at: string): Promise<void>; failSection(id: string, name: string, runDate: string, error: ErrorTypeName): Promise<void> }`; `export function memoryStore(): ReportStore`; `export function toView(r: Report): ReportView`; `export function setStore(s: ReportStore): void`; `export function store(): ReportStore`
  - **Call-site edits:** `src/app.ts` `handle` — `await store().getReport(...)` and `toView()` on GET; share calls `await store().setShared(id, true)`
- **Acceptance criteria:** `bun test src/db.test.ts src/app.test.ts`

### Task 2: Firestore adapter, backups and restore check

- **Skill:** `flow-system-design`
- **Description:** Implement `ReportStore` on Firestore (collection `reports`), with `claimSection` / `completeSection` / `failSection` as transactions that only write when the lease and `refreshedFor` match. Select the adapter at start: Firestore when `GOOGLE_CLOUD_PROJECT` or `FIRESTORE_EMULATOR_HOST` is set, memory otherwise. Create the one-time infra script's Firestore section: create the database, enable point-in-time recovery, add a daily backup schedule with 7-day retention, and a restore-check script that restores the latest backup to a scratch database and compares document counts.
- **Inputs:** Task 1 store interface; new: `src/db-firestore.ts`; new: `infra/setup.sh`
- **Outputs:** durable store; backups and a tested restore path
- **Contract:**
  - **Files:** create `src/db-firestore.ts`; create `src/db-firestore.test.ts`; edit `src/db.ts` (adapter selection); edit `package.json` (add `@google-cloud/firestore` dependency); create `infra/setup.sh`; create `infra/restore-check.sh`
  - **Interfaces:** `export function firestoreStore(db?: Firestore): ReportStore`; `infra/setup.sh` runs `gcloud firestore databases create --location=us-central1` (skip if exists), `gcloud firestore databases update --database='(default)' --enable-pitr`, `gcloud firestore backups schedules create --database='(default)' --recurrence=daily --retention=7d`; `infra/restore-check.sh` restores the latest backup to `reports-restore-check` and compares `reports` document counts, exiting non-zero on mismatch
  - **Call-site edits:** `src/db.ts` `store()` — default adapter chosen from env
- **Acceptance criteria:** `bun test src/db-firestore.test.ts && bash -n infra/setup.sh && bash -n infra/restore-check.sh && grep -q -- '--enable-pitr' infra/setup.sh && grep -q 'backups schedules create' infra/setup.sh`

### Task 3: Model client timeout and error classes

- **Skill:** `flow-system-design`
- **Bundled:** the model client's missing timeout and unchecked response status, found during discovery
- **Description:** Give `generateSection` and `suggestTitle` an abort timeout (90 s and 10 s), check `res.ok`, validate that the body carries a string, and throw `LlmError` with a closed `type`: `upstream_timeout`, `rate_limited` (429), `upstream_error` (other non-2xx or malformed body). No retries here.
- **Inputs:** src/llm.ts
- **Outputs:** a model client that always finishes within its timeout and never returns undefined text
- **Contract:**
  - **Files:** edit `src/llm.ts`; create `src/llm.test.ts`
  - **Interfaces:** `export class LlmError extends Error { type: "upstream_timeout" | "rate_limited" | "upstream_error" }`; `export async function generateSection(company: string, section: string, opts?: { timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<string>`; `suggestTitle(sections: string[], opts?: { timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<string>`
  - **Call-site edits:** none (no callers yet)
- **Acceptance criteria:** `bun test src/llm.test.ts`

### Task 4: Metrics helper and metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create the repo-local helper with an in-memory recorder and the typed closed lists: `error.type` values `_OTHER`, `budget_exhausted`, `internal`, `not_found`, `rate_limited`, `upstream_error`, `upstream_timeout`; attributes `operation.outcome`, `error.type`, `server.address`, `refresh.disposition`. Planned metrics: `reports.refresh.section.duration`/`.failures`, `reports.llm.call.duration`/`.failures`, `reports.refresh.tick.duration`/`.failures`/`.units`, `reports.refresh.last_success`, `reports.refresh.budget.used`. Create `.flow/metrics.md` with Backend `none yet — suggested: Google Cloud Monitoring via OTLP`, Namespace `reports`, Attributes, error.type values, Helper, Dashboard panels, Alerts, SLOs, As-code `spec-only`, Coverage. Wrap the model client calls in `instrument`.
- **Inputs:** Task 3 `LlmError`; new: `src/metrics.ts`; new: `.flow/metrics.md`
- **Outputs:** the helper every runtime task records through
- **Contract:**
  - **Files:** create `src/metrics.ts`; create `src/metrics.test.ts`; create `.flow/metrics.md`; edit `src/llm.ts` (wrap calls)
  - **Interfaces:** `export type ErrorTypeName = "_OTHER" | "budget_exhausted" | "internal" | "not_found" | "rate_limited" | "upstream_error" | "upstream_timeout"`; `export function instrument<T>(op: "refresh.section" | "refresh.tick" | "llm.call", fn: () => Promise<T>): Promise<T>`; `export function toErrorType(e: unknown): ErrorTypeName`; `export function countUnits(d: "enqueued" | "already_queued" | "deferred_by_cap", n: number): void`; `export function setGauge(name: "reports.refresh.last_success" | "reports.refresh.budget.used", v: number): void`; `export function memoryRecorder(): Recorder`; `export function setRecorder(r: Recorder): void`
  - **Call-site edits:** `src/llm.ts` `generateSection` and `suggestTitle` — body wrapped in `instrument("llm.call", …)`
- **Acceptance criteria:** `bun test src/metrics.test.ts` (one success observation, one failure per new error type, unlisted error falls to `_OTHER`) `&& grep -q '## error.type values' .flow/metrics.md`

### Task 5: Nightly spend ledger

- **Skill:** `flow-system-design`
- **Description:** One choke point for paid calls: `reserve(runDate)` increments `spend/<runDate>.calls` in a transaction only while below the cap from `REFRESH_DAILY_CALL_CAP` (default 100), and records `reports.refresh.budget.used`. Reservations are never refunded, so retries count against the cap. Memory and Firestore adapters.
- **Inputs:** Task 2 Firestore client; Task 4 helper; new: `src/spend.ts`
- **Outputs:** the cap every model call in the worker passes through
- **Contract:**
  - **Files:** create `src/spend.ts`; create `src/spend.test.ts`
  - **Interfaces:** `export interface SpendLedger { reserve(runDate: string): Promise<{ ok: boolean; used: number; cap: number }>; used(runDate: string): Promise<number> }`; `export function memoryLedger(cap: number): SpendLedger`; `export function firestoreLedger(db: Firestore, cap: number): SpendLedger`; `export function capFromEnv(env?: Record<string, string | undefined>): number`
  - **Call-site edits:** none (consumed by Tasks 6 and 7)
- **Acceptance criteria:** `bun test src/spend.test.ts` (cap 2 → third reserve returns `ok: false`; concurrent reserves never exceed the cap)

### Task 6: Section refresh worker and private routes

- **Skill:** `flow-system-design`
- **Description:** `refreshSection(job)`: `claimSection` (returns 200 without a call when `done`, 503 when `leased`, 200 when `missing`); reserve budget (200 plus `budget_exhausted` when refused); `generateSection` with a 90 s timeout inside a 120 s worker budget; `completeSection` on success; on failure keep the previous text, record the error via `failSection`, answer 503 for `upstream_timeout`, `rate_limited`, `upstream_error`, `internal` and 200 otherwise. Idempotency key `<reportId>:<sectionName>:<runDate>`. The payload carries `version: 1`. Mount `POST /internal/refresh/section` only when `SERVICE_ROLE=worker`; the public service answers 404.
- **Inputs:** Tasks 1, 3, 4, 5; new: `src/refresh.ts`; new: `src/internal.ts`
- **Outputs:** the queue's HTTP target
- **Contract:**
  - **Files:** create `src/refresh.ts`; create `src/refresh.test.ts`; create `src/internal.ts`; edit `src/app.ts` (delegate `/internal/*` to `handleInternal` when `SERVICE_ROLE=worker`)
  - **Interfaces:** `export type SectionJob = { version: 1; reportId: string; sectionName: string; runDate: string }`; `export type RefreshResult = "refreshed" | "already_done" | "in_progress" | "missing" | "budget_exhausted" | "failed_permanent" | "failed_transient"`; `export async function refreshSection(job: SectionJob, deps: { store: ReportStore; ledger: SpendLedger; generate: typeof generateSection; now: () => Date }): Promise<RefreshResult>`; `export function statusFor(r: RefreshResult): 200 | 503`; `export async function handleInternal(req: Request): Promise<Response | null>`
  - **Call-site edits:** `src/app.ts` `handle` — first line `if (process.env.SERVICE_ROLE === "worker") { const r = await handleInternal(req); if (r) return r; }`
- **Acceptance criteria:** `bun test src/refresh.test.ts src/app.test.ts` (asserts the idempotency key `<reportId>:<sectionName>:<runDate>` skips a refreshed section, the 90 s model timeout maps to 503 with previous text kept, and the public role returns 404 on `/internal/refresh/section`)

### Task 7: Nightly tick and queue client

- **Skill:** `flow-system-design`
- **Description:** `enqueueNightlyRefresh()`: compute `runDate` in `REFRESH_TIME_ZONE` (default `America/Chicago`); collect sections whose `refreshedFor` ≠ `runDate`; order shared first, then oldest `refreshedAt` (null first); take (cap − ledger used tonight); create one named Cloud Tasks task each, at most 10 in flight, each create call with a 10 s timeout, task dispatch deadline 150 s, OIDC token for the invoker service account; treat 409 already-exists as `already_queued`. Record units by disposition, tick duration, and `last_success` on success. Mount `POST /internal/refresh/tick` in `handleInternal`. Access token comes from the metadata server via `fetch`, no client library.
- **Inputs:** Tasks 1, 4, 5, 6; new: `src/tick.ts`; new: `src/tasks.ts`
- **Outputs:** the Scheduler's HTTP target
- **Contract:**
  - **Files:** create `src/tick.ts`; create `src/tick.test.ts`; create `src/tasks.ts`; create `src/tasks.test.ts`; edit `src/internal.ts` (tick route)
  - **Interfaces:** `export function runDateFor(now: Date, timeZone: string): string` (YYYY-MM-DD); `export function taskNameFor(job: SectionJob): string` (`r-<first 32 hex of sha256(reportId + "\u0000" + sectionName)>-<YYYYMMDD>`); `export async function enqueueNightlyRefresh(deps: { store: ReportStore; ledger: SpendLedger; enqueue: (job: SectionJob) => Promise<"created" | "exists">; now: () => Date; timeZone: string; cap: number }): Promise<{ enqueued: number; alreadyQueued: number; deferredByCap: number }>`; `export async function createTask(cfg: { queue: string; workerUrl: string; invokerServiceAccount: string; dispatchDeadlineSec: 150 }, job: SectionJob, fetchImpl?: typeof fetch): Promise<"created" | "exists">`
  - **Call-site edits:** `src/internal.ts` `handleInternal` — add `POST /internal/refresh/tick`
- **Acceptance criteria:** `bun test src/tick.test.ts src/tasks.test.ts` (cap ordering and deferral; a second tick for the same night only sees `exists`; the create-task body carries `dispatchDeadline: "150s"` and an `oidcToken`)

### Task 8: Private worker deploy, queue and paused nightly schedule

- **Skill:** `flow-system-design`
- **Description:** Extend the one-time setup script and the deploy script. Setup: service accounts for the scheduler/queue invoker, `roles/run.invoker` on the worker only; Cloud Tasks queue `reports-refresh` with max attempts 3, min backoff 60 s, max backoff 600 s, max doublings 3, max concurrent dispatches 5, max dispatches per second 1 (the dispatch deadline of 150 s is set per task in Task 7); Cloud Scheduler job `reports-nightly-refresh` at `0 3 * * *` in `America/Chicago` with OIDC, attempt deadline 120 s, max retry attempts 2, created then paused. Deploy: a second deploy of the same source as `reports-worker` with `--no-allow-unauthenticated`, `SERVICE_ROLE=worker`, request timeout 180 s, max instances 2, concurrency 5. The public deploy line is unchanged.
- **Inputs:** Tasks 6 and 7 routes; infra/setup.sh from Task 2; deploy.sh
- **Outputs:** a private worker, a rate-capped queue, a paused nightly clock
- **Contract:**
  - **Files:** edit `infra/setup.sh`; edit `deploy.sh`
  - **Interfaces:** `infra/setup.sh` adds `gcloud tasks queues create reports-refresh --location=us-central1 --max-attempts=3 --min-backoff=60s --max-backoff=600s --max-doublings=3 --max-concurrent-dispatches=5 --max-dispatches-per-second=1`, `gcloud scheduler jobs create http reports-nightly-refresh --location=us-central1 --schedule="0 3 * * *" --time-zone="America/Chicago" --http-method=POST --uri="$WORKER_URL/internal/refresh/tick" --oidc-service-account-email="$INVOKER_SA" --attempt-deadline=120s --max-retry-attempts=2` then `gcloud scheduler jobs pause reports-nightly-refresh --location=us-central1`; `deploy.sh` adds `gcloud run deploy reports-worker --source . --region us-central1 --no-allow-unauthenticated --set-env-vars SERVICE_ROLE=worker --timeout=180 --max-instances=2 --concurrency=5`
  - **Call-site edits:** none
- **Acceptance criteria:** `bash -n infra/setup.sh && bash -n deploy.sh && grep -q -- '--no-allow-unauthenticated' deploy.sh && grep -q -- '--max-attempts=3' infra/setup.sh && grep -q 'scheduler jobs pause' infra/setup.sh && grep -q -- '--allow-unauthenticated' deploy.sh`

| Task | Depends on |
| --- | --- |
| 1 | — |
| 2 | 1 |
| 3 | — |
| 4 | 3 |
| 5 | 2, 4 |
| 6 | 1, 3, 4, 5 |
| 7 | 1, 4, 5, 6 |
| 8 | 2, 6, 7 |

### Skills Summary

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-system-design | Yes (Tasks 1, 2, 3, 5, 6, 7, 8) | execution model, timeouts, retries, idempotency, cost cap and recovery for a scheduled paid job |
| flow-metrics | Yes (Task 4) | new job, queue consumer and outbound call need metrics and an alert spec |
| flow-testing | No (tests ride with each task) | each task owns its own `bun test` file |
| flow-ui-ux | No | no UI surface |

# PR description draft

## TLDR

Saved reports now survive restarts and can have their sections regenerated every night under a nightly spend cap; before, reports lived in one server's memory and never changed after creation.

## User-facing changes

- Reports now persist across deploys and restarts:
  - **Before:** a report vanished whenever the server restarted or scaled down.
  - **After:** a report stays until it is deleted.
- Sharing a report no longer risks undoing other changes to it:
  - **Before:** sharing re-saved the whole report it had just read.
  - **After:** sharing only flips the shared flag.
- Each report response now includes `refreshedAt`, the time its oldest section was last regenerated.
- Once the nightly schedule is resumed, every report's sections are regenerated each night at 03:00 US Central, shared reports first, up to 100 regenerations a night by default; a failed regeneration keeps the previous text.

## System changes

- Report storage moved to a durable database:
  - **Before:** reports were held in each instance's memory.
  - **After:** every instance reads and writes one Firestore database with point-in-time recovery and daily backups.
- New private refresh worker, nightly clock and rate-capped queue; the public service exposes no refresh routes.
- New ongoing cost once the schedule is resumed: up to the nightly cap (default 100) paid section calls per night, each 20-60 s, plus small database and queue charges.
- Model calls now time out (90 s for sections) and fail with a named error instead of hanging or storing empty text.

## Why

Readers of a report expect it to reflect what is true now, and today a report is never regenerated. Worse, reports are not actually kept: any restart erases them, so there is nothing to keep current.

## Key decisions

- Durable storage is part of this PR because a nightly refresh of memory-only reports is meaningless.
- Firestore over Cloud SQL: no always-on database bill for a flat document shape.
- Scheduler queues one task per section instead of doing the work itself, so a crash or retry re-runs one section, never the whole night.
- One nightly cap at a single choke point; units over the cap wait for the next night rather than being dropped.
- Refresh routes run only on a separate private service, because the existing service is public.
- The nightly schedule ships paused: it is not yet known whether the model provider returns newer information or just rewords, so the owner resumes it after checking.
- Titles are not regenerated, so a shared report's headline never changes overnight.
- Report creation is out of scope (proposed as a follow-up).
- Bundled: the model client's missing timeout and unchecked response status, found during discovery.

## Instrumentation

- Metrics for section refresh, model calls and the nightly tick (duration, failures by type, units queued or deferred, last successful run, budget used), plus the platform's queue depth.
- Alerts specced: refresh stale over 48 h, cap biting two nights running, section failures over 20 % in a night, queue not draining for 6 h.
- New SLO "report content is current": 95 % of section refreshes succeed over 28 days.
- spec-only: no metrics backend is chosen yet, so these are recorded but will not show on any graph until one is (status in the metrics contract's Backend section).

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/db.test.ts src/app.test.ts` — store, share race and response shape pass.
- [ ] Run `bun test src/llm.test.ts` — timeouts and provider failures surface as named errors.
- [ ] Run `bun test src/metrics.test.ts` — emission and `_OTHER` fallback pass.
- [ ] Run `bun test src/spend.test.ts` — the nightly cap is never exceeded.
- [ ] Run `bun test src/refresh.test.ts` — redelivery skips, failures keep previous text, cap refusal makes no model call.
- [ ] Run `bun test src/tick.test.ts src/tasks.test.ts` — ordering, deferral and same-night dedupe pass.
- [ ] Run `gcloud emulators firestore start --host-port=localhost:8085 &` then `FIRESTORE_EMULATOR_HOST=localhost:8085 bun test src/db-firestore.test.ts` — the durable adapter passes against the emulator.
- [ ] Run `bash -n infra/setup.sh && bash -n infra/restore-check.sh && bash -n deploy.sh` — scripts parse.
- [ ] Run `grep -q -- '--no-allow-unauthenticated' deploy.sh && grep -q -- '--max-attempts=3' infra/setup.sh && grep -q 'scheduler jobs pause' infra/setup.sh` — worker is private, queue retries capped, schedule ships paused.
- [ ] DECISION: you accept a default ceiling of 100 paid section regenerations per night (each 20-60 s, billed per call) until you set your own cap.
