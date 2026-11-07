# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Company report generation endpoint

**Goal:** A caller submits a company name once and, about a minute later, can read a durable five-section report, with paid model spend capped per day.

## Problem Statement

This service exists to produce written reports about companies, but nothing in it can create one today: there is a way to read a report and a way to mark one as shared, and no way to make one. The obvious fix, writing all five sections while the caller waits, runs into three problems. Each section takes 20 to 60 seconds and costs money. Saved reports live only in one server's memory. And the service is open to the public internet. Done naively, a caller waits minutes, may get nothing back, and anyone can run up the model bill.

| Fact                                                                    | Evidence                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| No route creates a report; `saveReport` is only called by the share route | src/app.ts:20                                                       |
| One section takes 20–60 s and is billed per call                        | src/llm.ts:1                                                        |
| The model call has no timeout and never checks the HTTP status          | src/llm.ts:6-10                                                     |
| Reports live in a per-process `Map`, so a restart or a second instance loses them | src/db.ts:9                                                         |
| The service is deployed publicly with no auth                           | deploy.sh:3 (`--allow-unauthenticated`)                             |
| Cloud Run kills a request at 300 s by default and gives 10 s on SIGTERM | https://docs.cloud.google.com/run/docs/configuring/request-timeout, https://docs.cloud.google.com/run/docs/container-contract |

Who it affects, in the product brief's terms: **user experience** (priority 1). The caller shouldn't have to hold a connection for minutes or re-check whether a report silently vanished. **Cost** (priority 2). Five paid calls per report, and the plan has to say what bounds them.

## Request vetting

- **Hypothesis:** A caller can get a five-section company report from one request, each paid model call runs once per section, and the result can still be read after the request ends.
- **Case against:** Taken literally, five model calls inside the request take 100–300 s sequentially [anchor: src/llm.ts:1], which collides with Cloud Run's 300 s default request timeout, and the call has no timeout of its own [anchor: src/llm.ts:6]. A client disconnect, a client retry, or a deploy's 10 s shutdown window throws away work that was already paid for. The finished report then goes into a per-instance in-memory map [anchor: src/db.ts:9] that another instance or a restart cannot see. And the service is public [anchor: deploy.sh:3], so anyone can trigger paid calls with no cap.
- **Sources:** https://docs.cloud.google.com/run/docs/configuring/request-timeout; https://docs.cloud.google.com/run/docs/container-contract; https://docs.cloud.google.com/run/docs/configuring/billing-settings
- **Verdict:** push back: accept the request with 202 and generate the five sections in one queued background task over a durable store, behind an API key and a daily report cap, with a status the caller polls

## Existing-code assessment

- **src/app.ts:** simplify — routing is a regex chain inside one exported `handle` that imports the store at module level, so nothing can inject a fake store or queue; turn it into `createApp(deps)` before adding routes [anchor: src/app.ts:9]
- **src/db.ts:** rewrite — a per-process `Map` is invisible to the queued worker (a different request, possibly a different instance) and is wiped on every restart; a durable store is a prerequisite for any version of this feature [anchor: src/db.ts:9]
- **src/llm.ts:** simplify — add an explicit timeout and an HTTP-status check to both calls before the worker relies on them [anchor: src/llm.ts:6]
- **deploy.sh:** keep — a single deploy command; extend it with the queue, the private worker service and the datastore [anchor: deploy.sh:3]
- **Dockerfile:** simplify — it copies `package.json` but never installs dependencies, so the first runtime dependency needs an install step [anchor: Dockerfile:3]

## Scope Boundary

**In scope:**

- `POST /reports` taking `{ "company": "<name>" }`. It requires an API key, takes an optional `Idempotency-Key` header, and answers `202` with the report id and a `Location` header.
- A fixed, server-side list of five sections. Each one gets exactly one model call per attempt, all five in parallel, inside one queued background task.
- Per-section progress that survives restarts. A retry re-runs only the sections that haven't finished yet.
- `GET /reports/:id` returning `status` (`queued` / `running` / `done` / `partial` / `failed`) and per-section state.
- A daily cap on created reports, enforced in the same write that creates the report.
- Timeouts and status checks on the model client.
- A durable store, which also makes the existing read and share routes survive restarts.
- Metrics helper plus `.flow/metrics.md`.
- Deploy changes: queue, private worker service, datastore with point-in-time recovery, dependency install.

**Out of scope:**

- Calling the title-suggestion model endpoint (see the title Open Question).
- Caller-chosen section lists.
- Streaming or push progress (SSE/WebSockets).
- Auth on the existing read and share routes.
- Regenerating or editing an existing report.
- Listing reports.
- Choosing a metrics backend.

## Behavioral contrast

### User flow

| Before                                                    | After                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `POST /reports` → `404 {"error":"not found"}`; no way to create a report | `POST /reports` with `{"company":"Acme"}` and the API key → `202 {"id":"…","status":"queued"}` within ~1 s, plus `Location: /reports/<id>` |
| —                                                         | `GET /reports/<id>` shows `queued` → `running` → `done` with five section texts, typically 20–70 s later      |
| —                                                         | Missing or wrong API key → `401`; empty or overlong company → `400`; daily cap reached → `429` with `Retry-After` |
| Re-sending the same request would (if it existed) pay for a second report | Re-sending with the same `Idempotency-Key` returns the same report id and pays for nothing new               |
| A report could vanish on any restart or be missing on another instance | Reports persist across restarts and instances                                                               |
| `POST /reports/<id>/share` works on any stored report      | Sharing a report that is not `done` → `409`                                                                  |

### System flow

- **Before:**
  - Reports are stored per process in memory. Nothing writes them except the share toggle.
  - The model client is never called. It has no timeout and no status check.
  - One public Cloud Run service, no queue, no datastore.
