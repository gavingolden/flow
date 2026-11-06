# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Generate company reports on request

**Goal:** A caller requesting a company report gets a link within a second, watches five sections arrive, and spend stays capped with no paid section lost to restarts.

## Problem Statement

This service exists to produce written company reports, but today there is no way to ask it for one: it can only fetch or share a report that already exists, and nothing ever creates one. The obvious fix is one request that writes all five sections before answering. Each section takes the model 20 to 60 seconds, so that request would hold the caller for up to five minutes and hit the platform's default cut-off. Any restart in that window throws away sections that were already paid for, and because the service is open to anyone, nothing would limit what such requests cost.

Measured against the product brief's ranked priorities, this lands on **user experience** (priority 1: the caller should not sit through a multi-minute blocking wait or lose a report to a timeout) and **cost** (priority 2: five paid model calls per report on a publicly reachable service need a hard ceiling).

| Fact                                                                           | Evidence                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------- |
| One section call takes 20-60 s and costs money per call                        | [anchor: src/llm.ts:1]                                    |
| The title call exists (1-3 s, paid) but the request names only the five sections | [anchor: src/llm.ts:13]                                   |
| No route creates a report; the only write is the share flag                    | [anchor: src/app.ts:20]                                   |
| Reports live in process memory only                                            | [anchor: src/db.ts:9]                                     |
| Deployed to Cloud Run, open to unauthenticated callers                         | [anchor: deploy.sh:3]                                     |
| Cloud Run request timeout defaults to 5 min; CPU is throttled after the response | https://docs.cloud.google.com/run/docs/configuring/request-timeout, https://docs.cloud.google.com/run/docs/configuring/billing-settings |

Five sequential calls take 100-300 s, which reaches the 300 s default request timeout. Five parallel calls still hold the caller 20-60 s, which is six times the 10 s interactive budget.

## Request vetting

