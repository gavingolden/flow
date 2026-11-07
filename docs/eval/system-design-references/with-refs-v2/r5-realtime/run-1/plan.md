# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Live section-by-section report progress

**Goal:** A report page that polls every few seconds shows each section as soon as it is written and knows when the whole report is finished, failed, or partly done.

## Problem Statement

People who start a report want to watch it come together, but today the only way to see new sections is to refresh the page by hand. Even after a refresh they cannot tell whether a blank section is still being written, has failed for good, or will never arrive, because the report never says so. That means repeated manual refreshing, guessing, and no point at which the page knows it can stop checking — the opposite of the brief's top priority of fewer interruptions and fewer things the user has to re-check.

Evidence from this service (the API behind the report page; the page itself is not in this repo):

| Fact | What it means for "watch it live" | Anchor |
| --- | --- | --- |
| The report read already returns every section, with an empty body until it is written | A page could already poll and fill sections in — partial progress is visible today | src/app.ts:11-15, src/db.ts:11-13 |
| The report's status column defaults to `queued` and nothing ever writes it | A poller has no finished state and would poll forever | migrations/001_reports.sql:4, src/worker.ts:5-12 |
| A failed model call leaves the section blank; the queue retries with platform-default attempts | A failed section looks identical to a pending one, indefinitely | src/worker.ts:9-10, deploy.sh:3 |
| A redelivered task re-runs the paid model call and overwrites the section | A section the user already read can change underneath them, and costs money twice | src/worker.ts:9-10, src/db.ts:15-17 |
| Each section takes 20–60 s and arrives whole from the model | "Live" at section granularity means one update every 20–60 s per section, not a token stream | src/llm.ts:1-11 |
| The service serves JSON only; no HTML route exists | The page's polling loop ships where the page is rendered, not here | src/app.ts:7-17 |

## Request vetting

- **Hypothesis:** Polling the existing report read every ~3 s, once that read carries per-section and report-level status, gives users the "watch it being written live, section by section" experience with no push channel.
- **Case against:** A push stream (server-sent events) would show each section the instant it is saved instead of up to ~3 s later; but sections arrive whole every 20–60 s [anchor: src/llm.ts:1], the worker writes from a different request than any viewer's, so a stream handler would itself have to poll the database [anchor: src/worker.ts:10], and on request-billed Cloud Run every open stream keeps a billed request alive for the whole report (https://docs.cloud.google.com/run/docs/configuring/billing-settings) and is cut at the request timeout (https://docs.cloud.google.com/run/docs/triggering/websockets).
- **Sources:** https://docs.cloud.google.com/run/docs/configuring/billing-settings and https://docs.cloud.google.com/run/docs/triggering/websockets (cited by flow-system-design's GCP and real-time references, retrieved 2026-11-03 there; not re-fetched in this pass).
- **Verdict:** adopt-with-conditions: deliver "live" by polling the report read, not a push stream, provided a newly written section appears in the read within one poll and every report reaches a terminal status (complete, partial, or failed) so polling stops.

## Existing-code assessment

- **src/app.ts report read:** keep — the route already returns the report plus ordered sections; extend the body additively with status, progress, and per-section status. [anchor: src/app.ts:10-15]
- **src/db.ts:** keep — small query module; add claim/fail/recompute functions beside the existing ones and widen `listSections`. [anchor: src/db.ts:11-17]
- **src/worker.ts:** rewrite — the 8-line body has no failure, dedupe, or status path, so adding them replaces the body rather than extending it; a prerequisite, bundled as Task 5. [anchor: src/worker.ts:5-12]
- **src/llm.ts generateSection:** simplify — add a timeout and a non-OK check before the worker relies on its failure modes. [anchor: src/llm.ts:6-10]
- **src/queue.ts:** keep — add a dispatch deadline to the task body. [anchor: src/queue.ts:7-14]
- **deploy.sh:** simplify — `create … || true` never applies settings to an existing queue; switch to create-or-update with explicit settings. [anchor: deploy.sh:3]
- **migrations/:** keep — add `002_section_progress.sql` alongside the existing schema. [anchor: migrations/001_reports.sql:8-14]

## Scope Boundary

**In scope:**

- Per-section status (`pending`, `generating`, `done`, `failed`) and position in the report read.
- Report status recomputed after every section change (`queued`, `generating`, `complete`, `partial`, `failed`) plus a done/failed/total count.
- Worker dedupe on report + section, a short lease against concurrent redelivery, and a cap of three paid attempts per section ending in a visible `failed` state.
- A 90 s timeout and non-OK check on the section model call.
- Queue settings (max attempts, backoff, concurrency) applied on every deploy, and a 120 s dispatch deadline on each task.
- An index supporting the polled read; `cache-control: no-store` on the read.
- First metrics contract and helper for the three touched operations.

**Out of scope:**

- The report page's polling loop and rendering (no page lives in this repo — see OQ1).
- Token-by-token streaming within a section (see Alternatives considered).
- Server-sent events or WebSockets (see Decision analysis).
- Authenticating the worker endpoint (candidate follow-up).
- Report creation / enqueueing — no caller of `enqueueSection` exists in this repo.
- `suggestTitle` — unused here and untouched.

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| The user refreshes the page by hand to see whether new sections exist | The page polls every ~3 s and fills each section in as it is written, with no refresh |
| A blank section could be "still writing", "failed", or "never coming" — indistinguishable | Each section shows as waiting, writing, done, or failed |
| The page never learns the report is finished | The report reports complete, partial, or failed, and the page stops polling |
| A section the user already read could change after a re-sent job | A finished section never changes |

