# PRD

# Signed contract uploads

**Goal:** A customer's signed PDF contract can be handed in, kept privately and durably in Cloud Storage, and looked up later with a verified upload status.

## Problem Statement

The reports service produces company reports, but it has no way to accept documents from customers. A customer who signs a contract today has nowhere in this system to return the signed copy, so it ends up in email threads or someone's drive, with no record of who sent what or when. The service also cannot tell one caller from another: it is open to the internet and checks no one, so accepting confidential legal documents safely needs more than a place to put the file.

**Premise check:** the request assumes "customers" the service can recognise; the codebase has no customer identity and no authentication at all. The service is deployed publicly (`deploy.sh:4`, `--allow-unauthenticated`), its only data owner field is a free-text `company` on reports (`migrations/001_reports.sql:3`), and no route checks a caller (`src/app.ts:7-17`). The plan therefore adds an access gate the request did not name (see Q1 and Decision 2).

| Fact | Evidence |
| --- | --- |
| No file storage, bucket, or upload code exists | `src/` holds only `app.ts`, `db.ts`, `llm.ts`, `queue.ts`, `worker.ts` |
| Postgres via Bun's built-in `sql`, schema as numbered SQL files | `src/db.ts:1`, `migrations/001_reports.sql` |
| No runtime dependencies at all; AGENTS.md forbids adding one without a reason | `package.json`, `AGENTS.md` |
| Cloud Run HTTP/1 request bodies are capped at 32 MiB (research, high, un-refuted) | https://cloud.google.com/run/quotas#request_limits |

> **Research findings (prior context, discovery Step 1.5).** Gather ran; both adversarial refute entries failed on a provider quota, so these claims are un-refuted and the load-bearing ones carry a prompt-free backstop in the plan. (high) Google recommends direct-to-bucket uploads over proxying through Cloud Run. (high) Without an SDK, V4 signed URLs are built by hand and signed via the IAM Credentials `signBlob` call, which needs Service Account Token Creator on the runtime account. (high) Signing `content-type`, `x-goog-content-length-range` and `x-goog-if-generation-match: 0` pins type, size range and no-overwrite. (medium) A resumable upload session is a simpler alternative but its link stays valid for up to a week.

## Request vetting

