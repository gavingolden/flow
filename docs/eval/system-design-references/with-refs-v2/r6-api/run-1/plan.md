# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Partner Reports API

**Goal:** Partner companies create reports and page through their own report history over a key-authenticated API, with no access to other partners' data and a ceiling on paid generation.

## Problem Statement

This service writes company reports section by section using a paid AI model, where each section takes 20 to 60 seconds and costs money. Right now an outside partner cannot ask for a report or see the ones they asked for. Nothing in the service creates a report, and the only way to read one gives any report to anyone who knows its id. So partners rely on someone inside to start reports and pass results back, and opening the service as it stands would let anyone read reports or run up model spend.

| Observation | Evidence |
| --- | --- |
| No HTTP route creates a report, and the section enqueue function is never called | [anchor: src/app.ts:7-17], [anchor: src/queue.ts:4] |
| The one read route returns any report by id with no credential | [anchor: src/app.ts:10-15] |
| The service is deployed open to the internet, including the paid section-generation worker route | [anchor: deploy.sh:4], [anchor: src/app.ts:9] |
| A report's status starts as `queued` and nothing ever changes it, so a "past reports" list would show every report as queued | [anchor: migrations/001_reports.sql:4], [anchor: src/worker.ts:10] |
| The enqueue call sends no Google credential, no task name and no worker auth token, so it has never worked as written | [anchor: src/queue.ts:5-15] |
| Each model call has no timeout and no failure check | [anchor: src/llm.ts:6-10] |

Who is affected, against the product brief's ranked priorities: **user experience** (partners get self-service requests and history, so no round-trip through staff), and **cost** (every report is a fixed number of paid model calls, so a public entry point must cap spend per partner).

## Request vetting

- **Hypothesis:** A per-partner API key checked on every new partner route, plus an owning-partner column on each report, is enough to keep one partner out of another's reports and inside its spend cap.
- **Case against:** On day one the key gate could be bypassed. The service is deployed `--allow-unauthenticated` [anchor: deploy.sh:4] and serves the paid worker route to any caller [anchor: src/app.ts:9], so anyone can trigger model calls without a key. Any report can also be read by id with no credential [anchor: src/app.ts:10]. A key on the new routes alone protects neither the spend cap nor partner data.
- **Sources:** no outside source: the Step 1.5 research pre-check judged this not researchable; the case rests on the committed deploy script and route table.
- **Verdict:** adopt-with-conditions: the section worker accepts only Cloud Tasks-authenticated calls, and partner-owned reports return 404 on every route unless the owning partner's key is presented — both asserted by tests in this PR.

## Existing-code assessment

- **src/app.ts (router):** keep — the single dispatch function stays; partner routes move to a new module and the router gains a service-role switch so the public service stops serving the worker route [anchor: src/app.ts:7-17]
- **src/app.ts legacy `GET /reports/:id`:** simplify — add a partner-ownership check so partner reports 404 here, leaving internal reports byte-identical [anchor: src/app.ts:10-15]
- **src/db.ts:** keep — extend with the partner, key and report queries; replace `saveSection` with a transactional `completeSection` that also updates the parent report's status [anchor: src/db.ts:15-17]
- **src/queue.ts:** rewrite — it sends no Google access token, no task name for dedupe, no OIDC token for the worker and never checks the response; it has never been called, so the rewrite is a prerequisite for creating reports at all [anchor: src/queue.ts:5-15]
- **src/worker.ts:** simplify — add a skip for already-done sections, a visible failed state on the final attempt and a versioned payload [anchor: src/worker.ts:5-12]
- **src/llm.ts `generateSection`:** simplify — add an explicit timeout and a non-2xx check so a failed call retries instead of saving `undefined` as a section body [anchor: src/llm.ts:6-10]
- **deploy.sh:** simplify — split into a public API service and a private worker service, and apply queue retry and rate settings on every deploy (today `create || true` never updates an existing queue) [anchor: deploy.sh:3-4]
- **migrations/001_reports.sql:** keep — the new migration only adds tables and columns, so the old code keeps working [anchor: migrations/001_reports.sql:1-14]

## Scope Boundary

**In scope:**

- Partner and API-key storage, with several keys per partner so a key can be rotated without losing report history.
- `POST /v1/reports`: create a report for a subject company. Requires an `Idempotency-Key`, is capped per partner per day, returns `202` and a `Location`.
- `GET /v1/reports`: the calling partner's reports, newest first, cursor-paginated.
- `GET /v1/reports/{id}`: one of the calling partner's reports with its sections; another partner's report returns 404.
- Status that moves through `queued` → `running` → `done` / `failed`, with a visible failed state once retries run out.
- The worker moves to a private Cloud Run service that only the queue's service account can invoke.
- An operator script to create partners and issue or revoke keys. A key is shown once.
- A partner-facing API reference and an operator runbook.
- Metrics helper and `.flow/metrics.md` (first instrumented change).

**Out of scope:**

- Partner self-service key management or a portal.
- Completion webhooks (partners poll).
- Partner-chosen section lists.
- Locking down the legacy anonymous route for internal reports (candidate follow-up).
- Billing or invoicing partners.

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| A partner cannot request a report; someone inside has to start it | A partner sends one authenticated request naming the subject company and gets back a report id and a link to check on it |
| A partner cannot see which reports they have requested | A partner lists their own reports, newest first, a page at a time |
| Anyone who has a report id can read the report without credentials | A partner's reports open only with that partner's key; other callers get "not found" |
| A report's status says "queued" forever | Status moves from queued to running to done, or to failed once retries run out |
| A retried request (a network blip, say) would be a second paid report | Repeating a request with the same idempotency key returns the original report and costs nothing extra |
| No limit on how many reports a caller can start | Each partner has a daily report limit; requests past it are refused with a retry-after time |

### System flow

- **Before:**
  - One public Cloud Run service serves both the read route and the paid worker route to any caller.
  - No code path creates a report or enqueues its sections.
  - Section tasks would carry no auth and no name. Model calls have no timeout. Report status is never updated.
- **After:**
  - The public API service serves `/v1` partner routes behind a hashed-key lookup, plus the legacy read route for internal reports only.
  - A private worker service runs section generation. Only Cloud Tasks, presenting an OIDC token for the invoker service account, can reach it.
  - Creating a report inserts the report and section rows in one transaction, under a per-partner row lock that enforces the daily cap. After commit it enqueues one named task per section.
  - The worker skips sections that are already done. The model call times out at 120 s. The worker updates the section and its parent report status in one transaction, and marks the section failed on the final attempt.

**Lost:**

- The public service stops serving `/tasks/generate-section`. Any caller outside this repo that posts there directly gets 404 and has to go through the queue to the private worker.
- The legacy anonymous read route stops returning partner-owned reports. It never returned them before, because none existed.

## User Stories / Acceptance Criteria

### Story 1: Request a report

- [ ] Given a valid key and a new `Idempotency-Key`, when the partner POSTs `{"company": "Acme Corp"}` to `/v1/reports`, then the response is `202` with `{id, status: "queued"}` and a `Location: /v1/reports/{id}` header, and one task is enqueued per default section — `bun test src/partner-api.test.ts`
- [ ] Given the same key and `Idempotency-Key` with the same body, when the partner repeats the POST, then the same report id comes back, no new report row exists, and only still-pending sections are re-enqueued — `bun test src/partner-api.test.ts`
- [ ] Given the same `Idempotency-Key` with a different `company`, when the partner POSTs, then the response is `422` `{error: "idempotency_mismatch"}` — `bun test src/partner-api.test.ts`
- [ ] Given a missing, unknown or revoked key, when any `/v1` route is called, then the response is `401` with `WWW-Authenticate: Bearer` and no DB write — `bun test src/partner-api.test.ts src/auth.test.ts`
- [ ] Given the partner already created `daily_report_limit` reports in the last 24 h, when it POSTs, then the response is `429` with a `Retry-After` header and nothing is enqueued — `bun test src/partner-api.test.ts`

