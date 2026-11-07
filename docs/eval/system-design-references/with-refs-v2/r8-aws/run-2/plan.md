# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Company report generation (`POST /reports`)

**Goal:** A caller can request a five-section company report and get its id within a second, then read each section as it finishes, without lost or double-paid work.

## Problem Statement

This service stores and serves company reports, but nothing can create one yet: there is a way to read a report and no way to ask for a new one. Each report needs five pieces of model-written text, and each piece takes 20 to 60 seconds and costs money. The service's web front door cuts off any request after 29 seconds. So a request that tries to write all five pieces while the caller waits would be dropped partway through, throw away work that was already paid for, and invite the caller to retry and pay again.

Framed against the product brief's ranked priorities: **user experience** (rank 1) means the caller should not be left holding a request that hangs and then fails. **Cost** (rank 2) means paid model calls must not be wasted or duplicated by retries.

| Fact | Evidence |
| --- | --- |
| Each model call takes 20-60 s and is paid per call | [anchor: src/llm.ts:1] |
| Every function and request is capped at 29 s | [anchor: template.yaml:6] |
| Five sequential calls take 100-300 s, and five parallel calls still take 20-60 s | arithmetic on src/llm.ts:1 |
| Only a read path exists. `saveReport` is never called anywhere in the repo | [anchor: src/db.ts:11], [anchor: src/handlers/getReport.ts:5] |
| The model client has no timeout and no status check. A `500` body without `text` returns `undefined` as the section | [anchor: src/llm.ts:3], [anchor: src/llm.ts:7] |
| The deployed read function has no table-name variable and no table read permission | [anchor: template.yaml:14], [anchor: src/db.ts:5] |
| The package is ESM (`"type": "module"`), but the relative import has no `.js` extension, which Node's ESM loader rejects at runtime | [anchor: package.json:5], [anchor: src/handlers/getReport.ts:2] |
| `npm test` and `npm run build` call `vitest` and `tsc`, but neither is a dependency and there is no `tsconfig.json` | [anchor: package.json:7] |

## Request vetting

- **Hypothesis:** five model calls for one report can finish inside a single `POST /reports` request, so the response can carry the generated report.
- **Case against:** each call takes 20-60 s [anchor: src/llm.ts:1], and requests die at 29 s [anchor: template.yaml:6]. Sequential is 100-300 s; even fully parallel is 20-60 s. A dropped request throws away sections that were already paid for, and a client retry re-pays all five. https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html
- **Sources:** https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html, https://www.nngroup.com/articles/response-times-3-important-limits/ (10 s attention budget, cited by the flow-system-design skill)
- **Verdict:** push back: accept the request with `202` and a pollable report status, and run the five section calls as one queued job per section

## Existing-code assessment

- **src/llm.ts:** simplify — before a worker depends on it, add an explicit timeout, a non-2xx check and failure classification. Today a model error is saved as an `undefined` section. [anchor: src/llm.ts:3]
- **src/db.ts:** keep — the module-level document client and table-name pattern fit. Extend it with conditional create, section-write and finalize functions. [anchor: src/db.ts:4]
- **src/handlers/getReport.ts:** simplify — fix the extensionless ESM import. The handler already returns the stored item as-is, so status and per-section progress appear with no logic change. [anchor: src/handlers/getReport.ts:2]
- **template.yaml:** simplify — the existing function has no `REPORTS_TABLE` variable and no read policy. Add both, together with the new queue, functions and API-key settings. [anchor: template.yaml:14]
- **package.json:** simplify — the `test` and `build` scripts reference tools that are not installed. Add the dev toolchain and a `typecheck` script. [anchor: package.json:7]

## Scope Boundary

**In scope:**

- `POST /reports`, which accepts `{ "company": string }` and returns `202` with the report id, a `Location: /reports/{id}` header and the five section names.
- One queued generation task per section, handled by a section worker that writes each section as it finishes.
- Report status (`queued` → `running` → `done` | `partial` | `failed`) and per-section status, readable through the existing `GET /reports/{id}`.
- An `Idempotency-Key` request header for safe client retries.
- An API key plus a usage-plan quota on `POST /reports`.
- A hardened model client (timeout, status check, failure classes).
- A metrics helper and `.flow/metrics.md`.
- Point-in-time recovery on the reports table.
- The missing build and test toolchain, and the existing read function's missing environment variable and permission.

**Out of scope:**

- Requiring an API key on `GET /reports/{id}` (candidate follow-up).
- A retention window for old reports (candidate follow-up).
- Streaming section text token by token.
- Caller-chosen or custom sections.
- An application-level spend ledger across API keys.
- Webhook or push notification when a report is ready.
- Regenerating a single section on demand.

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| There is no way to request a report; a caller can only read one that already exists | `POST /reports` with a company name returns a report id within about a second |
| A request that tried to generate a report would hang for up to 29 s and then fail | The caller polls `GET /reports/{id}` and sees each section as it finishes; the report is ready in about the time of its slowest section (20-60 s) |
| A network retry of a request would pay for a second report | Re-sending the same `Idempotency-Key` returns the original report with no new paid calls |
| A model error would be saved as an empty section | A failed section shows `failed` with its failure class, and the other four sections stay readable (`partial`) |
| As deployed, the existing read has no table name or read permission | The read returns the stored report or `404` |

### System flow

- **Before:**
  - The only runtime operation is a single synchronous table read.
  - No queue, no worker, no paid-call path is wired up, and no metrics exist.
- **After:**
  - The `POST` handler writes one report item (five `pending` sections) with a conditional put. It then sends five section messages to a queue and returns `202`.
  - The section worker (up to 10 at a time) makes one model call per message. It writes the section with a conditional update keyed on report id and section name. The last section to finish sets the terminal report status.
  - Transient failures are retried only through the queue: three attempts in total, with the backoff set on the message. After the last attempt the section is marked `failed`, and the message stays visible in the dead-letter queue for 14 days.
  - Every operation emits duration and failure metrics through one helper.

**Lost:** none — the change is additive. The existing read keeps its path, method and response shape; it only gains the configuration it was missing.

## User Stories / Acceptance Criteria

### Story 1: Request a report

- [ ] Given a valid API key and body `{ "company": "Acme" }`, when the caller sends `POST /reports`, then the response is `202`. Its `Location` header is `/reports/{id}`, its body has `status: "queued"` and five `pending` sections, and exactly five section messages are sent. Check: `npx vitest run src/handlers/createReport.test.ts` passes.
- [ ] Given a body with a missing, empty or over-200-character `company`, when the caller sends `POST /reports`, then the response is `400 { error }`. No report is stored and no message is sent. Check: same test file.
- [ ] Given a report already created with `Idempotency-Key: k1`, when the caller re-sends the same company with `k1`, then the response is `202` with the same id. No second report is stored, and messages are re-sent only while the report is still `queued`. Check: same test file.
- [ ] Given `Idempotency-Key: k1` was used for "Acme", when the caller sends `k1` with "Globex", then the response is `422 { error }` and nothing is stored or sent. Check: same test file.

