# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Rename section `body` to `content` and key section tasks by id

**Goal:** Generated section text lives under `content` and each generation task names its exact section, with no failed or double-paid generations while the change rolls out.

## Problem Statement

Each report is split into sections, and a background task writes the generated text for one section at a time. Today the stored text is called "body" and each task names its section only by its title, so the worker has to find the section by title inside the report. Two sections that share a title collide, and a task can never name one row exactly. Changing the storage name and the task shape in place is risky: the service deploys straight to all traffic, tasks already waiting in the queue still carry the old shape, and every retry of a failed task pays for another 20–60 second model call.

| Evidence | What the code shows |
| --- | --- |
| Column to rename | `body text` on `sections` [anchor: migrations/001_reports.sql:13] |
| No uniqueness on section titles | `sections` has no unique `(report_id, name)` constraint [anchor: migrations/001_reports.sql:8] |
| Task carries the title | the payload is `{ reportId, section }` [anchor: src/queue.ts:11]; the worker reads it as a name [anchor: src/worker.ts:6] |
| Write is keyed by title | `update sections set body = … where report_id = … and name = …` can touch several rows [anchor: src/db.ts:16] |
| Read exposes the column name | the report read selects `id, name, body` and returns it as the response [anchor: src/db.ts:12] [anchor: src/app.ts:14] |
| Paid call happens before the write | the model call precedes the save, so a failing save after a migration mismatch wastes a paid call per retry [anchor: src/worker.ts:9] [anchor: src/llm.ts:1] |
| Deploys go straight to all traffic, migrations run separately | `gcloud run deploy` with no migration step [anchor: deploy.sh:4] |
| Producer has no caller in this repo | `enqueueSection` is defined but never called, and sends no credentials [anchor: src/queue.ts:4] |

Who is affected, in the product brief's ranked terms: **user experience** (a report reader sees a section stay empty, or a report read fail, while the change rolls out) and **cost** (every retried task re-buys a paid generation).

## Request vetting

- **Hypothesis:** The column and the task payload can switch to the new shapes without a single failed report read, a lost section, or a repeated paid generation, provided the old and new code can both read and write during the rollout.
- **Case against:** Doing it as asked in one release, renaming the column and switching the payload together, breaks whichever revision is live during the gap. `deploy.sh` deploys straight to all traffic and runs no migration [anchor: deploy.sh:4]. The old revision's read and write name `body` [anchor: src/db.ts:12]. Queued tasks still carry the title-only shape [anchor: src/worker.ts:6]. A write that fails after the model call retries the paid call [anchor: src/worker.ts:9]. Parallel change is the standard remedy: https://martinfowler.com/bliki/ParallelChange.html
- **Sources:** https://martinfowler.com/bliki/ParallelChange.html
- **Verdict:** adopt-with-conditions: ship as expand-only — `content` added, backfilled and dual-written, worker accepting both task shapes — and drop `body` and the title-keyed path only after the legacy-task counter has read zero for longer than the queue's retry horizon

## Existing-code assessment

- **migrations/:** keep — append-only numbered SQL files; add `002` beside `001` [anchor: migrations/001_reports.sql]
- **src/db.ts:** simplify — replace the title-keyed `saveSection` with id-keyed reads and writes; the title lookup survives only as a legacy resolver [anchor: src/db.ts:15]
- **src/queue.ts:** simplify — the enqueue ignores the response status and sets no timeout; fix both while changing the payload [anchor: src/queue.ts:5]
- **src/worker.ts:** rewrite — the handler trusts one payload shape and regenerates on every delivery; it becomes a tolerant reader with an id-keyed idempotent skip [anchor: src/worker.ts:6]
- **src/llm.ts:** simplify — `generateSection` has no timeout and treats an error response as text; add both checks [anchor: src/llm.ts:6]
- **src/app.ts:** keep — the report read already delegates to `listSections`; its response shape stays the same [anchor: src/app.ts:14]
- **deploy.sh:** simplify — the queue is created with no retry settings; set max attempts there [anchor: deploy.sh:3]

## Scope Boundary

**In scope:**

- A new migration that adds `content`, copies existing `body` text into it, plus its down migration.
- Reads use `content` (falling back to `body` for rows the old revision wrote during rollout); writes go to both columns.
- The generate-section task carries the section id. During the transition it also carries the title so a rolled-back revision can still process it.
- The worker accepts both the new id-keyed task and the old title-keyed task, and skips the paid call when the section already has text.
- Timeouts and failure checks on the two outbound calls the worker path makes (model call, enqueue), a per-task dispatch deadline, and a max-attempts cap on the `sections` queue.
- A minimal zero-dependency metrics helper plus `.flow/metrics.md`, so the legacy-task count that gates the cleanup is visible.
- Tests for the migration, persistence, producer and worker.

**Out of scope:**

