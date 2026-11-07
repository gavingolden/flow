# PRD

# Contract upload

**Goal:** Customers upload a signed PDF contract in one request, get back a stored record, and every contract file is kept in Cloud Storage with one matching database row.

## Problem Statement

The reports service produces company reports, but it has nowhere to keep the signed contract a customer agrees to. Today a customer cannot hand that contract to the service at all, so it lives in email threads or someone's drive, and nobody can say for certain which signed version is on record. That costs the customer a re-send whenever the contract is needed, and it costs the business a reliable record of what was signed.

Evidence from the current service:

| Fact | Anchor |
| --- | --- |
| The service has two routes: section generation and report reads. Neither accepts a file. | src/app.ts:9-15 |
| The schema has only `reports` and `sections`. There is no table for documents or customers. | migrations/001_reports.sql:1-14 |
| The whole service is deployed open to the internet, and no route checks who is calling. | deploy.sh:4 |
| No Cloud Storage bucket, client, or dependency exists. The service talks to Google APIs over raw HTTP. | src/queue.ts:5, package.json:1-10 |

User experience comes first in the product brief, so the customer should do one thing (upload the file) and get an immediate yes or no, with no second confirmation step. Cost comes second: the design has to say what each upload costs and keep that spend limited to authenticated callers.

> **Research findings (prior context, discovery Step 1.5, partial run).** The gather step ran. Both adversarial refute steps failed on agy quota, so none of these claims was cross-checked.
> - [high] Cloud Run limits HTTP/1 request bodies to 32 MiB per request (https://cloud.google.com/run/docs/quotas).
> - [high] A Cloud Run service can get a keyless access token from the metadata server, and `roles/storage.objectCreator` is enough to create objects through the JSON API media upload (https://cloud.google.com/run/docs/securing/service-identity).
> - [high] Keyless V4 signed URLs need the IAM Credentials `signBlob` call plus `roles/iam.serviceAccountTokenCreator`, and those signatures are only reliable for about 12 hours (https://cloud.google.com/storage/docs/authentication/create-signatures).
> - [medium] The client sets Content-Type and filename, so neither can be trusted. Validate the `%PDF-` header bytes on the server.
> - [low] Typical signed contracts are 100 KB to 10 MB. No primary source was quoted, so this is treated as a risk, not a decision.

## Request vetting

- **Hypothesis:** Customer contract PDFs fit under Cloud Run's 32 MiB request cap, so the service can validate each file in memory and write it to Cloud Storage and Postgres in one request, staying within the 10 s interactive budget.
- **Case against:** The service is deployed `--allow-unauthenticated` and no handler checks callers [anchor: deploy.sh:4]. Built as literally asked, an upload route turns our bucket into a free public file host and a cost sink. Separately, proxying bytes through Cloud Run hard-fails at 32 MiB (https://cloud.google.com/run/docs/quotas). A large scanned contract with annexes gets a 413 from the platform, and the service never sees that request.
- **Sources:** https://cloud.google.com/run/docs/quotas
- **Verdict:** adopt-with-conditions: the upload route returns 401 to callers without the upload key and 415 to bodies without the `%PDF-` header, both before any byte reaches Cloud Storage, and it rejects files over 25 MiB with 413

## Existing-code assessment

- **src/app.ts:** keep — the if-chain router takes a third route cleanly. The new handler lives in its own module, the same way the section worker does [anchor: src/app.ts:9]
- **src/db.ts:** keep — tagged-template `sql` queries with exported typed helpers fit two more contract functions [anchor: src/db.ts:6-17]
- **migrations/:** keep — numbered SQL files with text primary keys. The new table follows as `002` [anchor: migrations/001_reports.sql:1]
- **deploy.sh:** keep — it already provisions infrastructure idempotently (`… || true`) before deploy. The bucket setup follows the same line pattern [anchor: deploy.sh:3]

## Scope Boundary

**In scope:**

- A new authenticated upload route that takes one PDF per request for a named customer.
- Server-side checks: caller key, size cap (25 MiB), `%PDF-` header bytes.
- File storage in a private Cloud Storage bucket. The object is named by the file's SHA-256 and written create-only (never overwritten).
- A new `contracts` table with one row per stored file. A duplicate upload of the same file for the same customer returns the existing row.
- Bucket provisioning in the deploy script (private, versioned, create-only grant for the service account), plus a recovery check script.
- Metrics for the upload and its outbound calls, plus the repo's first metrics contract file.

**Out of scope:**

- Reading, listing, or downloading stored contracts (candidate follow-up #3).
- Verifying the PDF's digital signature. "Signed" is read as a description of the document, not something we validate (see Open Questions).
- Malware scanning, retention locks, and legal holds (candidate follow-up #2).
- A browser upload page. This plan adds an HTTP route only.
- Customer accounts or per-customer credentials (see Q1).

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| A customer has no way to give the service a signed contract | The customer (through the calling app) sends the PDF in one request and gets a `201` with the stored record within a few seconds |
| Re-sending the same contract has no effect anywhere | Re-sending the identical file returns `200` with the original record. No duplicate is stored |
| n/a | A non-PDF, an oversize file, or a missing upload key gets a clear `415` / `413` / `401` with nothing stored |

### System flow

- **Before:**
  - The service writes only report and section rows. It holds no customer files.
- **After:**
  - Each accepted upload writes one create-only object to a private, versioned contracts bucket and one `contracts` row keyed by customer and file hash.
  - The service fetches a short-lived access token from the Cloud Run metadata server and caches it. No key file and no new dependency.
  - Upload latency, outcome, and outbound-call metrics are recorded through a new in-memory metrics helper. They won't show on any graph until a metrics backend is chosen.

**Lost:** none

## User Stories / Acceptance Criteria

### Story 1: Upload a signed contract

- [ ] Given a valid upload key and a PDF under 25 MiB, when it is POSTed as multipart field `file` to `/customers/{customerId}/contracts`, then the response is `201` with `{id, customerId, filename, sizeBytes, sha256, uploadedAt}`, one object exists at `contracts/{customerId}/{sha256}.pdf`, and one row exists. Check: `bun test src/contracts.test.ts` (stubbed storage and db).
- [ ] Given the same file is uploaded again for the same customer, when the request completes, then the response is `200` with the original record's `id`, and the stubbed storage 412 "already exists" is treated as success. Check: `bun test src/contracts.test.ts`.

### Story 2: Reject bad uploads before storing anything

- [ ] Given no `Authorization: Bearer <key>` header, or a wrong key, when uploading, then the response is `401` and storage is never called. Check: `bun test src/contracts.test.ts`.
- [ ] Given a body whose first 1024 bytes contain no `%PDF-`, when uploading, then the response is `415` and storage is never called. Check: `bun test src/contracts.test.ts`.
- [ ] Given a `Content-Length` or file size over 26,214,400 bytes, or a `customerId` not matching `^[A-Za-z0-9_-]{1,64}$`, when uploading, then the response is `413` or `400` respectively, with nothing stored. Check: `bun test src/contracts.test.ts`.

### Story 3: Failures are visible, not silent

- [ ] Given Cloud Storage answers 5xx or times out, when uploading, then the response is `503` with `Retry-After`, no row is written, and the failures counter records `upstream_error` or `upstream_timeout`. Check: `bun test src/contracts.test.ts src/metrics.test.ts`.

## Instrumentation

**Contract:** .flow/metrics.md create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports_service.contract.upload.duration` | Histogram | seconds | operation.outcome (ok, error) | contract upload handler |
| `reports_service.contract.upload.failures` | Counter | none | error.type (`_OTHER`, internal, invalid_input, unauthorized, upstream_error, upstream_timeout) | contract upload handler |
| `reports_service.outbound.duration` | Histogram | seconds | server.address (storage.googleapis.com, metadata.google.internal), operation.outcome (ok, error) | storage client |
| `reports_service.outbound.failures` | Counter | none | error.type (same six values), server.address (same two hosts) | storage client |

Estimated series: 40 per operation (contract upload: 2 × 17 + 6). Samples/month: about 1.7 million per instance at a 60 s export interval.
Estimated series: 80 per operation (outbound calls: 2 × 2 × 17 + 6 × 2). Samples/month: about 3.5 million per instance at a 60 s export interval.

**Attributes:** new registry seeded from the starter keys used here: `operation.outcome`, `error.type`, `server.address` (closed host list above). These become the first `.flow/metrics.md` `## Attributes` rows.

### Error types

New list, seeded from the starter values: `_OTHER` (fallback), `internal` (unexpected failure in this service), `invalid_input` (bad customer id, non-PDF, oversize; client-caused), `unauthorized` (missing or wrong upload key; client-caused), `upstream_error` (Cloud Storage, metadata server, or database answered with a failure), `upstream_timeout` (a dependency did not answer in time).

### Dashboard panels

- "Contract uploads: rate, error ratio, p95 duration" on the `reports-service overview` dashboard (spec-only until a backend exists).
- "Outbound calls by host: p95 duration and failures" on the same dashboard.

### Alerts

burn-rate tiers only

### SLO

New journey SLO, "Contract upload": 99.5% of uploads not rejected for a client-caused reason (`invalid_input`, `unauthorized`) succeed over 28 days.

**As-code:** spec-only — the repo keeps no dashboard or alert config, and no metrics backend is chosen yet.

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | DB (new migration), persistence (`src/db.ts`), integration (new Cloud Storage client), HTTP handler (new module plus one route), infra (`deploy.sh`) |
| Domain modules | Existing: `app`, `db`. New: `contracts` (upload handler), `storage` (Cloud Storage REST client), `metrics` (in-memory helper) |
| Data flow | Caller → upload route → key, size, and header checks → SHA-256 → Cloud Storage create-only write → `contracts` insert (on conflict, return the existing row) → JSON record |
| Pattern | Existing raw-`fetch` Google API client pattern (`src/queue.ts`) and single-purpose handler module (`src/worker.ts`). The only new pattern is the metrics helper, required by the instrumentation contract |
| Binary-framing check | The request does not frame a binary. The one real fork, server proxy vs. direct-to-bucket signed URL, has a middle ground (proxy now, signed URLs only if real uploads approach the cap), recorded in Decision analysis |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| Contract upload handler | ~3 s | inline (one storage write plus one row, under the 10 s budget) | 30 s handler deadline; storage call 20 s; db call 5 s | none in the service; the client retries `503` after `Retry-After` (one layer) | customer id + file SHA-256 (unique row; object name derived from it) | 25 MiB per file; authenticated callers only; no paid API calls |
| Access-token fetch | inline — ~50 ms, timeout 2 s | inline, cached until 5 minutes before expiry | 2 s | none | n/a (read-only) | free metadata-server call |
| Cloud Storage media upload | inline — ~1 s, timeout 20 s | inline | 20 s | none (client layer only) | `ifGenerationMatch=0` on `contracts/{customerId}/{sha256}.pdf`; a 412 means it is already stored | one write operation plus storage per GB-month per accepted file |

**Platform:** gcp

**Proportionality:** No queue (one ~1 s write fits the inline budget). No signed URLs or resumable uploads (files are capped well below the 32 MiB platform limit). No spend ledger (no paid API calls). No malware scanning (the service never serves files back). No delete permission for the service account (contracts are never removed by the app).
**Recovery:** Cloud Storage object versioning on the contracts bucket keeps a recoverable copy if an object is deleted. Objects are create-only, so they are never overwritten. The `contracts` table relies on Cloud SQL automated backups with point-in-time recovery. Task 7 enables versioning and adds `scripts/check-recovery.sh`, which fails unless bucket versioning and Cloud SQL point-in-time recovery are both on. Its `--restore-drill` mode runs the restore check: it clones the instance to a scratch copy at a point in time, compares the `contracts` row count, restores one noncurrent object version, then deletes the scratch copy. Run it once before launch and quarterly after.

## Technical Constraints

- File cap is 25 MiB, below Cloud Run's 32 MiB HTTP/1 request limit, leaving headroom for multipart framing (research finding 1, https://cloud.google.com/run/docs/quotas).
- No new runtime dependency: Cloud Storage is reached with `fetch` and the metadata-server token. Multipart parsing and SHA-256 use Bun built-ins (AGENTS.md: "No new runtime dependencies without a reason"; pattern src/queue.ts:5).
- The service is public (deploy.sh:4), so the upload route must authenticate the caller itself. The upload key is read from a Secret Manager-mounted env var, never baked into the image.
- Migrations are not applied by deploy (deploy.sh:1-4 runs none), so `002_contracts.sql` must be applied to Cloud SQL before the new revision serves traffic.
- Text primary keys follow the existing convention (migrations/001_reports.sql:2).

## Open Questions

- [ ] Q1: Who calls the upload route, and how is the customer identified? On redirect, Task 5's auth check and the route shape change.
  - **Stakes:** both — UX (top priority): if real customers call from browsers, a shared key cannot be given to them. Architecture: a shared key lets any holder upload for any customer id.
  - **Needs user input:** an external fact the agent cannot verify. The repo has no customer entity and no auth, so it shows nothing about who the callers are. The plan's default is a single shared upload key held by a trusted first-party app, with the customer id asserted in the path.
- [ ] Q2: Is point-in-time recovery enabled on the production Cloud SQL instance? On redirect, Task 7's recovery check passes as-is, or the user enables PITR before deploy.
  - **Stakes:** system — if PITR is off, a lost `contracts` table cannot be restored past the last backup, and the signed-contract record is gone even though the files survive.
  - **Needs user input:** credentials or production access — the instance configuration is not in the repo.
- [ ] Should the route take multipart form data or a raw PDF body? On redirect, Task 5's body parsing and the client contract change.
  - **Stakes:** user — the calling app must build its request in the chosen shape.
  - **Recommended:** multipart with one `file` field — browser file inputs and `FormData` send it natively, and it carries the original filename without a custom header [confidence: medium] [anchor: weighing: convention — the standard browser upload encoding]
- [ ] Is 25 MiB the right per-file cap? On redirect, the Task 5 constant changes. Above ~30 MiB the plan has to switch to signed URLs (Decision A).
  - **Stakes:** user — a customer with a larger scanned contract is refused.
  - **Recommended:** 25 MiB — the largest round cap that leaves multipart headroom under the platform's 32 MiB limit [confidence: medium] [anchor: weighing: risk — the platform 413 at 32 MiB is a hard failure the service cannot report]
- [ ] Should the service verify the PDF's digital signature? On redirect, a new task adds a PDF/PKCS#7 verifier and a new dependency.
  - **Stakes:** user — if "signed" meant verified, unverified files are accepted as contracts.
  - **Recommended:** no, store the file as received and treat "signed" as describing the document — verification needs a PDF signature parser, which is a new runtime dependency [confidence: medium] [anchor: weighing: footprint — AGENTS.md discourages new runtime dependencies]
- [ ] Should an identical re-upload return the existing record or store a second copy? On redirect, the unique constraint and the object naming change.
  - **Stakes:** both — duplicates confuse "which version is on record" (UX), and retries without dedupe create orphaned objects (system).
  - **Recommended:** return the existing record (`200`), keyed on customer id + SHA-256. This makes client retries safe and leaves no orphan when a row insert fails after the file is stored [confidence: medium] [anchor: weighing: reversibility — a later "keep every copy" mode only drops the constraint]
- [x] Should contract ids follow the repo's text-id convention? — resolved: `text` primary key holding `crypto.randomUUID()`
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision A — How do the file bytes reach Cloud Storage?** Exclusive for v1 (one upload contract per release).

| Branch | End-user flow | System flow | Interruptions per run |
| --- | --- | --- | --- |
| A1: proxy through the service (chosen) | The calling app sends one request with the file, waits ~1-3 s, and gets `201` with the record or a clear rejection | The service validates bytes in memory, writes one create-only object, inserts one row. A row failure after the write is healed by the client retry (412 means already stored) | 0 interruptions, 1 request |
| A2: direct-to-bucket V4 signed URL | The app asks for an upload URL, PUTs the file to Cloud Storage, then calls a confirm route. Three requests, and the upload can succeed while the confirm fails | Needs `signBlob` plus `roles/iam.serviceAccountTokenCreator`. The PDF is checked only after it lands (range read). Needs a quarantine prefix and cleanup for unconfirmed objects | 0 interruptions, 3 requests |
| A3: hybrid (proxy below the cap, signed URL above) | Small files as A1, large files as A2 | Both code paths, both IAM grants | 0 interruptions, 1 or 3 requests |

Ranked: A1 > A3 > A2. A1 is the fewest steps for the user and the smallest design. A3 is only worth it once real contracts approach 25 MiB. A2 pays signed-URL complexity on every upload with no gain below the cap. Verdict: **A1, proxy through the service, with a 25 MiB cap** — one request and synchronous validation, below the platform limit [confidence: high] [anchor: https://cloud.google.com/run/docs/quotas]

**Decision B — How does the route authenticate callers?** Exclusive.

| Branch | End-user flow | System flow |
| --- | --- | --- |
| B1: shared upload key in `Authorization: Bearer` (default) | Invisible to the customer. The calling app holds the key | One secret in Secret Manager, a constant-time compare, works on the public service |
| B2: Cloud Run IAM invoker (identity token) | Invisible to the customer. The calling app must be a Google identity | Requires removing `--allow-unauthenticated`, which also breaks the public report read route |
| B3: no auth (as literally requested) | Anyone can upload | The bucket becomes an open file host |

Ranked: B1 > B2 > B3. Verdict: **B1, shared upload key**, pending Q1 — the only branch that protects the bucket without changing who can reach the existing report route [confidence: medium] [anchor: adjacent: deploy.sh:4]

## Alternatives considered

- **Store PDFs in Postgres as `bytea`** — rejected: the user specified "store the files in Cloud Storage", and only metadata goes in the `contracts` table.
- **Use the `@google-cloud/storage` SDK** — rejected: AGENTS.md says "No new runtime dependencies without a reason", and the two REST calls needed (token, media upload) match the raw-`fetch` client already in src/queue.ts:5.

## Recommendation

**Proceed** — build Cloud Storage plus the `contracts` table as asked, with the vetting conditions (upload key, PDF header check, 25 MiB cap). Confirm the caller model in Q1 before merge [confidence: medium] [anchor: adjacent: deploy.sh:4]

**Redundancy:** none found

## Plan risks

The weakest assumption is that a single shared upload key matches how customers actually reach the service (Q1). If customers upload straight from a browser, that key leaks, and the auth model has to be redesigned around per-customer credentials before this route is safe.

## Cut list

- nothing — plan is minimal: the metrics helper and recovery script are required by the instrumentation and recovery contracts, and everything else (signed URLs, download, scanning, retention) is already cut to follow-ups.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Authenticate the section-worker route and the Cloud Tasks enqueue | High | Small | needs its own design/decision session: the open decision is whether to split the worker into its own non-public Cloud Run service or verify the Cloud Tasks OIDC token in the handler; meanwhile anyone can trigger paid model calls | same root cause (public service, no caller auth) on a different route | No |
| Retention policy / legal hold on the contracts bucket | Medium | Small | needs its own design/decision session: the open decision is the legally required retention period, and locking it is irreversible | protects the files this plan starts storing | No |
| Read and download stored contracts | Medium | Medium | needs its own design/decision session: the open decision is who may read whose contract (depends on Q1) and whether downloads stream through the service or use signed URLs | the natural read side of this upload | No |

- [x] Authenticate the section-worker route and the Cloud Tasks enqueue — the public worker route lets anyone trigger paid model generation, and the enqueue call sends no credential.
  - **UX:** none
  - **Problem:** any internet caller can POST to the section-worker route and trigger a 20-60 s paid model call [anchor: src/app.ts:9]
  - **Stability/efficiency:** none
  - **Value rank:** 5 — security exposure with unbounded paid spend on a service deployed open to the internet [anchor: deploy.sh:4]
  - **Complexity:** Small — the worker route, the enqueue call, deploy flags
  - **Risk:** Medium — changing who can reach the worker can stall section generation if misconfigured
  - **If never done:** anyone who finds the route can run up model-API spend with no cap
  - **Verdict:** clears bar — an open paid-call path outweighs a small, contained change
- [ ] Retention policy / legal hold on the contracts bucket — keep signed contracts undeletable for the legally required period.
  - **UX:** none
  - **Problem:** a project admin can delete a signed contract before any retention period ends; versioning only helps until the noncurrent copy is removed [anchor: user: "let customers upload their signed PDF contracts"]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk with no stated legal requirement yet [anchor: user: "let customers upload their signed PDF contracts"]
  - **Complexity:** Small — one bucket setting in the deploy script
  - **Risk:** High — a locked retention policy cannot be shortened or removed
  - **If never done:** contracts stay deletable by project admins
  - **Verdict:** below bar — the retention period is a legal input nobody has stated, and a wrong lock is irreversible
- [ ] Read and download stored contracts — let a customer or operator list and fetch the contracts on record.
  - **UX:** customers cannot retrieve what they uploaded through the service [anchor: user: "let customers upload their signed PDF contracts"]
  - **Problem:** none
  - **Stability/efficiency:** none
  - **Value rank:** 2 — a single missing capability; operators can still read the bucket directly [anchor: user: "let customers upload their signed PDF contracts"]
  - **Complexity:** Medium — list route with pagination, download path, access rules
  - **Risk:** Medium — exposes stored contracts, so it depends on the Q1 auth model
  - **If never done:** contracts are retrievable only by operators with bucket access
  - **Verdict:** below bar — blocked on the Q1 caller-identity answer

# Task breakdown

### Task 1: Add the contracts table migration

- **Skill:** `flow-new-feature`
- **Description:** Create the `contracts` table: one row per stored file, unique per customer and file hash.
- **Inputs:** migrations/001_reports.sql (conventions)
- **Outputs:** migrations/002_contracts.sql
- **Contract:**
  - **Files:** migrations/002_contracts.sql (create)
  - **Interfaces:** DDL:
    ```sql
    create table contracts (
      id text primary key,
      customer_id text not null,
      object_name text not null,
      filename text not null,
      size_bytes bigint not null check (size_bytes > 0),
      sha256 text not null,
      uploaded_at timestamptz not null default now(),
      unique (customer_id, sha256)
    );
    ```
  - **Call-site edits:** none
- **Acceptance criteria:** `grep -q 'create table contracts' migrations/002_contracts.sql && grep -q 'unique (customer_id, sha256)' migrations/002_contracts.sql`

### Task 2: Contract persistence helpers

- **Skill:** `flow-new-feature`
- **Description:** Add the `Contract` type and two queries in the existing tagged-template style. `insertContract` uses `on conflict (customer_id, sha256) do nothing returning *`. `findContractByHash` returns the existing row for the duplicate path.
- **Inputs:** Task 1; src/db.ts
- **Outputs:** two exported functions and one exported type in src/db.ts
- **Contract:**
  - **Files:** src/db.ts (edit)
  - **Interfaces:** `export type Contract = { id: string; customer_id: string; object_name: string; filename: string; size_bytes: number; sha256: string; uploaded_at: string }`; `export async function insertContract(c: Omit<Contract, "uploaded_at">): Promise<Contract | undefined>` (undefined on conflict); `export async function findContractByHash(customerId: string, sha256: string): Promise<Contract | undefined>`
  - **Call-site edits:** none (new exports)
- **Acceptance criteria:** `bun -e 'const m = await import("./src/db.ts"); process.exit(typeof m.insertContract === "function" && typeof m.findContractByHash === "function" ? 0 : 1)'`

### Task 3: Metrics helper and metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create the repo's first metrics helper: `instrument(op, fn)`, `recordOutbound(host, fn)`, a closed `ErrorType` union (`_OTHER`, `internal`, `invalid_input`, `unauthorized`, `upstream_error`, `upstream_timeout`), a typed attribute map, an in-memory recorder that tests can read and reset, and an in-flight count inside `instrument`'s `try`/`finally`. Create `.flow/metrics.md` with Backend `none yet — suggested: Google Cloud Monitoring via OTLP, 60 s export interval`, Namespace `reports_service`, the Attributes, error.type values, Helper, Dashboard panels, Dashboards, Alerts (burn-rate tiers only), As-code `spec-only`, SLOs ("Contract upload", 99.5% over 28 days), and Coverage (`contract.upload`, `outbound`) from `## Instrumentation`.
- **Inputs:** none (new: src/metrics.ts)
- **Outputs:** src/metrics.ts, .flow/metrics.md
- **Contract:**
  - **Files:** src/metrics.ts (create), .flow/metrics.md (create)
  - **Interfaces:** `export type ErrorType = "_OTHER" | "internal" | "invalid_input" | "unauthorized" | "upstream_error" | "upstream_timeout"`; `export class OpError extends Error { constructor(type: ErrorType, status: number, message: string) }`; `export async function instrument<T>(op: "contract.upload", fn: () => Promise<T>): Promise<T>`; `export async function recordOutbound<T>(host: "storage.googleapis.com" | "metadata.google.internal", fn: () => Promise<T>): Promise<T>`; `export const recorder: { observations: Array<{ metric: string; value: number; attrs: Record<string, string> }>; reset(): void }`
  - **Call-site edits:** none (consumed by Tasks 4 and 5)
- **Acceptance criteria:** `test -f .flow/metrics.md && grep -q '## error.type values' .flow/metrics.md && bun -e 'const m = await import("./src/metrics.ts"); process.exit(typeof m.instrument === "function" ? 0 : 1)'`

### Task 4: Cloud Storage REST client

- **Skill:** `flow-system-design`
- **Description:** A keyless Cloud Storage client over `fetch`. `getAccessToken` reads the metadata server (`Metadata-Flavor: Google`, 2 s timeout) and caches the token until 5 minutes before `expires_in`. `uploadObject` POSTs to `https://storage.googleapis.com/upload/storage/v1/b/{bucket}/o?uploadType=media&name={encoded}&ifGenerationMatch=0` with `Content-Type: application/pdf` and a 20 s `AbortSignal.timeout`. It returns `"created"` on 200 and `"exists"` on 412. It throws `OpError("upstream_timeout")` on timeout and `OpError("upstream_error")` on any other non-2xx. Both calls are wrapped in `recordOutbound`. The bucket comes from `CONTRACTS_BUCKET`. `fetch` is injectable for tests.
- **Inputs:** Task 3; src/queue.ts (raw-fetch Google API pattern)
- **Outputs:** src/storage.ts
- **Contract:**
  - **Files:** src/storage.ts (create)
  - **Interfaces:** `export async function getAccessToken(fetchImpl?: typeof fetch): Promise<string>`; `export async function uploadObject(name: string, body: Uint8Array, fetchImpl?: typeof fetch): Promise<"created" | "exists">`
  - **Call-site edits:** none (consumed by Task 5)
- **Acceptance criteria:** `bun -e 'const m = await import("./src/storage.ts"); process.exit(typeof m.uploadObject === "function" && typeof m.getAccessToken === "function" ? 0 : 1)'`

### Task 5: Upload handler and route

- **Skill:** `flow-new-feature`
- **Description:** `handleUploadContract` runs inside `instrument("contract.upload", …)` under a 30 s overall deadline:
  1. Reject `customerId` outside `^[A-Za-z0-9_-]{1,64}$` with 400.
  2. Compare `Authorization: Bearer` against `UPLOAD_API_KEY` in constant time (`crypto.timingSafeEqual`). Missing or wrong key gets 401.
  3. Reject `Content-Length` over 26,214,400 with 413 before reading the body.
  4. Parse `req.formData()` and take the `file` field. Missing gets 400. Size over the cap gets 413. No `%PDF-` in the first 1024 bytes gets 415.
  5. Compute the SHA-256 hex with `Bun.CryptoHasher`.
  6. Call `uploadObject("contracts/{customerId}/{sha256}.pdf")`.
  7. Call `insertContract` with `id = crypto.randomUUID()`, under a 5 s timeout. On conflict, call `findContractByHash` and return 200; otherwise return 201.

  Map `OpError` to its status with a JSON `{error}` body, and upstream failures to 503 with `Retry-After: 5`. Register the route in `handle`.
- **Inputs:** Tasks 2, 3, 4; src/worker.ts (handler-module pattern)
- **Outputs:** src/contracts.ts, a route in src/app.ts
- **Contract:**
  - **Files:** src/contracts.ts (create), src/app.ts (edit)
  - **Interfaces:** `export type UploadDeps = { uploadObject: typeof uploadObject; insertContract: typeof insertContract; findContractByHash: typeof findContractByHash; apiKey: string | undefined }`; `export async function handleUploadContract(req: Request, customerId: string, deps?: UploadDeps): Promise<Response>`; `export const MAX_CONTRACT_BYTES = 26_214_400`
  - **Call-site edits:** src/app.ts `handle` — add `const c = url.pathname.match(/^\/customers\/([^/]+)\/contracts$/); if (req.method === "POST" && c) return handleUploadContract(req, decodeURIComponent(c[1]));` before the reports route
- **Acceptance criteria:** `grep -q 'handleUploadContract' src/app.ts && bun -e 'const m = await import("./src/contracts.ts"); process.exit(m.MAX_CONTRACT_BYTES === 26214400 ? 0 : 1)'`

### Task 6: Tests for the upload path, storage client, and metrics

- **Skill:** `flow-testing`
- **Description:** Bun tests with injected deps and `fetch` (no network, no database).
  - **contracts:** 201 happy path; 200 duplicate; 401 missing and wrong key; 400 bad customer id and missing file; 413 by header and by size; 415 non-PDF, with storage never called on any rejection; 503 plus `Retry-After` on an upstream error.
  - **storage:** token cached across calls; 412 maps to `"exists"`; abort maps to `upstream_timeout`; 500 maps to `upstream_error`.
  - **metrics:** one `operation.outcome=ok` observation on success, one error observation plus one failures increment per error type, an unlisted error falls to `_OTHER`, and the in-flight count returns to 0 on both paths.
- **Inputs:** Tasks 3, 4, 5
- **Outputs:** src/contracts.test.ts, src/storage.test.ts, src/metrics.test.ts
- **Contract:**
  - **Files:** src/contracts.test.ts (create), src/storage.test.ts (create), src/metrics.test.ts (create)
  - **Interfaces:** none (tests only)
  - **Call-site edits:** none
- **Acceptance criteria:** `bun test src/contracts.test.ts src/storage.test.ts src/metrics.test.ts`

### Task 7: Provision the bucket and add the recovery check

- **Skill:** `flow-system-design`
- **Description:** Extend the deploy script in its existing idempotent style:
  - Create a private bucket with uniform access and public-access prevention, and turn on object versioning.
  - Grant the runtime service account `roles/storage.objectCreator` only (no delete, no overwrite).
  - Pass `CONTRACTS_BUCKET` and the Secret Manager-backed `UPLOAD_API_KEY` to the service.

  Add a recovery check script that exits non-zero unless bucket versioning is on and the Cloud SQL instance has point-in-time recovery enabled. Add a `--restore-drill` mode that runs the restore check end to end: clone the instance with `gcloud sql instances clone --point-in-time`, assert the clone's `contracts` row count equals the source's, restore one noncurrent object version with `gcloud storage cp` from its generation, then delete the clone.
- **Inputs:** deploy.sh
- **Outputs:** an updated deploy.sh and scripts/check-recovery.sh
- **Contract:**
  - **Files:** deploy.sh (edit), scripts/check-recovery.sh (create, executable)
  - **Interfaces:** config/infra, deploy.sh:
    - Before the `gcloud run deploy` line, add:
      - `gcloud storage buckets create "gs://${CONTRACTS_BUCKET}" --location us-central1 --uniform-bucket-level-access --public-access-prevention || true`
      - `gcloud storage buckets update "gs://${CONTRACTS_BUCKET}" --versioning`
      - `gcloud storage buckets add-iam-policy-binding "gs://${CONTRACTS_BUCKET}" --member "serviceAccount:${RUN_SERVICE_ACCOUNT}" --role roles/storage.objectCreator`
    - On the deploy line, add `--update-env-vars CONTRACTS_BUCKET=${CONTRACTS_BUCKET} --update-secrets UPLOAD_API_KEY=contracts-upload-key:latest`.
    - scripts/check-recovery.sh asserts that `gcloud storage buckets describe "gs://${CONTRACTS_BUCKET}" --format='value(versioning_enabled)'` is `True` and that `gcloud sql instances describe "${SQL_INSTANCE}" --format='value(settings.backupConfiguration.pointInTimeRecoveryEnabled)'` is `True`.
  - **Call-site edits:** none
- **Acceptance criteria:** `bash -n deploy.sh && bash -n scripts/check-recovery.sh && grep -q -- '--versioning' deploy.sh && grep -q 'roles/storage.objectCreator' deploy.sh && grep -q 'pointInTimeRecoveryEnabled' scripts/check-recovery.sh && grep -q 'restore-drill' scripts/check-recovery.sh`

| Task | Depends on |
| --- | --- |
| 1 | — |
| 2 | 1 |
| 3 | — |
| 4 | 3 |
| 5 | 2, 3, 4 |
| 6 | 3, 4, 5 |
| 7 | — |

**Skills Summary**

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-new-feature | Yes (Tasks 1, 2, 5) | New table, persistence helpers, and the upload handler |
| flow-system-design | Yes (Tasks 4, 7) | Outbound-call timeouts, create-only idempotent writes, bucket recovery settings |
| flow-metrics | Yes (Task 3) | First instrumented change; creates the helper and `.flow/metrics.md` |
| flow-testing | Yes (Task 6) | Handler, storage-client, and emission tests with injected deps |
| flow-ui-ux | No | No UI surface in this plan |
| flow-refactoring | No | Existing modules are extended in place; nothing to restructure |

# PR description draft

## TLDR

Customers can now upload a signed PDF contract to the reports service in one request; before, there was nowhere to send it, and now each file is kept privately with one database record.

## User-facing changes

- New upload route: the calling app sends a customer's signed PDF and gets back the stored record (id, filename, size, file hash, upload time) in one request.
- Re-sending the identical file for the same customer returns the original record instead of storing a duplicate, so retries are safe.
- Uploads without the upload key, non-PDF files, and files over 25 MiB are refused with a clear error, and nothing is stored.

## System changes

- The service now stores customer files:
  - **Before:** the service held only report and section rows and touched no file storage.
  - **After:** each accepted upload writes one create-only file to a private, versioned contracts bucket and one row to a new contracts table, keyed by customer and file hash.
- The service now authenticates callers on one route: the upload route requires a shared upload key held in Secret Manager. Every other route stays as open as before.
- Ongoing cost: one storage write per accepted upload, plus storage billed per GB-month for the files kept. There are no new paid API calls, and no new runtime dependency.
- The first metrics contract and helper: upload latency, outcome, and outbound-call metrics are recorded in memory and won't show on any graph until a metrics backend is chosen.

## Why

Customers have no way to hand the reports service the contract they signed, so the record of what was agreed lives outside the system and has to be re-sent whenever it is needed. The service is also open to the internet with no caller checks, so any place it accepts files has to protect itself.

## Key decisions

- Files go through the service rather than straight to the bucket with signed upload links. That makes one request and gives an immediate yes or no. Files over 25 MiB are refused because the platform hard-fails requests above 32 MiB.
- Callers prove themselves with one shared upload key. Requiring Google identities instead would have meant closing the whole service, including the public report reads. Whether one key matches how customers really reach the service is still open.
- Files are named by their content hash and written create-only. Retries are safe, a duplicate is never stored twice, and the service has no permission to delete or overwrite a contract.
- Signature verification, downloads, malware scanning, and retention locks are out of scope. Each needs its own decision.
- Google Cloud Storage is called directly over HTTP, not through Google's SDK, keeping the service free of new runtime dependencies.

## Instrumentation

- Metrics: contract-upload duration (by outcome) and failures (by error type); outbound-call duration and failures for Cloud Storage and the metadata server.
- Panels: "Contract uploads: rate, error ratio, p95 duration" and "Outbound calls by host" on the reports-service overview dashboard, spec-only.
- SLO: new "Contract upload" journey, 99.5% of non-client-caused uploads succeed over 28 days. Alerts use burn-rate tiers only.
- This PR creates the metrics contract with backend `none yet`. Graphs need a metrics backend choice (suggested: Google Cloud Monitoring via OTLP) before any of these appear.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/contracts.test.ts` — upload accepted (201), duplicate returns the original (200), and missing key (401), bad customer id (400), oversize (413), non-PDF (415), and storage failure (503) all pass with storage never called on a rejection.
- [ ] Run `bun test src/storage.test.ts` — token caching, "already exists" handling, and timeout/error mapping pass.
- [ ] Run `bun test src/metrics.test.ts` — success, per-error-type failure, `_OTHER` fallback, and in-flight return-to-zero emission tests pass.
- [ ] Run `grep -q 'create table contracts' migrations/002_contracts.sql && grep -q 'unique (customer_id, sha256)' migrations/002_contracts.sql` — the migration has the table and its dedupe constraint.
- [ ] Run `bash -n deploy.sh && grep -q -- '--versioning' deploy.sh && grep -q 'roles/storage.objectCreator' deploy.sh` — bucket provisioning is versioned and create-only.
- [ ] Run `test -f .flow/metrics.md && grep -q '## error.type values' .flow/metrics.md` — the metrics contract exists.
- [ ] DECISION: you accept one shared upload key (any holder can upload for any customer id) as v1 caller authentication, instead of per-customer credentials.
