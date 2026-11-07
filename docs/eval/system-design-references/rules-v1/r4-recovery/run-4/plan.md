# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Customer contract uploads

**Goal:** A customer's signed PDF contract can be uploaded once, is kept safely in private cloud storage, and is recorded so anyone can later confirm what was received and when.

## Problem Statement

This service produces company reports, but it has no way to accept documents from customers. A customer who has signed a contract must send it through some other channel, so nothing records what was received, from whom, or when, and the file may end up somewhere nobody backs up. The cost is lost or unprovable paperwork and manual chasing.

Evidence from the current service:

| Fact | Anchor |
| ---- | ------ |
| The only routes are report reads and the section-generation worker; nothing accepts a file | src/app.ts:7-17 |
| The database holds only `reports` and `sections`; there is no customer or contract record | migrations/001_reports.sql:1-14 |
| The service is deployed open to the internet, and no route checks who is calling | deploy.sh:4 |
| There is no customer entity anywhere; the closest identifier is a free-text company name on a report | migrations/001_reports.sql:3 |

Who is affected, framed against the product brief's ranked priorities: customers (priority 1, user experience: one upload, a clear yes/no answer, no surprise duplicates) and the business paying for storage (priority 2, cost: small, but every stored file is kept for good).

## Request vetting

- **Hypothesis:** Customers' signed contracts fit in a single request (10 MiB cap), so streaming them through this service into a private bucket and recording one row per file is enough, with no browser-direct upload flow.
- **Case against:** Read literally, "let customers upload" on a service deployed `--allow-unauthenticated` with no credential check creates a public, anonymous write path for legal documents. Anyone could fill the bucket or plant files under another customer's name [anchor: deploy.sh:4] [anchor: src/app.ts:7]. Separately, streaming files through Cloud Run is bounded by its per-request size ceiling (32 MiB for HTTP/1, cited from prior knowledge; the doc fetch was denied this run). Direct-to-storage signed URLs avoid that ceiling.
- **Sources:** https://docs.cloud.google.com/run/quotas (request-size ceiling, not re-fetched this run); https://docs.cloud.google.com/run/docs/configuring/request-timeout
- **Verdict:** adopt-with-conditions: every contract route rejects a request without a valid caller credential (401 test passes), and uploads over 10 MiB are refused with 413 before any storage write

## Existing-code assessment

- **src/app.ts:** keep — the regex-dispatch router takes two more routes cleanly; only `Bun.serve` gains a body-size cap [anchor: src/app.ts:7-19]
- **src/db.ts:** keep — the tagged-template `sql` style fits an insert and a lookup with no new abstraction [anchor: src/db.ts:6-17]
- **migrations/:** keep — numbered plain-SQL files; `002_contracts.sql` follows `001_reports.sql` [anchor: migrations/001_reports.sql:1]
- **deploy.sh:** keep — the idempotent `create … || true` line is the pattern for the bucket and recovery settings [anchor: deploy.sh:3]

## Scope Boundary

**In scope:**

- An authenticated upload endpoint that accepts one PDF (multipart form: `file`, `customer_id`), capped at 10 MiB, and checks the PDF header bytes.
- Storing the file in a dedicated private Cloud Storage bucket under a name derived from the customer and the file's content hash, so a retried upload never creates a second copy.
- A new `contracts` table with one row per (customer, file content).
- A metadata read endpoint, so the caller can confirm what was stored.
- A private bucket with public access blocked, object versioning, database backups with point-in-time recovery, and a restore check.
- Metrics for both endpoints and the storage call.

**Out of scope:**

- Verifying the PDF's digital signature (see Alternatives considered).
- Downloading or listing contracts (candidate follow-up: it needs its own decision on who may read them).
- Deleting contracts, legal retention locks, and any customer-facing UI.
- A customer account model. Customers stay an opaque caller-supplied id (Q-open questions below).
- Hardening the existing unauthenticated worker route (candidate follow-up).

## Behavioral contrast

### User flow

| Before | After |
| ------ | ----- |
| No way to hand a signed contract to this service | One upload call with the PDF and the customer id returns `201` with the stored record |
| — | Re-sending the same file returns `200` with the original record, and no duplicate is stored |
| — | A non-PDF, an oversized file, or a missing credential gets a clear `400` / `413` / `401` answer |
| — | Anyone holding the credential can look up a contract's record (`GET /contracts/{id}`) |

### System flow

- **Before:**
  - The service writes only report sections to Postgres and never touches Cloud Storage.
  - No route checks a credential.
- **After:**
  - Contract routes check a bearer credential (fail-closed when it is not configured); existing routes are unchanged.
  - An upload streams to a private bucket with a create-only precondition, then writes one `contracts` row in a 5 s-bounded transaction.
  - The service emits upload, lookup and storage-call metrics through a new in-process recorder.
  - Request bodies over 11 MiB are refused at the server for every route.