- Dropping `body`, removing dual-writes, and removing the title-keyed path and title field (the contract step, a ticked candidate below).
- Renaming the report-read response field from `body` to `content` (Open Question).
- Authenticating the task endpoint and a spend ledger (candidates below).
- A migration runner: migrations stay manually applied.

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| Report read returns each section as `{ id, name, body }` | Report read returns the same `{ id, name, body }`, now sourced from `content` |
| A redelivered generation task re-runs the paid model call and may overwrite the section's text with a different version | A redelivered task for a section that already has text is acknowledged without a model call; the first text stays |
| Two same-titled sections in one report both receive whichever text was generated last | Each task writes exactly one section |

### System flow

- **Before:**
  - The producer enqueues `{ reportId, section: <title> }`.
  - The worker looks the report up, calls the model, and updates every `sections` row matching `(report_id, name)` in `body`.
  - The model call and the enqueue have no timeout; an error response from the model is stored as empty text and the task completes.
- **After:**
  - The producer enqueues `{ reportId, sectionId, section: <title> }` with a 300 s dispatch deadline; it raises on a non-2xx response and times out after 10 s. The `sections` queue stops retrying a task after 10 attempts.
  - The worker resolves the section by `sectionId`, or by title for legacy tasks; it acknowledges unknown or malformed tasks with a 2xx so they are not retried, skips sections that already have text, and otherwise calls the model (120 s timeout, error responses raise so the queue retries) and writes `content` and `body` for that one row.
  - Each task records its shape (`id` or `legacy_name`) and its disposition in the new metrics helper.

**Lost:** re-sending a task for a section that already has text no longer regenerates it; title-only tasks become a legacy shape slated for removal; stored section text is held twice until the contract step.

## User Stories / Acceptance Criteria

### Story 1: Storage moves to `content` without breaking either revision

- [ ] Given a database at migration 001 with generated sections, when migration 002 is applied, then every row's `content` equals its `body` — verified by `test/db.test.ts`.
- [ ] Given migration 002 applied, when the down migration and then 002 again are applied, then both runs succeed and `content` is repopulated — verified by Task 1's `psql` command exiting 0.
- [ ] Given a section saved by the new code, when the old revision's query `select id, name, body from sections` runs, then it returns the new text — verified by `test/db.test.ts` (dual-write).
- [ ] Given a row the old revision wrote only to `body`, when the report read runs, then it returns that text — verified by `test/db.test.ts` (coalesce fallback).

### Story 2: Tasks name their section by id

- [ ] Given `enqueueSection(reportId, sectionId, name)`, when it runs, then the task body decodes to `{ reportId, sectionId, section: name }` — verified by `test/queue.test.ts`.
- [ ] Given an id-keyed task, when the worker runs, then it generates for and writes only that section id — verified by `test/worker.test.ts`.
- [ ] Given a legacy `{ reportId, section }` task, when the worker runs, then it resolves the section by title and writes that one row — verified by `test/worker.test.ts`.

### Story 3: Redelivery and bad tasks cost nothing

- [ ] Given a section that already has text, when its task is delivered again, then the worker returns 200 and makes no model call — verified by `test/worker.test.ts`.
- [ ] Given a task with neither a `sectionId` nor a `section`, or naming a missing section, when the worker runs, then it returns 200 and records `invalid_input` or `not_found` — verified by `test/worker.test.ts`.
- [ ] Given the model call fails or times out, when the worker runs, then it returns 500 (queue retries) and records `upstream_error` / `upstream_timeout`, and nothing is written — verified by `test/worker.test.ts`.

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports.section_task.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | generate-section worker |
| `reports.section_task.failures` | Counter | none | `error.type` (`_OTHER`, `internal`, `invalid_input`, `not_found`, `upstream_error`, `upstream_timeout`) | generate-section worker |
| `reports.section_task.deliveries` | Counter | `{task}` | `task.shape` (`id`, `legacy_name`), `task.disposition` (`generated`, `already_generated`, `dropped`) | generate-section worker |
| Cloud Tasks queue depth and oldest-task age | Gauge | `{task}`, seconds | `messaging.destination.name` (`sections`) | platform-native (Cloud Tasks metrics in Cloud Monitoring) |

Estimated series: 32 per operation — duration 2 × (13 explicit bounds `[1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 300, 600]` + 3) = 32; failures 6; deliveries 2 × 3 = 6; total 44 per instance.

**Attributes:** reuses the starter keys `operation.outcome`, `error.type`, `messaging.destination.name`; new keys `task.shape` (`id`, `legacy_name`) and `task.disposition` (`generated`, `already_generated`, `dropped`), added as `.flow/metrics.md` `## Attributes` rows.

### Error types

New list (first instrumented change): `_OTHER`, `internal`, `invalid_input` (task has no usable section reference), `not_found` (report or section no longer exists), `upstream_error` (model API answered non-2xx or without text), `upstream_timeout` (model API exceeded 120 s).

### Dashboard panels

On a `reports-service overview` dashboard (spec-only): section-task p50/p95/p99 duration; failures by `error.type`; deliveries by `task.shape` (the panel that gates the contract step: `legacy_name` must read zero); deliveries by `task.disposition`; Cloud Tasks `sections` depth and oldest-task age.

### Alerts