- **Hypothesis:** Five independent model calls, one per section, produce a usable company report. Each call can be retried on its own without re-paying for the others.
- **Case against:** Doing the five calls inside the `POST` request, as literally framed, breaks on this platform. Each call takes 20-60 s [anchor: src/llm.ts:1], so the request blocks 20-300 s against a 300 s default Cloud Run timeout (https://docs.cloud.google.com/run/docs/configuring/request-timeout). Results held only in memory [anchor: src/db.ts:9] vanish on any restart. A client retry re-pays all five calls on a public endpoint [anchor: deploy.sh:3].
- **Sources:** https://docs.cloud.google.com/run/docs/configuring/request-timeout and https://docs.cloud.google.com/run/docs/configuring/billing-settings, as cited by the flow-system-design GCP reference (retrieved 2026-11-03; not re-fetched in this pass)
- **Verdict:** adopt-with-conditions: POST /reports answers within 10 s with 202 and a status link, and the five section calls run as five durable queued tasks under one daily spend cap

## Existing-code assessment

- **src/llm.ts:** simplify — the section call has no timeout and never checks the response status, so a hung or failed model call cannot be retried safely; add a timeout and a typed transient/permanent error first [anchor: src/llm.ts:6]
- **src/db.ts:** rewrite — a process-local Map cannot serve as a status resource that a separate worker writes and the public service reads; replace it with a store interface (in-memory for tests, Firestore in production). This is a prerequisite, so it is bundled as Tasks 3-4 [anchor: src/db.ts:9]
- **src/app.ts:** simplify — handlers import the store as module globals, and the share route does a read-modify-write of the whole report that would clobber sections a worker writes concurrently; turn it into a handler factory that takes its dependencies, and make share a single-field update [anchor: src/app.ts:20]
- **deploy.sh:** keep — extend in place to deploy the public service and a private worker service from the same image [anchor: deploy.sh:3]
- **Dockerfile:** keep — one image serves both roles, selected by an environment variable [anchor: Dockerfile:6]

## Scope Boundary

**In scope:**

- `POST /reports` with body `{ "company": "<name>" }`, which answers `202 Accepted` with a `Location: /reports/{id}` header.
- A fixed server-side list of five sections. Each section is one queued task that makes one model call.
- `GET /reports/{id}` returns the overall status (`queued | running | partial | failed | done`) and each section's status and text.
- A private worker that generates one section per task. It gets per-section retries (at most 3 attempts) and a visible `failed` state.
- One daily cap on paid section calls, enforced before every call.
- An optional `Idempotency-Key` header, so a retried `POST` does not pay for a second report.
- A durable store (Firestore) with point-in-time recovery and daily backups.
- Metrics helper plus `.flow/metrics.md`.
- Deploy script for two services and the queue, plus a rollback command.
- Bundled fixes: the model-call timeout and status check, and the share route's lost-update race.

**Out of scope:**

- Caller authentication or per-caller rate limits on `POST /reports` (candidate follow-up).
- Calling the title model (the title stays `null`).
- Caller-chosen sections.
- Push updates (SSE or webhooks); clients poll.
- Regenerating a failed section on demand.
- Report retention and deletion (candidate follow-up).
- A metrics backend.

## Behavioral contrast

### User flow

| Before                                                        | After                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A caller cannot request a report at all                       | A caller sends a company name and gets an answer with a report link in under a second                  |
| Fetching a report link always returns "not found"             | Fetching the link shows the overall status and each section as it finishes (typically 20-60 s after the request) |
| —                                                             | If one section keeps failing, the report ends `partial` and shows the four that succeeded               |
| —                                                             | When the day's spend cap is reached, new requests are refused with a retry-after time instead of queuing more paid work |

### System flow

- **Before:**
  - One public Cloud Run service with no outbound calls in any route; reports exist only in memory and nothing creates them.
- **After:**
  - The public service creates a report row in Firestore and enqueues five named Cloud Tasks tasks (one per section), then returns 202.
  - A private worker service, reachable only by the queue's service account, claims one section, reserves one call from the daily spend ledger, calls the model with a 90 s timeout, and writes the section.
  - Cloud Tasks is the only layer that retries. It allows at most 3 attempts, with a 150 s dispatch deadline.
  - Report status is derived from the section rows on every read. There is no separate finalize step.

**Lost:** none. The read-report response changes shape (sections become objects carrying a status), but no route has ever been able to create a report, so no caller holds data in the old shape [anchor: src/app.ts:20].

## User Stories / Acceptance Criteria

### Story 1: Request a report

- [ ] Given a body `{ "company": "Acme" }`, when `POST /reports` is called, then the response is `202` with `Location: /reports/{id}` and body `{ id, status: "queued" }`, and exactly five tasks were enqueued, named `<id>-<sectionKey>` — `bun test src/app.test.ts`
- [ ] Given a missing, empty, non-string or longer-than-200-character `company`, or extra fields, when `POST /reports` is called, then the response is `400` and nothing is enqueued — `bun test src/app.test.ts`
- [ ] Given the same `Idempotency-Key` and body sent twice, then both responses carry the same `id` and only five tasks exist; given the same key with a different body, then the second response is `422` — `bun test src/app.test.ts`
- [ ] Given today's ledger has fewer than five calls left, when `POST /reports` is called, then the response is `429` with a `Retry-After` header (seconds to the next UTC day) and nothing is created — `bun test src/app.test.ts`

### Story 2: Follow progress

- [ ] Given a report with sections in mixed states, when `GET /reports/{id}` is called, then it returns `status` derived as: `queued` (all pending), `running` (any pending or running, not all pending), `done` (all done), `partial` (all terminal, at least one done and one failed), `failed` (all failed). It also returns `sections` in the fixed order with `{ key, title, status, text, error }` — `bun test src/db.test.ts src/app.test.ts`
- [ ] Given a worker writing a section while `POST /reports/{id}/share` runs, then both the section text and `shared: true` persist — `bun test src/db.test.ts`

### Story 3: Sections generate reliably

- [ ] Given a pending section, when the worker receives its task, then it reserves one ledger call, calls the model once, stores the text, and answers `200` — `bun test src/worker.test.ts`
- [ ] Given a section already `done`, when its task is redelivered, then the worker answers `200` without calling the model — `bun test src/worker.test.ts`
- [ ] Given a model timeout, a `429` or a `5xx`, when attempts remain, then the section returns to `pending` and the worker answers `503`, so Cloud Tasks retries; on the third attempt the section becomes `failed` and the worker answers `200` — `bun test src/worker.test.ts`
- [ ] Given a model `4xx` other than `429`, then the section is marked `failed` (`upstream_error`) on the first attempt and the worker answers `200` — `bun test src/worker.test.ts`
- [ ] Given a section held by another delivery's unexpired lease, then the worker answers `503` without calling the model — `bun test src/worker.test.ts`

### Story 4: Spend is capped

- [ ] Given a cap of N and N+5 concurrent reservations, then exactly N succeed. Given the cap is exhausted when a task runs, then the section is marked `failed` (`budget_exhausted`) without a model call — `bun test src/db.test.ts src/worker.test.ts`

### Story 5: The worker is not publicly reachable

- [ ] Given the public role, when the worker path is requested, then the response is `404`. The deploy dry-run deploys the worker with `--no-allow-unauthenticated` and grants `roles/run.invoker` only to the queue's service account — `bun test src/app.test.ts && ./deploy.sh --dry-run | grep -q -- '--no-allow-unauthenticated'`

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric                            | Instrument | Unit    | Attributes (closed values)                                                                                  | Emitted at                        |
| --------------------------------- | ---------- | ------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `reports.create.duration`         | Histogram  | seconds | `operation.outcome` (`ok`, `error`)                                                                         | `POST /reports` handler           |
| `reports.create.failures`         | Counter    | none    | `error.type` (`invalid_input`, `budget_exhausted`, `upstream_error`, `internal`, `_OTHER`)                  | `POST /reports` handler           |
| `reports.section.duration`        | Histogram  | seconds | `operation.outcome` (`ok`, `error`)                                                                         | section worker                    |
| `reports.section.failures`        | Counter    | none    | `error.type` (`upstream_error`, `upstream_timeout`, `rate_limited`, `budget_exhausted`, `internal`, `_OTHER`) | section worker                    |
| `reports.llm.client.duration`     | Histogram  | seconds | `server.address` (`api.example-llm.com`), `operation.outcome` (`ok`, `error`)                               | model client                      |
| `reports.llm.client.failures`     | Counter    | none    | `server.address` (`api.example-llm.com`), `error.type` (`upstream_error`, `upstream_timeout`, `rate_limited`, `_OTHER`) | model client               |
| Cloud Tasks queue depth           | Gauge      | `{message}` | queue `report-sections`                                                                                 | platform-native (Cloud Tasks `queue/depth`) |
| Cloud Run instance count          | Gauge      | `{instance}` | service                                                                                                | platform-native (Cloud Run)       |

`reports.create.duration` uses the request-scale advisory bounds (14). `reports.section.duration` and `reports.llm.client.duration` use explicit minute-scale bounds `[1, 5, 10, 20, 30, 45, 60, 90, 120]` (9).

Estimated series: 39 per operation (`reports.create`: 2 × 17 + 5)
Estimated series: 30 per operation (`reports.section`: 2 × 12 + 6)
Estimated series: 28 per operation (`reports.llm.client`: 1 × 2 × 12 + 1 × 4)

All figures are per reporting instance. Samples per month are not estimated because no backend is chosen yet.

**Attributes:** registers `operation.outcome`, `error.type`, `server.address` (closed list: `api.example-llm.com`)

### Error types

New list, created from the starter set: `_OTHER`, `internal`, `invalid_input` (client-caused), `not_found` (client-caused), `rate_limited`, `upstream_error`, `upstream_timeout`. Plus one new value, `budget_exhausted`: this service's daily cap on paid section calls is reached. It is excluded from the availability SLO because it is a deliberate refusal.

### Dashboard panels

These panels go on the new "reports-service overview" dashboard:

- Report requests per minute, split by outcome.
- Section generations per minute, split by outcome.
- Section failures by `error.type`.
- Section and model-call latency p50/p95/p99.
- Queue depth.
- Paid model calls per day, from the `reports.llm.client.duration` count.

### Alerts

- `report-sections` queue depth above 50 for 15 minutes → `notify`.
- `reports.section.failures{error.type="budget_exhausted"}` above 0 in 1 hour → `notify`, because the day's cap was hit.
- Burn-rate tiers otherwise.

Channels are named in `.flow/metrics.md` as `owner-notify`.

### SLO

New journey SLO "generate a company report": 99% of section generations end `ok` over 30 days, excluding `budget_exhausted` and `invalid_input`.

**As-code:** spec-only — the repo keeps no dashboard or alert config

## Architecture Decisions

- **Layers touched:**
  - Persistence: a new Firestore store and spend ledger.
  - Integration: the model client, plus a Cloud Tasks enqueue over REST.
  - HTTP: the public handlers and a new worker handler.
  - Infra: the deploy script (two services, a queue, IAM, PITR and backups).
- **Domain modules:**
  - Existing: `src/app.ts`, `src/db.ts`, `src/llm.ts`.
  - New, each single-purpose per AGENTS.md: `src/sections.ts` (the fixed section list), `src/queue.ts` (enqueue), `src/worker.ts` (section task handler), `src/db-firestore.ts` (production store), `src/metrics.ts` (helper).
- **Data flow:**
  1. The caller sends `POST /reports`.
  2. The public service validates the body, checks the ledger, creates the report row with five `pending` sections, enqueues five named tasks, and returns 202.
  3. Cloud Tasks delivers each task, with an OIDC token, to the private worker.
  4. The worker claims the section under a lease, reserves one ledger call, calls the model, and writes the section.
  5. On `GET /reports/{id}`, the public service reads the row and derives the status.
- **New patterns vs. existing:** new. The repo has no queue, no durable store and no outbound-call pattern yet. This follows flow-system-design's "one queued task per step plus a parent status row" model for multi-section generation.
- **Binary-framing check:** the request is not framed as either/or. The real fork is how the calls are executed: inline sequential, inline parallel, or queued. That fork is recorded in Decision A.
- **Goal-anchor check:** a literal reading ("the endpoint generates the report by calling the model") conflicts with the Goal's sub-second answer. The plan keeps the user's one-call-per-section shape and moves the calls off the request. That deviation is recorded in Open Questions.

### Runtime design

| Operation                          | Est. p99                         | Execution model                                         | Timeout / deadline                                            | Retries                                                        | Idempotency key                                              | Cost bound                                                         |
| ---------------------------------- | -------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Accept report (`POST /reports`)    | ~1 s (estimate: 1 store write + 5 enqueues) | inline — ~1 s, timeout 8 s                    | 8 s handler budget; each enqueue call 2 s                     | none in code; the caller re-posts with the same `Idempotency-Key` | `Idempotency-Key` header (new idempotency doc), task names `<reportId>-<sectionKey>` | new daily spend ledger, read-only admission check (≥5 calls left) |
| Generate one section (worker)      | ~60 s (src/llm.ts:1 says 20-60 s) | durable queue (Cloud Tasks `report-sections`) + worker invoked synchronously under the attempt deadline; 202 + status resource | dispatch deadline 150 s > worker budget 120 s > model call 90 s; lease 180 s | Cloud Tasks only: max attempts 3, min backoff 10 s, max backoff 300 s, max doublings 3 | `<reportId>:<sectionKey>` — named task + consumer done-check + lease claim | new daily spend ledger: reserve 1 call before every model call; queue max 5 concurrent dispatches, 1 dispatch/s; worker max 3 instances |
| Model section call                 | 60 s                             | inline — 60 s, timeout 90 s (inside the worker task)   | 90 s `AbortSignal.timeout`                                    | none (the queue retries)                                       | inherited from the section task                              | counted by the ledger reservation above                            |
| Read report (`GET /reports/{id}`)  | ~200 ms (estimate: 1 store read) | inline — ~200 ms, timeout 5 s                           | 5 s                                                           | none                                                           | n/a (read)                                                   | none (no paid call)                                                |

**Platform:** gcp

**Proportionality:** These are deliberately left out:

- An outbox relay. If an enqueue fails after the report row is written, the request returns 503; a re-post with the same key re-enqueues, and the named tasks dedupe.
- A finalize task. Status is derived on read, and no title call is made.
- A workflow engine. This is a fixed five-way fan-out.
- Per-caller rate limits (candidate follow-up).
- A canary rollout. No caller can create reports today, so there is no live traffic to compare.
- Multi-region and warm-standby restore.
- In-code retries. The Firestore client keeps its own built-in per-RPC retry; this plan adds no second layer around it.

**Recovery:** Firestore `(default)` database, Task 8.

- **Recovery path:** point-in-time recovery enabled, plus a daily backup schedule with 7-day retention.
- **Restore check:** restore the latest backup into a scratch database, compare the `reports` document count, then delete the scratch database.
- **Data class:** regenerable at a known cost (5 paid calls per report).
- **Targets:** RPO is minutes (PITR); RTO is under 1 hour.

**Rollback:** Task 9

- `./deploy.sh rollback` pauses the `report-sections` queue and shifts both services back to their previous revisions.
- Task payloads carry `version: 1`, so tasks enqueued by a rolled-back revision stay readable.

## Technical Constraints

- **Section call cost and latency:** each section call takes 20-60 s and is paid [anchor: src/llm.ts:1]. That is why the call cannot run inside the caller's request, and why every call passes the ledger choke point.
- **Cloud Run limits:** CPU is throttled after the response, and the platform sends SIGKILL 10 s after SIGTERM. Work cannot continue after replying, so in-flight sections must be resumable through the lease and queue retry (flow-system-design GCP reference: https://docs.cloud.google.com/run/docs/container-contract).
- **Public service:** the public service is deployed `--allow-unauthenticated` [anchor: deploy.sh:3]. The worker route must not be mounted on it. The worker runs as a separate `--no-allow-unauthenticated` service invoked only by the queue's service account.
- **Dependencies:** "No new runtime dependencies without a reason" [anchor: AGENTS.md:5].
  - Exactly one is added: `@google-cloud/firestore`, which is needed for transactional claims and ledger reservations.
  - Cloud Tasks is called through its REST API with `fetch`, using a token from the metadata server, so it adds no client library.
- **Performance/cost:**
  - Each report costs 5 paid section calls. The worst case is 15 if every section uses all 3 attempts, and every attempt counts against the daily cap.
  - Each report adds about 20 Firestore operations and 5 Cloud Tasks operations.
  - PITR and daily backups add ongoing storage cost in proportion to report volume. No dollar figure is stated because the model API's per-call price is not in the repo.

## Open Questions

- [ ] Q1. Which five sections does a report contain, and in what order? Redirect changes only the fixed section list in Task 3.
  - **Stakes:** user — the section list is the report's entire content, and a wrong list makes every report miss what readers need (priority 1, user experience)
  - **Needs user input:** user-held preference or subjective taste. The plan's placeholder is: Company overview, Products and services, Market and competitors, Financial performance, Risks and outlook.
- [ ] Q2. What daily ceiling on paid section calls should the service enforce? Redirect changes the default in Task 3 and the deploy env var in Task 9.
  - **Stakes:** both — too low refuses real requests (priority 1); too high lets an anonymous caller run up spend (priority 2, cost)
  - **Needs user input:** user-held preference or subjective taste (it is a budget choice). The plan's placeholder is 500 section calls per UTC day (about 100 reports), set by `REPORTS_DAILY_CALL_CAP`.
- [ ] Should the five section calls run inside the `POST` request, as literally described, or as queued tasks behind a 202? Redirecting to inline removes Tasks 5, 6 and the worker half of Task 9.
  - **Stakes:** both — inline blocks the caller 20-300 s and loses paid sections on any restart (priority 1 over priority 3)
  - **Recommended:** queued tasks behind a 202 and a status link. One call takes 20-60 s, so even the parallel inline form is 2-6× the 10 s interactive budget, and the sequential form reaches Cloud Run's 300 s default timeout [confidence: high] [anchor: src/llm.ts:1]
- [ ] Should reports be stored in Firestore or Cloud SQL? Redirecting rewrites Tasks 4 and 8.
  - **Stakes:** system — Cloud SQL adds an always-running instance cost for a store holding one document per report (priority 2, cost)
  - **Recommended:** Firestore. It is serverless like the Cloud Run service, it has transactions for the claim and ledger, and it has native PITR and backups [confidence: medium] [anchor: weighing: footprint — no database instance to provision, size or pay for while idle]
- [ ] When one section fails for good, should the report show the other four or be discarded? Redirecting to all-or-nothing changes the status derivation in Task 3 and the GET body in Task 7.
  - **Stakes:** user — discarding four paid, finished sections costs the reader content and costs money (priorities 1 and 2; priority 4 prefers degrading gracefully)
  - **Recommended:** keep them, with report status `partial` and the failed section showing its error [confidence: medium] [anchor: weighing: risk — all-or-nothing throws away up to four paid calls per failure]
- [ ] Should the service also call the title model when sections finish? Redirecting adds a finalize step (conditional update, sixth paid call) to Tasks 3 and 6.
  - **Stakes:** user — reports show no title (priority 1, look and feel), against one extra paid call per report (priority 2)
  - **Recommended:** no; the title stays `null`, which the existing report shape already allows [confidence: high] [anchor: user: "calling the model API once for each of five sections"]
- [ ] Should `POST /reports` require caller authentication in this change? Redirecting adds an API-key check and Secret Manager wiring to Tasks 7 and 9.
  - **Stakes:** both — open access lets anyone use up the day's cap and block real callers (priority 1), although spend stays bounded by the cap (priority 2)
  - **Recommended:** keep it public in this change, matching how the existing service is deployed. Spend is bounded by the daily cap, the queue's dispatch caps and max instances; caller authentication is tracked as a candidate follow-up [confidence: medium] [anchor: adjacent: deploy.sh:3]
- [ ] Should Cloud Tasks be called through the official client library or through its REST API with `fetch`? Redirecting changes Task 5's implementation and `package.json`.
  - **Stakes:** system — each extra runtime dependency is a cost under the repo rule, and the gRPC transport under Bun is unverified
  - **Recommended:** REST through `fetch`. Enqueueing is one `POST` per task, so a library is not justified under the repo's dependency rule [confidence: high] [anchor: AGENTS.md:5]
- [ ] May the read-report response change shape (sections become objects with a status)? Redirecting keeps `sections: string[]` and adds a parallel `sectionStatus` array in Task 3.
  - **Stakes:** system — a shape change breaks any existing reader of `GET /reports/{id}`
  - **Recommended:** change it. No route has ever created a report, so no reader holds the old shape [confidence: high] [anchor: src/app.ts:20]
- [ ] Should `POST /reports` accept an `Idempotency-Key` header? Cutting it removes the idempotency doc from Tasks 3-4 and one story from Task 7.
  - **Stakes:** both — without it, a client that retries after a dropped 202 pays for five more calls (priority 2) and sees a duplicate report (priority 1)
  - **Recommended:** accept it as optional. A request without it always creates a new report [confidence: medium] [anchor: weighing: risk — a retried POST otherwise doubles paid spend silently]
- [ ] Is the request body only `{ company }`, with sections fixed on the server? Redirecting to caller-chosen sections adds list validation and a cardinality cap to Task 7.
  - **Stakes:** user — callers cannot tailor sections (priority 1), but the per-report cost stays fixed at five calls (priority 2)
  - **Recommended:** company only, with sections fixed on the server [confidence: high] [anchor: user: "for each of five sections"]

## Decision analysis

**Decision A — how do the five section calls execute?** The three branches are mutually exclusive.

| Branch                          | End-user walkthrough                                                                                                                             | Interruptions / waits per run                       | Failure behaviour                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A1 inline, sequential           | The caller sends the request and waits 100-300 s for one response                                                                                | 1 blocking wait of 100-300 s                        | The 300 s default timeout kills slow runs; any restart loses every paid section; a retry re-pays all 5 |
| A2 inline, parallel             | The caller sends the request and waits 20-60 s for one response                                                                                  | 1 blocking wait of 20-60 s                          | A restart or scale-in mid-request loses every paid section; a retry re-pays all 5                   |
| A3 202 + one queued task per section | The caller sends the request, gets a link in about 1 s, and polls the link (each poll is a fast read) until `done`, typically 20-60 s later | 0 blocking waits over 10 s; N fast polls             | A failed section retries alone (3 attempts max); finished sections are never re-run; the outcome is visible as `partial` or `failed` |

The ranked combinations are A3 > A2 > A1, and there is no hybrid. A2 behind a 202 would be the post-response continuation that Cloud Run forbids; see Alternatives considered.

Verdict: **A3**. It is the only branch with no blocking wait over the 10 s budget (priority 1, user experience) and no re-paid sections on failure (priority 2, cost) [confidence: high] [anchor: src/llm.ts:1].

**Decision B — which durable store?** The two branches are mutually exclusive.

- **B1 Firestore:** no instance to run, so idle cost is storage only. It has transactions for the lease and ledger, native PITR and backups, and a local emulator for tests.
- **B2 Cloud SQL Postgres:** an always-on instance, connection pooling from Cloud Run, and migrations, all for one document per report.

The user flow is identical for both; they differ only in ongoing cost and operational load.

Verdict: **B1 Firestore**. With identical outcomes, the cheaper path wins under priority 2 (cost) [confidence: medium] [anchor: weighing: footprint — no instance to provision, patch or pay for while idle].

## Alternatives considered

- **Return 202 and keep generating in a detached promise on the same instance** — rejected: Cloud Run's request-based billing throttles CPU after the response is sent, and the platform sends SIGKILL 10 s after SIGTERM, so paid sections in flight are lost (https://docs.cloud.google.com/run/docs/configuring/billing-settings).
- **Keep the in-memory Map as the store** — rejected: src/db.ts:9 keeps reports in process memory. A section written by the worker instance is invisible to the instance that serves the read, and every scale-to-zero or deploy wipes all reports.
- **Orchestrate with Google Cloud Workflows** — rejected: the run is a fixed five-way fan-out with no branches or external waits, which is the case the flow-system-design workflows reference says a queue plus per-step rows covers.

## Recommendation

**Reconsider scope** — build the endpoint the user asked for, with one model call per section, but widen it. The request answers 202 at once, the five calls run as five queued tasks on a private worker under a daily spend cap, and reports move to a durable store. This is Decision A3 and B1, and Q2 sets the cap. The plan also simplifies the model client and the request handlers and rewrites the in-memory store, all bundled as prerequisites [confidence: high] [anchor: src/llm.ts:1]

**Redundancy:** none found. The section and title model calls exist but nothing calls them, and no route creates a report.

## Plan risks

The weakest assumption is that `@google-cloud/firestore` runs correctly under Bun. Its default gRPC transport is unverified here. Task 4 sets `preferRest: true` and must pass its contract suite against the Firestore emulator under `bun test`. If it cannot pass, the store layer needs a REST rewrite before anything ships.

## Cut list

- The optional `Idempotency-Key` support (about 40 lines plus one store document per keyed request) is cuttable if the real callers never retry `POST /reports` automatically. It stays in because a silent retry otherwise doubles paid spend.

# Candidate follow-up issues

| Candidate                                         | Value  | Complexity | Rationale                                                                                                                                                                          | Relation to current request                                          | Pull into this pipeline? |
| ------------------------------------------------- | ------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------ |
| Authenticate callers of `POST /reports`           | Medium | Medium     | Needs its own design/decision session. The open decision is which caller identity scheme the real report consumers can use (API key, IAP, or Cloud Run IAM). Without one, any anonymous caller can use up the shared daily cap | Hardens the new paid endpoint; the daily cap already bounds spend    | No                       |
| Expire old reports after a retention window       | Low    | Small      | Needs its own design/decision session. The open decision is how long generated reports are kept before deletion. Until it is set, the reports collection grows without a bound     | Data-lifecycle follow-on to the new durable store                    | No                       |

- [x] Authenticate callers of `POST /reports` — so one anonymous caller cannot use up the shared daily spend cap.
  - **UX:** none
  - **Problem:** the service is deployed open to unauthenticated callers, so anyone who finds the URL can trigger paid generation until the day's cap refuses everyone [anchor: deploy.sh:3]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk: spend is capped, but real callers can be locked out for the rest of the day [anchor: deploy.sh:3]
  - **Complexity:** Medium — a caller check on the public service, a secret or IAM wiring in deploy, and caller-side changes
  - **Risk:** Medium — changes how every caller reaches the service
  - **If never done:** any anonymous caller can block report generation for everyone until the next UTC day
  - **Verdict:** clears bar — a lock-out path on the new paid endpoint outweighs a medium change once the identity scheme is decided
- [ ] Expire old reports after a retention window — so the store does not grow forever.
  - **UX:** none
  - **Problem:** nothing deletes reports once the durable store exists, and the idempotency documents grow the same way [anchor: src/db.ts:15]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk: unbounded storage growth with no measured volume yet [anchor: src/db.ts:15]
  - **Complexity:** Small — a Firestore TTL policy on a `expiresAt` field
  - **Risk:** Low
  - **If never done:** storage and backup cost grow linearly with report volume
  - **Verdict:** below bar — there is no volume yet to measure, and the retention period is a product decision not yet made

# Task breakdown

### Task 1: Metrics helper and metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create a dependency-free metrics helper:
  - `instrument(op, fn)` records a duration histogram by `operation.outcome` and a failures counter by `error.type`.
  - The helper has a closed `ErrorType` union (`_OTHER`, `internal`, `invalid_input`, `not_found`, `rate_limited`, `upstream_error`, `upstream_timeout`, `budget_exhausted`) and a closed attribute map (`operation.outcome`, `error.type`, `server.address`).
  - Recording goes through a swappable in-memory recorder.

  Create `.flow/metrics.md` with:
  - `## Backend`: `none yet — suggested: Google Cloud Monitoring`.
  - `## Namespace`: `reports`.
  - The Attributes, error.type values, Helper, Dashboard panels, Alerts, SLOs and Coverage sections from this plan's Instrumentation.
- **Inputs:** none
- **Outputs:** the helper and the committed metrics contract
- **Contract:**
  - **Files:** create `src/metrics.ts`, `src/metrics.test.ts`, `.flow/metrics.md`
  - **Interfaces:** `export type ErrorType = "_OTHER" | "internal" | "invalid_input" | "not_found" | "rate_limited" | "upstream_error" | "upstream_timeout" | "budget_exhausted"`; `export function instrument<T>(op: "reports.create" | "reports.section" | "reports.llm.client", fn: () => Promise<T>, opts?: { attrs?: { "server.address"?: "api.example-llm.com" }; classify?: (e: unknown) => ErrorType }): Promise<T>`; `export function setRecorder(r: Recorder): void`; `export function memoryRecorder(): Recorder & { observations: Observation[]; counts: Count[] }`
  - **Call-site edits:** none (callers arrive in Tasks 2, 6, 7)
- **Acceptance criteria:** `bun test src/metrics.test.ts && test -f .flow/metrics.md && grep -q budget_exhausted .flow/metrics.md`. The test asserts one `ok` observation on success, one `error` observation plus one failures increment carrying the exact `error.type` on failure, and an unlisted error falling to `_OTHER`.

### Task 2: Harden the model client

- **Skill:** `flow-system-design`
- **Bundled:** the missing timeout and unchecked response status on the existing model calls, found during discovery
- **Description:** Add a 90 s timeout to `generateSection`, and a 10 s timeout to `suggestTitle` for consistency. Check `res.ok`, and throw a typed `LlmError` whose `kind` classifies the failure:
  - `timeout`: an abort or timeout.
  - `transient`: a `429` (with `rateLimited: true`), a `5xx`, or a network error.
  - `permanent`: any other `4xx`, or a missing `text` field.

  Record `reports.llm.client.duration` / `.failures` through the Task 1 helper. Keep the prompt as it is.
- **Inputs:** src/llm.ts; src/metrics.ts from Task 1
- **Outputs:** a model client that never hangs and reports a retryable or permanent failure
- **Contract:**
  - **Files:** edit `src/llm.ts`; create `src/llm.test.ts`
  - **Interfaces:** `export class LlmError extends Error { readonly kind: "timeout" | "transient" | "permanent"; readonly rateLimited: boolean }`; `export async function generateSection(company: string, section: string, opts?: { timeoutMs?: number }): Promise<string>` (default 90_000); `suggestTitle` keeps its signature and adds the timeout and `res.ok` check
  - **Call-site edits:** none (no caller exists yet)
- **Acceptance criteria:** `bun test src/llm.test.ts`, covering a mocked `fetch` for ok, timeout, 429, 503, 400 and missing-`text` responses, each asserting `LlmError.kind` plus one model-call duration observation

### Task 3: Report model, store interface, in-memory store and spend ledger

- **Skill:** `flow-system-design`
- **Bundled:** the share route's read-modify-write race against concurrent section writes, found during discovery
- **Description:** Replace the Map module with:
  - A `ReportStore` interface and the per-section report shape.
  - Derived status.
  - An atomic section claim with lease and attempt counter.
  - A daily spend ledger (`reserveCall` checks and increments atomically).
  - An idempotency-key record.
  - `setShared` as a single-field update.

  The in-memory implementation backs tests and local runs. A shared contract-test function runs against any `ReportStore`. The fixed five-section list (Q1 placeholder) lives in `src/sections.ts`. The default cap is read from `REPORTS_DAILY_CALL_CAP`, falling back to 500 (Q2).
- **Inputs:** src/db.ts
- **Outputs:** the store contract that every handler and the worker depend on
- **Contract:**
  - **Files:** edit `src/db.ts`; create `src/sections.ts`, `src/db.test.ts` (exports `runStoreContract(makeStore)` and runs it on the memory store)
  - **Interfaces:**
    - `export const REPORT_SECTIONS = [{ key: "overview", title: "Company overview" }, { key: "products", title: "Products and services" }, { key: "market", title: "Market and competitors" }, { key: "financials", title: "Financial performance" }, { key: "risks", title: "Risks and outlook" }] as const`
    - `export type SectionKey = (typeof REPORT_SECTIONS)[number]["key"]`
    - `export type SectionState = { key: SectionKey; title: string; status: "pending" | "running" | "done" | "failed"; text: string | null; error: ErrorType | null; attempts: number; leaseUntil: number | null }`
    - `export type Report = { id: string; company: string; title: string | null; shared: boolean; createdAt: string; sections: SectionState[] }`
    - `export type ReportStatus = "queued" | "running" | "partial" | "failed" | "done"`
    - `export function reportStatus(r: Report): ReportStatus`
    - `export interface ReportStore { getReport(id: string): Promise<Report | undefined>; createReport(i: { company: string; idempotencyKey: string | null; requestHash: string }): Promise<{ kind: "created" | "existing"; report: Report } | { kind: "conflict" }>; setShared(id: string): Promise<boolean>; claimSection(id: string, key: SectionKey, now: number, leaseMs: number, maxAttempts: number): Promise<"claimed" | "done" | "leased" | "exhausted" | "missing">; completeSection(id: string, key: SectionKey, text: string): Promise<void>; releaseSection(id: string, key: SectionKey): Promise<void>; failSection(id: string, key: SectionKey, error: ErrorType): Promise<void>; reserveCall(day: string, cap: number): Promise<boolean>; remainingCalls(day: string, cap: number): Promise<number> }`
    - `export function createMemoryStore(): ReportStore`
  - **Call-site edits:** `src/app.ts` — `getReport` becomes async, and `saveReport({...report, shared: true})` becomes `store.setShared(id)`. The full handler rewrite lands in Task 7; this task keeps `src/app.ts` compiling with a module-level `createMemoryStore()`.
- **Acceptance criteria:** `bun test src/db.test.ts`. It covers:
  - The status derivation for all five states.
  - A claim that returns `leased` under an unexpired lease and `exhausted` at max attempts.
  - N+5 concurrent `reserveCall` calls yielding exactly N `true`.
  - A same-key/same-hash create returning `existing`, and a different hash returning `conflict`.
  - A `setShared` racing `completeSection` that keeps both writes.

### Task 4: Firestore store implementation

- **Skill:** `flow-system-design`
- **Description:** Implement `ReportStore` on Firestore with `preferRest: true`:
  - Collection `reports/{id}` holds `sections` as a map keyed by `SectionKey`.
  - `spend/{YYYY-MM-DD}` holds `{ calls }`.
  - `idempotency/{key}` holds `{ reportId, requestHash }`.
  - The claim, ledger reservation and keyed create each run in a Firestore transaction.
  - `setShared` and section writes use field-path updates, never a whole-document set.

  Add the one runtime dependency.
- **Inputs:** `ReportStore` and `runStoreContract` from Task 3; new: src/db-firestore.ts
- **Outputs:** the production store, passing the same contract suite as the memory store
- **Contract:**
  - **Files:** create `src/db-firestore.ts`, `src/db-firestore.test.ts`; edit `package.json` (add `@google-cloud/firestore` to `dependencies`)
  - **Interfaces:** `export function createFirestoreStore(db: Firestore): ReportStore`
  - **Call-site edits:** none (wired in Task 7's entrypoint)
- **Acceptance criteria:** `gcloud emulators firestore start --host-port=localhost:8681 & sleep 8; FIRESTORE_EMULATOR_HOST=localhost:8681 bun test src/db-firestore.test.ts`. The test runs `runStoreContract` against the emulator and fails (does not skip) when `FIRESTORE_EMULATOR_HOST` is unset.

### Task 5: Cloud Tasks enqueue over REST

- **Skill:** `flow-system-design`
- **Description:** Add a `SectionQueue` that creates one HTTP-target task per section:
  - Endpoint: `POST https://cloudtasks.googleapis.com/v2/projects/{p}/locations/{l}/queues/report-sections/tasks`.
  - Bearer token from the metadata server (`Metadata-Flavor: Google`), cached until expiry.
  - Task name: `.../tasks/<reportId>-<sectionKey>`.
  - Must-set settings on every task: `dispatchDeadline: "150s"`, plus `httpRequest.oidcToken` with `serviceAccountEmail` = `TASKS_INVOKER_SA` and `audience` = `WORKER_URL`.
  - Body: base64 JSON `{ version: 1, reportId, sectionKey }`.
  - Each call has a 2 s timeout.
  - A `409 ALREADY_EXISTS` counts as enqueued, which makes a re-post idempotent.

  An in-memory fake backs the tests.
- **Inputs:** `SectionKey` from Task 3; new: src/queue.ts
- **Outputs:** an enqueue client with no new dependency
- **Contract:**
  - **Files:** create `src/queue.ts`, `src/queue.test.ts`
  - **Interfaces:** `export type SectionTask = { version: 1; reportId: string; sectionKey: SectionKey }`; `export interface SectionQueue { enqueue(t: SectionTask): Promise<void> }`; `export function createCloudTasksQueue(cfg: { project: string; location: string; queue: string; workerUrl: string; invokerServiceAccount: string; fetch?: typeof fetch }): SectionQueue`; `export function createMemoryQueue(): SectionQueue & { tasks: SectionTask[] }`
  - **Call-site edits:** none (wired in Task 7)
- **Acceptance criteria:** `bun test src/queue.test.ts`. The mocked `fetch` asserts the task name, `dispatchDeadline` of `150s`, the OIDC fields and the `version: 1` payload. A 409 resolves; a 500 and a 2 s timeout reject.

### Task 6: Section worker

- **Skill:** `flow-system-design`
- **Description:** This is the handler for `POST /internal/sections`. It is mounted only when `ROLE=worker`.

  Steps:
  1. Parse and validate the `SectionTask`, accepting `version: 1`. An unknown version or a malformed body gets `200`, logged as a permanent drop, so it is never retried forever.
  2. Claim the section with `claimSection(id, key, now, 180_000, 3)`:
     - `done` or `missing` → `200`.
     - `leased` → `503`.
     - `exhausted` → `failSection(..., "upstream_error")`, then `200`.
  3. Reserve one call from the ledger with `reserveCall(utcDay, cap)`. If it is refused, run `failSection(..., "budget_exhausted")` and answer `200`.
  4. Call `generateSection(company, title)` inside a 120 s handler budget.
  5. On success, run `completeSection` and answer `200`.

  Failure handling:
  - On `LlmError` `transient`/`timeout`: if attempts remain, run `releaseSection` and answer `503` (Cloud Tasks retries). On the last attempt, run `failSection` with `upstream_timeout`/`rate_limited`/`upstream_error` and answer `200`.
  - On `permanent`: run `failSection(..., "upstream_error")` and answer `200`.

  Retry happens only at the queue layer. Record `reports.section.duration` / `.failures`.
- **Inputs:** Tasks 1-3 outputs (src/llm.ts, src/metrics.ts, src/db.ts)
- **Outputs:** an idempotent section consumer, keyed on `<reportId>:<sectionKey>`, with a 120 s budget under the 150 s dispatch deadline
- **Contract:**
  - **Files:** create `src/worker.ts`, `src/worker.test.ts`
  - **Interfaces:** `export function createWorkerHandler(deps: { store: ReportStore; generate: typeof generateSection; dailyCap: number; now?: () => number }): (req: Request) => Promise<Response>`
  - **Call-site edits:** none (mounted in Task 7)
- **Acceptance criteria:** `bun test src/worker.test.ts`. The test asserts:
  - The idempotency key `<reportId>:<sectionKey>`: a redelivered `done` section makes 0 model calls.
  - The 120 s timeout budget.
  - `503` on transient failure with attempts left, and `failed` plus `200` on attempt 3.
  - A `permanent` failure marks the section `failed` on attempt 1.
  - An exhausted budget makes 0 model calls and marks `budget_exhausted`.
  - `503` under a live lease.
  - One `reports.section.duration` observation per handled task.

### Task 7: Public handlers and role entrypoint

- **Skill:** `flow-system-design`
- **Description:** Turn `handle` into `createApiHandler(deps)`.

  `POST /reports`:
  1. Validate the body: JSON with only `company`, a string of 1-200 characters after trimming. The body is capped at 4 KB.
  2. Hash the body. Read the optional `Idempotency-Key` header, which must be 1-200 printable characters.
  3. Admission check: if `remainingCalls(utcDay, cap) < 5`, answer `429` with `Retry-After` set to the seconds until the next UTC day.
  4. Call `createReport`: `conflict` → `422`; `existing` → the same 202.
  5. Enqueue the five tasks in parallel, under an 8 s handler budget. If any enqueue fails, answer `503`; a re-post with the same key re-enqueues safely.
  6. Answer `202` with `Location: /reports/{id}` and body `{ id, status }`.

  Other routes:
  - `GET /reports/{id}` returns `{ id, company, title, shared, createdAt, status, sections: [{ key, title, status, text, error }] }`.
  - `POST /reports/{id}/share` uses `setShared`.

  Record `reports.create.*`. In the `import.meta.main` entrypoint, `ROLE=worker` serves only `createWorkerHandler`, and any other value serves only the API handler. Both use `createFirestoreStore` when `GOOGLE_CLOUD_PROJECT` or `FIRESTORE_EMULATOR_HOST` is set, and the memory store and queue otherwise.
- **Inputs:** Tasks 1, 3-6 outputs
- **Outputs:** the user-facing endpoint and status resource
- **Contract:**
  - **Files:** edit `src/app.ts`; create `src/app.test.ts`
  - **Interfaces:** `export function createApiHandler(deps: { store: ReportStore; queue: SectionQueue; dailyCap: number; now?: () => number; newId?: () => string }): (req: Request) => Promise<Response>`; the exported `handle` is removed, with no external importer [anchor: src/app.ts:9]
  - **Call-site edits:** the `src/app.ts` entrypoint selects the handler by `ROLE`; `Dockerfile` stays unchanged
- **Acceptance criteria:** `bun test src/app.test.ts`. It covers:
  - A valid 202 with Location and five tasks.
  - The 400 cases.
  - Idempotent repeat versus the 422 conflict.
  - The 429 with `Retry-After`.
  - The 503 on enqueue failure.
  - The GET status and sections shape.
  - A share that preserves sections.
  - `POST /internal/sections` returning 404 on the API role.

### Task 8: Datastore, queue and IAM setup with recovery check

- **Skill:** `flow-system-design`
- **Description:** Write an idempotent, parameterized setup script (`${GCP_PROJECT:?}`, `${REGION:-us-central1}`) that does the following:
  1. Ensures the Firestore `(default)` database exists in native mode.
  2. Enables point-in-time recovery: `gcloud firestore databases update --database='(default)' --enable-pitr`.
  3. Creates a daily backup schedule: `gcloud firestore backups schedules create --database='(default)' --recurrence=daily --retention=7d`, skipped when one already exists.
  4. Creates or updates the `report-sections` queue with these must-set settings: `--max-attempts=3 --min-backoff=10s --max-backoff=300s --max-doublings=3 --max-concurrent-dispatches=5 --max-dispatches-per-second=1`. The 150 s dispatch deadline is set per task in Task 5.
  5. Creates service accounts `reports-api` (`roles/datastore.user`, `roles/cloudtasks.enqueuer`, `roles/iam.serviceAccountUser` on the invoker), `reports-worker` (`roles/datastore.user`) and `reports-tasks-invoker`.

  A separate recovery-check script does three things:
  - Asserts `pointInTimeRecoveryEnablement` is `POINT_IN_TIME_RECOVERY_ENABLED` and that a backup schedule exists.
  - Restores the newest backup into the scratch database `reports-restore-check`, compares its `reports` document count, then deletes the scratch database.
  - Prints the restore duration against the 1 h RTO.

  Both scripts support `--dry-run`, which prints the commands instead of running them.
- **Inputs:** none; new: scripts/setup-infra.sh, scripts/check-recovery.sh
- **Outputs:** a durable store with PITR, backups and a tested restore path, plus a configured queue
- **Contract:**
  - **Files:** create `scripts/setup-infra.sh`, `scripts/check-recovery.sh`
  - **Interfaces (config/infra form):**
    - Firestore `(default)`: `pointInTimeRecoveryEnablement` goes from unset to `POINT_IN_TIME_RECOVERY_ENABLED`; backup schedule goes from none to daily with 7d retention.
    - Queue `report-sections`: `maxAttempts` goes from absent to `3`, `minBackoff` to `10s`, `maxBackoff` to `300s`, `maxDoublings` to `3`, `maxConcurrentDispatches` to `5`, `maxDispatchesPerSecond` to `1`.
  - **Call-site edits:** none
- **Acceptance criteria:** `GCP_PROJECT=demo bash scripts/setup-infra.sh --dry-run | grep -q -- '--enable-pitr' && GCP_PROJECT=demo bash scripts/setup-infra.sh --dry-run | grep -q -- '--max-attempts=3' && GCP_PROJECT=demo bash scripts/check-recovery.sh --dry-run | grep -q 'restore'`

### Task 9: Deploy two services and add rollback

- **Skill:** `flow-system-design`
- **Description:** Extend `deploy.sh` so the default action deploys the following:
  1. **`reports-worker`**, deployed first with `--no-allow-unauthenticated --service-account=reports-worker@… --set-env-vars=ROLE=worker,REPORTS_DAILY_CALL_CAP=${REPORTS_DAILY_CALL_CAP:-500} --timeout=180 --max-instances=3 --concurrency=5`.
  2. **Invoker grant:** `roles/run.invoker` on `reports-worker`, for `reports-tasks-invoker` only.
  3. **`reports-service`**, with `--allow-unauthenticated --service-account=reports-api@… --set-env-vars=ROLE=api,WORKER_URL=<worker url>,TASKS_INVOKER_SA=…,REPORTS_DAILY_CALL_CAP=… --max-instances=5`. The worker URL is read with `gcloud run services describe reports-worker --format='value(status.url)'`.

  `./deploy.sh rollback` pauses the `report-sections` queue, then runs `gcloud run services update-traffic <svc> --to-revisions=<previous>=100` for both services. The previous revision is read from `gcloud run revisions list`. Rollback leaves the queue paused, and tasks are resumed by hand with `gcloud tasks queues resume report-sections`. Both actions support `--dry-run`.
- **Inputs:** deploy.sh; Task 8 service accounts and queue
- **Outputs:** a private worker, a public API, and a one-command rollback
- **Contract:**
  - **Files:** edit `deploy.sh`
  - **Interfaces (config/infra form):**
    - The `reports-service` deploy keeps `--allow-unauthenticated` and adds `--max-instances=5` and `ROLE=api`.
    - A new `reports-worker` service gets `--no-allow-unauthenticated`, `--timeout=180`, `--max-instances=3`, `--concurrency=5` and `ROLE=worker`.
    - New subcommand `rollback`.
  - **Call-site edits:** none
- **Acceptance criteria:** `./deploy.sh --dry-run | grep -q -- '--no-allow-unauthenticated' && ./deploy.sh --dry-run | grep -q 'roles/run.invoker' && ./deploy.sh rollback --dry-run | grep -q 'update-traffic' && ./deploy.sh rollback --dry-run | grep -q 'queues pause'`

| Task | Depends on |
| ---- | ---------- |
| 1    | —          |
| 2    | 1          |
| 3    | 1          |
| 4    | 3          |
| 5    | 3          |
| 6    | 1, 2, 3    |
| 7    | 1, 3, 4, 5, 6 |
| 8    | —          |
| 9    | 7, 8       |

Execution order: 1 → 9, in task order.

### Skills Summary

| Skill                | Recommended?           | Reason                                                                                   |
| -------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `flow-system-design` | Yes (Tasks 2-9)     | Execution model, deadlines, single-layer retry, idempotency, spend cap, recovery, rollback |
| `flow-metrics`       | Yes (Task 1)           | Creates the metrics helper and `.flow/metrics.md`                                        |
| `flow-testing`       | No (folded into tasks) | Each task ships its own `bun test` file; there is no separate test-only task              |
| `flow-ui-ux`         | No                     | No UI surface                                                                            |
| `flow-refactoring`   | No                     | The `src/app.ts` and `src/db.ts` reshapes are part of the feature, not behaviour-preserving refactors |
| `flow-new-feature`   | No (implicit)          | Drives implementation as a pipeline phase, not as a task                                  |

# PR description draft

## TLDR

You can now request a company report and get its link back within a second, where before no report could be created; its five sections then fill in under a daily spend cap.

## User-facing changes

- New request: send a company name to create a report, and get an immediate "accepted" answer with the report's link.
- Fetching a report now shows its progress:
  - **Before:** fetching any report link returned "not found", because no report could ever be created.
  - **After:** the link shows the overall status (queued, running, partial, failed, done) and each section's status and text as it finishes.
- A report whose section keeps failing ends as "partial" and still shows every section that succeeded.
- Sending the same request again with the same idempotency key returns the same report instead of paying for a new one.
- When the day's spend cap is reached, new requests are refused with a retry-after time.

## System changes

- Report generation now runs on a queue:
  - **Before:** one public service held reports only in memory and made no model calls.
  - **After:** the public service records each report durably and queues five section jobs; a separate private worker makes one model call per job, with up to three attempts.
- Reports move to a durable database, Firestore, with point-in-time recovery and daily backups, so reports survive restarts and deploys.
- One daily cap counts every paid model call, retries included. The default is 500 calls, about 100 reports.
- Ongoing cost:
  - Each report costs five paid model calls, at most fifteen if every section exhausts its retries.
  - Each report adds about twenty database operations and five queue operations.
  - Backup storage grows with report volume.

## Why

There is no way to ask this service for a company report: it can only read and share reports that already exist. A single request that writes five sections would hold the caller for up to five minutes and risk a timeout. Any restart would discard sections already paid for, and because the service is open to anyone, nothing would bound what such requests cost.

## Key decisions

- **Queued sections instead of generating inside the request.** One section takes 20-60 seconds, so even running all five in parallel would keep the caller waiting far past a ten-second budget. Running them in sequence hits the platform's five-minute cut-off.
- **The worker is a separate private service.** The main service is open to the public, so the worker is reachable only by the queue's identity; nobody can trigger paid work while skipping the queue's caps.
- **Firestore instead of Cloud SQL.** The outcome is the same and there is no always-on database instance to pay for.
- **Partial reports are kept.** A section that fails for good marks the report "partial" instead of discarding four paid sections.
- **No title generation.** The request names only five section calls, so reports have no title, which saves one paid call per report.
- **One new dependency.** Only the Firestore client is added; the queue is called over its plain web API, per the repo's dependency rule.
- **Out of scope:** caller authentication on the new request (filed as a follow-up), caller-chosen sections, push updates, regenerating a section on demand, and report retention.
- Bundled: the missing timeout and unchecked status on the existing model calls.
- Bundled: the share action's lost-update race against sections being written concurrently.

## Instrumentation

- **Recorded metrics:** report-request latency and failures, section-generation latency and failures, and model-call latency and failures, with a closed failure list that includes a new "daily budget exhausted" type.
- **Dashboard:** panels for the new "reports-service overview" dashboard are specified; the work is spec-only, with no dashboard URL yet.
- **Alerts:** queue backlog above 50 for 15 minutes, and any budget-exhausted failure.
- **SLO:** new "generate a company report" SLO, with 99% of section generations succeeding over 30 days.
- **Visibility:** this change creates the metrics contract with no backend chosen (suggested: Google Cloud Monitoring), so these metrics are recorded but will not appear on any graph until a backend is chosen.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/app.test.ts` — request accepted with link and five queued jobs, invalid bodies refused, idempotent repeat, conflict, cap refusal, and status shape all pass.
- [ ] Run `bun test src/worker.test.ts` — section success, redelivery without a model call, retry then fail on attempt three, permanent failure, budget refusal, and lease contention all pass.
- [ ] Run `bun test src/db.test.ts` — status derivation, concurrent cap reservations yielding exactly the cap, and share-versus-section race all pass.
- [ ] Run `bun test src/llm.test.ts src/queue.test.ts src/metrics.test.ts` — model timeout and error classification, queue job shape, and metric emission all pass.
- [ ] Start the Firestore emulator with `gcloud emulators firestore start --host-port=localhost:8681` (requires the gcloud CLI with the emulator component).
- [ ] Run `FIRESTORE_EMULATOR_HOST=localhost:8681 bun test src/db-firestore.test.ts` — the production store passes the same contract suite under Bun.
- [ ] Run `./deploy.sh --dry-run | grep -q -- '--no-allow-unauthenticated'` — the worker service is deployed private.
- [ ] Run `./deploy.sh rollback --dry-run | grep -q 'update-traffic'` — rollback shifts traffic to the previous revisions.
- [ ] Run `GCP_PROJECT=demo bash scripts/setup-infra.sh --dry-run | grep -q -- '--enable-pitr'` — point-in-time recovery is enabled by setup.
- [ ] DECISION: you accept the placeholder five sections (overview, products, market, financials, risks) and the default cap of 500 paid section calls per day, or reply with your own.