### System flow

- **Before:**
  - The worker calls the model with no timeout, writes the body, and returns; report status is never written.
  - A redelivered task regenerates and overwrites an already-written section.
  - A failing section is retried by the queue at platform defaults and stays blank.
- **After:**
  - The worker claims the section (marks it `generating`, counts the attempt), calls the model with a 90 s timeout, writes the body only if still empty, and recomputes the report status.
  - A redelivered task for a finished section returns 200 with no model call; a concurrent duplicate within the lease returns 409 and retries later.
  - The third failed paid attempt marks the section `failed`; a fourth delivery (after a crash) marks it failed without a model call; the queue's max attempts is four.
  - The report read returns status, progress, and per-section status with `cache-control: no-store`.

**Lost:** a re-sent generation task no longer regenerates an already-written section (previously it made a fresh paid call and overwrote the text); anyone relying on re-sending a task to "refresh" a section's text loses that.

## User Stories / Acceptance Criteria

### Story 1: Watch sections appear without refreshing

- [ ] Given a report whose second section was just written, when the report is read, then that section has status `done` with its body and the others keep their status, in `position` order — `bun test src/app.test.ts` and `bun test src/db.test.ts` pass.
- [ ] Given any report read, then the response carries `cache-control: no-store` — `bun test src/app.test.ts` passes.
- [ ] Given a report with 3 sections of which 1 is done, when read, then `progress` is `{ done: 1, failed: 0, total: 3 }` — `bun test src/app.test.ts` passes.

### Story 2: Know when the report is finished

- [ ] Given every section done, when the last section is saved, then the report status is `complete` — `bun test src/db.test.ts` passes.
- [ ] Given every section terminal with at least one failed and one done, then the report status is `partial`; with all failed, `failed` — `bun test src/db.test.ts` passes.
- [ ] Given the first section claim on a `queued` report, then the report status becomes `generating` — `bun test src/db.test.ts` passes.

### Story 3: Failures end, and finished sections never change

- [ ] Given a section already done, when its task is redelivered, then the worker returns 200 and makes no model call — `bun test src/worker.test.ts` passes.
- [ ] Given a model call that fails on attempts 1 and 2, then the worker returns 503 each time; on attempt 3 it marks the section `failed` and returns 200 — `bun test src/worker.test.ts` passes.
- [ ] Given a section claimed `generating` less than 150 s ago, when a duplicate delivery arrives, then the worker returns 409 with no model call — `bun test src/worker.test.ts` passes.
- [ ] Given a model call that does not answer in 90 s, then it fails as `upstream_timeout` — `bun test src/llm.test.ts` passes.

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports.section.generate.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | section worker |
| `reports.section.generate.failures` | Counter | none | `error.type` (`upstream_error`, `upstream_timeout`, `internal`, `_OTHER`) | section worker |
| `reports.llm.request.duration` | Histogram | seconds | `server.address` (`api.example-llm.com`), `operation.outcome` (`ok`, `error`) | model client, section call |
| `reports.llm.request.failures` | Counter | none | `server.address` (`api.example-llm.com`), `error.type` (`upstream_error`, `upstream_timeout`, `_OTHER`) | model client, section call |
| `reports.report.read.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | report read handler |
| `reports.report.read.failures` | Counter | none | `error.type` (`not_found`, `internal`, `_OTHER`) | report read handler |
| Cloud Tasks queue depth | Gauge | `{message}` | queue `sections` | platform-native (Cloud Tasks `queue/depth`) |
| Cloud Run instance count | Gauge | `{instance}` | service `reports-service` | platform-native (Cloud Run) |

Generate and model-call histograms use job-scale bounds `[5, 10, 20, 30, 45, 60, 90, 120]` (8 bounds); the read histogram uses the request-scale advisory bounds (14).

Estimated series: 26 per operation for section generate (2 × 11 + 4)
Estimated series: 25 per operation for the model call (1 host × 2 × 11 + 3)
Estimated series: 37 per operation for the report read (2 × 17 + 3)
All per reporting instance; at a 60 s export interval on Google Cloud Monitoring that is roughly (26 + 25 + 37) × 43,200 ≈ 3.8 million samples, about $0.23 a month per instance (pricing medium confidence per flow-metrics' backends reference).

**Attributes:** new keys `operation.outcome` (`ok`, `error`), `error.type` (`.flow/metrics.md` `## error.type values`), `server.address` (`api.example-llm.com`), added as `.flow/metrics.md` `## Attributes` rows.

### Error types

New list (first contract): `_OTHER` (fallback), `internal` (unexpected failure in this service), `not_found` (no such report — client-caused, excluded from the availability SLO), `upstream_error` (the model API answered non-OK or with no text), `upstream_timeout` (the model API did not answer within 90 s).

### Dashboard panels

On a new "Reports overview" dashboard: section generation success vs failure and failures by `error.type`; section generation p50/p95/p99; model-call p50/p95/p99; report-read rate and p95; Cloud Tasks `sections` queue depth.

### Alerts

