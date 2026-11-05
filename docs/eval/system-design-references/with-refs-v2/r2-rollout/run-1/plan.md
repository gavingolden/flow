# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Section content by id: rename `body` to `content` and key section tasks on the section id

**Goal:** Every generated section lands on exactly the section it was queued for, stored under `content`, with no failed reads, lost tasks, or wasted paid calls during the deploy.

## Problem Statement

The reports service writes each report in sections: a queue hands the worker one section at a time, the worker asks a paid model to write it, and the text is saved back to that section. Today the worker finds "its" section by name, so two sections that share a name in one report both receive the same text, and a section renamed while its task waits in the queue is never filled. The stored text also lives under a vague column name. Fixing this naively is risky: the running service and tasks already sitting in the queue still speak the old shape, so a careless cut-over would briefly break report reads, silently drop queued sections, and re-run paid model calls that then fail to save.

| Fact | Evidence |
| --- | --- |
| Generated text is stored in `sections.body` | [anchor: migrations/001_reports.sql:13] |
| Section names are not unique within a report (no constraint) | [anchor: migrations/001_reports.sql:8] |
| The task payload is `{ reportId, section }` where `section` is the name | [anchor: src/queue.ts:11] |
| The worker saves by `(report_id, name)`, so every same-named row is overwritten | [anchor: src/db.ts:16] |
| The public report read returns the column under its SQL name (`body`) | [anchor: src/db.ts:12] |
| Each model call takes 20–60 s and is paid per call | [anchor: src/llm.ts:1] |
| A non-2xx worker reply makes Cloud Tasks retry, re-running the paid call | [anchor: src/worker.ts:9] |
| Nothing in this repo calls the enqueue helper or inserts sections — the producer lives elsewhere | `grep -rn "enqueueSection\|insert into" src` → only the definition at src/queue.ts:4 |

Who is affected, in the brief's terms: report readers (user experience — a section with the wrong or missing text), and the owner's bill (cost — every failed attempt is a paid call thrown away).

## Request vetting