- **Hypothesis:** Sending contract bytes straight to a private bucket by short-lived signed link, and flipping a `contracts` row to uploaded only after the service confirms the object, keeps every recorded row backed by a real PDF while keeping 25 MiB transfers off the service.
- **Case against:** The literal reading (upload to the service, write to Cloud Storage, insert a row) proxies files through a public, unauthenticated service that Cloud Run caps at 32 MiB per request, and an insert-on-upload row can exist for a file that never landed. [anchor: deploy.sh] [anchor: https://cloud.google.com/run/quotas#request_limits]
- **Case against (approach):** Hand-rolled V4 signing is easy to get subtly wrong, and only real Cloud Storage rejects a bad canonical request. [anchor: https://cloud.google.com/storage/docs/access-control/signing-urls-manually]
- **Sources:** https://cloud.google.com/run/quotas#request_limits, https://cloud.google.com/storage/docs/access-control/signed-urls, https://cloud.google.com/storage/docs/xml-api/reference-headers
- **Verdict:** adopt-with-conditions: contract endpoints reject any request without the service access token, file bytes go direct to a private bucket by signed link, and a row reaches `uploaded` only after the service confirms the object exists, is ≤25 MiB, and starts with `%PDF-`

## Existing-code assessment

- **src/app.ts (router):** keep — the method + regex path match extends cleanly with three contract routes [anchor: src/app.ts:7-17]
- **src/db.ts (persistence):** keep — the tagged-template `sql` functions are the pattern the contract queries follow [anchor: src/db.ts:6-17]
- **migrations/ (schema):** keep — a numbered `002_contracts.sql` follows `001_reports.sql` [anchor: migrations/001_reports.sql:1]
- **deploy.sh (infra):** keep — idempotent `gcloud … || true` lines extend with bucket, IAM, and secret setup; the deploy line switches to additive env/secret flags [anchor: deploy.sh:3-4]

## Scope Boundary

**In scope:**

- A `contracts` table (pending → uploaded | rejected) and a private, versioned bucket with public access blocked.
- Three authenticated endpoints: create an upload, confirm an upload, look up one contract (status + download link).
- Server-side confirmation: object exists, size within cap, content type, `%PDF-` file signature.
- Deploy-script setup: bucket, IAM bindings, signing API, access-token secret, Cloud SQL point-in-time-recovery check.
- The repo's first metrics helper and metrics contract, covering the new endpoints and outbound storage calls.

**Out of scope:** listing or deleting contracts; validating the digital signature inside the PDF; virus scanning; a customer account or identity system; linking contracts to reports; a pending-row cleanup job; any UI.

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| A customer's signed contract has no home in the service | The calling app asks for an upload and gets a 15-minute link that accepts only a PDF ≤25 MiB |
| — | The caller uploads straight to storage, then confirms; the contract shows `uploaded`, or `rejected` with a reason |
| No way to retrieve a stored contract | A lookup returns the contract's status and, once uploaded, a 5-minute download link |
| Every route is open to anyone | Contract routes refuse requests without the service access token |

### System flow

- **Before:**
  - Postgres holds only `reports` and `sections`; no object storage is used.
  - No route authenticates its caller.
- **After:**
  - A `contracts` row is created `pending` with a server-chosen object name `contracts/{id}.pdf`.
  - The service signs a V4 PUT link (via the IAM Credentials API) pinned to `application/pdf`, 1–26,214,400 bytes, and no-overwrite.
  - On confirm (or on the next lookup of a pending row) the service reads the object's metadata and first 5 bytes, then flips the row to `uploaded` (recording size, MD5, generation) or `rejected`.
  - Contract routes require a bearer token from Secret Manager and scope every read to the caller-named customer.

**Lost:** none — the change is additive; existing report routes, the worker route, and their behaviour are untouched.

## User Stories / Acceptance Criteria

### Story 1: Request an upload

- [ ] Given a request without `Authorization: Bearer <token>`, when it hits any contract route, then the response is 401 — asserted in `src/contracts.test.ts`.
- [ ] Given the access token is not configured, when any contract route is called, then the response is 503 (fail closed) — asserted in `src/contracts.test.ts`.
- [ ] Given a valid token, `X-Customer-Id: acme`, and body `{"filename":"msa.pdf"}`, when `POST /contracts` is called, then the response is 201 with a `pending` contract and an upload `{url, method:"PUT", headers}` whose headers pin `content-type: application/pdf`, `x-goog-content-length-range: 1,26214400`, `x-goog-if-generation-match: 0` — asserted in `src/contracts.test.ts`.
- [ ] Given a missing or malformed `X-Customer-Id` or filename, when `POST /contracts` is called, then the response is 400 and no row is inserted — asserted in `src/contracts.test.ts`.

### Story 2: Confirm an upload

- [ ] Given a pending contract whose object exists, is ≤25 MiB, and starts with `%PDF-`, when `POST /contracts/{id}/confirm` is called, then the row becomes `uploaded` with size, MD5, and generation recorded — asserted in `src/contracts.test.ts`.
- [ ] Given a pending contract whose object starts with other bytes, when confirm is called, then the row becomes `rejected` with reason `not_pdf` and the response is 422 — asserted in `src/contracts.test.ts`.
- [ ] Given a pending contract with no object yet, when confirm is called, then the response is 409 and the row stays `pending` — asserted in `src/contracts.test.ts`.
- [ ] Given an already-uploaded contract, when confirm is called again, then the stored row is returned unchanged with 200 and no storage call is made — asserted in `src/contracts.test.ts`.

### Story 3: Look up a contract

- [ ] Given an uploaded contract owned by `acme`, when `GET /contracts/{id}` is called with `X-Customer-Id: acme`, then the response carries the row and a GET download link — asserted in `src/contracts.test.ts`.
- [ ] Given a contract owned by `acme`, when it is looked up with `X-Customer-Id: other`, then the response is 404 — asserted in `src/contracts.test.ts`.
- [ ] Given a pending contract whose object has since landed, when it is looked up, then it is confirmed in the same request and returned `uploaded` — asserted in `src/contracts.test.ts`.

### Story 4: Storage is durable and private

- [ ] Given the migrations, when applied to a scratch Postgres, then both apply and the status check constraint rejects an unknown status — `psql -v ON_ERROR_STOP=1` exit codes.
- [ ] Given `deploy.sh`, when parsed and grepped, then it blocks public access, turns on versioning, and uses additive `--update-env-vars`/`--update-secrets` only — `bash -n` + `grep` exit codes.

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports_service.contracts.create.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | `POST /contracts` handler |
| `reports_service.contracts.create.failures` | Counter | none | `error.type` (`unauthorized`, `invalid_input`, `upstream_error`, `upstream_timeout`, `internal`, `_OTHER`) | `POST /contracts` handler |
| `reports_service.contracts.confirm.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | `POST /contracts/{id}/confirm` handler |
| `reports_service.contracts.confirm.failures` | Counter | none | `error.type` (`unauthorized`, `not_found`, `object_missing`, `not_pdf`, `upstream_error`, `upstream_timeout`, `internal`, `_OTHER`) | `POST /contracts/{id}/confirm` handler |
| `reports_service.contracts.get.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | `GET /contracts/{id}` handler |
| `reports_service.contracts.get.failures` | Counter | none | `error.type` (`unauthorized`, `not_found`, `upstream_error`, `upstream_timeout`, `internal`, `_OTHER`) | `GET /contracts/{id}` handler |
| `reports_service.storage.call.duration` | Histogram | seconds | `server.address` (`storage.googleapis.com`, `iamcredentials.googleapis.com`), `operation.outcome` (`ok`, `error`) | storage client outbound calls |
| `reports_service.storage.call.failures` | Counter | none | `server.address` (2 hosts), `error.type` (`upstream_error`, `upstream_timeout`) | storage client outbound calls |

Estimated series: 40 per operation for create (histogram 2 × 17 = 34, plus 6 `error.type` values), 42 for confirm (34 + 8), 40 for get (34 + 6), 72 for the outbound storage calls (2 hosts × 2 outcomes × 17 = 68, plus 2 × 2 = 4); all per instance. Samples/month on Google Cloud Monitoring at a 60 s export interval: about 194 series × 43,200 ≈ 8.4M per instance.

**Attributes:** registers `operation.outcome`, `error.type`, `server.address` (closed host list above) as the repo's first `## Attributes` rows

### Error types

New list seeded from the starter values: `_OTHER`, `internal`, `invalid_input` (client-caused), `not_found` (client-caused), `unauthorized` (client-caused), `upstream_error`, `upstream_timeout`, plus two new domain values: `object_missing` (confirm called before the file landed; client-caused) and `not_pdf` (the stored file does not start with the PDF signature; client-caused). Client-caused values are excluded from the availability SLO.

### Dashboard panels

Request rate, success vs failure, failures by `error.type`, and latency p50/p95/p99 for `contracts.create`, `contracts.confirm`, `contracts.get`, and outbound storage-call latency by `server.address`, on a new "reports-service overview" dashboard (spec-only).

### Alerts

burn-rate tiers only

### SLO

New journey SLO "upload a contract": 99.5% of `contracts.confirm` requests succeed over 30 days, excluding client-caused `error.type` values, with the standard burn-rate tiers (14.4x 1h/5m page, 6x 6h/30m page, 1x 3d/6h notify) recorded once in `.flow/metrics.md`.

**As-code:** spec-only — the repo keeps no dashboard or alert config and has no metrics backend yet

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | DB (new table), integration (Cloud Storage + IAM Credentials over plain HTTPS), HTTP handlers, deploy infra, metrics |
| Domain modules | Existing: `src/app.ts` (routes), `src/db.ts` (queries). New: `src/storage.ts` (bucket + signing client), `src/contracts.ts` (handlers + access gate), `src/metrics.ts` (helper) |
| Data flow | Caller → `POST /contracts` (pending row + signed PUT link) → caller PUTs bytes direct to the bucket → `POST /contracts/{id}/confirm` (metadata + 5-byte read → row uploaded/rejected) → `GET /contracts/{id}` (row + signed GET link) |
| Pattern | Existing: one small single-purpose module per concern (`AGENTS.md`), `fetch`-based Google API calls with no SDK (`src/queue.ts:5`). New: bearer-token access gate, justified because contract files are confidential and the service is public |
| Binary-framing check | "Store in Cloud Storage" was not framed as either/or; the hidden binary is proxy-vs-direct upload, with the resumable-session link as the middle option (Decision 1) |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| Create upload (`POST /contracts`) | ~400 ms | inline — ~400 ms, timeout 8 s | handler 8 s; metadata token 1 s; signBlob 5 s | none server-side; caller re-posts | none needed — each create mints a fresh id; a repeat only leaves an unconfirmed pending row | no paid call; storage only |
| Confirm upload (`POST /contracts/{id}/confirm`) | ~600 ms | inline — ~600 ms, timeout 8 s | handler 8 s; objects.get 5 s; 5-byte read 5 s | none server-side; caller re-posts | contract id — conditional update `where status = 'pending'`; a repeat returns the stored row | no paid call |
| Look up (`GET /contracts/{id}`) | ~700 ms | inline — ~700 ms, timeout 8 s | handler 8 s; each outbound call 5 s | none server-side; caller re-reads | contract id — same conditional update when it lazily confirms | no paid call |
| Outbound storage / signing calls | ~300 ms | inline — ~300 ms, timeout 5 s | 5 s per call via abort signal; metadata token 1 s, cached until 60 s before expiry | none (caller is the one retry layer) | n/a — reads, or signing with no side effect | Cloud Storage per-GB storage + per-operation charges |

**Platform:** gcp

**Proportionality:** no queue or worker — every operation is sub-second and the transfer itself never touches the service; no Pub/Sub finalize notification — a lookup of a pending row re-runs confirmation, which covers a caller that never confirms; no pending-row pruning job — pending rows are tiny and their count is bounded by create calls from one trusted caller; no per-caller rate limit — the single authenticated caller is trusted in v1.

**Recovery:** Postgres — Task 2 makes `deploy.sh` check that the Cloud SQL instance (`${CLOUD_SQL_INSTANCE:?}`) has automated backups and point-in-time recovery on, enables them if not, and re-reads the flag; bucket — object versioning plus the default soft-delete window keep any replaced or deleted contract recoverable, and the service account has no delete right. Restore check: Task 2's `deploy.sh` writes a canary object twice under `_restore-check/`, restores the first (noncurrent) generation, and exits non-zero if its contents differ. A full database clone-to-point-in-time drill costs a scratch instance and is a post-deploy follow-up.

**Rollback:** none — additive table, bucket, and routes; nothing is cut over, renamed, or dropped, so reverting the deploy leaves the new table and bucket unused but harmless.

## Technical Constraints

- File bytes must never transit the service: Cloud Run caps HTTP/1 request bodies at 32 MiB (research finding, high, https://cloud.google.com/run/quotas#request_limits).
- No Google Cloud SDK or other runtime dependency (`AGENTS.md`: "No new runtime dependencies without a reason"); all Google calls are `fetch` with `AbortSignal.timeout`, as `src/queue.ts:5` already does for Cloud Tasks.
- `deploy.sh` must use `--update-env-vars` / `--update-secrets`, never `--set-env-vars`: the service already depends on `SECTIONS_QUEUE` and `WORKER_URL` (`src/queue.ts:2`, `src/queue.ts:10`), which `deploy.sh` does not set, and `--set-env-vars` would replace them.
- The runtime service account needs `roles/iam.serviceAccountTokenCreator` on itself and the IAM Credentials API enabled, or every signing call fails (research finding, high, https://cloud.google.com/storage/docs/access-control/iam-roles); it gets `roles/storage.objectCreator` + `roles/storage.objectViewer` on the bucket and no delete right.
- The bucket uses uniform bucket-level access and enforced public access prevention; object names are server-generated (`contracts/{id}.pdf`), never derived from caller input.
- The repo has no typechecker (`package.json` has no TypeScript tooling), so the metrics helper's closed `error.type` list is enforced at runtime (unknown → `_OTHER`) and by test, not by `tsc`.
- Cost: each contract costs one signing call, one object write (by the caller), and two or three small object reads; storage grows with volume and versioning, and no model-API spend is added.

## Open Questions

- [ ] **Q1.** Who is the "customer", and how does the service know the caller is allowed to act for them? — a redirect replaces Task 6's access gate (per-customer keys add a `customers`/`api_keys` table task; an upstream identity token adds token verification).
  - **Stakes:** both — lands on user experience (priority 1: the wrong model either blocks the real client or lets one customer reach another's contracts) and architecture (priority 3: the trust boundary).
  - **Needs user input:** an external fact the agent cannot verify — the repo has no identity system and whether an upstream customer-facing app already authenticates customers is not visible here; the plan assumes one trusted server-side caller holding a shared token and naming the customer per request (Decision 2).
- [ ] What is the maximum contract size? — a redirect changes `MAX_CONTRACT_BYTES` and the signed size range in Task 4.
  - **Stakes:** user — user experience (priority 1): too low rejects real scanned contracts; too high only raises storage cost (priority 2).
  - **Recommended:** 25 MiB (26,214,400 bytes) — covers multi-page scanned signed contracts while bounding per-file storage spend; enforced by the signed header and re-checked on confirm [confidence: medium] [anchor: weighing: risk — the confirm-time size re-check backstops the signed range, so a wrong cap fails visibly as `rejected`, never silently]
- [ ] Do customers upload straight from a browser? — a redirect keeps or drops the bucket CORS step in Task 2.
  - **Stakes:** user — user experience (priority 1): without CORS a browser's direct upload fails outright.
  - **Recommended:** support both — `deploy.sh` applies a CORS rule for one origin only when `CONTRACTS_CORS_ORIGIN` is set, and does nothing otherwise [confidence: medium] [anchor: weighing: reversibility — a one-origin CORS rule is inert when unset and removable with one command]
- [ ] Does "signed" mean the service must validate the digital signature inside the PDF? — a redirect adds a PDF signature-validation stage to confirm, which needs a parsing library.
  - **Stakes:** user — product quality (priority 4): a forged or unsigned PDF would be recorded as a contract.
  - **Recommended:** no — treat "signed" as the customer's executed copy and verify only that the stored bytes are a PDF [confidence: medium] [anchor: weighing: effort — PAdES/PKCS#7 validation needs a PDF parser, and AGENTS.md bars new runtime dependencies without a reason]
- [ ] Must contracts be held under a legal retention lock? — a redirect adds a bucket retention policy to Task 2.
  - **Stakes:** system — architecture (priority 3): a locked retention policy can never be shortened or removed.
  - **Recommended:** versioning plus soft delete and no delete right for the service, with no retention lock in v1 [confidence: medium] [anchor: weighing: reversibility — versioning can be tightened into a retention policy later; a locked policy cannot be undone]
- [ ] Should a contract link to a report or company? — a redirect adds a foreign-key column to Task 1's DDL.
  - **Stakes:** system — architecture (priority 3): a later link means a migration and a backfill.
  - **Recommended:** no link; contracts carry a free-text `customer_id`, the same way reports carry a free-text `company` owner [confidence: high] [anchor: migrations/001_reports.sql:3]
- [x] How is the object named? — resolved: server-generated `contracts/{id}.pdf`, never caller input.
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision 1 — How do contract bytes reach the bucket: V4 signed PUT link, or resumable upload session link?** (proxying through the service is closed in Alternatives considered)

| | Signed PUT link (chosen) | Resumable session link |
| --- | --- | --- |
| Caller flow | `POST /contracts` → PUT file to link (≤15 min) → `POST …/confirm`; 0 interruptions, 3 calls | `POST /contracts` with exact byte size → PUT to session link (valid up to a week) → `POST …/confirm`; 0 interruptions, 3 calls |
| System | One signing call per link; same signer mints download links | One authenticated session-start call; downloads still need signing or proxying |
| Permissions | Token Creator on the runtime account | Bucket create only |
| Risk | Hand-built canonical request can mismatch (Plan risks) | Long-lived link; caller must know the exact size up front |

Exclusive. Ranked combinations: signed PUT + signed GET (one mechanism) > session upload + signed GET (two mechanisms) > session upload + proxied download. Verdict: **signed PUT link** — ranked against the brief, it ties on user experience (priority 1: same three calls) and cost (priority 2), and wins on architecture (priority 3) because one signer serves both upload and download and links expire in minutes [confidence: medium] [anchor: weighing: symmetry — one V4 signer covers Story 1's upload and Story 3's download].

**Decision 2 — How are contract requests gated: one shared service token with a caller-named customer, or per-customer API keys?** (Cloud Run IAM is closed in Alternatives considered)

| | Shared token (chosen) | Per-customer keys |
| --- | --- | --- |
| Caller flow | Trusted app sends `Authorization: Bearer <token>` + `X-Customer-Id`; 0 interruptions | Each customer's client sends its own key; 0 interruptions, but someone must issue and rotate keys |
| System | One Secret Manager secret, one constant-time compare | New keys table, issuance path, rotation, hashing |
| Isolation | Reads scoped to the named customer; a caller bug could name the wrong customer | Customer identity proven by key |

Exclusive. Ranked combinations: shared token now, per-customer keys if Q1 says customers call directly > per-customer keys now > no gate (rejected: confidential files on a public service). Verdict: **shared token** — it is the smallest gate that closes the public exposure, and it is replaceable without touching storage or schema; ranked against the brief, cost (priority 2) and architecture (priority 3) favour it while user experience (priority 1) is unchanged for a server-side caller [confidence: medium] [anchor: weighing: footprint — one secret and one compare versus a new table, issuance, and rotation flow].

## Alternatives considered

- **Proxy the PDF bytes through the service** — rejected: Cloud Run rejects HTTP/1 request bodies over 32 MiB (https://cloud.google.com/run/quotas#request_limits) and each upload would hold an instance on a public service (`deploy.sh:4`) for the whole transfer.
- **Gate the service with Cloud Run IAM (`--no-allow-unauthenticated`)** — rejected: it would also lock the existing public `GET /reports/{id}` route (`src/app.ts:10-15`, `deploy.sh:4`).
- **Use the Google Cloud Storage SDK** — rejected: `AGENTS.md` bars new runtime dependencies without a reason, and the four calls needed (token, signBlob, object metadata, ranged read) are plain HTTPS.

## Recommendation

**Reconsider scope** — build the upload, storage, and `contracts` table as asked, widened by an access gate, a confirm step, and a single-contract lookup the request did not name, because the service has no caller identity today (Premise check, Q1) and an unconfirmed row could point at a file that never arrived [confidence: high] [anchor: deploy.sh:4]

**Redundancy:** none found — no storage, upload, document, or contracts code exists; `src/` covers only reports, sections, the model client, and the section queue.

## Plan risks

The single weakest assumption is that a hand-built V4 signature (canonical request + `signBlob`) matches what Cloud Storage expects byte for byte: the unit tests mock `signBlob` and can only pin the string-to-sign, so a canonicalisation slip would make every upload fail with 403 on the first real deploy, and the research behind the signed-header details was not adversarially checked (the refute pass hit a provider quota).

## Cut list

- The `CONTRACTS_CORS_ORIGIN` CORS step in `deploy.sh` — drop it if Q1/Q3 confirm the caller is server-side only.
- The lazy confirm-on-lookup in `GET /contracts/{id}` could go if callers reliably confirm; it stays because it is the only prompt-free recovery for a missed confirm.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Authenticate the Cloud Tasks section-worker route | High | Medium | needs its own design/decision session: the open decision is whether to split the worker into its own `--no-allow-unauthenticated` Cloud Run service or verify the Cloud Tasks OIDC token in the handler; anyone can trigger paid model calls today | same public service and same "no caller is authenticated" root as this plan's access gate, but a different mechanism (OIDC) and a different path | No |

- [x] Authenticate the Cloud Tasks section-worker route — the public worker route lets anyone trigger paid model calls and overwrite report sections; add an OIDC token to enqueued tasks and accept only that caller.
  - **UX:** none
  - **Problem:** anyone on the internet can POST to the worker route and have the service generate and overwrite a report section [anchor: src/app.ts:9]
  - **Stability/efficiency:** each forged request triggers one model call that "takes 20-60 s per call and costs money per call", with no cap [anchor: src/llm.ts:1]
  - **Value rank:** 5 — security exposure and unbounded paid spend (brief priority 2, cost) with no workaround short of redeploying [anchor: deploy.sh:4]
  - **Complexity:** Medium — `src/queue.ts` (add `oidcToken`), `deploy.sh` (service split or invoker binding) or JWT verification in `src/worker.ts`
  - **Risk:** Medium — touches the live report-generation path
  - **If never done:** forged calls keep costing money and can overwrite report content at will
  - **Verdict:** clears bar — a live, exploitable paid-call exposure outweighs Medium complexity and risk

# Task breakdown

### Task 1: Add the contracts migration

- **Skill:** `flow-system-design`
- **Description:** Create the `contracts` table: one row per uploaded contract, moving `pending` → `uploaded` | `rejected`.
- **Inputs:** `migrations/001_reports.sql` (id-as-text convention)
- **Outputs:** `migrations/002_contracts.sql`
- **Contract:** _(schema change type — exact DDL)_
  - **Files:** create `migrations/002_contracts.sql`
  - **Interfaces:** `create table contracts (id text primary key, customer_id text not null, object_name text not null unique, original_filename text not null, content_type text not null default 'application/pdf', status text not null default 'pending' check (status in ('pending','uploaded','rejected')), rejection_reason text check (rejection_reason in ('not_pdf','too_large')), size_bytes bigint, md5_hash text, generation text, created_at timestamptz not null default now(), uploaded_at timestamptz);` `create index contracts_customer_created_idx on contracts (customer_id, created_at desc);`
  - **Call-site edits:** none (first task)
- **Acceptance criteria:** `psql "${TEST_DATABASE_URL:?}" -v ON_ERROR_STOP=1 -f migrations/001_reports.sql -f migrations/002_contracts.sql` exits 0 against a scratch Postgres

### Task 2: Provision the bucket, permissions, secret, and database recovery in deploy.sh

- **Skill:** `flow-system-design`
- **Description:** Extend `deploy.sh` with idempotent setup. Bucket `${CONTRACTS_BUCKET:?}` in us-central1 with uniform bucket-level access, enforced public access prevention, and object versioning. When `CONTRACTS_CORS_ORIGIN` is set, apply a CORS rule for that one origin (methods PUT, GET; headers `content-type`, `x-goog-content-length-range`, `x-goog-if-generation-match`). Enable `iamcredentials.googleapis.com`. Grant `${RUNTIME_SA:?}` Token Creator on itself and objectCreator + objectViewer on the bucket. Create the `contracts-api-token` secret if it is missing and grant the runtime account secretAccessor on it. Check Cloud SQL `${CLOUD_SQL_INSTANCE:?}` backups/PITR, enable them if off, then re-read the flag and exit non-zero if still off. Restore check: write `gs://$CONTRACTS_BUCKET/_restore-check/canary` with two different contents, restore the first (noncurrent) generation with `gcloud storage cp "gs://…/canary#<first-generation>"`, and exit non-zero if the restored contents differ from the first write. Switch the deploy line to additive `--update-env-vars CONTRACTS_BUCKET=… --update-secrets CONTRACTS_API_TOKEN=contracts-api-token:latest`.
- **Inputs:** `deploy.sh`
- **Outputs:** updated `deploy.sh`
- **Contract:** _(config / infra — key + before → after)_
  - **Files:** edit `deploy.sh`
  - **Interfaces:** new required env: `CONTRACTS_BUCKET`, `RUNTIME_SA`, `CLOUD_SQL_INSTANCE`; optional `CONTRACTS_CORS_ORIGIN`. Line 4 before: `gcloud run deploy reports-service --source . --region us-central1 --allow-unauthenticated`; after: the same plus `--service-account "$RUNTIME_SA" --update-env-vars "CONTRACTS_BUCKET=$CONTRACTS_BUCKET" --update-secrets "CONTRACTS_API_TOKEN=contracts-api-token:latest"`. New commands: `gcloud storage buckets create "gs://$CONTRACTS_BUCKET" --location us-central1 --uniform-bucket-level-access --public-access-prevention || true`; `gcloud storage buckets update "gs://$CONTRACTS_BUCKET" --versioning`; `gcloud services enable iamcredentials.googleapis.com`; `gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --member "serviceAccount:$RUNTIME_SA" --role roles/iam.serviceAccountTokenCreator`; `gcloud storage buckets add-iam-policy-binding … --role roles/storage.objectCreator` and `… roles/storage.objectViewer`; `gcloud sql instances describe "$CLOUD_SQL_INSTANCE" --format='value(settings.backupConfiguration.pointInTimeRecoveryEnabled)'` → patch with `--backup-start-time 03:00 --enable-point-in-time-recovery` when not `True`, then re-check
  - **Call-site edits:** none
- **Acceptance criteria:** `bash -n deploy.sh && grep -q -- '--public-access-prevention' deploy.sh && grep -q -- '--versioning' deploy.sh && grep -q 'pointInTimeRecoveryEnabled' deploy.sh && grep -q '_restore-check' deploy.sh && grep -q -- '--update-secrets' deploy.sh && ! grep -q -- '--set-env-vars' deploy.sh`

### Task 3: Add the metrics helper and metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create the repo's first metrics helper (zero-dependency in-memory recorder behind a swappable interface) and `.flow/metrics.md` with backend `none yet — suggested: Google Cloud Monitoring`, namespace `reports_service`, the attributes `operation.outcome`, `error.type`, `server.address`, the error list (`_OTHER`, `internal`, `invalid_input`, `not_found`, `unauthorized`, `upstream_error`, `upstream_timeout`, `object_missing`, `not_pdf`), the panels, the "upload a contract" SLO, burn-rate tiers, and Coverage rows for `contracts.create`, `contracts.confirm`, `contracts.get`, and `storage.call`.
- **Inputs:** none (first instrumented change)
- **Outputs:** `src/metrics.ts`, `.flow/metrics.md`
- **Contract:**
  - **Files:** create `src/metrics.ts`, `.flow/metrics.md`
  - **Interfaces:** `export type ErrorType = "_OTHER" | "internal" | "invalid_input" | "not_found" | "unauthorized" | "upstream_error" | "upstream_timeout" | "object_missing" | "not_pdf"`; `export type Operation = "contracts.create" | "contracts.confirm" | "contracts.get"`; `export type ServerAddress = "storage.googleapis.com" | "iamcredentials.googleapis.com"`; `export interface Recorder { histogram(name: string, seconds: number, attrs: Record<string, string>): void; counter(name: string, inc: number, attrs: Record<string, string>): void }`; `export function setRecorder(r: Recorder): void`; `export function createMemoryRecorder(): Recorder & { histograms: Array<{name: string; seconds: number; attrs: Record<string, string>}>; counters: Array<{name: string; inc: number; attrs: Record<string, string>}> }`; `export function toErrorType(value: unknown): ErrorType` (unknown → `_OTHER`); `export async function instrument<T>(op: Operation, fn: () => Promise<{ value: T; errorType?: ErrorType }>): Promise<T>`; `export async function instrumentOutbound<T>(host: ServerAddress, fn: () => Promise<T>): Promise<T>`
  - **Call-site edits:** none (consumers arrive in Tasks 4 and 6)
- **Acceptance criteria:** `bun -e 'import { instrument, createMemoryRecorder, setRecorder, toErrorType } from "./src/metrics.ts"; const r = createMemoryRecorder(); setRecorder(r); await instrument("contracts.create", async () => ({ value: 1 })); if (r.histograms.length !== 1 || toErrorType("nope") !== "_OTHER") process.exit(1)' && test -f .flow/metrics.md`

### Task 4: Add the Cloud Storage and signing client

- **Skill:** `flow-system-design`
- **Description:** A `fetch`-only client: fetch and cache the runtime account's email and access token from the metadata server (1 s timeout; cache until 60 s before expiry); build V4 signed URLs (GOOG4-RSA-SHA256, path-style `storage.googleapis.com/{bucket}/{object}`, `UNSIGNED-PAYLOAD`) signed via `iamcredentials` `signBlob` with the base64 result hex-encoded; read object metadata (`null` on 404); read the first N bytes with `Range`. Every outbound call uses `AbortSignal.timeout(5000)` and goes through `instrumentOutbound`; an abort maps to `StorageError("upstream_timeout")`, any non-2xx (other than a metadata 404) to `StorageError("upstream_error")`.
- **Inputs:** `src/metrics.ts` (Task 3); existing `fetch`-to-Google pattern in `src/queue.ts`
- **Outputs:** `src/storage.ts`
- **Contract:**
  - **Files:** create `src/storage.ts`
  - **Interfaces:** `export const MAX_CONTRACT_BYTES = 26_214_400`; `export const UPLOAD_URL_TTL_SEC = 900`; `export const DOWNLOAD_URL_TTL_SEC = 300`; `export type SignedRequest = { url: string; method: "PUT" | "GET"; headers: Record<string, string>; expiresAt: string }`; `export function buildStringToSign(input: { method: "PUT" | "GET"; bucket: string; objectName: string; headers: Record<string, string>; email: string; now: Date; expiresSec: number }): { stringToSign: string; url: string }` (pure, for the golden test); `export async function signUploadUrl(objectName: string, now?: Date): Promise<SignedRequest>` (signed headers `content-type: application/pdf`, `host`, `x-goog-content-length-range: 1,26214400`, `x-goog-if-generation-match: 0`); `export async function signDownloadUrl(objectName: string, now?: Date): Promise<SignedRequest>`; `export type ObjectMetadata = { size: number; contentType: string; md5Hash: string; generation: string }`; `export async function getObjectMetadata(objectName: string): Promise<ObjectMetadata | null>`; `export async function readObjectPrefix(objectName: string, bytes: number): Promise<Uint8Array>`; `export class StorageError extends Error { constructor(readonly errorType: "upstream_error" | "upstream_timeout", message: string) }`. Bucket read from `process.env.CONTRACTS_BUCKET` at call time.
  - **Call-site edits:** none (consumer arrives in Task 6)
- **Acceptance criteria:** `bun -e 'import { buildStringToSign } from "./src/storage.ts"; const { stringToSign } = buildStringToSign({ method: "PUT", bucket: "b", objectName: "contracts/x.pdf", headers: { "content-type": "application/pdf" }, email: "sa@p.iam.gserviceaccount.com", now: new Date("2026-01-01T00:00:00Z"), expiresSec: 900 }); if (!stringToSign.startsWith("GOOG4-RSA-SHA256\n20260101T000000Z\n20260101/auto/storage/goog4_request\n")) process.exit(1)'`

### Task 5: Add contract persistence

- **Skill:** `flow-system-design`
- **Description:** Add contract queries to `src/db.ts` using the existing tagged-template `sql` style. `markContractUploaded` and `markContractRejected` update only `where id = $1 and status = 'pending'` and return the updated row (or `undefined` when nothing changed), which makes confirm idempotent on the contract id.
- **Inputs:** `migrations/002_contracts.sql` (Task 1); `src/db.ts`
- **Outputs:** contract query functions in `src/db.ts`
- **Contract:**
  - **Files:** edit `src/db.ts`
  - **Interfaces:** `export type ContractStatus = "pending" | "uploaded" | "rejected"`; `export type Contract = { id: string; customer_id: string; object_name: string; original_filename: string; content_type: string; status: ContractStatus; rejection_reason: "not_pdf" | "too_large" | null; size_bytes: number | null; md5_hash: string | null; generation: string | null; created_at: string; uploaded_at: string | null }`; `export async function insertPendingContract(c: { id: string; customerId: string; objectName: string; originalFilename: string }): Promise<Contract>`; `export async function getContract(id: string): Promise<Contract | undefined>`; `export async function markContractUploaded(id: string, meta: { sizeBytes: number; md5Hash: string; generation: string }): Promise<Contract | undefined>`; `export async function markContractRejected(id: string, reason: "not_pdf" | "too_large"): Promise<Contract | undefined>`
  - **Call-site edits:** none (existing `getReport`, `listSections`, `saveSection` unchanged)
- **Acceptance criteria:** `bun -e 'const m = await import("./src/db.ts"); for (const f of ["insertPendingContract","getContract","markContractUploaded","markContractRejected","getReport"]) if (typeof m[f] !== "function") process.exit(1)'`

### Task 6: Add the contract endpoints and wire the routes

- **Skill:** `flow-new-feature`
- **Description:** Handlers for create, confirm, and look-up behind an access gate. Gate: `CONTRACTS_API_TOKEN` unset → 503; missing or wrong `Authorization: Bearer` (constant-time compare via `crypto.timingSafeEqual` on equal-length buffers) → 401. `X-Customer-Id` must match `^[A-Za-z0-9_.:-]{1,128}$` (400 otherwise); filename 1–255 chars, path stripped. Create: new id `crypto.randomUUID()`, object `contracts/{id}.pdf`, insert pending, return 201 + `Location: /contracts/{id}` + `{ contract, upload }`. Confirm: unknown id or other customer → 404; already uploaded/rejected → 200 with stored row; metadata `null` → 409 `object_missing`; size > cap → reject `too_large` (422); first 5 bytes ≠ `%PDF-` → reject `not_pdf` (422); else mark uploaded → 200. Look-up: 404 rules as confirm; a pending row runs confirm first (failures leave it pending, not an error); an uploaded row adds a `download` signed GET request. Each handler runs inside `instrument(op, …)` with the matching `error.type`. Errors use one JSON shape `{ error: <error.type>, message }`.
- **Inputs:** `src/storage.ts` (Task 4), contract queries in `src/db.ts` (Task 5), `src/metrics.ts` (Task 3)
- **Outputs:** `src/contracts.ts`; routes in `src/app.ts`
- **Contract:**
  - **Files:** create `src/contracts.ts`; edit `src/app.ts`
  - **Interfaces:** `export function checkAccess(req: Request): Response | null` (null = allowed); `export async function handleCreateContract(req: Request): Promise<Response>`; `export async function handleConfirmContract(req: Request, id: string): Promise<Response>`; `export async function handleGetContract(req: Request, id: string): Promise<Response>`; `export async function confirmPending(contract: Contract): Promise<{ contract: Contract; errorType?: ErrorType }>` (shared by confirm and look-up)
  - **Call-site edits:** `src/app.ts` `handle` — add `POST /contracts` → `handleCreateContract`, `POST /contracts/{id}/confirm` → `handleConfirmContract`, `GET /contracts/{id}` → `handleGetContract`, matched before the final 404; existing routes unchanged
- **Acceptance criteria:** `CONTRACTS_API_TOKEN=t bun -e 'import { handle } from "./src/app.ts"; const r = await handle(new Request("http://x/contracts", { method: "POST" })); if (r.status !== 401) process.exit(1)'`

### Task 7: Test the storage client and metrics helper

- **Skill:** `flow-testing`
- **Description:** Unit tests with `fetch` replaced by a stub. Storage: golden string-to-sign and query string for a fixed date, email, and object; signed upload headers exactly as pinned; `signBlob` base64 → lowercase-hex signature; metadata 404 → `null`; abort → `StorageError("upstream_timeout")`; 500 → `upstream_error`; token cached across calls. Metrics: one success observation with `operation.outcome=ok` and no failure; one failure per new branch (`object_missing`, `not_pdf`, `unauthorized`) with the exact `error.type`; unknown value → `_OTHER`; outbound histogram carries `server.address`.
- **Inputs:** `src/storage.ts` (Task 4), `src/metrics.ts` (Task 3)
- **Outputs:** `src/storage.test.ts`, `src/metrics.test.ts`
- **Contract:**
  - **Files:** create `src/storage.test.ts`, `src/metrics.test.ts`
  - **Interfaces:** none new — tests target Task 3 and Task 4 exports
  - **Call-site edits:** none
- **Acceptance criteria:** `bun test src/storage.test.ts src/metrics.test.ts`

### Task 8: Test the contract endpoints

- **Skill:** `flow-testing`
- **Description:** Handler tests with `./db` and `./storage` replaced through `mock.module` from `bun:test`, covering every Story 1–3 criterion: 401, 503, 400, 201 with pinned upload headers, confirm → uploaded, confirm → rejected `not_pdf` (422), confirm with no object → 409 and still pending, repeat confirm → 200 with no storage call, cross-customer → 404, look-up with download link, look-up of a landed pending row → uploaded. Assert emission against the in-memory recorder for one success and the `object_missing` and `not_pdf` failures.
- **Inputs:** `src/contracts.ts` and `src/app.ts` routes (Task 6), `src/metrics.ts` (Task 3)
- **Outputs:** `src/contracts.test.ts`
- **Contract:**
  - **Files:** create `src/contracts.test.ts`
  - **Interfaces:** none new — tests target Task 6 exports through `handle` from `src/app.ts`
  - **Call-site edits:** none
- **Acceptance criteria:** `bun test src/contracts.test.ts`

| Task | Depends on |
| --- | --- |
| 1 | — |
| 2 | — |
| 3 | — |
| 4 | 3 |
| 5 | 1 |
| 6 | 3, 4, 5 |
| 7 | 3, 4 |
| 8 | 6 |

### Skills Summary

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-system-design | Yes (Tasks 1, 2, 4, 5) | New table, bucket, recovery, outbound calls with timeouts, idempotent confirm |
| flow-metrics | Yes (Task 3) | First instrumented change; creates helper and `.flow/metrics.md` |
| flow-new-feature | Yes (Task 6) | New user-facing endpoints and access gate |
| flow-testing | Yes (Tasks 7, 8) | Unit coverage for signer, metrics, and handlers |
| flow-ui-ux | No | No UI in this service |
| flow-refactoring | No | Existing modules extend in place; nothing restructured |
| flow-verify | No (implicit) | Runs as the pipeline's verify phase, not a task |

# PR description draft

See `.flow-tmp/pr-description-draft.md` (written alongside this file); its contents are reproduced below.

## TLDR

Customers can now hand in a signed PDF contract through the reports service, which keeps it privately in Cloud Storage and records it; before, the service had no way to accept or keep documents.

## User-facing changes

- A calling app can request an upload for a customer's signed contract and gets back a short-lived (15-minute) upload link that only accepts a PDF up to 25 MiB and can never overwrite an existing file.
- After uploading, the caller confirms the contract; the service checks the file really arrived and really is a PDF before marking it uploaded, and marks it rejected (with the reason) otherwise.
- A calling app can look up one contract and gets its status plus a 5-minute download link once it is uploaded; a lookup for another customer's contract answers "not found".
- Every contract request must carry the service's access token; requests without it are refused, and if the token is not configured the contract feature stays off rather than open.

## System changes

- The service gains its first stored-document capability and its first authenticated surface:
  - **Before:** the service stored only reports and their sections in Postgres and authenticated no caller.
  - **After:** contract files live in a private, versioned Cloud Storage bucket with public access blocked, each tracked by one database row that moves from pending to uploaded or rejected, and contract requests require a shared access token held in Secret Manager.
- File bytes never pass through the service: callers upload straight to the bucket, so the service avoids Cloud Run's 32 MiB request ceiling and holds no request open for the transfer.
- The deploy script now also creates and secures the bucket, grants the service the narrow storage and URL-signing permissions it needs (create and read, no delete), and checks that database point-in-time recovery is on.
- Ongoing cost: Cloud Storage billed per GB stored (versioning keeps replaced or deleted copies, so storage only grows) plus about four storage or signing calls per contract; no model calls are added.

## Why

Customers who sign a contract have nowhere in this system to return the signed copy, so it lives in email threads or someone's drive with no record of who sent what or when. The service is also open to the internet and identifies no one, so confidential legal documents cannot safely be accepted the way reports are served today.

## Key decisions

- Direct-to-bucket upload by signed link instead of sending the file through the service: Cloud Run rejects request bodies over 32 MiB and each proxied upload would tie up a public instance for the whole transfer.
- Signed links (not resumable upload sessions) for both upload and download: one signing mechanism serves both directions, and links expire in minutes rather than the up-to-a-week life of a session link.
- One shared access token, with the calling app naming the customer on each request, instead of per-customer credentials: smallest safe gate for v1; per-customer credentials remain open (see the plan's first open question).
- A contract only counts as uploaded after the service itself confirms the file exists, is within the size cap, and starts with the PDF file signature; a missed confirmation is picked up on the next lookup.
- No Google Cloud SDK: the four storage and signing calls are plain HTTPS requests, per the repo rule against new runtime dependencies.
- The service gets create and read rights on the bucket but no delete right, and replaced or deleted files are kept by bucket versioning.
- Out of scope: listing or deleting contracts, validating the digital signature inside the PDF, virus scanning, linking contracts to reports, and any customer account system.

## Instrumentation

Spec-only: this change creates the repo's metrics contract with no metrics backend chosen yet (suggested: Google Cloud Monitoring), so these metrics are recorded in-process but won't show on any graph until a backend is chosen. It adds duration histograms and failure counters for contract create, confirm, and lookup, plus an outbound histogram for the storage and signing calls, panels for request rate, failures by type, and p50/p95/p99 latency on a new service overview dashboard, and a new "upload a contract" journey SLO (99.5% over 30 days, burn-rate alerts only).

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/storage.test.ts` — the signer golden test, pinned upload headers, timeout-to-`upstream_timeout` mapping, and 404-to-null metadata specs pass.
- [ ] Run `bun test src/contracts.test.ts` — missing-token 401, unconfigured-token 503, create returns a PUT link with pinned headers, confirm marks uploaded, confirm marks a non-PDF rejected, confirm with no object returns 409, cross-customer lookup returns 404, and lookup returns a download link specs pass.
- [ ] Run `bun test src/metrics.test.ts` — success, failure-by-type, unlisted-value-to-`_OTHER`, and outbound-call emission specs pass.
- [ ] Start a scratch Postgres with `docker run -d --rm --name contracts-pg -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16` (wait until `docker exec contracts-pg pg_isready` exits 0).
- [ ] Run `psql postgresql://postgres:pg@localhost:55432/postgres -v ON_ERROR_STOP=1 -f migrations/001_reports.sql -f migrations/002_contracts.sql` — both migrations apply with exit 0.
- [ ] Run `psql postgresql://postgres:pg@localhost:55432/postgres -v ON_ERROR_STOP=1 -c "insert into contracts (id, customer_id, object_name, original_filename, status) values ('c1','acme','contracts/c1.pdf','a.pdf','bogus')"` — expect a non-zero exit (the status check constraint rejects the row).
- [ ] Run `bash -n deploy.sh && grep -q -- '--public-access-prevention' deploy.sh && grep -q -- '--update-secrets' deploy.sh && ! grep -q -- '--set-env-vars' deploy.sh` — the deploy script parses, blocks public access, and does not wipe existing environment variables.
- [ ] DECISION: you accept one shared access token, with the calling app naming the customer on each request, as the v1 gate, instead of per-customer credentials.