**Lost:** none — the change only adds things; the new 11 MiB body ceiling is far above any body the existing routes take (a JSON `{reportId, section}` payload, src/worker.ts:6).

## User Stories / Acceptance Criteria

### Story 1: Upload a signed contract

- [ ] Given a valid credential and a PDF under 10 MiB, when the caller posts it with a `customer_id`, then the response is `201` with `id`, `sha256`, `size_bytes`, and a `Location: /contracts/{id}` header, the object is written once, and one row is inserted (`bun test src/contracts.test.ts`).
- [ ] Given the same customer re-posts identical bytes, when the upload completes, then the response is `200` with the original `id` and no second row exists (`bun test src/contracts.test.ts`).
- [ ] Given the object already exists from an earlier attempt whose row insert failed, when the caller retries, then the storage call's precondition failure is treated as success and the row is inserted (`bun test src/storage.test.ts src/contracts.test.ts`).

### Story 2: Reject bad uploads before storing anything

- [ ] Given no `Authorization` header or a wrong token, when the caller posts, then the response is `401` and no storage call happens (`bun test src/contracts.test.ts`).
- [ ] Given a file over 10 MiB, when the caller posts, then the response is `413` and no storage call happens (`bun test src/contracts.test.ts`).
- [ ] Given a file whose first bytes are not `%PDF-`, an empty file, or a `customer_id` outside `^[A-Za-z0-9_-]{1,64}$`, when the caller posts, then the response is `400` (`bun test src/contracts.test.ts`).
- [ ] Given the upload credential is not configured on the server, when anyone posts, then the response is `503` (fail-closed) (`bun test src/contracts.test.ts`).

### Story 3: Confirm what was stored

- [ ] Given a stored contract, when an authenticated caller requests `GET /contracts/{id}`, then the record comes back without the storage object name; an unknown id returns `404` (`bun test src/contracts.test.ts`).

### Story 4: Storage failures are visible, not silent

- [ ] Given Cloud Storage answers `5xx` or does not answer within 8 s, when the caller uploads, then the response is `502` / `504`, no row is written, and the failures counter records `upstream_error` / `upstream_timeout` (`bun test src/contracts.test.ts src/metrics.test.ts`).

## Instrumentation

**Contract:** .flow/metrics.md create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| ------ | ---------- | ---- | -------------------------- | ---------- |
| `reports_service.contract.upload.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | upload handler |
| `reports_service.contract.upload.failures` | Counter | none | `error.type` (7 values below) | upload handler |
| `reports_service.contract.get.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | metadata handler |
| `reports_service.contract.get.failures` | Counter | none | `error.type` (7 values below) | metadata handler |
| `reports_service.storage.request.duration` | Histogram | seconds | `server.address` (`storage.googleapis.com`), `operation.outcome` (`ok`, `error`) | storage client |

Estimated series: 75 per operation (upload: 2 × 17 histogram + 7 counter + 1 × 2 × 17 storage-call histogram), per reporting instance
Estimated series: 41 per operation (metadata lookup: 2 × 17 + 7), per reporting instance

**Attributes:** new registry seeded with `error.type`, `operation.outcome`, `server.address` (closed list: `storage.googleapis.com`), added as `.flow/metrics.md` `## Attributes` rows

### Error types

| Value | Meaning |
| ----- | ------- |
| `_OTHER` | fallback: no listed class fits |
| `internal` | unexpected failure inside this service, including an unconfigured upload credential |
| `invalid_input` | not a PDF, empty, missing field, or malformed `customer_id` (client-caused) |
| `not_found` | unknown contract id (client-caused) |
| `payload_too_large` | file over the 10 MiB cap (client-caused) |
| `unauthorized` | missing or wrong credential (client-caused) |
| `upstream_error` | Cloud Storage or the metadata server answered with a failure |
| `upstream_timeout` | Cloud Storage or the metadata server did not answer in time |

(7 values reachable per operation: the upload never emits `not_found`, and the lookup never emits `payload_too_large`.)

### Dashboard panels

- "Contract uploads: rate and p95 latency by outcome" — lands on the `reports-service overview` dashboard (spec-only).
- "Contract upload failures by error.type" — same dashboard.
- "Cloud Storage call p95 latency" — same dashboard.

### Alerts

burn-rate tiers only

### SLO

New journey SLO "contract upload": 99.5% of uploads that are not client-caused (excluding `invalid_input`, `payload_too_large`, `unauthorized`) succeed over 28 days; p95 server time under 5 s.

**As-code:** spec-only — the repo keeps no dashboard or alert config, and no metrics backend is chosen yet (suggested: Google Cloud Monitoring)

## Architecture Decisions