| Signal | Condition | Sustained for | Action | Routes to | Dashboard |
| --- | --- | --- | --- | --- | --- |
| `sections` oldest-task age | > 30 min | 15 min | notify | the owner's notification channel (name recorded in `.flow/metrics.md`) | reports-service overview |

Plus burn-rate tiers on the SLO below.

### SLO

New journey SLO `section-generation`: SLI = share of section tasks whose final delivery ends `operation.outcome=ok`; target 99% over 28 days.

**As-code:** spec-only — the repo keeps no dashboard or alert config and no metrics backend is chosen yet (`backend: none yet — suggested: Google Cloud Monitoring`).

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | DB schema, persistence, queue producer, queue consumer, outbound model client, metrics helper |
| Domain modules | existing `sections` table, `src/db.ts`, `src/queue.ts`, `src/worker.ts`, `src/llm.ts`; new `src/metrics.ts` |
| Data flow | producer enqueues `{ reportId, sectionId, section }` → Cloud Tasks → worker resolves the section row → model call → write `content` and `body` → report read serves `coalesce(content, body)` as `body` |
| Pattern | expand/contract (parallel change) for the column; tolerant reader for the task payload; the existing "acknowledge with 2xx when the unit is gone" convention [anchor: src/worker.ts:8] extended to missing sections and malformed tasks |
| Binary-framing check | the request is not framed A-or-B; the middle ground between "rename in place" and "leave as is" is the expand-only release chosen here |
| Goal-anchor check | every decision serves the Goal's "no failed or double-paid generations"; the one-shot rename the request literally describes conflicts with it and is challenged in Request vetting |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| Generate-section task consumer | ~60 s | queue — existing Cloud Tasks `sections` queue, worker invoked synchronously under the attempt deadline | model call 120 s, inside a 300 s per-task dispatch deadline (set by the producer, equal to Cloud Run's default request timeout) | queue retry policy only, capped at 10 attempts (platform-default backoff); the worker never retries itself | section id — skip when the row already has text | one paid generation per section; redelivery after a save costs nothing; no global cap (candidate) |
| Enqueue section task | inline — <1 s, timeout 10 s | inline | 10 s | none in-process; the caller sees the raised error | none (no caller in this repo) | free |
| Report read | inline — <1 s, timeout unchanged (Bun SQL client default) | inline | unchanged | none | n/a | free |
| Expand migration 002 (one-off, manual `psql`) | seconds — one `ALTER` plus one `UPDATE` | one-off script, before deploy | n/a | re-run is safe | `add column if not exists`, `where content is null` | free |

**Platform:** gcp

**Proportionality:** deliberately left out — a canary or `--no-traffic` split (deploy.sh deploys straight to all traffic; rollback is a traffic shift back), a payload `version` field (shapes are distinguishable by `sectionId`), a separate resumable backfill job (one re-runnable `UPDATE`), a spend ledger (candidate), a dead-letter destination (a task that exhausts its attempts shows in the failures counter), a migration runner.

**Recovery:** none — migration 002 only adds a nullable column and copies `body` into it; `body` is never modified and keeps being written, so nothing can be lost, and generated text is regenerable at a known per-call cost. The destructive `drop column body` is deferred to the contract candidate, which carries the on-demand backup step.

**Rollback:** Task 1

## Technical Constraints

- Every read of `content` in the worker happens before the paid model call, so a deploy that lands before migration 002 fails fast with no spend. Today the read already precedes the model call [anchor: src/worker.ts:7].
- Any task the worker can never process returns 2xx. Cloud Tasks retries every non-2xx, and the existing handler already returns 200 for a missing report [anchor: src/worker.ts:8].
- The new task body keeps the `section` title field, because the previous revision's consumer reads only `reportId` and `section` [anchor: src/worker.ts:6].
- Deadlines shrink inward: model call 120 s < dispatch deadline 300 s ≤ Cloud Run's request timeout, which `deploy.sh` leaves at its default [anchor: deploy.sh:4].
- Migration 002 is applied by hand with `psql` before `./deploy.sh`, because the deploy runs no migration [anchor: deploy.sh:4].
- No new runtime dependency. The metrics helper is a zero-dependency in-memory recorder [anchor: AGENTS.md:5].
- Cost: the idempotent skip removes the repeat paid call on redelivery. Dual-writing keeps two copies of each section's text until the contract step.

## Open Questions

- [ ] Q1 — Is the service live, with real reports and queued tasks, and does anything outside this repo enqueue generate-section tasks? If nothing is live, the plan collapses to a one-shot rename: no dual-write, no legacy task path, no contract follow-up.
  - **Stakes:** both — if it is live and the plan were collapsed, report reads fail and queued sections are lost or re-paid during the deploy (user experience, cost); if it is not live, the expand-only shape costs one extra follow-up release.
  - **Needs user input:** credentials or production access — whether production has traffic, queued tasks, or an external producer can only be checked with production access; the in-repo producer is never called and sends no credentials [anchor: src/queue.ts:4], so tasks may come from elsewhere.
