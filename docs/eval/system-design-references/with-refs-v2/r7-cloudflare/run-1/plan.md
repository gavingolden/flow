# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question (the platform ceilings this plan turns on are already cited in the system-design Cloudflare reference, retrieved 2026-11-04); force with `flow feature create --research`.

# Nightly report refresh

**Goal:** Every saved report carries sections regenerated within the last day, with nightly model spend capped and failed refreshes visible instead of corrupting a report.

## Problem Statement

Saved company reports are written once and then never change, so their content ages from the day each was created. This service cannot regenerate a report at all today: it only serves stored text. Readers see reports of unknown age with no promise that any of it is current, and the owner has no bulk way to bring them up to date.

| Evidence | What it shows |
| --- | --- |
| [anchor: src/index.ts:5-16] | The worker has only a request handler (get one report, list reports); no scheduled or background entry point exists. |
| [anchor: src/db.ts:12-16] | A section writer exists but nothing calls it (`grep -rn saveSections src` → only its definition). |
| [anchor: src/llm.ts:1-9] | The model client exists but nothing calls it; each call takes 20-60 s, costs money, and has no timeout and no failure check — a failed response would be stored as an empty section. |
| [anchor: src/db.ts:3] | A report row holds only the company, the five section texts as a JSON array, and a last-updated time. The five section *names* are recorded nowhere. |

Who is affected, in the product brief's ranked terms: readers (priority 1, user experience — "fewer things the user has to re-check") get reports that are no more than a day old; the owner (priority 2, cost) takes on a new recurring paid-call bill of five model calls per saved report per night, which this plan caps.

## Request vetting

- **Hypothesis:** Regenerating all five sections every night makes reports measurably more current, and that freshness is worth five paid model calls per saved report per night.
- **Case against:** The model is sent nothing but the section name and the company name [anchor: src/llm.ts:6] — no new source data enters the prompt — so unless the provider itself draws on live information, nightly regeneration rewords the same facts at full cost (~150 calls per report per month); the system-design guidance also warns a periodic paid loop needs one spend cap and a visible failed state, neither of which exists in this repo today [anchor: wrangler.toml].
- **Sources:** https://developers.cloudflare.com/workers/platform/limits/ (scheduled-invocation wall time) and https://developers.cloudflare.com/queues/platform/limits/ (consumer limits), via the system-design Cloudflare reference; the live-data question is unverifiable from the repo (blind judge, high: "cannot be determined from the repository").
- **Verdict:** adopt-with-conditions: nightly model calls never exceed the configured nightly call cap, and a report is overwritten only when all five of its sections regenerated successfully that night

## Existing-code assessment

- **src/index.ts (worker entry point):** keep — add scheduled and queue entry points beside the existing request handler; the request routes are untouched [anchor: src/index.ts:5]
- **src/db.ts (D1 persistence):** keep — the refresh's persistence calls follow the same prepare/bind style; the unused section writer is superseded by an atomic swap that also keeps the previous text [anchor: src/db.ts:12]
- **src/llm.ts (model client):** simplify — add a per-call timeout, check the response status, and raise a typed error before it is called in a loop; today a failed call returns `undefined` text [anchor: src/llm.ts:3-8]
- **wrangler.toml (deploy config):** keep — extend with a cron trigger, a queue with dead-letter queue, and the call-cap variable [anchor: wrangler.toml:1-8]

## Scope Boundary

**In scope:**

- A nightly scheduled refresh of every saved report (every row the "list reports" route returns).
- Regenerating all five sections per report through a durable queue, one message per report, with per-section checkpoints so a retry never re-pays for a finished section.
- One nightly paid-call cap enforced at a single point before every model call.
- An all-or-nothing swap: a report's text and last-updated time change only when all five new sections exist; the previous text is kept beside the run for 30 days.
- A per-report, per-night run record showing queued / running / done / failed and the failure class.
- Hardening the model client (timeout, status check, typed failure classes).
- Metrics for the tick, each report refresh, and each model call; a staleness signal; the repo's first metrics contract file.

**Out of scope:**

- An on-demand "refresh this report now" endpoint, or any new public route.
- Changing what the model is asked or feeding it fresh source data (see Q3).
- Skipping reports nobody reads (candidate follow-up).
- Choosing a metrics backend or building dashboards (spec only).
- Authentication on the existing read routes.

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| A report's text and "last updated" time never change after it is first stored. | A report's text and "last updated" time change once per night (after 03:00 UTC) when all five sections regenerated. |
| — | If a night's refresh fails for a report, that report keeps yesterday's text and time unchanged — never a mix of old and new sections. |

### System flow

- **Before:**
  - The worker answers read requests only; the model client and section writer are dead code.
- **After:**
  - A nightly tick creates one run record per saved report and enqueues one message per report; it never calls the model itself.
  - A queue consumer claims the run, generates the missing sections in parallel (each call reserved against the nightly cap and bounded by a timeout), checkpoints each finished section, and swaps the report atomically when all five exist.
  - Transient failures retry through the queue only (3 retries, capped backoff); permanent failures, budget exhaustion and final attempts mark the run failed with a named failure class; crashes land on a dead-letter queue.
  - Run records older than 30 days are pruned by the tick.