### Story 2: List past reports

- [ ] Given partner A and partner B each own reports, when A calls `GET /v1/reports`, then only A's reports come back, ordered by `created_at` descending — `bun test src/partner-api.test.ts`
- [ ] Given more reports than `page_size`, when A follows `next_page_token`, then the next page continues with no duplicates or gaps, and `page_size` above 100 is clamped to 100 — `bun test src/partner-api.test.ts`
- [ ] Given a malformed `page_token`, when A calls the list, then the response is `400` `{error: "invalid_input"}` — `bun test src/partner-api.test.ts`

### Story 3: Read one report

- [ ] Given A owns a report, when A calls `GET /v1/reports/{id}`, then the response is `200` with the report, its status and its sections in position order — `bun test src/partner-api.test.ts`
- [ ] Given B owns the report, when A calls `GET /v1/reports/{id}`, then the response is `404` with the same body an unknown id gets — `bun test src/partner-api.test.ts`
- [ ] Given a partner-owned report, when anyone calls the legacy `GET /reports/{id}`, then the response is `404`; an internal report (no partner) still returns `200` unchanged — `bun test src/app.test.ts`

### Story 4: Reports finish or fail visibly

- [ ] Given a queued section, when the worker succeeds, then the section is `done` with its body, and the report becomes `done` once every section is done — `bun test src/worker.test.ts`
- [ ] Given a section that is already `done`, when its task is redelivered, then the worker returns `200` and makes zero model calls — `bun test src/worker.test.ts`
- [ ] Given a model call that times out or returns non-2xx, when the attempt is not the last, then the worker returns `500` (Cloud Tasks retries); on the last attempt the section and report become `failed` and the worker returns `200` — `bun test src/worker.test.ts`

### Story 5: Paid work cannot be triggered without the queue

- [ ] Given `SERVICE_ROLE` is `api` or unset, when anyone POSTs `/tasks/generate-section`, then the response is `404`; with `SERVICE_ROLE=worker`, `/v1` and legacy routes return `404` — `bun test src/app.test.ts`
- [ ] Given the deploy script, when it is checked, then the worker service is deployed `--no-allow-unauthenticated` and the queue carries max-attempts and dispatch caps — `bash -n deploy.sh && grep -q -- '--no-allow-unauthenticated' deploy.sh && grep -q -- '--max-attempts' deploy.sh`

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports.report_create.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | `POST /v1/reports` handler |
| `reports.report_create.failures` | Counter | none | `error.type` (`unauthorized`, `invalid_input`, `rate_limited`, `upstream_error`, `internal`, `_OTHER`) | `POST /v1/reports` handler |
| `reports.report_list.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | `GET /v1/reports` handler |
| `reports.report_list.failures` | Counter | none | `error.type` (`unauthorized`, `invalid_input`, `internal`, `_OTHER`) | `GET /v1/reports` handler |
| `reports.report_get.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | `GET /v1/reports/{id}` handler |
| `reports.report_get.failures` | Counter | none | `error.type` (`unauthorized`, `not_found`, `internal`, `_OTHER`) | `GET /v1/reports/{id}` handler |
| `reports.section_generate.duration` | Histogram (bounds 1, 2.5, 5, 10, 20, 30, 45, 60, 90, 120) | seconds | `operation.outcome` (`ok`, `error`) | worker `handleGenerateSection` |
| `reports.section_generate.failures` | Counter | none | `error.type` (`upstream_error`, `upstream_timeout`, `internal`, `_OTHER`) | worker `handleGenerateSection` |
| `reports.outbound.duration` | Histogram | seconds | `server.address` (`api.example-llm.com`, `cloudtasks.googleapis.com`), `operation.outcome` (`ok`, `error`) | `generateSection`, `enqueueSection` |
| Cloud Tasks queue depth | Gauge | `{message}` | `messaging.destination.name` (`sections`) | platform-native (Cloud Tasks `queue/depth`) |

Estimated series: 40 per operation for `report_create` (2 × 17 + 6)
Estimated series: 38 per operation for `report_list` (2 × 17 + 4)
Estimated series: 38 per operation for `report_get` (2 × 17 + 4)
Estimated series: 30 per operation for `section_generate` (2 × 13 + 4)
Estimated series: 60 per operation for `outbound` (model host: 2 × 13 job-scale buckets = 26; Cloud Tasks host: 2 × 17 = 34)

All counts are per reporting instance. Once the suggested Google Cloud Monitoring backend (OTLP route, 60 s export) is chosen, the ~206 series come to roughly 6 to 7 million samples a month per instance, about $0.40 a month per instance at the first-tier price (medium confidence; pricing per `.flow/metrics.md` `## Backend`). Partner id is deliberately **not** a label, because each tenant would add exported series. Per-partner usage comes from the reports table instead.

**Attributes:** new keys, added as `.flow/metrics.md` `## Attributes` rows — `operation.outcome` (`ok`, `error`), `error.type` (the `## error.type values` list), `server.address` (`api.example-llm.com`, `cloudtasks.googleapis.com`), `messaging.destination.name` (`sections`)

### Error types