- [ ] Should the report-read response keep the field name `body`, or switch to `content`? Switching changes the response every API client parses.
  - **Stakes:** user — a renamed response field breaks any client that reads `body`.
  - **Recommended:** keep `body` in the response, sourced from `content` — the request names the column, not the API, and no API client is in the repo to check the blast radius [confidence: medium] [anchor: weighing: risk — the response is built straight from the query row (src/app.ts:14), so a column-name leak would silently rename a public field]
- [ ] Should a task for a section that already has text skip the model call? Skipping removes re-buys on redelivery but means re-sending a task no longer regenerates.
  - **Stakes:** both — without the skip every redelivery re-buys a 20–60 s paid generation and can swap the text a reader already saw (cost, user experience); with it, intentional regeneration needs a future explicit path.
  - **Recommended:** skip when the row already has text; no regenerate path exists in the repo to break [confidence: medium] [anchor: adjacent: src/worker.ts:8]
- [ ] Should the new task body keep the section title alongside the id during the transition?
  - **Stakes:** system — without it, a rollback to the previous revision receives tasks it cannot read and pays for a generation it writes nowhere.
  - **Recommended:** keep `section` in the body until the contract step; the previous consumer reads only that field [confidence: high] [anchor: src/worker.ts:6]
- [ ] For a legacy title-keyed task where two sections share the title, which row gets the text?
  - **Stakes:** system — picking the wrong rule leaves one same-titled section permanently empty once the idempotent skip is on.
  - **Recommended:** the first same-titled row still missing text, ordered by position, falling back to the first by position — each legacy task then fills one distinct row [confidence: medium] [anchor: weighing: risk — migrations/001_reports.sql:8 has no unique (report_id, name), so duplicates are possible]
- [ ] How is migration 002 applied? A redirect to a migration tool changes the file format and the rollout steps.
  - **Stakes:** system — applying it after the deploy makes reads and task processing fail until it lands.
  - **Recommended:** by hand with `psql` before `./deploy.sh`, matching the repo's single plain-SQL migration and its migration-free deploy [confidence: high] [anchor: deploy.sh:4]
- [ ] How many attempts should the `sections` queue allow before giving up on a task? A different number changes only the deploy flag, but it bounds the paid calls one failing section can buy.
  - **Stakes:** both — too low drops sections during a short model outage (user experience); too high lets one failing section keep buying generations (cost).
  - **Recommended:** 10 attempts with platform-default backoff — enough to ride out a model outage of tens of minutes, and a hard ceiling of 10 paid calls per section where today there is none [confidence: medium] [anchor: weighing: risk — deploy.sh:3 sets no cap today]
- [x] Where do tests live? — `test/`, so the Dockerfile's `COPY src ./src` keeps them out of the image.
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision A — how does the rename reach production?**

| Branch | Downstream flow | Interruptions |
| --- | --- | --- |
| A1 One-shot: `rename column` + payload switch in one release | Migration then deploy: the live revision's report read and worker write fail until the deploy lands; each failed write retries after a paid call. Deploy then migration: the new revision fails the same way. Rollback needs a reverse rename, and tasks enqueued by the new revision reach an old consumer that cannot read them. | 0 prompts, but an outage window on every deploy and rollback |
| A2 Pause the queue, rename, deploy, resume | No paid retries while paused; report reads still fail in the window; rollback still needs a reverse rename and in-flight new-shape tasks still reach the old consumer. | 3 manual operator steps per release |
| A3 Expand-only now, contract later (chosen) | Migration 002 is additive, so the old revision keeps working; the new revision dual-writes, so a rollback is a traffic shift with no data step; both task shapes are processed; `body` is dropped in a follow-up once the legacy counter reads zero. | 0 prompts; 1 extra follow-up release |

Exclusive: A1, A2 and A3 cannot coexist. Ranked: A3 > A2 > A1. If Q1 answers "not live", A1 becomes acceptable and cheapest. Verdict: **A3** — it is the only branch where the previous revision can read every row the new one writes and every task the new one enqueues, which protects the brief's top two priorities (user experience, then cost) [confidence: medium] [anchor: weighing: reversibility — deploy.sh:4 has no migration step to sequence a rename against]

## Alternatives considered

- **Explicit `version` field in the task payload** — rejected: the shapes are distinguishable by the presence of `sectionId`, and the current consumer reads only `reportId` and `section` (src/worker.ts:6), so no reader needs it.
- **Generated column or view aliasing `body` as `content`** — rejected: a Postgres generated column is read-only, so the write at src/db.ts:16 could not move to it; a view adds a second relation name every query must learn.

## Recommendation