**Lost:** each night's swap replaces the report's previous text; it survives only in that night's run record for 30 days (and in database point-in-time restore), not in the live report.

## User Stories / Acceptance Criteria

### Story 1: Reports refresh nightly

- [ ] Given three saved reports, when the nightly tick runs, then three run records exist for that UTC date in `queued` state and three queue messages were sent — asserted by `npx vitest run test/refresh.test.ts`.
- [ ] Given the tick fires twice for the same date, when both complete, then still exactly three run records exist — asserted by `npx vitest run test/refresh.test.ts`.
- [ ] Given a queued run and a model stub returning five texts, when the consumer processes its message, then the report's sections equal the five texts in order, its last-updated time advanced, and the run is `done` with the old text kept as `previous_sections_json` — asserted by `npx vitest run test/refresh.test.ts`.

### Story 2: Failures never corrupt a report

- [ ] Given a model stub that fails section 3 with a 503, when the consumer processes the message, then the report is unchanged, sections 1, 2, 4, 5 are checkpointed, the run is back to `queued`, and the message is retried — asserted by `npx vitest run test/refresh.test.ts`.
- [ ] Given that retried message, when the stub now succeeds, then exactly one more model call is made (section 3 only) and the report swaps — asserted by `npx vitest run test/refresh.test.ts`.
- [ ] Given a 401 from the model, or a fourth failed attempt, when the consumer processes the message, then the run is `failed` with the matching failure class and the message is acknowledged, not retried — asserted by `npx vitest run test/refresh.test.ts`.
- [ ] Given a duplicate message for a run another consumer holds, when it is processed, then no model call is made and it is acknowledged — asserted by `npx vitest run test/refresh.test.ts`.

### Story 3: Spend is capped