### Story 2: Generate sections

- [ ] Given a section message for a `pending` section, when the worker runs, then it calls the model exactly once and stores the text, and the section becomes `done`. Check: `npx vitest run src/handlers/generateSection.test.ts` passes.
- [ ] Given a redelivered message for a section that is already `done` or `failed`, when the worker runs, then it makes no model call and changes nothing. Check: same test file.
- [ ] Given a model timeout, `429` or `5xx` on attempt 1 or 2, when the worker runs, then it sets the message's visibility to the backoff delay and throws, and the section stays `pending`. On attempt 3, the section becomes `failed` with its failure class and the worker does not throw. Check: same test file.
- [ ] Given a permanent model failure (a non-429 `4xx`, or a body without a string `text`), when the worker runs, then the section becomes `failed` on the first attempt with no retry. Check: same test file.

### Story 3: Read progress and the finished report

- [ ] Given the fifth section finishes, when the worker records it, then the report becomes `done` if all five sections succeeded, `partial` if one to four failed, and `failed` if all five failed. Exactly one worker sets the terminal status. Check: `npx vitest run src/db.test.ts src/handlers/generateSection.test.ts` passes.
- [ ] Given the built read handler, when Node imports it as ESM, then it loads without a module-resolution error. Check: `npm run build && REPORTS_TABLE=x node --input-type=module -e "await import('./dist/handlers/getReport.js')"` exits 0.

### Story 4: Bounded cost and failure

- [ ] Given the deployment template, the section queue has a 540 s visibility timeout and a dead-letter queue with `maxReceiveCount: 3`. The worker has a 90 s timeout and a maximum concurrency of 10. `POST /reports` requires an API key under a 100-a-day usage plan. Check: the `grep` chain in Task 7's acceptance criteria exits 0.

### Story 5: Observable operations

- [ ] Given each operation runs once, successfully and then failing, the in-memory recorder shows one duration observation with the matching `operation.outcome` and, on failure, one failures increment with the exact `error.type`. Check: `npx vitest run src/metrics.test.ts src/handlers` passes.

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports.create.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | `POST /reports` handler |
| `reports.create.failures` | Counter | none | `error.type` (`invalid_input`, `idempotency_conflict`, `upstream_error`, `internal`, `_OTHER`) | `POST /reports` handler |
| `reports.section.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | section worker |
| `reports.section.failures` | Counter | none | `error.type` (`upstream_error`, `upstream_timeout`, `rate_limited`, `internal`, `_OTHER`) | section worker |
| `reports.model_call.duration` | Histogram | seconds | `server.address` (`api.example-llm.com`), `operation.outcome` (`ok`, `error`) | model client, called from the section worker |
| `reports.ready.duration` | Histogram | seconds | `operation.outcome` (`ok` = `done`, `error` = `partial` or `failed`) | section worker, when it sets the terminal status |
| SQS `ApproximateNumberOfMessagesVisible` / `ApproximateAgeOfOldestMessage` | Gauge | `{message}` / seconds | queue name (section queue, dead-letter queue) | platform-native (CloudWatch SQS metrics) |
| Lambda `Duration` / `Errors` / `ConcurrentExecutions` | — | — | function name | platform-native (CloudWatch Lambda metrics) |

Histogram boundaries:

- `reports.create.duration` uses the OpenTelemetry request-scale boundaries (14 bounds).
- `reports.section.duration` and `reports.model_call.duration` use `[1, 5, 10, 20, 30, 45, 60, 75, 90]` (9 bounds).
- `reports.ready.duration` uses `[15, 30, 60, 90, 120, 180, 300, 600, 1800]` (9 bounds).

Estimated series:

- `POST /reports` (accept): 39 per operation — histogram 2 × 17 = 34, plus 5 `error.type` values.
- Section generation: 53 per operation — histogram 2 × 12 = 24, plus 5 `error.type` values, plus the model-call histogram 1 × 2 × 12 = 24.
- Report time-to-ready: 24 per operation (histogram 2 × 12).

All figures are per reporting instance.

**Attributes:** registers `operation.outcome` (`ok`, `error`), `error.type` (the closed list below) and `server.address` (`api.example-llm.com`) as the first `.flow/metrics.md` `## Attributes` rows.

### Error types

New closed list, seeded from the starter values plus one new value:

- `_OTHER`
- `internal`
- `invalid_input` — client-caused
- `idempotency_conflict` — client-caused; the same `Idempotency-Key` was sent with a different company
- `rate_limited` — the model API returned `429`
- `upstream_error` — the model API returned `5xx`, a non-429 `4xx` or a malformed body, or the queue send failed
- `upstream_timeout` — the model call exceeded 75 s

### Dashboard panels

All on the new "reports-api overview" dashboard (spec-only):

- Request rate, success vs failure, failures by `error.type`, and latency p50/p95/p99 for `reports.create` and `reports.section`.
- Model-call latency p95.
- Report time-to-ready p50/p95.
- Queue depth and oldest-message age for the section queue (platform-native, `max`).
- Dead-letter queue depth (platform-native).

### Alerts

| Signal | Condition | Sustained for | Action | Routes to | Dashboard |
| --- | --- | --- | --- | --- | --- |
| Section queue oldest-message age | above 600 s | 10 min | page | `#reports-api-alerts` (placeholder channel name — owner to rename) | reports-api overview (spec-only, no URL yet) |
| Dead-letter queue depth | above 0 | 5 min | notify | `#reports-api-alerts` (placeholder channel name — owner to rename) | reports-api overview (spec-only, no URL yet) |

The new SLO also gets the standard burn-rate tiers, recorded once in `.flow/metrics.md`.

### SLO

New journey SLO, "generate a company report", over 30 days:

- Availability SLI: share of reports that reach `done`, out of all reports reaching a terminal status. Target 99%.
- Latency SLI: share of reports reaching a terminal status within 300 s. Target 95%.

Client-caused `error.type` values are excluded.

