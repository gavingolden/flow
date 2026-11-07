# PRD

# Company report generation (`POST /reports`)

**Goal:** A caller can request a five-section company report and get its id back right away, then read the finished sections as they complete, with daily model spend capped.

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

## Problem Statement

This service exists to hand out company reports, but today it can only look up a report that already exists — nothing in the service can create one. Producing a report means asking a paid AI model to write five sections, and each request takes 20 to 60 seconds. Done the obvious way, inside one web request, a caller would wait two to five minutes, and the request would be cut off after 29 seconds, so the caller would pay for model calls and receive nothing. The cost of getting this wrong is paid model calls that produce nothing, plus callers who retry and pay again.

Evidence:

| Fact | What it means | Anchor |
| --- | --- | --- |
| No code path writes a report; the only writer is unused | Report creation is genuinely missing (no duplication) | [anchor: src/db.ts:11] |
| Each model call takes 20–60 s and is billed per call | Five calls in a row take 100–300 s; even five in parallel take up to 60 s | [anchor: src/llm.ts:1] |
| Every function times out at 29 s, the same as the API Gateway REST integration ceiling | A request that waits on the model is killed before it finishes | [anchor: template.yaml:6] |
| The model client has no timeout and never checks the response status | A hung or failed call blocks or produces a missing section with no visible error | [anchor: src/llm.ts:3] |
| The read endpoint as deployed has no table name and no table read permission | Polling for the result would fail even after the report exists | [anchor: template.yaml:14] |
| No TypeScript compiler, test runner or tsconfig is installed, although `npm test` and `npm run build` call them | Nothing in this plan can be built or tested until the tooling exists | [anchor: package.json:7] |

The priorities this serves, from the product brief: **user experience** (the caller gets an immediate answer and never waits on a request that is going to die), **cost** (no paid call is thrown away, and a daily ceiling stops a runaway bill), then **architecture** (generation survives retries and redeploys).

## Request vetting

- **Hypothesis:** five model calls of 20–60 s each can back a `POST /reports` endpoint only if the endpoint answers within seconds and the calls run in a queued worker, with the caller reading the result from the existing read endpoint.
- **Case against:** the literal reading — one request that calls the model five times and returns the report — cannot finish: 100–300 s of calls against a 29 s function and gateway ceiling [anchor: template.yaml:6] [anchor: src/llm.ts:1]. Even raising the gateway limit leaves a caller blocked for up to five minutes, and a dropped connection loses work that was already paid for.
- **Sources:** https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html ; https://www.nngroup.com/articles/response-times-3-important-limits/
- **Verdict:** adopt-with-conditions: POST /reports returns 202 with a status link in under 1 s and makes no model call itself (asserted by a handler test whose model client mock records zero calls); the five section calls run in a queued worker, one task per section.

## Existing-code assessment

- **src/llm.ts:** simplify — add a 75 s timeout, a status check and typed, retry-classified errors before the worker depends on it; the request shape stays as-is [anchor: src/llm.ts:3]
- **src/db.ts:** simplify — replace the unused, unconditional `saveReport` overwrite with conditional report state changes and give the client a request timeout [anchor: src/db.ts:11]
- **src/handlers/getReport.ts:** simplify — fix the extensionless ESM import, hide internal bookkeeping fields, and report past-deadline jobs as failed so polling always ends [anchor: src/handlers/getReport.ts:2]
- **template.yaml:** simplify — the read function lacks its table env var and read policy; add those alongside the new queue, ledger table and two functions [anchor: template.yaml:14]
- **package.json:** simplify — the declared `test` and `build` scripts call tools that are not installed [anchor: package.json:7]

## Scope Boundary

**In scope:**

- `POST /reports` with body `{"company": "<name>"}`: validates, reserves model spend, stores a queued report, queues one task per section, answers `202` with `Location: /reports/{id}`.
- Optional `Idempotency-Key` header: a repeat with the same key and body returns the same report instead of paying again; the same key with a different body is rejected.
- A worker that writes one section per task, retries transient model failures at the queue layer only, and marks a section failed (never silently dropped).
- Partial results: a report whose sections all finished reads `done`; one where some failed reads `partial` with the successful sections kept.
- A daily model-call ceiling enforced at one point (report creation), answering `429` with `Retry-After` when reached.
- `GET /reports/{id}` working as deployed, showing per-section status, and ending any job past its 15-minute deadline as `failed`.
- Build and test tooling so `npm test` and `npm run build` run.
- Metrics spec and a repo-local metrics helper (`.flow/metrics.md` created).

**Out of scope:**

- Caller authentication on either endpoint — tracked as a follow-up (see `# Candidate follow-up issues`); the spend ceiling bounds cost in the meantime.
- Re-running a single failed section; the caller re-requests the report.
- Streaming sections as they are written (polling is enough for a minutes-long job).
- Choosing a metrics backend, dashboards or alert config as code.
- Model-API authentication: the existing client sends no credential header; this plan keeps the request shape as-is [anchor: src/llm.ts:3].
- Listing reports, deleting reports, caller-chosen sections.

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| There is no way to request a report; a caller can only read one by id, and that read fails as deployed | `POST /reports {"company": "Acme"}` answers in under a second with `202`, the report id and a status link |
| — | Polling `GET /reports/{id}` shows `queued` → `running` → `done` (or `partial` / `failed`), with each section's text appearing as it finishes |
| — | A network retry carrying the same `Idempotency-Key` returns the same report and costs nothing extra |
| — | Once the daily ceiling is reached, new requests get `429` with the seconds until it resets |

### System flow

- **Before:**
  - The API has one read function; nothing writes reports and no model call is ever made.
- **After:**
  - Report creation writes one report row, reserves five model calls in a daily spend ledger and sends five queue messages.
  - A worker takes one section per message, claims it with a lease, calls the model once (75 s timeout), and writes the section; the last section to finish sets the report's final status.
  - A failing section is retried by the queue up to three attempts in total, then marked failed; messages that crash the worker land in a dead-letter queue.
  - Model spend per report is 5 calls normally and at most 15 (three attempts each); every retry is recorded against the daily ledger.

**Lost:** the unused `saveReport` helper is removed (no caller exists).

## User Stories / Acceptance Criteria

### Story 1: Request a report without waiting