- [ ] Given a nightly cap of 7 calls and two queued reports, when both are processed, then exactly 7 model calls are made and the run left short is `failed` with `budget_exhausted` — asserted by `npx vitest run test/refresh.test.ts`.
- [ ] Given a model call that never answers, when 90 s elapse, then the call aborts with `upstream_timeout` — asserted by `npx vitest run test/llm.test.ts` with fake timers.

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports.refresh.tick.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | nightly tick |
| `reports.refresh.tick.failures` | Counter | none | `error.type` (7 listed values) | nightly tick |
| `reports.refresh.report.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | queue consumer, per report |
| `reports.refresh.report.failures` | Counter | none | `error.type` (7 listed values) | queue consumer, per report |
| `reports.llm.generate.duration` | Histogram | seconds | `server.address` (`api.example-llm.com`), `operation.outcome` (`ok`, `error`) | model client |
| `reports.llm.generate.failures` | Counter | none | `server.address` (`api.example-llm.com`), `error.type` (7 listed values) | model client |
| `reports.refresh.last_success.time` | Gauge | seconds (Unix time) | none | queue consumer, on each successful swap |
| queue backlog and oldest-message age | Gauge | `{message}` / seconds | `messaging.destination.name` (`report-refresh`, `report-refresh-dlq`) | platform-native (Cloudflare Queues metrics) |

Histograms use explicit job-scale bounds `[1, 5, 10, 20, 30, 45, 60, 90, 120, 300]` (10 bounds).

Estimated series: 33 per operation for the tick (2 x 13 + 7)
Estimated series: 33 per operation for the per-report refresh (2 x 13 + 7)
Estimated series: 33 per operation for the model call (1 host x 2 x 13 + 1 host x 7), plus 1 for the staleness gauge

**Attributes:** registers `operation.outcome`, `error.type`, `server.address` (closed list: `api.example-llm.com`), `messaging.destination.name` (closed list: `report-refresh`, `report-refresh-dlq`)

### Error types

New list (first metrics contract in the repo): `_OTHER` (fallback), `internal` (unexpected failure in this worker), `not_found` (the report was deleted between tick and consume), `rate_limited` (the model answered 429), `upstream_error` (the model answered another failure or an unreadable body), `upstream_timeout` (the model did not answer within 90 s), `budget_exhausted` (the nightly call cap was reached — not an outage, excluded from the freshness SLO's error budget only when the owner deliberately lowered the cap).

### Dashboard panels

On a new "reports-worker overview" dashboard (spec only): reports refreshed vs failed per night; failures by `error.type`; per-report refresh p50/p95/p99; model-call p50/p95/p99 and failures; age of the last successful refresh; queue backlog and dead-letter depth.

### Alerts

| Signal | Condition | Sustained for | Action | Routes to | Dashboard |
| --- | --- | --- | --- | --- | --- |
| Refresh staleness | now − `reports.refresh.last_success.time` > 48 h | 15 min | notify | `reports-owner` | reports-worker overview |
| Dead-letter depth | `report-refresh-dlq` backlog > 0 | 15 min | notify | `reports-owner` | reports-worker overview |
| Budget exhausted | `reports.refresh.report.failures{error.type=budget_exhausted}` > 0 in a night | 0 min | notify | `reports-owner` | reports-worker overview |

### SLO

New journey SLO "saved reports stay fresh": 99% of saved reports refreshed successfully within 24 h of each nightly tick, over 30 days, with the standard burn-rate tiers recorded once in `.flow/metrics.md`.

**As-code:** spec-only — the repo keeps no dashboard or alert config, and no metrics backend is chosen yet (suggested: Workers Analytics Engine); these metrics are recorded through an in-memory recorder and will not show on any graph until a backend is chosen.

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | D1 schema (two new tables), persistence, model client, a new refresh orchestration module, worker entry points, deploy config |
| Domain modules | Existing: reports persistence, model client, entry point. New: refresh orchestration (tick + consumer), metrics helper |
| Data flow | Saved reports → nightly tick → one run record + one queue message per report → consumer → five model calls (capped, checkpointed) → atomic swap into the report |
| Pattern | New: scheduler-enqueues-one-task-per-unit + idempotent queue consumer with a claim lease, per the system-design guidance; persistence follows the existing prepare/bind style in src/db.ts |
| Binary-framing check | Not a binary request; the unit-of-work fork (per section / per report / workflow engine) is in Decision analysis, and the middle option (per report with per-section checkpoints) is the pick |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| Nightly tick | ~5 s for 1,000 reports | scheduler-enqueue: cron tick creates run records and enqueues one message per report; never calls the model | platform 15 min wall time; tick itself targets < 1 min | none (next night re-runs; a re-fired tick is a no-op by key) | `report_id` + UTC `run_date` (run-record primary key, insert-or-ignore) | no paid call; seeds the new nightly spend ledger row |
| Per-report refresh (queue consumer) | ~95 s (five parallel calls) | durable queue `report-refresh`, batch size 1, max concurrency 5, dead-letter queue `report-refresh-dlq` | 15 min claim lease < platform 15 min consumer wall time; each model call 90 s | queue only: 3 retries, exponential backoff 60 s → 600 s cap with up to 30 s jitter; permanent failures not retried | `report_id` + `run_date`, claimed with a conditional lease update; each section checkpointed by index | new nightly spend ledger, reserved before every call |
| Model call | ~60 s | called only from the consumer | 90 s abort | none at this layer (queue owns retries) | covered by the section checkpoint | new nightly spend ledger: `UPDATE … SET calls = calls + 1 WHERE day = ? AND calls < cap` |

**Platform:** cloudflare

**Proportionality:** no workflow engine (a fixed five-way fan-out a queue already handles); no per-section messages (one consumer owns a report's fan-in, so no concurrent-assembler guard); no outbox (a re-fired tick re-enqueues every still-queued run and the consumer dedupes); no per-tenant caps (single owner); no status endpoint (the existing report route already returns the last-updated time).

**Recovery:** the regenerated text is regenerable at a known cost (five calls per report), but each swap overwrites the previous text, so the swap first copies it into that night's run record (`previous_sections_json`, kept 30 days); restore one report with `UPDATE reports SET sections_json = (SELECT previous_sections_json FROM report_refresh_runs WHERE report_id = ? AND run_date = ?) WHERE id = ?`, and the whole database with D1 Time Travel point-in-time restore (https://developers.cloudflare.com/d1/reference/time-travel/); the restore path is checked by a test that swaps then restores a report (Task 7). The two new tables are operational state and need nothing beyond that.

## Technical Constraints

- The nightly tick must not call the model: a scheduled invocation has a 15-minute wall-time limit, and five 20-60 s calls per report would exhaust it after a handful of reports (https://developers.cloudflare.com/workers/platform/limits/; [anchor: src/llm.ts:1]).
- `waitUntil` is not a fallback for generation: it extends execution by at most 30 s after a response (same source).
- Queue consumers get 15 minutes wall time per invocation and messages are retried 3 times by default, then dropped unless a dead-letter queue is configured — so the dead-letter queue is a must-set setting (https://developers.cloudflare.com/queues/configuration/dead-letter-queues/).
- The model API key stays a Worker secret (`LLM_API_KEY`, already on the environment type) and never enters a queue payload [anchor: src/index.ts:3].
- The repo has no typecheck step (no `tsconfig.json`, no `@cloudflare/workers-types`), so the closed failure-class list is enforced by tests, not the compiler [anchor: package.json:6-9].
- The `reports` table is created outside this repo; the migration adds new tables only and must not recreate or alter it [anchor: src/db.ts:3].
- Cost: adds up to five paid model calls per saved report per night (about 150 per report per month), never more than the nightly cap.

## Open Questions

- [ ] **Q1** What are the five section names, in stored order? The plan puts them in one constant list the prompt and the stored array both follow; a redirect changes only that list.
  - **Stakes:** user — wrong or reordered names write wrong content into every report every night, and reorder existing sections (priority 1, user experience).
  - **Needs user input:** a user-held product fact — the names appear nowhere in the repo; stored reports hold only the texts [anchor: src/db.ts:3].
- [ ] **Q2** What nightly model-call cap should the refresh enforce? The plan ships the cap as one deploy variable; a redirect changes its value.
  - **Stakes:** both — too low leaves reports stale every night; too high lets a retry storm or a growing report count run up the bill (priority 2, cost).
  - **Needs user input:** a user-held budget preference; per-call price is not in the repo. Suggested starting point: saved reports x 5 x 1.25.
- [ ] **Q3** Does the model service draw on current information? If not, nightly regeneration rewords the same facts; a "no" moves the cron to weekly or makes this plan a candidate for feeding fresh source data instead.
  - **Stakes:** both — the whole feature's value to readers (priority 1) against ~150 calls per report per month (priority 2).
  - **Needs user input:** an external fact the agent cannot verify — the endpoint is not documented in the repo, and a blind second-opinion judge agreed it cannot be determined from the repository.
- [ ] When one section fails for good, should the report keep all of yesterday's text, or take the four new sections plus one old one? A redirect changes the swap rule and the run's final state.
  - **Stakes:** user — a mixed report would show a fresh "last updated" time over a stale section (product brief precondition: truthfulness).
  - **Recommended:** keep yesterday's text whole (all-or-nothing) — the timestamp then always describes every section [confidence: medium] [anchor: weighing: risk — a partial swap makes the last-updated time false for one section]
- [ ] When should the nightly refresh run? A redirect changes one cron string.
  - **Stakes:** user — readers checking reports mid-refresh see a mix of refreshed and unrefreshed reports.
  - **Recommended:** 03:00 UTC daily (`0 3 * * *`) — off-peak for European and American business hours; cron runs on UTC [confidence: medium] [anchor: weighing: risk — off-peak hour minimizes readers seeing a half-refreshed set]
- [ ] Which reports count as "saved"? A narrower reading would add a filter to the tick.
  - **Stakes:** system — refreshing rows that are not meant to be kept wastes paid calls (priority 2, cost).
  - **Recommended:** every row in the reports table — the existing "list saved reports" query returns every row with no filter [confidence: high] [anchor: src/db.ts:9]
- [ ] How many reports refresh at once? A redirect changes one queue setting.
  - **Stakes:** system — too high hits the model provider's rate limit (failures marked `rate_limited`, retried); too low stretches the nightly window.
  - **Recommended:** max concurrency 5 consumers (25 model calls in flight), raised later from the rate-limited failure count — retries are bounded and the setting is one line [confidence: medium] [anchor: weighing: reversibility — a one-line queue setting tuned from the `rate_limited` metric]
- [ ] Should tests run against a real local D1 (Cloudflare's Workers test pool, a new dev-only dependency) or a hand-written fake? A redirect changes the test harness task.
  - **Stakes:** system — a fake would not exercise the JSON-update, lease and transactional-swap SQL the refresh's correctness rests on.
  - **Recommended:** the Workers test pool with the migration applied — it runs the real SQL; it is dev-only, so the "no new runtime dependencies" rule is untouched [confidence: medium] [anchor: weighing: risk — the lease and atomic swap are SQL-level guarantees a fake cannot check]
- [x] A report saved after the night's tick waits for the next night — resolved without asking
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision A — what is one unit of queued work?** Exclusive (one must be picked). Friction: 0 interruptions per run on every branch — fully automated, the owner sees only metrics and run records.

| Branch | System flow | Retry cost | Moving parts |
| --- | --- | --- | --- |
| A1: one message per section (5 per report) | tick sends 5N messages; five consumers each write one section; the last finisher assembles | only the failed section | needs a guarded "only one assembler" update, since five consumers race to finish |
| A2: one message per report, sections checkpointed (middle) | tick sends N messages; one consumer runs five calls in parallel, checkpoints each, swaps when all five exist | only the failed section (checkpoint skips the rest) | one owner per report; no assembly race; ~95 s per invocation, far inside 15 min |
| A3: Cloudflare Workflows, one instance per report | tick creates N workflow instances; each step persisted and retried by the engine | only the failed step | adds a workflow engine for a fixed fan-out; failure state lives in the engine, not beside the report in D1 |

Ranked: A2 > A1 > A3. Verdict: **A2 — one message per report with per-section checkpoints** — same retry cost as A1 with no concurrent-assembler race, and no engine for a fixed pipeline a queue already handles [confidence: medium] [anchor: weighing: footprint — one consumer owns a report's fan-in, removing the assembly guard A1 needs].

## Recommendation

**Proceed** — build the nightly refresh as one message per report through a capped, checkpointed queue with an all-or-nothing swap, simplifying the model client first; resolve Q1 (section names) before implementation and Q3 (live data) before relying on the nightly cadence [confidence: medium] [anchor: weighing: risk — the cap and all-or-nothing swap bound the two failure modes the Request vetting names]

**Redundancy:** none found — the worker has no scheduled, queue, or regeneration path today [anchor: src/index.ts:5-16]

## Plan risks

The single weakest assumption is that regenerating text from an unchanged prompt makes reports more current (Q3): if the model service has no live data, the feature spends ~150 calls per report per month to reword the same facts, and readers see churn rather than freshness.

## Cut list

- nothing — plan is minimal: the queue, lease, checkpoint, cap and dead-letter queue are each the system-design minimum for a periodic paid loop, and the plan already declined per-section messages, a workflow engine, an outbox and a status endpoint.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Skip the nightly refresh for reports nobody has opened recently | Medium | Medium | needs its own design/decision session: the open decision is what inactivity window marks a report dormant, given the worker records no report views today | narrows which reports this refresh pays for | No |

- [ ] Skip the nightly refresh for reports nobody has opened recently — record report views and refresh only reports read within a chosen window.
  - **UX:** none
  - **Problem:** every saved report costs five paid calls every night whether or not anyone reads it [anchor: src/db.ts:9]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired cost risk; no measured share of unread reports exists yet [anchor: src/db.ts:9]
  - **Complexity:** Medium — a view-tracking write on the read route, a new column, a filter in the tick
  - **Risk:** Medium — a wrong window silently stops refreshing reports people still use
  - **If never done:** spend scales with every saved report, read or not, bounded only by the nightly cap
  - **Verdict:** below bar — the nightly cap already bounds spend, and with no measured share of unread reports the saving is unquantified

# Task breakdown

### Task 1: Add refresh-run and spend-ledger tables

- **Skill:** `flow-system-design`
- **Description:** Create the D1 migration for per-report, per-night run records and the nightly model-call ledger. Does not touch the existing `reports` table. Recovery setup: the backup for the overwritten report text is the `previous_sections_json` column this migration adds (kept 30 days), and database-wide point-in-time recovery is D1 Time Travel, which is always on for D1 and needs no enabling; record both, plus the one-statement per-report restore from `### Runtime design`, as a header comment in the migration. The restore check is the swap-then-restore test in Task 7.
- **Inputs:** existing `reports` table [anchor: src/db.ts:3]
- **Outputs:** migration file applied by `wrangler d1 migrations apply reports`
- **Contract:**
  - **Files:** create `migrations/0001_report_refresh.sql`
  - **Interfaces (schema):**
    ```sql
    CREATE TABLE IF NOT EXISTS report_refresh_runs (
      report_id TEXT NOT NULL,
      run_date TEXT NOT NULL,                 -- UTC YYYY-MM-DD of the tick
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','running','done','failed')),
      sections_json TEXT NOT NULL DEFAULT '[null,null,null,null,null]',
      previous_sections_json TEXT,
      error_type TEXT,
      lease_until TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (report_id, run_date)
    );
    CREATE INDEX IF NOT EXISTS report_refresh_runs_date_status
      ON report_refresh_runs (run_date, status);
    CREATE TABLE IF NOT EXISTS llm_spend_ledger (
      day TEXT PRIMARY KEY,                   -- UTC YYYY-MM-DD
      calls INTEGER NOT NULL DEFAULT 0,
      cap INTEGER NOT NULL
    );
    ```
  - **Call-site edits:** none
