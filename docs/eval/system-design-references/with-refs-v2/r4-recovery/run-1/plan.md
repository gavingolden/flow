# PRD

# Signed contract uploads

**Goal:** Each signed PDF contract sent for a report is checked, stored privately, and gets a durable record and receipt. Repeat sends return the same receipt, never a duplicate.

## Problem Statement

The service builds company reports, but it has nowhere to put the signed contract that goes with one. Today a signed PDF can only live outside the system, so nothing records which report it belongs to, when it arrived, or whether the copy on file is the real document. A customer who sends a contract gets no receipt, and the team has no single place to find it later. The service also has no idea who a customer is: it runs publicly and treats knowing a report's id as permission to read that report.

**Premise check:** the request says "let customers upload", which assumes the service can tell who a customer is. The codebase has no customer, account or login concept. The only identity-like field is a free-text company name on each report [anchor: migrations/001_reports.sql:3], and the service is deployed open to the internet [anchor: deploy.sh:4]. This plan therefore scopes uploads to a report (the one thing a caller can already prove they know) and leaves customer identity as an open question (Q1).

| What exists today | Evidence |
| --- | --- |
| Reports and their sections, keyed by text ids | [anchor: migrations/001_reports.sql:1] |
| One public read route, `GET /reports/{id}`, open to anyone with the id | [anchor: src/app.ts:10] |
| No Cloud Storage use, no bucket, no upload route of any kind | [anchor: src/app.ts:7] |
| Google APIs are called with plain `fetch`, with no SDK and no dependencies | [anchor: src/queue.ts:5] [anchor: package.json:1] |
| Migrations are numbered SQL files; the deploy script applies none | [anchor: deploy.sh:1] |

> **Research findings (prior context, discovery Step 1.5).** Gathered from primary Google and IETF/OWASP sources. Both adversarial cross-checks failed to run (agy error), so none of these was independently refuted. Treat them as primary-source claims, not verified ones.
> - (high) Cloud Run rejects HTTP/1 request bodies over 32 MiB with a 413. Passing PDFs through the service is viable under an app cap below that. https://cloud.google.com/run/quotas
> - (high) A Cloud Run service can get its own access token from the metadata server with no SDK. https://cloud.google.com/run/docs/securing/service-identity
> - (high) Cloud Storage's upload API accepts raw bytes in one request (`uploadType=media`). `ifGenerationMatch=0` makes the write fail with a 412 if a live object already has that name. https://cloud.google.com/storage/docs/request-preconditions
> - (high) Direct-to-storage signed links without a key file need the signing API plus a token-creator role granted to the service account on itself. https://cloud.google.com/storage/docs/access-control/signing-urls-manually
> - (high) A PDF starts with `%PDF-` (RFC 8118). Content type and magic bytes are both caller-controlled, so combine them with a size cap and server-generated object names. https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html

## Request vetting

- **Hypothesis:** Passing each PDF through the existing service into a private, create-only bucket gives callers a reliable upload path with no new dependencies or permissions, recording one row per distinct file per report. Knowing the report id is an acceptable gate for writes as long as nothing can be read back.
- **Case against:** The service is deployed `--allow-unauthenticated` with no customer concept [anchor: deploy.sh:4], so "customers upload" really means "anyone holding a report id can write files into our bucket". OWASP says content-type and magic-byte checks are easily bypassed and must not stand alone. Holding a 20 MiB body in memory at Cloud Run's default concurrency could also run an instance out of memory.
- **Sources:** https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html, https://cloud.google.com/run/quotas
- **Verdict:** adopt-with-conditions: upload-only (no list or download route), 20 MiB cap, `%PDF-` check, private create-only bucket with public access prevention, at most 8 concurrent uploads per instance, and Q1 answered before any read-back route is built

## Existing-code assessment

- **src/app.ts (router):** keep — the regex route table takes one more match next to the report route without restructuring [anchor: src/app.ts:10]
- **src/db.ts (persistence):** keep — tagged-template query functions; two more follow the same shape [anchor: src/db.ts:6]
- **src/queue.ts (task-queue call):** simplify — it sends no `Authorization` header and has no timeout, so Google would reject it and a hang would never time out. Reuse the new access-token helper and add a timeout (bundled into Task 3) [anchor: src/queue.ts:5]
- **deploy.sh:** keep — the idempotent `create … || true` pattern extends to the bucket [anchor: deploy.sh:3]
- **migrations/:** keep — numbered plain SQL; add `002_contracts.sql` [anchor: migrations/001_reports.sql:1]

## Scope Boundary

**In scope:**
- One upload route: `POST /reports/{id}/contracts`, raw PDF body, optional `?filename=`.
- Validation: report exists, `Content-Type: application/pdf`, 1 byte to 20 MiB, starts with `%PDF-`.
- Storage in a new private, versioned bucket under a content-addressed, server-generated name.
- A new `contracts` table with one row per distinct file per report. Repeat uploads are safe.
- A per-instance cap of 8 concurrent uploads.
- Metrics for the upload path.
- Deploy wiring for the bucket, its permissions and its versioning check.
- Bundled: authenticate the existing task-queue call and give it a timeout.

