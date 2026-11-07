# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Reuse report summaries until the report changes

**Goal:** Opening a report's summary a second time costs no model call and returns instantly, until the report's content actually changes.

## Problem Statement

Every report has a short summary that readers open alongside it. Today the service asks the paid model to write that summary again every time anyone opens it, even though the report itself rarely changes. A popular report opened a few hundred times a day therefore pays for a few hundred identical summaries, and every one of those readers waits 5–15 seconds for text that was already produced minutes earlier.

This lands on the brief's top two priorities at once: **user experience** (a 5–15 s wait on every open) and **cost** (one paid call per open instead of one per change).

| Fact | Evidence |
| ---- | -------- |
| The summary route calls the model on every request, with no reuse | [anchor: src/app.ts:14] |
| Each summary call takes 5–15 s and is billed per call | [anchor: src/llm.ts:22] |
| Reports are edited occasionally but opened hundreds of times a day | [anchor: src/app.ts:7] |
| The summary depends only on the report's sections, not its title or company | [anchor: src/app.ts:14] |
| A failed model response is returned to the reader as a successful but empty summary (`200 {}`), because the client never checks the response status | [anchor: src/llm.ts:28] |

The stated premise holds: the code calls the model on every summary open, and the in-code comment corroborates the read-heavy traffic.

## Request vetting

- **Hypothesis:** A summary is fully determined by the report's sections, and sections change far less often than summaries are read, so a summary reused until the sections change cuts model calls from one per open to one per sections version per instance. [anchor: src/app.ts:7]
- **Case against:** The cache lives in each server instance's memory, so the saving divides by the number of running instances and resets on every restart, deploy, or scale-to-zero; the deploy script sets no instance ceiling, so the fleet-wide bound is unknown [anchor: deploy.sh:3]. Precomputing on save would also remove the first-open wait.
- **Rebuttal:** Reports themselves live in that same per-instance store [anchor: src/db.ts:9], so the summary has exactly the lifetime of the data it describes. The save path has no caller in this service [anchor: src/db.ts:15], so there is nowhere to precompute.
- **Sources:** no outside source: the research relevance gate judged this a pure-internal change; the case is grounded in committed repo files
- **Verdict:** adopt-with-conditions: a test shows exactly one model call across 50 sequential and 10 concurrent opens of an unchanged report, and exactly one new call after its sections change

## Existing-code assessment

- **src/app.ts summary route:** keep — the route shape and JSON error helper fit; it only needs to call a cached lookup and map a model failure to an error response [anchor: src/app.ts:14]
- **src/llm.ts model-API client:** simplify — three copies of the same request code with no timeout and no status check; extract one shared request helper before adding timing and failure classification [anchor: src/llm.ts:6]
- **src/db.ts report store:** keep — add a second map for summaries beside the existing report map [anchor: src/db.ts:9]

## Scope Boundary

**In scope:**

- Reuse a report's summary until its sections change, keyed on a fingerprint of the sections.
- Make concurrent first opens of the same report share one model call.
- Stop treating a failed model call as a successful empty summary. Return an error and never cache it.
- Put an explicit timeout on every model call.
- Add summary-lookup and model-call metrics, so the saving can be measured.

**Out of scope:**

- A cache shared across instances (e.g. Memorystore). See Decision analysis.
- Generating summaries ahead of time when a report is saved. See Alternatives considered.
- Browser or CDN caching headers.
- Capping the Cloud Run instance count. This is a candidate follow-up.
- Changes to the full-report response.

## Behavioral contrast

### User flow

| Before | After |
| ------ | ----- |
| Every open of a report's summary waits 5–15 s | The first open after a change waits 5–15 s; later opens return from memory immediately |
| Two readers who open the same report a minute apart may see two differently worded summaries | Every reader sees the same summary until the report's sections change |
| When the model API fails, the reader gets a successful response with no summary in it | When the model API fails, the reader gets an explicit "summary unavailable" error; the next open tries again |

### System flow