- **Acceptance criteria:** `npx wrangler d1 migrations apply reports --local` exits 0 and `grep -qi 'point-in-time' migrations/0001_report_refresh.sql`

### Task 2: Configure the cron trigger, queue, dead-letter queue and call cap

- **Skill:** `flow-system-design`
- **Description:** Wire the nightly schedule, the refresh queue (producer + consumer) with its must-set dead-letter queue, and the nightly cap variable (value per Q2).
- **Inputs:** Task 1
- **Outputs:** deploy config the worker's new entry points bind to
- **Contract:**
  - **Files:** edit `wrangler.toml`
  - **Interfaces (config, before → after):**
    - `[triggers].crons`: absent → `["0 3 * * *"]`
    - `[[queues.producers]]`: absent → `binding = "REFRESH_QUEUE"`, `queue = "report-refresh"`
    - `[[queues.consumers]]`: absent → `queue = "report-refresh"`, `max_batch_size = 1`, `max_retries = 3`, `retry_delay = 60`, `max_concurrency = 5`, `dead_letter_queue = "report-refresh-dlq"`
    - `[vars].NIGHTLY_LLM_CALL_CAP`: absent → the Q2 value as a string
  - **Call-site edits:** none
- **Acceptance criteria:** `grep -q 'dead_letter_queue = "report-refresh-dlq"' wrangler.toml && grep -q '"0 3 \* \* \*"' wrangler.toml && grep -q NIGHTLY_LLM_CALL_CAP wrangler.toml`