**Out of scope:**
- Any customer identity, login or API-key scheme (Q1).
- Listing, downloading or deleting contracts.
- Verifying the digital signature inside the PDF.
- Virus or malware scanning.
- Resumable or direct-to-storage (signed-link) uploads.
- Files over 20 MiB.
- A migration runner.
- Locking down the existing public worker route (a ticked candidate follow-up).

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| There is no way to hand the service a signed contract. It lives in email or a shared drive. | The caller sends the PDF to the report's contracts address and gets a receipt: id, size, fingerprint, upload time. |
| Nothing confirms a contract arrived, or which report it belongs to. | The receipt and the database record tie the contract to the report and the moment it arrived. |
| — | A wrong file type, a non-PDF, an oversized file or an unknown report is refused with a specific status and reason. |
| — | Sending the same file again (for example after a timeout) returns the original receipt. Nothing is duplicated. |

### System flow

- **Before:**
  - The service talks to Postgres and the model API. A task-queue helper exists but no route calls it, and it sends no credentials.
  - There is no object storage.
- **After:**
  - Each accepted upload makes one Cloud Storage write (create-only, refuses overwrite) and then inserts one `contracts` row.
  - The service fetches and caches its own access token from the metadata server. The task-queue call now uses the same token and a 10 s timeout.
  - In-flight uploads are counted per instance. The 9th concurrent upload is refused with a 503 instead of risking memory exhaustion.

**Lost:** none. The change is additive. The one altered path, the task-queue call, is not invoked by any route today [anchor: src/app.ts:1].

## User Stories / Acceptance Criteria

### Story 1: Upload a signed contract

- [ ] Given an existing report, when the caller POSTs a valid PDF of 20 MiB or less with `Content-Type: application/pdf` to `/reports/{id}/contracts`, then the response is 201 with `{id, reportId, sha256, sizeBytes, originalFilename, uploadedAt}`, and storage received exactly one write named `contracts/{id}/{sha256}.pdf`. Checked by `bun test src/contracts.test.ts`.
- [ ] Given that contract already exists, when the identical bytes are POSTed to the same report, then the response is 200 with the same `id`, and no second row is inserted. Checked by `bun test src/contracts.test.ts`.
- [ ] Given `?filename=../../Signed MSA.pdf`, when uploaded, then the record keeps a sanitized name with no path separators, at most 255 characters, and the object name ignores it. Checked by `bun test src/contracts.test.ts`.

### Story 2: Refuse bad uploads before anything is stored

- [ ] Given an unknown report id, when a PDF is POSTed, then the response is 404 and storage is not called. Checked by `bun test src/contracts.test.ts`.
- [ ] Given `Content-Type: image/png`, then the response is 415. Given a body over 20 MiB (by `Content-Length` or by actual bytes), then 413. Given an empty body or bytes not starting with `%PDF-`, then 422. In every case storage is not called. Checked by `bun test src/contracts.test.ts`.

### Story 3: Failures are visible and safe to retry