- **Before:**
  - Each summary request makes one paid model call: calls equal opens.
  - Model calls have no timeout. A hung upstream holds the request until the platform kills it.
  - Nothing records how often the model is called or how long it takes.
- **After:**
  - Each summary request first checks a stored summary keyed on the report id plus a fingerprint of its sections. Only a miss calls the model, and concurrent misses on one instance share one call.
  - Model calls end after a fixed timeout. Failed and timed-out calls surface as a 502 and are never stored.
  - Summary lookups and model calls are timed, so the hit ratio (the saving) can be read from the two counts.

**Lost:** Readers no longer get a freshly re-worded summary on each open of an unchanged report. A client that tolerated the old `200 {}` on upstream failure now receives a `502`.

## User Stories / Acceptance Criteria

### Story 1: Repeat opens reuse the summary

- [ ] Given a saved report with no stored summary, when its summary is requested 50 times in a row, then the model is called exactly once and all 50 responses carry the same text (`bun test src/summary.test.ts`)
- [ ] Given a saved report with no stored summary, when 10 summary requests arrive concurrently, then the model is called exactly once and all 10 resolve to the same text (`bun test src/summary.test.ts`)

### Story 2: A changed report gets a fresh summary

- [ ] Given a stored summary, when the report is saved with different sections, then the next summary request calls the model exactly once and returns the new text (`bun test src/summary.test.ts`)
- [ ] Given a stored summary, when the report is saved with only a new title, then the next summary request makes no model call (`bun test src/summary.test.ts`)

### Story 3: Failures are visible and never cached

- [ ] Given the model API answers with a non-2xx status, when the summary is requested, then the response is `502 {"error":"summary unavailable"}`, and a second request calls the model again (`bun test src/app.test.ts`)
- [ ] Given the model API does not answer within the timeout, when a summary call is made, then it rejects with an `upstream_timeout` error (`bun test src/llm.test.ts`)
- [ ] Given the model API answers 2xx with no string `text`, when a summary call is made, then it rejects with an `upstream_error` error (`bun test src/llm.test.ts`)

### Story 4: The saving is measurable