| Aspect | Decision |
| ------ | -------- |
| Layers touched | DB schema, storage integration, HTTP handlers, deploy/infra, metrics |
| Domain modules | existing `src/app.ts`, `src/db.ts`; new `src/contracts.ts` (handlers), `src/storage.ts` (Cloud Storage client), `src/metrics.ts` (recorder) |
| Data flow | caller posts multipart, then the service authenticates, validates size and header bytes, hashes, writes create-only to the bucket, inserts the row (on conflict returns the existing row), and responds |
| Pattern | plain-`fetch` Google API client with no SDK, the same approach `src/queue.ts:5` uses for Cloud Tasks; idempotent `|| true` infra lines in `deploy.sh` |
| Binary-framing check | The request implies "stream through the service" without saying so. A: stream-through. Middle: stream-through behind a storage-module seam, so signed-URL uploads can be added later for files over 10 MiB. B: signed-URL direct upload. The plan takes the middle (see Decision analysis). |
| Goal-anchor check | "Customers upload" read literally conflicts with the goal's "kept safely" on a public, credential-free service, so the plan adds a caller credential the request did not mention (Q1). |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --------- | -------- | --------------- | ------------------ | ------- | --------------- | ---------- |
| `POST /contracts` (server time after body received) | ~4 s (estimate, unmeasured) | inline | storage write 8 s; token fetch 2 s; DB transaction `statement_timeout` 5 s | none server-side; caller retries safely | `(customer_id, sha256)`: object name `contracts/{customer_id}/{sha256}.pdf` written with create-only precondition plus a unique row constraint | 10 MiB per upload; byte-identical repeats store nothing new; credential-gated caller |
| Metadata-server token fetch | inline — 50 ms, timeout 2 s | inline, cached until 60 s before expiry | 2 s | none | n/a (read) | free |
| `GET /contracts/{id}` | inline — 50 ms, timeout 5 s | inline | `statement_timeout` 5 s | none | n/a (read) | free |

**Platform:** gcp

**Proportionality:** no queue, worker or status resource: one upload is a single bounded storage write plus one insert, well under the 10 s interactive budget. No signed-URL flow until a contract over 10 MiB is seen. No per-caller rate limiter, because the endpoint is credential-gated to a trusted caller (revisit with Q1). No service-wide `--max-instances` change, since that would also cap report generation.

**Recovery:** contracts are irreplaceable customer input. Task 7 enables Cloud SQL automated backups and point-in-time recovery on `${CLOUD_SQL_INSTANCE:?}`, creates the bucket with object versioning, and adds `scripts/restore-check.sh`. That script clones the instance to a point in time and compares the `contracts` row count, then checks that a noncurrent object version can be read back. Run it quarterly and after any backup config change.

**Rollback:** Task 1 — `migrations/002_contracts.down.sql` drops the table; its acceptance applies down then up against a local Postgres. Routes and bucket are additive, so a redeploy of the previous revision removes the routes.

## Technical Constraints

- No new runtime dependency: Cloud Storage is called over `fetch` with a metadata-server token, and multipart parsing uses Bun's built-in `Request.formData()` (AGENTS.md: "No new runtime dependencies without a reason").
- The body cap must stay under Cloud Run's per-request ceiling (32 MiB HTTP/1, from prior knowledge), so `Bun.serve` gets `maxRequestBodySize: 11 MiB` and the handler enforces 10 MiB on the file itself.
- The bucket must block public access and use uniform bucket-level access, because the service itself is public (deploy.sh:4).
- The upload credential lives in Secret Manager and is mounted as `CONTRACTS_UPLOAD_TOKEN`; it is never baked into the image (Dockerfile:1-6 copies only `src`).
- The database layer uses Bun's `sql` tagged template (src/db.ts:1); a `bigint` column may come back as a string, so `size_bytes` is converted to a number at the persistence boundary.
- Cost implication: Cloud Storage Standard in us-central1 is about $0.02 per GB-month at list price (not re-checked this run); 1,000 contracts at 2 MB each is about $0.04/month, plus versioned copies, which only appear if an object is overwritten (the create-only precondition prevents that).

## Open Questions

- [ ] Q1. Who calls the upload endpoint: a trusted backend that customers already use, or customer browsers directly? This changes the credential model. A trusted backend means one shared token (this plan); browsers mean per-customer credentials and probably signed-URL uploads, a different Task 5 and a new auth module.
  - **Stakes:** both — if customers call directly, a shared token would have to ship to browsers, and anyone could upload as any customer (priority 1 user trust and priority 3 system design).
  - **Needs user input:** an external fact the agent cannot verify — the repo has no front-end, no customer table, and no reference to any upstream caller. deliberated (medium): ask before designing per-customer authentication, and meanwhile build only the caller-agnostic parts [confidence: medium] [anchor: adjacent: src/app.ts]. The plan builds the caller-agnostic core and keeps the credential check behind one small `authorize(req)` function that fails closed with a shared bearer token, so a different model replaces one function.