**As-code:** spec-only — the repo keeps no dashboard, alert or SLO files (the tree is six files: `AGENTS.md`, `package.json`, `template.yaml`, `src/db.ts`, `src/llm.ts`, `src/handlers/getReport.ts`). `## Backend` is recorded as `none yet — suggested: OpenTelemetry SDK`, so these metrics stay in the in-memory recorder until a backend is chosen.

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | HTTP handler (new `POST /reports`), queue consumer (new section worker), persistence (extend `src/db.ts`), outbound model client (harden `src/llm.ts`), infrastructure (`template.yaml`), metrics (new helper) |
| Domain modules | Existing: `src/db.ts`, `src/llm.ts`, `src/handlers/getReport.ts`. New: `src/sections.ts` (the five section names and the message payload type), `src/queue.ts` (section enqueue and visibility change), `src/metrics.ts`, `src/handlers/createReport.ts`, `src/handlers/generateSection.ts` |
| Data flow | A caller request writes a parent report item holding five child section entries. Five queue messages each drive one model call, then one conditional section write; the last writer sets the terminal status. The caller reads the same item through the existing `GET /reports/{id}` |
| Pattern | Follows the flow-system-design "multi-section work" row: one queued task per step plus a parent status row. The parent and its children live in one table item, because the table has a single `id` hash key [anchor: template.yaml:13] and five sections fit well under the item size limit. New queue and worker pattern, justified by the 29 s ceiling against 20-60 s calls |
| Binary-framing check | Generating in the request and returning the report, or accepting and polling: the middle option, one long-running request with the five calls in parallel, still needs 20-60 s against a 29 s ceiling, so it is not viable here (see Decision analysis). This is genuinely a two-way choice on this platform |
| Report id | If `Idempotency-Key` is present, the id is a UUID-formatted SHA-256 of `<apiKeyId>:<Idempotency-Key>`, so keys are scoped per caller. Otherwise it is `crypto.randomUUID()` |
| Message payload | `{ "version": 1, "reportId": string, "section": SectionName }` — versioned so the payload survives deploys |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| Accept report request (`POST /reports`) | ~400 ms | inline — ~400 ms, timeout 10 s (function) | 10 s function; 3 s abort signal on each table and queue call | none server-side; the client re-posts with the same `Idempotency-Key` (AWS SDK default retries on the infrastructure calls only) | API key id + `Idempotency-Key` → report id, conditional put `attribute_not_exists(id)` | new usage-plan quota: 100 requests a day per API key, 1 rps, burst 2; fixed fan-out of exactly 5 sections |
| Generate one section (queue consumer) | ~65 s | queue — one message per section, worker invoked synchronously by the event source with batch size 1 | 90 s worker; queue visibility 540 s (above the 90 s worker timeout) | SQS redrive only: `maxReceiveCount` 3; backoff set through a visibility change of 30 s and then 120 s, ±20% jitter; no retries in the model client | `<reportId>:<section>` — the conditional section write requires the section to be `pending`, and a `done`/`failed` section makes no model call | at most 3 paid calls per section and 15 per report; event-source maximum concurrency 10; inherits the usage-plan quota |
| Model API call | ~60 s | inline inside the worker, timeout 75 s | 75 s abort signal (below the 90 s worker timeout) | none at this layer (the queue is the one retry layer) | inherits `<reportId>:<section>` | counted inside the section bound |
| Finalize report status | ~50 ms | inline — ~50 ms, timeout 3 s | 3 s abort signal | none (a conditional no-op on a repeat) | report id; conditional on status not already terminal | none (no paid call) |
| Read report (`GET /reports/{id}`, existing) | ~50 ms | inline — ~50 ms, timeout 29 s (unchanged) | unchanged | none | n/a (read) | none (no paid call) |

**Platform:** aws

**Proportionality:**

- No Step Functions: a fixed five-way fan-out is what a plain queue already covers.
- No application spend ledger: the usage-plan quota plus the three-attempt cap gives a computed per-key bound of 1,500 calls a day.
- No dead-letter consumer: the worker marks the section `failed` on its final attempt, so the dead-letter queue is only for inspection and re-drive.
- No streaming and no webhook: polling suits work that takes tens of seconds.
- No per-section metric attribute: it would put the section histogram over 100 series.
- No retention job (candidate follow-up).

**Recovery:**

- Reports table: enable point-in-time recovery (Task 7). The restore check is a quarterly drill, written in `docs/recovery.md`: restore to a scratch table, then compare item counts. Generated sections are regenerable at about 5 paid calls per report, but the request record and its paid text are worth keeping.
- Section queue and dead-letter queue: none — messages are regenerable by re-posting the report. The dead-letter queue keeps messages for 14 days so a failure can be inspected and re-driven.

## Technical Constraints

- **Request ceiling.** Requests and functions are capped at 29 s [anchor: template.yaml:6], and API Gateway REST integrations default to 29 s (aws.md in flow-system-design). No paid model call may run inside `POST /reports`.
- **Model latency and cost.** Model calls take 20-60 s and are paid [anchor: src/llm.ts:1]. The worker timeout (90 s) is above the model-call timeout (75 s), and the queue visibility timeout (540 s) is above the worker timeout: deadlines shrink inward.
- **New runtime dependency.** `AGENTS.md` says "No new runtime dependencies without a reason". The one new runtime dependency is `@aws-sdk/client-sqs`, from the AWS SDK v3 family the service already uses [anchor: package.json:11]. It is needed to send section messages and to change message visibility for backoff. Everything else (`typescript`, `vitest`, `@types/aws-lambda`, `@types/node`) is a dev dependency.
- **ESM imports.** `"type": "module"` [anchor: package.json:5] means every relative import needs a `.js` extension, and `tsconfig.json` uses `module`/`moduleResolution` `NodeNext` so the compiler enforces it.
- **Item size.** All five sections live in one item. DynamoDB caps an item at 400 KB (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html), so the worker truncates any section text over 60,000 characters and sets `truncated: true` on that section. Five sections at the cap stay under the limit.
- **At-least-once delivery.** Standard SQS delivers at least once (aws.md in flow-system-design). The worker must check the section's status before the paid call, and it writes conditionally after the call.
- **Prompt input.** The company name is placed directly into the model prompt [anchor: src/llm.ts:5]. Input is trimmed, limited to 1-200 characters, and has control characters stripped.
- **Cost.** Each report costs 5 paid model calls nominally and 15 at most. Time-to-ready is about the slowest section (20-60 s), not the sum (100-300 s).

## Open Questions

- [ ] **Q1.** Which five sections does a report contain? A redirect changes only the `SECTION_NAMES` constant (Task 4) and the prompt text each section sends; the plan is unchanged. The user said only "five sections".
  - **Stakes:** user — the section list is the report's whole content; the wrong five make every report miss what its reader needs
  - **Needs user input:** user-held preference or subjective taste — the report's content outline is the owner's editorial call. The plan ships placeholders (overview, products and services, market and competition, financial performance, risks and outlook).
- [ ] Should `POST /reports` answer immediately (`202` plus polling) rather than with the finished report? A redirect to the finished report in one response cannot be built on this platform (Decision analysis). A redirect to "stream progress" would add a streaming channel on top of the same queue.
  - **Stakes:** both — callers must poll instead of waiting on one response, and the alternative drops requests at 29 s and re-pays on retry
  - **Recommended:** `202` with a `Location` header and polling of the existing `GET /reports/{id}` — the 20-60 s per-call latency against the 29 s request ceiling rules out any in-request generation [confidence: high] [anchor: src/llm.ts:1]