### Task 3: Add the metrics helper and the metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create the repo-local helper (swappable recorder, in-memory by default, closed failure-class union with `_OTHER` fallback) and `.flow/metrics.md` with Backend `none yet — suggested: Workers Analytics Engine`, Namespace `reports`, the Attributes, error.type values, Dashboard panels, Alerts, SLO and Coverage from `## Instrumentation`. Planned metrics: `reports.refresh.tick.duration` / `.failures`, `reports.refresh.report.duration` / `.failures`, `reports.llm.generate.duration` / `.failures`, `reports.refresh.last_success.time`; error types `_OTHER`, `internal`, `not_found`, `rate_limited`, `upstream_error`, `upstream_timeout`, `budget_exhausted`.
- **Inputs:** none
- **Outputs:** the helper every runtime surface records through; the committed metrics contract
- **Contract:**
  - **Files:** create `src/metrics.ts`, create `.flow/metrics.md`
  - **Interfaces:**
    - `export type ErrorType = "_OTHER" | "internal" | "not_found" | "rate_limited" | "upstream_error" | "upstream_timeout" | "budget_exhausted"`
    - `export type Operation = "refresh.tick" | "refresh.report" | "llm.generate"`
    - `export interface Recorder { histogram(name: string, value: number, attrs: Record<string, string>): void; counter(name: string, inc: number, attrs: Record<string, string>): void; gauge(name: string, value: number, attrs: Record<string, string>): void }`
    - `export function setRecorder(r: Recorder): void`
    - `export function memoryRecorder(): Recorder & { records: Array<{ kind: "histogram" | "counter" | "gauge"; name: string; value: number; attrs: Record<string, string> }> }`
    - `export function toErrorType(err: unknown): ErrorType`
    - `export async function instrument<T>(op: Operation, fn: () => Promise<T>, attrs?: { "server.address"?: "api.example-llm.com" }): Promise<T>`
    - `export function recordLastSuccess(unixSeconds: number): void`
  - **Call-site edits:** none (callers arrive in Tasks 4 and 6)