- [ ] Given a cache miss followed by a hit, when both requests complete, then the in-memory recorder holds two `reports.summary.duration` observations with `operation.outcome=ok` and one `reports.llm.summarize.duration` observation (`bun test src/summary.test.ts`)
- [ ] Given a failed model call, when the summary is requested, then the recorder holds one `reports.summary.duration` observation with `operation.outcome=error` and one `reports.summary.failures` increment with exactly that `error.type` (`bun test src/metrics.test.ts src/summary.test.ts`)

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| ------ | ---------- | ---- | -------------------------- | ---------- |
| `reports.summary.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | summary lookup (hit or miss) behind `GET /reports/{id}/summary` |
| `reports.summary.failures` | Counter | none | `error.type` (`_OTHER`, `upstream_error`, `upstream_timeout`) | summary lookup |
| `reports.llm.summarize.duration` | Histogram | seconds | `server.address` (`api.example-llm.com`), `operation.outcome` (`ok`, `error`) | model-API summarize call |

Histogram boundaries are explicit, because a lookup spans a sub-millisecond hit to a 30 s timeout: `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 7.5, 10, 15, 20, 30]` (15 bounds).

Estimated series: 39 per operation for `reports.summary` (histogram 2 outcomes x (15 + 3) = 36, plus 3 `error.type` values), per instance
Estimated series: 36 per operation for `reports.llm.summarize` (1 host x 2 outcomes x 18), per instance

No separate hit/miss counter is needed. The model-call count divided by the summary-lookup count is the miss ratio. Volume comes from histogram counts, per the conventions.

**Attributes:** registers `operation.outcome`, `error.type`, `server.address` (closed list: `api.example-llm.com`)

### Error types

New list, seeded from the starter values the service actually emits:

- `upstream_error`: the model API answered non-2xx or with no usable text.
- `upstream_timeout`: the model API did not answer within the timeout.
- `_OTHER`: the fallback.

None is client-caused.

### Dashboard panels

On a new "reports-service overview" dashboard (spec-only, no URL yet):

- Request rate, success vs failure, failures by `error.type`, and latency p50/p95/p99 for `reports.summary`.
- Latency p50/p95/p99 for `reports.llm.summarize`.
- A "Summary model-call ratio" panel: rate of `reports.llm.summarize.duration` count divided by rate of `reports.summary.duration` count. Lower is cheaper.

### Alerts

burn-rate tiers only

### SLO

New journey SLO "read a report summary": 99% availability over 30 days, from the `reports.summary.duration` outcome split, with the standard burn-rate tiers recorded once in `.flow/metrics.md`. A latency SLO waits until the hit ratio has been measured.

**As-code:** spec-only — the repo keeps no dashboard or alert config. Backend `none yet — suggested: Google Cloud Monitoring (OTLP route)`, since the service deploys to Cloud Run. These metrics are recorded in memory, and no graph shows them until a backend is chosen.

## Architecture Decisions

| Aspect | Decision |
| ------ | -------- |
| Layers touched | HTTP handler, persistence (report store), model-API client, new summary-cache module, new metrics helper |
| Domain modules | Existing `src/app.ts`, `src/db.ts`, `src/llm.ts`. New `src/summary.ts` (cache-aside lookup plus single-flight) and `src/metrics.ts` (zero-dependency helper), per AGENTS.md "small and single-purpose" |
| Data flow | Request → load report → fingerprint its sections → stored summary with the same fingerprint? return it : join an in-flight call or start one → store → return |
| Pattern | Cache-aside with a content-derived key. The stored summary row is the cache, per the system-design caching guidance. It sits in the existing report store, following the in-memory map pattern there [anchor: src/db.ts:9] |
| Cache key | Report id plus a SHA-256 of the JSON-encoded sections, using the runtime's built-in crypto. Any edit to the sections changes the key, so no invalidation hook or TTL is needed. Title or company edits do not invalidate, because the summary does not depend on them [anchor: src/app.ts:14] |
| Storage shape | A separate summary map keyed by report id, holding one `{ sectionsHash, text }` entry per report and overwritten on a new version. Memory stays bounded by the report count. Summaries are not added as a field on the report, which keeps the full-report response unchanged [anchor: src/app.ts:15] |
| Binary-framing check | The request does not frame an A/B choice. The storage fork (per-instance / shared / HTTP-only) is simulated in Decision analysis |
| Goal-anchor check | Every decision serves "no model call and an instant response on a repeat open until the content changes". Stale-while-revalidate was rejected against that goal's "until the content changes" clause |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --------- | -------- | --------------- | ------------------ | ------- | --------------- | ---------- |
| Summary lookup (`GET /reports/{id}/summary`) | hit ~5 ms; miss ~15 s | inline cache-aside, with per-instance single-flight on miss | the model-call timeout of 30 s, well inside Cloud Run's 300 s default request timeout | none server-side (the reader re-opens) | report id + sections SHA-256 | at most 1 model call per (report, sections version) per instance; new cache in the report store |
| Model summarize call | ~15 s | inline, behind the lookup's single-flight | 30 s (2x the documented 15 s upper bound) | none | same key, enforced by the caller's single-flight | gated by the lookup above, the single choke point |
| Model section-generate and title calls (no caller in this service) | 60 s / 3 s | inline — 60 s p99, timeout 120 s / inline — 3 s p99, timeout 10 s | 120 s / 10 s | none | n/a | unchanged, no caller |

**Platform:** gcp

**Proportionality:**

- Kept inline, a deliberate departure from "persisted model generation goes through a queue": the reader already waits inline today, a miss now happens once per edit rather than once per open, and the repo has no queue to reuse.
- No shared cache: reports themselves are per-instance [anchor: src/db.ts:9].
- No TTL: the key is content-derived and cannot go stale.
- No stale-while-revalidate: Cloud Run's request-based billing throttles post-response work, and a stale summary would describe sections that no longer exist.
- No spend ledger: the repo has none, and the cache is the choke point. An instance ceiling is a candidate follow-up.

**Recovery:** none — every stored summary is regenerable from its report's sections at the cost of one model call, and it lives in the same store as the reports it describes.

## Technical Constraints

- No new runtime dependencies (AGENTS.md: "No new runtime dependencies without a reason"). Fingerprinting uses the runtime's built-in `node:crypto`, and the metrics helper is a zero-dependency in-memory recorder.
- The cache key must cover every input to the summary. Today that is only the sections [anchor: src/app.ts:14]. If the summary call ever takes title or company, the key must grow to match.
- Cloud Run request-based billing throttles work after the response is sent (https://docs.cloud.google.com/run/docs/configuring/billing-settings), so no background refresh is planned.
- The full-report response must stay byte-identical. Summaries live in their own map, not on the report object, because the full-report route returns the report wholesale [anchor: src/app.ts:15].
- Token spend: model summary calls drop from one per open to one per sections version per serving instance.
- Latency: repeat opens drop from 5–15 s to an in-memory read.
- CI time: adds the repo's first test files (`bun test` currently finds none).

## Open Questions

- [ ] Should the stored summary live beside the reports in each instance's own store, or in a cache shared across instances? A redirect to shared replaces Task 3's in-memory map with an external cache client plus a new dependency and infra.
  - **Stakes:** system — cost: if production runs many instances, each pays one call per report edit instead of one in total
  - **Recommended:** beside the reports, per instance — the reports themselves are held there, so the summary shares their lifetime and no new dependency is needed [confidence: high] [anchor: src/db.ts:9]
- [ ] After a report changes, should the first reader wait for the new summary (as every reader does today), or see the old summary instantly while a new one is generated? A redirect adds a stale-serve path plus a background refresh to Task 3.
  - **Stakes:** user — a wait on the first open after each edit, versus a summary that describes sections the report no longer has
  - **Recommended:** wait — the brief's truthfulness precondition outranks its user-experience priority, and the wait is no worse than today's for one reader per edit [confidence: medium] [anchor: weighing: risk — a stale summary misstates an edited report, and Cloud Run throttles the background refresh it needs]
- [ ] What should a reader get when the model call fails? A redirect changes the status and body in Task 4.
  - **Stakes:** user — a misleading empty success, versus an explicit error the client must handle
  - **Recommended:** `502 {"error":"summary unavailable"}`, never cached, so the next open retries — same JSON error shape the route already uses for a missing report [confidence: medium] [anchor: adjacent: src/app.ts:13]
- [ ] How long should a summary call wait before giving up? A redirect changes one constant in Task 2.
  - **Stakes:** user — too short cuts off slow-but-valid summaries, too long holds a reader on a hung upstream
  - **Recommended:** 30 s for summaries (and 120 s / 10 s for the two uncalled section and title calls), about 2x each call's documented upper bound [confidence: medium] [anchor: weighing: risk — 2x headroom over the documented 5–15 s range keeps valid calls while bounding a hang]
- [ ] Should the missing status check and timeout also be fixed in the two other model calls, which have no caller in this service? A redirect narrows Task 2 to the summary call only.
  - **Stakes:** system — the same `200`-with-undefined defect stays latent in the two other calls
  - **Recommended:** yes, through one shared request helper — the identical unchecked pattern sits in all three calls, and one helper is smaller than three fixes [confidence: high] [anchor: src/llm.ts:10]
- [x] Fingerprint algorithm — SHA-256 from the runtime's built-in crypto over the JSON-encoded sections array (unambiguous, unlike a joined string). Resolved without asking.
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision A — where does the stored summary live?**

| Branch | Downstream flow | Friction |
| ------ | --------------- | -------- |
| A1: per-instance, beside the reports | Reader opens a summary → instance checks its own map → hit returns in ms. Each instance pays one call per edit, and a restart refills on the first open. No new dependency or infra | 0 interruptions — fully automated |
| A2: shared external cache (e.g. Memorystore) | Reader opens a summary → instance queries the shared cache over the network → hit returns in ~1–5 ms. One call per edit fleet-wide. Adds a client dependency (against AGENTS.md's no-new-dependencies rule), a VPC connector, and a standing monthly charge, while the reports themselves stay per-instance | 0 interruptions — fully automated |
| A3: HTTP caching headers only | Each reader's browser caches its own copy. Two different readers still cost two calls, and nothing in front of Cloud Run caches shared responses [anchor: deploy.sh:3] | 0 interruptions — fully automated |

- **Exclusivity:** A1 and A2 are mutually exclusive (one store of record). A3 is complementary to either.
- **Ranked combinations:**
  1. A1. It removes almost all of the cost with no new dependency.
  2. A1 + A3. It needs a sections-hash ETag, which adds surface no named reader consumes yet.
  3. A2. It pays standing infra cost while the reports it summarizes are still per-instance.
  4. A3 alone. It does not deduplicate across readers.

Verdict: **A1** — per-instance, beside the reports. It wins on cost (brief priority 2) without growing infra, and it matches the lifetime of the reports it summarizes [confidence: high] [anchor: src/db.ts:9].

## Alternatives considered

- **Generate the summary when a report is saved** — rejected: the save function has no caller in this service [anchor: src/db.ts:15], so there is no write path to hook, and eager generation would pay for summaries of reports nobody opens.
- **Store the summary as a field on the report record** — rejected: the full-report route returns the report object wholesale [anchor: src/app.ts:15], so a new field would silently change that public response.
- **Stale-while-revalidate (serve the old summary, refresh in the background)** — rejected: Cloud Run request-based billing throttles post-response work (https://docs.cloud.google.com/run/docs/configuring/billing-settings), and a stale summary describes sections that no longer exist.

## Recommendation

**Proceed** — reuse each summary until its report's sections change. Repeat opens become free and instant, with one call per edit per instance. The model-API client is simplified into one checked, time-limited request helper as part of the change (see Existing-code assessment) [confidence: high] [anchor: src/app.ts:14]

**Redundancy:** none found — no existing cache, memo, or stored summary anywhere in the service (`src/` holds only the handler, the report store, and the model client)

## Plan risks

The saving assumes few serving instances. The deploy script sets no instance ceiling [anchor: deploy.sh:3], and the cost bound scales with instance count, so a scaled-out fleet that restarts often could recover only a fraction of the expected spend. The model-call ratio panel is the check.

## Cut list

- nothing — plan is minimal: every task either delivers the cache, fixes a defect the cache would otherwise pin (an empty summary stored as success), or adds the two counts needed to prove the saving. TTLs, a shared cache, background refresh, ETags, and a hit/miss counter are already excluded.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --------- | ----- | ---------- | --------- | --------------------------- | ------------------------ |
| Cap the Cloud Run instance count for reports-service | Medium | Trivial | needs its own design/decision session: the open decision is which instance ceiling the real traffic needs, since too low queues readers and too high leaves paid spend unbounded | bounds the per-instance multiplier on this plan's cost saving, and on every other paid model call | No |

- [x] Cap the Cloud Run instance count for reports-service — needs its own decision session: the open decision is which instance ceiling the real traffic needs; until then paid model spend has no fleet-wide ceiling.
  - **UX:** none
  - **Problem:** the deploy command sets no maximum instance count, so a traffic spike scales out without bound, and each new instance pays its own model calls [anchor: deploy.sh:3]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk: unbounded instance count multiplies paid calls with no ceiling [anchor: deploy.sh:3]
  - **Complexity:** Trivial — one flag in the deploy script
  - **Risk:** Low — a too-low value queues requests, easily raised
  - **If never done:** paid model spend has no fleet-wide ceiling, and the summary cache's saving divides by however many instances a spike creates
  - **Verdict:** clears bar — a one-flag change closes the only unbounded multiplier on paid spend, which outweighs its trivial complexity and low risk

# Task breakdown

### Task 1: Metrics helper and metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create a zero-dependency metrics helper and the repo's first `.flow/metrics.md`.
  - The helper has a swappable `Recorder`, an `InMemoryRecorder` (the default), `instrument(op, fn)`, and `timeOutbound(name, server, fn)`.
  - It holds a closed `ErrorType` union (`_OTHER`, `upstream_error`, `upstream_timeout`) and a per-instrument attribute map, so `error.type` cannot be passed to a histogram.
  - It reads the error class from a thrown error's `errorType` field when that field is in the union, and falls back to `_OTHER`.
  - It records durations in seconds against the explicit 15-bound boundary list.
  - The contract file records: Backend `none yet — suggested: Google Cloud Monitoring (OTLP)`, Namespace `reports`, Attributes, error.type values, Helper `src/metrics.ts`, the Dashboard panels from the PRD, empty Dashboards, Alerts (burn-rate tiers), As-code `spec-only`, the SLO "read a report summary", and Coverage (`reports.summary`, `reports.llm.summarize`).
- **Inputs:** none (new: src/metrics.ts)
- **Outputs:** Metrics helper, its tests, the committed metrics contract
- **Contract:**
  - **Files:** create `src/metrics.ts`, `src/metrics.test.ts`, `.flow/metrics.md`
  - **Interfaces:** `export type ErrorType = "_OTHER" | "upstream_error" | "upstream_timeout"`; `export type Outcome = "ok" | "error"`; `export type ServerAddress = "api.example-llm.com"`; `export interface Recorder { observe(name: string, seconds: number, attrs: Record<string, string>): void; increment(name: string, attrs: Record<string, string>): void }`; `export class InMemoryRecorder implements Recorder { observations: { name: string; seconds: number; attrs: Record<string, string> }[]; increments: { name: string; attrs: Record<string, string> }[] }`; `export function setRecorder(r: Recorder): void`; `export function instrument<T>(op: "reports.summary", fn: () => Promise<T>): Promise<T>` (records `<op>.duration` with `operation.outcome`, and on throw `<op>.failures` with `error.type`, then rethrows); `export function timeOutbound<T>(name: "reports.llm.summarize", server: ServerAddress, fn: () => Promise<T>): Promise<T>` (records `<name>.duration` with `server.address` and `operation.outcome`); `export const DURATION_BOUNDARIES: readonly number[]`
  - **Call-site edits:** none (consumers arrive in Tasks 2 and 3)
- **Acceptance criteria:** `bun test src/metrics.test.ts && grep -q "upstream_timeout" .flow/metrics.md && grep -q "src/metrics.ts" .flow/metrics.md` — covers the success observation, failure observation plus exact-`error.type` increment, and the unlisted-error-to-`_OTHER` fallback.

### Task 2: Checked, time-limited model-API requests

- **Skill:** `flow-system-design`
- **Bundled:** the unchecked-response bug in the model client (a failed call returns a successful empty summary), plus the same status check and timeout on the two other model calls, surfaced during discovery
- **Description:** Replace the three copies of the bare request code with one private helper.
  - The helper posts JSON with `AbortSignal.timeout(ms)` and throws `ModelApiError("upstream_timeout")` on abort.
  - It throws `ModelApiError("upstream_error")` on a non-2xx status or a body whose expected field is not a string.
  - `summarize` gains an optional timeout override (for tests) and wraps its request in `timeOutbound("reports.llm.summarize", "api.example-llm.com", …)`.
  - Timeouts: summarize 30 s, generateSection 120 s, suggestTitle 10 s.
- **Inputs:** Task 1 helper (src/metrics.ts)
- **Outputs:** Hardened model client and its tests
- **Contract:**
  - **Files:** edit `src/llm.ts`; create `src/llm.test.ts`
  - **Interfaces:** `export class ModelApiError extends Error { readonly errorType: "upstream_error" | "upstream_timeout"; constructor(errorType: "upstream_error" | "upstream_timeout", message: string) }`; `export async function summarize(sections: string[], opts?: { timeoutMs?: number }): Promise<string>`; `generateSection(company, section)` and `suggestTitle(sections)` keep their signatures; private `postModel(path: string, body: unknown, field: "text" | "title", timeoutMs: number): Promise<string>`
  - **Call-site edits:** none (`src/app.ts` keeps calling `summarize(sections)` until Task 4)
- **Acceptance criteria:** `bun test src/llm.test.ts` — with a stubbed `globalThis.fetch`:
  - a 500 response rejects with `errorType === "upstream_error"`;
  - a 2xx response with no `text` rejects with `upstream_error`;
  - a stub that never answers rejects with `upstream_timeout` under `timeoutMs: 50`;
  - a success records one `reports.llm.summarize.duration` observation.

### Task 3: Summary cache with single-flight

- **Skill:** `flow-system-design`
- **Description:** Add a summary map to the report store and a summary module.
  - The module fingerprints `report.sections` (SHA-256 of `JSON.stringify(sections)`, `node:crypto`) and returns the stored text when the fingerprints match.
  - On a miss, it joins an in-flight promise keyed `${id}:${hash}` or starts one through `generate`.
  - On success, it stores `{ sectionsHash, text }`. It never stores a rejection, and it deletes the in-flight entry on settle.
  - The whole lookup runs inside `instrument("reports.summary", …)`.
- **Inputs:** Task 1 helper (src/metrics.ts), Task 2 client (src/llm.ts), existing report store (src/db.ts)
- **Outputs:** Cache-aside summary lookup and its tests
- **Contract:**
  - **Files:** edit `src/db.ts`; create `src/summary.ts`, `src/summary.test.ts`
  - **Interfaces:** in `src/db.ts`: `export type StoredSummary = { sectionsHash: string; text: string }`; `export function getStoredSummary(reportId: string): StoredSummary | undefined`; `export function saveStoredSummary(reportId: string, summary: StoredSummary): void`. In `src/summary.ts`: `export function sectionsHash(sections: string[]): string`; `export async function getReportSummary(report: Report, generate: (sections: string[]) => Promise<string> = summarize): Promise<string>`
  - **Call-site edits:** none (wired in Task 4)
- **Acceptance criteria:** `bun test src/summary.test.ts` — with a counting fake `generate`:
  - 50 sequential calls make 1 generate call;
  - 10 concurrent calls make 1 generate call;
  - changed sections make exactly 1 new call;
  - a title-only change makes 0 calls;
  - a rejecting generate is not stored, so the next call generates again;
  - the in-memory recorder shows the duration and failure observations from Story 4.

### Task 4: Wire the summary route to the cache

- **Skill:** `flow-new-feature`
- **Description:** Route `GET /reports/{id}/summary` through `getReportSummary`. Catch `ModelApiError` (and any other throw) and return `502 {"error":"summary unavailable"}` in the route's existing JSON error shape. The 404 path and the full-report response are unchanged.
- **Inputs:** Task 3 module (src/summary.ts)
- **Outputs:** Wired handler and route-level tests
- **Contract:**
  - **Files:** edit `src/app.ts`; create `src/app.test.ts`
  - **Interfaces:** `handle(req: Request): Promise<Response>` unchanged; the summary branch returns `json({ summary })` on success and `json({ error: "summary unavailable" }, 502)` on failure
  - **Call-site edits:** `src/app.ts` `handle` — replace the `summarize(report.sections)` call with `getReportSummary(report)` and drop the `summarize` import
- **Acceptance criteria:** `bun test src/app.test.ts && bun test` — with a stubbed `globalThis.fetch`:
  - two summary requests for one saved report make one upstream call and return the same body;
  - an upstream 500 returns 502 and the next request calls upstream again;
  - an unknown id returns 404;
  - `GET /reports/{id}` returns the report with no summary field.

| Task | Depends on |
| ---- | ---------- |
| 1 | — |
| 2 | 1 |
| 3 | 1, 2 |
| 4 | 3 |

### Skills Summary

| Skill | Recommended? | Reason |
| ----- | ------------ | ------ |
| flow-metrics | Yes (Task 1) | First instrumented change: creates the helper and `.flow/metrics.md` |
| flow-system-design | Yes (Tasks 2, 3) | Outbound timeouts, cache-aside, stampede protection, cost bound |
| flow-new-feature | Yes (Task 4) | Handler wiring for the user-visible behavior change |
| flow-testing | No (folded in) | Each task writes its own tests; no separate test-only task |
| flow-refactoring | No | The client consolidation changes behavior (status check, timeout), so it is not a pure refactor |
| flow-ui-ux | No | No UI surface |

# PR description draft

## TLDR

Opening a report's summary again no longer pays for a new model call or waits 5–15 seconds: the summary is reused until the report's sections change, and model failures now return an explicit error.

## User-facing changes

- Opening the same report's summary again is now instant and consistent:
  - **Before:** every open waited 5–15 seconds for a newly generated, possibly differently worded summary.
  - **After:** the first open after a report changes waits as before; every later open returns the same summary immediately.
- A failed summary now reports an error:
  - **Before:** when the model service failed, the summary request returned success with no summary in it.
  - **After:** it returns a "summary unavailable" error (502), and the next open tries again.

## System changes

- Paid model calls for summaries drop from one per open to one per report change per running instance:
  - **Before:** model calls equaled summary opens, hundreds a day for a popular report.
  - **After:** a summary is stored with a fingerprint of the report's sections and reused until they change, and simultaneous first opens share one call.
- Model calls are now time-limited, and failures are never stored:
  - **Before:** a hung model service held the request until the platform killed it.
  - **After:** a summary call gives up after 30 seconds, and failures surface as errors.
- Summary lookups and model calls are now measured, so the saving can be read as the ratio of model calls to opens.

## Why

A popular report is opened hundreds of times a day but edited rarely. Yet every open pays for a fresh model call and makes the reader wait 5–15 seconds for a summary that already existed. That is the service's largest avoidable paid spend, and its slowest common screen.

## Key decisions

- Summaries are stored next to the reports in each instance, not in a shared cache. The reports themselves live per instance, so the summary shares their lifetime, and no new dependency or infrastructure is needed. The trade-off is one call per edit per instance rather than one fleet-wide.
- The cache key is a fingerprint of the report's sections, the only input to the summary. Any edit to the sections refreshes it automatically, with no TTL or invalidation hook. Title-only edits keep the existing summary.
- After an edit, the first reader waits for the new summary rather than seeing the old one, because a stale summary would describe content the report no longer has.
- Summaries are stored separately from the report record, so the full-report response is unchanged.
- Out of scope: a cache shared across instances, generating summaries ahead of time on save (nothing in this service saves reports), and browser caching headers.
- Bundled: the model client's unchecked-response bug (a failed call returned a successful empty summary), fixed with a status check and timeout on all three model calls through one shared request path.

## Instrumentation

- New metrics:
  - `reports.summary.duration` (by outcome) and `reports.summary.failures` (by `error.type`: `upstream_error`, `upstream_timeout`, `_OTHER`), for every summary open.
  - `reports.llm.summarize.duration` (by host and outcome), for every paid summary call.
- Panels added to the "reports-service overview" dashboard spec:
  - request rate, success vs failure, failures by type, and latency percentiles for summary opens;
  - latency percentiles for model calls;
  - a "Summary model-call ratio" panel that shows the saving.
- New journey SLO "read a report summary": 99% availability over 30 days, burn-rate alert tiers only.
- Dashboard: spec-only. These metrics are recorded but won't show on any graph until a metrics backend is chosen. The suggested backend is Google Cloud Monitoring, since the service runs on Cloud Run (status in `.flow/metrics.md` under Backend).

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/summary.test.ts` — 50 sequential and 10 concurrent opens make one model call, changed sections make one new call, and a title-only change makes none.
- [ ] Run `bun test src/app.test.ts` — an upstream failure returns 502 and the next open retries, an unknown report returns 404, and the full-report response has no summary field.
- [ ] Run `bun test src/llm.test.ts` — a non-2xx response or missing text maps to `upstream_error`, and a hung upstream maps to `upstream_timeout`.
- [ ] Run `bun test src/metrics.test.ts` — duration, failure, and `_OTHER`-fallback emissions are recorded.
- [ ] Run `git diff --exit-code main -- package.json` — no new dependencies were added.