| Signal | Condition | Sustained for | Action | Routes to | Dashboard |
| --- | --- | --- | --- | --- | --- |
| Section generation failure ratio | failures / generate count > 10% | 15 min | notify | the owner's notification channel (named in `.flow/metrics.md` `## Alerts`) | Reports overview |
| `sections` queue depth | > 50 tasks | 15 min | notify | the owner's notification channel (named in `.flow/metrics.md` `## Alerts`) | Reports overview |

Plus the standard burn-rate tiers for the SLO below, recorded once in `.flow/metrics.md`.

### SLO

New journey SLO "watch a report fill in": SLI 1 — 99.5% of report reads succeed (non-5xx, `not_found` excluded) over 28 days; SLI 2 — 99% of sections reach `done` rather than `failed` over 28 days.

**As-code:** spec-only — the repo keeps no dashboard or alert config files.

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | DB schema (new migration), persistence (`src/db.ts`), model client (`src/llm.ts`), worker (`src/worker.ts`), queue enqueue + deploy config (`src/queue.ts`, `deploy.sh`), HTTP read (`src/app.ts`), new metrics helper (`src/metrics.ts`) |
| Domain modules | Existing: reports, sections, section worker, model client, queue. New: `src/metrics.ts` (small, single-purpose per AGENTS.md) |
| Data flow | Cloud Tasks delivers one task per section → worker claims the section row → model call → conditional body write → report status recompute; the page polls the report read, which reads the same rows |
| Pattern | Parent status row + one child row per step, the child row being the unit of retry, dedupe, and progress (flow-system-design workflows reference); client polls the durable row (real-time reference) |
| Binary-framing check | Push vs poll is the implicit binary; the middle option (poll now, layer SSE later on the same durable rows) is recorded in Decision analysis |
| Goal anchor | "Knows when finished" in the Goal drives the terminal report statuses and the attempt cap — without them, polling never ends |

**Invariant:** a section is `done` if and only if its body is non-empty. The read and the report recompute derive `done` from the body, so a section written by an old worker revision during rollout still counts as done.

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| Report read (polled) | inline — ~50 ms, bounded by the Cloud Run request timeout | inline | Cloud Run request timeout (default 300 s) | none server-side; the page re-polls | n/a (read-only) | one indexed read per poll; page polls every 3 s and stops on a terminal status |
| Generate section | ~60 s (20–60 s model call) | existing Cloud Tasks `sections` queue; worker invoked synchronously under the attempt deadline | model call 90 s < dispatch deadline 120 s < Cloud Run request timeout 300 s | queue layer only: max attempts 4, min backoff 10 s, max backoff 120 s | report id + section name (claim only while body is empty; 150 s lease on `generating`) | ≤ 3 paid model calls per section (attempt counter on the row); max 10 concurrent dispatches |
| Model call (section) | ~60 s | inline within the worker | 90 s (`AbortSignal.timeout`) | none at this layer | inherits the worker's key | one call per claimed attempt |

**Platform:** gcp

**Proportionality:** no server-sent events or WebSockets (sections arrive whole every 20–60 s, see Decision analysis); no named-task dedupe at enqueue (no enqueue caller exists in this repo, and the consumer dedupes on business identity); no separate per-query database timeout — the read is an indexed single-report query and Bun's built-in client exposes no per-query timeout this plan verified, so the Cloud Run request timeout bounds a hung read (a named departure from the every-call-timeout default); no spend ledger — the per-section attempt cap plus the queue concurrency cap bound spend, and a report-level ledger belongs with report creation, which is not in this repo.

**Recovery:** none — the migration only adds columns, an index, and a one-time status backfill derived from existing bodies; it deletes or rewrites no section text, and section bodies are paid generations regenerable at a known cost (≤ 3 model calls per section).

## Technical Constraints

- Apply `migrations/002_section_progress.sql` before deploying the new code: the new worker and read reference `status`, `attempts`, and `updated_at`. The migration is safe under the old code (all new columns have defaults). [migrations/001_reports.sql, deploy.sh]
- The read's response change must be additive only — existing fields (`id`, `company`, `status`, `created_at`, `sections[].id/name/body`) keep their meaning, so the current page keeps working before it adopts polling. [src/app.ts:14]
- Deadlines shrink inward: model call 90 s < task dispatch deadline 120 s < Cloud Run request timeout (default 300 s); the lease (150 s) is longer than the dispatch deadline so a live attempt is never double-claimed. [flow-system-design GCP reference]
- The queue's max attempts (4) is exactly the paid-attempt cap (3) plus one, so a worker killed mid-call still reaches `failed` on the final delivery without another paid call. [src/worker.ts, deploy.sh]
- No new runtime dependencies: the metrics helper is an in-memory recorder until a backend is chosen. [AGENTS.md]
- Cost: polling adds ~20 small reads per minute per open report tab while generating; deduped redelivery removes duplicate paid model calls.

## Open Questions

- [ ] OQ1 — Does the report page live outside this repo, so this PR ships only the server contract? Redirect changes: a page/client task would be added.
  - **Stakes:** user — if the page is not updated to poll, users still refresh by hand after this merges (UX, priority 1).
  - **Recommended:** ship the server contract here and land the page's 3 s poll loop in the app that renders the page — this service has only JSON routes and no HTML surface. [confidence: high] [anchor: src/app.ts:7-17]