- **Acceptance criteria:** `test -f .flow/metrics.md && grep -q budget_exhausted .flow/metrics.md && grep -q 'budget_exhausted' src/metrics.ts`

### Task 4: Harden the model client

- **Skill:** `flow-system-design`
- **Bundled:** the model client's missing timeout and unchecked failure response, surfaced during discovery (a failed call would store an empty section)
- **Description:** Add a 90 s abort, check the response status and body shape, and raise a typed error whose class maps 1:1 to the failure list and carries whether it is retryable (timeout, 429, 5xx → retryable; other 4xx, unreadable body → permanent). Emit the model-call metrics through the helper (Task 3).
- **Inputs:** Task 3's helper (`src/metrics.ts`)
- **Outputs:** a model client safe to call in a loop
- **Contract:**
  - **Files:** edit `src/llm.ts`
  - **Interfaces:**
    - `export const LLM_TIMEOUT_MS = 90_000`
    - `export class LlmError extends Error { constructor(readonly type: "upstream_timeout" | "rate_limited" | "upstream_error", readonly retryable: boolean, message: string) }`
    - `export async function generateSection(apiKey: string, company: string, section: string, opts?: { timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<string>` — throws `LlmError`; wrapped in `instrument("llm.generate", …, { "server.address": "api.example-llm.com" })`
  - **Call-site edits:** none yet (first caller is Task 6)
- **Acceptance criteria:** `npx wrangler deploy --dry-run --outdir /tmp/reports-worker-build` exits 0 and `grep -q 'AbortSignal.timeout' src/llm.ts`

### Task 5: Add refresh persistence

- **Skill:** `flow-system-design`
- **Description:** Add the run-record, lease, checkpoint, atomic-swap, ledger and pruning queries beside the existing ones. The swap is one D1 batch (transaction): copy the report's current text into the run's `previous_sections_json`, write the five new sections and `updated_at` into the report, mark the run `done`. Remove the now-superseded unused section writer.
- **Inputs:** Task 1
- **Outputs:** persistence functions the orchestration calls
- **Contract:**
  - **Files:** edit `src/db.ts`
  - **Interfaces:**
    - `export type RunStatus = "queued" | "running" | "done" | "failed"`
    - `export interface RefreshRun { reportId: string; runDate: string; status: RunStatus; sections: (string | null)[]; attempts: number; errorType: string | null }`
    - `export async function createRunsForDate(env: Env, reportIds: string[], runDate: string): Promise<void>` — `INSERT OR IGNORE`
    - `export async function listQueuedRunIds(env: Env, runDate: string): Promise<string[]>`
    - `export async function claimRun(env: Env, reportId: string, runDate: string, leaseMs: number, now: Date): Promise<RefreshRun | null>` — conditional update: status `queued`, or `running` with an expired lease; increments `attempts`
    - `export async function saveRunSection(env: Env, reportId: string, runDate: string, index: number, text: string): Promise<void>` — `json_set(sections_json, '$[' || ? || ']', ?)`
    - `export async function completeRun(env: Env, reportId: string, runDate: string): Promise<void>` — the atomic batch swap above
    - `export async function releaseRun(env: Env, reportId: string, runDate: string): Promise<void>` — back to `queued`, lease cleared
    - `export async function failRun(env: Env, reportId: string, runDate: string, errorType: string): Promise<void>`
    - `export async function ensureLedgerDay(env: Env, day: string, cap: number): Promise<void>` — `INSERT OR IGNORE`
    - `export async function reserveLlmCall(env: Env, day: string): Promise<boolean>` — `UPDATE llm_spend_ledger SET calls = calls + 1 WHERE day = ? AND calls < cap`; true when `meta.changes === 1`
    - `export async function pruneRunsBefore(env: Env, runDate: string): Promise<void>` — deletes run and ledger rows older than the date
  - **Call-site edits:** delete `saveSections` (no callers: `grep -rn saveSections src`)
- **Acceptance criteria:** `npx wrangler deploy --dry-run --outdir /tmp/reports-worker-build` exits 0 and `! grep -q 'export async function saveSections' src/db.ts`

### Task 6: Add the nightly tick and the queue consumer, and wire them into the worker