- **Hypothesis:** Swapping the task key from name to id and renaming the column fixes mis-targeted section writes without breaking report reads or queued tasks during the deploy.
- **Case against:** Done literally in one release, both changes break mid-deploy: an in-place column rename fails every query the still-running revision issues (Fowler's Parallel Change: never rename in the release that stops using the old shape), and a payload swap strands tasks already queued as `{ reportId, section }` [anchor: src/queue.ts:11], which the worker would answer 200 "gone" and Cloud Tasks would delete [anchor: src/worker.ts:8]. Migrations are applied by hand (no runner in [anchor: deploy.sh]), so the broken window is however long the operator takes.
- **Sources:** https://martinfowler.com/bliki/ParallelChange.html ; https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks
- **Verdict:** adopt-with-conditions: ship as expand/contract — this release adds and backfills `content` while still writing `body`, and the worker accepts both payload shapes; dropping `body` and the name-shaped path is a second release gated on the legacy-payload counter reading zero.

## Existing-code assessment

- **migrations/001_reports.sql:** keep — an applied migration is never edited; the schema change goes in new numbered files [anchor: migrations/001_reports.sql:8]
- **src/db.ts:** keep — three small query functions; add id-keyed lookup and save beside them, replace the name-keyed save [anchor: src/db.ts:15]
- **src/worker.ts:** keep — an 8-line handler whose "200 gone" stop-retry pattern is reused for missing sections and invalid payloads [anchor: src/worker.ts:8]
- **src/queue.ts:** keep — one enqueue function; change its second parameter and add a dispatch deadline and timeout [anchor: src/queue.ts:4]
- **src/llm.ts:** keep — add a timeout to the section call so the deadline chain holds [anchor: src/llm.ts:6]
- **deploy.sh:** keep — add one queue-update line for retry bounds; the create line is a no-op once the queue exists [anchor: deploy.sh:3]

## Scope Boundary

**In scope:**

- New migration adding a nullable `sections.content` column, and a separate idempotent backfill copying `body` into it.
- Reads return `coalesce(content, body)`; writes go to both `content` and `body` for this release.
- The generate-section task carries `{ reportId, sectionId }`; the worker looks the section up by id (scoped to the report) and saves by id.
- The worker still accepts the old `{ reportId, section }` shape and saves it the old way, counting each one.
- Bounded retries and deadlines on the section queue and the model call, so cut-over failures cannot multiply paid calls.
- A minimal, dependency-free metrics helper and the repo's first `.flow/metrics.md`, carrying the drain signal.
- Tests for the worker, enqueue, metrics emission, and the id-keyed queries.

**Out of scope:**

- Dropping `body` and the name-shaped worker path — the contract release, tracked as a candidate follow-up.
- Renaming the `body` field in the public report response (kept stable; see Open Questions).
- Authenticating the worker route — tracked as a candidate follow-up.
- Changing the out-of-repo producer that creates sections and enqueues tasks.
- A migration runner.

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| Two sections with the same name in one report both show the text generated for whichever task finished last | Each section shows the text generated for it |
| A section renamed while its task is queued stays empty | The task finds the section by id and fills it |
| Report reads return each section's text under `body` | Unchanged — still `body` |

### System flow

- **Before:**
  - The producer enqueues `{ reportId, section: <name> }`.
  - The worker calls the model, then updates every row matching `(report_id, name)` in `body`.
  - The queue retries failures on its default policy with no deadline set; the model call has no timeout.
- **After:**
  - The producer enqueues `{ reportId, sectionId }` with a 180 s dispatch deadline.
  - The worker loads the one section by `(id, report_id)`, calls the model (120 s timeout), and writes `content` and `body` on that row.
  - Old-shape tasks still process by name and increment a legacy-payload counter.
  - Invalid payloads and missing sections answer 200 so they are not retried; invalid ones increment a failures counter.
  - The queue stops after 5 attempts with 10–300 s backoff.

**Lost:** callers of the enqueue helper can no longer pass a section name (they must pass the section id); unlimited queue retries are gone, so a task failing 5 times is dropped instead of retried indefinitely.

## User Stories / Acceptance Criteria

### Story 1: Generated text lands on the queued section only

- Given a report with two sections both named "Overview" (ids `s1`, `s2`), When a task `{ reportId, sectionId: "s1" }` is processed, Then only `s1` is written. Check: `bun test src/worker.test.ts` asserts the save was called with `s1` only.

### Story 2: Tasks queued before the deploy still complete

- Given a task in the old shape `{ reportId, section: "Overview" }`, When the new worker processes it, Then the text is saved by name and the legacy-payload counter increments by 1. Check: `bun test src/worker.test.ts`.

### Story 3: Bad or orphaned tasks stop without paid retries

- Given a payload with neither `sectionId` nor `section`, When processed, Then the reply is 200, the model is not called, and `failures{error.type=invalid_payload}` increments. Check: `bun test src/worker.test.ts`.
- Given a `sectionId` that does not exist in that report, When processed, Then the reply is 200 "gone" and the model is not called. Check: `bun test src/worker.test.ts`.

### Story 4: Report reads keep working across the schema change

- Given a migrated database where one row has only `body` set and another has `content` set, When the report is read, Then both rows return their text under `body`. Check: `DATABASE_URL=… bun test src/db.test.ts` (skips without a database).

### Story 5: New tasks carry the section id and a deadline

- When the enqueue helper is called with `("r1", "s1")`, Then the decoded task body is exactly `{ reportId: "r1", sectionId: "s1" }` and the task sets `dispatchDeadline: "180s"`. Check: `bun test src/queue.test.ts`.

## Instrumentation

**Contract:** `.flow/metrics.md` `create`

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports.section_task.duration` | Histogram (bounds `[1, 5, 10, 20, 30, 45, 60, 90, 120, 180]`) | s | `operation.outcome` (`ok` \| `error`) | worker handler, via `instrument("section_task", …)` |
| `reports.section_task.failures` | Counter | none | `error.type` (`invalid_payload` \| `_OTHER`) | worker handler |
| `reports.section_task.legacy_payloads` | Counter | none | none | worker handler, name-shaped branch |
| `cloudtasks.googleapis.com/queue/depth` | Gauge | `{message}` | queue `sections` | platform-native (Cloud Tasks) |

Estimated series: 26 per operation for the duration histogram (2 outcomes × (10 bounds + 3)), 2 for failures, 1 for legacy payloads — 29 per reporting instance.

**Attributes:** new keys `operation.outcome` (`ok` | `error`) and `error.type` (closed list below), registered in `.flow/metrics.md` `## Attributes`.

### Error types

- `invalid_payload` — the task body has neither `sectionId` nor `section`; the task is dropped with 200.
- `_OTHER` — any thrown failure (model call, database) that makes the worker answer 5xx and the queue retry.

### Dashboard panels

- "reports-service overview": section task latency p50/p95 by outcome; section task failures by `error.type`; legacy-shaped section tasks (drain signal for the contract release); `sections` queue depth (platform-native).

### Alerts

burn-rate tiers only

### SLO

New journey SLO `report-section-generation` (the repo has none yet): SLI = share of section tasks with `operation.outcome=ok`; target 99% over 28 days.

**As-code:** spec-only — the repo keeps no dashboard or alert files and has no metrics backend (`none yet — suggested: Google Cloud Monitoring via OTLP`).

## Architecture Decisions

- **Layers touched:** data (new migrations, query functions), integration (queue payload, worker handler, model-call timeout, queue retry config), observability (new metrics helper).
- **Domain modules:** `src/db.ts`, `src/worker.ts`, `src/queue.ts`, `src/llm.ts`, `deploy.sh`; new `src/metrics.ts`. No new runtime dependency (AGENTS.md).
- **Data flow:** producer → Cloud Tasks `{ reportId, sectionId }` → worker loads section (name, report company) → model → `content` + `body` on that row → report read returns `coalesce(content, body)` as `body`.
- **New patterns vs. existing:** reuses the worker's "200 gone" stop-retry reply (src/worker.ts:8) and Bun's `sql` tagged template (src/db.ts:7). New: expand/contract migration pair, a versioned-by-shape payload, the metrics helper.
- **Binary-framing check:** the request is not framed as either/or, but the cut-over is: single-release rename vs. full parallel change. Middle option considered (code that tolerates either column name, then rename) — see Decision analysis.
- **Goal-anchor check:** the user's literal "rename the column" conflicts with the Goal's "no failed reads during the deploy" if done in one release; resolved by finishing the rename in a second release (OQ "cut-over strategy").
- **Rollout sequence (operator, post-merge):** apply `002` (add column) → `./deploy.sh` → wait for the old revision to stop serving → apply `003` (backfill). The contract release then drops `body`.

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| Generate one section (worker) | 60 s | existing Cloud Tasks queue + worker invoked synchronously under the attempt deadline | model call 120 s < dispatch deadline 180 s < Cloud Run request timeout 300 s | queue only: max 5 attempts, backoff 10–300 s | section id (business identity); the save is an overwrite of one row, so a redelivery rewrites the same row | ≤5 paid model calls per task; invalid payloads and missing sections make 0 |
| Enqueue one section task | inline — <1 s, timeout 10 s | inline | 10 s on the Cloud Tasks API call | none (caller decides) | none — one task per call, unchanged | no paid call |
| Read a report | inline — <0.1 s, timeout: Cloud Run request timeout (unchanged) | inline | unchanged | none | n/a (read) | no paid call |

**Platform:** gcp

**Proportionality:** no spend ledger (the attempt cap bounds per-task spend; a global cap is a separate decision), no named-task dedupe (the overwrite is already safe to repeat), no canary or flag (the expand step keeps both revisions working, so a straight deploy is safe), no dead-letter queue (Cloud Tasks has none; the failures counter and queue depth are the visible failed state).

**Recovery:** none — this release only adds a nullable column and copies `body` into it; `body` is never modified, so every row's prior value survives and a code rollback needs no data rollback. The contract release's column drop is the destructive step and must take an on-demand Cloud SQL backup first (noted in that candidate).

## Technical Constraints

- No new runtime dependencies; keep modules small and single-purpose — the metrics helper is an in-memory recorder with zero dependencies (AGENTS.md).
- Schema lives in `migrations/` as plain SQL files applied by hand; there is no runner, so ordering is an operator step (AGENTS.md; deploy.sh has no migration step).
- Cloud Tasks treats any non-2xx reply as a retry, so permanent failures (invalid payload, missing section) must answer 2xx (https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks).
- `gcloud tasks queues create … || true` never changes an existing queue, so retry bounds need a separate `gcloud tasks queues update` (deploy.sh:3).
- Tests run with `bun test`; Bun's `sql` reads its connection from `DATABASE_URL`, so query tests must skip when it is unset.
- Cost: the retry cap lowers worst-case paid calls per failing task from the queue default to 5; no added ongoing cost.

## Open Questions

- [ ] **Q1 — How are migrations applied in production?** The plan assumes an operator runs each file by hand against Cloud SQL in the order add-column → deploy → backfill, since neither `deploy.sh` nor the code runs migrations. If a runner applies all pending files before deploy, the backfill must move to the contract release (it would otherwise run while the old revision still writes only `body`).
  - **Needs user input:** production access — how and when migrations reach the production database is not visible in the repo.
  - **Stakes:** system — a backfill run before the old revision stops serving can leave a regenerated section's `content` one generation stale until the next write.
- [ ] **Cut-over strategy for the column rename.** Assumed expand/contract over two releases rather than an in-place rename (see Decision analysis).
  - **Recommended:** expand/contract — add and backfill `content`, dual-write, drop `body` next release; the only option where rolling back this deploy is a traffic shift with no schema undo. [confidence: medium] [anchor: weighing: reversibility — an in-place rename makes the previous revision unable to run, so rollback needs a reverse migration under pressure]
  - **Stakes:** both — report readers get errors and the owner pays for failed model calls during any broken window.
- [ ] **Public report response keeps the field name `body`.** The user asked to rename the column, not the API; reads alias the column back to `body`. On redirect, the response field becomes `content` and any reader of the report endpoint must change.
  - **Recommended:** keep `body` in the response — the request names only the storage column, and no in-repo list of response consumers exists to update. [confidence: medium] [anchor: weighing: risk — renaming a public field breaks readers we cannot see; keeping it costs one SQL alias]
  - **Stakes:** user — an unseen report reader would lose section text if the field were renamed.
- [ ] **Task payload keeps `reportId` alongside `sectionId`.** Read "carry the section id instead of the section name" as swapping only the name field; the worker uses both to scope the lookup so a mismatched pair is treated as gone.
  - **Recommended:** `{ reportId, sectionId }` — a one-field swap of the current shape, and the pair stops a stray id from writing into another report. [confidence: high] [anchor: user: "carry the section id instead of the section name"]
  - **Stakes:** system — a payload without `reportId` would need the lookup to trust the id alone.
- [ ] **Old name-shaped tasks are processed, not dropped.** Tasks already queued, and any out-of-repo producer not yet updated, still send `{ reportId, section }`; the worker keeps the old save-by-name path for them until the contract release.
  - **Recommended:** accept and process them by name, counting each on the legacy-payload counter — the current payload shape is exactly what queued tasks carry. [confidence: high] [anchor: src/queue.ts:11]
  - **Stakes:** user — dropping them leaves those sections empty in finished reports.
- [ ] **Invalid payloads answer 200, not 400.** A 4xx would make Cloud Tasks retry a payload that can never succeed.
  - **Recommended:** reply 200 and increment `failures{error.type=invalid_payload}`, mirroring the worker's existing stop-retry reply for a missing report. [confidence: high] [anchor: src/worker.ts:8]
  - **Stakes:** system — a 4xx keeps a poison task cycling through the queue until its attempts run out.
- [ ] **Retry and deadline values.** Assumed max 5 attempts, 10–300 s backoff, 180 s dispatch deadline, 120 s model-call timeout, 10 s enqueue timeout. Different values change only the numbers in deploy.sh, the enqueue body and the model call.
  - **Recommended:** the values above — the model call is documented at 20–60 s, so 120 s leaves 2× headroom and each deadline sits inside the next. [confidence: high] [anchor: src/llm.ts:1]
  - **Stakes:** system — too few attempts drops sections on a brief model outage; too many multiplies paid calls (the brief ranks cost second).
- [ ] **Metrics bootstrap is included.** The legacy-payload counter is the only signal that tells the owner when the name-shaped path can be removed, because the producer lives outside this repo and queue depth cannot distinguish task shapes. On redirect (every producer confirmed updated), the helper and `.flow/metrics.md` are cut and the plan relies on platform-native queue depth.
  - **Recommended:** include the minimal helper with three metrics — it is the evidence the contract release is gated on. [confidence: medium] [anchor: weighing: footprint — one ~50-line zero-dependency file plus the contract doc, against removing a fallback blind]
  - **Stakes:** system — without it, the contract release either waits forever or breaks an unseen producer.

## Decision analysis

**Decision: how the `body` → `content` rename is cut over.** Exclusive — exactly one strategy ships. System-perspective flows (the report reader sees errors only where noted):

| Branch | What happens during the deploy | Rollback | Operator steps per rollout |
| --- | --- | --- | --- |
| A. In-place rename in this release | Migration first: the old revision's report reads return 500 and its worker saves fail after a paid call, retried until the new revision serves. Deploy first: the new revision fails every read and save until the operator runs the migration. Either way, a window of minutes. | Needs a reverse rename before the old revision can run again | 2 (rename, deploy); 0 automated guards |
| B. Expand/contract (recommended) | Old and new revisions both work: the old one writes `body`, the new one writes both and reads `coalesce(content, body)`. No failed reads, no wasted calls. | Traffic shift to the previous revision; schema untouched | 3 now (add column, deploy, backfill) + 1 later (drop column in the contract release) |
| C. Tolerant code, then rename | New code tries `content` and falls back to `body` on an undefined-column error; deploy, then rename. No window if the operator waits for the old revision to stop serving. | After the rename, the previous revision cannot run (same as A) | 2 now (deploy, rename) + 1 later (remove fallback) |

Ranked combinations: B > C > A. B is the only branch with a schema-free rollback; C trades one operator step for error-driven control flow in every query; A is the literal request and the only branch with a guaranteed failure window. Friction: B adds 1 operator step this release and 0 interruptions to report readers; A adds 0 steps and ≥1 window of failed reads.

**Verdict:** B — expand/contract; it is the only branch where neither the report reader nor the bill sees the deploy (brief priorities 1 and 2), at the cost of one extra manual step and a second small release. [confidence: medium] [anchor: weighing: reversibility — B alone keeps the previous revision runnable against the new schema]

## Alternatives considered

- **Hard-switch the task to carry only the section id, with no old-shape acceptance** — rejected: tasks queued before the deploy carry `{ reportId, section }` (src/queue.ts:11); the new worker would find no row, reply 200 "gone" (src/worker.ts:8), and Cloud Tasks would delete the task, leaving the section empty with no error.
- **Keep name keys and add a unique `(report_id, name)` constraint** — rejected: the user asked to "carry the section id instead of the section name", and the constraint fails outright on any report that already has duplicate names, which the schema allows (migrations/001_reports.sql:8).

## Recommendation

**Reconsider scope** — build it, but as a two-release parallel change: this release adds `content`, dual-writes, and accepts both task shapes; the column drop and name-shaped path removal ship next, once the legacy counter reads zero (see the "cut-over strategy" Open Question). [confidence: medium] [anchor: weighing: reversibility — the literal one-release rename has no safe rollback]

**Redundancy:** none found

## Plan risks

The weakest assumption is that every producer of section tasks will be updated to send ids: none lives in this repo (src/queue.ts:4 has no caller), so an unseen producer could keep sending names indefinitely, and the contract release must not ship until the legacy-payload counter has read zero for longer than the queue retains tasks.

## Cut list

- The metrics bootstrap (helper, contract file, emission tests) is the largest piece the user did not ask for; it stays only because it carries the drain signal the contract release is gated on — cut it if the user confirms every producer is already updated (Open Question "Metrics bootstrap").

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Authenticate the section worker route | High | Medium | anyone on the internet can trigger paid model calls; needs its own design/decision session — the open decision is whether to split the worker into its own non-public service or verify the queue's OIDC token in the handler | touches the same worker route this plan edits, but is a separate security concern | No |
| Drop `sections.body` and the name-shaped task path once drained | Medium | Small | finishes the rename the user asked for; needs its own design/decision session — the open decision is when to cut over — it can ship only after this release is deployed, the backfill applied, and the legacy-payload counter reads zero past the queue's retention | the second half of this request's expand/contract | No |

- [x] Authenticate the section worker route — the public service lets anyone trigger paid section generation.
  - **UX:** none
  - **Problem:** the worker route sits on a service deployed with public access, so any caller can POST a task body and trigger a paid 20–60 s model call outside the queue's retry and rate limits [anchor: deploy.sh:4]
  - **Stability/efficiency:** none
  - **Value rank:** 5 — an unauthenticated path to paid spend with no workaround short of taking the service private [anchor: src/app.ts:9]
  - **Complexity:** Medium — deploy split or token verification, plus queue service-account wiring
  - **Risk:** Medium — a misconfigured invoker role stops all section generation
  - **If never done:** anyone who learns the URL can run up model spend at will
  - **Verdict:** clears bar — open paid-spend exposure outweighs a Medium change
- [x] Drop `sections.body` and the name-shaped task path once drained — the contract release that finishes this rename.
  - **UX:** none
  - **Problem:** this release leaves a duplicate column written on every save and a legacy code path that saves by name, reproducing the duplicate-name bug for any old-shape task [anchor: src/db.ts:16]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk: the legacy path re-introduces mis-targeted writes if an old producer keeps sending names [anchor: src/queue.ts:11]
  - **Complexity:** Small — one migration, removal of one branch and one query, take an on-demand Cloud SQL backup before the drop
  - **Risk:** Low — gated on the legacy counter at zero
  - **If never done:** the rename the user asked for is never finished and the dual write persists
  - **Verdict:** clears bar — it completes the requested rename at Small cost once its gate is met

# Task breakdown

### Task 1: Expand migrations for `sections.content`

- **Skill:** `flow-system-design`
- **Description:** Add two new migration files. `002` adds the nullable column (instant, safe for the running revision). `003` is an idempotent backfill run by the operator after the new revision serves all traffic. Do not edit `001`.
- **Inputs:** migrations/001_reports.sql
- **Outputs:** two SQL files
- **Contract:**
  - **Files:** create `migrations/002_sections_add_content.sql`; create `migrations/003_backfill_sections_content.sql`
  - **Interfaces (Schema):**
    - `002`: `alter table sections add column if not exists content text;`
    - `003`: `update sections set content = body where content is null and body is not null;`
  - **Call-site edits:** none
- **Acceptance criteria:** `grep -q 'add column if not exists content text' migrations/002_sections_add_content.sql && grep -q 'set content = body where content is null' migrations/003_backfill_sections_content.sql`

### Task 2: Id-keyed section queries with dual write

- **Skill:** `flow-new-feature`
- **Description:** Add a `Section` type, an id-and-report-scoped lookup, an id-keyed save, and a renamed name-keyed save for the legacy path. Both saves write `content` and `body`. `listSections` returns `coalesce(content, body) as body` so the public response is unchanged. Keep the old `saveSection` export until Task 4 removes its last caller, so the repo stays green.
- **Inputs:** src/db.ts; Task 1's column
- **Outputs:** new exports in src/db.ts
- **Contract:**
  - **Files:** edit `src/db.ts`
  - **Interfaces:**
    - `export type Section = { id: string; report_id: string; name: string; position: number; content: string | null }`
    - `export async function getSection(reportId: string, sectionId: string): Promise<Section | undefined>` — `select id, report_id, name, position, coalesce(content, body) as content from sections where id = ${sectionId} and report_id = ${reportId}`
    - `export async function saveSectionContent(sectionId: string, content: string): Promise<void>` — `update sections set content = ${content}, body = ${content} where id = ${sectionId}`
    - `export async function saveSectionContentByName(reportId: string, name: string, content: string): Promise<void>` — same dual write, `where report_id = ${reportId} and name = ${name}`
    - `listSections`: select `id, name, coalesce(content, body) as body`
  - **Call-site edits:** none in this task (src/app.ts keeps calling `listSections` unchanged)
- **Acceptance criteria:** `grep -q 'export async function getSection' src/db.ts && grep -q 'coalesce(content, body) as body' src/db.ts && bun test`

### Task 3: Zero-dependency metrics helper and metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create the repo's first metrics helper: `instrument(op, fn)` records `reports.section_task.duration` (seconds, bounds `[1, 5, 10, 20, 30, 45, 60, 90, 120, 180]`) split by `operation.outcome`, and on throw increments `reports.section_task.failures` with `error.type=_OTHER` and rethrows; `recordFailure(op, errorType)` and `increment(name)` cover `invalid_payload` and `reports.section_task.legacy_payloads`. Swappable in-memory recorder, closed `ErrorType = "invalid_payload" | "_OTHER"`. Create `.flow/metrics.md` with Backend (`none yet — suggested: Google Cloud Monitoring via OTLP`), Namespace `reports`, Attributes, error.type values, Helper, Dashboard panels, Dashboards (none yet), Alerts (burn-rate tiers only), As-code (spec-only), SLOs (`report-section-generation`, 99% ok over 28 days), Coverage (`section_task`).
- **Inputs:** new: src/metrics.ts; new: .flow/metrics.md
- **Outputs:** helper module + contract file
- **Contract:**
  - **Files:** create `src/metrics.ts`; create `.flow/metrics.md`
  - **Interfaces:**
    - `export type ErrorType = "invalid_payload" | "_OTHER"`
    - `export async function instrument<T>(op: "section_task", fn: () => Promise<T>): Promise<T>`
    - `export function recordFailure(op: "section_task", errorType: ErrorType): void`
    - `export function increment(name: "reports.section_task.legacy_payloads"): void`
    - `export const memoryRecorder: { histograms: Array<{ name: string; value: number; attrs: Record<string, string> }>; counters: Array<{ name: string; attrs: Record<string, string> }>; reset(): void }`
  - **Call-site edits:** none in this task
- **Acceptance criteria:** `test -f .flow/metrics.md && grep -q 'reports.section_task.legacy_payloads' .flow/metrics.md && grep -q 'export async function instrument' src/metrics.ts && bun test`

### Task 4: Worker accepts `{ reportId, sectionId }` and the legacy shape

- **Skill:** `flow-system-design`
- **Description:** Parse the body as `{ reportId: string; sectionId?: string; section?: string }`. With `sectionId`: `getReport` + `getSection(reportId, sectionId)`; either missing → 200 "gone" with no model call; else generate with `section.name` and `saveSectionContent(section.id, text)`. With only `section`: increment the legacy counter, then the old flow via `saveSectionContentByName`. With neither, or a non-string `reportId`: `recordFailure("section_task", "invalid_payload")` and 200 "invalid" with no model call. Wrap the handler body in `instrument("section_task", …)`. Remove the now-unused `saveSection` from src/db.ts. Idempotency key: the section id (the save overwrites one row); timeout: the 120 s model-call timeout from Task 5 inside the 180 s dispatch deadline.
- **Inputs:** src/worker.ts; Task 2's `getSection`, `saveSectionContent`, `saveSectionContentByName`; Task 3's src/metrics.ts
- **Outputs:** updated worker; `saveSection` removed
- **Contract:**
  - **Files:** edit `src/worker.ts`; edit `src/db.ts` (delete `saveSection`)
  - **Interfaces:** `export async function handleGenerateSection(req: Request): Promise<Response>` (signature unchanged); task body type `{ reportId: string; sectionId: string } | { reportId: string; section: string }`
  - **Call-site edits:** `src/worker.ts` imports `getSection`, `saveSectionContent`, `saveSectionContentByName` instead of `saveSection`; the header comment states the new body shape
- **Acceptance criteria:** `! grep -q 'saveSection(' src/worker.ts && grep -q 'sectionId' src/worker.ts && ! grep -q 'export async function saveSection(' src/db.ts && bun test` (idempotency key: section id; timeout: 120 s model call under a 180 s dispatch deadline)

### Task 5: Producer, queue retry bounds, and call timeouts

- **Skill:** `flow-system-design`
- **Bundled:** retry bounds, dispatch deadline and call timeouts surfaced during discovery — they cap paid calls wasted by cut-over failures.
- **Description:** `enqueueSection` takes the section id and sends `{ reportId, sectionId }`, sets the task's dispatch deadline, and times out its own API call. Add a queue update to deploy.sh (the existing create line never changes an existing queue). Add a timeout to the section model call.
- **Inputs:** src/queue.ts; src/llm.ts; deploy.sh
- **Outputs:** updated producer, model call and deploy script
- **Contract:**
  - **Files:** edit `src/queue.ts`; edit `src/llm.ts`; edit `deploy.sh`
  - **Interfaces:**
    - `export async function enqueueSection(reportId: string, sectionId: string): Promise<void>` — task JSON gains `dispatchDeadline: "180s"`; body is `btoa(JSON.stringify({ reportId, sectionId }))`; fetch gets `signal: AbortSignal.timeout(10_000)`
    - `generateSection` fetch gets `signal: AbortSignal.timeout(120_000)`
  - **Config (deploy.sh):** insert after line 3: `gcloud tasks queues update sections --location us-central1 --max-attempts=5 --min-backoff=10s --max-backoff=300s` (before: no retry config; after: max attempts 5, backoff 10–300 s)
  - **Call-site edits:** none in-repo (no caller of `enqueueSection` exists; the out-of-repo producer must pass the section id)
- **Acceptance criteria:** `grep -q 'sectionId' src/queue.ts && grep -q 'dispatchDeadline: "180s"' src/queue.ts && grep -q 'AbortSignal.timeout(120_000)' src/llm.ts && grep -q -- '--max-attempts=5' deploy.sh && bash -n deploy.sh`

### Task 6: Worker and producer tests

- **Skill:** `flow-testing`
- **Description:** Worker tests mock `./db` and `./llm` with `mock.module` and assert: id payload saves only that id (Story 1); legacy payload saves by name and increments the legacy counter once (Story 2); invalid payload returns 200, no model call, `invalid_payload` failure recorded (Story 3); unknown id returns 200 "gone", no model call (Story 3); a thrown model error returns non-2xx and records `_OTHER`. Producer test spies on `fetch` and decodes the task body (Story 5).
- **Inputs:** Tasks 3–5
- **Outputs:** two test files
- **Contract:**
  - **Files:** create `src/worker.test.ts`; create `src/queue.test.ts`
  - **Interfaces:** none exported
  - **Call-site edits:** none
- **Acceptance criteria:** `bun test src/worker.test.ts src/queue.test.ts`

### Task 7: Metrics emission and query tests

- **Skill:** `flow-testing`
- **Description:** Emission tests against `memoryRecorder`: one success (`operation.outcome=ok` histogram), one failure per error type (`invalid_payload`, `_OTHER`), and the legacy counter. Query tests run against a real Postgres only when `DATABASE_URL` is set (`describe.skipIf(!process.env.DATABASE_URL)`): apply `001`–`003`, seed duplicate-named sections, assert `saveSectionContent` writes one row, `getSection` with a wrong report id returns undefined, and `listSections` returns `body` for a body-only row and a content row (Story 4).
- **Inputs:** Tasks 1–3
- **Outputs:** two test files
- **Contract:**
  - **Files:** create `src/metrics.test.ts`; create `src/db.test.ts`
  - **Interfaces:** none exported
  - **Call-site edits:** none
- **Acceptance criteria:** `bun test src/metrics.test.ts src/db.test.ts`

| Task | Depends on |
| --- | --- |
| 1 | — |
| 2 | 1 |
| 3 | — |
| 4 | 2, 3 |
| 5 | — |
| 6 | 3, 4, 5 |
| 7 | 1, 2, 3 |

**Skills Summary**

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-system-design | Yes (Tasks 1, 4, 5) | schema expand/contract, queue payload change, retry and deadline settings |
| flow-new-feature | Yes (Task 2) | new query functions in an existing module |
| flow-metrics | Yes (Task 3) | first instrumented change creates the helper and contract |
| flow-testing | Yes (Tasks 6, 7) | the repo has no tests yet |
| flow-refactoring | No | behaviour changes (targeting by id); not a pure refactor |
| flow-ui-ux | No | no UI surface |

# PR description draft

## TLDR

Generated report sections now land on exactly the section they were queued for, stored under `content`, and the switch runs without failed report reads, lost queued sections, or extra paid model calls.

## User-facing changes

- Sections that share a name within one report each get their own generated text:
  - **Before:** every same-named section showed whichever text finished last.
  - **After:** each section shows the text generated for it.
- A section renamed while waiting in the queue is still filled:
  - **Before:** it stayed empty.
  - **After:** the task finds it by id and fills it.

## System changes

- Section tasks now identify the section by id:
  - **Before:** the task carried the section name and the worker updated every row with that name.
  - **After:** the task carries the section id; the worker updates that one row and still accepts name-shaped tasks until the follow-up release.
- The stored text moves to a new column in two steps:
  - **Before:** text lived only in the old column.
  - **After:** text is written to both columns and read from the new one first; the old column is dropped in a follow-up release.
- Failing section tasks have a hard ceiling on paid calls:
  - **Before:** the queue retried on its default policy and the model call had no timeout.
  - **After:** at most 5 attempts per task, a 120 s model-call timeout, and a 180 s task deadline; worst-case paid calls per failing task drop to 5.
- Deploying now needs an operator to run two database steps around the deploy: add the column before, backfill after the old revision stops serving.

## Why

When two sections in a report share a name, or a section is renamed while its task waits, the generated text lands on the wrong section or nowhere, and readers see wrong or missing content. Switching how sections are identified while the old service and old queued tasks are still running risks broken reads and paid model calls whose results are thrown away.

## Key decisions

- Parallel change instead of an in-place rename: the new column is added and dual-written now and the old one dropped later, so rolling back this deploy is a traffic shift rather than a schema undo.
- The public report response keeps the field name `body`; only the storage column changes.
- Old name-shaped tasks are processed and counted, not dropped, because tasks queued before the deploy and any out-of-repo producer still send them.
- Invalid or orphaned tasks reply success so the queue does not retry them into paid calls.
- Bundled: retry bounds, a task deadline and model-call timeouts, surfaced during discovery to cap paid calls wasted by cut-over failures.

## Instrumentation

Spec-only — no dashboard URL exists yet. This change creates the repo's metrics contract with three section-task metrics (latency by outcome, failures by type, and a legacy-shaped-task counter that signals when the follow-up release is safe) plus the platform's queue depth, on a planned "reports-service overview" dashboard. These graphs need a metrics backend choice before they show anywhere (suggested: Google Cloud Monitoring via OTLP).

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/worker.test.ts` — id-shaped, legacy-shaped, invalid and unknown-id tasks all pass.
- [ ] Run `bun test src/queue.test.ts` — the task body decodes to `{ reportId, sectionId }` with a 180 s deadline.
- [ ] Run `bun test src/metrics.test.ts` — success, both failure types and the legacy counter are recorded.
- [ ] Run `docker run -d --name rs-pg -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16 && sleep 5 && for f in migrations/00*.sql; do docker exec -i rs-pg psql -U postgres -v ON_ERROR_STOP=1 < "$f"; done` — all three migrations apply cleanly.
- [ ] Run `DATABASE_URL=postgres://postgres:pg@localhost:55432/postgres bun test src/db.test.ts` — id-keyed save writes one row and reads return `body` for old and new rows.
- [ ] Run `bash -n deploy.sh && grep -q -- '--max-attempts=5' deploy.sh` — the deploy script parses and sets the retry cap.
- [ ] DECISION: accept that the column rename finishes only in a follow-up release, and that this deploy needs the add-column step before and the backfill step after.