- [ ] OQ2 — Section-level updates rather than word-by-word streaming? Redirect changes: token streaming would need a streaming model API, chunk storage, and a push channel — a different plan.
  - **Stakes:** user — if users expected text to type out live, section-level updates feel jumpier (UX, priority 1).
  - **Recommended:** section-level, as asked. [confidence: high] [anchor: user: "section by section"]
- [ ] OQ3 — Poll every 3 s instead of a push stream? Redirect changes: an SSE endpoint, its own database polling loop, and reconnect handling would be added.
  - **Stakes:** both — UX (up to ~3 s extra delay per section, priority 1) vs cost (an always-open billed request per watching tab, priority 2).
  - **Recommended:** poll every 3 s — the existing read already returns the rows a stream would carry, and a stream saves ≤ 3 s on a 20–60 s section. [confidence: medium] [anchor: weighing: footprint — reuses the existing read; a stream adds a long-lived handler that still polls the database]
- [ ] OQ4 — Cap paid attempts per section at 3 before marking it failed? Redirect changes: the cap constant and the queue's max attempts (cap + 1).
  - **Stakes:** both — too low shows users failed sections that a retry would have fixed (UX); too high multiplies paid 20–60 s calls on a broken prompt (cost).
  - **Recommended:** 3 paid attempts, queue max attempts 4. [confidence: medium] [anchor: weighing: risk — each attempt is a paid 20–60 s model call (src/llm.ts:1), and transient failures rarely survive two backoffs]
- [ ] OQ5 — Call a report with some done and some failed sections `partial` (not `failed`)? Redirect changes: the report-status recompute and the page's terminal-state copy.
  - **Stakes:** user — calling a mostly-written report "failed" hides the sections that succeeded (fewer surprises, priority 1).
  - **Recommended:** `partial` when all sections are terminal with ≥ 1 done and ≥ 1 failed; `failed` only when all failed. [confidence: medium] [anchor: weighing: symmetry — mirrors the per-section done/failed split]
- [ ] OQ6 — Store and recompute `reports.status` rather than derive it only at read time? Redirect changes: the worker's recompute call and Task 2's recompute function.
  - **Stakes:** system — a derived-only status would leave the column `queued` forever for every other reader of the table.
  - **Recommended:** store and recompute after every section transition, using the existing column. [confidence: high] [anchor: migrations/001_reports.sql:4]
- [x] Mark the report read `cache-control: no-store`? — yes; a cached poll would hide progress and nothing caches this read today.
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision D1 — How does the page learn a section was written: poll the read, a server-sent-events stream, or a WebSocket?**

| Branch | End-user walkthrough | System flow | Friction | Cost |
| --- | --- | --- | --- | --- |
| A. Poll the report read every 3 s | The user opens the report; empty sections show "writing…"; each finished section appears within ~3 s of being saved; the page stops polling at complete/partial/failed. The user types nothing and waits only for generation. | Page → existing read (indexed) every 3 s; worker writes rows | 0 interruptions — fully automated | ~20 small reads/min per open tab while generating; no open connections |
| B. SSE stream (`/reports/{id}/events`) with poll fallback | Same as A, but sections appear ~instantly after save; after a dropped connection or the request timeout the page reconnects with `Last-Event-ID` | New long-lived handler per tab; because the worker writes in another request, the handler polls the database itself (or needs LISTEN/NOTIFY, unverified for Bun's client) | 0 interruptions | one billed Cloud Run request open per watching tab for the whole report, plus the same database polling server-side |
| C. WebSocket | Same as B | New two-way channel nobody sends on; same database polling | 0 interruptions | as B, plus a channel type the platform cuts at the request timeout |

- **Exclusivity:** A and B are complementary (B layers on A's durable rows; A is B's fallback). C is mutually exclusive with B (two push channels for one stream) and over-built for one-way updates.
- **Ranked combinations:** 1) A alone; 2) A now, B later if users report the ~3 s lag; 3) A + B now; 4) C.
- Verdict: **A alone** — on 20–60 s sections, B's only gain is ≤ 3 s per section while it adds an always-open billed request per tab (cost, priority 2) for an experience difference users are unlikely to notice (UX, priority 1); B stays available later without changing A. [confidence: medium] [anchor: weighing: footprint — A reuses src/app.ts's read; B adds a new long-lived handler that still polls the database]

## Alternatives considered

- **Token-by-token streaming within a section** — rejected: the user asked for "section by section", and the model client returns a whole section in one response (src/llm.ts:2-11).
- **Derive report status only at read time** — rejected: `reports.status` already exists with default `queued` (migrations/001_reports.sql:4), and leaving it unwritten keeps it `queued` for every other reader.

## Recommendation

**Reconsider scope** — build the server half as a polling contract (status, progress, per-section state, bounded failures) rather than a push stream, and leave the page's poll loop to the app that renders the page (OQ1, OQ3, D1); rewrite the worker body (Task 5) and simplify the model call and deploy queue step (Tasks 3, 6). [confidence: medium] [anchor: weighing: footprint — reuses the existing read in src/app.ts instead of a new streaming surface]

**Redundancy:** the report read (src/app.ts:10-15) already exposes partial progress (empty bodies until written), which is why the plan extends it rather than adding a new endpoint; it lacks any terminal or failed state, so it does not already serve the request.