- [ ] Given a valid body `{"company": "Acme"}`, when `POST /reports` runs, then it returns `202`, a `Location: /reports/<id>` header and `{"id","status":"queued"}`, and the model client mock records zero calls — `npx vitest run src/handlers/createReport.test.ts`
- [ ] Given a missing, empty or over-200-character `company`, when `POST /reports` runs, then it returns `400` with `error: "invalid_input"` and nothing is stored or queued — same test file
- [ ] Given a repeat with the same `Idempotency-Key` and body, when `POST /reports` runs, then it returns the original id with no second spend reservation; with a different body it returns `422` — same test file

### Story 2: Sections are generated once each, and failures are visible

- [ ] Given a queued section task, when the worker runs and the model succeeds, then the section text is stored and its status becomes `done` — `npx vitest run src/handlers/generateSection.test.ts`
- [ ] Given a section that is already `done`, when its task is delivered again, then the model is not called — same test file
- [ ] Given a transient model failure on attempt 1 or 2, when the worker runs, then it throws so the queue retries; on attempt 3, or on a permanent failure, it marks the section `failed` and does not throw — same test file
- [ ] Given the fifth section finishing with one earlier failure, when the worker finalizes, then the report status is `partial` and exactly one finalizer wins — same test file

### Story 3: Spend is capped per day

- [ ] Given the daily ledger has fewer than 5 calls left, when `POST /reports` runs, then it returns `429` with a `Retry-After` header equal to the seconds until UTC midnight — `npx vitest run src/ledger.test.ts src/handlers/createReport.test.ts`

### Story 4: Polling always ends

- [ ] Given a report still `running` 15 minutes after creation, when `GET /reports/{id}` runs, then it shows `status: "failed"` and the unfinished sections as `failed` with `error: "expired"` — `npx vitest run src/handlers/getReport.test.ts`
- [ ] Given any report, when `GET /reports/{id}` runs, then internal fields (`requestHash`, `claims`) are absent from the body — same test file
- [ ] Given the deployed template, when it is linted, then the read function has its table env var and read policy — `sam validate --lint && grep -A12 'GetReportFunction:' template.yaml | grep -q DynamoDBReadPolicy`

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| API Gateway `Latency`, `Count`, `4XXError`, `5XXError` | Histogram-like (native) | ms | stage, method, resource | platform-native (API Gateway CloudWatch metrics) |
| `reports.create.failures` | Counter | none | `error.type` (closed list below) | report creation handler |
| `reports.section.duration` | Histogram, bounds `[1, 5, 10, 20, 30, 45, 60, 75, 90]` | s | `operation.outcome` (`ok`, `error`) | section worker |
| `reports.section.failures` | Counter | none | `error.type` | section worker |
| `reports.llm.call.duration` | Histogram, same bounds | s | `server.address` (`api.example-llm.com`), `operation.outcome` | model client call site in the worker |
| `reports.report.duration` | Histogram, bounds `[60, 120, 180, 300, 450, 600, 900]` | s | `operation.outcome` (`partial`/`failed` count as `error`) | worker, once, by the finalizer that wins |
| SQS `ApproximateNumberOfMessagesVisible`, `ApproximateAgeOfOldestMessage` (main queue and dead-letter queue) | Gauge (native) | `{message}`, s | queue name | platform-native (SQS CloudWatch metrics) |
| Lambda `ConcurrentExecutions`, `Errors`, `Throttles` | native | — | function name | platform-native (Lambda CloudWatch metrics) |

Estimated series: 10 per operation (report creation: failures counter only; request latency is platform-native)
Estimated series: 58 per operation (section generation: 2 × (9 + 3) = 24 duration, 10 failures, 24 outbound-call duration)
Estimated series: 20 per operation (whole report: 2 × (7 + 3))

**Attributes:** reuses registered starter keys `operation.outcome`, `error.type`, `server.address` (closed host list: `api.example-llm.com`) and `messaging.destination.name` (queue names from the template), seeded as the first rows of `.flow/metrics.md` `## Attributes`.

### Error types

Starter list (`_OTHER`, `internal`, `invalid_input`, `not_found`, `rate_limited`, `unauthorized`, `upstream_error`, `upstream_timeout`) plus two new values:

- `budget_exhausted` — the daily model-call ceiling was reached; the request was refused before any paid call.
- `expired` — a section was not finished before its report's 15-minute deadline and was abandoned without a model call.

`invalid_input`, `not_found` and `unauthorized` are marked client-caused.

### Dashboard panels

Added to `.flow/metrics.md` `## Dashboard panels`, all on the "Reports overview" dashboard (not yet created): section success vs failure, section failures by `error.type`, section latency p50/p95/p99, model-call latency p95, report end-to-end latency p95, report creation failures by `error.type`, section queue depth, section queue oldest-message age, dead-letter queue depth.

### Alerts

| Signal | Condition | Sustained for | Action | Routes to | Dashboard |
| --- | --- | --- | --- | --- | --- |
| Section queue oldest-message age | above 300 s | 10 min | page | `reports-oncall` | Reports overview |
| Dead-letter queue depth | above 0 | 5 min | notify (at most once per 24 h) | `reports-oncall` | Reports overview |
| `reports.create.failures{error.type=budget_exhausted}` | above 0 | 1 min | notify (at most once per 24 h) | `reports-oncall` | Reports overview |

Plus the burn-rate tiers for the new SLO below.

### SLO

New user journey "generate a company report": SLI = share of reports finalized with `operation.outcome=ok` within 600 s, read from `reports.report.duration`; target 95% over 30 days.