- [ ] How is a customer identified? This changes the schema and the object path.
  - **Stakes:** both — a wrong identifier means contracts filed under ids nobody else can join on (priority 4 product quality).
  - **Recommended:** a caller-supplied opaque `customer_id` text field (`^[A-Za-z0-9_-]{1,64}$`), with no customers table — the service already identifies reports' owners with a free-text field rather than a foreign key, and the pattern keeps the value safe inside the storage object path [confidence: medium] [anchor: adjacent: migrations/001_reports.sql:3]
- [ ] What is the maximum file size? This changes the cap constant, the server body limit, and whether a signed-URL flow is needed now.
  - **Stakes:** user — a customer with a large scanned contract is turned away with `413`.
  - **Recommended:** 10 MiB — enough for a multi-page scanned contract, and it keeps the in-memory body and the request well under Cloud Run's per-request ceiling, so no second upload path is needed in v1 [confidence: medium] [anchor: weighing: risk — 3x headroom under the platform ceiling with a single code path]
- [ ] What happens when the same customer uploads the same file twice? This changes the unique constraint, the object naming, and the response code.
  - **Stakes:** both — without dedupe, a client retry after a timeout stores a duplicate contract and doubles storage (priority 1 surprises, priority 2 cost).
  - **Recommended:** dedupe on `(customer_id, sha256)`: return `200` with the original record — it makes caller retries safe with no server-side retry layer [confidence: medium] [anchor: weighing: reversibility — the constraint can be dropped later; duplicate rows cannot be cleanly merged]
- [ ] What request shape does the upload take? This changes the client contract.
  - **Stakes:** user — a caller built for a different shape must be rewritten.
  - **Recommended:** `multipart/form-data` with fields `file` and `customer_id` — it is the shape browser forms and every HTTP client send by default, it carries the original filename, and Bun parses it with no new dependency [confidence: medium] [anchor: weighing: convention — the default file-upload encoding of HTML forms and HTTP clients]
- [ ] Should "signed" be verified? This changes whether a PDF signature parser is added.
  - **Stakes:** user — unsigned contracts would be accepted as if signed.
  - **Recommended:** no — accept any well-formed PDF and treat "signed" as the customer's description of the document; verifying signatures needs a PDF/CMS parser, which is a new runtime dependency [confidence: medium] [anchor: weighing: footprint — AGENTS.md forbids new runtime dependencies without a reason, and the request does not ask for verification]
- [x] How is the migration applied? — resolved without asking: the same way as `001_reports.sql`, by hand against Cloud SQL, because the repo has no migration runner.
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision A — How do the file bytes reach Cloud Storage?**

| Branch | End-to-end caller flow | Friction | System consequence |
| ------ | ---------------------- | -------- | ------------------ |
| A1: stream through the service (chosen) | Caller sends one multipart POST, waits ~1-4 s, gets `201` with the record | 0 interruptions; 1 request | Body passes through Cloud Run memory (bounded at 11 MiB); one code path; nothing is left orphaned or half-done |
| A2: signed-URL direct upload | Caller POSTs metadata, receives a URL, PUTs the file to Cloud Storage, then POSTs "finalize"; three requests, each of which can fail on its own | 0 interruptions; 3 requests | No size ceiling. Needs IAM `signBlob` permission, a `pending` row state, and a sweeper for abandoned uploads |
| A-middle: A1 now, with the storage client behind a module seam so A2 can be added for files over 10 MiB | Same as A1 today | 0 interruptions; 1 request | Same as A1; A2 stays additive later |