## Plan risks

The user-visible "no more refreshing" lands only when the report page — which is not in this repo — is changed to poll the new fields; if no one owns that change, this PR improves correctness and cost but changes nothing a user sees.

## Cut list

- The 150 s lease on `generating` sections (and the 409 path) guards only a concurrent duplicate delivery of the same task; cut it if review judges that too rare, since the body-empty conditional write already prevents a double write (but not a double paid call).
- `partial` as a separate report status could collapse into `failed` with the per-section states carrying the detail, removing one terminal value the page must handle.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Authenticate the section-worker endpoint | High | Medium | needs its own design/decision session: the open decision is whether to split the worker into its own non-public Cloud Run service invoked by the queue's service account, or verify the queue's OIDC token inside the handler on the public service — anyone can currently trigger paid generation | same worker this plan edits, but a security boundary change, not progress reporting | No |

- [x] Authenticate the section-worker endpoint — the worker route is served on a publicly reachable service, so anyone can trigger paid model calls and bypass the queue's rate and attempt caps.
  - **UX:** none
  - **Problem:** `POST /tasks/generate-section` is routed on the same service deployed with `--allow-unauthenticated`, with no caller check [anchor: src/app.ts:9]
  - **Stability/efficiency:** an unauthenticated caller can force paid 20–60 s model calls on any pending section, outside the queue's concurrency cap [anchor: deploy.sh:4]
  - **Value rank:** 5 — security exposure: unauthenticated callers can spend money on the paid model API [anchor: deploy.sh:4]
  - **Complexity:** Medium — deploy split or token verification, plus queue OIDC config; touches deploy.sh, src/app.ts, src/queue.ts
  - **Risk:** Medium — a wrong audience or service-account setting stops all section generation
  - **If never done:** the public worker route stays an open path to paid spend and to writing sections out of band
  - **Verdict:** clears bar — an open path to paid spend outweighs a Medium change, but the split-vs-verify choice deserves its own session

# Task breakdown

### Task 1: Section progress migration

- **Skill:** `flow-system-design`
- **Bundled:** the `sections (report_id, position)` index, surfaced because polling multiplies reads of that table and no index on `report_id` exists.
- **Description:** Add per-section lifecycle columns, backfill status from existing bodies, constrain report and section status values, and index the polled read.
- **Inputs:** migrations/001_reports.sql
- **Outputs:** migrations/002_section_progress.sql
- **Contract:**
  - **Files:** create `migrations/002_section_progress.sql`
  - **Interfaces (Schema):**
    ```sql
    alter table sections
      add column status text not null default 'pending'
        check (status in ('pending','generating','done','failed')),
      add column attempts int not null default 0,
      add column updated_at timestamptz not null default now();
    update sections set status = 'done' where body is not null;
    alter table reports
      add constraint reports_status_check
        check (status in ('queued','generating','complete','partial','failed'));
    create index sections_report_id_position_idx on sections (report_id, position);
    ```
  - **Call-site edits:** none
- **Acceptance criteria:** `grep -q "sections_report_id_position_idx" migrations/002_section_progress.sql && grep -q "add column attempts" migrations/002_section_progress.sql`

### Task 2: Section lifecycle queries

- **Skill:** `flow-system-design`
- **Description:** Widen `listSections` and add claim / save-if-empty / fail / recompute functions implementing the invariant "done iff body is non-empty".
- **Inputs:** Task 1; src/db.ts
- **Outputs:** updated src/db.ts
- **Contract:**
  - **Files:** edit `src/db.ts`
  - **Interfaces:**
    - `export type SectionStatus = "pending" | "generating" | "done" | "failed"`
    - `export type ReportStatus = "queued" | "generating" | "complete" | "partial" | "failed"`
    - `export type SectionView = { id: string; name: string; position: number; status: SectionStatus; body: string | null }`
    - `export const SECTION_LEASE_SECONDS = 150`
    - `listSections(reportId: string): Promise<SectionView[]>` — status reported as `done` when body is non-null, ordered by position
    - `claimSection(reportId: string, name: string): Promise<{ claimed: true; attempts: number } | { claimed: false; reason: "done" | "leased" | "missing" }>` — one `update … set status='generating', attempts=attempts+1, updated_at=now() where … and body is null and (status <> 'generating' or updated_at < now() - lease) returning attempts`; on no row, a follow-up select names the reason
    - `saveSection(reportId: string, name: string, body: string): Promise<boolean>` — sets body and `status='done'` only `where body is null`; returns whether it wrote
    - `failSection(reportId: string, name: string): Promise<void>` — `status='failed'` where body is null
    - `refreshReportStatus(reportId: string): Promise<ReportStatus>` — one `update reports set status = <case over sections> where id = … returning status`
  - **Call-site edits:** `src/app.ts` `handle` keeps calling `listSections` (shape widened, additive); `src/worker.ts` consumes the new functions in Task 5
- **Acceptance criteria:** `grep -q "export async function claimSection" src/db.ts && grep -q "export async function refreshReportStatus" src/db.ts`

### Task 3: Bounded section model call