- [ ] Given storage answers 5xx, then the response is 502 and no row is inserted. Given storage does not answer within 20 s, then 504. Checked by `bun test src/contracts.test.ts`.
- [ ] Given 8 uploads already in flight on the instance, when a 9th arrives, then it gets 503 with `Retry-After: 5`, and the in-flight count returns to 0 after the 8 finish. Checked by `bun test src/contracts.test.ts`.
- [ ] Each outcome records one upload-duration observation, and each failure records one failures increment with the matching `error.type`. Checked by `bun test src/metrics.test.ts src/contracts.test.ts`.

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports.contract.upload.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | contract upload handler |
| `reports.contract.upload.failures` | Counter | none | `error.type` (`_OTHER`, `internal`, `invalid_input`, `not_found`, `rate_limited`, `upstream_error`, `upstream_timeout`) | contract upload handler |
| `reports.storage.request.duration` | Histogram | seconds | `server.address` (`storage.googleapis.com`), `operation.outcome` (`ok`, `error`) | Cloud Storage client |
| `reports.contract.upload.active` | UpDownCounter | `{request}` | none | contract upload handler (inside `instrument`'s try/finally) |

Estimated series: 41 per operation for the upload (histogram 2 × 17 + 7 `error.type` values), 34 for the storage call (1 host × 2 outcomes × 17), and 1 for in-flight. That is 76 per instance. Request-scale bucket bounds (14 + 3).

**Attributes:** new registry. `operation.outcome` (`ok`, `error`), `error.type` (closed list below), `server.address` (`storage.googleapis.com`). These become `.flow/metrics.md` `## Attributes` rows.

### Error types

New list, seeded from the starter values:

| Value | Meaning |
| --- | --- |
| `_OTHER` | Fallback: no listed class fits. |
| `internal` | Unexpected failure inside the service. |
| `invalid_input` | Wrong content type, empty, over 20 MiB, or not a PDF. Client-caused. |
| `not_found` | The report does not exist. Client-caused. |
| `rate_limited` | The per-instance upload cap was hit. |
| `upstream_error` | Cloud Storage, Postgres or the metadata server answered with a failure. |
| `upstream_timeout` | One of those did not answer in time. |

### Dashboard panels

On a new "reports-service overview" dashboard (spec-only, no URL yet):
- upload volume
- success vs failure
- failures by `error.type`
- upload latency p50/p95/p99
- Cloud Storage write latency p95
- uploads in flight against the cap of 8

### Alerts

burn-rate tiers only

### SLO

New journey SLO "upload a contract": 99.5% of uploads succeed over 30 days, excluding client-caused `invalid_input` and `not_found`. Standard burn-rate tiers are recorded once in `.flow/metrics.md`.

**As-code:** spec-only — the repo keeps no dashboard or alert config. Backend: `none yet — suggested: Google Cloud Monitoring`.

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | DB (new table), integration (Cloud Storage client, access-token helper), HTTP handler, deploy config |
| Domain modules | New: `src/contracts.ts` (upload handler), `src/storage.ts` (Cloud Storage client), `src/gcp-token.ts` (metadata token), `src/metrics.ts` (metrics helper). Extended: `src/db.ts`, `src/app.ts`, `src/queue.ts`, `deploy.sh` |
| Data flow | Caller sends PDF bytes to the handler. The handler validates, hashes (SHA-256), and makes a create-only Cloud Storage write named `contracts/{reportId}/{sha256}.pdf`, then inserts a `contracts` row. It returns 201, or 200 for a repeat |
| Pattern | Existing: REST over `fetch` to a Google API (as in `src/queue.ts`), tagged-template SQL (as in `src/db.ts`), child rows keyed by `report_id` (as in `sections`). New: an injected-dependencies parameter on the handler so tests run without Postgres or Cloud Storage. There are no tests or test seams today, which is why it is needed |
| Binary-framing check | Pass-through vs direct-to-storage links has a middle ground: pass through now under a 20 MiB cap, and add signed links only if real contracts exceed it (see Decision analysis A) |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| Contract upload (`POST /reports/{id}/contracts`) | ~3 s server-side at 20 MiB, excluding the caller's own transfer time | inline — the caller waits for the stored record | Handler budget 30 s: token 2 s, Cloud Storage write 20 s, each Postgres query 5 s | none server-side; caller retries are safe | (report id, SHA-256 of the file bytes): a unique constraint plus a content-addressed object name written with `ifGenerationMatch=0` | 20 MiB per request; at most 8 in flight per instance (503 beyond); no paid API call |
| Access-token fetch | inline — ~10 ms, timeout 2 s | inline, cached until 60 s before expiry | 2 s | none (a failure surfaces as `upstream_error`) | n/a — read-only | none |
| Task-queue enqueue (bundled fix) | inline — ~200 ms, timeout 10 s | unchanged (inline call) | 10 s (new) | none at this layer (unchanged) | unchanged | unchanged |

**Platform:** gcp

**Proportionality:** Several things are deliberately left out:
- No queue: the storage write is a single few-second call whose failure the waiting caller sees and can retry safely.
- No signed-link flow, resumable uploads, virus scanning or per-customer quotas.
- No retry layer in the service: the caller is the one retry layer, made safe by the content fingerprint.
- The 10 s interactive budget covers the server-side work. A slow client link stretches only the caller's own transfer.

**Recovery:**
- Contracts bucket: object versioning on. The app's role is create-only (`roles/storage.objectCreator`), so it cannot overwrite or delete. `deploy.sh` asserts after every deploy that versioning is enabled, and the deploy fails otherwise.
- `contracts` table: rides the Cloud SQL instance's automated backups and point-in-time recovery. Whether those are enabled is unverified from the repo (Q2).
- Rows vs objects: a row's object name points at its file, so a restored table can be checked against bucket listings. An object with no row (the DB insert failed after the write) is harmless, and the next retry reuses it.

## Technical Constraints

- No new runtime dependencies [anchor: AGENTS.md:5]. Cloud Storage is called over its JSON upload API with `fetch` and a metadata-server bearer token, mirroring how the task-queue call reaches Google today [anchor: src/queue.ts:5].
- Cloud Run caps HTTP/1 request bodies at 32 MiB (research finding 1). The app cap of 20 MiB leaves headroom, and 8 concurrent uploads at 20 MiB keeps buffered bodies near 160 MiB on a default 512 MiB instance.
- Object names are server-generated from the fingerprint. The caller's filename is metadata only (OWASP finding 5).
- `deploy.sh` applies no migrations [anchor: deploy.sh:1]. `002_contracts.sql` must be applied to Cloud SQL before the new handler is deployed, the same out-of-band way `001` was.
- Cost: storage grows with uploaded bytes. At the cap, 1,000 contracts take at most 20 GB. No paid model calls are added.

## Open Questions

- [ ] **Q1.** Who sends the upload, and how should they prove they may? The choice is the customer's own browser or app, or another service of yours acting for them. This decides whether the follow-up gate is a per-customer key, a Google-signed caller token from your own service, or a login, and whether a read-back route can ever ship.
  - **Stakes:** both — if the default is wrong, anyone who learns a report id can attach junk or a fake contract to that report. That is a product-quality and trust problem, the brief's priority 4, though no stored contract can be read back.
  - **Needs user input:** an external fact the agent cannot verify. The repo contains no caller, no customer model and no record of how report ids reach customers. Until answered, the plan uses "knowing the report id" as the gate, the same rule the existing read route uses [anchor: src/app.ts:10].
- [ ] **Q2.** Are automated backups and point-in-time recovery enabled on the production Cloud SQL instance? If not, the plan gains a task to enable them before contracts go live.
  - **Stakes:** system — without them a database loss drops every contract record, though the files themselves would survive in the versioned bucket.
  - **Needs user input:** credentials or production access. The instance name and its backup settings are not in the repo.
- [ ] Attach each contract to a report, not to a company name or a new customer table. Redirecting changes the table's foreign key and the route shape.
  - **Stakes:** user — if contracts really belong to a company across several reports, each one would have to be uploaded once per report.
  - **Recommended:** attach to a report through `report_id`, matching how sections hang off reports. There is no customer or company record to point at — [confidence: medium] [anchor: adjacent: migrations/001_reports.sql:10]
- [ ] Pass uploads through the service rather than issuing direct-to-storage signed links. Redirecting replaces Tasks 3 and 5 with a three-step signed-link flow plus a self-granted signing role.
  - **Stakes:** system — pass-through caps files at 20 MiB and puts the upload bytes on the service's instances.
  - **Recommended:** pass through. It is one request, needs no new IAM role, and the file is checked before it is stored, while 32 MiB of platform headroom covers typical contracts — [confidence: medium] [anchor: weighing: footprint — one request and zero new roles vs three requests and a self-granted token-creator role]
- [ ] Cap uploads at 20 MiB. A different number changes one constant and the memory math.
  - **Stakes:** user — a large scanned contract over the cap is refused with 413 and has to be compressed first.
  - **Recommended:** 20 MiB. It stays under the 32 MiB platform cap with room to spare and bounds buffered bodies at about 160 MiB per instance — [confidence: medium] [anchor: weighing: risk — headroom under the platform limit and the default instance memory]
- [ ] Do not verify the digital signature inside the PDF. Read "signed" as describing the document. Redirecting adds a PDF-signature verification component and a trust-anchor decision.
  - **Stakes:** user — a PDF that was never signed is accepted as long as it is a valid PDF.
  - **Recommended:** no signature verification in this PR. The service records what it received and when, and checks that it is a real PDF — [confidence: medium] [anchor: weighing: effort — signature verification needs a parser and trust anchors, far larger than the upload itself]
- [ ] Accept the raw PDF as the request body, with an optional `?filename=`, rather than a multipart form. Redirecting changes the body parsing in Task 5 and its tests.
  - **Stakes:** user — a plain HTML form posts multipart and would be refused with 415.
  - **Recommended:** raw body. One content type to validate, no form parsing, and any `fetch` client can send a file directly — [confidence: medium] [anchor: weighing: footprint — one content type and no multipart parsing]
- [ ] Return the original receipt (200) when identical bytes are re-sent to the same report, instead of storing a second copy or refusing with 409.
  - **Stakes:** system — with a 409 or a second copy, a caller retrying after a timeout either sees a false error or creates duplicates.
  - **Recommended:** return the original receipt. The fingerprint is the business identity of the document — [confidence: medium] [anchor: weighing: reversibility — the same bytes are the same contract; returning the stored record loses nothing]
- [x] Should this PR add list or download routes for contracts? Resolved: no. The request asks only to upload, store and record, and Q1 must be answered before anything is readable.
  - **Stakes:** none — resolved without asking
- [x] Should the plan add a migration runner? Resolved: no. `002_contracts.sql` is applied out of band like `001`, and the deploy script applies none [anchor: deploy.sh:1].
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision A — How do the PDF bytes reach Cloud Storage?**

- **(1) Pass through the service.**
  - User flow: one POST with the file, then a receipt about 1–3 s after the transfer finishes. 0 interruptions.
  - System: the file is checked before storage. No new IAM role. Bytes count against instance memory (bounded by the 8-upload cap). Hard 20 MiB ceiling.
- **(2) Direct-to-storage signed link.**
  - User flow: POST to ask for a link, PUT the file to Google, then POST again to confirm. That is three requests and 0 interruptions, but three failure points for the caller to handle.
  - System: a new self-granted signing role. The file is unchecked until after it is stored, which needs a second download to check it. Links that are fetched but never used leave orphan objects. No size ceiling beyond the signed range.
- **(3) Middle ground.** Ship (1) now and add (2) only for files over 20 MiB if real contracts hit the cap.

The branches are exclusive per upload but complementary over time. Ranked: (3) > (1) > (2).

Verdict: **pass through now, keep signed links as the escape hatch** — signed links cost two extra round trips, a new role and after-the-fact validation, with nothing yet showing a need for files over 20 MiB [confidence: medium] [anchor: weighing: footprint — one request and zero new roles vs three requests and a self-granted signing role].

**Decision B — What gates who may upload?**

- **(1) Knowing the report id.**
  - User flow: unchanged, the caller just sends the file. 0 interruptions.
  - System: no new infrastructure. Anyone with the id can attach a file, but nothing can be read back.
- **(2) A Google-signed token from a trusted calling service, verified in the handler.**
  - User flow: invisible to customers. Only works if uploads come through another service of yours.
- **(3) Per-customer API keys.**
  - User flow: a key must be issued to each customer first, which is 1 extra setup step per customer.
  - System: a new keys table and an issuance flow.

The branches are mutually exclusive as the primary gate. (2) and (3) each replace (1). Ranked for this PR: (1) with the vetting conditions > (2) > (3).

Verdict: **(1) for this PR, revisit once Q1 is answered** — it matches the access rule the read route already uses and adds no surface, and the upload-only scope keeps the exposure to unwanted writes rather than leaked contracts [confidence: medium] [anchor: adjacent: src/app.ts:10].

## Recommendation

**Reconsider scope** — build upload-only, gated on knowing the report id, with the vetting conditions. Leave customer identity and any read-back to Q1, because the request's premise that the service knows who a customer is does not hold (see Premise check). The bundled task-queue fix is a `simplify` verdict on an existing surface [confidence: medium] [anchor: adjacent: src/app.ts:10]

**Redundancy:** none found. There is no existing upload, storage or file-record capability in the service [anchor: src/app.ts:7].

## Plan risks

Knowing a report's id is the only thing between the internet and the bucket. If report ids are guessable or widely shared, anyone can attach files, including fake "signed" contracts, to any report, and the record would look authoritative (Q1).

## Cut list

- The bundled task-queue fix touches a call no route makes today [anchor: src/app.ts:1]. Cut Task 3's `src/queue.ts` edit and its test if the diff should be contracts-only.
- The optional `?filename=` capture could be cut if no one will read original filenames. It is kept because a record with only a hash is hard for a person to recognize.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Lock down the public worker route | High | Medium | needs its own design/decision session: the open decision is whether to move the worker to its own non-public Cloud Run service or verify the Cloud Tasks OIDC token in the handler | unrelated to contracts; found while reading the router | No |
| Authenticated contract read-back | Medium | Medium | needs its own design/decision session: the open decision is how a caller proves they may read a signed contract (Q1) | the natural next step after upload; deliberately excluded here | No |

- [x] Lock down the public worker route — anyone on the internet can POST to the section-generation route and trigger paid model calls.
  - **UX:** none
  - **Problem:** the worker route is served by a service deployed with `--allow-unauthenticated`, so any caller can trigger a paid generation for any report id and bypass the queue's rate limits [anchor: src/app.ts:9]
  - **Stability/efficiency:** each forged call costs one 20–60 s paid model call [anchor: src/llm.ts:1]
  - **Value rank:** 5 — a security and spend exposure with no workaround [anchor: deploy.sh:4]
  - **Complexity:** Medium — the worker service or token check, queue OIDC config, and deploy changes
  - **Risk:** Medium — changes how Cloud Tasks reaches the worker; a misconfiguration silently stops section generation
  - **If never done:** anyone who finds the URL can run up the model bill
  - **Verdict:** clears bar — an open paid endpoint is a live spend and abuse exposure that outweighs a medium-sized change
- [ ] Authenticated contract read-back — list and download a report's contracts once caller identity is settled.
  - **UX:** callers could retrieve the signed copy they uploaded instead of keeping their own [anchor: user: "let customers upload their signed PDF contracts"]
  - **Problem:** none
  - **Stability/efficiency:** none
  - **Value rank:** 2 — no one has asked to read contracts back yet [anchor: user: "let customers upload their signed PDF contracts; store the files in Cloud Storage and record each one in a new `contracts` table"]
  - **Complexity:** Medium — two routes, signed download links or streaming, and the access check chosen under Q1
  - **Risk:** Medium — a wrong access check leaks signed legal documents
  - **If never done:** contracts can be retrieved only by an operator, straight from the bucket
  - **Verdict:** below bar — no requester, and its safe design depends on the unanswered Q1

# Task breakdown

### Task 1: Contracts table migration

- **Skill:** `flow-system-design`
- **Description:** Add the `contracts` table: one row per distinct file per report, with the repeat-upload guard as a unique constraint.
- **Inputs:** `migrations/001_reports.sql` (the `reports` table to reference)
- **Outputs:** `migrations/002_contracts.sql`
- **Contract:**
  - **Files:** create `migrations/002_contracts.sql`
  - **Interfaces:** exact DDL:
    ```sql
    create table contracts (
      id text primary key,
      report_id text not null references reports(id),
      object_name text not null unique,
      sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
      size_bytes integer not null check (size_bytes > 0 and size_bytes <= 20971520),
      original_filename text check (char_length(original_filename) <= 255),
      uploaded_at timestamptz not null default now(),
      unique (report_id, sha256)
    );
    ```
  - **Call-site edits:** none
- **Acceptance criteria:** `grep -q 'create table contracts' migrations/002_contracts.sql && grep -q 'unique (report_id, sha256)' migrations/002_contracts.sql && grep -q 'references reports(id)' migrations/002_contracts.sql`

### Task 2: Contract persistence functions

- **Skill:** `flow-system-design`
- **Description:** Add the read and insert for contracts in the existing tagged-template style. The insert is conflict-safe on `(report_id, sha256)` and returns the existing row on a repeat. Each query is bounded at 5 s.
- **Inputs:** Task 1; `src/db.ts`
- **Outputs:** two exported functions and a `Contract` type in `src/db.ts`
- **Contract:**
  - **Files:** edit `src/db.ts`
  - **Interfaces:**
    - `export type Contract = { id: string; report_id: string; object_name: string; sha256: string; size_bytes: number; original_filename: string | null; uploaded_at: string }`
    - `export async function findContract(reportId: string, sha256: string): Promise<Contract | undefined>`
    - `export async function insertContract(c: Omit<Contract, "uploaded_at">): Promise<{ contract: Contract; created: boolean }>`, implemented as `insert … on conflict (report_id, sha256) do nothing returning *`, falling back to `findContract` when nothing is returned
  - **Call-site edits:** none (consumed by Task 5)
- **Acceptance criteria:** `bun build src/db.ts --target bun --outdir /tmp/flow-build-check >/dev/null && grep -q 'export async function insertContract' src/db.ts && grep -q 'on conflict (report_id, sha256) do nothing' src/db.ts`

### Task 3: Access-token helper and Cloud Storage client

- **Skill:** `flow-system-design`
- **Bundled:** the task-queue call's missing `Authorization` header and missing timeout, found in the existing-code assessment
- **Description:** Add a metadata-server access-token helper, cached until 60 s before expiry, with a 2 s timeout. Add a create-only Cloud Storage upload over the JSON API:
  - `POST https://storage.googleapis.com/upload/storage/v1/b/{bucket}/o?uploadType=media&name={encoded}&ifGenerationMatch=0`, with a 20 s timeout.
  - 200 maps to `"created"` and 412 maps to `"exists"`.
  - Other statuses throw `StorageError("upstream_error")`. An abort or timeout throws `StorageError("upstream_timeout")`.
  - Each call is wrapped in the storage-request metric once Task 4 lands. Until then, the wrapping call is added in Task 5's wiring.
  - The bucket comes from `CONTRACTS_BUCKET`.
  - Switch `src/queue.ts` to send `Authorization: Bearer <token>` and `content-type: application/json`, with `AbortSignal.timeout(10_000)`.
- **Inputs:** `src/queue.ts` (the existing REST-over-fetch pattern); new: `src/gcp-token.ts`; new: `src/storage.ts`
- **Outputs:** `src/gcp-token.ts`, `src/storage.ts`, edited `src/queue.ts`
- **Contract:**
  - **Files:** create `src/gcp-token.ts`; create `src/storage.ts`; edit `src/queue.ts`
  - **Interfaces:**
    - `export async function getAccessToken(): Promise<string>` (in `src/gcp-token.ts`)
    - `export class StorageError extends Error { constructor(readonly kind: "upstream_error" | "upstream_timeout", readonly status?: number) }`
    - `export async function putObject(bucket: string, name: string, body: Uint8Array, contentType: string): Promise<"created" | "exists">` (in `src/storage.ts`)
  - **Call-site edits:** `src/queue.ts` `enqueueSection` — add the `Authorization` and `content-type` headers and the `signal: AbortSignal.timeout(10_000)` option to its `fetch`
- **Acceptance criteria:** `bun build src/gcp-token.ts src/storage.ts src/queue.ts --target bun --outdir /tmp/flow-build-check >/dev/null && grep -q 'ifGenerationMatch=0' src/storage.ts && grep -q 'Metadata-Flavor' src/gcp-token.ts && grep -q 'Authorization' src/queue.ts`

### Task 4: Metrics helper and metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create the repo's first metrics helper. It is a zero-dependency in-memory recorder behind a swappable interface, with a closed `ErrorType` union and an attribute map mirroring `.flow/metrics.md`. Create `.flow/metrics.md` with these sections:
  - Backend `none yet — suggested: Google Cloud Monitoring`
  - Namespace `reports`
  - Attributes and the error.type values from `## Instrumentation`
  - Helper path
  - Dashboard panels
  - Dashboards (none yet)
  - Alerts (burn-rate tiers)
  - As-code `spec-only`
  - SLOs (the "upload a contract" SLO)
  - Coverage (the contract upload and the storage request)

  Planned metrics: `reports.contract.upload.duration`, `reports.contract.upload.failures`, `reports.storage.request.duration`, `reports.contract.upload.active`.
- **Inputs:** none in repo (`.flow/metrics.md` absent); new: `src/metrics.ts`
- **Outputs:** `src/metrics.ts`, `.flow/metrics.md`
- **Contract:**
  - **Files:** create `src/metrics.ts`; create `.flow/metrics.md`
  - **Interfaces:**
    - `export type ErrorType = "_OTHER" | "internal" | "invalid_input" | "not_found" | "rate_limited" | "upstream_error" | "upstream_timeout"`
    - `export type Attributes = { "operation.outcome"?: "ok" | "error"; "error.type"?: ErrorType; "server.address"?: "storage.googleapis.com" }`
    - `export interface Recorder { histogram(name: string, seconds: number, attrs: Attributes): void; counter(name: string, attrs: Attributes): void; upDown(name: string, delta: number, attrs: Attributes): void }`
    - `export function setRecorder(r: Recorder): void`
    - `export function memoryRecorder(): Recorder & { records: Array<{ kind: string; name: string; value: number; attrs: Attributes }> }`
    - `export async function instrument<T>(op: string, fn: () => Promise<T>, errorTypeOf: (r: { value?: T; error?: unknown }) => ErrorType | undefined): Promise<T>`, which records duration, failures and the in-flight up/down in try/finally
    - `export async function recordOutbound<T>(host: "storage.googleapis.com", fn: () => Promise<T>): Promise<T>`
  - **Call-site edits:** none (consumed by Task 5)
- **Acceptance criteria:** `bun build src/metrics.ts --target bun --outdir /tmp/flow-build-check >/dev/null && grep -q '## error.type values' .flow/metrics.md && grep -q 'reports.contract.upload.duration' .flow/metrics.md && grep -q '## Coverage' .flow/metrics.md`

### Task 5: Upload handler and route

- **Skill:** `flow-new-feature`
- **Description:** Add `POST /reports/{id}/contracts`. The order of operations is:
  1. In-flight cap: 8 per instance, otherwise 503 with `Retry-After: 5`.
  2. The report exists, otherwise 404.
  3. `Content-Type` is `application/pdf` (parameters allowed), otherwise 415.
  4. `Content-Length` is at most 20 MiB, otherwise 413.
  5. Read the body. Re-check 0 < bytes ≤ 20 MiB (413 or 422) and the `%PDF-` prefix (422).
  6. Compute the SHA-256 with `Bun.CryptoHasher`.
  7. Call `findContract`. On a hit, return 200 with the existing receipt.
  8. Call `putObject` with `contracts/{reportId}/{sha256}.pdf`. `"created"` and `"exists"` both continue.
  9. Call `insertContract` with `id = crypto.randomUUID()`, then return 201, or 200 when `created` is false.

  `StorageError` maps to 502 or 504. Sanitize `?filename=` by stripping `/`, `\` and control characters and truncating to 255 characters, or store null. Wrap the whole handler in `instrument("reports.contract.upload", …)` and the storage call in `recordOutbound`. Dependencies are injected for tests.
- **Inputs:** Tasks 2, 3, 4; `src/app.ts`; `src/db.ts`
- **Outputs:** `src/contracts.ts`, edited `src/app.ts`
- **Contract:**
  - **Files:** create `src/contracts.ts`; edit `src/app.ts`
  - **Interfaces:**
    - `export const MAX_CONTRACT_BYTES = 20 * 1024 * 1024`
    - `export const MAX_CONCURRENT_UPLOADS = 8`
    - `export type ContractDeps = { getReport: typeof getReport; findContract: typeof findContract; insertContract: typeof insertContract; putObject: typeof putObject; bucket: string }`
    - `export async function handleUploadContract(req: Request, reportId: string, deps?: ContractDeps): Promise<Response>`
    - The response body is `{ id, reportId, sha256, sizeBytes, originalFilename, uploadedAt }`
  - **Call-site edits:** `src/app.ts` `handle` — add a `POST` match on `/^\/reports\/([^/]+)\/contracts$/` that calls `handleUploadContract(req, m[1])`, placed before the 404 fallthrough
- **Acceptance criteria:** `bun build src/app.ts --target bun --outdir /tmp/flow-build-check >/dev/null && grep -q 'handleUploadContract' src/app.ts && grep -q 'MAX_CONCURRENT_UPLOADS = 8' src/contracts.ts`

### Task 6: Tests for the storage client, task-queue call and metrics helper

- **Skill:** `flow-testing`
- **Description:** Stub the global `fetch` to assert the bearer token, `ifGenerationMatch=0`, 412 mapped to `"exists"`, 5xx mapped to `StorageError("upstream_error")`, and a timeout mapped to `"upstream_timeout"`. Assert the task-queue request's `Authorization` header and timeout signal. Write the metrics emission tests against `memoryRecorder()`: success, one failure per new `error.type` branch, an unlisted error falling to `_OTHER`, and the in-flight count returning to 0 on both paths.
- **Inputs:** Tasks 3, 4
- **Outputs:** three test files
- **Contract:**
  - **Files:** create `src/storage.test.ts`; create `src/queue.test.ts`; create `src/metrics.test.ts`
  - **Interfaces:** none (tests only)
  - **Call-site edits:** none
- **Acceptance criteria:** `bun test src/storage.test.ts src/queue.test.ts src/metrics.test.ts`

### Task 7: Tests for the upload handler

- **Skill:** `flow-testing`
- **Description:** Use injected `ContractDeps` fakes to cover every acceptance criterion in Stories 1–3:
  - 201, then 200 on a repeat with no second insert
  - filename sanitizing
  - 404, 415, 413 (header and actual size), and 422 (empty and non-PDF), with no storage call in any of them
  - 502 and 504 with no insert
  - 503 with `Retry-After` at the 9th concurrent upload, with in-flight back to 0
  - metric emission per outcome
- **Inputs:** Task 5
- **Outputs:** `src/contracts.test.ts`
- **Contract:**
  - **Files:** create `src/contracts.test.ts`
  - **Interfaces:** none (tests only)
  - **Call-site edits:** none
- **Acceptance criteria:** `bun test src/contracts.test.ts && bun test`

### Task 8: Deploy wiring for the contracts bucket

- **Skill:** `flow-system-design`
- **Description:** Extend `deploy.sh` in its idempotent style:
  - Create the bucket with uniform access and public-access prevention, and turn on versioning.
  - Grant the runtime service account create-only access.
  - Pass `CONTRACTS_BUCKET` to the service.
  - After deploy, assert that versioning is enabled. This is the restore-readiness check, and it exits non-zero otherwise.
- **Inputs:** Task 3 (`CONTRACTS_BUCKET` consumer); `deploy.sh`
- **Outputs:** edited `deploy.sh`
- **Contract:**
  - **Files:** edit `deploy.sh`
  - **Interfaces:** config/infra surgical form:
    - add `CONTRACTS_BUCKET="${CONTRACTS_BUCKET:-$(gcloud config get-value project)-contracts}"` and `RUN_SA="${RUN_SA:-$(gcloud projects describe "$(gcloud config get-value project)" --format='value(projectNumber)')-compute@developer.gserviceaccount.com}"`
    - add `gcloud storage buckets create "gs://$CONTRACTS_BUCKET" --location us-central1 --uniform-bucket-level-access --public-access-prevention || true`
    - add `gcloud storage buckets update "gs://$CONTRACTS_BUCKET" --versioning`
    - add `gcloud storage buckets add-iam-policy-binding "gs://$CONTRACTS_BUCKET" --member "serviceAccount:$RUN_SA" --role roles/storage.objectCreator`
    - `gcloud run deploy` line: before, no env vars; after, `--set-env-vars CONTRACTS_BUCKET=$CONTRACTS_BUCKET`, other flags unchanged
    - add the final check `gcloud storage buckets describe "gs://$CONTRACTS_BUCKET" --format='value(versioning_enabled)' | grep -qi true`
  - **Call-site edits:** none
- **Acceptance criteria:** `bash -n deploy.sh && grep -q 'public-access-prevention' deploy.sh && grep -q -- '--versioning' deploy.sh && grep -q 'roles/storage.objectCreator' deploy.sh && grep -q 'CONTRACTS_BUCKET' deploy.sh`

| Task | Depends on |
| --- | --- |
| 1 | — |
| 2 | 1 |
| 3 | — |
| 4 | — |
| 5 | 2, 3, 4 |
| 6 | 3, 4 |
| 7 | 5 |
| 8 | 3 |

### Skills Summary

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-system-design | Yes (Tasks 1, 2, 3, 8) | New store, idempotency key, outbound call timeouts, bucket recovery settings on GCP |
| flow-metrics | Yes (Task 4) | First instrumented change; creates the helper and `.flow/metrics.md` |
| flow-new-feature | Yes (Task 5) | The user-facing upload route |
| flow-testing | Yes (Tasks 6, 7) | No tests exist yet; handler and client specs |
| flow-ui-ux | No | No UI surface in this service |
| flow-refactoring | No | The only cleanup (the task-queue auth) is bundled into Task 3 |

# PR description draft

Condensed here; the full draft is `pr-description-draft.md`.

## TLDR

A signed PDF contract can now be uploaded to a report and returns a receipt, where before contracts had nowhere to go; each is now stored privately with its own database record.

## User-facing changes

- New upload address: send a PDF to a report's contracts address and get back a receipt with the contract's id, size, fingerprint and upload time.
- Uploading the same file to the same report again returns the original receipt. No duplicate is stored.
- Refused uploads come back with a specific reason: unknown report (404), not sent as a PDF (415), file over 20 MiB (413), empty file or bytes that are not a PDF (422), service busy (503 with a retry hint).
- An optional original filename can be attached to an upload and is kept on the record. It is never used to name the stored file.

## System changes

- The service now writes to Cloud Storage. Each accepted upload is one write to a new private bucket (public access blocked, versioning on) plus one row in a new contracts table. The service account can only create objects, so the app cannot overwrite or delete a stored contract.
- Uploads are capped at 8 at a time per instance, so large files cannot run an instance out of memory and take report reads down with it.
- The task-queue call now authenticates and has a timeout:
  - **Before:** it sent no access token and had no timeout, so Google would have rejected it. No route calls it today.
  - **After:** it sends the service's own access token and gives up after 10 seconds.
- Ongoing cost: storage grows with uploaded bytes. At the 20 MiB cap, 1,000 contracts take at most 20 GB. No paid model call is added.

## Why

Customers sign contracts, but the service had no way to accept one or remember that it arrived. The signed copy stayed outside the system, with no record of which report it belongs to or when it came in. Also, the service has no idea who a customer is. Anyone who knows a report's id can already read that report, so whatever accepts contracts has to hold up on a fully public service.

## Key decisions

- **Uploads pass through the service rather than going straight to storage via signed links.** The 20 MiB cap is well under the platform's 32 MiB request limit, so one request is enough. It needs no new permissions, and the file is checked before anything is stored.
- **A contract belongs to a report**, matching how sections already hang off reports.
- **Knowing the report's id is the only gate, for now.** Because of that, this PR ships no way to list or download contracts (Q1).
- **The file's fingerprint makes uploads safe to repeat.** A retry gets the original receipt instead of a duplicate.
- **No new dependencies, and no check of the digital signature inside the PDF.**
- Bundled: the task-queue call was sending no access token and had no timeout.

## Instrumentation

- Upload duration, upload failures by class, Cloud Storage write duration, and uploads in progress. New journey SLO "upload a contract" (99.5% over 30 days). Burn-rate tiers only.
- These metrics are recorded but appear on no graph until a metrics backend is chosen (suggested: Google Cloud Monitoring). Spec only.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/contracts.test.ts`: all upload-handler specs pass.
- [ ] Run `bun test src/storage.test.ts`: all Cloud Storage client specs pass.
- [ ] Run `bun test src/queue.test.ts`: the task-queue request carries a bearer token and a timeout.
- [ ] Run `bun test src/metrics.test.ts`: all emission specs pass.
- [ ] Run `grep -q 'create table contracts' migrations/002_contracts.sql && grep -q 'unique (report_id, sha256)' migrations/002_contracts.sql`: the migration is in place.
- [ ] Run `bash -n deploy.sh && grep -q 'public-access-prevention' deploy.sh && grep -q 'versioning' deploy.sh && grep -q 'roles/storage.objectCreator' deploy.sh`: the bucket wiring is in place.
- [ ] DECISION: accept that, until Q1 is answered, anyone who knows a report's id can attach a PDF to it. No read-back path ships.