**As-code:** spec-only — the repo keeps no dashboard or alert config files.

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | HTTP handlers (new create handler, new queue worker, updated read handler), persistence (report state, new spend ledger), integration (model client, queue producer), infrastructure (template), tooling |
| Domain modules | Existing: `src/db.ts`, `src/llm.ts`, `src/handlers/getReport.ts`. New: `src/sections.ts`, `src/ledger.ts`, `src/queue.ts`, `src/metrics.ts`, `src/handlers/createReport.ts`, `src/handlers/generateSection.ts` — each single-purpose per AGENTS.md |
| Data flow | Request body → validated company → report row (status `queued`, five section slots) → five queue messages → worker writes each section into its slot → last finisher sets final status → read endpoint returns the row |
| Pattern | Extends the existing handler + `db.ts` persistence pattern [anchor: src/handlers/getReport.ts:4]; introduces a queue + parent-row-with-section-slots pattern because no queued work exists yet |
| Binary-framing check | Synchronous vs asynchronous is not a real choice here (synchronous cannot finish); the middle options — one queued job for all five sections, or a workflow engine — are simulated in Decision A |
| Data model | One report item holds all five sections in a map (five texts fit well inside DynamoDB's 400 KB item limit), plus `sectionStatus`, `sectionErrors` and `claims` (lease expiry) maps — no child rows, no schema change to the key |
| Dependency | Adds `@aws-sdk/client-sqs` as the one new runtime dependency (reason: sending queue messages); dev dependencies `typescript`, `vitest`, `@types/aws-lambda`, `@types/node` |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| Create report (`POST /reports`) | inline — 0.5 s, timeout 10 s (function), 3 s per DynamoDB/SQS call | inline: validate, reserve, write, enqueue, respond 202 | 10 s function; 3 s SDK request timeout | none in handler; caller retries with `Idempotency-Key` | `Idempotency-Key` header → deterministic report id; absent → new random id | new daily spend ledger: reserves 5 calls per report against `DAILY_MODEL_CALL_CAP` |
| Generate one section | 60 s | durable queue (SQS) + worker, batch size 1, max concurrency 5 | model call 75 s < worker 90 s < queue visibility 180 s; report deadline 15 min | queue redrive only: 3 attempts total, then dead-letter queue; no in-code or client retry | `<reportId>:<section>` — slot status plus a 100 s claim lease | same ledger: attempts 2–3 recorded as extra calls; ≤ 15 calls per report |
| Finalize report | inline in worker — 0.1 s | conditional update by whichever worker finishes the fifth section | within the worker's 90 s | none needed (idempotent: same final value) | report id + condition "status not yet final" | none (no paid call) |
| Read report (`GET /reports/{id}`) | inline — 0.2 s, timeout 3 s | inline | 3 s SDK request timeout | none | n/a (read) | none |

**Platform:** aws

**Proportionality:** left out on purpose — a workflow engine (five independent sections and one fan-in are covered by the queue plus the report row), an outbox (a failed enqueue answers 503 and a replay with the same key re-sends; without a key the 15-minute deadline closes the report), exponential backoff (the queue's fixed 180 s redelivery is enough for three attempts), per-caller rate limits (no caller identity exists yet; the daily ceiling bounds cost), streaming, and integration tests against a local DynamoDB.

**Recovery:** the reports table holds paid generations (regenerable at a known cost of 5–15 model calls each) — turn on point-in-time recovery for it in the template task; restore check: Task 2 adds `scripts/restore-check.sh`, which restores the table to a scratch table with `aws dynamodb restore-table-to-point-in-time`, compares `Table.ItemCount` with the source, and deletes the scratch table; run it once after the first deploy and after any backup config change. The spend ledger is regenerable bookkeeping — none — losing it only resets the current day's count; its rows expire after 3 days via TTL.

## Technical Constraints

- The 29 s function timeout and API Gateway's 29 s REST integration ceiling rule out any model call on the request path [anchor: template.yaml:6]; the create function sets its own 10 s timeout.
- The package is ESM (`"type": "module"`), so compiled relative imports need `.js` extensions; the existing `"../db"` import must change [anchor: package.json:5] [anchor: src/handlers/getReport.ts:2].
- "No new runtime dependencies without a reason" — only `@aws-sdk/client-sqs` is added, for queue sends [anchor: AGENTS.md].
- The queue's visibility timeout (180 s) must exceed the worker timeout (90 s), and the claim lease (100 s) must sit between the worker timeout and the visibility timeout so a redelivered message can always re-claim.
- AWS documents usage-plan quotas as best-effort and says not to rely on them for cost control, so the ceiling lives in the application ledger (https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-usage-plans.html).
- Cost: normal spend is 5 model calls per report; worst case 15. The daily ceiling defaults to 500 calls (100 reports) until Q2 is answered.
- Latency: report creation answers in under 1 s; a finished report typically takes about 60 s (five sections in parallel), worst case about 8 minutes with retries.

## Open Questions

- [ ] Q1. Which five sections does a report contain? The plan ships `Company overview`, `Products and services`, `Market and competition`, `Financial highlights`, `Risks and outlook` as one code constant; a redirect changes only that constant and the prompts.
  - **Stakes:** user — readers get section topics that do not match what they need from a company report.
  - **Needs user input:** user-held preference — the section list is report content, which only you can choose.
- [ ] Q2. What daily ceiling on model calls should the service enforce? The plan ships a template parameter defaulting to 500 calls per day (100 reports); a redirect changes the default value only.
  - **Stakes:** both — too low refuses legitimate requests with `429`; too high lets an anonymous caller run up the bill.
  - **Needs user input:** user-held preference — the ceiling is a budget decision, and the price per model call is not visible in the repo.
- [ ] Does `POST /reports` answer immediately (202 + poll) rather than returning the finished report? Redirecting to a synchronous response would remove the queue, worker and deadline tasks — and cannot work within the timeouts.
  - **Stakes:** both — a synchronous endpoint times out at 29 s after paying for calls whose results are lost.
  - **Recommended:** 202 with a status link, generation in a queued worker — the 20–60 s call time times five exceeds the 29 s ceiling [confidence: high] [anchor: template.yaml:6]
- [ ] One queued task per section, or one queued job that writes all five sections in turn? Redirecting to one job merges the worker's claim and finalize logic into a loop and raises its timeout to about 5 minutes.
  - **Stakes:** both — with one job, a failure on section five retries (and re-pays for) all five, and the report takes up to 5 minutes instead of about 1.
  - **Recommended:** one task per section — a retry re-runs only the failed section and the five run in parallel [confidence: medium] [anchor: weighing: risk — a single-job retry repeats up to four already-paid calls]
- [ ] When some sections fail, keep the ones that succeeded (`partial`) or fail the whole report? Redirecting to all-or-nothing changes the finalize rule and hides successful section text.
  - **Stakes:** user — readers lose sections that were generated and paid for.
  - **Recommended:** keep successful sections and mark the report `partial` — it keeps paid output and matches the brief's "degrade gracefully" quality priority [confidence: medium] [anchor: weighing: reversibility — a stored partial report can later be filtered out; discarded text cannot be recovered]
- [ ] Should `Idempotency-Key` be optional or required on `POST /reports`? Redirecting to required adds a `400` branch for a missing header.
  - **Stakes:** system — with an optional key, a caller that retries without one pays for a second report.
  - **Recommended:** optional, honored when present — no caller exists yet to break, and required headers add friction for every manual call [confidence: medium] [anchor: weighing: footprint — required adds a rejection branch every caller must handle]
- [ ] Keep the spend ledger in its own table or as rows in the reports table? Redirecting to the reports table removes one table and adds an id-shape guard to the read endpoint.
  - **Stakes:** system — a ledger row in the reports table would be readable by anyone through the read endpoint.
  - **Recommended:** its own table — the read endpoint returns any item by id unfiltered, so a shared table would expose ledger rows [confidence: high] [anchor: src/handlers/getReport.ts:5]
- [ ] What request body does `POST /reports` accept? The plan accepts `{"company": "<name>"}`, trimmed, 1–200 characters, no control characters; a redirect changes the validator and the prompt input.
  - **Stakes:** user — callers needing more input (a ticker, a region) cannot express it.
  - **Recommended:** a single `company` string, length-capped — it is the only input the model client takes [confidence: medium] [anchor: adjacent: src/llm.ts:2]
- [x] Status vocabulary (`queued`, `running`, `done`, `partial`, `failed`) — resolved without asking
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision A — how do the five model calls run relative to the request?** (mutually exclusive branches)

| Branch | Caller walkthrough | Interruptions / waits per run | System consequence |
| --- | --- | --- | --- |
| A1. In the request (raise the gateway limit, Regional APIs only) | Caller sends POST, waits 100–300 s (sequential) or up to 60 s (parallel), gets the report or a timeout | 1 blocking wait of 60–300 s; at today's 29 s limit, always a timeout | A dropped connection loses paid work; a client retry pays again |
| A2. One queued job writes all five sections in turn | Caller gets 202 in < 1 s, polls; the report appears after 100–300 s | 0 interruptions; polling for up to 5 min | A failure on any section retries all five; worker timeout ~5 min |
| A3. One queued task per section (chosen) | Caller gets 202 in < 1 s, polls; sections appear over ~60 s | 0 interruptions; polling for ~1 min | Retry re-runs one section; five in parallel; needs a lease and a finalizer |
| A4. Workflow engine (Step Functions map over sections) | Same as A3 for the caller | 0 interruptions | Adds a state machine, its IAM role and a start-execution call for a fixed fan-out a queue already covers |

Ranked: A3 > A2 > A4 > A1. Verdict: **A3** — fastest report, cheapest retries, and the smallest addition that handles fan-out and fan-in [confidence: medium] [anchor: weighing: risk — A2 repeats paid calls on retry; A1 cannot complete within the 29 s ceiling].

**Decision B — what does a report with a failed section show?** (complementary with Decision A; branches exclusive with each other)

| Branch | Caller walkthrough | Interruptions | Consequence |
| --- | --- | --- | --- |
| B1. `partial`, successful sections kept (chosen) | Polls, sees four sections and one marked `failed` | 0 | Paid output is kept; the caller decides whether four sections suffice |
| B2. All-or-nothing `failed` | Polls, sees `failed` and no text | 0 | Four paid sections are thrown away; caller re-requests and pays for five again |

Verdict: **B1** — it keeps paid output and degrades gracefully, the brief's cost and quality priorities [confidence: medium] [anchor: weighing: reversibility — partial text can be hidden later; discarded text cannot be restored].

## Alternatives considered

- **DynamoDB Streams trigger on the reports table** — rejected: a stream shard processes records in order and a failing record blocks the shard until retries run out, so one failing 60 s paid call stalls every report behind it.
- **Asynchronous self-invocation of a worker Lambda** — rejected: Lambda async events retry twice on their own and are discarded without a configured destination; the platform guidance prefers SQS for explicit retry and dead-letter control.
- **API Gateway usage plan quota and API keys as the spend cap and caller gate** — rejected: AWS documents quotas as best-effort, not to be relied on for cost control, and API keys as unsuitable for authorization (https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-usage-plans.html).

## Recommendation

**Reconsider scope** — build `POST /reports` as an immediate `202` with queued per-section generation instead of a request that returns the finished report (see the 202 Open Question and Decision A), and bundle the fixes it depends on: simplify the model client (timeouts, error classes), the report persistence (conditional state changes replacing the unused overwrite), the read endpoint (working deployment, deadline), the template, and the missing build/test tooling [confidence: high] [anchor: template.yaml:6]

**Redundancy:** none found — no existing code path creates a report; the only writer is unused [anchor: src/db.ts:11]

## Plan risks

The tests mock the DynamoDB client, so a mistake in the conditional update expressions that make claims, section writes and finalization safe (for example, a wrong attribute path in a nested map) would pass every test and only show up as duplicate model calls or stuck reports after deploy.

## Cut list

- Per-caller rate limiting was cut: there is no caller identity yet, and the daily ceiling already bounds spend; it returns with the authentication follow-up.
- An outbox for the enqueue step was cut: a failed enqueue answers 503, a keyed replay re-sends, and the 15-minute deadline closes anything left behind.
- Exponential backoff between attempts was cut: three attempts at a fixed 180 s redelivery fit well inside the 15-minute deadline.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Authenticate callers of the reports API | Medium | Medium | needs its own design/decision session: the open decision is which caller identity mechanism (IAM signing, a Cognito user pool, or a custom authorizer) the API adopts, and whether existing readers of reports can be required to use it | the new POST starts paid work with no caller identity; the spend ceiling bounds cost but any caller can use up the day's budget | No |
| Run the persistence tests against a local DynamoDB | Medium | Small | needs its own design/decision session: the open decision is whether the test environment may depend on Docker or a Java runtime, which nothing in the repo uses today | closes the plan's top risk — conditional-update bugs that mocked tests cannot catch | No |

- [x] Authenticate callers of the reports API — decide and add one caller identity mechanism for `POST /reports` and `GET /reports/{id}`, then add per-caller rate limits.
  - **UX:** none
  - **Problem:** any anonymous caller can start paid report generation and read any report whose id it holds [anchor: template.yaml:19]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk: an anonymous caller can exhaust the daily model-call ceiling for everyone [anchor: template.yaml:19]
  - **Complexity:** Medium — template auth config on both routes, caller-scoped idempotency keys, per-caller limits
  - **Risk:** Medium — changes how every client calls the API
  - **If never done:** the daily budget stays open to any caller, and reports stay readable by anyone holding an id
  - **Verdict:** clears bar — an open paid endpoint is a standing cost exposure that outweighs a Medium change
- [ ] Run the persistence tests against a local DynamoDB — exercise the claim, section-write and finalize conditional updates against a real engine in CI.
  - **UX:** none
  - **Problem:** none
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk: expression mistakes pass mocked tests [anchor: src/db.ts:2]
  - **Complexity:** Small — one test setup file and a container step
  - **Risk:** Medium — adds a container dependency to the test run
  - **If never done:** expression bugs in report state changes are found only after deploy
  - **Verdict:** below bar — no failure has been observed yet and the value line is not substantiated by a reproduced fault

# Task breakdown

### Task 1: Build and test tooling

- **Skill:** `flow-testing`
- **Bundled:** the missing compiler, test runner and tsconfig that `npm run build` and `npm test` already call, plus the extensionless ESM import in the read handler
- **Description:** Add dev dependencies `typescript`, `vitest`, `@types/aws-lambda`, `@types/node`; add `tsconfig.json` (`module`/`moduleResolution` `NodeNext`, `target` `ES2022`, `strict`, `rootDir` `src`, `outDir` `dist`, exclude `**/*.test.ts`); change the `test` script to `vitest run` so it terminates; fix `import { getReport } from "../db"` to `"../db.js"`.
- **Inputs:** existing `package.json`, `src/handlers/getReport.ts`
- **Outputs:** a repo where `npx tsc --noEmit` and `npm test` run
- **Contract:**
  - **Files:** edit `package.json`; create `tsconfig.json`; edit `src/handlers/getReport.ts`
  - **Interfaces:** `package.json` `scripts.test`: `"vitest"` → `"vitest run"`; `devDependencies` += the four packages
  - **Call-site edits:** `src/handlers/getReport.ts` import path `"../db"` → `"../db.js"`
- **Acceptance criteria:** `npm install && npx tsc --noEmit && npx vitest run --passWithNoTests`

### Task 2: Infrastructure — queue, ledger table, functions, read-function fix

- **Skill:** `flow-system-design`
- **Bundled:** the read function's missing `REPORTS_TABLE` env var and table read policy, without which polling cannot work
- **Description:** Extend `template.yaml` with every resource the runtime design names, including the queue's must-set settings and point-in-time recovery on the reports table, and add a restore-check script for that recovery path.
- **Inputs:** existing `template.yaml`; env var names `REPORTS_TABLE`, `SPEND_LEDGER_TABLE`, `SECTION_QUEUE_URL`, `DAILY_MODEL_CALL_CAP`
- **Outputs:** a template that deploys the POST route, the worker and its queue
- **Contract:**
  - **Files:** edit `template.yaml`; create `scripts/restore-check.sh` (args: source table name, scratch table name; restores to the latest restorable time, waits for the table, compares `Table.ItemCount`, exits non-zero on mismatch, deletes the scratch table)
  - **Interfaces (config key paths, before → after):**
    - `Parameters.DailyModelCallCap`: absent → `Type: Number, Default: 500, MinValue: 5`
    - `Resources.ReportsTable.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled`: absent → `true`
    - `Resources.SpendLedgerTable`: absent → `AWS::DynamoDB::Table`, `PAY_PER_REQUEST`, key `day` (S), `TimeToLiveSpecification: { AttributeName: expiresAt, Enabled: true }`
    - `Resources.SectionDLQ`: absent → `AWS::SQS::Queue`, `MessageRetentionPeriod: 1209600`
    - `Resources.SectionQueue`: absent → `AWS::SQS::Queue`, `VisibilityTimeout: 180`, `MessageRetentionPeriod: 3600`, `RedrivePolicy: { deadLetterTargetArn: !GetAtt SectionDLQ.Arn, maxReceiveCount: 3 }`
    - `Resources.GetReportFunction.Properties.Environment.Variables.REPORTS_TABLE`: absent → `!Ref ReportsTable`; `Policies`: absent → `[DynamoDBReadPolicy: { TableName: !Ref ReportsTable }]`
    - `Resources.CreateReportFunction`: absent → handler `dist/handlers/createReport.handler`, `Timeout: 10`, env `REPORTS_TABLE`, `SPEND_LEDGER_TABLE`, `SECTION_QUEUE_URL: !Ref SectionQueue`, `DAILY_MODEL_CALL_CAP: !Ref DailyModelCallCap`; policies `DynamoDBCrudPolicy` (both tables), `SQSSendMessagePolicy: { QueueName: !GetAtt SectionQueue.QueueName }`; event `Api: { Path: /reports, Method: post }`
    - `Resources.GenerateSectionFunction`: absent → handler `dist/handlers/generateSection.handler`, `Timeout: 90`, env `REPORTS_TABLE`, `SPEND_LEDGER_TABLE`; policies `DynamoDBCrudPolicy` (both tables); event `SQS: { Queue: !GetAtt SectionQueue.Arn, BatchSize: 1, ScalingConfig: { MaximumConcurrency: 5 } }`
  - **Call-site edits:** none
- **Acceptance criteria:** `sam validate --lint && grep -q 'VisibilityTimeout: 180' template.yaml && grep -q 'maxReceiveCount: 3' template.yaml && grep -q 'PointInTimeRecoveryEnabled: true' template.yaml && grep -q 'MaximumConcurrency: 5' template.yaml && bash -n scripts/restore-check.sh && grep -q 'restore-table-to-point-in-time' scripts/restore-check.sh`

### Task 3: Model client timeout and error classes

- **Skill:** `flow-system-design`
- **Description:** Give the model call a 75 s timeout, check the response status, reject a missing or empty `text`, and throw a typed error that says whether a retry can help. No retry inside the client (the queue is the single retry layer). Request body and URL unchanged.
- **Inputs:** `src/llm.ts`; Task 1 tooling
- **Outputs:** a model client the worker can classify failures from
- **Contract:**
  - **Files:** edit `src/llm.ts`; create `src/llm.test.ts`
  - **Interfaces:**
    - `export const MODEL_CALL_TIMEOUT_MS = 75_000;`
    - `export type ModelErrorKind = "timeout" | "rate_limited" | "upstream_error" | "invalid_response" | "rejected";`
    - `export class ModelCallError extends Error { readonly kind: ModelErrorKind; readonly retryable: boolean; readonly status?: number }` — `timeout`, `rate_limited` (429), `upstream_error` (5xx or network) are retryable; `rejected` (other 4xx) and `invalid_response` are not
    - `export async function generateSection(company: string, section: string): Promise<string>` — signature unchanged; uses `AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS)`
  - **Call-site edits:** none (no current caller)
- **Acceptance criteria:** `npx vitest run src/llm.test.ts` (covers 200 ok, 429, 500, 400, empty text, abort-timeout via fake timers)

### Task 4: Metrics helper and metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create the repo-local metrics helper with a swappable in-memory recorder (no backend yet) and the closed `ErrorType` union, and create `.flow/metrics.md` with `## Backend` (`none yet — suggested: OpenTelemetry SDK`), `## Namespace` (`reports`), `## Attributes`, `## error.type values` (starter list + `budget_exhausted`, `expired`), `## Helper`, `## Dashboard panels`, `## Dashboards` (none yet), `## Alerts` (rows from the plan's Instrumentation section plus burn-rate tiers), `## As-code` (`spec-only`), `## SLOs` ("generate a company report", 95% within 600 s, 30 days), `## Coverage` (`reports.create`, `reports.section`, `reports.report`). Metrics planned: `reports.create.failures`, `reports.section.duration`, `reports.section.failures`, `reports.llm.call.duration`, `reports.report.duration`.
- **Inputs:** Task 1 tooling; new: `src/metrics.ts`
- **Outputs:** a typed helper every handler calls; the committed metrics contract
- **Contract:**
  - **Files:** create `src/metrics.ts`, `src/metrics.test.ts`, `.flow/metrics.md`
  - **Interfaces:**
    - `export type ErrorType = "_OTHER" | "budget_exhausted" | "expired" | "internal" | "invalid_input" | "not_found" | "rate_limited" | "unauthorized" | "upstream_error" | "upstream_timeout";`
    - `export type Outcome = "ok" | "error";`
    - `export interface Recorder { histogram(name: string, seconds: number, attrs: Record<string, string>): void; counter(name: string, attrs: Record<string, string>): void }`
    - `export function setRecorder(r: Recorder): void` and `export function createInMemoryRecorder(): Recorder & { histograms: Array<{ name: string; seconds: number; attrs: Record<string, string> }>; counters: Array<{ name: string; attrs: Record<string, string> }> }`
    - `export async function instrument<T>(op: "reports.section", fn: () => Promise<T>, classify: (err: unknown) => ErrorType): Promise<T>`
    - `export function recordFailure(op: "reports.create" | "reports.section", errorType: ErrorType): void`
    - `export function recordModelCall(seconds: number, outcome: Outcome): void` (fixed `server.address=api.example-llm.com`)
    - `export function recordReportDuration(seconds: number, outcome: Outcome): void`
    - `export function toErrorType(value: string): ErrorType` (unlisted → `_OTHER`)
  - **Call-site edits:** none yet (consumed by Tasks 8–9)
- **Acceptance criteria:** `npx vitest run src/metrics.test.ts && test -f .flow/metrics.md && grep -q 'budget_exhausted' .flow/metrics.md` (tests cover one success observation, one failure per new `error.type`, and unlisted value → `_OTHER`)

### Task 5: Section list and report state persistence

- **Skill:** `flow-system-design`
- **Description:** Define the five sections, and replace the unused overwrite with conditional report state changes. All writes use condition expressions so retries and duplicate deliveries are safe. Give the DynamoDB client a 3 s request timeout.
- **Inputs:** `src/db.ts`; Task 1 tooling
- **Outputs:** report create / claim / complete / fail / finalize primitives
- **Contract:**
  - **Files:** create `src/sections.ts`; edit `src/db.ts`; create `src/db.test.ts`
  - **Interfaces:**
    - `src/sections.ts`: `export const SECTIONS = [{ key: "overview", title: "Company overview" }, { key: "products", title: "Products and services" }, { key: "market", title: "Market and competition" }, { key: "financials", title: "Financial highlights" }, { key: "outlook", title: "Risks and outlook" }] as const;` `export type SectionKey = (typeof SECTIONS)[number]["key"];` `export const REPORT_DEADLINE_MS = 15 * 60_000;` `export const CLAIM_LEASE_MS = 100_000;`
    - `src/db.ts`: `export type SectionStatus = "queued" | "running" | "done" | "failed";` `export type ReportStatus = "queued" | "running" | "done" | "partial" | "failed";` `export interface ReportItem { id: string; version: 1; company: string; status: ReportStatus; createdAt: string; deadlineAt: string; requestHash: string; enqueued: boolean; sections: Partial<Record<SectionKey, string>>; sectionStatus: Record<SectionKey, SectionStatus>; sectionErrors: Partial<Record<SectionKey, string>>; claims: Partial<Record<SectionKey, number>>; completedAt?: string }`
    - `export async function getReport(id: string): Promise<Record<string, unknown> | undefined>` (unchanged)
    - `export async function createReport(input: { id: string; company: string; requestHash: string; now: Date }): Promise<"created" | "exists">` — `attribute_not_exists(id)`
    - `export async function markEnqueued(id: string): Promise<void>`
    - `export async function claimSection(id: string, section: SectionKey, now: Date): Promise<ReportItem | undefined>` — succeeds only when the slot is `queued`, or `running` with an expired lease; sets report `running`; `undefined` when already terminal or leased
    - `export async function completeSection(id: string, section: SectionKey, text: string): Promise<ReportItem>` — condition slot is `running`; returns `ALL_NEW`
    - `export async function failSection(id: string, section: SectionKey, errorType: string): Promise<ReportItem>`
    - `export function deriveFinalStatus(item: ReportItem): "done" | "partial" | "failed" | undefined` — `undefined` while any slot is non-terminal
    - `export async function finalizeReport(id: string, status: "done" | "partial" | "failed", now: Date): Promise<boolean>` — condition status is `queued` or `running`; `true` for the single winner
    - remove `saveReport`
  - **Call-site edits:** none (no current caller of `saveReport`)
- **Acceptance criteria:** `npx vitest run src/db.test.ts` (asserts each command's `ConditionExpression`, and `deriveFinalStatus` for all-done, one-failed, all-failed, still-running)

### Task 6: Daily spend ledger

- **Skill:** `flow-system-design`
- **Description:** One choke point for model spend: an atomic daily counter in the ledger table keyed by UTC date. Reservation is conditional on staying within `DAILY_MODEL_CALL_CAP`; extra attempts are recorded unconditionally so the count stays true. Rows carry `expiresAt` 3 days out.
- **Inputs:** Task 1 tooling; Task 2 env var `SPEND_LEDGER_TABLE`, `DAILY_MODEL_CALL_CAP`; new: `src/ledger.ts`
- **Outputs:** reserve / record functions used by Tasks 8–9
- **Contract:**
  - **Files:** create `src/ledger.ts`, `src/ledger.test.ts`
  - **Interfaces:**
    - `export const CALLS_PER_REPORT = 5;`
    - `export async function reserveModelCalls(count: number, now: Date): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }>` — `ADD calls :n` with condition `attribute_not_exists(calls) OR calls <= :capMinusN`; on condition failure returns seconds to next UTC midnight
    - `export async function recordExtraModelCall(now: Date): Promise<void>`
  - **Call-site edits:** none yet
- **Acceptance criteria:** `npx vitest run src/ledger.test.ts` (under cap → ok; at cap → `ok: false` with correct `retryAfterSeconds`; key is `day#YYYY-MM-DD` in UTC)

### Task 7: Section queue producer

- **Skill:** `flow-system-design`
- **Description:** Send one versioned message per section in a single batch call; any failed entry throws. Adds `@aws-sdk/client-sqs` (the one new runtime dependency). Client request timeout 3 s.
- **Inputs:** Task 1 tooling; Task 2 env var `SECTION_QUEUE_URL`; Task 5 `SectionKey`; new: `src/queue.ts`
- **Outputs:** `enqueueSections` for Task 8; the message shape for Task 9
- **Contract:**
  - **Files:** create `src/queue.ts`, `src/queue.test.ts`; edit `package.json` (`dependencies` += `@aws-sdk/client-sqs`)
  - **Interfaces:**
    - `export interface SectionTask { version: 1; reportId: string; section: SectionKey }`
    - `export function parseSectionTask(body: string): SectionTask` — throws on unknown version or section
    - `export class EnqueueError extends Error {}`
    - `export async function enqueueSections(reportId: string, sections: readonly SectionKey[]): Promise<void>` — one `SendMessageBatchCommand`, entry ids = section keys
  - **Call-site edits:** none yet
- **Acceptance criteria:** `npx vitest run src/queue.test.ts` (five entries with `version: 1`; a `Failed` entry throws `EnqueueError`; `parseSectionTask` rejects version 2)

### Task 8: `POST /reports` handler

- **Skill:** `flow-system-design`
- **Description:** Validate body; derive the report id (with `Idempotency-Key`: a UUID-formatted SHA-256 of the key; without: `crypto.randomUUID()`); on a keyed repeat, return the stored report's 202 (re-sending messages if `enqueued` is false) or `422` when `requestHash` differs; otherwise reserve 5 calls (`429` + `Retry-After` and `reports.create.failures{budget_exhausted}` on refusal), create the report, enqueue, mark enqueued, return 202. Enqueue failure → `503` with `Retry-After: 5` and `upstream_error`. Never call the model.
- **Inputs:** Tasks 4, 5, 6, 7; new: `src/handlers/createReport.ts`
- **Outputs:** the POST route's handler named in Task 2
- **Contract:**
  - **Files:** create `src/handlers/createReport.ts`, `src/handlers/createReport.test.ts`
  - **Interfaces:**
    - `export const handler: APIGatewayProxyHandler`
    - `export function parseCreateBody(body: string | null): { company: string } | { error: string }` — trimmed, 1–200 chars, no control characters
    - `export function reportIdFromKey(key: string): string`
    - Responses: `202 { id, status }` + `Location: /reports/{id}`; `400 { error: "invalid_input", message }`; `422 { error: "invalid_input", message: "Idempotency-Key reused with a different body" }`; `429 { error: "budget_exhausted" }` + `Retry-After`; `503 { error: "upstream_error" }` + `Retry-After: 5`
  - **Call-site edits:** none
- **Acceptance criteria:** `npx vitest run src/handlers/createReport.test.ts` (202 path with model mock asserting zero calls; 400; keyed replay with no second reservation; 422; 429 with `Retry-After`; 503 on `EnqueueError`; failure counter emitted with the right `error.type`)

### Task 9: Section worker

- **Skill:** `flow-system-design`
- **Description:** SQS handler, batch size 1. Idempotency key `<reportId>:<section>`; timeout 75 s model call inside a 90 s function. Steps: parse task; if past `deadlineAt`, `failSection(..., "expired")` with no model call; `claimSection` (return if `undefined` — already done or leased); on attempt > 1, `recordExtraModelCall`; call `generateSection` inside `instrument("reports.section", …)` and `recordModelCall`; on success `completeSection`; on `ModelCallError` that is not retryable, or on attempt ≥ 3 (`ApproximateReceiveCount`), `failSection` with the mapped `error.type` and return normally; on a retryable error before attempt 3, throw so the queue redelivers. After any terminal write, `deriveFinalStatus` → `finalizeReport`; the winner emits `recordReportDuration`.
- **Inputs:** Tasks 3, 4, 5, 6, 7; new: `src/handlers/generateSection.ts`
- **Outputs:** the queue consumer named in Task 2
- **Contract:**
  - **Files:** create `src/handlers/generateSection.ts`, `src/handlers/generateSection.test.ts`
  - **Interfaces:**
    - `export const handler: SQSHandler`
    - `export const MAX_ATTEMPTS = 3;`
    - `export function errorTypeFor(err: unknown): ErrorType` — `timeout` → `upstream_timeout`, `rate_limited` → `rate_limited`, `upstream_error`/`rejected`/`invalid_response` → `upstream_error`, other → `internal`
  - **Call-site edits:** none
- **Acceptance criteria:** `npx vitest run src/handlers/generateSection.test.ts` (success writes section; duplicate delivery of a done slot makes zero model calls — idempotency key `<reportId>:<section>`; retryable error on attempt 1 throws; same error on attempt 3 marks failed without throwing; non-retryable marks failed at once; expired report makes zero model calls; fifth finisher with one failure finalizes `partial` once; model timeout constant is 75 000 ms)

### Task 10: Read endpoint shows progress and always ends

- **Skill:** `flow-testing`
- **Description:** Keep returning the stored item, but drop `requestHash` and `claims`; when `status` is `queued` or `running` and now is past `deadlineAt`, present `status: "failed"` and every non-terminal section as `failed` with `error: "expired"` (read-only overlay; the worker writes the same outcome when it sees the message). Items without a `status` field pass through unchanged.
- **Inputs:** Task 1 (import fix), Task 5 (`ReportItem`, `REPORT_DEADLINE_MS`)
- **Outputs:** a polling-safe read endpoint
- **Contract:**
  - **Files:** edit `src/handlers/getReport.ts`; create `src/handlers/getReport.test.ts`
  - **Interfaces:** `export const handler: APIGatewayProxyHandler` (unchanged); `export function presentReport(item: Record<string, unknown>, now: Date): Record<string, unknown>`
  - **Call-site edits:** `handler` wraps the `getReport` result in `presentReport(report, new Date())`
- **Acceptance criteria:** `npx vitest run src/handlers/getReport.test.ts` (200 with internal fields removed; 404 unchanged; past-deadline overlay; legacy item unchanged)

| Task | Depends on |
| --- | --- |
| 1 | — |
| 2 | — |
| 3 | 1 |
| 4 | 1 |
| 5 | 1 |
| 6 | 1, 2 |
| 7 | 1, 2, 5 |
| 8 | 4, 5, 6, 7 |
| 9 | 3, 4, 5, 6, 7 |
| 10 | 1, 5 |

### Skills Summary

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-system-design | Yes (Tasks 2, 3, 5–9) | New queued paid work: execution model, timeouts, single retry layer, idempotency, spend cap |
| flow-metrics | Yes (Task 4) | New handler, worker, outbound call; creates `.flow/metrics.md` |
| flow-testing | Yes (Tasks 1, 10) | Test tooling does not exist yet; read-handler tests |
| flow-new-feature | No | Drives implementation of this plan; not a per-task skill |
| security-review | No | Run at review time; caller authentication is a follow-up |
| flow-ui-ux | No | No UI surface |
| claude-api | No | The model provider is not named in the repo; the client's request shape is unchanged |

# PR description draft

## TLDR

Callers can now request a five-section company report with `POST /reports` and get its id in under a second; before, no report could be created, and waiting on generation would time out.

## User-facing changes

- New endpoint: `POST /reports` with `{"company": "<name>"}` answers `202` with the report id and a `Location: /reports/<id>` link, without waiting for generation.
- Polling `GET /reports/<id>` shows the report moving from `queued` to `running` to `done`, with each section's text appearing as it finishes.
- When some sections fail after retries, the report reads `partial` and keeps the sections that succeeded; each failed section says why.
- A retry that sends the same `Idempotency-Key` header returns the same report and is not charged again; the same key with a different company is rejected with `422`.
- Once the day's model-call ceiling (default 500 calls, about 100 reports) is reached, new requests get `429` with the seconds until it resets at UTC midnight.
- Reading a report now works as deployed, and a report still unfinished 15 minutes after the request reads `failed` instead of waiting forever:
  - **Before:** the read endpoint was deployed without its table name or permission to read the table.
  - **After:** it can read reports, and every job reaches a final status a caller can see.

## System changes

- Report generation now runs in the background, one queued task per section:
  - **Before:** the service made no model calls and had no background work.
  - **After:** each report sends five messages to a new queue; a worker writes one section per message, retries a failing section up to three attempts in total, and sends crashes to a dead-letter queue.
- New ongoing cost: 5 model calls per report normally, at most 15 with retries, capped per day by a ledger checked before any call is queued. Adds one small on-demand DynamoDB table, one SQS queue plus its dead-letter queue, and point-in-time recovery on the reports table.
- The project now has a working build and test setup (compiler, test runner, config); the test script runs once and exits instead of watching.

## Why

The service can show a company report but has no way to make one. A report needs five paid model calls that each take 20–60 seconds, far longer than a web request is allowed to run, so the straightforward design would charge for calls whose results never reach the caller.

## Key decisions

- **Respond immediately, generate in the background.** Five calls take 100–300 seconds in a row against a 29-second request limit; even raising that limit would leave callers blocked for minutes and lose paid work on a dropped connection.
- **One queued task per section, not one job per report.** A retry re-runs only the failed section, and the five run in parallel (about a minute per report instead of up to five).
- **Keep successful sections when one fails.** Discarding four paid sections because a fifth failed costs the caller a full re-run.
- **The spend ceiling lives in the application, not in API Gateway usage plans.** AWS documents usage-plan quotas as best-effort and not to be relied on for cost control.
- **A queue rather than a database change stream or async function calls.** A change stream blocks every report behind one failing call; async calls retry on their own and drop failures silently.
- **Caller authentication is out of scope** and tracked as a follow-up; until then the daily ceiling bounds what an anonymous caller can spend.
- Bundled: the missing compiler, test runner and config that the existing build and test scripts already call, plus the read handler's broken module import.
- Bundled: the read function's missing table setting and read permission, without which polling cannot work.

## Instrumentation

New metrics for report creation failures, per-section generation time and failures, model-call time, and end-to-end report time, plus a new "generate a company report" SLO (95% finished successfully within 10 minutes, 30 days). Panels are specified for a "Reports overview" dashboard; alerts cover the section queue's oldest-message age, dead-letter queue depth and the spend ceiling being reached. Spec-only: no metrics backend is chosen yet, so these metrics are recorded but won't show on any graph until one is picked (status in `.flow/metrics.md` `## Backend`).

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `npm install && npx tsc --noEmit` — the project type-checks.
- [ ] Run `npx vitest run src/handlers/createReport.test.ts` — the 202 path makes zero model calls, and the 400, 422, 429 and 503 paths pass.
- [ ] Run `npx vitest run src/handlers/generateSection.test.ts` — duplicate delivery, retry-versus-fail by attempt, expiry and single-finalizer specs pass.
- [ ] Run `npx vitest run src/handlers/getReport.test.ts` — internal fields are hidden and past-deadline reports read `failed`.
- [ ] Run `npx vitest run src/llm.test.ts src/db.test.ts src/ledger.test.ts src/queue.test.ts src/metrics.test.ts` — all specs pass.
- [ ] Run `sam validate --lint` — the template is valid.
- [ ] Run `grep -q 'VisibilityTimeout: 180' template.yaml && grep -q 'maxReceiveCount: 3' template.yaml && grep -q 'PointInTimeRecoveryEnabled: true' template.yaml` — the queue and recovery settings are present.
- [ ] Run `grep -A12 'GetReportFunction:' template.yaml | grep -q DynamoDBReadPolicy` — the read function can read the reports table.
- [ ] Run `bash -n scripts/restore-check.sh && grep -q 'restore-table-to-point-in-time' scripts/restore-check.sh` — the restore check for the reports table's backups is present and parses.
- [ ] DECISION: you accept the default daily ceiling of 500 model calls (about 100 reports) until you set your own budget.
- [ ] DECISION: you accept the five section titles — Company overview, Products and services, Market and competition, Financial highlights, Risks and outlook.