- **Skill:** `flow-system-design`
- **Description:** Give `generateSection` a 90 s timeout and typed failures so the worker can tell transient from terminal outcomes; leave `suggestTitle` untouched.
- **Inputs:** src/llm.ts
- **Outputs:** updated src/llm.ts
- **Contract:**
  - **Files:** edit `src/llm.ts`
  - **Interfaces:**
    - `export class LlmError extends Error { constructor(readonly kind: "upstream_error" | "upstream_timeout", message: string) }`
    - `export const SECTION_TIMEOUT_MS = 90_000`
    - `generateSection(company: string, section: string, opts?: { timeoutMs?: number }): Promise<string>` — `fetch(…, { signal: AbortSignal.timeout(opts?.timeoutMs ?? SECTION_TIMEOUT_MS) })`; abort → `LlmError("upstream_timeout")`; non-OK status or missing `text` → `LlmError("upstream_error")`
  - **Call-site edits:** `src/worker.ts` `handleGenerateSection` (Task 5) catches `LlmError`
- **Acceptance criteria:** `grep -q "AbortSignal.timeout" src/llm.ts && grep -q "export class LlmError" src/llm.ts`

### Task 4: Metrics helper and contract

- **Skill:** `flow-metrics`
- **Description:** Create the repo-local metrics helper (in-memory recorder, closed `ErrorType` union mirroring `.flow/metrics.md`) and the first `.flow/metrics.md`, covering `reports.section.generate`, `reports.llm.request`, and `reports.report.read` with error types `_OTHER`, `internal`, `not_found`, `upstream_error`, `upstream_timeout`; backend `none yet — suggested: Google Cloud Monitoring (OTLP route)`.
- **Inputs:** new: src/metrics.ts; new: .flow/metrics.md
- **Outputs:** src/metrics.ts, .flow/metrics.md
- **Contract:**
  - **Files:** create `src/metrics.ts`, create `.flow/metrics.md`
  - **Interfaces:**
    - `export type ErrorType = "_OTHER" | "internal" | "not_found" | "upstream_error" | "upstream_timeout"`
    - `export type Operation = "reports.section.generate" | "reports.llm.request" | "reports.report.read"`
    - `export interface Recorder { observe(name: string, seconds: number, attrs: Record<string, string>): void; increment(name: string, attrs: Record<string, string>): void }`
    - `export function memoryRecorder(): Recorder & { observations: unknown[]; increments: unknown[] }`
    - `export function setRecorder(r: Recorder): void`
    - `export async function instrument<T>(op: Operation, fn: () => Promise<T>, opts?: { classify?: (e: unknown) => ErrorType; attrs?: { "server.address"?: "api.example-llm.com" } }): Promise<T>` — records `<op>.duration` with `operation.outcome`, and on throw `<op>.failures` with `error.type` (unmapped → `_OTHER`), then rethrows
  - **Call-site edits:** used by `src/worker.ts` (Task 5), `src/llm.ts` `generateSection` (Task 5 wraps the call), `src/app.ts` report read (Task 7)
- **Acceptance criteria:** `test -f .flow/metrics.md && grep -q "## error.type values" .flow/metrics.md && bun -e "import('./src/metrics.ts').then(m => process.exit(typeof m.instrument === 'function' ? 0 : 1))"`

### Task 5: Idempotent, bounded section worker

- **Skill:** `flow-system-design`
- **Description:** Rewrite `handleGenerateSection`: missing report → 200 `gone`; claim the section (idempotency key: report id + section name); not claimed because done → 200; leased → 409; `attempts > MAX_PAID_ATTEMPTS` → fail + recompute + 200 with no model call; otherwise recompute (marks report `generating`), call the model (90 s timeout) inside `instrument("reports.section.generate")` and `instrument("reports.llm.request", …, { attrs: { "server.address": "api.example-llm.com" } })`, save-if-empty, recompute, 200; on failure, `attempts >= MAX_PAID_ATTEMPTS` → fail + recompute + 200, else 503 so the queue retries.
- **Inputs:** Tasks 2, 3, 4; src/worker.ts
- **Outputs:** updated src/worker.ts
- **Contract:**
  - **Files:** edit `src/worker.ts`
  - **Interfaces:**
    - `export const MAX_PAID_ATTEMPTS = 3`
    - `handleGenerateSection(req: Request): Promise<Response>` — status codes: 200 (done, gone, deduped, terminally failed), 409 (leased duplicate), 503 (retryable failure)
  - **Call-site edits:** none (`src/app.ts` already routes `POST /tasks/generate-section` to it)
- **Acceptance criteria:** `grep -q "MAX_PAID_ATTEMPTS = 3" src/worker.ts && grep -q "claimSection" src/worker.ts && grep -q "status: 503" src/worker.ts` — idempotency key (report id + section name) and the 90 s timeout are asserted by Task 8's `bun test src/worker.test.ts`.

### Task 6: Queue settings and dispatch deadline

- **Skill:** `flow-system-design`
- **Description:** Apply the queue's must-set settings on every deploy and set a dispatch deadline on each task.
- **Inputs:** deploy.sh; src/queue.ts; Task 5 (cap value)
- **Outputs:** updated deploy.sh, src/queue.ts
- **Contract:**
  - **Files:** edit `deploy.sh`, edit `src/queue.ts`
  - **Config (deploy.sh line 3):**
    - before: `gcloud tasks queues create sections --location us-central1 || true`
    - after: `Q_FLAGS="--location us-central1 --max-attempts=4 --min-backoff=10s --max-backoff=120s --max-concurrent-dispatches=10"` then `gcloud tasks queues create sections $Q_FLAGS || gcloud tasks queues update sections $Q_FLAGS`
  - **Config (src/queue.ts task body):** before: `task: { httpRequest: {…} }`; after: `task: { dispatchDeadline: "120s", httpRequest: {…} }`
  - **Call-site edits:** none
