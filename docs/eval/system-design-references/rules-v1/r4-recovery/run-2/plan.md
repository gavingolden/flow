# PRD

# Signed contract uploads

**Goal:** A customer's signed PDF contract can be sent to the service once and is then kept privately and findable by company, with retries never creating duplicates.

## Problem Statement

This service writes reports about companies for its customers. It has no way to receive a document: a customer's signed contract cannot be handed to it, kept, or found again later next to that customer's work. Where signed contracts live today is not visible from this service, so each one is tracked by hand somewhere else, and proving what a customer signed means searching outside the product.

**Premise check:** the request says "let customers upload", which assumes the service can tell who a customer is. It cannot: the service has no sign-in or customer accounts, every route is public, and the only party-like field in the data is a free-text company name on reports [anchor: deploy.sh:4] [anchor: migrations/001_reports.sql:3] [anchor: src/app.ts:7]. Taken literally, the request would open a public write path for sensitive signed documents, so the plan adds an upload credential the request did not mention (see `## Recommendation` and the access-gate Open Question).

| Product-brief priority | What is at stake here |
| ---------------------- | --------------------- |
| 1. User experience | One send, a clear answer (stored / already stored / rejected and why), and no duplicates when a send is retried |
| 2. Cost | Stored contracts add an ongoing storage bill that grows with volume; abuse of a public write path would grow it without limit |
| 3. Architecture | A new private bucket and table; the service stays keyless (no long-lived storage keys) |
| 4. Product quality | Non-PDF, empty, or oversized files are refused with a named reason instead of being stored |

## Request vetting