- **Skill:** `flow-system-design`
- **Description:** New orchestration module. The tick: compute the UTC run date, seed the ledger with the cap, create run records for every saved report, send one message per queued run in batches of 100, prune records older than 30 days; it never calls the model. The consumer: claim the run (ack if busy, finished or missing), load the report (fail `not_found` if gone), generate every missing section in parallel — each reserved against the ledger first (`budget_exhausted` when refused) — checkpoint each success, swap when all five exist and record last-success time; on a retryable failure below the final attempt release the run and retry with backoff `min(600, 60 x 2^(attempts-1))` s plus up to 30 s jitter; on a permanent failure, budget exhaustion or the fourth attempt, fail the run and ack. Idempotency key: `report_id` + `run_date`; per-call timeout 90 s; lease 15 min.
- **Inputs:** Tasks 2, 3, 4, 5; `REPORT_SECTIONS` names from Q1
- **Outputs:** the working nightly refresh
- **Contract:**
  - **Files:** create `src/refresh.ts`, edit `src/index.ts`
  - **Interfaces:**
    - `export const REPORT_SECTIONS: readonly [string, string, string, string, string]` (Q1)
    - `export const MAX_ATTEMPTS = 4` (1 + `max_retries = 3`)
    - `export const LEASE_MS = 15 * 60_000`
    - `export interface RefreshMessage { version: 1; reportId: string; runDate: string }`
    - `export type ConsumeResult = { action: "ack" } | { action: "retry"; delaySeconds: number }`
    - `export async function enqueueNightlyRefresh(env: Env, now: Date): Promise<{ runDate: string; enqueued: number }>` — wrapped in `instrument("refresh.tick", …)`
    - `export async function processRefreshMessage(env: Env, msg: RefreshMessage, attempts: number, now: Date, generate?: typeof generateSection): Promise<ConsumeResult>` — wrapped in `instrument("refresh.report", …)`
  - **Call-site edits:**
    - `src/index.ts` `Env`: add `REFRESH_QUEUE: Queue<RefreshMessage>; NIGHTLY_LLM_CALL_CAP: string`
    - `src/index.ts` default export: add `scheduled(event, env, ctx)` calling `enqueueNightlyRefresh(env, new Date(event.scheduledTime))`, and `queue(batch, env)` calling `processRefreshMessage` per message and applying `msg.ack()` / `msg.retry({ delaySeconds })`
- **Acceptance criteria:** `npx wrangler deploy --dry-run --outdir /tmp/reports-worker-build` exits 0 and `grep -q 'async scheduled' src/index.ts && grep -q 'async queue' src/index.ts`

### Task 7: Add the Workers test harness and persistence tests

- **Skill:** `flow-testing`
- **Description:** Add the dev-only Cloudflare Workers test pool so tests run against a local D1 with the Task 1 migration applied. Test: run creation is idempotent, the claim lease refuses a second claimer and admits one after expiry, section checkpoints land by index, the swap keeps the previous text and is all-or-nothing, the restore statement in Runtime design returns a report to its previous text, the ledger refuses the call after the cap, pruning deletes only old rows.
- **Inputs:** Tasks 1, 5
- **Outputs:** a working `npx vitest` setup plus persistence coverage
- **Contract:**
  - **Files:** edit `package.json` (devDependency `@cloudflare/vitest-pool-workers`, version compatible with `vitest ^3`), create `vitest.config.ts`, create `test/db.test.ts`
  - **Interfaces:** `vitest.config.ts` uses `defineWorkersConfig` with `wrangler.configPath: "./wrangler.toml"` and the migrations from `readD1Migrations("./migrations")` applied in a setup step
  - **Call-site edits:** none
- **Acceptance criteria:** `npx vitest run test/db.test.ts` exits 0

### Task 8: Test the model client and metrics emission

- **Skill:** `flow-testing`
- **Description:** With a stub `fetchImpl` and fake timers: success returns the text and records one `llm.generate` observation with `operation.outcome=ok`; 429 → `rate_limited` retryable; 503 → `upstream_error` retryable; 401 → `upstream_error` permanent; missing `text` field → `upstream_error` permanent; no answer for 90 s → `upstream_timeout`; each failure records one `error` observation plus one failures increment with that type; an unknown thrown value maps to `_OTHER`; the last-success gauge records the given value.
- **Inputs:** Tasks 3, 4, 7
- **Outputs:** client and emission coverage
- **Contract:**
  - **Files:** create `test/llm.test.ts`, create `test/metrics.test.ts`
  - **Interfaces:** none (tests only)
  - **Call-site edits:** none
- **Acceptance criteria:** `npx vitest run test/llm.test.ts test/metrics.test.ts` exits 0

### Task 9: Test the nightly tick and the queue consumer

- **Skill:** `flow-testing`
- **Description:** Cover every Story 1-3 criterion against local D1, a captured `REFRESH_QUEUE`, and a stub `generate`: tick creates N runs and N messages and is a no-op on re-fire; happy-path swap; one failed section → retry with only that section re-called next attempt; permanent failure and final attempt → `failed` + ack; duplicate message while leased → ack with no model call; cap of 7 over two reports → exactly 7 calls and one `budget_exhausted`; deleted report → `not_found`; per-report metrics recorded for each outcome.
- **Inputs:** Tasks 6, 7
- **Outputs:** orchestration coverage
- **Contract:**
  - **Files:** create `test/refresh.test.ts`
  - **Interfaces:** none (tests only)
  - **Call-site edits:** none