A1 and A2 are mutually exclusive as the v1 default; A2 is complementary later as an extra path for large files. Ranked: A-middle > A1 > A2 (A2 triples the caller's work and adds a pending state for a size problem nobody has reported).

Verdict: **A-middle** — single-request upload now, signed URLs only if a real contract exceeds 10 MiB [confidence: medium] [anchor: weighing: footprint — one endpoint and no pending state versus three endpoints, a sweeper and an IAM grant]

## Alternatives considered

- **Verify PDF digital signatures in the service** — rejected: needs a PDF/CMS parsing dependency, against AGENTS.md's "No new runtime dependencies without a reason", and the request never asks for verification.
- **Use the official Cloud Storage SDK** — rejected: a new runtime dependency (AGENTS.md), when src/queue.ts:5 already calls a Google API over plain `fetch`.
- **Bun's built-in S3 client against the Cloud Storage interop endpoint** — rejected: it needs long-lived HMAC keys stored as secrets, while the Cloud Run service account's metadata-server token needs none.

## Recommendation

**Reconsider scope** — build the upload as asked, plus two additions the request did not name: a fail-closed caller credential on a service that is otherwise public, and a metadata lookup so callers can confirm receipt. Q1 decides whether the shared-token credential is the final model [confidence: medium] [anchor: weighing: risk — deploy.sh:4 makes every route public, and these are legal documents]

**Redundancy:** none found — no existing route, table or module accepts or stores files (src/app.ts, src/db.ts, migrations/001_reports.sql).

## Plan risks

The weakest assumption is that a trusted backend is the caller (Q1). If customers' browsers call directly, the shared token cannot be kept secret, and the credential model plus possibly the upload path (signed URLs) must change before this is safe to expose.

## Cut list

- No per-stage upload timing metric — the storage-call histogram already isolates the only slow stage, and per-stage series would push the upload past 100 series.
- No list or download endpoints and no `pending` row state — none is needed for "upload and record", and each would force the open read-authorization decision now.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --------- | ----- | ---------- | --------- | --------------------------- | ------------------------ |
| The section-generation worker route is public | High | Medium | needs its own design/decision session: the open decision is whether to split the worker into a private Cloud Run service or verify Cloud Tasks OIDC tokens in the handler; an open route lets anyone trigger paid model calls | unrelated to this feature; surfaced while auditing the service's public routes | No |
| Contracts can be uploaded but not listed or downloaded through the service. | Medium | Medium | needs its own design/decision session: the open decision is who may read a contract (the uploading caller, staff, or per-customer access), which depends on Q1's answer | natural next step after upload; deliberately out of scope here | No |

- [x] The section-generation worker route is public — anyone can trigger paid model calls and overwrite report sections.
  - **UX:** none
  - **Problem:** `POST /tasks/generate-section` runs a paid model call and overwrites a section for any caller, on a service deployed `--allow-unauthenticated` [anchor: src/app.ts:9]
  - **Stability/efficiency:** each call is a paid model call taking 20-60 s, with no caller check before it [anchor: src/llm.ts:1]
  - **Value rank:** 5 — security exposure: unauthenticated paid work plus overwrite of stored report content [anchor: deploy.sh:4]
  - **Complexity:** Medium — the worker route, deploy flags, and the queue's OIDC configuration
  - **Risk:** Medium — misconfiguration stops section generation entirely
  - **If never done:** anyone who finds the URL can run up model spend and replace report sections
  - **Verdict:** clears bar — a live, unauthenticated paid path outweighs a Medium change
- [ ] Contracts can be uploaded but not listed or downloaded through the service.
  - **UX:** callers wanting a stored contract back must ask someone with cloud-console access [anchor: user: "let customers upload their signed PDF contracts"]
  - **Problem:** none
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent gap: nobody has yet asked to retrieve a contract [anchor: user: "let customers upload their signed PDF contracts"]
  - **Complexity:** Medium — two routes plus a read-authorization model
  - **Risk:** Medium — wrong read rules leak contracts between customers
  - **If never done:** retrieval stays a manual console task
  - **Verdict:** below bar — no observed retrieval need yet, and its authorization model waits on Q1

# Task breakdown

### Task 1: Contracts table migration

- **Skill:** `flow-system-design`
- **Description:** Add the `contracts` table and its down migration.
- **Inputs:** migrations/001_reports.sql (numbering and style precedent)
- **Outputs:** an applied `contracts` table; a reversible down script
- **Contract:**
  - **Files:** `migrations/002_contracts.sql` (create), `migrations/002_contracts.down.sql` (create)
  - **Interfaces:** Schema DDL:
    ```sql
    create table contracts (
      id text primary key,
      customer_id text not null check (customer_id ~ '^[A-Za-z0-9_-]{1,64}$'),
      object_name text not null unique,
      original_filename text not null check (length(original_filename) between 1 and 255),
      size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
      sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
      created_at timestamptz not null default now(),
      unique (customer_id, sha256)
    );
    ```
    Down: `drop table contracts;`
  - **Call-site edits:** none
- **Acceptance criteria:** `grep -q 'unique (customer_id, sha256)' migrations/002_contracts.sql && psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_reports.sql -f migrations/002_contracts.sql -f migrations/002_contracts.down.sql -f migrations/002_contracts.sql` against a scratch local Postgres (`docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=pg postgres:16`, `DATABASE_URL=postgres://postgres:pg@localhost:5432/postgres`)

### Task 2: Metrics helper and metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create the repo's first metrics helper: an in-memory, swappable recorder with a closed `ErrorType` union (`_OTHER`, `internal`, `invalid_input`, `not_found`, `payload_too_large`, `unauthorized`, `upstream_error`, `upstream_timeout`) and a typed attribute map. Create `.flow/metrics.md` with Backend `none yet — suggested: Google Cloud Monitoring`, Namespace `reports_service`, Attributes, error.type values, Helper, Dashboard panels, Dashboards, Alerts (burn-rate tiers), As-code `spec-only`, SLOs (contract upload), and Coverage (the three operations in the Instrumentation section).
- **Inputs:** new: src/metrics.ts
- **Outputs:** `instrument` and `recordOutbound` helpers; the committed metrics contract
- **Contract:**
  - **Files:** `src/metrics.ts` (create), `src/metrics.test.ts` (create), `.flow/metrics.md` (create)
  - **Interfaces:**
    - `export type ErrorType = "_OTHER" | "internal" | "invalid_input" | "not_found" | "payload_too_large" | "unauthorized" | "upstream_error" | "upstream_timeout"`
    - `export type Recorder = { histogram(name: string, seconds: number, attrs: Attributes): void; counter(name: string, attrs: Attributes): void }`
    - `export function setRecorder(r: Recorder): void`
    - `export function memoryRecorder(): Recorder & { histograms: Array<{ name: string; seconds: number; attrs: Attributes }>; counters: Array<{ name: string; attrs: Attributes }> }`
    - `export async function instrument<T>(op: "contract.upload" | "contract.get", fn: () => Promise<T>, classify: (result: T | unknown) => ErrorType | null): Promise<T>`, which records `reports_service.<op>.duration` with `operation.outcome`, plus `.failures` with `error.type` when `classify` returns non-null
    - `export async function recordOutbound<T>(address: "storage.googleapis.com", fn: () => Promise<T>): Promise<T>`
    - `export function toErrorType(value: string): ErrorType` (unknown maps to `_OTHER`)
  - **Call-site edits:** none (consumed by Tasks 3 and 5)
- **Acceptance criteria:** `bun test src/metrics.test.ts` (success observation; one failure per error-type branch; unknown value becomes `_OTHER`) `&& test -f .flow/metrics.md && grep -q 'payload_too_large' .flow/metrics.md`

### Task 3: Cloud Storage client

- **Skill:** `flow-system-design`
- **Description:** A create-only object writer over the Cloud Storage JSON API: `POST https://storage.googleapis.com/upload/storage/v1/b/{CONTRACTS_BUCKET}/o?uploadType=media&name={encoded}&ifGenerationMatch=0`. `200` means created; `412` means already present (success, `created: false`); anything else throws `StorageError("upstream_error")`; an abort throws `StorageError("upstream_timeout")`. The access token comes from the metadata server (`Metadata-Flavor: Google`, 2 s timeout) and is cached until 60 s before expiry. Storage write timeout is 8 s via `AbortSignal.timeout`. Wrapped in `recordOutbound`.
- **Inputs:** src/queue.ts (plain-fetch Google API precedent); src/metrics.ts (Task 2)
- **Outputs:** `putObjectIfAbsent`
- **Contract:**
  - **Files:** `src/storage.ts` (create), `src/storage.test.ts` (create)
  - **Interfaces:**
    - `export class StorageError extends Error { constructor(readonly kind: "upstream_error" | "upstream_timeout", message: string) }`
    - `export async function putObjectIfAbsent(name: string, bytes: Uint8Array, contentType: "application/pdf"): Promise<{ created: boolean }>`
  - **Call-site edits:** none (consumed by Task 5)
- **Acceptance criteria:** `bun test src/storage.test.ts` (mocked `fetch`: 200 gives created true; 412 gives created false; 503 throws `upstream_error`; a hung request throws `upstream_timeout` after the timeout; the token is fetched once across two writes)

### Task 4: Contract persistence

- **Skill:** `flow-new-feature`
- **Description:** Add the contract type plus an insert-or-return-existing and a lookup, using the existing tagged-template style. The insert runs in `sql.begin` with `set local statement_timeout = '5s'`, using `insert … on conflict (customer_id, sha256) do nothing returning *`, falling back to a select by `(customer_id, sha256)`. `size_bytes` is converted to a number.
- **Inputs:** src/db.ts; Task 1 schema
- **Outputs:** `insertContract`, `getContract`
- **Contract:**
  - **Files:** `src/db.ts` (edit)
  - **Interfaces:**
    - `export type Contract = { id: string; customer_id: string; object_name: string; original_filename: string; size_bytes: number; sha256: string; created_at: string }`
    - `export async function insertContract(c: Omit<Contract, "created_at">): Promise<{ contract: Contract; created: boolean }>`
    - `export async function getContract(id: string): Promise<Contract | undefined>`
  - **Call-site edits:** none (consumed by Task 5)
- **Acceptance criteria:** `bun build src/db.ts --target=bun --outdir=/tmp/flow-build-check >/dev/null && grep -q 'on conflict (customer_id, sha256)' src/db.ts`

### Task 5: Upload and lookup handlers

- **Skill:** `flow-new-feature`
- **Description:** `POST /contracts` steps, in order:
  1. `authorize` (bearer token, constant-time compare against `CONTRACTS_UPLOAD_TOKEN`; unset gives `503`)
  2. reject `Content-Length` over cap + 64 KiB with `413`
  3. `req.formData()`; require `file` (a File) and `customer_id`
  4. `file.size` 1..10 MiB, else `413`/`400`
  5. first 5 bytes equal `%PDF-`, else `400`
  6. sha256 hex
  7. `putObjectIfAbsent("contracts/{customer_id}/{sha256}.pdf")`
  8. `insertContract` with `crypto.randomUUID()`
  9. respond `201` (or `200` on duplicate) with `{ id, customer_id, filename, size_bytes, sha256, created_at }` and `Location`

  `StorageError` maps to `502`/`504`. `GET /contracts/{id}` requires the same credential and returns the record without `object_name`, or `404`. Error bodies keep the existing `{ error }` shape. Both are wrapped in `instrument`.
- **Inputs:** src/storage.ts (Task 3), src/db.ts (Task 4), src/metrics.ts (Task 2), src/app.ts
- **Outputs:** two live routes
- **Contract:**
  - **Files:** `src/contracts.ts` (create), `src/app.ts` (edit)
  - **Interfaces:**
    - `export const MAX_CONTRACT_BYTES = 10 * 1024 * 1024`
    - `export function authorize(req: Request): "ok" | "unauthorized" | "not_configured"`
    - `export async function handleUploadContract(req: Request): Promise<Response>`
    - `export async function handleGetContract(req: Request, id: string): Promise<Response>`
  - **Call-site edits:** `src/app.ts` `handle`: add `POST /contracts` to `handleUploadContract` and `GET /contracts/{id}` (`/^\/contracts\/([^/]+)$/`) to `handleGetContract`; `src/app.ts` `Bun.serve` call: add `maxRequestBodySize: 11 * 1024 * 1024`
- **Acceptance criteria:** `bun build src/app.ts --target=bun --outdir=/tmp/flow-build-check >/dev/null && grep -q 'maxRequestBodySize' src/app.ts`

### Task 6: Handler tests

- **Skill:** `flow-testing`
- **Description:** Tests through `handle()` with `mock.module("./db")` and `mock.module("./storage")` and the metrics `memoryRecorder`, covering every acceptance criterion in Stories 1-4: 201, 200 duplicate, retry after a 412 inserts the row, 401, 503 unconfigured, 413 (header and actual size), 400 (not a PDF, empty, bad `customer_id`, missing field), 502/504 with no insert, GET 200 without `object_name`, GET 404, and the matching `error.type` increments.
- **Inputs:** Tasks 2-5
- **Outputs:** regression coverage for the endpoints
- **Contract:**
  - **Files:** `src/contracts.test.ts` (create)
  - **Interfaces:** none (tests only)
  - **Call-site edits:** none
- **Acceptance criteria:** `bun test src/contracts.test.ts`

### Task 7: Bucket, secret and recovery wiring

- **Skill:** `flow-system-design`
- **Description:** Make deploy create and secure the bucket, mount the credential, and turn on database recovery; add a restore check.
- **Inputs:** deploy.sh
- **Outputs:** a private versioned bucket; PITR on; a runnable restore check
- **Contract:**
  - **Files:** `deploy.sh` (edit), `scripts/restore-check.sh` (create)
  - **Interfaces:** Config/infra, before → after in `deploy.sh`:
    - add `gcloud storage buckets create "gs://${CONTRACTS_BUCKET:?}" --location us-central1 --uniform-bucket-level-access --public-access-prevention || true`
    - add `gcloud storage buckets update "gs://${CONTRACTS_BUCKET}" --versioning`
    - add `gcloud storage buckets add-iam-policy-binding "gs://${CONTRACTS_BUCKET}" --member "serviceAccount:${RUN_SERVICE_ACCOUNT:?}" --role roles/storage.objectCreator`
    - add `gcloud sql instances patch "${CLOUD_SQL_INSTANCE:?}" --backup-start-time 03:00 --enable-point-in-time-recovery`
    - `gcloud run deploy` line: append `--set-env-vars CONTRACTS_BUCKET=${CONTRACTS_BUCKET} --set-secrets CONTRACTS_UPLOAD_TOKEN=contracts-upload-token:latest`

    `scripts/restore-check.sh`:
    - `gcloud sql instances clone "$CLOUD_SQL_INSTANCE" "$CLOUD_SQL_INSTANCE-restore-check" --point-in-time "$(date -u -d '-1 hour' +%FT%TZ)"`
    - compare `select count(*) from contracts` on the clone with the source
    - `gcloud storage ls --all-versions "gs://$CONTRACTS_BUCKET/contracts/" | head -1` must be non-empty
    - delete the clone; exit non-zero on any mismatch
  - **Call-site edits:** none
- **Acceptance criteria:** `bash -n deploy.sh && bash -n scripts/restore-check.sh && grep -q -- '--enable-point-in-time-recovery' deploy.sh && grep -q -- '--public-access-prevention' deploy.sh && grep -q -- '--versioning' deploy.sh`

| Task | Depends on |
| ---- | ---------- |
| 1 | — |
| 2 | — |
| 3 | 2 |
| 4 | 1 |
| 5 | 2, 3, 4 |
| 6 | 5 |
| 7 | — |

### Skills Summary

| Skill | Recommended? | Reason |
| ----- | ------------ | ------ |
| flow-system-design | Yes (Tasks 1, 3, 7) | New table, outbound storage call with timeout/idempotency, and recovery settings |
| flow-metrics | Yes (Task 2) | First instrumented change: creates the helper and `.flow/metrics.md` |
| flow-new-feature | Yes (Tasks 4, 5) | New persistence functions and user-facing endpoints |
| flow-testing | Yes (Task 6) | Endpoint behaviour tests with mocked storage and database |
| flow-ui-ux | No | No UI surface; the caller is an API client |
| flow-refactoring | No | Existing modules are extended in place; no cleanup needed |

# PR description draft

## TLDR

Customers' signed PDF contracts can now be uploaded to the service, which keeps them in private, versioned cloud storage and records each one; before, there was no way to hand over a contract at all.

## User-facing changes

- New upload endpoint: posting a PDF (up to 10 MiB) with a customer id returns the stored contract's record, including its content fingerprint and size.
- Re-sending the same file for the same customer returns the original record instead of storing a duplicate.
- Non-PDF files, oversized files, and requests without the upload credential are refused with a clear reason (`400`, `413`, `401`) before anything is stored.
- New lookup endpoint: an authenticated caller can fetch a contract's record by id to confirm it was received.

## System changes

- Contract routes require a bearer credential and refuse all requests when it is not configured:
  - **Before:** no route in the service checked who was calling.
  - **After:** the two contract routes check a credential held in Secret Manager; existing report routes are unchanged.
- The service now writes to a dedicated Cloud Storage bucket with public access blocked and object versioning on, using create-only writes so a retried upload never overwrites or duplicates a file.
- Database recovery is now enforced at deploy: automated backups and point-in-time recovery are turned on, and a restore-check script proves a restore works.
- Request bodies over 11 MiB are now refused server-wide:
  - **Before:** the server accepted any body size up to the platform limit.
  - **After:** bodies over 11 MiB are refused; the existing routes only take small JSON bodies.
- Ongoing cost: storage at about $0.02 per GB-month at list price, roughly $0.04/month per 1,000 two-megabyte contracts. There are no paid model calls on this path.

## Why

Customers who sign a contract have no way to give it to this service, so nothing records what was received, from whom, or when, and the file may end up somewhere unbacked-up. These are legal documents: losing one, or being unable to show it arrived, costs far more than storing it.

## Key decisions

- Files stream through the service in one request, not via signed direct-to-storage URLs: one call for the caller and no half-finished uploads to clean up. Signed URLs can be added later if a contract over 10 MiB ever shows up.
- A shared bearer credential gates the contract routes, because the service is publicly reachable. It is an interim model, pending confirmation of who the real caller is (a trusted backend or customer browsers).
- Duplicates are detected by customer plus file fingerprint, which makes caller retries safe without any server-side retry logic.
- Signatures inside the PDF are not verified: that would need a new PDF-parsing dependency, and the request did not ask for proof.
- Customers are identified by a caller-supplied id; no customer accounts are introduced.
- Out of scope: listing, downloading or deleting contracts, and locking down the existing public report-generation worker route (filed as a follow-up).
- Bundled: the service's first metrics helper and metrics contract, which this change needs in order to report upload health.

## Instrumentation

Spec-only: no dashboard URL exists yet, and no metrics backend is chosen (suggested: Google Cloud Monitoring), so these metrics are recorded in-process but won't show on any graph until a backend is picked. This PR creates `.flow/metrics.md` with the contract-upload and contract-lookup duration and failure metrics and the storage-call latency metric. It adds three panels to the planned "reports-service overview" dashboard (upload rate and p95 by outcome, upload failures by error type, storage-call p95), burn-rate alert tiers, and a new "contract upload" SLO: 99.5% of non-client-caused uploads succeed over 28 days.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/contracts.test.ts` — upload (201, duplicate 200, retry-after-partial), rejection (401, 503, 413, 400), storage-failure (502/504) and lookup (200/404) specs all pass.
- [ ] Run `bun test src/storage.test.ts` — create-only write, already-exists, upstream error, timeout and token-caching specs pass.
- [ ] Run `bun test src/metrics.test.ts` — success, per-error-type failure and `_OTHER` fallback emission specs pass.
- [ ] Start a scratch Postgres with `docker run -d --name contracts-pg -p 5432:5432 -e POSTGRES_PASSWORD=pg postgres:16`.
- [ ] Run `psql postgres://postgres:pg@localhost:5432/postgres -v ON_ERROR_STOP=1 -f migrations/001_reports.sql -f migrations/002_contracts.sql -f migrations/002_contracts.down.sql -f migrations/002_contracts.sql` — exits 0, proving the migration applies, rolls back and re-applies.
- [ ] Run `bash -n deploy.sh && bash -n scripts/restore-check.sh && grep -q -- '--enable-point-in-time-recovery' deploy.sh && grep -q -- '--public-access-prevention' deploy.sh` — deploy wiring is present and parses.
- [ ] DECISION: you accept a single shared upload credential held by a trusted calling backend as the v1 access model, knowing it is unsafe if customers' browsers call the service directly.