- **Acceptance criteria:** `grep -q -- "--max-attempts=4" deploy.sh && grep -q "queues update sections" deploy.sh && grep -q 'dispatchDeadline: "120s"' src/queue.ts && bash -n deploy.sh`

### Task 7: Progress-aware report read

- **Skill:** `flow-system-design`
- **Description:** Extend the report read additively with `progress` and per-section `status`/`position`, mark it `cache-control: no-store`, and instrument it as `reports.report.read` (404 → `not_found`).
- **Inputs:** Tasks 2, 4; src/app.ts
- **Outputs:** updated src/app.ts
- **Contract:**
  - **Files:** edit `src/app.ts`
  - **Interfaces:**
    - Response body: `{ id, company, status: ReportStatus, created_at, progress: { done: number; failed: number; total: number }, sections: SectionView[] }`
    - `json(body: unknown, status = 200, headers: Record<string, string> = {})` — merges extra headers; the read passes `{ "cache-control": "no-store" }`
  - **Call-site edits:** `src/app.ts` `handle` GET branch builds `progress` from `listSections`
- **Acceptance criteria:** `grep -q "no-store" src/app.ts && grep -q "progress" src/app.ts`

### Task 8: Unit tests for worker, read, model call, and metrics

- **Skill:** `flow-testing`
- **Description:** Bun tests with `mock.module` stubs for `./db` and `./llm` (worker, app) and a stubbed `fetch` (llm), plus emission tests against the in-memory recorder.
- **Inputs:** Tasks 3, 4, 5, 7
- **Outputs:** test files
- **Contract:**
  - **Files:** create `src/worker.test.ts`, `src/app.test.ts`, `src/llm.test.ts`, `src/metrics.test.ts`
  - **Interfaces:** cases — worker: done → 200 no model call; leased → 409 no model call; attempts 1–2 failing → 503; attempt 3 failing → `failSection` + 200; attempt 4 → fail with no model call; success → `saveSection` + `refreshReportStatus`. App: body shape, order, progress counts, `cache-control: no-store`, 404. LLM: abort → `upstream_timeout` (use `timeoutMs: 10`), non-OK → `upstream_error`. Metrics: one success observation with `operation.outcome=ok`, one failure per new `error.type`, unlisted → `_OTHER`.
  - **Call-site edits:** none
- **Acceptance criteria:** `bun test src/worker.test.ts src/app.test.ts src/llm.test.ts src/metrics.test.ts`

### Task 9: Database integration test for lifecycle queries

- **Skill:** `flow-testing`
- **Description:** Integration test against a real Postgres (skipped when `DATABASE_URL` is unset) covering claim, lease expiry, save dedupe, fail, and report status recompute to `generating`, `complete`, `partial`, `failed`, plus the "done iff body" invariant in `listSections`.
- **Inputs:** Tasks 1, 2
- **Outputs:** src/db.test.ts
- **Contract:**
  - **Files:** create `src/db.test.ts`
  - **Interfaces:** `describe.skipIf(!process.env.DATABASE_URL)`; seeds one report with three sections per case and truncates after
  - **Call-site edits:** none
- **Acceptance criteria:** `docker run -d --rm --name reports-pg -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16 && sleep 3 && for f in migrations/*.sql; do psql postgres://postgres:pg@localhost:55432/postgres -v ON_ERROR_STOP=1 -f "$f"; done && DATABASE_URL=postgres://postgres:pg@localhost:55432/postgres bun test src/db.test.ts`

| Task | Depends on |
| --- | --- |
| 1 | — |
| 2 | 1 |
| 3 | — |
| 4 | — |
| 5 | 2, 3, 4 |
| 6 | 5 |
| 7 | 2, 4 |
| 8 | 3, 4, 5, 7 |
| 9 | 1, 2 |

**Skills Summary**

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-system-design | Yes (Tasks 1, 2, 3, 5, 6, 7) | Queue consumer, outbound paid call, timeouts, idempotency, polled status resource |
| flow-metrics | Yes (Task 4) | First instrumented change creates `.flow/metrics.md` and the helper |
| flow-testing | Yes (Tasks 8, 9) | Unit and database integration tests |
| flow-ui-ux | No | No UI in this repo; the page's polling loop is out of scope (OQ1) |
| flow-new-feature | No | Drives implementation downstream; not a per-task skill |

# PR description draft

## TLDR

A report page polling every few seconds can now show each section as it finishes and know when the report is done; before, the report never said which sections were pending, failed, or finished.

## User-facing changes

- Reading a report now tells a page how far along it is:
  - **Before:** the report came back with sections that were either written or empty, and an overall status that always said "queued", so a page could not tell "still writing" from "stuck" or "finished".
  - **After:** the report comes back with an overall status (queued, generating, complete, partial, failed), a done/failed/total count, and a per-section status in display order, so a page polling every 3 seconds can fill sections in as they land and stop polling when the report is finished.