New list, seeded from the starter values: `_OTHER`, `internal`, `invalid_input` (client-caused; also covers an idempotency-key mismatch), `not_found` (client-caused), `rate_limited` (client-caused here, since it is the partner's own daily cap), `unauthorized` (client-caused), `upstream_error`, `upstream_timeout`. The availability SLO excludes client-caused values.

### Dashboard panels

On a new "reports-service overview" dashboard (spec-only): Request rate, Success vs failure, Failures by `error.type`, Latency p50/p95/p99 for `report_create`, `report_list`, `report_get` and `section_generate`. Also Queue depth for `sections` (platform-native), and an outbound latency p95 panel by `server.address`.

### Alerts

burn-rate tiers only

### SLO

A new journey SLO, "partner API: request and read reports". Availability: 99.5% of `report_create`, `report_list` and `report_get` calls do not fail, over 30 days, excluding client-caused `error.type` values. Latency: 95% of those calls finish under 1 s. It uses the standard burn-rate tiers, recorded once in `.flow/metrics.md`.

**As-code:** spec-only — the repo keeps no dashboard or alert config

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | DB (migration 002), persistence (`src/db.ts`), auth (new `src/auth.ts`), HTTP (new `src/partner-api.ts`, `src/app.ts`), queue (`src/queue.ts`), worker + model client (`src/worker.ts`, `src/llm.ts`), infra (`deploy.sh`), operator tooling (new `scripts/api-keys.ts`), docs |
| Domain modules | Existing: reports, sections, queue, worker, model client. New: partners + API keys (`src/auth.ts`), partner HTTP surface (`src/partner-api.ts`), metrics helper (`src/metrics.ts`) |
| Data flow | Partner HTTP → key hash lookup → one transaction (partner row lock, daily cap, idempotency check, report + section inserts) → after commit, one named Cloud Tasks task per section → private worker → model call → section + parent status update in one transaction → partner polls `GET /v1/reports/{id}` |
| Pattern | Follows the repo's existing queue-per-section worker shape [anchor: src/queue.ts:1]; new pieces are a versioned `/v1` partner surface and a role-gated single image deployed as two Cloud Run services |
| Key storage | Keys look like `rpk_` + 32 random bytes in base64url. Only the SHA-256 digest is stored, behind a unique index, plus a 12-character display prefix. The full key is shown once at issue. |
| Auth header | `Authorization: Bearer <key>`; `401` + `WWW-Authenticate: Bearer` on miss |
| Error shape | `{"error": "<code>", "message": "<text>"}` — additive to the existing `{error}` body [anchor: src/app.ts:13] |
| Binary-framing check | The request is not framed as A-or-B. The real forks are how to protect the worker and what the legacy route does (see Decision analysis), and each has a middle option. |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| Create report (`POST /v1/reports`) | ~1 s | inline — key lookup, one transaction, N parallel enqueues; responds `202` + status resource | 10 s handler budget; `set local statement_timeout = '5s'`; each enqueue call 5 s | none in the handler — a partner retries with the same `Idempotency-Key`; a failed enqueue returns `503` + `Retry-After` | `(partner_id, Idempotency-Key)` unique index; replay returns the stored report | new per-partner daily report cap (partners row, checked under `select … for update`) |
| List reports (`GET /v1/reports`) | inline — ~100 ms, timeout 5 s | inline | 5 s statement timeout | none (client re-requests) | read-only | none (no paid call) |
| Get report (`GET /v1/reports/{id}`) | inline — ~100 ms, timeout 5 s | inline | 5 s statement timeout | none | read-only | none |
| Section generation (worker) | ~65 s | durable queue + private worker invoked synchronously under the Cloud Tasks attempt deadline | dispatch deadline 180 s > worker Cloud Run timeout 180 s ≥ model call 120 s | Cloud Tasks only: max 5 attempts, backoff 10 s → 300 s; the final attempt marks the section `failed` | Cloud Tasks task name `<reportId>-<position>` plus a consumer skip when the section is already `done` | queue `max-concurrent-dispatches=10`, `max-dispatches-per-second=1`; upstream per-partner daily cap |
| Model call (`generateSection`) | 60 s | inside the worker | 120 s `AbortSignal.timeout` | none here — retried by the queue only | inherited from the task | inherited from the queue caps |
| Cloud Tasks enqueue (`enqueueSection`) | ~300 ms | inline in create | 5 s per call; access token cached until 60 s before expiry | none here — the partner replay re-enqueues; `409 ALREADY_EXISTS` counts as success | task name `<reportId>-<position>` | none (Cloud Tasks per-operation cost is negligible at this volume) |

**Platform:** gcp

**Proportionality:**

- No outbox: the required `Idempotency-Key` replay re-enqueues pending sections, and named tasks dedupe.
- No Redis or token-bucket rate limiter: a 24 h count under the partner row lock is enough for a handful of partners.
- No completion webhooks, and no custom oldest-task-age gauge: platform queue depth is enough pre-launch.
- No `last_used_at` write on every request.
- No canary: there are no live partners yet, so deploy at 100% and roll back by shifting traffic.

Worst-case paid spend is bounded at partners × daily limit × sections-per-report model calls per day.

**Recovery:**

- **What is at stake:** partners and API-key rows are irreplaceable configuration (re-issuing keys disrupts every partner integration). Section bodies are paid generations, regenerable at one model call each.
- **Backup path:** Cloud SQL automated daily backups plus point-in-time recovery on the existing instance. Task 8 has `deploy.sh` enable them idempotently (`gcloud sql instances patch "$SQL_INSTANCE" --backup-start-time=03:00 --enable-point-in-time-recovery`).
- **Restore check:** documented in the operator runbook (Task 10), run quarterly. Clone to a scratch instance at a point in time (`gcloud sql instances clone "$SQL_INSTANCE" reports-restore-check --point-in-time=<ts>`), compare `partners`, `api_keys` and `reports` row counts with production, then delete the clone.

## Technical Constraints

- No new runtime dependencies (AGENTS.md "No new runtime dependencies without a reason"). Key hashing uses `Bun.CryptoHasher`/WebCrypto, Cloud Tasks auth uses the Cloud Run metadata server token over plain `fetch`, and worker auth uses Cloud Run IAM rather than an in-app JWT library.
- The repo has no migration runner, so `migrations/002_partner_api.sql` is applied the same way 001 is (out of band) **before** the new revision deploys. The migration is expand-only, so the old revision keeps working against it [anchor: migrations/001_reports.sql:1].
- The Cloud Tasks HTTP target must carry `oidcToken.serviceAccountEmail` and `audience`, and the API service account needs `roles/cloudtasks.enqueuer` plus `iam.serviceAccounts.actAs` on the invoker account. Without this the private worker rejects every task (flow-system-design GCP mapping).
- `SECTION_MAX_ATTEMPTS` (worker env, default 5) must equal the queue's `--max-attempts`. Otherwise the final-attempt failure marking never fires, or fires early. Both are set in `deploy.sh` from one shell variable.
- Status recompute must take `select … for update` on the report row in the same transaction as the section update. Two sections finishing together would otherwise each miss the other's commit and leave the report `running` forever.
- The partner-supplied `company` is placed verbatim into the model prompt [anchor: src/llm.ts:8], so it is validated: trimmed, 1–200 characters, no control characters.
- Cost: each partner report costs one paid model call per default section (20–60 s each [anchor: src/llm.ts:1]). The default cap of 50 reports per partner per day bounds the daily worst case at 50 × sections × partners calls.

## Open Questions

- [ ] Q1: What are the default report sections a partner report contains? Redirecting changes only the `DEFAULT_SECTIONS` constant in Task 7, and with it the per-report cost.
  - **Stakes:** user — partners receive whatever sections are listed; a wrong list ships reports with the wrong content, and every extra section is one more paid model call.
  - **Needs user input:** user-held preference or subjective taste — no section names exist anywhere in the repo, so the plan ships a placeholder list (`overview`, `financials`, `risks`) for you to replace.
- [ ] Q2: Are automated backups and point-in-time recovery already on for the production Cloud SQL instance, and what is its name? Redirecting either drops the `gcloud sql instances patch` line from Task 8 or supplies `SQL_INSTANCE`.
  - **Stakes:** system — if backups are off, a lost database takes every partner's keys and report history with it.
  - **Needs user input:** credentials or production access — instance settings are not visible from the repo.
- [ ] Does "request reports" mean the partner names the subject company in each request, or are reports always about the partner itself? Redirecting to "about the partner" drops the `company` body field and sets `company` from the partner row in Task 7.
  - **Stakes:** user — the wrong reading gives partners a request shape that cannot express what they want.
  - **Recommended:** the partner names the subject `company` in the request body — the model prompt is written "for" a company per report, and the reports table already stores that subject separately from any owner [confidence: medium] [anchor: adjacent: src/llm.ts:8]
- [ ] Are the report sections fixed by the service, or chosen by the partner per request? Redirecting to partner-chosen adds a validated `sections` array (capped length, allow-list) to Task 7 and makes the per-report cost variable.
  - **Stakes:** both — partner flexibility against a predictable cost per report.
  - **Recommended:** a fixed server-side list in v1 — every report then costs a known number of model calls, so the daily cap is a true spend ceiling [confidence: medium] [anchor: weighing: risk — a partner-chosen list makes per-report spend unbounded by the report cap alone]
- [ ] Is `Idempotency-Key` required or optional on `POST /v1/reports`? Redirecting to optional removes the `400` for a missing key in Task 7, and means a failed enqueue leaves an orphaned report the partner cannot re-drive.
  - **Stakes:** both — partners write one extra header against the risk of double-paid reports and stuck reports.
  - **Recommended:** required — it is the only dedupe against partner retries of a paid operation and the only recovery path for an enqueue that fails after commit [confidence: medium] [anchor: weighing: risk — without it a 503 after commit leaves a queued report with no way to re-enqueue]
- [ ] What is the default daily report limit per partner? Redirecting changes one column default in Task 1's DDL.
  - **Stakes:** both — too low blocks a legitimate partner with 429s; too high raises the worst-case daily model spend.
  - **Recommended:** 50 reports per partner per 24 h, stored per partner so one partner's limit can change with a single row update [confidence: medium] [anchor: weighing: reversibility — a per-row column changes without a deploy]
- [ ] How is the worker route protected? Redirecting changes Task 8's deploy shape and Task 7's role switch (see Decision analysis A).
  - **Stakes:** system — a publicly invocable worker lets anyone run paid model calls and skip the partner cap.
  - **Recommended:** deploy the same image as a second, private Cloud Run service that only the queue's service account can invoke [confidence: medium] [anchor: weighing: risk — Cloud Run IAM verifies the OIDC token, so no in-house JWT verification code ships]
- [ ] What does the legacy anonymous `GET /reports/{id}` do once partner reports exist? Redirecting changes the legacy handler in Task 7 (see Decision analysis B).
  - **Stakes:** both — partner report confidentiality against breaking unknown internal readers.
  - **Recommended:** keep it for internal reports and return 404 for any partner-owned report [confidence: medium] [anchor: weighing: reversibility — internal readers see no change, and the route can be locked down later without touching partner routes]
- [ ] How are partners created and keys issued or revoked? Redirecting to an admin HTTP endpoint adds an authenticated admin route and its own auth scheme to Task 7.
  - **Stakes:** user — the operator onboarding partners runs a local script against the database rather than calling an endpoint.
  - **Recommended:** an operator script (`bun scripts/api-keys.ts create-partner | issue | revoke`) that prints a new key exactly once [confidence: medium] [anchor: weighing: footprint — no second auth scheme for an admin surface used a few times a month]
- [ ] What error body shape do `/v1` routes use? Redirecting to RFC 9457 Problem Details changes every error response in Task 7 and the API reference.
  - **Stakes:** user — partners parse this shape, and changing it after launch is a breaking change.
  - **Recommended:** `{"error": "<code>", "message": "<text>"}`, extending the existing `{error}` body so current parsing keeps working [confidence: high] [anchor: src/app.ts:13]
- [x] Key string prefix (`rpk_`) and display-prefix length (12 characters) — resolved without asking
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision A — how is the paid worker route kept away from the public?** Friction for partners in every branch: 0 interruptions, since partners never call the worker.

- **A1, private worker service:**
  - **What changes:** the same image is deployed twice. `reports-service` runs with `SERVICE_ROLE=api` and stays public. `reports-worker` runs with `SERVICE_ROLE=worker`, `--no-allow-unauthenticated`, and only the queue's invoker service account holds `roles/run.invoker`.
  - **Downstream:** an anonymous POST to the worker gets a 403 from Cloud Run before any code runs, and the public service returns 404 for the route.
  - **Cost:** one extra scale-to-zero service, so near-zero idle cost.
- **A2, in-app OIDC verification:**
  - **What changes:** the worker verifies the Google-signed JWT itself. That means a JWKS fetch and cache, an RS256 check, and audience and email checks, about 80 lines of security-critical code with no library under the no-new-dependency rule.
  - **Downstream:** same behaviour if the code is right, and a full bypass if it is wrong.
- **A3, shared-secret header:**
  - **What changes:** tasks carry a secret header.
  - **Downstream:** the secret is readable by anyone with `cloudtasks.tasks.get`, and rotating it strands queued tasks.

The three are mutually exclusive. Ranking: A1 > A2 > A3.

Verdict: **A1** — the platform verifies the caller, so the plan ships no crypto code, and the deploy change is a few lines [confidence: medium] [anchor: weighing: risk — removes a hand-written token check from the path that controls paid spend].

**Decision B — what does the legacy anonymous read route do once partner reports exist?** Friction for partners in every branch: 0 interruptions.

- **B1, unchanged:** partner reports are readable without a key by anyone holding an id. That fails the vetting condition.
- **B2, partner-owned reports 404 on the legacy route:** internal readers see byte-identical responses, and partner data opens only through `/v1`.
- **B3, move the route to the private worker service:** this closes anonymous reads of internal reports too, but any out-of-repo reader of today's public route breaks with no warning.

The three are mutually exclusive with each other, and each is complementary with A1 (B3 needs A1's private service). Ranked combinations: A1+B2 > A1+B3 > A2+B2 > A1+B1.

Verdict: **B2**, with B3 tracked as a candidate follow-up once its consumers are known [confidence: medium] [anchor: weighing: reversibility — B2 can tighten to B3 later without touching partner routes; B3 cannot be undone for a broken consumer without a redeploy].

## Alternatives considered

- **OAuth 2.0 client-credentials tokens instead of API keys** — rejected: the user asked for "a public API authenticated with an API key". Client credentials adds a token endpoint, client registration and token-expiry handling that nothing in the request calls for.
- **Salted argon2/bcrypt key hashes** — rejected: a salted hash cannot be looked up through a unique index, which forces a prefix lookup plus a deliberately slow verify on every request. The keys are 256-bit random values, so an unsalted SHA-256 digest carries no brute-force risk.
- **Transactional outbox for section enqueues** — rejected: the required `Idempotency-Key` replay re-enqueues only pending sections, and named tasks dedupe, so an outbox adds a table and a relay process for no extra guarantee.

## Recommendation

**Reconsider scope** — build the partner API as asked, widened by the two prerequisites that keep the key gate from being bypassed on day one. The worker moves to a private service (Decision A) and partner reports drop off the anonymous legacy route (Decision B). This also rewrites the enqueue client, which has never worked, and simplifies the worker, model client, router and deploy script so reports finish or fail visibly [confidence: medium] [anchor: adjacent: deploy.sh:4]

**Redundancy:** none found — the repo has no report-creation path, no list endpoint and no authentication of any kind [anchor: src/app.ts:7-17]

## Plan risks

The weakest assumption is that nothing outside this repo posts directly to the public worker route or depends on it. The repo has no way to create a report, so today's reports are created by something outside it, and that producer may depend on the public worker route that this plan moves behind IAM.

## Cut list

- Several API keys per partner could collapse to one key column on the partner row. It stays: rotating a leaked key with one key per partner either orphans the partner's report history or needs a downtime swap. No other cut was found, because every other piece (cap, idempotency, failed state, private worker) answers a named failure mode above.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Lock down anonymous reads of internal reports on the legacy `GET /reports/{id}` route | High | Small | needs its own design/decision session: the open decision is whether any out-of-repo consumer still relies on anonymous reads of internal reports | adjacent — this plan only hides partner-owned reports there (Decision B2) | No |
| Report-completion webhooks for partners | Medium | Medium | genuinely novel non-trivial feature: signed callbacks, delivery retries and per-partner endpoint registration are their own surface | extends the polling-only status resource this plan ships | No |
| Partner self-service key management portal | Low | Large | genuinely novel non-trivial feature: it needs partner login, a UI and a second auth scheme | replaces the operator script this plan ships | No |

- [x] Lock down anonymous reads of internal reports on the legacy `GET /reports/{id}` route — require IAM or move it to the private worker service once its consumers are known.
  - **UX:** none
  - **Problem:** any internal report is readable by anyone on the internet who holds its id, with no credential [anchor: src/app.ts:10-15]
  - **Stability/efficiency:** none
  - **Value rank:** 5 — security exposure: report content served anonymously from a service deployed `--allow-unauthenticated` [anchor: deploy.sh:4]
  - **Complexity:** Small — one route plus one deploy flag, once consumers are identified
  - **Risk:** Medium — breaks any unknown anonymous reader
  - **If never done:** internal report content stays publicly readable by id indefinitely
  - **Verdict:** clears bar — an anonymous read path to report content outweighs a small change whose only risk is identifying consumers first
- [ ] Report-completion webhooks for partners — call a partner-registered URL when a report reaches `done` or `failed`.
  - **UX:** partners would stop polling `GET /v1/reports/{id}`; there is no partner request for it yet
  - **Problem:** none
  - **Stability/efficiency:** none
  - **Value rank:** 1 — no observed partner friction yet; polling works [anchor: user: "list their past reports"]
  - **Complexity:** Medium — new table, signing, a delivery queue and retries
  - **Risk:** Medium — outbound calls to partner-controlled URLs (SSRF surface)
  - **If never done:** nothing — partners poll the status resource
  - **Verdict:** below bar — no observed failure, and polling covers the asked-for history and status
- [ ] Partner self-service key management portal — let partners create and revoke their own keys.
  - **UX:** none
  - **Problem:** none
  - **Stability/efficiency:** none
  - **Value rank:** 1 — onboarding volume is unknown and the operator script covers it [anchor: user: "partner companies request reports"]
  - **Complexity:** Large — partner login, UI, second auth scheme
  - **Risk:** High — a new authenticated surface that issues credentials
  - **If never done:** nothing — an operator issues keys with the script
  - **Verdict:** below bar — no observed onboarding friction against a large new credential-issuing surface

# Task breakdown

### Task 1: Migration 002 — partners, API keys, report ownership, section status

- **Skill:** `flow-system-design`
- **Description:** Expand-only schema for partner ownership, hashed keys, idempotency and per-section status, with indexes for the list, cap and key lookups. Backfill existing sections that already have a body to `done`.
- **Inputs:** `migrations/001_reports.sql`
- **Outputs:** `migrations/002_partner_api.sql`
- **Contract:** _(schema change type — exact DDL)_
  - **Files:** create `migrations/002_partner_api.sql`
  - **Interfaces:**
    - `create table partners (id text primary key, name text not null unique, daily_report_limit int not null default 50 check (daily_report_limit >= 0), created_at timestamptz not null default now());`
    - `create table api_keys (id text primary key, partner_id text not null references partners(id), key_hash bytea not null unique, key_prefix text not null, created_at timestamptz not null default now(), revoked_at timestamptz);`
    - `alter table reports add column partner_id text references partners(id), add column idempotency_key text;`
    - `create unique index reports_partner_idempotency on reports (partner_id, idempotency_key) where partner_id is not null;`
    - `create index reports_partner_created on reports (partner_id, created_at desc, id desc) where partner_id is not null;`
    - `alter table sections add column status text not null default 'queued' check (status in ('queued','done','failed'));`
    - `update sections set status = 'done' where body is not null;`
  - **Call-site edits:** none (consumers arrive in Task 3)
- **Acceptance criteria:** `grep -q 'create table api_keys' migrations/002_partner_api.sql && grep -q 'reports_partner_idempotency' migrations/002_partner_api.sql && { [ -z "$TEST_DATABASE_URL" ] || psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_reports.sql -f migrations/002_partner_api.sql; }`

### Task 2: Metrics helper and `.flow/metrics.md`

- **Skill:** `flow-metrics`
- **Description:**
  - Create the repo-local, zero-dependency metrics helper with an in-memory recorder behind a swappable `Recorder`, plus `.flow/metrics.md`.
  - **`.flow/metrics.md` contents:**
    - Backend `none yet — suggested: Google Cloud Monitoring (OTLP, 60 s export)`; namespace `reports`.
    - Attributes `operation.outcome`, `error.type`, `server.address`, `messaging.destination.name`.
    - The eight `error.type` values from `## Instrumentation`, with the client-caused ones marked.
    - The panels, the new SLO, burn-rate alert tiers, As-code `spec-only`, and Coverage listing `report_create`, `report_list`, `report_get`, `section_generate`, `outbound`.
  - **HTTP status mapping in `instrumentHttp`:** 400/422 → `invalid_input`, 401 → `unauthorized`, 404 → `not_found`, 429 → `rate_limited`, 503 → `upstream_error`, other 5xx → `internal`.
- **Inputs:** new: `src/metrics.ts`
- **Outputs:** helper + contract file + emission tests
- **Contract:**
  - **Files:** create `src/metrics.ts`, `src/metrics.test.ts`, `.flow/metrics.md`
  - **Interfaces:**
    - `export type ErrorType = "_OTHER" | "internal" | "invalid_input" | "not_found" | "rate_limited" | "unauthorized" | "upstream_error" | "upstream_timeout"`
    - `export type Operation = "report_create" | "report_list" | "report_get" | "section_generate"`
    - `export type ServerAddress = "api.example-llm.com" | "cloudtasks.googleapis.com"`
    - `export interface Recorder { observe(name: string, seconds: number, attrs: Record<string, string>): void; increment(name: string, attrs: Record<string, string>): void }`
    - `export function setRecorder(r: Recorder): void`
    - `export function createMemoryRecorder(): Recorder & { observations: …; increments: … }`
    - `export class OpError extends Error { constructor(public errorType: ErrorType, message?: string) }`
    - `export async function instrument<T>(op: Operation, fn: () => Promise<T>): Promise<T>` (a thrown `OpError` records its type; anything else records `internal`)
    - `export async function instrumentHttp(op: Operation, fn: () => Promise<Response>): Promise<Response>` (maps status per the description)
    - `export async function timeOutbound<T>(dep: ServerAddress, fn: () => Promise<T>): Promise<T>`
  - **Call-site edits:** none (callers arrive in Tasks 5–7)
- **Acceptance criteria:** `bun test src/metrics.test.ts && test -f .flow/metrics.md && grep -q 'upstream_timeout' .flow/metrics.md`. The tests must pass for: a success records one `operation.outcome=ok` observation and no increment; each status-mapped failure records one `error` observation plus one increment with the exact `error.type`; an unknown throw maps to `internal`.

### Task 3: Persistence — partner, key, report and section queries

- **Skill:** `flow-system-design`
- **Description:**
  - Add the partner-facing SQL to `src/db.ts`.
  - **`createPartnerReport` runs in one `sql.begin` transaction:**
    1. `set local statement_timeout = '5s'`.
    2. `select daily_report_limit from partners where id = $1 for update`.
    3. Idempotency lookup on `(partner_id, idempotency_key)`. Same `company` → `replayed`, with the sections not yet `done`. Different `company` → `idempotency_mismatch`.
    4. 24 h count against the limit; at or over the limit → `quota_exceeded`.
    5. Insert the report (`crypto.randomUUID()`) and one section row per name, with its position.
  - **`completeSection` / `failSection`:** in one transaction, lock the report row (`select id from reports where id = $1 for update`), update the section, then recompute `reports.status`. The recompute gives `failed` if any section failed and none are queued, `done` if all are done, otherwise `running`.
  - Replace `saveSection` with `completeSection`. Add a `partner_id` field to `Report`.
- **Inputs:** Task 1 schema; `src/db.ts`
- **Outputs:** typed query functions + a Postgres-backed test that runs when `TEST_DATABASE_URL` is set
- **Contract:**
  - **Files:** edit `src/db.ts`; create `src/db.test.ts`
  - **Interfaces:**
    - **Types:**
      - `export type Report = { id: string; company: string; status: string; created_at: string; partner_id: string | null }`
      - `export type PartnerRow = { id: string; name: string; daily_report_limit: number }`
      - `export type PendingSection = { name: string; position: number }`
      - `export type CreateReportResult = { kind: "created" | "replayed"; reportId: string; pending: PendingSection[] } | { kind: "quota_exceeded"; retryAfterSeconds: number } | { kind: "idempotency_mismatch" }`
      - `export type ReportSummary = { id: string; company: string; status: string; created_at: string }`
    - **Partner and key queries:**
      - `export async function findPartnerByKeyHash(hash: Uint8Array): Promise<PartnerRow | undefined>` (joins `api_keys` with `revoked_at is null`)
      - `export async function insertPartner(name: string, dailyLimit?: number): Promise<string>`
      - `export async function insertApiKey(partnerId: string, hash: Uint8Array, prefix: string): Promise<string>`
      - `export async function revokeApiKey(prefix: string): Promise<number>`
    - **Report queries:**
      - `export async function createPartnerReport(input: { partnerId: string; company: string; idempotencyKey: string; sections: readonly string[] }): Promise<CreateReportResult>`
      - `export async function listPartnerReports(partnerId: string, opts: { limit: number; after?: { createdAt: string; id: string } }): Promise<ReportSummary[]>` (keyset on `(created_at, id) < (…)`, ordered desc)
      - `export async function getPartnerReport(partnerId: string, reportId: string): Promise<(ReportSummary & { sections: { name: string; status: string; body: string | null }[] }) | undefined>`
    - **Section queries:**
      - `export async function getSectionStatus(reportId: string, name: string): Promise<string | undefined>`
      - `export async function completeSection(reportId: string, name: string, body: string): Promise<void>`
      - `export async function failSection(reportId: string, name: string): Promise<void>`
  - **Call-site edits:** `src/worker.ts` — `saveSection` import is replaced in Task 6 (this task keeps a temporary `saveSection` re-export as `completeSection` alias so the tree stays green)
- **Acceptance criteria:** `bun test src/db.test.ts`. With `TEST_DATABASE_URL` set, it runs: the cap is enforced under concurrent creates, replay vs mismatch, keyset pagination with no gaps, and two concurrent `completeSection` calls leave the report `done`. Without it, it skips.

### Task 4: API-key authentication

- **Skill:** `flow-new-feature`
- **Description:**
  - Key generation (`rpk_` + 32 random bytes in base64url), SHA-256 hashing via `Bun.CryptoHasher`, and Bearer parsing.
  - `authenticatePartner` resolves a request to a partner or `null`. Unknown, revoked and malformed keys all return `null`, with no distinguishing timing branch beyond the single indexed lookup.
- **Inputs:** Task 3 `findPartnerByKeyHash`
- **Outputs:** `src/auth.ts` + unit tests (db mocked with `mock.module`)
- **Contract:**
  - **Files:** create `src/auth.ts`, `src/auth.test.ts`
  - **Interfaces:**
    - `export type Partner = { id: string; name: string; dailyReportLimit: number }`
    - `export function generateApiKey(): { key: string; prefix: string; hash: Uint8Array }` (prefix = first 12 chars)
    - `export function hashApiKey(key: string): Uint8Array`
    - `export function parseBearer(req: Request): string | null`
    - `export async function authenticatePartner(req: Request): Promise<Partner | null>`
  - **Call-site edits:** none (consumed in Tasks 7 and 9)
- **Acceptance criteria:** `bun test src/auth.test.ts` — the generated key matches `/^rpk_[A-Za-z0-9_-]{43}$/`, the hash is deterministic and 32 bytes, missing, `Basic` and malformed headers return `null`, and a revoked key (lookup returns undefined) returns `null`

### Task 5: Rewrite the Cloud Tasks enqueue client

- **Skill:** `flow-system-design`
- **Bundled:** the enqueue client has never been able to authenticate to Cloud Tasks or to a private worker, a prerequisite surfaced during discovery
- **Description:**
  - Fetch and cache a Google access token from the Cloud Run metadata server (`Metadata-Flavor: Google`; refresh 60 s before `expires_in`).
  - Create a named task `"${QUEUE}/tasks/${reportId}-${position}"` with `dispatchDeadline: "180s"`, `httpMethod: "POST"`, a JSON content type and a versioned body `{version: 1, reportId, section}`. Set `oidcToken: {serviceAccountEmail: TASKS_INVOKER_SA, audience: WORKER_URL}`.
  - Each call gets a 5 s `AbortSignal.timeout`. A `409` counts as success. Any other non-2xx throws `OpError("upstream_error")`.
  - Wrap the call in `timeOutbound("cloudtasks.googleapis.com", …)`.
- **Inputs:** `src/queue.ts`; Task 2 `src/metrics.ts`
- **Outputs:** working enqueue client + tests with a stubbed `fetch`
- **Contract:**
  - **Files:** edit `src/queue.ts`; create `src/queue.test.ts`
  - **Interfaces:** `export type SectionTask = { version: 1; reportId: string; section: string }`; `export async function enqueueSection(reportId: string, section: string, position: number): Promise<void>`; env `SECTIONS_QUEUE`, `WORKER_URL`, `TASKS_INVOKER_SA`
  - **Call-site edits:** none today (the function has no callers); Task 7 calls it
- **Acceptance criteria:** `bun test src/queue.test.ts`. It asserts: the `Authorization: Bearer` header comes from the metadata token, and a second call reuses the cached token; the task name is `<reportId>-<position>`; the payload carries `oidcToken`, `dispatchDeadline` and `version: 1`; `409` resolves; `500` rejects; one `reports.outbound.duration` observation per call with `server.address=cloudtasks.googleapis.com`.

### Task 6: Harden the section worker and model client

- **Skill:** `flow-system-design`
- **Bundled:** the model call's missing timeout and failure check, and the report status nothing ever updates, both surfaced during discovery as objective bugs on the partner path
- **Description:**
  - **`generateSection`:** takes a 120 s `AbortSignal.timeout`. An abort throws `OpError("upstream_timeout")`, and a non-2xx throws `OpError("upstream_error")` with `permanent: true` for a 4xx. Wrap it in `timeOutbound("api.example-llm.com", …)`.
  - **Worker, in order:**
    1. Accept payloads with or without `version`.
    2. If the report is gone → 200.
    3. If `getSectionStatus` is `done` or `failed` → 200 with no model call (the idempotency key is the task's `reportId` + `section`).
    4. Generate, then `completeSection` → 200.
    5. On error, read `X-CloudTasks-TaskRetryCount`. If `retryCount + 1 >= SECTION_MAX_ATTEMPTS` (default 5), or the error is permanent → `failSection` and return 200. Otherwise → 500, and Cloud Tasks retries.
  - Wrap the worker in `instrument("section_generate", …)`.
  - Leave `suggestTitle` untouched.
- **Inputs:** Task 3 section queries; Task 2 metrics helper; `src/worker.ts`, `src/llm.ts`
- **Outputs:** idempotent, bounded worker + tests (db and llm mocked)
- **Contract:**
  - **Files:** edit `src/worker.ts`, `src/llm.ts`; create `src/worker.test.ts`
  - **Interfaces:** `export async function generateSection(company: string, section: string, opts?: { timeoutMs?: number }): Promise<string>` (throws `OpError`); `export async function handleGenerateSection(req: Request): Promise<Response>` (unchanged signature); env `SECTION_MAX_ATTEMPTS`
  - **Call-site edits:** `src/worker.ts` — `saveSection` → `completeSection`; remove the temporary alias from `src/db.ts`
- **Acceptance criteria:** `bun test src/worker.test.ts`. It asserts: success → `completeSection` is called once and the response is 200; a `done` section → 200 with zero `generateSection` calls; a timeout at retry count 0 → 500 with no `failSection`; a timeout at retry count 4 → `failSection` + 200; a 4xx model response → `failSection` + 200 on the first attempt; `section_generate` emits `upstream_timeout` and `upstream_error` failures; the model call's abort fires at the configured 120 s deadline (fake timer).

### Task 7: Partner HTTP routes and service-role routing

- **Skill:** `flow-new-feature`
- **Description:**
  - **`POST /v1/reports`:**
    1. Auth.
    2. Require `Idempotency-Key` (1–255 chars) → else 400.
    3. Validate `company` (trimmed, 1–200 chars, no control characters) → else 400.
    4. `createPartnerReport` with `DEFAULT_SECTIONS`.
    5. `quota_exceeded` → 429 + `Retry-After`; `idempotency_mismatch` → 422 `{error: "idempotency_mismatch"}`.
    6. Otherwise `Promise.all(enqueueSection)` over `pending`. An enqueue failure → 503 + `Retry-After: 5`, carrying the report id. Success → 202 `{id, status}` + `Location`.
  - **`GET /v1/reports`:** `page_size` defaults to 20 and is clamped to 1–100. `page_token` is opaque base64url of `created_at|id`; a malformed token → 400. Fetch `limit + 1` rows to decide `next_page_token`.
  - **`GET /v1/reports/{id}`:** `getPartnerReport`, or 404 with the unknown-id body.
  - **Shared rules:** every `/v1` route returns 401 + `WWW-Authenticate: Bearer` when auth fails, and each is wrapped in `instrumentHttp`.
  - **`src/app.ts` routing:** read `SERVICE_ROLE` (`api` default, or `worker`). `worker` serves only `POST /tasks/generate-section`. `api` serves `/v1/*` and legacy `GET /reports/:id`, which returns 404 when `partner_id` is not null.
- **Inputs:** Tasks 3, 4, 5, 6; `src/app.ts`
- **Outputs:** partner surface + routing + handler tests (db, queue and auth mocked via `mock.module`)
- **Contract:**
  - **Files:** create `src/partner-api.ts`, `src/partner-api.test.ts`, `src/app.test.ts`; edit `src/app.ts`
  - **Interfaces:** `export const DEFAULT_SECTIONS: readonly string[] = ["overview", "financials", "risks"]` (placeholder pending Q1); `export async function handlePartnerApi(req: Request, url: URL): Promise<Response | null>` (null when the path is not under `/v1/`); `export function encodePageToken(createdAt: string, id: string): string`; `export function decodePageToken(token: string): { createdAt: string; id: string } | null`; the `handle(req)` signature is unchanged
  - **Call-site edits:** `src/app.ts` `handle` — add the role switch, delegate `/v1/` to `handlePartnerApi`, and add the partner-ownership 404 to the legacy route
- **Acceptance criteria:** `bun test src/partner-api.test.ts src/app.test.ts` — every Story 1–3 and Story 5 criterion above passes, including the 401, 422, 429 and 503 paths, cross-partner 404, pagination continuity and clamp, legacy-route 404 for partner-owned reports and 200 for internal ones, and role gating; `report_create` emits `rate_limited` and `unauthorized` failures

### Task 8: Deploy split, queue settings and backups

- **Skill:** `flow-system-design`
- **Bundled:** queue retry and rate settings that never applied to an existing queue, and enabling Cloud SQL backups/PITR, surfaced during discovery
- **Description:**
  - Rewrite `deploy.sh` (still `set -euo pipefail`) around shell variables `MAX_ATTEMPTS=5`, `REGION=us-central1`, `SQL_INSTANCE` (required) and `INVOKER_SA`.
  - **Queue:** create it if missing, then always `gcloud tasks queues update sections --location "$REGION" --max-attempts="$MAX_ATTEMPTS" --min-backoff=10s --max-backoff=300s --max-doublings=4 --max-concurrent-dispatches=10 --max-dispatches-per-second=1`.
  - **Private worker:** deploy `reports-worker` from the same source with `--no-allow-unauthenticated --timeout=180 --max-instances=5 --set-env-vars SERVICE_ROLE=worker,SECTION_MAX_ATTEMPTS="$MAX_ATTEMPTS"`, and grant `roles/run.invoker` on it to `$INVOKER_SA`.
  - **Public API:** deploy `reports-service` with `--allow-unauthenticated --max-instances=5 --set-env-vars SERVICE_ROLE=api,WORKER_URL=<worker url>,TASKS_INVOKER_SA="$INVOKER_SA"`.
  - **Backups:** `gcloud sql instances patch "$SQL_INSTANCE" --backup-start-time=03:00 --enable-point-in-time-recovery` (dropped if Q2 confirms already on).
- **Inputs:** `deploy.sh`; Task 7 role switch
- **Outputs:** two-service deploy with queue must-set settings
- **Contract:** _(config / infra type — file + key + before → after)_
  - **Files:** edit `deploy.sh`
  - **Interfaces:**
    - queue `sections`: max attempts unset → `5`; backoff unset → `10s`–`300s`; concurrency unset → `10`; rate unset → `1/s`; per-task dispatch deadline → `180s` (set in Task 5)
    - service `reports-service`: worker route → removed (`SERVICE_ROLE=api`)
    - new service `reports-worker`: `--no-allow-unauthenticated`, timeout `180`, invoker `$INVOKER_SA`
    - Cloud SQL: PITR → enabled
  - **Call-site edits:** none
- **Acceptance criteria:** `bash -n deploy.sh && grep -q -- '--no-allow-unauthenticated' deploy.sh && grep -q -- '--max-attempts' deploy.sh && grep -q -- '--max-concurrent-dispatches' deploy.sh && grep -q 'SERVICE_ROLE=worker' deploy.sh && grep -q 'enable-point-in-time-recovery' deploy.sh`

### Task 9: Operator key-management script

- **Skill:** `flow-new-feature`
- **Description:** `bun scripts/api-keys.ts` provides three subcommands:
  - `create-partner <name> [--daily-limit N]` prints the partner id.
  - `issue <partner-id>` prints the full key exactly once, plus its prefix.
  - `revoke <key-prefix>` prints the count revoked.
  - It runs locally against `DATABASE_URL`, for example through the Cloud SQL proxy. It is not shipped in the image.
- **Inputs:** Tasks 3 and 4
- **Outputs:** script + tests (db mocked)
- **Contract:**
  - **Files:** create `scripts/api-keys.ts`, `scripts/api-keys.test.ts`
  - **Interfaces:** `export async function run(argv: string[], out: (line: string) => void): Promise<number>` (exit code; unknown subcommand → usage + 2)
  - **Call-site edits:** none
- **Acceptance criteria:** `bun test scripts/api-keys.test.ts` — `issue` calls `insertApiKey` with the hash of the printed key, never the key itself; `revoke` reports the count; an unknown subcommand returns 2

### Task 10: Partner API reference and operator runbook

- **Skill:** `flow-new-feature`
- **Bundled:** partner-facing documentation and the restore-check runbook, both needed for partners to integrate and for the Recovery line to be actionable
- **Description:**
  - **Partner reference:** auth header, the three endpoints with request and response examples, the error codes, the `Idempotency-Key` requirement, the daily limit and `Retry-After`, pagination, and status values.
  - **Operator runbook:** onboarding a partner, issuing and rotating or revoking a key, setting a partner's limit, pausing paid work (`gcloud tasks queues pause sections`), and the quarterly point-in-time restore check.
- **Inputs:** Tasks 7–9 interfaces
- **Outputs:** two markdown docs
- **Contract:** _(docs type — new files)_
  - **Files:** create `docs/partner-api.md`, `docs/operator-runbook.md`
  - **Interfaces:** `docs/partner-api.md` headings `## Authentication`, `## Create a report`, `## List reports`, `## Get a report`, `## Errors`, `## Limits and idempotency`; `docs/operator-runbook.md` headings `## Onboard a partner`, `## Rotate or revoke a key`, `## Pause paid work`, `## Restore check`
  - **Call-site edits:** none
- **Acceptance criteria:** `grep -q '^## Limits and idempotency' docs/partner-api.md && grep -q 'Idempotency-Key' docs/partner-api.md && grep -q '^## Restore check' docs/operator-runbook.md && grep -q 'instances clone' docs/operator-runbook.md`

| Task | Depends on |
| ---- | ---------- |
| 1 | — |
| 2 | — |
| 3 | 1 |
| 4 | 3 |
| 5 | 2 |
| 6 | 2, 3 |
| 7 | 3, 4, 5, 6 |
| 8 | 7 |
| 9 | 3, 4 |
| 10 | 7, 8, 9 |

### Skills Summary

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-system-design | Yes (Tasks 1, 3, 5, 6, 8) | Queue, worker, idempotency, cost cap, deploy and recovery decisions |
| flow-metrics | Yes (Task 2) | First instrumented change: helper + `.flow/metrics.md` |
| flow-new-feature | Yes (Tasks 4, 7, 9, 10) | New auth module, partner routes, operator script, docs |
| flow-testing | No (implicit) | Every task carries its own tests; no separate test task needed |
| flow-refactoring | No | The existing-code changes are behaviour changes, not behaviour-preserving cleanup |
| flow-ui-ux | No | No UI surface |
| flow-verify | No (implicit) | Runs as the pipeline's verify phase |

# PR description draft

## TLDR

Partner companies can now request reports and list their own past reports through a key-authenticated public API. Before, nothing could create a report and anyone holding an id could read one.

## User-facing changes

- Partners can request a report with one authenticated call naming the subject company. The call returns a report id and a link to check its progress.
- Partners can list their own past reports, newest first, a page at a time, and open any one of them with its sections.
- Repeating a request with the same idempotency key returns the original report instead of starting, and paying for, a second one.
- Each partner has a daily report limit. Requests past it are refused with a time to retry after.
- A report's status now shows where it is:
  - **Before:** every report read "queued" forever, whether or not its sections had been written.
  - **After:** status moves from queued to running to done, or to failed once retries run out.
- A partner's reports open only with that partner's key:
  - **Before:** anyone who knew a report's id could read it with no credential.
  - **After:** partner reports return "not found" to anyone else, including on the old read link; internal reports read as before.
- Operators onboard partners and issue, rotate or revoke keys with a local command. A new key is shown exactly once.

## System changes

- Paid section generation now runs on a separate, private service that only the task queue can call:
  - **Before:** one public service ran both the read route and the paid worker, so anyone on the internet could trigger model calls.
  - **After:** the public service serves partner and read routes only, and the worker accepts nothing but queue-authenticated calls.
- Section tasks are now named, authenticated, time-bounded and retried only by the queue:
  - **Before:** the enqueue call carried no credential, no task name and no deadline, and model calls had no timeout.
  - **After:** each section is one named task (duplicates collapse), with a 180-second attempt deadline, a 120-second model-call timeout and at most 5 attempts. The final attempt marks the section failed.
- The queue's retry and rate settings are now applied on every deploy:
  - **Before:** the deploy only created the queue and never applied limits.
  - **After:** at most 10 sections generate at once, at 1 new start per second.
- New database tables hold partners and hashed API keys, and reports now record their owning partner. The schema change is additive, so the previous release still runs against it.
- Ongoing cost: each partner report costs one paid model call per section. The per-partner daily limit (default 50 reports) caps the daily worst case at partners × 50 × sections calls. The private worker adds one scale-to-zero service with near-zero idle cost.

## Why

Partners who want reports currently depend on someone inside to start them and relay the results, because the service has no way to accept a report request and no way to show a requester their history. The service's only read path also exposes any report to anyone with its id, and its paid generation step is reachable by anyone. Opening it to outside partners as it stands would leak reports and let model spend run unbounded.

## Key decisions

- **Private worker service, not in-app token checks.** The same build deploys twice, and the platform verifies the queue's identity before any code runs. The alternatives were hand-written token verification on the security path, or a shared secret readable from the queue.
- **The old anonymous read link stays for internal reports and hides partner reports.** This keeps unknown internal readers working while partner data opens only with a key. Locking down internal reports too is tracked as a follow-up until their readers are known.
- **`Idempotency-Key` is required on report requests.** It is the only protection against a retried request paying twice, and the only way to recover a report whose sections failed to enqueue.
- **Fixed default sections per report, not partner-chosen.** Every report costs a known number of model calls, so the daily limit is a real spend ceiling.
- **Keys are random 256-bit tokens stored only as SHA-256 digests.** A fast unsalted digest is safe for random keys and can be looked up by index. A slow salted hash would add per-request latency for no security gain.
- **Out of scope:** completion webhooks, partner self-service key management, partner-chosen sections, and billing.
- Bundled: the enqueue client had never been able to authenticate to the queue or to a private worker. It was rewritten as a prerequisite.
- Bundled: the model call's missing timeout and failure check, and the report status that nothing updated, were fixed as objective bugs on the partner path.
- Bundled: queue retry and rate settings now apply on every deploy, and database backups with point-in-time recovery are enabled.
- Bundled: a partner-facing API reference and an operator runbook, including a quarterly restore check.

## Instrumentation

These are the first metrics in this repo. They are recorded, but no graph will show them until a metrics backend is chosen; the suggested one is Google Cloud Monitoring (see the backend status in `.flow/metrics.md`). Until then the dashboard is spec-only.

- **Per operation:** latency and failures-by-type for requesting a report, listing reports, reading a report and generating a section. There is also outbound latency to the model provider and to the task queue.
- **New panels** on the spec-only "reports-service overview" dashboard: request rate, success vs failure, failures by type, latency p50/p95/p99 per operation, section queue depth (platform-native) and outbound latency.
- **New journey SLO**, "partner API: request and read reports": 99.5% of calls succeed over 30 days (partner mistakes excluded), and 95% finish under 1 second. It uses the standard burn-rate alert tiers.
- Partner identity is deliberately not a metric label, so per-partner usage is read from the database and does not multiply monitoring series.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/partner-api.test.ts` — report requests return 202 with a status link, a repeated idempotency key replays, a changed body is refused with 422, an over-limit request gets 429 with Retry-After, and a missing or revoked key gets 401.
- [ ] Run `bun test src/partner-api.test.ts` — listing returns only the caller's reports newest first, pages continue with no gaps, page size is clamped to 100, and a malformed page token gets 400.
- [ ] Run `bun test src/app.test.ts` — another partner's report and a partner report on the old read link both return 404, an internal report still returns 200, and the public role refuses the worker route.
- [ ] Run `bun test src/worker.test.ts` — a finished section is skipped with zero model calls, a timeout retries before the last attempt, and the last attempt marks the section and report failed.
- [ ] Run `bun test src/queue.test.ts` — section tasks are named per report and position, carry the worker auth token and deadline, and treat an already-existing task as success.
- [ ] Run `bun test src/auth.test.ts scripts/api-keys.test.ts` — keys have the expected shape, only their digest is stored, and revoked keys are rejected.
- [ ] Run `bun test src/metrics.test.ts && grep -q 'upstream_timeout' .flow/metrics.md` — metrics record one observation per call with the right failure type, and the metrics contract file exists.
- [ ] Run `[ -n "$TEST_DATABASE_URL" ] && psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_reports.sql -f migrations/002_partner_api.sql && bun test src/db.test.ts` against a scratch local Postgres — the migration applies, the daily limit holds under concurrent requests, and two sections finishing together leave the report done.
- [ ] Run `bash -n deploy.sh && grep -q -- '--no-allow-unauthenticated' deploy.sh && grep -q -- '--max-attempts' deploy.sh && grep -q 'SERVICE_ROLE=worker' deploy.sh` — the deploy script is valid, deploys a private worker and applies the queue limits.
- [ ] DECISION: accept that the public service stops serving the section-worker route, so any caller outside this repo that posts there directly gets "not found" and must go through the queue instead.
