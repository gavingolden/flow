# PRD

# Customer contract uploads

**Goal:** A customer's signed PDF contract, once submitted, is kept privately in Cloud Storage with a database record, and only authenticated callers can submit one.

## Problem Statement

Customers sign contracts with us, and today there is no place for them to hand those signed PDFs back. Signed copies end up in email threads or on someone's laptop, where they can be lost, are hard to find again, and are tied to no customer record. The service also has no idea who a "customer" is, and every endpoint it exposes is open to the whole internet, so a contract store added the naive way would accept, and could leak, legally sensitive documents from anyone.

| Evidence | What it shows |
| --- | --- |
| Routes in the service: only `GET /reports/{id}` and the section worker callback [anchor: src/app.ts:7-17] | No upload path and no contract concept exists |
| Schema: only `reports` and `sections` [anchor: migrations/001_reports.sql] | No `contracts` table, no customers table; the only party field is free-text `reports.company` |
| Deploy: `gcloud run deploy ... --allow-unauthenticated` [anchor: deploy.sh:4] | No authentication anywhere; any caller reaches every route |
| No Cloud Storage client, bucket, or dependency [anchor: package.json] | Storage access must be built (no SDK; AGENTS.md forbids new runtime deps without a reason) |

**Premise check:** the request assumes "customers" can be identified and allowed to upload; the codebase has no customer identity and no authentication at all (public Cloud Run service, no customers table), so the plan must add a caller credential and decide who the caller is (Q1) before the feature is safe to ship.

> Research findings (prior context, discovery Step 1.5). Gather ran; both adversarial refute checks failed on a provider quota, so every claim below is **unrefuted** and is used only where the plan also holds without it.
> - [high, unrefuted] Cloud Run rejects HTTP/1 request bodies over 32 MiB (end-to-end HTTP/2 lifts the cap) — https://cloud.google.com/run/quotas
> - [high, unrefuted] Google recommends direct-to-bucket uploads (signed URL or a backend-started resumable session) to keep bytes off app servers; the docs are silent against proxying small files that need server-side inspection — https://cloud.google.com/storage/docs/resumable-uploads
> - [high, unrefuted] Bun's built-in S3 client works with Cloud Storage only through long-lived HMAC keys; it cannot use Cloud Run's keyless identity — https://bun.com/docs/runtime/s3
> - [high, unrefuted] Keyless signed URLs on Cloud Run need the IAM `signBlob` call plus `roles/iam.serviceAccountTokenCreator`; a create-only bucket role is `roles/storage.objectCreator` — https://cloud.google.com/storage/docs/access-control/signing-urls-manually

## Request vetting

- **Hypothesis:** an authenticated caller can POST a PDF of at most 20 MiB to this public Cloud Run service, which validates it, writes it to a private bucket under a content-derived name, and records one `contracts` row, with retries converging on one object and one row.
- **Case against:** the service is deployed `--allow-unauthenticated` with zero auth [anchor: deploy.sh:4], so "let customers upload" taken literally creates an anonymous write path for legally sensitive files plus storage spend nobody caps; and Google's own guidance prefers direct-to-bucket uploads over proxying bytes through app containers (https://cloud.google.com/storage/docs/resumable-uploads), which bounds this design at Cloud Run's 32 MiB body limit.
- **Sources:** https://cloud.google.com/storage/docs/resumable-uploads, https://cloud.google.com/run/quotas
- **Verdict:** adopt-with-conditions: the upload route returns 401 for any request without the valid caller key, 503 when the key is unconfigured, and the bucket has public access prevention enforced so no stored contract is ever publicly readable
- **Per-part:** storage in Cloud Storage + `contracts` table — adopt as asked; upload transport — proxy through the service (Decision A); caller identity — shared service key, pending Q1 (Decision B).

## Existing-code assessment

- **src/app.ts (request router):** keep — the regex-match dispatch takes one more route cleanly [anchor: src/app.ts:10]
- **src/db.ts (Postgres access):** keep — the tagged-template `sql` pattern extends with two contract functions [anchor: src/db.ts:6-9]
- **migrations/ (schema):** keep — numbered plain-SQL files; add `002_contracts.sql` [anchor: migrations/001_reports.sql]
- **deploy.sh (infra):** keep — idempotent `create ... || true` provisioning style extends to the bucket, secret and env wiring [anchor: deploy.sh:3]

## Scope Boundary

**In scope:**