- **After:**
  - The public service validates the request, then in one transaction reserves the day's budget and creates the report row. After that commit it enqueues one named Cloud Tasks task per report.
  - A private worker service (same image, `SERVICE_ROLE=worker`, reachable only through the queue's OIDC identity) runs the five section calls in parallel. Each result is written as soon as it lands.
  - Retries happen only at the queue: 3 attempts, re-running only unfinished sections. After the final attempt the report ends `partial` or `failed`, so failures stay visible.
  - Each report costs 5 paid generation calls, 15 at most with retries, and the daily cap bounds the total.

**Lost:** the service can no longer run with zero cloud setup. Starting it needs a Firestore database, a Cloud Tasks queue, the API-key secret and the worker service (tests use in-memory fakes). Sharing an unfinished report is now refused.

## User Stories / Acceptance Criteria

### Story 1: Start a report

- [ ] Given a valid API key and `{"company":"Acme"}`, when `POST /reports`, then the response is `202` with `{id, status:"queued"}` and `Location: /reports/<id>`, and exactly one generation task named for that report is enqueued (`bun test src/app.test.ts`)
- [ ] Given a missing or wrong `Authorization: Bearer` key, when `POST /reports`, then `401` and no report or task is created (`bun test src/app.test.ts`)
- [ ] Given a missing, empty, or longer-than-200-character `company`, when `POST /reports`, then `400` and nothing is created (`bun test src/app.test.ts`)
- [ ] Given the day's report cap is reached, when `POST /reports`, then `429` with a `Retry-After` header and no task is enqueued (`bun test src/app.test.ts`)
- [ ] Given two `POST /reports` with the same `Idempotency-Key` and body, then both return the same id and only one task is enqueued; the same key with a different company returns `422` (`bun test src/app.test.ts`)

### Story 2: Generate the five sections

- [ ] Given a queued report, when the worker runs and all five calls succeed, then the model client is called exactly five times (once per section), the report is `done`, and `sections` holds the five texts in the fixed order (`bun test src/worker.test.ts`)
- [ ] Given one section fails on a non-final attempt, when the worker runs, then it answers `503`, the four successful sections are stored, and the redelivered attempt calls the model only for the failed section (six calls in total) (`bun test src/worker.test.ts`)
- [ ] Given a section still fails on the final attempt, then the worker answers `200`, the report is `partial` and the failed section carries its `error.type` (`bun test src/worker.test.ts`)
- [ ] Given a report that is already `done`, when its task is redelivered, then no model call is made (`bun test src/worker.test.ts`)
- [ ] Given the model API does not answer within the per-call timeout, then that section fails with `upstream_timeout` (`bun test src/llm.test.ts`)

### Story 3: Read and share

- [ ] Given a report id, when `GET /reports/:id`, then the body includes `status`, per-section state, and `sections`; an unknown id returns `404` (`bun test src/app.test.ts`)
- [ ] Given a report that is not `done`, when `POST /reports/:id/share`, then `409`; given a `done` report, then `200 {shared:true}` (`bun test src/app.test.ts`)
- [ ] Given a stubbed store, queue and model client, when a report is created, its task is run, and it is read back, then the read shows `done` with five sections (`bun test src/app.test.ts`, end-to-end flow spec)

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric                      | Instrument | Unit    | Attributes (closed values)                                                   | Emitted at                                      |
| --------------------------- | ---------- | ------- | ---------------------------------------------------------------------------- | ----------------------------------------------- |
| `reports.create.duration`   | Histogram  | seconds | platform-native                                                              | platform-native (Cloud Run `request_latencies`) |
| `reports.create.failures`   | Counter    | none    | `error.type` (`invalid_input`, `unauthorized`, `rate_limited`, `internal`, `upstream_error`, `_OTHER`) | `POST /reports` handler                         |
| `reports.generate.duration` | Histogram  | seconds | `operation.outcome` (`ok`, `error`)                                          | worker, one observation per task attempt        |
| `reports.generate.failures` | Counter    | none    | `error.type` (`not_found`, `upstream_error`, `upstream_timeout`, `internal`, `_OTHER`) | worker                                          |
| `reports.llm.duration`      | Histogram  | seconds | `server.address` (`api.example-llm.com`), `operation.outcome` (`ok`, `error`) | model client, per call                          |
| `reports.llm.failures`      | Counter    | none    | `server.address` (`api.example-llm.com`), `error.type` (`upstream_error`, `upstream_timeout`, `_OTHER`) | model client, per call                          |
| Queue depth                 | Gauge      | `{message}` | platform-native                                                          | platform-native (Cloud Tasks `queue/depth`)     |

Bucket boundaries, which are explicit because these runs are not request-scale: generate `[10, 20, 30, 45, 60, 90, 120, 180, 240]` (9 bounds); llm `[1, 5, 10, 20, 30, 45, 60, 90]` (8 bounds).

Estimated series: 6 per operation for `reports.create` (failures counter only; latency is platform-native)
Estimated series: 29 per operation for `reports.generate` (histogram 2 × (9 + 3) = 24, plus 5 `error.type` values)
Estimated series: 25 per operation for `reports.llm` (histogram 1 host × 2 × (8 + 3) = 22, plus 1 host × 3 `error.type` values)

All are per reporting instance. The worker is capped at 2 instances (see Runtime design).

**Attributes:** new keys registered as `.flow/metrics.md` `## Attributes` rows:

- `operation.outcome` (`ok`, `error`)
- `error.type` (the list below)
- `server.address` (`api.example-llm.com`)
- `messaging.destination.name` (`report-generation`), platform-native only

### Error types

These are the starter list, with no new classes:

| Value              | Meaning                                    |
| ------------------ | ------------------------------------------ |
| `_OTHER`           | fallback                                   |
| `internal`         | internal failure                           |
| `invalid_input`    | bad body (client-caused)                   |
| `not_found`        | task for a missing report (client-caused)  |
| `rate_limited`     | the daily report cap was reached           |
| `unauthorized`     | bad or missing API key (client-caused)     |
| `upstream_error`   | model API or Cloud Tasks answered non-2xx  |
| `upstream_timeout` | model API exceeded the 90 s call timeout   |

### Dashboard panels

On a new "reports-service overview" dashboard:

- Request rate, Success vs failure and Latency p50 / p95 / p99 for `reports.generate`.
- Failures by `error.type` for `reports.create` and `reports.generate`.
- Latency p50 / p95 / p99 for `reports.llm` (outbound).
- Queue depth for `report-generation` (platform-native).

### Alerts

burn-rate tiers only

### SLO

New journey SLO "generate a company report", 30-day window:

- **Availability:** 99% of generation attempts end `ok`, excluding client-caused `error.type` values.
- **Latency:** 95% of attempts finish under 120 s.

Both are recorded in `.flow/metrics.md` `## SLOs`, with the standard burn-rate tiers.

**As-code:** spec-only — the repo keeps no dashboard or alert config, and `## Backend` reads `none yet — suggested: Google Cloud Monitoring via OTLP`

## Architecture Decisions

| Aspect            | Decision                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layers touched    | HTTP handlers (`src/app.ts`), persistence (`src/db.ts`), model client (`src/llm.ts`), new queue client (`src/queue.ts`), new worker (`src/worker.ts`), new metrics helper (`src/metrics.ts`), deploy (`deploy.sh`, `Dockerfile`) |
| Domain modules    | Existing: report store, model client. New: report queue, report worker, metrics helper, fixed section list (`src/sections.ts`). Each is one small single-purpose module, per AGENTS.md |
| Data flow         | 1. Caller sends `POST`. 2. The transaction checks the daily budget and creates the report row. 3. After commit, a named Cloud Tasks task is enqueued. 4. The private worker makes 5 parallel model calls. 5. Each section result is written to its row as it lands. 6. The derived status goes to `done` / `partial` / `failed`. 7. The caller polls `GET` |
| Pattern           | New: queued generation with a parent status row and per-section checkpoints (flow-system-design "multi-section work"). The only deviation is one task per report instead of one per section; see Decision 1 |
| Binary framing    | The request isn't framed as a binary choice. The real fork is sync vs. async, and the middle option (inline, parallel calls, durable store, raised timeout) is ranked in Decision 1 |
| Auth              | `POST /reports` requires `Authorization: Bearer <REPORTS_API_KEY>`, compared in constant time and loaded from Secret Manager. The worker lives on a separate service deployed with `--no-allow-unauthenticated` and only the queue's service account can invoke it. Existing `GET` and share routes stay unchanged |

### Runtime design

| Operation                          | Est. p99 | Execution model                                                     | Timeout / deadline                                         | Retries                                                         | Idempotency key                                                    | Cost bound                                                    |
| ---------------------------------- | -------- | ------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| Create report (`POST /reports`)    | ~600 ms  | inline — ~600 ms, timeout 5 s (2 s per Firestore / Cloud Tasks call) | 5 s handler                                                | none server-side; the client re-POSTs with `Idempotency-Key`     | `Idempotency-Key` header (hashed) → stored report id                 | new daily report cap, reserved in the create transaction       |
| Generate report (worker task)      | ~70 s    | queue — Cloud Tasks, one named task per report, private worker service | dispatch deadline 300 s > worker deadline 240 s             | Cloud Tasks only: max attempts 3, min backoff 10 s, max backoff 120 s | task name `report-<reportId>`, plus per-section checkpoint `<reportId>:<section>` (finished sections are skipped) | ≤ 5 calls per attempt × 3 attempts = 15 calls per capped report |
| Model call (`generateSection`)     | ~60 s    | inline within the worker, 5 in parallel                             | 90 s per call (`AbortSignal.timeout`)                       | none (queue layer only)                                         | n/a — called only for sections with no stored result               | counted under the report's cap                                 |
| Read report (`GET /reports/:id`)   | ~100 ms  | inline — ~100 ms, timeout 2 s                                       | 2 s                                                        | none                                                            | n/a (read)                                                         | none (no paid call)                                           |

**Platform:** gcp

**Proportionality:** these were deliberately left out:

- **Per-section tasks with a finalize step.** Five fixed sections fit one 300 s attempt, and checkpoints already stop finished sections from re-running.
- **Outbox for the enqueue.** If the enqueue fails after commit, the report is marked `failed` and the caller gets `503`, which is visible and cheap.
- **Per-caller rate limiting.** There is one API key, so the daily cap plus the worker's `--max-instances=2` and the queue's `maxConcurrentDispatches=2` (at most 10 concurrent model calls) are the overload cap.
- **Multi-region and SSE progress.** Polling is enough for jobs of tens of seconds.

**Recovery:** Firestore point-in-time recovery is enabled when the database is created (7-day window, RPO of minutes). Reports are paid generations: rebuilding one costs 5 model calls, but the `shared` flag is user state, so recovery matters. The restore check is a one-time PITR export to a scratch bucket after the first deploy, tracked as a post-merge follow-up because it needs production access.

## Technical Constraints

- **No work after the response.** Cloud Run request-based billing throttles CPU once the response is sent, so generation must not run as a detached promise in the `POST` handler (https://docs.cloud.google.com/run/docs/configuring/billing-settings).
- **Deadlines shrink inward.** Cloud Tasks dispatch deadline 300 s > worker internal deadline 240 s > per-call timeout 90 s. The default dispatch deadline is 10 min and the maximum is 30 min (https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks).
- **Keep the worker off the public service.** The existing service is public (deploy.sh:3), so the worker route must not be mounted there. It is served only when `SERVICE_ROLE=worker`, on a service deployed `--no-allow-unauthenticated`.
- **Bound the prompt input.** `company` is interpolated straight into the model prompt (src/llm.ts:8). Cap it at 200 characters and strip control characters before storing or sending it.
- **Two new runtime dependencies, with the reason AGENTS.md requires.**
  - `@google-cloud/firestore` makes reports durable across restarts and instances.
  - `@google-cloud/tasks` gives a durable queue with named-task dedupe and retry config.
  - Hand-rolled REST calls would need hand-written metadata-server token handling for both.
- **Cost.** Each report is 5 paid generation calls normally and 15 at most with retries. Today there are zero, because no route calls the model. The daily cap is the one choke point that bounds spend.
- **Latency.** The caller's wait drops from a 100–300 s blocking request (literal reading) to a ~1 s `202` plus polling. A finished report takes ~20–70 s.
- **Tests.** No tests exist yet. Every task adds its own `bun test` file using in-memory fakes, so CI needs no GCP credentials.

## Open Questions

- [ ] **Q1.** Which five sections, and in what order? A redirect changes only the `REPORT_SECTIONS` constant in Task 5 and the fixture names in its tests.
  - **Stakes:** user — the section list is the report's content, and the user experience (priority 1) depends on it matching what readers expect
  - **Needs user input:** user-held preference or subjective taste. Until answered, the plan ships the placeholder list `Overview`, `Products and Services`, `Market and Competition`, `Financial Highlights`, `Risks and Outlook`.
- [ ] **Q2.** What daily report cap? A redirect changes the `REPORTS_DAILY_CAP` value set in Task 7.
  - **Stakes:** both — too low refuses legitimate reports with `429` (user experience); too high leaves model spend effectively unbounded (cost)
  - **Needs user input:** user-held preference or subjective taste (a spend budget). Until answered, the plan ships `50` reports per UTC day, which is at most 750 model calls with retries.
- [ ] Should `POST /reports` answer `202` and let the caller poll, rather than return the finished report? A redirect to synchronous drops Tasks 4 and 7's queue and worker and puts the five calls inside the request (Decision 1, rank 3).
  - **Stakes:** both — synchronous means a 60–300 s blocking request that can lose paid work (user experience, cost); async needs a polling loop on the caller's side
  - **Recommended:** `202` plus polling — the model client's own comment puts one call at 20–60 s, so five calls cannot fit the interactive budget or reliably fit the 300 s request timeout [confidence: high] [anchor: src/llm.ts:1]
- [ ] Should generation also call the title-suggestion endpoint to fill `title`? A redirect adds a sixth, 1–3 s call at the end of a `done` run in Task 5.
  - **Stakes:** user — reports have a `null` title until this is added
  - **Recommended:** no — the user asked for the model API to be called "once for each of five sections", and `title` is already nullable, so leaving it `null` honours that without a sixth paid call [confidence: high] [anchor: user: "calling the model API once for each of five sections"]
- [ ] When one section still fails after the final attempt, keep the four good sections (`partial`) or fail the whole report? A redirect to all-or-nothing changes Task 5's final-attempt branch and Story 2's third criterion.
  - **Stakes:** user — all-or-nothing hides four paid, finished sections from the reader
  - **Recommended:** keep them and mark the report `partial` — throwing away four paid results to recover one wastes spend, and the reader can still see which section failed [confidence: medium] [anchor: weighing: risk — a partial report is visible and recoverable, an all-or-nothing failure discards paid work]
- [ ] How should `POST /reports` be authenticated? A redirect swaps Task 6's bearer-key check for IAM (whole service private) or another scheme.
  - **Stakes:** both — no auth lets anyone on the internet spend model budget (cost); making the whole service private would break existing callers of the read and share routes (user experience)
  - **Recommended:** a single bearer API key from Secret Manager on `POST /reports` only — it closes the paid path without changing the existing public read and share routes [confidence: medium] [anchor: weighing: risk — the only route that spends money is gated; existing routes are left as they are]
- [ ] How is the worker protected? A redirect to in-handler OIDC verification removes the second Cloud Run service from Task 7 and adds a token-verification dependency to Task 5.
  - **Stakes:** system — a worker reachable from the public service would let anyone trigger paid generation and bypass the cap
  - **Recommended:** a second Cloud Run service from the same image, deployed `--no-allow-unauthenticated`, invokable only by the queue's service account — IAM enforces it with no token code in the app [confidence: medium] [anchor: weighing: footprint — zero auth code in the app versus a new verification dependency]
- [ ] Which durable store? A redirect to Cloud SQL rewrites Task 3 and adds an instance, connection handling and migrations to Task 7.
  - **Stakes:** system — the store sets ongoing cost and operational load
  - **Recommended:** Firestore (native mode) — the existing data model is one document per report id, which maps one-to-one onto a Firestore document, with no always-on instance to pay for [confidence: medium] [anchor: weighing: footprint — `Map<string, Report>` maps directly to a document collection]
- [ ] Should sharing an unfinished report be refused? A redirect removes the `409` branch from Task 6.
  - **Stakes:** user — a shared link to a report that is still `queued` shows the recipient an empty report
  - **Recommended:** refuse with `409` until `done` — no report can be unfinished today, so this breaks no current caller [confidence: medium] [anchor: weighing: risk — new restriction on a state that does not exist yet]
- [x] Run the five section calls in parallel or one after another?
  - **Stakes:** none — resolved without asking: parallel (p99 ~60 s versus ~300 s), with the same five calls and the same cost either way

## Decision analysis

**Decision 1 — How does one request turn into five 20–60 s paid calls?**

- **Branch A, inline (the literal request).**
  - Walkthrough: the caller sends `POST /reports` and waits with the connection open while all five calls run. That's ~60 s in parallel, or up to ~300 s sequentially, which is right at Cloud Run's 300 s kill. Then it receives `201` with the report.
  - Friction: 0 human interruptions per run, plus 1 blocking wait of 60–300 s.
  - Failure modes: a client timeout, disconnect or deploy discards paid sections, and a client retry pays for all five again.
  - Even this branch still needs the durable store and the cap.
- **Branch B, 202 plus one queued task per report with per-section checkpoints (recommended).**
  - Walkthrough: the caller sends `POST /reports` and gets `202` plus an id in ~1 s. It then polls `GET /reports/<id>` (for example every 5 s, about 14 polls) until `done`, typically 20–70 s later.
  - Friction: 0 human interruptions per run, 0 blocking waits over 1 s, and 1 polling loop in the caller.
  - A failed section is retried alone by the queue.
- **Branch C, 202 plus one queued task per section, with a finalize step.**
  - The caller's experience is the same as B.
  - On the system side: 5 tasks per report, status derived from children, and a guarded finalize step so two finishers can't both assemble the report.
  - Friction: identical to B.

**Exclusivity:**

- A versus B or C: mutually exclusive, because the response contract differs (`201` with the report versus `202` with an id).
- B versus C: mutually exclusive queue shapes.
- The durable store, the daily cap and the model-client timeout complement every branch.

**Ranked combinations:**

1. B, durable store, cap, timeout.
2. C, durable store, cap, timeout.
3. A with parallel calls, durable store, cap, timeout, and a raised request timeout.
4. A as literally asked, with in-memory store and no cap. Not viable: reports vanish across instances.

Verdict: **Branch B** — fixed five sections fit one 300 s attempt, so per-section tasks add a fan-in step without changing cost or retry behaviour, while inline generation loses paid work on any disconnect [confidence: medium] [anchor: weighing: footprint — one task and one checkpoint loop versus five tasks plus a guarded finalize]

## Alternatives considered

- **Generate in a detached promise after returning `202`** — rejected: Cloud Run request-based billing throttles CPU after the response (https://docs.cloud.google.com/run/docs/configuring/billing-settings), and a SIGTERM gives only 10 s, so paid work would be frozen or lost.
- **Pub/Sub instead of Cloud Tasks** — rejected: there is exactly one worker per unit, and Cloud Tasks gives named-task dedupe plus `maxConcurrentDispatches` and rate caps that Pub/Sub push does not (https://docs.cloud.google.com/tasks/docs/configuring-queues).
- **Keep the in-memory `Map` store** — rejected: the worker runs in a different request, often on a different instance, so it could never read the report the `POST` wrote (src/db.ts:9).

## Recommendation

**Reconsider scope** — build `POST /reports`, but as `202` plus one queued generation task over a durable store, behind an API key and a daily cap, rather than five paid calls inside the request (Decision 1). This bundles a rewrite of the in-memory store and simplifications of the handler wiring, model client and Dockerfile, all prerequisites. [confidence: high] [anchor: src/llm.ts:1]

**Redundancy:** none found — no route creates reports today; `saveReport` is called only by the share route (src/app.ts:20) and the model client is never called.

## Plan risks

The weakest assumption is that whoever calls `POST /reports` can poll: if the real caller is a script or UI built to expect the finished report in the response body, the `202` contract breaks it, and the plan would need Decision 1's rank-3 inline fallback.

## Cut list

- **Per-section Cloud Tasks fan-out with a finalize step.** It is the system-design default for multi-section work, but with a fixed five sections it adds a fan-in race guard and four extra tasks per report for no cost or latency gain.
- **A streaming (SSE) progress channel.** Polling a status that changes three times in about a minute serves the caller just as well.
- **Caller-supplied section lists.** They would need a cardinality cap and prompt validation per section, and nobody has asked for them.

# Task breakdown

### Task 1: Metrics helper and metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create the repo-local metrics helper with a zero-dependency in-memory recorder.
  - The helper defines a closed `ErrorType` union (`_OTHER`, `internal`, `invalid_input`, `not_found`, `rate_limited`, `unauthorized`, `upstream_error`, `upstream_timeout`) and typed attributes per instrument (`operation.outcome`, `error.type`, `server.address`).
  - Create `.flow/metrics.md` with these sections, filled from the plan's Instrumentation section:
    - `## Backend`: `none yet — suggested: Google Cloud Monitoring via OTLP`
    - `## Namespace`: `reports`
    - `## Attributes` and `## error.type values`
    - `## Helper`: `src/metrics.ts`
    - `## Dashboard panels`, `## Dashboards` (none yet), `## Alerts` (burn-rate tiers), `## As-code` (`spec-only`)
    - `## SLOs`: "generate a company report"
    - `## Coverage`: `reports.create`, `reports.generate`, `reports.llm`
- **Inputs:** new: src/metrics.ts
- **Outputs:** Helper the later tasks call; committed metrics contract.
- **Contract:**
  - **Files:** create `src/metrics.ts`, `src/metrics.test.ts`, `.flow/metrics.md`
  - **Interfaces:**
    - `export type ErrorType = "_OTHER" | "internal" | "invalid_input" | "not_found" | "rate_limited" | "unauthorized" | "upstream_error" | "upstream_timeout"`
    - `export type Operation = "reports.create" | "reports.generate" | "reports.llm"`
    - `export interface Recorder { observe(name: string, seconds: number, attrs: Record<string, string>): void; increment(name: string, attrs: Record<string, string>): void }`
    - `export function createMemoryRecorder(): Recorder & { observations: Array<{ name: string; seconds: number; attrs: Record<string, string> }>; increments: Array<{ name: string; attrs: Record<string, string> }> }`
    - `export function setRecorder(r: Recorder): void`
    - `export async function instrument<T>(op: Exclude<Operation, "reports.create">, fn: () => Promise<T>, opts?: { serverAddress?: "api.example-llm.com"; classify?: (e: unknown) => ErrorType }): Promise<T>` — records `<op>.duration` with `operation.outcome`, and `<op>.failures` with `error.type` on throw, then rethrows
    - `export function recordFailure(op: Operation, errorType: ErrorType): void`
    - `export function toErrorType(value: string): ErrorType` — falls back to `_OTHER`
  - **Call-site edits:** none (first task)
- **Acceptance criteria:** `bun test src/metrics.test.ts && grep -q '## Coverage' .flow/metrics.md` — success, failure-per-`error.type`, and unlisted-value→`_OTHER` specs pass against the in-memory recorder

### Task 2: Harden the model client

- **Skill:** `flow-system-design`
- **Bundled:** the missing timeout and unchecked HTTP status in the existing model client, which were surfaced during discovery
- **Description:** Give both model calls an explicit timeout via `AbortSignal.timeout`: 90 s for `generateSection`, 10 s for `suggestTitle`. Throw a typed `LlmError` on a non-2xx response, a timeout, or a missing `text`/`title` field. Wrap `generateSection` in `instrument("reports.llm", …, { serverAddress: "api.example-llm.com" })`, mapping timeouts to `upstream_timeout` and everything else to `upstream_error`. Add no retries here: the queue is the only retry layer.
- **Inputs:** Task 1's `src/metrics.ts`
- **Outputs:** A model client the worker can bound and classify.
- **Contract:**
  - **Files:** edit `src/llm.ts`; create `src/llm.test.ts`
  - **Interfaces:**
    - `export class LlmError extends Error { constructor(readonly kind: "timeout" | "upstream" | "bad_response", message: string) }`
    - `export async function generateSection(company: string, section: string, opts?: { timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<string>`
    - `export async function suggestTitle(sections: string[], opts?: { timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<string>`
  - **Call-site edits:** none (no current callers)
- **Acceptance criteria:** `bun test src/llm.test.ts` — the 2xx, non-2xx→`upstream`, timeout→`timeout` (using a never-resolving stub fetch and a 50 ms timeout) and missing-field→`bad_response` specs pass, and one `reports.llm.duration` observation is recorded per call

### Task 3: Durable report store

- **Skill:** `flow-system-design`
- **Description:** Rewrite `src/db.ts` behind a `ReportStore` interface, with a Firestore implementation and an in-memory implementation that tests use.
  - **`createReport`** runs one transaction that:
    1. reads `budgets/<YYYY-MM-DD>` and refuses with `cap_reached` when `reports >= dailyCap`;
    2. looks up `idempotency/<sha256(key)>` when a key is given, returning `existing` for the same company or `key_conflict` for a different one;
    3. writes the report (`status: "queued"`, all five `sectionResults` pending), the budget increment and the idempotency doc.
  - **`saveSectionResult`** updates only that section's field, so parallel writers can't clobber each other.
  - Keep `getReport` and `saveReport`, now async.
  - Add `@google-cloud/firestore` to `package.json` `dependencies`.
- **Inputs:** none in-repo beyond the current `src/db.ts`. new: src/sections.ts (the `REPORT_SECTIONS` constant with the Q1 placeholder list)
- **Outputs:** Durable store that the handlers and worker share.
- **Contract:**
  - **Files:** edit `src/db.ts`, `src/app.ts`, `package.json`; create `src/sections.ts`, `src/db.test.ts`
  - **Interfaces:**
    - `src/sections.ts`:
      - `export const REPORT_SECTIONS = ["Overview", "Products and Services", "Market and Competition", "Financial Highlights", "Risks and Outlook"] as const`
      - `export type SectionName = (typeof REPORT_SECTIONS)[number]`
    - `src/db.ts` types:
      - `export type ReportStatus = "queued" | "running" | "done" | "partial" | "failed"`
      - `export type SectionResult = { status: "pending" | "done" | "failed"; text: string | null; error: ErrorType | null }`
      - `export type Report = { id: string; company: string; status: ReportStatus; sections: string[]; sectionResults: Record<SectionName, SectionResult>; title: string | null; shared: boolean; createdAt: string }` — `sections` holds the five texts in `REPORT_SECTIONS` order once `done`, otherwise `[]`
      - `export type CreateResult = { kind: "created" | "existing"; report: Report } | { kind: "cap_reached" } | { kind: "key_conflict" }`
    - `src/db.ts` store:
      - `export interface ReportStore { getReport(id: string): Promise<Report | undefined>; saveReport(report: Report): Promise<void>; createReport(input: { company: string; idempotencyKey: string | null; day: string; dailyCap: number }): Promise<CreateResult>; saveSectionResult(id: string, section: SectionName, result: SectionResult): Promise<void>; setStatus(id: string, status: ReportStatus, sections?: string[]): Promise<void> }`
      - `export function createMemoryStore(): ReportStore`
      - `export function createFirestoreStore(db?: Firestore): ReportStore`
  - **Call-site edits:** `src/app.ts` `handle` — `await` the now-async `getReport` and `saveReport` in the existing GET and share branches, reading from a `createFirestoreStore()` instance (Task 6 replaces this with injection)
- **Acceptance criteria:** `bun test src/db.test.ts` — the memory-store specs pass: created, existing (same key and company), key_conflict, cap_reached at `dailyCap`, a per-section write leaving other sections intact, and setStatus; `grep -q '"@google-cloud/firestore"' package.json`

### Task 4: Report generation queue client

- **Skill:** `flow-system-design`
- **Description:** Add a queue client that creates one named Cloud Tasks HTTP task per report.
  - Task name: `report-<reportId>`, so a re-enqueue is deduplicated.
  - Body: `{ reportId }`.
  - HTTP target: the worker URL with an OIDC token for the queue's service account, audience equal to the worker URL.
  - `dispatchDeadline` of 300 s.
  - An `ALREADY_EXISTS` error counts as success, and every call has a 2 s timeout.
  - Add `@google-cloud/tasks` to `dependencies`.
  - Provide a recording fake for tests.
- **Inputs:** new: src/queue.ts
- **Outputs:** A `ReportQueue` the `POST` handler calls after commit.
- **Contract:**
  - **Files:** create `src/queue.ts`, `src/queue.test.ts`; edit `package.json`
  - **Interfaces:**
    - `export interface ReportQueue { enqueueGeneration(reportId: string): Promise<void> }`
    - `export function createCloudTasksQueue(cfg: { project: string; location: string; queue: string; workerUrl: string; serviceAccountEmail: string; client?: CloudTasksClient }): ReportQueue`
    - `export function createRecordingQueue(): ReportQueue & { enqueued: string[] }`
    - `export function taskName(cfg: { project: string; location: string; queue: string }, reportId: string): string`
  - **Call-site edits:** none (consumed in Task 6)
- **Acceptance criteria:** `bun test src/queue.test.ts` — with a stubbed `CloudTasksClient`, the specs assert the task name `…/tasks/report-<id>`, `dispatchDeadline.seconds === 300`, the OIDC `serviceAccountEmail` and audience, and that `ALREADY_EXISTS` resolves without throwing; `grep -q '"@google-cloud/tasks"' package.json`

### Task 5: Report generation worker

- **Skill:** `flow-system-design`
- **Description:** Implement the worker, keyed on idempotency key `report-<reportId>` and per-section checkpoint `<reportId>:<section>`, under a 240 s internal deadline. It answers `POST /tasks/generate-report` with body `{ reportId }`.
  1. Load the report. A missing report is `not_found` and returns `200` so it is not retried. A report already `done`, `partial` or `failed` is a no-op returning `200`.
  2. Set the status to `running`.
  3. Call `generateSection` with `Promise.allSettled` for every section that has no stored `done` result, saving each result as soon as it settles.
  4. If all five are done, call `setStatus("done", texts in REPORT_SECTIONS order)` and return `200`.
  5. If any failed and this is not the final attempt (read from `X-CloudTasks-TaskRetryCount` against `MAX_ATTEMPTS=3`), return `503` so Cloud Tasks retries.
  6. On the final attempt, mark the failed sections and set `partial` (some done) or `failed` (none done), returning `200`.
  7. Wrap the run in `instrument("reports.generate", …)`.
- **Inputs:** Task 2's `src/llm.ts`, Task 3's `src/db.ts` and `src/sections.ts`, Task 1's `src/metrics.ts`
- **Outputs:** The worker request handler mounted when `SERVICE_ROLE=worker`.
- **Contract:**
  - **Files:** create `src/worker.ts`, `src/worker.test.ts`
  - **Interfaces:**
    - `export type WorkerDeps = { store: ReportStore; generate: (company: string, section: string) => Promise<string>; maxAttempts: number; deadlineMs: number }`
    - `export type RunOutcome = "done" | "retry" | "partial" | "failed" | "noop" | "not_found"`
    - `export async function runReportGeneration(reportId: string, retryCount: number, deps: WorkerDeps): Promise<RunOutcome>`
    - `export function createWorkerHandler(deps: WorkerDeps): (req: Request) => Promise<Response>` — `retry` maps to `503`, everything else to `200`
  - **Call-site edits:** none (mounted in Task 6)
- **Acceptance criteria:** `bun test src/worker.test.ts` — the specs pass with a memory store and a counting stub `generate`:
  - All succeed: 5 calls and status `done`.
  - One fails on retryCount 0: `503`, 4 stored, and the redelivery makes 1 call.
  - Final-attempt failure: `partial`, with `error.type` on the failed section.
  - Redelivery of a `done` report: 0 calls.
  - The idempotency key `report-<reportId>` and the 240 s deadline are asserted.

### Task 6: Public `POST /reports` and extended read and share routes

- **Skill:** `flow-system-design`
- **Description:** Replace the module-level `handle` with `createApp(deps)`.
  - Add `POST /reports`, in this order:
    1. Check the bearer key in constant time; on failure return `401` and record `unauthorized`.
    2. Parse `{ company }`: trim it, strip control characters, require 1–200 characters; otherwise return `400` and record `invalid_input`.
    3. Call `store.createReport` with the optional `Idempotency-Key` header and today's UTC day.
    4. Map the result: `cap_reached` → `429` with `Retry-After` set to the seconds until UTC midnight, recording `rate_limited`; `key_conflict` → `422`; `existing` → `202` with the same id and no enqueue.
    5. On `created`, call `queue.enqueueGeneration`. If that throws, set the report `failed`, record `upstream_error` and return `503`.
    6. Return `202 { id, status }` with `Location: /reports/<id>`.
  - `GET /reports/:id` returns the extended report.
  - `POST /reports/:id/share` returns `409` unless `status === "done"`.
  - The entry point wires the Firestore store, the Cloud Tasks queue and env config. It mounts `createWorkerHandler` instead of `createApp` when `SERVICE_ROLE=worker`.
- **Inputs:** Task 3's `src/db.ts`, Task 4's `src/queue.ts`, Task 5's `src/worker.ts`, Task 1's `src/metrics.ts`
- **Outputs:** The public API surface described in the stories.
- **Contract:**
  - **Files:** edit `src/app.ts`; create `src/app.test.ts`
  - **Interfaces:**
    - `export type AppDeps = { store: ReportStore; queue: ReportQueue; apiKey: string; dailyCap: number; now?: () => Date }`
    - `export function createApp(deps: AppDeps): (req: Request) => Promise<Response>`
    - Env read at the entry point only: `SERVICE_ROLE` (`api` | `worker`), `REPORTS_API_KEY`, `REPORTS_DAILY_CAP`, `GCP_PROJECT`, `TASKS_LOCATION`, `TASKS_QUEUE`, `WORKER_URL`, `TASKS_SERVICE_ACCOUNT`, `MAX_ATTEMPTS`
  - **Call-site edits:** `src/app.ts` — the `import.meta.main` block switches from `Bun.serve({ fetch: handle })` to `Bun.serve({ fetch: SERVICE_ROLE === "worker" ? createWorkerHandler(…) : createApp(…) })`; the exported `handle` is removed (no other importers)
- **Acceptance criteria:** `bun test src/app.test.ts` — every Story 1 and Story 3 criterion passes against `createMemoryStore()` plus `createRecordingQueue()`, including the end-to-end create → `runReportGeneration` → `GET` spec ending `done` with five sections; `reports.create.failures` increments carry the exact `error.type` per branch

### Task 7: Deploy the queue, worker service and datastore

- **Skill:** `flow-system-design`
- **Description:** Change two files. **`Dockerfile`:** copy `bun.lock` (if present) and run `bun install --production` before copying `src`. **`deploy.sh`:**
  - **Firestore.** Create the database idempotently: `gcloud firestore databases create --location=us-central1` plus `gcloud firestore databases update --enable-pitr`.
  - **Queue.** Create or update the Cloud Tasks queue `report-generation` with `--max-attempts=3 --min-backoff=10s --max-backoff=120s --max-concurrent-dispatches=2`. The per-task dispatch deadline of 300 s is set by Task 4's client and must stay above the worker's 240 s deadline.
  - **Worker service.** Deploy `reports-worker` from the same source with `--no-allow-unauthenticated --set-env-vars=SERVICE_ROLE=worker,MAX_ATTEMPTS=3 --timeout=300 --max-instances=2 --concurrency=5`.
  - **Invoker grant.** Give the queue's service account `roles/run.invoker` on `reports-worker`.
  - **Public service.** Keep `reports-service` `--allow-unauthenticated` and add `--max-instances=4`. Set `SERVICE_ROLE=api`, `REPORTS_DAILY_CAP=50` (Q2 placeholder), `TASKS_LOCATION`, `TASKS_QUEUE`, `WORKER_URL` and `TASKS_SERVICE_ACCOUNT`, and mount `REPORTS_API_KEY` from Secret Manager via `--set-secrets`.
  - **Enqueue permissions.** Grant the public service's identity `roles/cloudtasks.enqueuer` and `roles/iam.serviceAccountUser` on the tasks service account.
  - **Check at implement time.** Each flag against `gcloud … --help`, deviations recorded.
- **Inputs:** Task 4's `src/queue.ts` (task-level dispatch deadline), Task 6's `src/app.ts` (env names)
- **Outputs:** A deploy script that provisions everything the runtime design names.
- **Contract:** _(config/infra change type — exact file + key + before → after)_
  - **Files:** edit `deploy.sh`, `Dockerfile`
  - **Interfaces:**
    - `Dockerfile`: no install step → `RUN bun install --production` after `COPY package.json ./`
    - `deploy.sh`: single public deploy → Firestore (PITR on), the queue (max attempts 3, backoff 10–120 s, max concurrent dispatches 2), private `reports-worker`, the invoker binding, and the public deploy with secrets, env and `--max-instances`
  - **Call-site edits:** none
- **Acceptance criteria:** `bash -n deploy.sh && grep -q -- '--max-attempts=3' deploy.sh && grep -q -- '--no-allow-unauthenticated' deploy.sh && grep -q -- '--enable-pitr' deploy.sh && grep -q 'roles/run.invoker' deploy.sh && grep -q 'bun install' Dockerfile`

| Task | Depends on |
| ---- | ---------- |
| 1    | —          |
| 2    | 1          |
| 3    | 1          |
| 4    | —          |
| 5    | 1, 2, 3    |
| 6    | 1, 3, 4, 5 |
| 7    | 4, 6       |

### Skills Summary

| Skill                | Recommended?       | Reason                                                                                  |
| -------------------- | ------------------ | --------------------------------------------------------------------------------------- |
| `flow-system-design` | Yes (Tasks 2–7)    | Queued paid work, timeouts, single retry layer, idempotency, spend cap, Cloud Run/Tasks |
| `flow-metrics`       | Yes (Task 1)       | First instrumented change; creates the helper and `.flow/metrics.md`                    |
| `flow-testing`       | No (folded in)     | Each task owns its `bun test` file so every task leaves the repo verify-green           |
| `flow-refactoring`   | No                 | The `createApp(deps)` change is a prerequisite inside Task 6, not a standalone refactor |
| `flow-ui-ux`         | No                 | No UI surface                                                                           |
| `flow-verify`        | No (implicit)      | Runs as the pipeline's verify phase                                                     |

# PR description draft

## TLDR

You can now create a company report with one authenticated request that answers immediately and finishes about a minute later; before, the service could read and share reports but had no way to make one.

## User-facing changes

- New endpoint: sending a company name to `POST /reports` with the service API key answers `202` in about a second, with the new report's id and a link to check on it.
- Checking a report with `GET /reports/<id>` now shows its progress:
  - **Before:** a report had only its text, title and shared flag.
  - **After:** the report also shows whether it is queued, running, done, partially done or failed, and the state of each of its five sections.
- A finished report contains five sections, each written by one model call.
- Re-sending a creation request with the same `Idempotency-Key` returns the same report instead of paying for a new one.
- Creation is refused with a clear status when the API key is missing (`401`), the company name is empty or too long (`400`), or the day's report limit is reached (`429`, with a retry-after time).
- Sharing a report now waits until it is finished:
  - **Before:** any stored report could be shared.
  - **After:** sharing a report that is not done yet is refused with `409`.
- Reports now survive restarts and are visible from every server instance:
  - **Before:** a report could vanish on restart or be missing on another instance.
  - **After:** reports are kept in a durable database.

## System changes

- Report generation moved out of the request:
  - **Before:** no generation existed, and reports lived in one process's memory.
  - **After:** each report is one queued background task, run by a private worker that only the queue can call. The five sections are written in parallel, each saved as it finishes, and a retry re-runs only unfinished sections.
- Model spend is now bounded at one point. Each report costs 5 paid generation calls, 15 at most with retries, and a daily report limit (placeholder 50 per day) caps the total. Ongoing cost goes from zero, since nothing called the model before, to at most 750 generation calls per day at the placeholder limit.
- New cloud resources with ongoing cost: a Firestore database with point-in-time recovery, a Cloud Tasks queue, and a second Cloud Run service. All are capped at a few instances.
- Every model call now has a 90-second timeout and fails visibly on an error response instead of returning an empty section.

## Why

The service is meant to produce company reports, but nothing could create one. Writing a report takes five model calls of 20 to 60 seconds each, and every call costs money. If the caller has to wait while all five run, a dropped connection or a deploy throws away paid work. And because the service is public, anyone could run up the bill.

## Key decisions

- **Queued generation instead of an in-request response.** The endpoint answers `202` and the caller polls, rather than holding the connection for one to five minutes. The alternative it beat, generating inside the request, loses paid work on any disconnect and runs into the platform's 5-minute request limit.
- **One background task per report, not one per section.** Five fixed sections fit one task attempt, and saving each section as it finishes gives the same "never pay twice for a finished section" guarantee without a fan-in step.
- **Partial reports are kept.** If one section still fails after three attempts, the reader sees the four finished sections and which one failed, rather than losing all five paid results.
- **No title call.** The request asked for one model call per section, so titles stay empty. A title would cost a sixth call per report.
- **API key on creation only.** The only route that spends money now needs a key. The existing read and share routes are unchanged.
- **Firestore over Cloud SQL.** A report is one document per id, and Firestore has no always-on instance to pay for.
- Bundled: the missing timeout and unchecked HTTP status in the existing model client, which were surfaced during discovery.
- Out of scope: caller-chosen section lists, live streaming of progress, auth on the read and share routes, and choosing a metrics backend.

## Instrumentation

These metrics are new. Graphs need a metrics backend, which hasn't been chosen yet: the suggestion is Google Cloud Monitoring, and the status is in the repo's metrics contract under `## Backend`. Until a backend is chosen, the metrics are recorded but appear on no graph. The dashboard is spec-only.

- **Panels** on a new "reports-service overview" dashboard:
  - Report generation: request rate, success vs failure and latency p50 / p95 / p99.
  - Failures by error type for report creation and report generation.
  - Model-call latency p50 / p95 / p99.
  - Queue depth (platform-native).
- **New journey SLO**, "generate a company report", over 30 days: 99% of generation attempts succeed (client-caused errors excluded) and 95% finish under 120 seconds. It uses the standard burn-rate alert tiers.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/metrics.test.ts` — success, per-error-type failure and fallback specs pass.
- [ ] Run `bun test src/llm.test.ts` — the timeout, non-2xx and missing-field specs pass.
- [ ] Run `bun test src/db.test.ts` — the created, idempotent-repeat, key-conflict, daily-cap and per-section-write specs pass.
- [ ] Run `bun test src/queue.test.ts` — the named-task, 300 s dispatch-deadline, OIDC and already-exists specs pass.
- [ ] Run `bun test src/worker.test.ts` — the five-calls-on-success, retry-only-failed-section, partial-on-final-attempt and no-op-on-redelivery specs pass.
- [ ] Run `bun test src/app.test.ts` — the 202, 401, 400, 429, 422, 409 and end-to-end create-run-read specs pass.
- [ ] Run `bash -n deploy.sh && grep -q -- '--max-attempts=3' deploy.sh && grep -q -- '--no-allow-unauthenticated' deploy.sh && grep -q -- '--enable-pitr' deploy.sh` — the deploy script parses and provisions the queue limits, private worker and recovery.
- [ ] Run `docker build -q -t reports-service:plan-check .` — the image builds with its dependencies installed.
- [ ] Run `test -f .flow/metrics.md && grep -q 'reports.generate.duration' .flow/metrics.md` — the metrics contract exists and lists the generation metric.
- [ ] DECISION: accept that `POST /reports` answers `202` with a report id to poll, instead of returning the finished report in the response, in exchange for never losing paid sections to a dropped connection.