- **Hypothesis:** Signed contracts fit comfortably in one proxied request (capped at 10 MiB, under Cloud Run's 32 MiB HTTP/1 body limit), and gating the route with an upload credential is enough access control for v1.
- **Case against:** The service is deployed publicly with no identity model [anchor: deploy.sh:4], so the literal request creates an unauthenticated write path for signed contracts; OWASP's file-upload guidance requires authorization, type checks, and size limits on exactly this kind of route (https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html). Proxying also caps file size at 32 MiB, so large high-resolution scans would be refused (https://cloud.google.com/run/docs/quotas).
- **Sources:** https://cloud.google.com/run/docs/quotas (web-grounded research, high confidence); https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html. The research's adversarial refute passes did not run (provider quota exhausted), so the approach critique is not cross-model verified.
- **Verdict:** adopt-with-conditions: the upload route rejects any request without the upload credential (401) and any body that is not a PDF of 1 byte to 10 MiB (4xx), each proven by a passing test in `src/contracts.test.ts`

## Existing-code assessment

- **src/app.ts request router:** keep — one `handle()` with inline method/path matching; one more `POST /contracts` branch fits the existing shape [anchor: src/app.ts:7]
- **src/db.ts persistence:** keep — small tagged-template `sql` functions; `insertContract` sits next to `saveSection` in the same style [anchor: src/db.ts:15]
- **deploy.sh:** keep — already provisions its queue idempotently with `|| true`; the bucket follows the same idiom, but its `--allow-unauthenticated` flag is why the upload route needs its own gate [anchor: deploy.sh:3]
- **migrations/:** keep — numbered SQL files; the contracts table lands as the next number [anchor: migrations/001_reports.sql:1]

## Scope Boundary

**In scope:**

- One API route that accepts a signed PDF contract plus the company it belongs to, gated by an upload credential.
- A private Cloud Storage bucket (no public access, versioned) holding each file once, named by its content fingerprint.
- A new `contracts` table recording company, fingerprint, size, original file name, storage location, and upload time.
- Re-sending the same file for the same company returns the existing record instead of a duplicate.
- Refusing empty, non-PDF, and over-10 MiB files with a named reason.
- Metrics for the upload and for the storage calls, plus a recovery check for the new table and bucket.

**Out of scope:**

- Customer sign-in or per-customer credentials (candidate follow-up).
- Listing, downloading, replacing, or deleting contracts.
- Checking that the PDF's signature is cryptographically valid.
- Any upload screen — this repo has no user interface.
- Malware scanning and retention/deletion policy.
- Files over 10 MiB (direct-to-bucket signed upload links are the path if this is ever needed; see `## Decision analysis`).

## Behavioral contrast

### User flow

| Before | After |
| ------ | ----- |
| The service has no way to accept a document | A caller holding the upload credential sends a PDF and a company name and gets back the stored contract record (`201`) |
| — | Sending the same file again for the same company returns the same record (`200`), never a second copy |
| — | An empty, non-PDF, or over-10 MiB file is refused with `400` / `415` / `413` and a named error |
| — | A request without the credential is refused with `401`; nothing is stored |

### System flow

- **Before:**
  - The service reads and writes only reports and sections in Postgres; it holds no files.
  - Every route is public and none accepts a request body larger than a small JSON task payload.
- **After:**
  - A credential-gated upload route writes the PDF to a private, versioned Cloud Storage bucket with a create-only write, then records a `contracts` row keyed on company plus file fingerprint.
  - The service authenticates to Cloud Storage with its own runtime identity (no stored storage key).
  - Upload and storage-call latency, failures by type, and in-flight uploads are recorded through a new metrics helper.

**Lost:** nothing a user loses; operators can no longer run the deploy script without first setting the bucket name and runtime service-account variables and creating the upload-credential secret.

## User Stories / Acceptance Criteria

### Story 1: Upload a signed contract

- [ ] Given a valid credential and a 1 KiB PDF for company "Acme", when it is posted to `POST /contracts`, then the response is `201` with the record's id, company, fingerprint and size, and the storage write was create-only — test `stores a new PDF and returns 201` in `src/contracts.test.ts` passes.
- [ ] Given that same file was already stored for "Acme", when it is posted again, then the response is `200` with the same record id and no second row is created — test `returns the existing record with 200 for a duplicate upload` passes.

### Story 2: Refuse what should not be stored

- [ ] Given no `Authorization` header or a wrong credential, when posting, then the response is `401` and neither storage nor the database is called — test `rejects a missing or wrong credential with 401` passes.
- [ ] Given a body whose first bytes are not `%PDF-`, when posting, then the response is `415` — test `rejects a non-PDF body with 415` passes.
- [ ] Given a file over 10 MiB, when posting, then the response is `413` before the file reaches storage — test `rejects a body over 10 MiB with 413` passes.
- [ ] Given no company field, when posting, then the response is `400` — test `rejects a missing company with 400` passes.

### Story 3: Fail visibly, never half-silently

- [ ] Given the storage write fails, when posting, then the response is `502`, no row is written, and one failure with `error.type=upstream_error` is recorded — test `maps a storage failure to 502` passes.
- [ ] Given the upload credential is not configured on the server, when posting, then the response is `503` (fail closed) — test `fails closed with 503 when the upload credential is not configured` passes.
- [ ] Given 8 uploads already in flight on the instance, when a ninth arrives, then it is refused with `503` and `Retry-After` — test `sheds load past 8 concurrent uploads with 503` passes.

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| ------ | ---------- | ---- | -------------------------- | ---------- |
| `reports_service.contract.upload.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | contract upload handler |
| `reports_service.contract.upload.failures` | Counter | none | `error.type` (the 7 values below) | contract upload handler |
| `reports_service.contract.upload.in_flight` | UpDownCounter | `{request}` | none | contract upload handler |
| `reports_service.storage.call.duration` | Histogram | seconds | `server.address` (`storage.googleapis.com`, `metadata.google.internal`), `operation.outcome` (`ok`, `error`) | storage client |
| `reports_service.storage.call.failures` | Counter | none | `server.address` (2 hosts), `error.type` (the 7 values below) | storage client |
| `reports_service.storage.call.in_flight` | UpDownCounter | `{request}` | `server.address` (2 hosts) | storage client |

Estimated series: 42 per operation for contract upload (histogram 2 × 17, failures 7, in-flight 1), per instance
Estimated series: 84 per operation for storage calls (histogram 2 hosts × 2 outcomes × 17 = 68, failures 2 × 7 = 14, in-flight 2), per instance

**Attributes:** new registry seeded with `operation.outcome` (`ok`, `error`), `error.type` (`.flow/metrics.md` list), `server.address` (`storage.googleapis.com`, `metadata.google.internal`)

### Error types

New list, seeded from the starter values: `_OTHER` (fallback), `internal` (unexpected failure, including the credential not being configured), `invalid_input` (client-caused: missing company, empty, non-PDF, or oversized file), `rate_limited` (this service shed the upload because 8 were already in flight — service-caused, counts against the SLO), `unauthorized` (client-caused: missing or wrong credential), `upstream_error` (Cloud Storage, the metadata server, or Postgres answered with a failure), `upstream_timeout` (one of those did not answer in time).

### Dashboard panels

On a new "reports-service overview" dashboard (spec only): contract upload rate and success vs failure; upload failures by `error.type`; upload latency p50/p95/p99; uploads in flight; storage call latency p95 by `server.address`.

### Alerts

burn-rate tiers only

### SLO

New journey SLO "upload a signed contract": 99.5% of uploads that are not client-caused (`invalid_input`, `unauthorized` excluded) succeed over 30 days, with the standard burn-rate tiers recorded once in `.flow/metrics.md`.

**As-code:** spec-only — the repo keeps no dashboard or alert files and has no metrics backend yet (suggested: Google Cloud Monitoring).

## Architecture Decisions

| Aspect | Decision |
| ------ | -------- |
| Layers touched | Postgres schema, Cloud Storage bucket + deploy script, storage client, HTTP handler, metrics helper |
| Domain modules | Existing: router, persistence. New: storage client, contracts handler, metrics helper (each one small single-purpose module, per AGENTS.md) |
| Data flow | Caller → upload route (gate, size and type checks, fingerprint) → create-only write to private bucket → insert-or-return `contracts` row → JSON record back |
| Pattern | Raw `fetch` to a Google REST API with no client library, as the queue module already does [anchor: src/queue.ts:5]; tagged-template `sql` persistence as in `src/db.ts` |
| Upload path | Proxied through the service (one request), not direct-to-bucket signed links — see `## Decision analysis` |
| Storage auth | Service's own runtime identity via the metadata-server token, cached until 60 s before expiry; no stored storage key |
| Access gate | One shared upload credential from Secret Manager, compared in constant time; missing server config fails closed (`503`) |
| Idempotency | Object name = `contracts/<sha256>.pdf` written with "create only if absent"; row unique on `(company, sha256)` |
| Binary-framing check | The request is not framed as A-or-B; the upload-path fork has a middle option (proxy now, signed links only above the cap) recorded in Decision analysis |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --------- | -------- | --------------- | ------------------ | ------- | --------------- | ---------- |
| Contract upload (`POST /contracts`), after the body is received | ~3 s (estimate, 10 MiB file) | inline | 10 s interactive budget; inner deadlines below sum to 9 s | none in the service; the caller retries, which is safe | company + SHA-256 of the file bytes | 10 MiB per upload; 8 in-flight uploads per instance; credential gate |
| Metadata-server token fetch | inline — <0.1 s, timeout 1 s | inline, cached ~1 h | 1 s | none | n/a (read-only) | free |
| Cloud Storage create-only object write | inline — ~2 s (estimate), timeout 5 s | inline | 5 s | none | object name `contracts/<sha256>.pdf` + create-only precondition | one write per distinct file; storage billed per GB-month |
| `contracts` insert-or-return | inline — <0.05 s, timeout 3 s | inline | 3 s (`statement_timeout`) | none | unique `(company, sha256)` | n/a |

**Platform:** gcp

**Proportionality:** no queue or worker (the upload finishes well inside the interactive budget, and a failure is returned to the caller, who still holds the file); no direct-to-bucket signed links, malware scanning, or per-caller rate limiter (the credential gate plus the 8-in-flight cap bound abuse for v1); no outbox (a row-insert failure after the object write leaves an orphan object that the next retry adopts).

**Recovery:** Cloud SQL automated backups plus point-in-time recovery for the `contracts` rows, and object versioning (plus Cloud Storage's default soft delete) for the PDFs; Task 2's recovery-check script verifies both are on, enables them if not, restores a prior version of a canary object to prove the bucket restore path, and with `--db-drill` clones the database to a scratch instance and counts `contracts` rows.

**Rollback:** none — additive only (a new table, bucket, and route); the previous revision never reads them, so rolling back is a Cloud Run traffic shift with no data step.

## Technical Constraints

- No new runtime dependencies [anchor: AGENTS.md:5] — Cloud Storage via `fetch`, multipart parsing via Bun's built-in `Request.formData()`, hashing via `Bun.CryptoHasher`, constant-time compare via `node:crypto`.
- Cloud Run refuses HTTP/1.1 request bodies over 32 MiB, and Bun's server speaks HTTP/1.1, so the cap applies (research, high confidence; https://cloud.google.com/run/docs/quotas) — the 10 MiB limit leaves room for multipart overhead.
- Every route is public [anchor: deploy.sh:4] — the gate must live in the handler.
- Uploads are buffered in memory before hashing; at 8 in flight × 10 MiB that is ~80 MiB, inside a default-size Cloud Run instance (memory limit unverified for this service — `deploy.sh` sets none).
- The repo has no migration runner, only `migrations/001_reports.sql`; `002_contracts.sql` is applied the same out-of-band way.
- The repo has no tests yet; the new `*.test.ts` files are the first, run with `bun test` [anchor: AGENTS.md:3].

## Research findings (prior context)

Web-grounded research ran (gather only; both adversarial refute passes were skipped because the research provider's quota was exhausted, so none of these were cross-checked):

- [high] Cloud Run caps HTTP/1.1 request bodies at 32 MiB — https://cloud.google.com/run/docs/quotas
- [high] A Cloud Run service can write to Cloud Storage keylessly: metadata-server token + JSON API simple upload — https://cloud.google.com/storage/docs/uploading-objects
- [high] Bun's built-in S3 client works against Cloud Storage only with long-lived HMAC keys, which some organisations block — https://bun.sh/docs/api/s3
- [high] Keyless signed upload links need the IAM `signBlob` call, the Service Account Token Creator role, a two-phase pending/uploaded row state, and bucket CORS — https://cloud.google.com/storage/docs/access-control/signing-urls-manually
- [medium] Born-digital e-signed contracts are typically 100 KiB–5 MiB; high-resolution scans can exceed 32 MiB (not measured on this product's data — kept as a risk, not a decision input on its own)

## Open Questions

- [ ] Who may upload, and how is the caller authenticated? Changes on redirect: the gate in the handler, the deploy secret, and whether `company` comes from the request or from the caller's identity.
  - **Stakes:** both — Product-brief priority 1 (user experience): a customer who must go through an intermediary has one more hop; priority 2 (cost): an ungated route invites unbounded storage spend.
  - **Recommended:** one shared upload credential held by whoever uploads on customers' behalf, checked in constant time and failing closed when unset; per-customer sign-in is a ticked candidate follow-up — it is the smallest gate that closes the public write path on a service with no identity model [confidence: medium] [anchor: weighing: risk — every route on this service is public (deploy.sh:4), so an ungated upload route stores anyone's file]
- [ ] Proxy uploads through the service, or hand callers direct-to-bucket signed links? Changes on redirect: Tasks 4–6 (signing code, a pending/uploaded row state, bucket CORS, a confirm call).
  - **Stakes:** user — Product-brief priority 1: proxying is one call for the uploader but refuses files over the cap.
  - **Recommended:** proxy, capped at 10 MiB — see `## Decision analysis` [confidence: medium] [anchor: weighing: footprint — one request and no two-phase row state versus ~45 lines of signing code, a pending state, CORS, and a confirm call]
- [ ] What size cap? Changes on redirect: the limit constant, the in-flight cap's memory math, and the 413 test.
  - **Stakes:** user — Product-brief priority 1: a too-low cap refuses legitimate scanned contracts.
  - **Recommended:** 10 MiB — covers the researched typical range for e-signed PDFs with headroom, keeps 8 buffered uploads near 80 MiB, and stays far below the 32 MiB platform limit [confidence: medium] [anchor: weighing: risk — a higher cap multiplies per-instance memory held by concurrent uploads, and deploy.sh sets no memory limit]
- [ ] What does a contract belong to? Changes on redirect: the table's columns and foreign keys, and the uniqueness key.
  - **Stakes:** system — Product-brief priority 3 (architecture): changing the owner later means a migration and backfill.
  - **Recommended:** a free-text `company` column, the same convention reports use; no link to a report, since a contract is not tied to one report [confidence: medium] [anchor: adjacent: migrations/001_reports.sql:3]
- [ ] Should the service verify the PDF's digital signature? Changes on redirect: adds a PDF/cryptography parser and a new rejection path.
  - **Stakes:** user — Product-brief priority 4 (product quality): an unsigned PDF would be stored as "signed".
  - **Recommended:** no — "signed" describes the document the customer sends, and verifying PDF signatures needs a parsing dependency the project discourages; the check is a content-type and `%PDF-` header check only [confidence: medium] [anchor: weighing: footprint — signature verification needs a PDF and certificate parser, a new runtime dependency AGENTS.md:5 asks to justify]
- [ ] Request format: multipart form or raw PDF body? Changes on redirect: how the handler reads the company and file, and every test request.
  - **Stakes:** user — Product-brief priority 1: a plain HTML form or `curl -F` can post multipart directly; a raw body needs the company in a header or query string.
  - **Recommended:** `multipart/form-data` with fields `company` and `file`, parsed by Bun's built-in form parser [confidence: medium] [anchor: weighing: footprint — Bun parses multipart natively, so both browser forms and API clients work with no dependency]
- [ ] What does a duplicate upload return? Changes on redirect: the status code and test for the duplicate path.
  - **Stakes:** user — Product-brief priority 1: a retry after a network timeout must not look like a failure.
  - **Recommended:** `200` with the existing record (a new file returns `201`), so retries are invisible to the uploader [confidence: medium] [anchor: weighing: risk — a `409` on retry would make a successful-but-timed-out upload look failed]
- [x] Is there a user interface to build? — no; the service returns JSON only and the image ships no front end [anchor: src/app.ts:4] [anchor: Dockerfile:4]
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision A — how does the file reach the bucket?** Ranked against the product brief: user experience (1) first, then cost (2), then architecture (3).

| Branch | Uploader's flow | System flow | Friction |
| ------ | --------------- | ----------- | -------- |
| A1. Proxy through the service (chosen) | Sends one request with the file; gets the record back | Service checks, fingerprints, writes create-only to the bucket, inserts the row, answers | 0 interruptions; 1 call per upload |
| A2. Direct-to-bucket signed link | Asks for a link, uploads the file to the bucket, then calls back to confirm | Service signs via IAM `signBlob`, inserts a `pending` row, verifies the object on confirm, flips to `uploaded`; bucket needs CORS; abandoned uploads leave pending rows | 0 interruptions; 3 calls per upload; uploader must handle a partial failure between calls |
| A3. Hybrid: proxy up to the cap, signed link above | One call for normal files; three for large scans | Both code paths and both row states | 0 interruptions; 1 or 3 calls |

A1 and A2 are mutually exclusive as the default path; A3 is A1 plus A2 (complementary). Ranked: A1 > A3 > A2 — A1 is the fewest steps for the uploader and the least code; A3 only earns its second path if real contracts exceed 10 MiB, which is unmeasured; A2 makes every upload three steps to serve a rare large file. Verdict: **A1, proxy capped at 10 MiB; revisit A3 only if refused-size failures appear in the `invalid_input` failure count** [confidence: medium] [anchor: weighing: footprint — A1 needs no signing code, pending state, CORS or confirm call, and the 32 MiB platform cap is far above the researched typical size].

## Alternatives considered

- **An ungated upload route, as literally requested** — rejected: every route on this service is public (deploy.sh:4), so it would let anyone store files under any company name at the service's expense.
- **Bun's built-in S3 client with Cloud Storage HMAC keys** — rejected: it needs a long-lived HMAC key pair stored and rotated in Secret Manager, which the metadata-server token avoids entirely (https://bun.sh/docs/api/s3).
- **Storing PDF bytes in a Postgres column** — rejected: the user specified "store the files in Cloud Storage".

## Recommendation

**Reconsider scope** — build the upload as asked, widened by an upload-credential gate the request did not mention, because the service has no customer identity (see the Premise check and the "Who may upload" Open Question) [confidence: medium] [anchor: weighing: risk — deploy.sh:4 makes every route public, so the literal request would ship an open write path for signed contracts]

**Redundancy:** none found — the service has no existing upload, file-storage, or contracts capability (its modules are the router, persistence, model client, queue, and worker only).

## Plan risks

The shared credential assumes a trusted party uploads on customers' behalf; if customers are meant to call the route themselves, every customer holds the same credential and can file a contract under any other company's name — the gate then stops strangers but not customers impersonating each other.

## Cut list

- Outbound metrics for the metadata-server token fetch — the token is cached for about an hour, so that series is nearly always empty; kept only because the convention asks for one outbound histogram per dependency, and is the first thing to drop if the reviewer disagrees.
- The `--db-drill` scratch-instance clone in the recovery script — a quarterly manual restore could cover it; kept because the recovery contract asks for a scripted restore check, and it runs only when invoked.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --------- | ----- | ---------- | --------- | --------------------------- | ------------------------ |
| Lock the section-worker route so only the task queue can call it | High | Small | needs its own design/decision session: the open decision is whether to move the worker to its own private Cloud Run service or verify the queue's OIDC token in the handler; anyone can trigger paid model calls today | unrelated to contract uploads; surfaced while checking which routes are public | No |
| Per-customer upload identity | Medium | Medium | genuinely novel non-trivial feature — the open decision is which identity provider customers sign in with; it would let customers upload directly and stop one customer filing under another's name | replaces this plan's shared credential with per-customer identity | No |

- [x] Lock the section-worker route so only the task queue can call it — it is public today and each call triggers a paid model generation.
  - **UX:** none
  - **Problem:** any internet caller can POST to the section-worker route and make the service run a paid 20–60 s model call [anchor: src/app.ts:9]
  - **Stability/efficiency:** each unauthenticated call costs one paid model generation with no cap [anchor: src/llm.ts:1]
  - **Value rank:** 5 — a security exposure with no workaround: the service is deployed publicly [anchor: deploy.sh:4]
  - **Complexity:** Small — the worker route plus the deploy script
  - **Risk:** Medium — changes how the queue reaches the worker; a mistake stops report generation
  - **If never done:** anyone who finds the route can run up model spend and overwrite report sections
  - **Verdict:** clears bar — an open paid-call path ranks on cost (brief priority 2) and outweighs a small, contained change
- [x] Per-customer upload identity — let each customer authenticate as themselves so the company on a contract comes from their identity, not a form field.
  - **UX:** customers could upload without going through whoever holds the shared credential [anchor: user: "let customers upload their signed PDF contracts"]
  - **Problem:** with one shared credential, any holder can file a contract under any company name [anchor: deploy.sh:4]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk: impersonation is possible but not observed [anchor: deploy.sh:4]
  - **Complexity:** Medium — an identity provider, per-request identity checks, a customer-to-company mapping
  - **Risk:** Medium — touches every route's access model
  - **If never done:** uploads keep depending on a trusted intermediary, and company attribution rests on that intermediary's honesty
  - **Verdict:** clears bar — it serves the brief's top priority (user experience) for the user's own stated audience, and outweighs Medium complexity once the provider decision is made

# Task breakdown

### Task 1: Add the contracts table migration

- **Skill:** `flow-system-design`
- **Description:** Create the `contracts` table. One row per (company, file fingerprint).
- **Inputs:** migrations/001_reports.sql (naming and style precedent)
- **Outputs:** `migrations/002_contracts.sql`
- **Contract:**
  - **Files:** `migrations/002_contracts.sql` (create)
  - **Interfaces:** exact DDL:
    ```sql
    create table contracts (
      id text primary key,
      company text not null check (length(company) between 1 and 200),
      sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
      object_name text not null,
      original_filename text,
      size_bytes integer not null check (size_bytes > 0),
      uploaded_at timestamptz not null default now(),
      unique (company, sha256)
    );
    ```
  - **Call-site edits:** none
- **Acceptance criteria:** `grep -qi 'create table contracts' migrations/002_contracts.sql && grep -qi 'unique (company, sha256)' migrations/002_contracts.sql`

### Task 2: Provision the private bucket, deploy wiring, and recovery check

- **Skill:** `flow-system-design`
- **Description:** Provision the contracts bucket idempotently in the deploy script, in the same `|| true` style as the queue. Make it private and versioned, and give the runtime service account create-only object access. Pass the bucket name and the upload-credential secret to the service. Add a recovery-check script that: verifies Cloud SQL automated backups and point-in-time recovery are on and enables them if not; verifies bucket versioning is on and enables it if not; writes, overwrites, and restores a canary object's prior version and compares the bytes; and with `--db-drill`, clones the instance to `${CLOUD_SQL_INSTANCE}-restore-drill`, counts `contracts` rows, and deletes the clone.
- **Inputs:** deploy.sh (existing idempotent-provisioning idiom)
- **Outputs:** updated `deploy.sh`; new `scripts/check-recovery.sh`
- **Contract:**
  - **Files:** `deploy.sh` (edit), `scripts/check-recovery.sh` (create, executable)
  - **Interfaces:** `deploy.sh` — required env: `CONTRACTS_BUCKET`, `RUNTIME_SA` (each `: "${VAR:?}"`); new lines before the `gcloud run deploy` line:
    - `gcloud storage buckets create "gs://$CONTRACTS_BUCKET" --location us-central1 --uniform-bucket-level-access --public-access-prevention || true`
    - `gcloud storage buckets update "gs://$CONTRACTS_BUCKET" --versioning`
    - `gcloud storage buckets add-iam-policy-binding "gs://$CONTRACTS_BUCKET" --member "serviceAccount:$RUNTIME_SA" --role roles/storage.objectCreator`
    - `gcloud run deploy` line gains `--service-account "$RUNTIME_SA" --set-env-vars "CONTRACTS_BUCKET=$CONTRACTS_BUCKET" --set-secrets "CONTRACT_UPLOAD_TOKEN=contract-upload-token:latest"`; `--allow-unauthenticated` is unchanged.
    `scripts/check-recovery.sh` — required env `CLOUD_SQL_INSTANCE`, `CONTRACTS_BUCKET`; reads `settings.backupConfiguration.enabled` and `settings.backupConfiguration.pointInTimeRecoveryEnabled` via `gcloud sql instances describe`, runs `gcloud sql instances patch "$CLOUD_SQL_INSTANCE" --backup-start-time 03:00 --enable-point-in-time-recovery` only when either is off; exits non-zero when any check fails.
  - **Call-site edits:** none
- **Acceptance criteria:** `bash -n deploy.sh && bash -n scripts/check-recovery.sh && grep -q -- '--versioning' deploy.sh && grep -q 'pointInTimeRecoveryEnabled' scripts/check-recovery.sh && grep -q -- '--public-access-prevention' deploy.sh`

### Task 3: Metrics helper and the repo metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create a zero-dependency metrics helper with a swappable recorder (in-memory aggregate by default, since there is no backend yet), a closed `ErrorType` union (`_OTHER`, `internal`, `invalid_input`, `rate_limited`, `unauthorized`, `upstream_error`, `upstream_timeout`), and `instrument(op, fn, attrs)` that records `<op>.duration` (seconds, by `operation.outcome`), `<op>.failures` (by `error.type`), and `<op>.in_flight`, all under the `reports_service.` namespace. Create `.flow/metrics.md` with Backend (`none yet — suggested: Google Cloud Monitoring`), Namespace, Attributes, error.type values, Helper, Dashboard panels, Dashboards (none yet), Alerts (burn-rate tiers), As-code (`spec-only`), SLOs ("upload a signed contract", 99.5%/30 d), and Coverage (`contract.upload`, `storage.call`). Add emission tests.
- **Inputs:** new: src/metrics.ts
- **Outputs:** `src/metrics.ts`, `src/metrics.test.ts`, `.flow/metrics.md`
- **Contract:**
  - **Files:** `src/metrics.ts` (create), `src/metrics.test.ts` (create), `.flow/metrics.md` (create)
  - **Interfaces:**
    - `export type ErrorType = "_OTHER" | "internal" | "invalid_input" | "rate_limited" | "unauthorized" | "upstream_error" | "upstream_timeout"`
    - `export type Attributes = { "operation.outcome"?: "ok" | "error"; "error.type"?: ErrorType; "server.address"?: "storage.googleapis.com" | "metadata.google.internal" }`
    - `export interface Recorder { record(kind: "histogram" | "counter" | "updown", name: string, value: number, attrs: Attributes): void }`
    - `export class MemoryRecorder implements Recorder { series(name: string, attrs?: Attributes): { count: number; sum: number }; reset(): void }`
    - `export function setRecorder(r: Recorder): void`
    - `export class OperationError extends Error { constructor(readonly errorType: ErrorType, message?: string) }`
    - `export async function instrument<T>(op: string, fn: () => Promise<T>, attrs?: Attributes): Promise<T>` — a thrown `OperationError` records its `errorType`; any other throw records `_OTHER`; rethrows either way; in-flight returns to its prior value in `finally`.
  - **Call-site edits:** none (consumers arrive in Tasks 4–5)
- **Acceptance criteria:** `bun test src/metrics.test.ts` (covers: one `ok` observation with no failure; one `error` observation plus one failure per `ErrorType` thrown; a non-`OperationError` throw maps to `_OTHER`; in-flight returns to 0 on success and failure)

### Task 4: Keyless Cloud Storage client

- **Skill:** `flow-system-design`
- **Description:** A small storage module that fetches the runtime identity's access token from the metadata server (header `Metadata-Flavor: Google`, 1 s timeout, cached until 60 s before `expires_in`), and writes an object create-only via the JSON API simple upload (`POST https://storage.googleapis.com/upload/storage/v1/b/<bucket>/o?uploadType=media&name=<encoded>&ifGenerationMatch=0`, 5 s timeout). `200` means `"created"`, `412` means `"exists"`, a timeout throws `OperationError("upstream_timeout")`, and any other status throws `OperationError("upstream_error")`. Each outbound call is wrapped in `instrument("storage.call", …, { "server.address": … })`.
- **Inputs:** src/metrics.ts (Task 3); src/queue.ts (raw-fetch-to-Google-API precedent)
- **Outputs:** `src/storage.ts`
- **Contract:**
  - **Files:** `src/storage.ts` (create)
  - **Interfaces:**
    - `export type PutResult = "created" | "exists"`
    - `export async function putObjectIfAbsent(objectName: string, body: Uint8Array, contentType: string): Promise<PutResult>` — reads `process.env.CONTRACTS_BUCKET`; throws `OperationError("internal")` when unset
    - `export function resetTokenCacheForTests(): void`
  - **Call-site edits:** none (consumed in Task 5)
- **Acceptance criteria:** `bun build src/storage.ts --target bun --outdir "$(mktemp -d)" >/dev/null && grep -q 'ifGenerationMatch=0' src/storage.ts && grep -q 'Metadata-Flavor' src/storage.ts`

### Task 5: Contract persistence, upload handler, and route

- **Skill:** `flow-system-design`
- **Description:** Add `insertContract` (inside `sql.begin`, `set local statement_timeout = '3s'`, `insert … on conflict (company, sha256) do nothing returning *`, and on no row return the existing one with `created: false`). Add the upload handler, inside `instrument("contract.upload", …)`. Steps, in order:
  - Reject with `503` + `Retry-After: 5` (`rate_limited`) when 8 uploads are in flight.
  - Fail closed with `503` (`internal`) when `CONTRACT_UPLOAD_TOKEN` is unset.
  - Return `401` (`unauthorized`) unless `Authorization: Bearer <token>` matches, compared as SHA-256 digests with `timingSafeEqual`.
  - Return `413` (`invalid_input`) when `Content-Length` is missing or exceeds 10 MiB + 64 KiB, checked before reading the body.
  - Parse `formData()`; return `400` for a missing or blank `company` (trimmed, ≤200 chars) or a missing `file`.
  - Return `413` when the file is over 10 MiB and `400` when it is empty.
  - Return `415` unless the first 5 bytes are `%PDF-`.
  - Fingerprint with `Bun.CryptoHasher("sha256")`, then `putObjectIfAbsent("contracts/<sha256>.pdf", …, "application/pdf")`.
  - Call `insertContract`, keeping `original_filename` truncated to 255 chars.
  - Return `201` or `200` with `{ id, company, sha256, size_bytes, original_filename, uploaded_at }`.

  Errors use the existing `{ error: "<code>" }` JSON shape; storage failures return `502`/`504`. Wire `POST /contracts` in the router.
- **Inputs:** src/storage.ts (Task 4), src/metrics.ts (Task 3), migrations/002_contracts.sql (Task 1), src/db.ts, src/app.ts
- **Outputs:** `insertContract` in `src/db.ts`; `src/contracts.ts`; route in `src/app.ts`
- **Contract:**
  - **Files:** `src/db.ts` (edit), `src/contracts.ts` (create), `src/app.ts` (edit)
  - **Interfaces:**
    - `src/db.ts`: `export type Contract = { id: string; company: string; sha256: string; object_name: string; original_filename: string | null; size_bytes: number; uploaded_at: string }`; `export type NewContract = Omit<Contract, "id" | "uploaded_at">`; `export async function insertContract(c: NewContract): Promise<{ contract: Contract; created: boolean }>` (id = `crypto.randomUUID()`)
    - `src/contracts.ts`: `export const MAX_CONTRACT_BYTES = 10 * 1024 * 1024`; `export const MAX_CONCURRENT_UPLOADS = 8`; `export async function handleUploadContract(req: Request): Promise<Response>`
  - **Call-site edits:** `src/app.ts` `handle()` — add `if (req.method === "POST" && url.pathname === "/contracts") return handleUploadContract(req);` beside the existing `/tasks/generate-section` branch, plus the import.
- **Acceptance criteria:** `bun build src/app.ts --target bun --outdir "$(mktemp -d)" >/dev/null && grep -q '"/contracts"' src/app.ts && grep -q 'export async function insertContract' src/db.ts`

### Task 6: Storage and upload tests

- **Skill:** `flow-testing`
- **Description:** Test the storage client with a stubbed `globalThis.fetch`: token caching (one metadata call for two writes), `200` returns `created`, `412` returns `exists`, `500` throws `upstream_error`, and an aborted call throws `upstream_timeout`. Test the upload route through `handle()` with `mock.module("./db")` and `mock.module("./storage")` registered before importing the app, a `MemoryRecorder`, and `CONTRACT_UPLOAD_TOKEN` set per test. Use these test names exactly:
  - `stores a new PDF and returns 201`
  - `returns the existing record with 200 for a duplicate upload`
  - `rejects a missing or wrong credential with 401`
  - `rejects a non-PDF body with 415`
  - `rejects a body over 10 MiB with 413`
  - `rejects a missing company with 400`
  - `maps a storage failure to 502`
  - `fails closed with 503 when the upload credential is not configured`
  - `sheds load past 8 concurrent uploads with 503`

  Each failure test also asserts the one `reports_service.contract.upload.failures` increment with its `error.type`.
- **Inputs:** Tasks 3–5
- **Outputs:** `src/storage.test.ts`, `src/contracts.test.ts`
- **Contract:**
  - **Files:** `src/storage.test.ts` (create), `src/contracts.test.ts` (create)
  - **Interfaces:** none exported (test files)
  - **Call-site edits:** none
- **Acceptance criteria:** `bun test src/storage.test.ts src/contracts.test.ts`

| Task | Depends on |
| ---- | ---------- |
| 1 | — |
| 2 | — |
| 3 | — |
| 4 | 3 |
| 5 | 1, 3, 4 |
| 6 | 3, 4, 5 |

### Skills Summary

| Skill | Recommended? | Reason |
| ----- | ------------ | ------ |
| flow-system-design | Yes (Tasks 1, 2, 4, 5) | New handler, outbound calls, a new table and bucket: timeouts, idempotency, recovery |
| flow-metrics | Yes (Task 3) | First instrumented change: creates the helper and `.flow/metrics.md` |
| flow-testing | Yes (Task 6) | First tests in the repo; module mocking for db and storage |
| flow-ui-ux | No | No user interface in this repo |
| flow-refactoring | No | Every touched surface is "keep" |

# PR description draft

## TLDR

Signed PDF contracts can now be uploaded through a credential-gated endpoint that stores each file privately in Cloud Storage and records it in a contracts table; previously the service could not accept documents.

## User-facing changes

- New endpoint: sending a signed PDF and a company name with the upload credential stores the contract and returns its record (`201`).
- Re-sending the same file for the same company returns the existing record (`200`) instead of storing a duplicate.
- Empty, non-PDF, and over-10 MiB files are refused with a named error (`400` / `415` / `413`); a request without the upload credential is refused with `401`.

## System changes

- The service now holds files: a private, versioned Cloud Storage bucket keeps one copy of each contract, written create-only and named by its content fingerprint.
- The service authenticates to Cloud Storage with its own runtime identity — no storage key is stored or rotated.
- Deploying now requires a bucket name, a runtime service account, and an upload-credential secret:
  - **Before:** the deploy script ran with no extra settings.
  - **After:** it stops with a clear message unless the bucket name and runtime service account are set, and the upload-credential secret exists.
- Ongoing cost: Cloud Storage spend grows with the volume of stored contracts (one copy per distinct file, plus prior versions kept by versioning); no paid API calls are added.

## Why

The service had no way to receive a customer's signed contract, so signed copies were tracked by hand somewhere else and could not be found next to the customer's reports. The service also has no notion of who a customer is, so accepting documents safely needed an access check the request did not mention.

## Key decisions

- **Upload credential added:** every route on the service is public and there are no customer accounts, so the upload route requires one shared credential and refuses when the server has none configured. Per-customer sign-in is a separate follow-up.
- **Upload goes through the service, capped at 10 MiB:** one request for the uploader, with no signing code, pending state, or bucket CORS. Direct-to-bucket links would make every upload three steps to serve rare large scans.
- **Keyless storage access:** the runtime identity's short-lived token was chosen over Bun's S3 client with long-lived HMAC keys.
- **Retries are safe by construction:** the file's fingerprint plus company is the identity, so a retried upload never stores twice or errors.
- **Out of scope:** listing, downloading, or deleting contracts; signature verification; malware scanning; any upload screen.
- Bundled: the first metrics helper and metrics contract for the service, required to measure the new upload.
- Bundled: a recovery check that turns on and proves database backups, point-in-time recovery, and bucket versioning.

## Instrumentation

- Metrics: contract upload duration (by outcome), failures by type, and in-flight count; Cloud Storage and token-fetch call duration and failures by host.
- Panels (spec-only, no dashboard yet): upload rate and success vs failure, failures by type, upload latency p50/p95/p99, uploads in flight, storage call latency by host.
- SLO: new "upload a signed contract" journey, 99.5% of non-client-caused uploads succeed over 30 days; burn-rate alert tiers only.
- These metrics are recorded in memory but will not appear on any graph until a metrics backend is chosen — this PR creates the metrics contract with backend `none yet` (suggested: Google Cloud Monitoring).

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/contracts.test.ts -t "stores a new PDF and returns 201"` — passes.
- [ ] Run `bun test src/contracts.test.ts -t "duplicate upload"` — passes.
- [ ] Run `bun test src/contracts.test.ts -t "missing or wrong credential"` — passes.
- [ ] Run `bun test src/contracts.test.ts -t "non-PDF body"` — passes.
- [ ] Run `bun test src/contracts.test.ts -t "over 10 MiB"` — passes.
- [ ] Run `bun test src/contracts.test.ts -t "missing company"` — passes.
- [ ] Run `bun test src/contracts.test.ts -t "storage failure"` — passes.
- [ ] Run `bun test src/contracts.test.ts -t "fails closed"` — passes.
- [ ] Run `bun test src/contracts.test.ts -t "sheds load"` — passes.
- [ ] Run `bun test src/storage.test.ts src/metrics.test.ts` — passes.
- [ ] Run `bash -n deploy.sh && bash -n scripts/check-recovery.sh && grep -q -- '--public-access-prevention' deploy.sh` — exits 0.
- [ ] DECISION: you accept one shared upload credential for v1, meaning any holder can file a contract under any company name until per-customer sign-in ships.