- `POST /customers/{customerId}/contracts` accepting one PDF (raw `application/pdf` body, optional `filename` query parameter), max 20 MiB.
- Caller authentication with a bearer service key; fail closed when unconfigured.
- Validation: PDF magic bytes, declared content type, non-empty, size cap; safe `customerId` charset.
- Private Cloud Storage bucket (public access prevention, uniform access, object versioning) and the object write via the Cloud Storage JSON API with Cloud Run's keyless identity.
- New `contracts` table; duplicate uploads of the same file for the same customer return the existing record.
- Backups/point-in-time recovery verification for the database and a recovery check script.
- Metrics helper, `.flow/metrics.md`, upload metrics and emission tests.

**Out of scope:**

- Listing, downloading, or deleting contracts (no read path in this PR).
- Verifying the PDF's cryptographic signature ("signed" is taken as business state, Q5).
- Malware scanning, OCR, or contract field extraction.
- A customers table or per-customer credentials (unless Q1 redirects).
- Any UI.
- Securing the existing section-worker route (candidate follow-up #1).

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| No way to submit a signed contract to the service | The calling app sends the PDF to `POST /customers/{customerId}/contracts` and gets back the contract record (id, filename, size, upload time) |
| — | Re-sending the same file for the same customer returns the original record instead of storing a second copy |
| — | A non-PDF, empty, or over-20 MiB file is refused with a clear error naming the reason; a missing or wrong key is refused with 401 |

### System flow

- **Before:**
  - The service serves report reads and the section-worker callback; it holds no files and talks to no storage bucket.
- **After:**
  - An authenticated upload is validated in memory, hashed, written once to a private bucket under `contracts/{customerId}/{sha256}.pdf`, then recorded as one `contracts` row.
  - The service fetches a short-lived access token from the Cloud Run metadata server (cached) to call Cloud Storage; no key file or HMAC secret exists.
  - At most 4 uploads are processed concurrently per instance; extra ones get 503 with `Retry-After`.

**Lost:** none — purely additive (new route, table, bucket); no existing behaviour changes.

## User Stories / Acceptance Criteria

### Story 1: Authenticated caller uploads a signed contract

- [ ] Given a valid key and a valid PDF, when it is POSTed, then the response is 201 with `{id, customerId, filename, sizeBytes, sha256, uploadedAt}`, one object is written, and one row is inserted — asserted in `src/contracts.test.ts` (`bun test src/contracts.test.ts` exits 0).
- [ ] Given the same file for the same customer is POSTed again, then the response is 200 with the original `id` and no second row or object write — asserted in `src/contracts.test.ts`.

### Story 2: Bad requests are refused before anything is stored

- [ ] Given no `Authorization` header or a wrong key, then 401 and zero storage/database calls — `src/contracts.test.ts`.
- [ ] Given `CONTRACTS_API_KEY` is unset, then 503 (fail closed) — `src/contracts.test.ts`.
- [ ] Given a body not starting with `%PDF-`, or a non-`application/pdf` content type, then 415; given an empty body, 400; given more than 20 MiB, 413 — `src/contracts.test.ts`.
- [ ] Given a `customerId` outside `[A-Za-z0-9_-]{1,64}`, then 400 — `src/contracts.test.ts`.

### Story 3: Storage failures are visible, not silent

- [ ] Given Cloud Storage times out or returns 5xx, then the response is 502, no row is inserted, and `reports.contract.upload.failures` records `upstream_timeout` / `upstream_error` — `src/contracts.test.ts`.
- [ ] Given the object already exists (412 precondition), then the upload is treated as stored and the row is recorded — `src/storage.test.ts`.

### Story 4: Stored contracts are private and recoverable

- [ ] Given `deploy.sh`, then it creates the bucket with public access prevention and uniform access, enables versioning, and mounts the key from Secret Manager — `bash -n deploy.sh && grep -q -- '--public-access-prevention' deploy.sh` exits 0.
- [ ] Given `scripts/check-recovery.sh` is run against the project, then it exits non-zero unless Cloud SQL point-in-time recovery and bucket versioning are both on — `bash -n scripts/check-recovery.sh` exits 0 (live run is post-deploy).

## Instrumentation

**Contract:** .flow/metrics.md create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports.contract.upload.duration` | Histogram | seconds | `operation.outcome` (ok, error) | upload handler |
| `reports.contract.upload.failures` | Counter | none | `error.type` (the 9 values below) | upload handler |
| `reports.storage.call.duration` | Histogram | seconds | `server.address` (storage.googleapis.com), `operation.outcome` (ok, error) | storage client |

Estimated series: 34 (duration: 2 × 17) + 9 (failures) = 43 per operation for the upload, and 34 (1 host × 2 × 17) for the storage call — 77 per instance total.

**Attributes:** new keys with their closed values, added as `.flow/metrics.md` `## Attributes` rows: `operation.outcome` (ok, error), `error.type` (closed list below), `server.address` (storage.googleapis.com).

### Error types

New list (first instrumented change in this repo): `_OTHER`, `internal`, `invalid_input` (client-caused), `not_found` (client-caused), `payload_too_large` (client-caused — body over 20 MiB), `rate_limited` (per-instance upload concurrency full), `unauthorized` (client-caused), `upstream_error`, `upstream_timeout`.

### Dashboard panels

Added to `.flow/metrics.md` `## Dashboard panels` for the (future) "reports-service overview" dashboard: upload p50/p95/p99 latency; upload failures by `error.type`; storage call p99 latency.

### Alerts

burn-rate tiers only (on the new SLO below).

### SLO

New journey SLO "contract upload": 99% of upload requests that are not client-caused failures succeed over 28 days (SLI = ok count / (ok + non-client-caused error) from the duration histogram and failures counter).

**As-code:** spec-only — the repo keeps no dashboard or alert config, and `.flow/metrics.md` records backend `none yet — suggested: Google Cloud Monitoring`.

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | DB schema, persistence, storage integration, HTTP handler, infra (deploy), metrics |
| Domain modules | existing `src/app.ts`, `src/db.ts`; new `src/contracts.ts` (handler), `src/storage.ts` (Cloud Storage client), `src/metrics.ts` (helper) — one purpose each per AGENTS.md |
| Data flow | caller → auth + validate in memory → sha256 → dedupe lookup in `contracts` → object create (create-only precondition) → insert row → 201/200 JSON |
| Pattern | raw `fetch` to a Google REST API, as the Cloud Tasks call already does [anchor: src/queue.ts:5]; tagged-template SQL as in `src/db.ts`; no SDK |
| Binary-framing check | Upload transport is proxy vs direct-to-bucket; the middle option (backend-started resumable session) is weighed in Decision A |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| Upload contract (`POST /customers/{customerId}/contracts`) | ~4 s at 20 MiB | inline | handler bounded by the inner call timeouts below; Cloud Run request timeout (5 min default) as backstop | none in the service; caller retries, safe via the key | (customer_id, sha256 of bytes) — unique constraint | 20 MiB cap × 4 concurrent uploads per instance (new in-process limiter) × Cloud Run max instances |
| Metadata-server access token fetch | inline — ~50 ms, timeout 2 s | inline, cached until 60 s before expiry | 2 s | none | n/a (read) | free |
| Cloud Storage object create | ~3 s at 20 MiB | inline | 15 s | none (one retry layer: the caller) | object name `contracts/{customerId}/{sha256}.pdf` + `ifGenerationMatch=0` | Class A op per upload + ~$0.02/GB-month storage (standard class, us-central1) |
| `contracts` row lookup + insert | inline — ~20 ms, timeout via existing Postgres client | inline | existing client | none | (customer_id, sha256) `on conflict do nothing` | existing Cloud SQL |

**Platform:** gcp

**Proportionality:** no queue, worker, or status resource — the whole upload is a few seconds and nothing paid loops; no signed URLs or resumable sessions (Decision A); no per-customer rate limiting beyond the shared key plus per-instance limiter; no multi-region bucket.

**Recovery:** contracts are irreplaceable customer documents. Database: Cloud SQL automated backups + point-in-time recovery, verified (and enabled if off) by Task 2. Bucket: object versioning plus Cloud Storage's default soft-delete window, so an overwritten or deleted object is recoverable. Restore is checked by `scripts/check-recovery.sh` (asserts both settings) and a documented one-object restore of a noncurrent version (Task 2).

**Rollback:** none — additive new table, bucket and route; nothing existing is cut over, and the previous revision ignores the new table.

## Technical Constraints

- Body cap 20 MiB, below Cloud Run's 32 MiB HTTP/1 request limit (research finding 1, high, unrefuted); enforce on `Content-Length` before reading and on the read length after.
- No new runtime dependencies — AGENTS.md ("No new runtime dependencies without a reason"); Cloud Storage is reached by `fetch` to its JSON upload endpoint with a metadata-server token.
- The Cloud Run runtime service account needs `roles/storage.objectCreator` on the bucket only (research finding 4); no `signBlob` / Token Creator role is needed because no URLs are signed.
- Memory: uploads are buffered in memory; the per-instance limit of 4 concurrent uploads keeps worst-case upload buffering near 80 MiB against Cloud Run's default 512 MiB instance (sizing derived from the cap, not measured).
- Contracts must never be publicly readable: bucket public access prevention enforced (the service itself is `--allow-unauthenticated`, deploy.sh:4).

## Open Questions

- [ ] Q1 — Who calls the upload endpoint: an app or backend you operate on the customer's behalf, or customers' own systems directly? Redirecting to "customers directly" adds a customers table and per-customer API keys (Decision B, branch B2) and changes Tasks 1, 3 and 6.
  - **Stakes:** both — a shared key handed to many customers lets any one of them upload as any other customer.
  - **Needs user input:** an external fact the agent cannot verify — whether a customer-facing app exists outside this repo.
- [ ] Q2 — Contract retention and deletion policy (legal retention period; should a bucket retention lock forbid deletion?). Redirecting adds a retention policy to the bucket in Task 2.
  - **Stakes:** both — too short a lock fails legal obligations; a locked retention policy cannot be shortened later.
  - **Needs user input:** a user-held preference — the legal retention requirement is a business/legal decision.
- [ ] How does the caller authenticate? Redirect to OIDC or per-customer keys changes Task 6 and Task 2.
  - **Stakes:** system — a weak scheme exposes an anonymous write path.
  - **Recommended:** one bearer service key from Secret Manager, compared in constant time, fail-closed when unset — the smallest secure footprint with no new dependency, and it is a strict subset of per-customer keys if Q1 redirects [confidence: medium] [anchor: weighing: footprint — zero deps, one secret, upgrades to B2 without rework]
- [ ] Which customer does a contract belong to? Redirecting to `reports.company` changes the schema in Task 1 and the route in Task 6.
  - **Stakes:** user — contracts filed under the wrong identifier are hard to find again.
  - **Recommended:** a free-text `customer_id` taken from the route, validated to `[A-Za-z0-9_-]{1,64}`, no foreign key (no customers table exists) — mirrors how reports name their party as free text [confidence: medium] [anchor: adjacent: migrations/001_reports.sql:3]
- [ ] Maximum file size. Raising it past ~30 MiB forces Decision A's direct-to-bucket branch.
  - **Stakes:** user — a customer with a large scanned contract is refused.
  - **Recommended:** 20 MiB — headroom under the 32 MiB platform limit while covering multi-page scanned contracts [confidence: medium] [anchor: weighing: risk — stays clear of the platform's hard 413]
- [ ] Should "signed" be verified cryptographically (PDF digital signature)? Yes adds a PDF-parsing dependency and a validation task.
  - **Stakes:** user — an unsigned draft could be filed as signed.
  - **Recommended:** no — treat "signed" as the customer's statement; verification needs a PDF parser (a new dependency) and many signed contracts are wet-ink scans with no digital signature [confidence: medium] [anchor: weighing: footprint — avoids a new runtime dependency barred by AGENTS.md without reason]
- [ ] What does a repeat upload of the same file return? Redirecting to "always store a new copy" drops the unique constraint in Task 1.
  - **Stakes:** user — duplicates clutter the record; silent dedupe could surprise a caller expecting a new id.
  - **Recommended:** 200 with the original record (201 for a new one), so retries after a timeout never double-store [confidence: medium] [anchor: weighing: risk — makes caller retries safe without a separate idempotency header]
- [ ] Upload transport: proxy bytes through the service, or have the caller upload straight to the bucket? See Decision A.
  - **Stakes:** system — the proxy caps file size at the platform limit; direct upload adds two extra calls and post-hoc validation.
  - **Recommended:** proxy through the service [confidence: medium] [anchor: weighing: footprint — one request and one endpoint, validation before anything is stored]
- [ ] Request body shape: raw `application/pdf` body or `multipart/form-data`? Multipart changes Task 6's parsing and tests.
  - **Stakes:** user — a browser form posting directly would need multipart.
  - **Recommended:** raw `application/pdf` body with an optional `filename` query parameter — the caller is assumed to be a backend (Q1), and a raw body lets the size check run on `Content-Length` before reading [confidence: medium] [anchor: weighing: effort — no multipart parsing or boundary edge cases]

## Decision analysis

**Decision A — upload transport (mutually exclusive).**

| Branch | End-to-end flow (caller) | Interruptions / calls | Consequences |
| --- | --- | --- | --- |
| A1 proxy | caller sends 1 request with the PDF → waits ~1–4 s → gets the record | 0 interruptions; 1 call | validated before storage; hard ceiling 32 MiB (platform); bytes pass through the container |
| A2 backend-started resumable session | caller calls "start upload" → PUTs bytes to the returned bucket URL → calls "finalize" → service reads the object back to validate, then records it | 0 interruptions; 3 calls | no size ceiling; invalid files land in the bucket before rejection; abandoned sessions and unrecorded objects need cleanup |

Combinations with Decision B, ranked: A1+B1 > A1+B2 > A2+B1 > A2+B2.
Verdict: **A1 proxy** — contracts sit far below the ceiling, and validating before storing keeps junk out of a legal document store [confidence: medium] [anchor: weighing: footprint — one endpoint vs three plus a cleanup path].

**Decision B — caller identity (B1/B2 exclusive for v1; B2 is a later extension of B1, so complementary over time).**

| Branch | End-to-end flow | Interruptions | Consequences |
| --- | --- | --- | --- |
| B1 shared service key | your app holds one key, calls on the customer's behalf, names the customer in the path | 0 | trusts the caller to name the right customer; one secret to rotate |
| B2 per-customer keys | each customer is issued a key; the service maps key → customer | 0 per upload; key issuance is a new admin flow | needs a customers table, key storage and issuance — roughly doubles the diff |

Verdict: **B1**, contingent on Q1 — correct when a trusted app fronts customers, and upgradeable to B2 without reworking the upload path [confidence: medium] [anchor: weighing: reversibility — B2 adds a lookup in front of B1's check].

## Alternatives considered

- **Bun's built-in S3 client against Cloud Storage** — rejected: it needs long-lived HMAC keys to store and rotate, while Cloud Run's metadata-server token is keyless (research finding 3, https://bun.com/docs/runtime/s3).
- **Official `@google-cloud/storage` SDK** — rejected: AGENTS.md bars new runtime deps without a reason, and one `fetch` call covers the single create operation (precedent: src/queue.ts:5).
- **Storing PDF bytes in Postgres** — rejected: the user said "store the files in Cloud Storage".

## Recommendation

**Reconsider scope** — build the upload as asked, but add a mandatory caller credential and a private bucket the request did not mention, because the service has no authentication today (Premise check; confirm the caller in Q1) [confidence: high] [anchor: deploy.sh:4]

**Redundancy:** none found

## Plan risks

The single shared key is only safe if a trusted app sits between customers and this service (Q1); if customers call directly, any customer holding the key can file contracts under any other customer's id.

## Cut list

- nothing — plan is minimal: there is no read/list endpoint, no queue, no signed URLs and no SDK; the metrics helper and recovery check are required by the repo-wide instrumentation and recovery rules, not speculative.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Authenticate the section-worker path end-to-end | High | Small | needs its own design/decision session: the open decision is whether to split the worker into its own private Cloud Run service or verify the Cloud Tasks OIDC token in-handler; anyone can trigger paid model calls today | same root exposure (public service) but a different route and threat; not needed for uploads | No |

- [x] Authenticate the section-worker path end-to-end — the public `/tasks/generate-section` route lets anyone trigger paid model calls, and task enqueue sends no auth token.
  - **UX:** none
  - **Problem:** any internet caller can POST to the worker route and run a paid 20–60 s model call per request, bypassing the queue's rate limits [anchor: src/app.ts:9]
  - **Stability/efficiency:** none
  - **Value rank:** 5 — unbounded paid-call exposure with no workaround on a public service [anchor: deploy.sh:4]
  - **Complexity:** Small — the worker route, the enqueue call and the deploy script
  - **Risk:** Medium — changing who may call the worker can break section generation if the queue's identity is misconfigured
  - **If never done:** anyone who finds the route can run up model-API spend at will
  - **Verdict:** clears bar — a live, uncapped spend exposure outweighs a small, contained change

# Task breakdown

### Task 1: `contracts` table migration

- **Skill:** `flow-system-design`
- **Description:** Add the `contracts` table with the business-identity uniqueness that makes repeat uploads idempotent.
- **Inputs:** `migrations/001_reports.sql` (naming and id conventions)
- **Outputs:** `migrations/002_contracts.sql`
- **Contract:**
  - **Files:** create `migrations/002_contracts.sql`
  - **Interfaces:** DDL:
    ```sql
    create table contracts (
      id text primary key,
      customer_id text not null,
      filename text,
      object_path text not null unique,
      sha256 text not null,
      size_bytes bigint not null check (size_bytes > 0),
      content_type text not null default 'application/pdf',
      uploaded_at timestamptz not null default now(),
      unique (customer_id, sha256)
    );
    ```
  - **Call-site edits:** none
- **Acceptance criteria:** `grep -q 'create table contracts' migrations/002_contracts.sql && grep -q 'unique (customer_id, sha256)' migrations/002_contracts.sql`

### Task 2: Bucket, secret, env wiring and recovery check

- **Skill:** `flow-system-design`
- **Description:** Extend the deploy script to provision a private bucket (uniform access, public access prevention, versioning), grant the runtime service account `roles/storage.objectCreator` on it, mount `CONTRACTS_API_KEY` from Secret Manager, and set `CONTRACTS_BUCKET`. Add a recovery check that verifies (and with `--fix` enables) Cloud SQL backups + point-in-time recovery and asserts bucket versioning, and documents a one-object restore of a noncurrent version in its header comment.
- **Inputs:** `deploy.sh`
- **Outputs:** updated `deploy.sh`; new `scripts/check-recovery.sh`
- **Contract:**
  - **Files:** edit `deploy.sh`; create `scripts/check-recovery.sh`
  - **Interfaces:** config/infra —
    - `deploy.sh`: new `gcloud storage buckets create "gs://${CONTRACTS_BUCKET:?}" --location us-central1 --uniform-bucket-level-access --public-access-prevention || true`; `gcloud storage buckets update "gs://${CONTRACTS_BUCKET}" --versioning`; `gcloud storage buckets add-iam-policy-binding "gs://${CONTRACTS_BUCKET}" --member "serviceAccount:${RUN_SERVICE_ACCOUNT:?}" --role roles/storage.objectCreator`; `gcloud run deploy` gains `--set-env-vars CONTRACTS_BUCKET=${CONTRACTS_BUCKET}` and `--set-secrets CONTRACTS_API_KEY=contracts-api-key:latest` (`--allow-unauthenticated` unchanged)
    - `scripts/check-recovery.sh`: reads `${CLOUD_SQL_INSTANCE:?}` and `${CONTRACTS_BUCKET:?}`; asserts `settings.backupConfiguration.enabled` and `settings.backupConfiguration.pointInTimeRecoveryEnabled` are `True` via `gcloud sql instances describe`, and bucket versioning is on via `gcloud storage buckets describe`; with `--fix`, runs `gcloud sql instances patch "$CLOUD_SQL_INSTANCE" --backup-start-time=03:00 --enable-point-in-time-recovery`; exits non-zero on any missing setting
  - **Call-site edits:** none
- **Acceptance criteria:** `bash -n deploy.sh && bash -n scripts/check-recovery.sh && grep -q -- '--public-access-prevention' deploy.sh && grep -q 'pointInTimeRecoveryEnabled' scripts/check-recovery.sh`

### Task 3: Contract persistence functions

- **Skill:** `flow-new-feature`
- **Description:** Add the contract type and two functions to the Postgres module: look up by (customer, hash), and insert-if-absent returning the stored row either way.
- **Inputs:** Task 1; `src/db.ts`
- **Outputs:** exported `Contract`, `findContract`, `insertContract`
- **Contract:**
  - **Files:** edit `src/db.ts`
  - **Interfaces:**
    - `export type Contract = { id: string; customer_id: string; filename: string | null; object_path: string; sha256: string; size_bytes: number; content_type: string; uploaded_at: string }`
    - `export async function findContract(customerId: string, sha256: string): Promise<Contract | undefined>`
    - `export async function insertContract(c: Omit<Contract, "uploaded_at">): Promise<{ contract: Contract; created: boolean }>` — `insert ... on conflict (customer_id, sha256) do nothing returning *`, falling back to `findContract` when no row returns
  - **Call-site edits:** none (consumed by Task 6)
- **Acceptance criteria:** `grep -q 'export async function insertContract' src/db.ts && grep -q 'on conflict (customer_id, sha256) do nothing' src/db.ts && bun build src/db.ts --target=bun --outdir /tmp/flow-build-db >/dev/null`

### Task 4: Cloud Storage client

- **Skill:** `flow-system-design`
- **Description:** A single-purpose module that creates an object via the Cloud Storage JSON upload endpoint (`uploadType=media`, `ifGenerationMatch=0`) using a metadata-server access token cached until 60 s before expiry. 2 s timeout on the token fetch, 15 s on the upload; a 412 response means "already stored" (`created: false`); a timeout throws `StorageError("upstream_timeout")`, any other non-2xx throws `StorageError("upstream_error")`. Times each call with `reports.storage.call.duration`. Includes its tests with a stubbed global `fetch`.
- **Inputs:** Task 5 (metrics helper); `src/queue.ts` (raw-fetch-to-Google-API precedent)
- **Outputs:** `src/storage.ts`, `src/storage.test.ts`
- **Contract:**
  - **Files:** create `src/storage.ts`; create `src/storage.test.ts`
  - **Interfaces:**
    - `export class StorageError extends Error { constructor(public readonly kind: "upstream_error" | "upstream_timeout", message: string) }`
    - `export async function putObjectIfAbsent(bucket: string, name: string, bytes: Uint8Array, contentType: string): Promise<{ created: boolean }>`
    - internal `getAccessToken(): Promise<string>` (cached)
  - **Call-site edits:** none (consumed by Task 6)
- **Acceptance criteria:** `bun test src/storage.test.ts` (covers 200 → created, 412 → not created, 503 → `upstream_error`, aborted fetch → `upstream_timeout`, token cached across two calls)

### Task 5: Metrics helper and metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create the repo's first metrics helper with an in-memory recorder and a closed `ErrorType` union, and create `.flow/metrics.md` (Backend `none yet — suggested: Google Cloud Monitoring`, Namespace `reports`, Attributes, error.type values, Helper, Dashboard panels, Dashboards, Alerts, As-code `spec-only`, SLOs with "contract upload", Coverage). Planned metrics: `reports.contract.upload.duration`, `reports.contract.upload.failures`, `reports.storage.call.duration`; error types `_OTHER`, `internal`, `invalid_input`, `not_found`, `payload_too_large`, `rate_limited`, `unauthorized`, `upstream_error`, `upstream_timeout`.
- **Inputs:** none
- **Outputs:** `src/metrics.ts`, `src/metrics.test.ts`, `.flow/metrics.md`
- **Contract:**
  - **Files:** create `src/metrics.ts`; create `src/metrics.test.ts`; create `.flow/metrics.md`
  - **Interfaces:**
    - `export type ErrorType = "_OTHER" | "internal" | "invalid_input" | "not_found" | "payload_too_large" | "rate_limited" | "unauthorized" | "upstream_error" | "upstream_timeout"`
    - `export async function instrument<T>(op: string, fn: () => Promise<T>, classify?: (e: unknown) => ErrorType): Promise<T>`
    - `export function recordFailure(op: string, errorType: ErrorType): void` (for handled failures behind a non-throwing response)
    - `export const memoryRecorder: { observations: Array<{ metric: string; value: number; attrs: Record<string, string> }>; reset(): void }`
  - **Call-site edits:** none (consumed by Tasks 4 and 6)
- **Acceptance criteria:** `bun test src/metrics.test.ts && grep -q '## error.type values' .flow/metrics.md && grep -q 'payload_too_large' .flow/metrics.md`

### Task 6: Upload handler and route

- **Skill:** `flow-new-feature`
- **Description:** The upload handler: check `Authorization: Bearer <key>` against `CONTRACTS_API_KEY` in constant time (503 when unset, 401 on mismatch); validate `customerId` (400), `Content-Type: application/pdf` (415), `Content-Length` ≤ 20 MiB before reading (413), body non-empty (400), first bytes `%PDF-` (415), read length ≤ 20 MiB (413); take one of 4 per-instance upload slots or return 503 with `Retry-After: 5`; sha256 the bytes; return 200 with the existing record if `findContract` hits; else `putObjectIfAbsent(CONTRACTS_BUCKET, "contracts/{customerId}/{sha256}.pdf", …)` then `insertContract` and return 201 (502 on `StorageError`). Wrap in `instrument("reports.contract.upload", …)`; client-caused refusals call `recordFailure` with the matching `ErrorType`. Wire the route in the router.
- **Inputs:** Tasks 3, 4, 5; `src/app.ts`
- **Outputs:** `src/contracts.ts`; updated `src/app.ts`
- **Contract:**
  - **Files:** create `src/contracts.ts`; edit `src/app.ts`
  - **Interfaces:**
    - `export const MAX_CONTRACT_BYTES = 20 * 1024 * 1024`
    - `export const MAX_CONCURRENT_UPLOADS = 4`
    - `export async function handleUploadContract(req: Request, customerId: string): Promise<Response>`
    - response body: `{ id, customerId, filename, sizeBytes, sha256, uploadedAt }`; errors `{ error: string }` (same JSON shape as existing `json()` errors)
  - **Call-site edits:** `src/app.ts` `handle` — add `const c = url.pathname.match(/^\/customers\/([^/]+)\/contracts$/); if (req.method === "POST" && c) return handleUploadContract(req, decodeURIComponent(c[1]));` before the reports route
- **Acceptance criteria:** `grep -q 'handleUploadContract' src/app.ts && bun build src/app.ts --target=bun --outdir /tmp/flow-build-app >/dev/null`

### Task 7: Upload handler tests

- **Skill:** `flow-testing`
- **Description:** Tests with `./db` and `./storage` replaced via `mock.module`, covering every Story 1–3 criterion and the emission recipe (one ok observation on success; one error observation + one failures increment per `error.type` branch: `unauthorized`, `invalid_input`, `payload_too_large`, `rate_limited`, `upstream_error`, `upstream_timeout`).
- **Inputs:** Task 6
- **Outputs:** `src/contracts.test.ts`
- **Contract:**
  - **Files:** create `src/contracts.test.ts`
  - **Interfaces:** none (test file); fixture: a minimal valid PDF byte string starting `%PDF-1.4`
  - **Call-site edits:** none
- **Acceptance criteria:** `bun test src/contracts.test.ts`

| Task | Depends on |
| --- | --- |
| 1 | — |
| 2 | — |
| 3 | 1 |
| 4 | 5 |
| 5 | — |
| 6 | 3, 4, 5 |
| 7 | 6 |

Execution order: 1, 2, 5, 3, 4, 6, 7.

### Skills Summary

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-system-design | Yes (Tasks 1, 2, 4) | new table with idempotency key, bucket + recovery, outbound call timeouts |
| flow-metrics | Yes (Task 5) | first instrumented change; creates helper and `.flow/metrics.md` |
| flow-new-feature | Yes (Tasks 3, 6) | persistence functions and the user-facing endpoint |
| flow-testing | Yes (Task 7) | handler test suite with module mocks |
| flow-ui-ux | No | no UI surface |
| flow-refactoring | No | existing modules extend in place |

# PR description draft

## TLDR

Your app can now submit a customer's signed PDF contract to the reports service, which stores it privately in Cloud Storage and records it; before, there was nowhere to send signed contracts.

## User-facing changes

- New upload endpoint: an authenticated caller sends one PDF (up to 20 MiB) for a named customer and gets back the stored contract record (id, filename, size, fingerprint, upload time).
- Sending the same file again for the same customer returns the original record instead of storing a duplicate.
- Uploads without the service key are refused (401), and uploads are refused outright (503) if the key was never configured.
- Files that are not PDFs, are empty, or exceed 20 MiB are refused with an error naming the reason, and nothing is stored.
- When the service is busy with 4 uploads on one instance, further uploads get a "retry shortly" response (503 with `Retry-After`).

## System changes

- The service now holds customer documents: a new private bucket (no public access possible, versioned) and a new contracts table in the existing database.
- The service now calls Cloud Storage using its own Cloud Run identity, with no stored key file or storage secret; one new secret (the caller key) lives in Secret Manager.
- Ongoing cost: one storage write per new contract plus standard-class storage (about $0.02 per GB-month); no paid API calls are added.
- The repo gains its first metrics contract and helper; upload latency, failures by reason, and storage-call latency are recorded but won't show on any graph until a metrics backend is chosen.

## Why

Customers have no way to return signed contracts to us, so signed copies scatter across email and laptops, unlinked to any customer record. The service is also fully public with no notion of who is calling, so any contract store has to establish who may submit documents before it can safely hold them.

## Key decisions

- Bytes go through the service rather than straight to the bucket: one request, and the file is checked to be a real PDF before anything is stored; the trade-off is a hard platform ceiling of 32 MiB per request, hence the 20 MiB cap.
- One shared service key authenticates the caller, on the assumption that an app you run calls on the customer's behalf; per-customer credentials were deferred because they need a customers table and key issuance.
- Repeat uploads are deduplicated on (customer, file fingerprint), which makes retries after a timeout safe without a separate idempotency header.
- No Google SDK and no Bun S3 client: a single direct storage call keeps the no-new-dependency rule, and the S3 route would need long-lived storage keys.
- Out of scope: listing, downloading or deleting contracts, verifying digital signatures, malware scanning, and securing the existing section-worker route (tracked as a follow-up).

## Instrumentation

- Metrics: upload duration (by outcome), upload failures (by reason: unauthorized, invalid input, too large, busy, storage error, storage timeout, other), storage call duration.
- Panels (spec-only, no dashboard URL yet): upload latency percentiles, upload failures by reason, storage call p99.
- New SLO "contract upload": 99% of non-client-caused uploads succeed over 28 days; burn-rate alerts only.
- These metrics are recorded in memory only until a metrics backend is chosen (suggested: Google Cloud Monitoring; status in the repo's metrics contract).

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/contracts.test.ts` — new upload, duplicate upload, auth refusals, validation refusals, busy refusal and storage failures all pass.
- [ ] Run `bun test src/storage.test.ts` — created, already-exists, storage error, timeout and token caching pass.
- [ ] Run `bun test src/metrics.test.ts` — success, failure and unlisted-value emission tests pass.
- [ ] Run `bash -n deploy.sh && grep -q -- '--public-access-prevention' deploy.sh` — the bucket is created private.
- [ ] Run `bash -n scripts/check-recovery.sh && grep -q 'pointInTimeRecoveryEnabled' scripts/check-recovery.sh` — the recovery check is present and parses.
- [ ] Run `CONTRACTS_API_KEY=test-key PORT=18080 bun src/app.ts & sleep 1; [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary '%PDF-1.4' -H 'Content-Type: application/pdf' http://localhost:18080/customers/acme/contracts)" = "401" ]; kill %1` — an upload with no key is refused by the running server.
- [ ] DECISION: you accept one shared service key for all uploads (trusting the calling app to name the right customer) instead of per-customer credentials.