- **Acceptance criteria:** `npx vitest run test/refresh.test.ts` exits 0

| Task | Depends on |
| --- | --- |
| 1 | — |
| 2 | 1 |
| 3 | — |
| 4 | 3 |
| 5 | 1 |
| 6 | 2, 3, 4, 5 |
| 7 | 1, 5 |
| 8 | 3, 4, 7 |
| 9 | 6, 7 |

Execution order: 1 through 9 as numbered.

### Skills Summary

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-system-design | Yes (Tasks 1, 2, 4, 5, 6) | periodic paid loop: queue, lease, idempotency, retries, spend cap, recovery |
| flow-metrics | Yes (Task 3) | first instrumented change in the repo; creates the metrics contract and helper |
| flow-testing | Yes (Tasks 7, 8, 9) | new test harness plus unit and integration coverage |
| flow-new-feature | No | the implementation driver, not a per-task skill |
| flow-ui-ux | No | no UI surface |
| flow-refactoring | No | the only cleanup (model client) is bundled into Task 4 |

# PR description draft

## TLDR

Saved reports now regenerate all five sections every night under a fixed spend cap; before, a report's text never changed after it was first stored, and a failed refresh now leaves the report untouched.

## User-facing changes

- Every saved report is refreshed once a night (after 03:00 UTC), and its "last updated" time moves with it:
  - **Before:** a report's text and last-updated time never changed after it was first stored.
  - **After:** both change nightly when all five sections regenerated successfully.
- A refresh that fails for a report leaves yesterday's text and time in place — never a mix of old and new sections.

## System changes

- The worker gains a nightly schedule and a background queue; the schedule only queues one job per report, and the queue does the model calls, retrying transient failures up to three times before marking the report's run failed.
- Ongoing cost: up to five paid model calls per saved report per night (about 150 per report per month), never more than a nightly call cap enforced before every call.
- Each night's refresh keeps a run record per report (state, failure class, and the previous text for 30 days), so a bad refresh can be undone per report.
- The model client now times out after 90 seconds and treats a failed answer as an error:
  - **Before:** a failed call would have produced an empty section.
  - **After:** it raises a named failure the refresh records and retries or stops on.

## Why

Saved reports age from the day they are written and this service has no way to bring them up to date, so readers cannot tell how current a report is. The owner also has no bound on what keeping reports current would cost.

## Key decisions

- One queued job per report, with each finished section saved as it lands — a retry re-pays only for the section that failed, and one job owns a report's assembly, beating one job per section (needs a race guard) and a workflow engine (more machinery for a fixed five-step job).
- All-or-nothing swap — a report changes only when all five new sections exist, so its last-updated time is always true.
- One nightly call cap checked before every model call, rather than counters spread across call sites.
- The schedule never calls the model itself — a scheduled run has a 15-minute limit that five 20-60 second calls per report would exhaust.
- Out of scope: an on-demand refresh endpoint, feeding the model fresh source data, and skipping reports nobody reads.
- Bundled: the model client's missing timeout and unchecked failure response.
- Deploy note: the `report-refresh` and `report-refresh-dlq` queues must exist before deploy.

## Instrumentation

New metrics for the nightly tick, each report refresh, and each model call (duration split by success or error, failures by a closed failure list), plus a last-successful-refresh time and the platform's own queue backlog. Spec-only: a new "reports-worker overview" dashboard (refreshed vs failed per night, failures by type, refresh and model-call latency, staleness, queue and dead-letter depth); notify alerts on staleness over 48 hours, any dead-lettered job, and any night that hit the cap; a new "saved reports stay fresh" SLO of 99% refreshed within 24 hours. This PR creates the repo's first metrics contract; no metrics backend is chosen yet (suggested: Workers Analytics Engine), so these metrics are recorded in memory and will not appear on any graph until a backend is chosen.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `npx wrangler d1 migrations apply reports --local` — exits 0.
- [ ] Run `npx vitest run test/db.test.ts` — run records, lease, checkpoints, all-or-nothing swap, restore and spend cap pass.
- [ ] Run `npx vitest run test/llm.test.ts test/metrics.test.ts` — timeout, failure classes and metric emission pass.
- [ ] Run `npx vitest run test/refresh.test.ts` — nightly tick, retry of only the failed section, cap of 7 calls, duplicate-message and deleted-report cases pass.
- [ ] Run `npx wrangler deploy --dry-run --outdir /tmp/reports-worker-build` — the worker bundles with the new schedule and queue entry points.
- [ ] Run `grep -q 'dead_letter_queue = "report-refresh-dlq"' wrangler.toml && grep -q '"0 3 \* \* \*"' wrangler.toml` — the dead-letter queue and nightly schedule are configured.
- [ ] DECISION: you accept up to five paid model calls per saved report per night (about 150 per report per month), capped at the nightly call cap set in this PR.