- A section that keeps failing now shows as failed after three paid attempts instead of staying blank forever, and the rest of the report still shows.
- A section you have already seen appear no longer changes underneath you:
  - **Before:** a re-sent generation job rewrote an already-written section with a new paid model call.
  - **After:** a re-sent job for a finished section is a no-op and costs nothing.
- Report reads are marked not-cacheable, so a poll never gets a stale copy from a cache in between.

## System changes

- Section generation now tracks a lifecycle per section and a derived status per report:
  - **Before:** the worker made one model call with no timeout and wrote the result; report status was never updated, and a failed call was retried by the queue with no cap the app knew about.
  - **After:** each section moves pending → generating → done or failed, the report status is recomputed after every section change, the model call has a 90 s timeout, and paid attempts per section are capped at three (the queue's max attempts is four, so even a crashed worker ends in a visible failed state).
- Redelivered or concurrent generation jobs are deduplicated on report + section name, so the queue's at-least-once delivery can no longer double-charge a section.
- The section queue is now configured on every deploy (max attempts, backoff, concurrency cap of 10) and each job carries a 120 s dispatch deadline; before, the queue was only created once with platform defaults and later settings were never applied.
- Cost: polling adds about one small database read per open report tab every 3 seconds while a report is generating (about 60 reads for a three-minute report); it removes the duplicate paid model calls that redelivery used to cause.
- Polling the report read is backed by a new index on sections by report and position, so read cost stays flat as the sections table grows.

## Why

People generating a report want to watch it come together, but today they have to keep refreshing the page and still cannot tell whether a blank section is being written, has failed, or will never arrive. Because the report never reaches a finished state, nothing can tell a page when to stop checking either.

## Key decisions

- Polling, not a push stream: sections take 20–60 seconds each and arrive whole, so a server-sent-events or WebSocket channel would save at most about 3 seconds per section while holding a billed server request open for every watching tab for the whole report. The report read stays the source of truth; a push channel can be layered on later without changing it.
- Section-level, not word-by-word: the request asked for "section by section", and the model client returns a whole section at once.
- The page's own polling loop is out of scope: this service has no HTML page, so the loop ships in whichever app renders the report page.
- Report status is stored and recomputed after every section change rather than derived only on read, because the column already exists and other readers see it.
- A report with some failed and some finished sections is "partial", so the user still sees what succeeded.
- Bundled: worker idempotency and the paid-attempt cap, surfaced because a live viewer would otherwise watch sections change or never finish.
- Bundled: a 90 s timeout and error check on the model call, since a hung or failed call would otherwise leave a section "generating" with no end.
- Bundled: queue retry and concurrency settings applied on every deploy, because the existing deploy step never updates an existing queue.
- Bundled: an index on sections by report, because polling multiplies reads of that table.
- Not in this PR: the worker endpoint is publicly reachable on the same service, which lets anyone trigger paid generation; tracked as a follow-up because it needs its own decision on how to authenticate the queue.

## Instrumentation

This PR creates the service's metrics contract. Three operations are instrumented: generating a section (duration split by outcome, failures by type), the outbound model call (duration by outcome, failures by type), and the report read that pages poll (duration by outcome, failures by type). Queue depth and instance count use the platform's own metrics. Dashboard panels: generation success vs failure, generation latency p50/p95/p99, model-call latency, report-read rate and latency, and queue depth, on a new "Reports overview" dashboard — spec-only, no URL yet. Alerts: section failure ratio above 10% for 15 minutes, and queue depth above 50 for 15 minutes, both notify. New journey SLO "watch a report fill in": 99.5% of report reads succeed and 99% of sections finish rather than fail, over 28 days. These metrics are recorded but will not show on any graph until a metrics backend is chosen; the suggested backend is Google Cloud Monitoring, and its status lives in the metrics contract's Backend section.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/worker.test.ts` — all specs pass (finished section is a no-op with no model call; third failed attempt marks the section failed and returns 200; earlier failures return 503; a leased in-flight section returns 409 with no model call).
- [ ] Run `bun test src/app.test.ts` — all specs pass (report read returns status, progress counts, per-section status and position in order, and a `cache-control: no-store` header; unknown report returns 404).
- [ ] Run `bun test src/llm.test.ts` — all specs pass (a hung model call fails as a timeout; a non-OK response fails as an upstream error).
- [ ] Run `bun test src/metrics.test.ts` — all specs pass (one success observation, one failure increment per error type, an unlisted error falls to `_OTHER`).
- [ ] Start a throwaway Postgres with `docker run -d --rm --name reports-pg -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16`.
- [ ] Apply both migrations with `for f in migrations/*.sql; do psql postgres://postgres:pg@localhost:55432/postgres -v ON_ERROR_STOP=1 -f "$f"; done` — exits 0.
- [ ] Run `DATABASE_URL=postgres://postgres:pg@localhost:55432/postgres bun test src/db.test.ts` — all specs pass (claim, lease, save dedupe, fail, and report status recompute to complete, partial, and failed).
- [ ] Run `grep -Eq -- '--max-attempts=4' deploy.sh && grep -q 'queues update sections' deploy.sh && grep -q 'dispatchDeadline' src/queue.ts` — exits 0.
- [ ] DECISION: you accept that a finished section can take up to one poll interval (about 3 seconds) to appear, in exchange for no always-open server connection per watching tab.