**Reconsider scope** — build the rename as an expand-only release now (column added, dual-written, both task shapes accepted) and drop `body` in the ticked contract follow-up; if Q1 says nothing is live, collapse to a one-shot rename. The worker is rewritten into a tolerant reader; `src/db.ts`, `src/queue.ts`, `src/llm.ts` and `deploy.sh` get bundled simplifications (id-keyed writes, timeouts, failure checks, a queue attempt cap) [confidence: medium] [anchor: weighing: reversibility — the previous revision must keep reading src/db.ts:12's `body` during the deploy]

**Redundancy:** none found

## Plan risks

The weakest assumption is that nothing outside this repo writes `sections.body` (a sibling service, a manual fix-up, a BI job). Such a write after the backfill would leave `content` stale with no error, because reads prefer `content` whenever it is non-null.

## Cut list

- The SLO and alert rows in `.flow/metrics.md` are spec-only text with no backend to evaluate them. They could shrink to the Coverage and Helper sections if the owner will not choose a backend soon.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Authenticate the generate-section task endpoint | High | Medium | needs its own design/decision session: the open decision is whether to split the worker into its own non-public Cloud Run service or verify the Cloud Tasks OIDC token in the handler; today anyone can trigger paid generations | same endpoint whose payload this plan changes | No |
| Contract step: drop `body`, dual-writes and the title-keyed task path | Medium | Small | needs its own design/decision session: the open decision is when the pre-rename revision and legacy title-keyed tasks are retired, which only the production legacy-task counter can answer; finishes the requested rename | completes this request's rename once the expand release has drained | No |
| Cap paid generation spend | Medium | Small | needs its own design/decision session: the open decision is the daily spend ceiling for paid generation and what happens to tasks over it; nothing bounds total model spend today | same paid call this plan touches | No |

- [x] Authenticate the generate-section task endpoint — the service is deployed `--allow-unauthenticated` and the task route sits on the public service, so any caller can trigger paid model calls.
  - **UX:** none
  - **Problem:** anyone who can reach the service URL can POST to the task route and spend on model calls, bypassing the queue [anchor: deploy.sh:4]
  - **Stability/efficiency:** none
  - **Value rank:** 5 — security exposure: unauthenticated callers can trigger paid work [anchor: src/app.ts:9]
  - **Complexity:** Medium — deploy config plus either a second service or token verification in the handler
  - **Risk:** Medium — a misconfigured invoker role stops all section generation
  - **If never done:** the paid generation path stays open to any caller
  - **Verdict:** clears bar — an open paid endpoint outweighs a medium-sized deploy change
- [x] Contract step: drop `body`, dual-writes and the title-keyed task path — once the legacy-task counter reads zero.
  - **UX:** none
  - **Problem:** until it ships the rename the user asked for is half-done: two columns hold the same text and the worker keeps a second lookup path [anchor: user: "rename the `body` column on `sections` to `content`"]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk: a stray writer to `body` silently diverges from `content` [anchor: user: "rename the `body` column on `sections` to `content`"]
  - **Complexity:** Small — one migration, `src/db.ts`, `src/worker.ts`, `src/queue.ts`, with an on-demand Cloud SQL backup before the drop
  - **Risk:** Medium — dropping a column is irreversible without the backup
  - **If never done:** the duplicate column and legacy path stay forever and every write stores the text twice
  - **Verdict:** clears bar — it completes the requested change; the backup step contains the risk
- [ ] Cap paid generation spend — add one spend ledger checked in front of the model call.
  - **UX:** none
  - **Problem:** nothing bounds total model spend; every call is unmetered [anchor: src/llm.ts:1]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk: no runaway has been observed [anchor: src/llm.ts:1]
  - **Complexity:** Small — one ledger table plus a check at the model call
  - **Risk:** Low
  - **If never done:** spend stays bounded only by traffic and this plan's 10-attempt cap
  - **Verdict:** below bar — no observed runaway, and the ceiling is an owner decision this plan cannot make

# Task breakdown

### Task 1: Expand migration and its rollback

- **Skill:** `flow-system-design`
- **Description:** Add migration 002 that adds a nullable `content` column and copies `body` into it, re-runnable. Add the down migration that drops `content`. Put the rollback procedure in the down file's header comment: first shift traffic back with `gcloud run services update-traffic reports-service --region us-central1 --to-revisions=<previous>=100`, and only then, optionally, apply the down migration. The rollback is safe because the new code dual-writes `body`. Also put the rollout order in 002's header: apply 002 with `psql`, then `./deploy.sh`.
- **Inputs:** migrations/001_reports.sql
- **Outputs:** an additive, reversible schema change
- **Contract:**
  - **Files:** `migrations/002_sections_content.sql` (create), `migrations/002_sections_content.down.sql` (create)
  - **Interfaces:** DDL — `alter table sections add column if not exists content text;` then `update sections set content = body where content is null and body is not null;`. Down — `alter table sections drop column if exists content;`
  - **Call-site edits:** none
- **Acceptance criteria:** `createdb reports_mig_check && psql -d reports_mig_check -v ON_ERROR_STOP=1 -f migrations/001_reports.sql -f migrations/002_sections_content.sql -f migrations/002_sections_content.down.sql -f migrations/002_sections_content.sql -f migrations/002_sections_content.sql; rc=$?; dropdb reports_mig_check; exit $rc`

### Task 2: Id-keyed persistence with dual-write

- **Skill:** `flow-system-design`
- **Description:** Switch `src/db.ts` reads to `coalesce(content, body)` and writes to both columns, keyed by section id. Add a legacy resolver for title-keyed tasks that prefers the first same-titled row still missing text. The report-read row keeps the field name `body`.
- **Inputs:** Task 1
- **Outputs:** the persistence API the worker uses
- **Contract:**
  - **Files:** `src/db.ts` (edit)
  - **Interfaces:** `export type Section = { id: string; report_id: string; name: string; position: number; content: string | null }`; `export async function getSection(id: string): Promise<Section | undefined>`; `export async function findSectionByName(reportId: string, name: string): Promise<Section | undefined>` (order by `coalesce(content, body) is null desc, position`, limit 1); `export async function saveSectionContent(sectionId: string, content: string): Promise<void>` (`update sections set content = $1, body = $1 where id = $2`); `listSections(reportId)` selects `id, name, coalesce(content, body) as body`; remove `saveSection`
  - **Call-site edits:** `src/worker.ts` `handleGenerateSection` stops importing `saveSection` (done in Task 6)
- **Acceptance criteria:** `bun build src/db.ts --target bun --outdir "$(mktemp -d)" && grep -q 'coalesce(content, body)' src/db.ts && ! grep -q 'export async function saveSection(' src/db.ts`

### Task 3: Bound and check the model call

- **Skill:** `flow-system-design`
- **Bundled:** the missing timeout and the error-as-text bug on the model call, found while checking the worker's deadline chain
- **Description:** `generateSection` gets a 120 s abort timeout. It throws `UpstreamError` on a non-2xx response or a body with no string `text`, so a failed call never stores empty text. Timeouts surface as `UpstreamTimeoutError`.
- **Inputs:** src/llm.ts
- **Outputs:** a bounded model call whose failures the worker can classify
- **Contract:**
  - **Files:** `src/llm.ts` (edit)
  - **Interfaces:** `export class UpstreamError extends Error {}`; `export class UpstreamTimeoutError extends Error {}`; `export const GENERATE_TIMEOUT_MS = 120_000`; `generateSection(company: string, section: string): Promise<string>` signature unchanged, fetch gains `signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS)`
  - **Call-site edits:** none (signature unchanged)
- **Acceptance criteria:** `bun build src/llm.ts --target bun --outdir "$(mktemp -d)" && grep -q 'AbortSignal.timeout(GENERATE_TIMEOUT_MS)' src/llm.ts`

### Task 4: Metrics helper and metrics contract

- **Skill:** `flow-metrics`
- **Description:** Create a zero-dependency metrics helper with a swappable in-memory recorder and closed `ErrorType` and attribute unions. Create `.flow/metrics.md` with namespace `reports`, the attributes, the error types, the helper path, the panels, the alert row, the `section-generation` SLO, `## As-code: spec-only`, `## Backend: none yet — suggested: Google Cloud Monitoring`, and `## Coverage` listing `section_task`. The planned metrics are `reports.section_task.duration` (histogram, the explicit bounds in the Instrumentation section), `reports.section_task.failures` (counter by `error.type`: `_OTHER`, `internal`, `invalid_input`, `not_found`, `upstream_error`, `upstream_timeout`) and `reports.section_task.deliveries` (counter by `task.shape`, `task.disposition`).
- **Inputs:** none
- **Outputs:** `instrument`/`count` helpers the worker calls
- **Contract:**
  - **Files:** `src/metrics.ts` (create), `.flow/metrics.md` (create)
  - **Interfaces:** `export type ErrorType = "_OTHER" | "internal" | "invalid_input" | "not_found" | "upstream_error" | "upstream_timeout"`; `export type Attrs = { "operation.outcome"?: "ok" | "error"; "error.type"?: ErrorType; "task.shape"?: "id" | "legacy_name"; "task.disposition"?: "generated" | "already_generated" | "dropped" }`; `export interface Recorder { histogram(name: string, value: number, attrs: Attrs): void; counter(name: string, attrs: Attrs): void }`; `export function setRecorder(r: Recorder): void`; `export function memoryRecorder(): Recorder & { records: Array<{ kind: "histogram" | "counter"; name: string; value?: number; attrs: Attrs }> }`; `export function count(name: string, attrs: Attrs): void`; `export async function instrument<T>(op: string, fn: () => Promise<T>, classify: (e: unknown) => ErrorType): Promise<T>`
  - **Call-site edits:** none (first used in Task 6)
- **Acceptance criteria:** `bun build src/metrics.ts --target bun --outdir "$(mktemp -d)" && test -f .flow/metrics.md && grep -q 'task.shape' .flow/metrics.md`

### Task 5: Producer carries the section id; queue gets its must-set settings

- **Skill:** `flow-system-design`
- **Bundled:** the enqueue's missing timeout and ignored response status, and the queue's missing max-attempts cap and dispatch deadline
- **Description:** `enqueueSection` takes the section id and title and enqueues `{ reportId, sectionId, section }`. The title stays until the contract step so a rolled-back consumer can still read the task. Export the payload types for the worker. Add a 10 s timeout, and throw on a non-2xx response. Set `dispatchDeadline: "300s"` on every task. In `deploy.sh`, cap the queue at 10 attempts on both a fresh and an existing queue.
- **Inputs:** src/queue.ts
- **Outputs:** the id-keyed task shape
- **Contract:**
  - **Files:** `src/queue.ts` (edit), `deploy.sh` (edit)
  - **Interfaces:** config — `deploy.sh` line 3 before: `gcloud tasks queues create sections --location us-central1 || true`; after: `gcloud tasks queues create sections --location us-central1 --max-attempts=10 || gcloud tasks queues update sections --location us-central1 --max-attempts=10`. Task body gains `dispatchDeadline: "300s"`. Code — `export type LegacySectionTask = { reportId: string; section: string }`; `export type SectionTask = { reportId: string; sectionId: string; section: string }`; `export async function enqueueSection(reportId: string, sectionId: string, sectionName: string): Promise<void>`
  - **Call-site edits:** none — `enqueueSection` has no caller in the repo
- **Acceptance criteria:** `bun build src/queue.ts --target bun --outdir "$(mktemp -d)" && grep -q 'sectionId' src/queue.ts && grep -q 'AbortSignal.timeout(10_000)' src/queue.ts && grep -q 'dispatchDeadline' src/queue.ts && [ "$(grep -c -- '--max-attempts=10' deploy.sh)" = 2 ] && bash -n deploy.sh`

### Task 6: Tolerant, idempotent, instrumented worker

- **Skill:** `flow-system-design`
- **Description:** The worker parses the task body tolerantly. When `sectionId` is present it calls `getSection` and requires `report_id === reportId`; otherwise it falls back to `findSectionByName` for legacy tasks. A missing report or section returns 200 `gone` (`not_found`, disposition `dropped`). A body with no usable reference returns 200 (`invalid_input`, `dropped`). A section that already has content returns 200 with no model call (`already_generated`). Otherwise the worker calls `generateSection(report.company, section.name)`, then `saveSectionContent(section.id, text)` (`generated`). Model failures return 500 so the queue retries (`upstream_error`/`upstream_timeout`). All `content` reads happen before the model call. Wrap the work in `instrument("section_task", …)` and count deliveries by `task.shape`. Idempotency key: the section id. Timeout: the 120 s model-call timeout, inside the 300 s dispatch deadline.
- **Inputs:** Tasks 2, 3, 4, 5; existing Cloud Tasks queue `sections` (deploy.sh)
- **Outputs:** the generate-section consumer accepting both shapes
- **Contract:**
  - **Files:** `src/worker.ts` (edit)
  - **Interfaces:** `export function parseSectionTask(body: unknown): { reportId: string; sectionId?: string; sectionName?: string; shape: "id" | "legacy_name" } | null`; `handleGenerateSection(req: Request): Promise<Response>` signature unchanged
  - **Call-site edits:** `src/worker.ts` imports `getSection`, `findSectionByName`, `saveSectionContent` instead of `saveSection`; `src/app.ts` route unchanged
- **Acceptance criteria:** `bun build src/app.ts --target bun --outdir "$(mktemp -d)" && grep -q 'getSection' src/worker.ts && ! grep -q 'saveSection(' src/worker.ts` — the idempotency key (section id) and the 120 s timeout are asserted by Task 8's tests

### Task 7: Migration and persistence integration tests

- **Skill:** `flow-testing`
- **Description:** Run against a real Postgres from `DATABASE_URL`, and skip with a named reason when it is unset. Before each test, drop and recreate the schema by applying `001` and then `002`. The tests assert: the backfill copies `body` into `content`; `saveSectionContent` writes both columns, so the old query `select id, name, body` sees the new text; `listSections` returns `body` sourced from `coalesce(content, body)`, including a row written only to `body`; `getSection` and `findSectionByName` resolve correctly, with the legacy resolver preferring an empty same-titled row; and down-then-up succeeds.
- **Inputs:** Tasks 1, 2
- **Outputs:** regression coverage for the schema and the persistence layer
- **Contract:**
  - **Files:** `test/db.test.ts` (create)
  - **Interfaces:** none exported
  - **Call-site edits:** none
- **Acceptance criteria:** `docker run -d --rm --name reports-pg-test -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16 && until docker exec reports-pg-test pg_isready -U postgres; do sleep 1; done && DATABASE_URL=postgres://postgres:pg@localhost:55432/postgres bun test test/db.test.ts; rc=$?; docker stop reports-pg-test; exit $rc`

### Task 8: Worker, producer and metrics-emission tests

- **Skill:** `flow-testing`
- **Description:** Use `mock.module` for `../src/db` and `../src/llm`, `memoryRecorder()` for metrics, and a stubbed `fetch` for the producer. Worker cases: an id-keyed task generates and writes only that id (asserts `saveSectionContent` is called with the section id); a legacy task resolves by title; an already-generated section returns 200 with zero model calls (the idempotency key); report or section missing returns 200 with `not_found`; a malformed body returns 200 with `invalid_input`; a model `UpstreamError` returns 500 with `upstream_error` and no write; an `UpstreamTimeoutError` returns 500 with `upstream_timeout`; deliveries are counted by `task.shape` and `task.disposition`; the duration histogram records `ok` and `error`. Producer cases: the decoded body equals `{ reportId, sectionId, section }`; the task sets `dispatchDeadline: "300s"`; a non-2xx response throws. Model-client case: the 120 s timeout constant is wired.
- **Inputs:** Tasks 3, 4, 5, 6
- **Outputs:** regression coverage for the payload switch and the idempotent skip
- **Contract:**
  - **Files:** `test/worker.test.ts` (create), `test/queue.test.ts` (create)
  - **Interfaces:** none exported
  - **Call-site edits:** none
- **Acceptance criteria:** `bun test test/worker.test.ts test/queue.test.ts`

| Task | Depends on |
| --- | --- |
| 1 | — |
| 2 | 1 |
| 3 | — |
| 4 | — |
| 5 | — |
| 6 | 2, 3, 4, 5 |
| 7 | 1, 2 |
| 8 | 3, 4, 5, 6 |

### Skills Summary

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-system-design | Yes (Tasks 1, 2, 3, 5, 6) | schema expand/contract, queue payload rollout, consumer idempotency and timeouts |
| flow-metrics | Yes (Task 4) | first instrumented change: helper plus `.flow/metrics.md` |
| flow-testing | Yes (Tasks 7, 8) | new integration and unit test suites; the repo has none |
| flow-new-feature | No | drives implementation overall; no task needs it as a per-task guide |
| flow-refactoring | No | the change alters behaviour (payload, idempotent skip), so it is not a behaviour-preserving refactor |

# PR description draft

## TLDR

Section generation now targets one exact section and never pays twice for the same section, and stored section text moves to a new name without breaking reports during rollout.

## User-facing changes

- Re-delivered generation tasks no longer re-run the paid model call:
  - **Before:** each redelivery bought a new generation and could replace text a reader had already seen.
  - **After:** a section that already has text keeps it and the task completes immediately.
- Same-titled sections in one report each get their own generated text:
  - **Before:** one generation was written into every section sharing the title.
  - **After:** each task writes exactly one section.
- The report read keeps returning each section's text under the same field name.

## System changes

- Generation tasks now name their section by id:
  - **Before:** a task carried only the report and the section title.
  - **After:** a task carries the report, the section id, and (until the follow-up cleanup) the title; the worker still accepts title-only tasks.
- Section text is stored under `content`:
  - **Before:** text lived in `body`.
  - **After:** text is written to both `content` and `body`, and read from `content` with a fallback, so the previous release can still read everything; `body` is dropped in a follow-up.
- The model call and the enqueue now have timeouts (120 s and 10 s). A failed model call is retried by the queue instead of stored as empty text.
- Retries are bounded:
  - **Before:** the queue had no attempt cap, so a failing section could keep buying generations.
  - **After:** a task stops after 10 attempts, and each attempt has a 300 s deadline.
- Cost: one fewer paid generation for every redelivered task; section text is stored twice until the cleanup ships.

## Why

The generation worker finds its section by title, so sections that share a title collide, and a task cannot name one row exactly. The stored text's name is also being changed. The service deploys straight to all traffic, and tasks already waiting in the queue keep the old shape. An in-place change would fail report reads, and every failure would re-buy a paid generation on retry.

## Key decisions

- Expand now, contract later: the old column stays and is still written, so rolling back is a traffic shift with no data step. Dropping it waits for the follow-up, once no title-only tasks arrive.
- The worker accepts both task shapes, and the new shape keeps the title, so tasks survive a deploy and a rollback in either direction.
- The report read keeps its field name. The request named the storage column, not the API.
- Tasks the worker can never process are acknowledged, not retried, and counted under a named failure class.
- Bundled: the missing timeout and error-as-text bug on the model call.
- Bundled: the enqueue's missing timeout and ignored response status, and the queue's missing max-attempts cap and dispatch deadline.

## Instrumentation

Spec-only: no metrics backend is chosen yet, so these metrics are recorded but won't show on any graph until one is picked (suggested: Google Cloud Monitoring; status in `.flow/metrics.md` `## Backend`). Panels added to the `reports-service overview` spec: section-task duration percentiles, failures by class, deliveries by task shape (the cleanup gate: the title-only count must read zero), deliveries by disposition, and queue depth and oldest-task age. New journey SLO `section-generation` at 99% over 28 days. One notify alert fires when the oldest queued task is older than 30 min for 15 min.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test test/worker.test.ts test/queue.test.ts` — all specs pass, including the already-generated skip with zero model calls and the legacy title-only task.
- [ ] Run `docker run -d --rm --name reports-pg-test -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16 && until docker exec reports-pg-test pg_isready -U postgres; do sleep 1; done` — a scratch Postgres is ready.
- [ ] Run `DATABASE_URL=postgres://postgres:pg@localhost:55432/postgres bun test test/db.test.ts` — the backfill, dual-write, fallback read and down-then-up specs pass.
- [ ] Run `createdb -h localhost -p 55432 -U postgres mig_check && psql -h localhost -p 55432 -U postgres -d mig_check -v ON_ERROR_STOP=1 -f migrations/001_reports.sql -f migrations/002_sections_content.sql -f migrations/002_sections_content.down.sql -f migrations/002_sections_content.sql` (with `PGPASSWORD=pg`) — exits 0.
- [ ] Run `docker stop reports-pg-test` — the scratch database is removed.