- [ ] What may a report request carry? A redirect to add fields (ticker, region, language) changes validation (Task 5), the stored item (Task 4) and the prompt (Task 2).
  - **Stakes:** user — a caller cannot disambiguate two companies with the same name
  - **Recommended:** `{ "company": string }` only, 1-200 characters — the model client already takes exactly a company name and a section [confidence: high] [anchor: src/llm.ts:2]
- [ ] Who may call `POST /reports`, and with what cap? A redirect removes `ApiKeyRequired`/`UsagePlan` (Task 7) or changes the quota numbers.
  - **Stakes:** both — without a cap an anonymous caller can trigger unbounded paid calls (cost, the brief's rank 2); too tight a quota rejects legitimate callers (user experience, rank 1)
  - **Recommended:** require an API key with a usage plan of 100 requests a day, 1 rps, burst 2 per key — this is the only place a cost cap can sit without a new ledger, and quota numbers can be raised with no redeploy of code [confidence: medium] [anchor: weighing: risk — every request fans out to 5-15 paid calls, and the endpoint would otherwise be open to the internet]
- [ ] Must callers send an `Idempotency-Key`? A redirect to "required" adds a `400` branch to Task 5; a redirect to "not supported" removes the id derivation and the `422` branch.
  - **Stakes:** both — without a key, a network retry pays for a second report (cost); requiring one adds a header every caller must remember (user experience)
  - **Recommended:** optional — honoured when sent, and a random id otherwise — because the brief ranks user experience over cost, and the usage-plan quota already bounds duplicate spend [confidence: medium] [anchor: weighing: risk — duplicate spend without a key is bounded by the per-key quota, while a required header breaks every first-time caller]
- [ ] When a section still fails after retries, should the report show the other sections or fail as a whole? A redirect to all-or-nothing changes `finalizeReport` (Task 4) to set `failed` on any failure and hide section text.
  - **Stakes:** user — the reader either gets four useful sections or nothing for a report that was already 80% paid for
  - **Recommended:** show the succeeded sections under a `partial` status, with each failed section's failure class — the brief's product-quality priority asks for graceful degradation, and discarding paid sections wastes cost [confidence: medium] [anchor: weighing: reversibility — a caller can treat `partial` as failed on its side, while discarded text cannot be recovered]
- [x] Error body shape — follow the existing `{ "error": string }` shape the read handler already returns [anchor: src/handlers/getReport.ts:8]
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision A — where do the five model calls run?** These branches are mutually exclusive execution models.

| Branch | End-user flow (what the caller sees, sends, waits for) | System flow | Interruptions per run |
| --- | --- | --- | --- |
| A1. In the request, sequential (literal reading) | Sends `POST /reports`, waits; at 29 s gets a gateway timeout and no report | 1-2 calls finish and are paid, then the function is killed and the result is lost; a retry starts over | 1 blocking wait of 29 s that always fails |
| A2. In the request, five calls in parallel | Sends `POST /reports`, waits 20-60 s; any call over 29 s produces a timeout, so most requests fail | 5 paid calls per attempt, all lost on timeout | 1 blocking wait of 20-60 s, failing whenever one call exceeds 29 s |
| A3. Accept, then one queued job per report (sequential calls in one worker) | Gets `202` plus an id in under 1 s; polls; the report is ready after 100-300 s | 1 message → 1 worker making 5 calls in series; a retry re-runs every section unless it is checkpointed | 0 interruptions — polling only |
| A4. Accept, then one queued job per section (recommended) | Gets `202` plus an id in under 1 s; polls; sections appear as they finish; ready in about 20-60 s | 5 messages → 5 workers in parallel; a retry re-runs only the failed section; a finished section is never re-paid | 0 interruptions — polling only |
| A5. Accept, then a Step Functions Standard workflow with a Map over sections | Same as A4 | Exactly-once steps and a visual history, but a new service, a state-machine definition and a new SDK client to start executions | 0 interruptions — polling only |

Ranked: A4 > A5 > A3 > A2 > A1.

- A4 and A5 tie for the caller. A4 wins on footprint: a fixed five-way fan-out is what the flow-system-design workflows guidance says a plain queue covers, without adding an engine.
- A3 is five times slower and re-pays finished sections on a retry.
- A1 and A2 cannot complete under the 29 s ceiling.

Verdict: **A4 — accept with `202` and run one queued job per section** — the only branch that is both fast for the caller (the brief's rank 1) and never re-pays a finished section (rank 2) without adding a workflow engine [confidence: high] [anchor: template.yaml:6]

## Recommendation

**Reconsider scope** — build `POST /reports` as accept-then-generate (`202` plus polling, one queued job per section; Decision A, Open Question 2) instead of generating in the request. The plan also bundles simplify fixes to the model client (timeout and status check), the read handler (ESM import), the template (missing variable and permission) and the toolchain (missing build and test tools). [confidence: high] [anchor: src/llm.ts:1]

**Redundancy:** none found — the only write function, `saveReport`, is an unused unconditional put with no generation logic [anchor: src/db.ts:11]

## Plan risks

The weakest assumption is that the model API accepts up to 10 concurrent calls, five per report. Its rate limits are unknown: the client sends no API key or tier information [anchor: src/llm.ts:3]. If the provider throttles at lower concurrency, sections cycle through `rate_limited` retries and reports end `partial`. The mitigations are that one setting (the worker's maximum concurrency) is the single knob, and that `rate_limited` is visible on its own failures-by-type panel.

## Cut list

- nothing — plan is minimal: every component traces to a hard constraint.
  - The 29 s ceiling requires the queue.
  - At-least-once delivery requires the section key.
  - Paid fan-out requires the quota and attempt cap.
  - The broken toolchain and template are prerequisites for shipping at all.

  A spend ledger, Step Functions, streaming, a dead-letter consumer and per-section metric attributes were already left out (Proportionality).

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Require an API key on the report read | Medium | Small | Needs its own design/decision session: the open decision is whether report reads are scoped to the API key that created the report, which changes the read contract for existing callers | Adjacent — this plan secures report creation but leaves reads public | No |
| Retention window for stored reports | Low | Small | Needs its own design/decision session: the open decision is how long a generated report must stay readable, which is a product commitment to callers | Adjacent — this plan starts writing reports, so the table starts to grow | No |

- [ ] Require an API key on the report read — `GET /reports/{id}` needs no credentials; decide whether reads are scoped to the API key that created the report.
  - **UX:** none
  - **Problem:** anyone holding a report id can read the report; ids are random UUIDs, so exposure requires the id to leak [anchor: template.yaml:19]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk; nothing shows an id has leaked [anchor: template.yaml:19]
  - **Complexity:** Small — one template setting plus an ownership check in the read handler
  - **Risk:** Medium — breaks any current caller of the read that has no API key
  - **If never done:** a leaked report id stays readable indefinitely by anyone
  - **Verdict:** below bar — the risk is latent behind unguessable ids, and the change breaks the read contract, so it needs the owner's decision first
- [ ] Retention window for stored reports — stored reports never expire; choose a window and add a table expiry attribute.
  - **UX:** none
  - **Problem:** the reports table has no expiry attribute, so every generated report is stored forever [anchor: template.yaml:8]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent cost with no measured table size yet [anchor: template.yaml:8]
  - **Complexity:** Small — one table setting plus an expiry attribute written at create time
  - **Risk:** Low
  - **If never done:** storage cost grows linearly with reports created
  - **Verdict:** below bar — no measured cost yet, and the retention window is a product promise only the owner can make

# Task breakdown

### Task 1: Build and test toolchain, and the ESM import fix

- **Skill:** `flow-testing`
- **Bundled:** the `test`/`build` scripts reference uninstalled tools, and the existing read handler's extensionless import fails under Node ESM — both surfaced during discovery
- **Description:** Add the dev toolchain so `npm run typecheck`, `npm run build` and `npx vitest run` work. Set the compiler to emit ESM into `dist/` to match the template's `dist/handlers/*.handler` paths, and fix the existing extensionless relative import.
- **Inputs:** `package.json`, `src/handlers/getReport.ts`
- **Outputs:** a compiling project with a working test runner; `dist/handlers/getReport.js` loads under Node
- **Contract:**
  - **Files:**
    - edit `package.json`: `devDependencies` adds `typescript`, `vitest`, `@types/aws-lambda`, `@types/node`; `scripts` adds `"typecheck": "tsc --noEmit"`; `build` stays `tsc`; `test` stays `vitest`
    - create `tsconfig.json`: `target` `ES2022`, `module` `NodeNext`, `moduleResolution` `NodeNext`, `strict` `true`, `rootDir` `src`, `outDir` `dist`, `exclude` `["**/*.test.ts"]`
    - edit `src/handlers/getReport.ts`
  - **Interfaces:** none new
  - **Call-site edits:** `src/handlers/getReport.ts` — `from "../db"` becomes `from "../db.js"`
- **Acceptance criteria:** `npm install && npm run typecheck && npm run build && REPORTS_TABLE=x node --input-type=module -e "await import('./dist/handlers/getReport.js')"`

### Task 2: Harden the model client

- **Skill:** `flow-system-design`
- **Bundled:** the model client saves an error response as an `undefined` section and has no timeout — an objective bug found during discovery
- **Description:** Add an explicit timeout, a non-2xx check, response-shape validation and a typed failure class that the worker maps to retry-or-fail. Do not add retries here; the queue is the one retry layer.
- **Inputs:** Task 1 toolchain; `src/llm.ts`
- **Outputs:** a model client that either returns a string or throws a classified `LlmError`
- **Contract:**
  - **Files:** edit `src/llm.ts`
  - **Interfaces:**
    - `export type LlmErrorKind = "timeout" | "rate_limited" | "upstream_error" | "invalid_response"`
    - `export class LlmError extends Error { readonly kind: LlmErrorKind; readonly retryable: boolean; readonly status?: number }`. `retryable` is true for `timeout`, `rate_limited` and `5xx` `upstream_error`, and false for a non-429 `4xx` and for `invalid_response`.
    - `export async function generateSection(company: string, section: string, opts?: { timeoutMs?: number }): Promise<string>`. The default `timeoutMs` is `75_000`, applied with `AbortSignal.timeout`. It throws `LlmError` when the response is not ok or when `text` is not a string.
    - `export const MODEL_HOST = "api.example-llm.com"`
  - **Call-site edits:** none (no existing caller)
- **Acceptance criteria:** `npm run typecheck && grep -q 'AbortSignal.timeout' src/llm.ts && grep -q 'export class LlmError' src/llm.ts`

### Task 3: Metrics helper and metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create the repo-local metrics helper with a zero-dependency in-memory recorder. Give it a closed `ErrorType` union and a typed attribute map mirroring `.flow/metrics.md`, and create that file.
  - Metrics: `reports.create.duration`/`.failures`, `reports.section.duration`/`.failures`, `reports.model_call.duration`, `reports.ready.duration`.
  - `error.type` values: `_OTHER`, `internal`, `invalid_input`, `idempotency_conflict`, `rate_limited`, `upstream_error`, `upstream_timeout`.
  - `.flow/metrics.md` sections, with the content from this plan's `## Instrumentation`:
    - `## Backend` `none yet — suggested: OpenTelemetry SDK`
    - `## Namespace` `reports`
    - `## Attributes`, `## error.type values`, `## Helper` `src/metrics.ts`
    - `## Dashboard panels`, `## Dashboards`, `## Alerts`, `## As-code` `spec-only`
    - `## SLOs` (the "generate a company report" journey) and `## Coverage` (the three operations)
- **Inputs:** Task 1 toolchain
- **Outputs:** `src/metrics.ts`, `.flow/metrics.md`
- **Contract:**
  - **Files:** create `src/metrics.ts`; create `.flow/metrics.md`
  - **Interfaces:**
    - `export type ErrorType = "_OTHER" | "internal" | "invalid_input" | "idempotency_conflict" | "rate_limited" | "upstream_error" | "upstream_timeout"`
    - `export type Operation = "reports.create" | "reports.section" | "reports.ready"`
    - `export async function instrument<T>(op: Operation, fn: () => Promise<T>, classify: (e: unknown) => ErrorType): Promise<T>`, which records `<op>.duration` with `operation.outcome`, and `<op>.failures` with `error.type` on throw
    - `export function recordDuration(name: string, seconds: number, attrs: Attributes): void`
    - `export function recordFailure(op: Operation, errorType: ErrorType): void`
    - `export interface Recorder { histogram(name: string, value: number, attrs: Attributes): void; counter(name: string, attrs: Attributes): void }`
    - `export function setRecorder(r: Recorder): void`
    - `export function createMemoryRecorder(): Recorder & { observations: Array<{ name: string; value: number; attrs: Attributes }>; counts: Array<{ name: string; attrs: Attributes }> }`
  - **Call-site edits:** none (consumers arrive in Tasks 5 and 6)
- **Acceptance criteria:** `npm run typecheck && test -f .flow/metrics.md && grep -q 'idempotency_conflict' .flow/metrics.md && grep -q 'idempotency_conflict' src/metrics.ts`

### Task 4: Report persistence and section definitions

- **Skill:** `flow-system-design`
- **Description:** Define the five section names (placeholders until Q1 is answered) and the versioned message payload. Extend the persistence module with:
  - a conditional create
  - a section write that only succeeds while the section is `pending`, which increments the done or failed count atomically and returns the counts
  - a best-effort `queued` → `running` transition
  - a single-winner finalize that derives `done`/`partial`/`failed`

  Every table call gets a 3 s abort signal. Truncate section text over 60,000 characters with `truncated: true`.
- **Inputs:** Task 1 toolchain; `src/db.ts`
- **Outputs:** typed report persistence API
- **Contract:**
  - **Files:** create `src/sections.ts`; edit `src/db.ts`
  - **Interfaces:**
    - `export const SECTION_NAMES = ["overview", "products_and_services", "market_and_competition", "financial_performance", "risks_and_outlook"] as const` (placeholders, Q1)
    - `export type SectionName = (typeof SECTION_NAMES)[number]`
    - `export type SectionMessage = { version: 1; reportId: string; section: SectionName }`
    - `export function parseSectionMessage(body: string): SectionMessage`, which throws on an unknown version or section
    - `export type ReportStatus = "queued" | "running" | "done" | "partial" | "failed"`
    - `export type SectionState = { status: "pending" | "done" | "failed"; text?: string; truncated?: boolean; error?: ErrorType }`
    - `export type ReportItem = { id: string; company: string; status: ReportStatus; sections: Record<SectionName, SectionState>; doneCount: number; failedCount: number; createdAt: string; updatedAt: string; completedAt?: string }`
    - `export async function createReport(item: ReportItem): Promise<{ created: true } | { created: false; existing: ReportItem }>`, using a conditional put `attribute_not_exists(id)`
    - `export async function markRunning(id: string): Promise<void>`, conditional on `status = queued`, which swallows the condition failure
    - `export async function recordSection(id: string, section: SectionName, state: SectionState): Promise<{ applied: boolean; doneCount: number; failedCount: number; createdAt: string }>`, conditional on `sections.<s>.status = pending`, with `ADD doneCount|failedCount :one`
    - `export async function finalizeReport(id: string, status: "done" | "partial" | "failed"): Promise<boolean>`, conditional on `status IN (queued, running)`
  - **Call-site edits:** none — the existing `getReport` and `saveReport` keep their signatures
- **Acceptance criteria:** `npm run typecheck && grep -q 'attribute_not_exists' src/db.ts && grep -q 'export const SECTION_NAMES' src/sections.ts`

### Task 5: `POST /reports` handler and section enqueue

- **Skill:** `flow-system-design`
- **Description:**
  - Validate the body (`company`: string, trimmed, 1-200 characters, control characters stripped).
  - Read an optional `Idempotency-Key` header (1-255 characters, case-insensitive name).
  - Derive the report id from the API key id plus the key, or use a random UUID.
  - Conditionally create the report with five `pending` sections, then send five messages in one batch.
  - Responses:
    - `202` with `Location` and body `{ id, status, sections: SECTION_NAMES }`
    - `400` on invalid input
    - `422` on a same-key/different-company replay
    - a same-key replay re-sends messages only while the report is `queued`
    - `503` with `Retry-After: 5` when the batch send reports any failed entry; when no idempotency key was given, mark that report `failed` first
  - Wrap the handler in `instrument("reports.create", …)`.
- **Inputs:** Tasks 3 and 4; new: `src/queue.ts`
- **Outputs:** the `POST /reports` handler and the queue module
- **Contract:**
  - **Files:** create `src/handlers/createReport.ts`; create `src/queue.ts`; edit `package.json` (`dependencies` adds `@aws-sdk/client-sqs`)
  - **Interfaces:**
    - `export const handler: APIGatewayProxyHandler`
    - `export function deriveReportId(apiKeyId: string, idempotencyKey: string): string` (UUID-formatted SHA-256)
    - `export async function enqueueSections(reportId: string): Promise<void>`, which throws when `SendMessageBatch` returns any `Failed` entry and uses `process.env.SECTION_QUEUE_URL`
    - `export async function delayRetry(receiptHandle: string, seconds: number): Promise<void>` (`ChangeMessageVisibility`)
  - **Call-site edits:** none (new entry point; wired in Task 7)
- **Acceptance criteria:** `npm run typecheck && npm run build && test -f dist/handlers/createReport.js`

### Task 6: Section worker

- **Skill:** `flow-system-design`
- **Description:** SQS-triggered handler with batch size 1, idempotency key `<reportId>:<section>` and a 75 s model-call timeout inside a 90 s worker timeout. Per message:
  1. Parse it with `parseSectionMessage`, then load the report. If the report is missing or the section is not `pending`, return without a model call.
  2. Call `markRunning`, then `generateSection(company, section, { timeoutMs: 75_000 })` timed as `reports.model_call.duration` with `server.address = MODEL_HOST`.
  3. On success, `recordSection` the section as `done`.
  4. On `LlmError`:
     - If it is retryable and `ApproximateReceiveCount < 3`, call `delayRetry` with 30 s on attempt 1 and 120 s on attempt 2 (±20% jitter), then rethrow.
     - Otherwise, `recordSection` the section as `failed` with its mapped `error.type` and return.
  5. When `doneCount + failedCount === 5`, call `finalizeReport` (`done` if `failedCount === 0`, `failed` if `doneCount === 0`, else `partial`). If it wins, record `reports.ready.duration` from `createdAt`.

  Wrap the handler in `instrument("reports.section", …)`. The `LlmError` → `error.type` mapping is `timeout` → `upstream_timeout`, `rate_limited` → `rate_limited`, and everything else → `upstream_error`.
- **Inputs:** Tasks 2, 3, 4 and 5 (`src/queue.ts` for `delayRetry`)
- **Outputs:** the section worker entry point
- **Contract:**
  - **Files:** create `src/handlers/generateSection.ts`
  - **Interfaces:**
    - `export const handler: SQSHandler`
    - `export const MAX_ATTEMPTS = 3`
    - `export function backoffSeconds(attempt: number, rand?: () => number): number` (30 s, then 120 s, ±20%)
  - **Call-site edits:** none (new entry point; wired in Task 7)
- **Acceptance criteria:** `npm run typecheck && npm run build && test -f dist/handlers/generateSection.js && grep -q 'MAX_ATTEMPTS = 3' src/handlers/generateSection.ts`

### Task 7: Infrastructure — queue, functions, API key, recovery

- **Skill:** `flow-system-design`
- **Bundled:** the existing read function's missing table-name variable and read policy, plus point-in-time recovery on the reports table, both surfaced during discovery
- **Description:** Wire the new functions, the queue (with must-set visibility timeout and dead-letter queue), the API-key usage plan and table recovery into the template. Write the restore drill. Run `sam validate --lint` before committing.
- **Inputs:** Tasks 5 and 6 (handler paths)
- **Outputs:** a deployable template and a restore runbook
- **Contract:**
  - **Files:** edit `template.yaml`; create `docs/recovery.md`
  - **Key paths, before → after:**
    - `Globals.Function.Environment.Variables`: absent → `REPORTS_TABLE: !Ref ReportsTable`, `SECTION_QUEUE_URL: !Ref SectionQueue`
    - `Globals.Api.Auth.UsagePlan`: absent → `CreateUsagePlan: PER_API`, `Quota: { Limit: 100, Period: DAY }`, `Throttle: { RateLimit: 1, BurstLimit: 2 }`
    - `Resources.ReportsTable.Properties.PointInTimeRecoverySpecification`: absent → `PointInTimeRecoveryEnabled: true`
    - `Resources.SectionDeadLetterQueue`: absent → `Type: AWS::SQS::Queue`, `MessageRetentionPeriod: 1209600`
    - `Resources.SectionQueue`: absent → `Type: AWS::SQS::Queue`, `VisibilityTimeout: 540`, `RedrivePolicy: { deadLetterTargetArn: !GetAtt SectionDeadLetterQueue.Arn, maxReceiveCount: 3 }`
    - `Resources.GetReportFunction.Properties.Policies`: absent → `[DynamoDBReadPolicy: { TableName: !Ref ReportsTable }]`
    - `Resources.CreateReportFunction`: absent → `Handler: dist/handlers/createReport.handler`, `Timeout: 10`, `Policies: [DynamoDBCrudPolicy (ReportsTable), SQSSendMessagePolicy (SectionQueue.QueueName)]`, `Events.Api: { Type: Api, Properties: { Path: /reports, Method: post, Auth: { ApiKeyRequired: true } } }`
    - `Resources.GenerateSectionFunction`: absent → `Handler: dist/handlers/generateSection.handler`, `Timeout: 90`, `Policies: [DynamoDBCrudPolicy (ReportsTable), SQSPollerPolicy (SectionQueue.QueueName)]`, `Events.Queue: { Type: SQS, Properties: { Queue: !GetAtt SectionQueue.Arn, BatchSize: 1, ScalingConfig: { MaximumConcurrency: 10 } } }`
    - `docs/recovery.md`: new — a quarterly restore drill. Run `aws dynamodb restore-table-to-point-in-time` into a scratch table, compare `aws dynamodb describe-table --query Table.ItemCount` against the source, then delete the scratch table.
  - **Call-site edits:** none
- **Acceptance criteria:** `grep -q 'maxReceiveCount: 3' template.yaml && grep -q 'VisibilityTimeout: 540' template.yaml && grep -q 'MaximumConcurrency: 10' template.yaml && grep -q 'ApiKeyRequired: true' template.yaml && grep -q 'PointInTimeRecoveryEnabled: true' template.yaml && grep -q 'DynamoDBReadPolicy' template.yaml && test -f docs/recovery.md && sam validate --lint`

### Task 8: Unit tests — model client, metrics helper, persistence

- **Skill:** `flow-testing`
- **Description:**
  - Model client, with a mocked `fetch`: ok, timeout, `429`, `500`, `400` and a body missing `text`.
  - Metrics helper (the conventions emission recipe):
    - a success records one duration observation with `operation.outcome=ok` and no failure
    - each `error.type` branch records `operation.outcome=error` plus exactly one failures increment
    - an unlisted error maps to `_OTHER`
  - Persistence, with the document client's `send` mocked through `vi.mock`:
    - conditional create returns `existing` on a duplicate
    - `recordSection` returns `applied: false` when the section is not pending
    - `finalizeReport` returns `false` for the second caller
    - text over 60,000 characters is truncated with `truncated: true`
- **Inputs:** Tasks 2, 3 and 4
- **Outputs:** three passing test files
- **Contract:**
  - **Files:** create `src/llm.test.ts`, `src/metrics.test.ts`, `src/db.test.ts`
  - **Interfaces:** none new — the tests target the Task 2-4 exports
  - **Call-site edits:** none
- **Acceptance criteria:** `npx vitest run src/llm.test.ts src/metrics.test.ts src/db.test.ts`

### Task 9: Handler tests — accept and section worker, with emission

- **Skill:** `flow-testing`
- **Description:**
  - `createReport`, with persistence and queue mocked: every Story 1 criterion — `202` plus `Location` plus five sends, `400` with no writes, same-key replay with the same id, `422` on a different company, `503` with `Retry-After` on a partial batch failure — plus emission of `reports.create.duration` and `reports.create.failures` (`invalid_input`, `idempotency_conflict`, `upstream_error`) against the in-memory recorder.
  - `generateSection`, with the model client, persistence and queue mocked:
    - every Story 2 and Story 3 criterion: a single model call per pending section; no call for a `done`/`failed` section; a retryable failure on receive count 1 calls `delayRetry` with 30 s ±20% and rethrows; a retryable failure on receive count 3 records `failed` without throwing; a permanent failure records `failed` on attempt 1
    - finalize to `done`/`partial`/`failed`
    - emission of `reports.section.*`, `reports.model_call.duration` with `server.address` and `reports.ready.duration`
- **Inputs:** Tasks 5 and 6
- **Outputs:** two passing test files
- **Contract:**
  - **Files:** create `src/handlers/createReport.test.ts`, `src/handlers/generateSection.test.ts`
  - **Interfaces:** none new — the tests target the Task 5-6 handlers with mocked modules
  - **Call-site edits:** none
- **Acceptance criteria:** `npx vitest run src/handlers && npm run typecheck`

| Task | Depends on |
| ---- | ---------- |
| 1    | —          |
| 2    | 1          |
| 3    | 1          |
| 4    | 1, 3       |
| 5    | 3, 4       |
| 6    | 2, 3, 4, 5 |
| 7    | 5, 6       |
| 8    | 2, 3, 4    |
| 9    | 5, 6       |

### Skills Summary

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-system-design | Yes (Tasks 2, 4, 5, 6, 7) | Queue-driven paid work: timeouts, one retry layer, idempotency key, cost bound, must-set queue settings |
| flow-metrics | Yes (Task 3) | First instrumented change; creates the helper and `.flow/metrics.md` |
| flow-testing | Yes (Tasks 1, 8, 9) | Test toolchain plus unit and emission tests |
| flow-new-feature | No (implicit) | Drives the implement phase; not a per-task skill |
| flow-refactoring | No | The existing-code changes are bug fixes inside feature tasks, not behaviour-preserving restructuring |
| flow-ui-ux | No | No UI surface; the API has no client in this repo |
| flow-verify | No (implicit) | Runs as the pipeline's verify phase, not a task |

# PR description draft

## TLDR

Callers can now create company reports, which nothing could do before: `POST /reports` returns an id within a second, and the five sections generate in the background, appearing on the report read as each finishes.

## User-facing changes

- New endpoint: `POST /reports` with a body of `{ "company": "<name>" }` accepts a report request and answers `202 Accepted` with the report id, a `Location` header pointing at `GET /reports/{id}`, and the five section names, each `pending`.
- New behaviour on the existing report read: `GET /reports/{id}` now shows a report's progress (`queued`, `running`, then `done`, `partial` or `failed`) and each section's own status, with the section text as soon as that section finishes.
- New request header: sending the same `Idempotency-Key` with a repeated `POST /reports` returns the original report instead of paying for a second one; reusing a key for a different company is rejected with `422`.
- `POST /reports` requires an API key (`x-api-key`) and is limited per key to 100 report requests a day, 1 request a second with bursts of 2; callers over the limit get `429`.
- Bad input is rejected before any paid work: a missing, empty or over-200-character company name returns `400`.
- The existing report read now gets a table name and read permission on deploy:
  - **Before:** the read was deployed without the table name or permission to read the table, so it could not return a stored report.
  - **After:** the read is deployed with both, so it returns the stored report or `404`.

## System changes

- Report generation moved out of the request:
  - **Before:** the service had no way to produce a report, and generating one in the request would hit the 29-second request ceiling after one or two of five model calls.
  - **After:** the request stores the report and queues one generation task per section. Section workers run up to 10 at a time and write each section as it finishes, so a report is ready in roughly the time of its slowest section (20-60 s) instead of the sum of all five (100-300 s).
- Retries live in one place. A failed section is retried by the queue at most three times in total, waiting about 30 s and then about 120 s between attempts. After the last attempt the section is marked failed and the rest of the report still completes.
- Ongoing cost: each report costs 5 paid model calls normally and at most 15 in the worst case (every section on its last retry). A runaway caller is capped at 100 reports a day per API key, so one key's worst case is 1,500 calls a day.
- The reports table now has point-in-time recovery enabled. That adds a small per-GB storage charge in exchange for being able to restore after an operator mistake.
- A new metrics contract records how long it takes to accept a request, generate a section, call the model and get a report ready, plus failures by class. Nothing graphs these yet, because no metrics backend has been chosen.

## Why

Reports could be read but never created. Each report needs five model-written sections that take 20-60 seconds apiece and cost money, and the service's front door drops any request after 29 seconds. A caller waiting on a single request for all five would be cut off partway through, lose sections that were already paid for, and likely retry and pay again.

## Key decisions

- **Accept now, generate in the background, instead of generating in the request.** The 29-second request ceiling falls below even one slow model call, so the request returns `202` with the report id and the caller polls the existing report read. Generating in the request, even with the five calls run in parallel, cannot finish in time.
- **One queued task per section, instead of one task per report.** If a section fails, only that section is retried. A report takes about as long as its slowest section rather than all five combined, and a section that already finished is never paid for twice. A managed workflow engine was not adopted, because a fixed five-way fan-out is exactly what a plain queue already covers.
- **Show partial results instead of all-or-nothing.** If a section still fails after its retries, the report ends as `partial` with the other four sections readable. It does not throw away four paid sections.
- **The spend cap is enforced where requests come in: an API key plus a daily usage-plan quota.** Together with the three-attempt limit per section, that gives a computed worst case per key. A separate application-level spend ledger was left out for now.
- **One new runtime dependency, the AWS SQS client from the AWS SDK family the service already uses.** It is needed to queue section tasks and to delay a retry, which the project guide requires a reason for.
- Bundled: a timeout, a status check and failure classification for the model client. Before this change, a model error response would have been saved as an empty section.
- Bundled: the existing report read's missing table name and read permission.
- Bundled: a build and test toolchain (the project's test and build scripts referenced tools that were not installed). Also fixes the module imports that Node would refuse to load once built.
- Bundled: point-in-time recovery on the reports table, plus a written restore drill.
- Out of scope: requiring an API key on the report read, a retention window for old reports, streaming section text as it is written, and letting callers choose their own sections.

## Instrumentation

New metrics contract (spec-only, no dashboard URL yet): request accept duration and failures, per-section generation duration and failures, model-call duration, and report time-to-ready. Panels for these plus the platform's own queue-depth, oldest-message-age and dead-letter-depth signals are specced on a "reports-api overview" dashboard. There is a new journey SLO, "generate a company report" (99% of reports reach `done`, 95% within 300 s, over 30 days), with the standard burn-rate tiers and two saturation alerts (oldest message older than 10 minutes, any dead-lettered message). These metrics are recorded through an in-memory recorder and won't appear on any graph until a metrics backend is chosen; that choice is recorded as open in the new metrics contract.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `npm install && npm run typecheck && npm run build && test -f dist/handlers/createReport.js && test -f dist/handlers/generateSection.js`. Expect exit 0: the service compiles and both new entry points are emitted.
- [ ] Run `node --input-type=module -e "await import('./dist/handlers/getReport.js')"` with `REPORTS_TABLE=x` set. Expect exit 0: the built read handler loads under Node's module rules.
- [ ] Run `npx vitest run src/handlers/createReport.test.ts`. Expect the accept specs to pass: `202` with a `Location` header and five queued sections, `400` on bad input with nothing stored or queued, same-key replay returning the same id, and `422` on a same-key/different-company request.
- [ ] Run `npx vitest run src/handlers/generateSection.test.ts`. Expect the section specs to pass: one model call per section, no model call on a redelivered finished section, a retry with backoff on a transient failure, a failed section on the final attempt, and the report ending `done`, `partial` or `failed`.
- [ ] Run `npx vitest run src/llm.test.ts`. Expect the model-client specs to pass: timeout, `429`, `5xx`, `4xx` and malformed-body cases each raise the expected failure class.
- [ ] Run `npx vitest run src/db.test.ts src/metrics.test.ts`. Expect the persistence and metrics specs to pass: conditional create, the section write skipped when the section is not pending, a single finalizer, and one duration observation plus one failure increment per failure class.
- [ ] Run `grep -q 'maxReceiveCount: 3' template.yaml && grep -q 'VisibilityTimeout: 540' template.yaml && grep -q 'MaximumConcurrency: 10' template.yaml && grep -q 'ApiKeyRequired: true' template.yaml && grep -q 'PointInTimeRecoveryEnabled: true' template.yaml`. Expect exit 0: the queue, concurrency, API-key and recovery settings are present.
- [ ] Run `sam validate --lint`. Expect exit 0: the deployment template is valid (requires the AWS SAM CLI installed locally; no AWS credentials needed).
- [ ] DECISION: you accept that `POST /reports` answers with a report id and the caller polls `GET /reports/{id}` for the finished sections, instead of a single response that contains the finished report.
