# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Section text renamed to `content`; generation tasks target sections by id

**Goal:** Each queued generation writes exactly the section it was queued for, section text lives in a `content` column, and no deploy, rollback, or in-flight task breaks during the switch.

## Problem Statement

This service generates report sections with a paid model API and serves the saved text back to report readers. Today a queued generation job finds its section by name instead of by the section's unique identifier, so when one report has two sections with the same name, each job overwrites both of them with the same text. The owner also wants the stored text field renamed. Doing either change in one step would break the version that is currently running, any jobs already waiting in the queue, and the ability to roll back.

In the product brief's terms: the wrong-section overwrite is a **product quality** defect (priority 4) that readers see as duplicated text (priority 1, user experience). A careless cut-over would spend paid model calls on jobs that save nothing (priority 2, cost).

| Fact | Evidence |
| --- | --- |
| Section text is stored in a column named `body` | [anchor: migrations/001_reports.sql:13] |
| `sections` has no uniqueness on `(report_id, name)` | [anchor: migrations/001_reports.sql:8-14] |
| The worker's write targets every row matching `(report_id, name)` | [anchor: src/db.ts:16] |
| The task payload is `{ reportId, section }`, where `section` is the name | [anchor: src/queue.ts:11] [anchor: src/worker.ts:6] |
| The section list reads `body` and its rows go straight into the `GET /reports/:id` JSON, so a bare column rename also renames the public response field | [anchor: src/db.ts:12] [anchor: src/app.ts:14] |
| `enqueueSection` has no callers in this repo, so whatever produces tasks today lives outside the repo or is not written yet | `grep -rn enqueueSection src` → only the definition in src/queue.ts:4 |
| Deploys go straight to 100% of traffic and apply no migrations | [anchor: deploy.sh:4] |

## Request vetting

- **Hypothesis:** The column rename and the switch from section name to section id can ship without breaking the running revision, tasks already in the queue, or a rollback to the previous revision.
- **Case against:** Doing it literally in one release breaks all three. The running code selects and updates `body` [anchor: src/db.ts:12] [anchor: src/db.ts:16]. `deploy.sh` ships to all traffic with no migration step [anchor: deploy.sh:4], so every read fails between an in-place `RENAME COLUMN` and the rollout finishing, and a rolled-back revision cannot read `content`. Cloud Tasks also delivers old-version tasks to the new worker and, after a rollback, new tasks to the old worker. An id-only payload reaching today's worker destructures `section` as `undefined` [anchor: src/worker.ts:6], spends a paid model call, and saves nothing.
- **Sources:** https://martinfowler.com/bliki/ParallelChange.html (expand/contract; cited through the flow-system-design data and rollout references, not fetched in this pass). The case itself rests on the repo code cited above.
- **Verdict:** adopt-with-conditions: ship as expand/contract — this PR adds `content` beside `body` and writes both, the task carries the section id plus a name field kept only for the transition, and the worker accepts both payload shapes; dropping `body`, the name field and the legacy branch waits for the contract follow-up once the legacy-payload counter has read zero for longer than the queue's task retention.

## Existing-code assessment

- **migrations/001_reports.sql:** keep — it is an already-applied migration; the change goes in a new numbered `002` file. [anchor: migrations/001_reports.sql:1]
- **src/db.ts:** simplify — replace the name-keyed `saveSection` with an id-keyed write, which is the defect this request fixes, and add a by-id read; the other queries keep their shape. [anchor: src/db.ts:15-16]
- **src/worker.ts:** keep — a small handler; extend it with a payload parser and the id lookup. [anchor: src/worker.ts:5-12]
- **src/queue.ts:** keep — the payload is changed in place. Its `btoa` encoding throws on non-Latin-1 section names, so it moves to UTF-8-safe base64 (bundled). [anchor: src/queue.ts:11]
- **src/llm.ts:** keep — add timeouts and a non-2xx check (bundled). Today a model-API error response is saved as empty section text. [anchor: src/llm.ts:10]
- **deploy.sh:** keep — add one queue-settings line after the existing create. [anchor: deploy.sh:3]

## Scope Boundary

**In scope:**

- Expand migration `002`: add `sections.content`, backfill it from `body`, and ship a down migration.
- A dual-write of `content` and `body` during the transition; reads take `coalesce(content, body)`.
- The task payload becomes `{ version: 2, reportId, sectionId, section }`. `section` is the name and is kept only for the transition.
- The worker looks the section up by id, and still accepts legacy `{ reportId, section }` tasks.
- Bundled: UTF-8-safe payload encoding, a model-call timeout and non-2xx check, and queue max attempts, backoff, concurrency and dispatch deadline.
- Required by the repo's planning contract: a backups/PITR preflight before the migration, and first worker metrics with `.flow/metrics.md`.

**Out of scope:**

- The contract step: dropping `body`, the transition name field and the legacy branch. Tracked as a candidate follow-up.
- Renaming the `GET /reports/:id` response field. See the Open Questions.
- Worker authentication. Tracked as a candidate follow-up.
- Skipping regeneration on redelivery, and a spend ledger.

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| A report with two same-named sections: each section's job overwrites both, so both show one shared generation | Each job writes only its own section, so each shows its own generation |
| `GET /reports/:id` returns `sections[].body` | `GET /reports/:id` still returns `sections[].body` (unchanged, per Open Questions) |
| A model-API error response is saved as empty section text and the job reports success | A model-API error fails the job, and the queue retries it up to 5 times |

### System flow

- **Before:**
  - The task payload is `{ reportId, section: <name> }`. The worker updates every `(report_id, name)` match.
  - Section text lives only in `body`.
  - Queue retries and the task deadline run on Cloud Tasks defaults. The model call has no timeout.
  - The worker emits no metrics.
- **After:**
  - The task payload is `{ version: 2, reportId, sectionId, section: <name> }`. The worker updates exactly one row by id, and legacy name-only tasks are still processed.
  - Section text lives in `content`, and `body` is still written for one release so a rollback can read it.
  - The queue allows max 5 attempts, backs off 10 s → 300 s, runs at most 5 concurrent dispatches, and gives each task a 180 s dispatch deadline. The model call times out at 120 s.
  - The worker emits a duration histogram, a failures counter and a legacy-payload counter.

**Lost:** Producers can no longer rely on the name alone. Name-only tasks are deprecated: still accepted here, removed by the contract follow-up. The queue's default retry budget is replaced by a 5-attempt cap.

## User Stories / Acceptance Criteria

### Story 1: A queued section is written to exactly that section

- [ ] Given a report with two sections both named `Intro`, when a v2 task for one section's id runs, then only that section's `content` and `body` are updated (`bun test src/worker.test.ts`).
- [ ] Given a v2 task whose `sectionId` does not exist, or belongs to a different report than `reportId`, when it runs, then the worker returns 200 and makes no model call (`bun test src/worker.test.ts`).

### Story 2: Tasks enqueued before the deploy still complete

- [ ] Given a legacy `{ reportId, section: "Intro" }` task, when it runs on the new worker, then every `Intro` row in that report gets the one generation, as today, and the legacy-payload counter goes up by one (`bun test src/worker.test.ts`).
- [ ] Given a payload matching neither shape, when it runs, then the worker returns 200 with no model call, and the failures counter records `invalid_input` (`bun test src/worker.test.ts`).

### Story 3: A rollback to the previous revision keeps working

- [ ] Given `enqueueSection(reportId, { id, name })`, when the task body is decoded, then it carries `version: 2`, `sectionId`, and the `section` name that the previous worker reads (`bun test src/queue.test.ts`).
- [ ] Given migration `002` applied to a database whose sections hold `body` text, when the up/down/up sequence runs on a scratch Postgres, then it exits 0 and `content` equals the prior `body` (the psql commands in Test Steps).
- [ ] Given the new code, when a section is saved, then both `content` and `body` hold the text (`bun test src/worker.test.ts` asserts the dual-write SQL).

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| --- | --- | --- | --- | --- |
| `reports.section.generate.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | generate-section worker |
| `reports.section.generate.failures` | Counter | none | `error.type` (`_OTHER`, `internal`, `invalid_input`, `not_found`, `upstream_error`, `upstream_timeout`) | generate-section worker |
| `reports.section.generate.legacy_payloads` | Counter | `{task}` | none | generate-section worker, when a name-only task arrives |
| Cloud Tasks queue depth | Gauge | `{message}` | `messaging.destination.name` (`sections`) | platform-native (Cloud Tasks `queue/depth`) |

The histogram uses job-scale boundaries `[1, 5, 10, 20, 30, 45, 60, 90, 120]` s (9 bounds), because a generation takes 20–60 s.

Estimated series: 31 per operation per instance (histogram 2 outcomes × (9 + 3) = 24, plus 6 `error.type` values, plus 1 legacy counter)

**Attributes:** new registry, seeded from the starter keys used here: `operation.outcome` (`ok`, `error`), `error.type` (the closed list below), `messaging.destination.name` (`sections`).

### Error types

New list, seeded from the starter values: `_OTHER` (fallback), `internal` (unexpected failure in this service), `invalid_input` (the task payload matches neither shape; client-caused), `not_found` (the section or report is gone before the task ran; client-caused), `upstream_error` (the model API returned non-2xx), `upstream_timeout` (the model call passed its 120 s timeout). Both client-caused values are excluded from the SLO.

### Dashboard panels

On a new "reports-service overview" dashboard:

- section generations by outcome
- failures by `error.type`
- generation latency p50/p95/p99
- legacy payloads received, which is the drain signal that gates the contract follow-up
- Cloud Tasks `sections` queue depth (native)

### Alerts

burn-rate tiers only

### SLO

A new journey SLO, "a queued report section gets generated": 99% of generate-section tasks end `ok` over 30 days, excluding `invalid_input` and `not_found`. The standard burn-rate tiers are recorded once in `.flow/metrics.md`.

**As-code:** spec-only — the repo keeps no dashboard or alert config.

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | DB schema (migration 002), persistence (`src/db.ts`), queue producer (`src/queue.ts`), queue consumer (`src/worker.ts`), model client (`src/llm.ts`), deploy config (`deploy.sh`), new metrics helper (`src/metrics.ts`) |
| Domain modules | Existing: db, queue, worker, llm. New: `src/metrics.ts`, a zero-dependency in-memory recorder. |
| Data flow | A producer enqueues `{version 2, reportId, sectionId, section}`. Cloud Tasks POSTs it to the worker. The worker reads the section row by id, reads its report, calls the model API, and writes `content` and `body` by id. `GET /reports/:id` reads `coalesce(content, body) as body`. |
| Pattern | Expand/contract for the column (flow-system-design data reference). Additive, versioned payload with the consumer accepting both shapes (flow-system-design rollout reference). |
| Binary-framing check | The request reads as one step, rename now. Middle ground chosen: expand now, contract later (see Decision analysis). |
| Goal-anchor check | The literal "instead of the section name" conflicts with the goal of not breaking a rollback. The name is kept as a transition-only field and removed in the contract step (Open Questions). |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| generate-section worker (changed consumer) | ~65 s | existing Cloud Tasks `sections` queue + worker invoked synchronously under the attempt deadline | model call 120 s < dispatch deadline 180 s < Cloud Run request 300 s | queue layer only: max 5 attempts, backoff 10 s → 300 s | section id (a redelivery overwrites the same single row) | ≤5 model calls per task (max attempts); queue max 5 concurrent dispatches; no spend ledger exists |
| enqueue generate-section task (changed producer) | ~300 ms | inline — ~300 ms, timeout 5 s | 5 s | none (the caller decides) | none (unnamed task; the consumer is effect-idempotent by section id) | no paid call |
| `GET /reports/:id` section list (changed projection) | ~50 ms | inline — ~50 ms, timeout 300 s (existing Cloud Run request limit, unchanged) | 300 s | none | n/a (read) | no paid call |
| migration 002 backfill (one-off) | ~seconds per 100k rows (unmeasured) | operator-run with `psql` before the deploy | `statement_timeout` 5 min, set in the file | none (re-runnable: `where content is null`) | n/a | no paid call |

**Platform:** gcp

**Proportionality:** No spend ledger. None exists, and this change does not add a paid call, so concurrency and attempt caps bound spend for now. No named-task dedupe and no skip-if-already-generated: a redelivery still spends one model call, as it does today. No canary: deploys stay straight to 100% because the expand release is rollback-safe. No separate worker service: worker auth is a candidate follow-up.

**Recovery:** Cloud SQL automated backups plus point-in-time recovery. Task 1's preflight verifies both are on, enables them with `--enable`, takes an on-demand backup before `002` runs, checks that the backup reports `SUCCESSFUL`, and with `--restore-check` restores it into a scratch instance and compares the `sections` row count against the source. `002` is additive and destroys nothing, so the destructive `drop column body` waits for the contract follow-up, which carries its own pre-drop backup.

**Rollback:** Task 1 — `migrations/002_sections_content.down.sql` drops `content`, and only applies before the contract step. The code rolls back by shifting Cloud Run traffic to the previous revision: `gcloud run services update-traffic reports-service --region us-central1 --to-revisions=<previous>=100`. That is safe because `body` is still written and v2 payloads still carry the `section` name the previous worker reads. The Test Steps run the up/down/up sequence.

## Technical Constraints

- The previous revision must keep working while `002` is applied, during the rollout, and after a rollback. So `body` keeps being written and is not renamed or dropped in this release. Source: flow-system-design `references/data.md` "Expand and contract" and `references/rollout.md` "Queue payloads survive deploys".
- `migrations/001_reports.sql` is already applied and must not be edited. The change ships as `002`. Source: the repo's numbered migration layout ([anchor: migrations/001_reports.sql:1]).
- `002` must be applied before the new revision is deployed, because the new reads reference `content`. `deploy.sh` runs no migrations ([anchor: deploy.sh:1-4]).
- A worker 2xx completes the task and any other status retries it (flow-system-design `references/gcp.md`). So a missing section and an invalid payload both return 200 and are counted, while model failures return 5xx and retry.
- No new runtime dependencies (AGENTS.md). The metrics helper is an in-memory recorder, and the tests use `bun:test`'s built-in `mock.module`.
- Cost: on the happy path, model calls per section are unchanged. The new 5-attempt cap and 5-dispatch concurrency cap put an upper bound on spend for a task that keeps failing.

## Open Questions

- [ ] Q1 — Does anything outside this repo enqueue generate-section tasks, and does the production `sections` queue hold tasks now? Redirect: if nothing enqueues and the queue is empty, cut the legacy-payload branch and the transition `section` field from Task 3, and the legacy counter from Task 5.
  - **Stakes:** system — if a name-only producer exists and the legacy branch were cut, its tasks would be dropped as `invalid_input`. That is product quality (priority 4).
  - **Needs user input:** credentials or production access — the in-repo producer has no callers (`grep -rn enqueueSection src`), so only the production queue and the owner's out-of-repo producers can answer.
- [ ] Ship as expand/contract, or rename in place in one release? Redirect: in-place drops the dual-write, the `coalesce`, the down migration and the contract candidate, and `002` becomes `alter table sections rename column body to content`.
  - **Stakes:** system — in-place makes every section read fail between the migration and the rollout, and blocks a rollback. That is architecture (priority 3) and product quality (priority 4).
  - **Recommended:** expand/contract — the running code reads and writes `body` and deploys go straight to all traffic, so only expand/contract keeps the previous revision readable [confidence: medium] [anchor: weighing: reversibility — src/db.ts:12 and deploy.sh:4 leave no migration-ordered or canary window for an in-place rename]
- [ ] Keep the `GET /reports/:id` response field as `body`, or rename it to `content`? Redirect: renaming changes Task 2's select alias to `as content` and adds a breaking API change to the PR's user-facing changes.
  - **Stakes:** user — any client parsing `sections[].body` would silently get `undefined`. That is user experience (priority 1).
  - **Recommended:** keep `body` in the API — the request names the column, not the public contract, and no API client exists in this repo to update alongside [confidence: medium] [anchor: weighing: risk — src/app.ts:14 spreads DB rows straight into the response, so the alias is the only thing keeping the field stable]
- [ ] Keep the section name in the v2 payload during the transition, against the literal "instead of the section name"? Redirect: id-only removes `section` from Task 3's producer, and a rollback then spends model calls that save nothing.
  - **Stakes:** both — a rolled-back worker given an id-only task spends a paid call (priority 2, cost) and leaves the section empty (priority 1).
  - **Recommended:** keep `section` as a transition-only field and remove it in the contract follow-up — the previous worker reads only `section` [confidence: high] [anchor: src/worker.ts:6]
- [ ] Keep `reportId` in the payload? Redirect: dropping it means the worker takes the report from the section row and loses the ownership cross-check.
  - **Stakes:** system — without it, a mis-addressed task could write a section of the wrong report.
  - **Recommended:** keep `reportId` and reject a section whose `report_id` differs — the user asked to replace only the name [confidence: high] [anchor: user: "carry the section id instead of the section name"]
- [ ] How is `002` applied? Redirect: if an automated runner applies migrations after the deploy, add a migrate-before-deploy step to `deploy.sh` in Task 6.
  - **Stakes:** system — if the column is missing when the new revision starts, every section read errors until it appears.
  - **Recommended:** the operator runs Task 1's preflight, then `psql -f migrations/002_sections_content.sql`, then `./deploy.sh` — the repo has no migration runner [confidence: medium] [anchor: adjacent: deploy.sh:1-4]
- [ ] A legacy name-only task for a name shared by several sections: write one generation to all of them, or only the first? Redirect: first-only changes `findSectionsByName` to return a single row.
  - **Stakes:** user — first-only would leave the other same-named sections empty for legacy tasks.
  - **Recommended:** write to all matches, exactly today's behavior for old tasks [confidence: high] [anchor: src/db.ts:16]
- [ ] Should an unrecognized payload return 200 (dropped and counted) or 4xx (retried)? Redirect: 4xx spends up to 5 attempts on a payload that cannot succeed.
  - **Stakes:** system — retrying a malformed task wastes attempts and hides it in retry noise.
  - **Recommended:** 200 plus the `invalid_input` failure count plus a log line — the worker already returns 200 to stop retries for a missing report [confidence: high] [anchor: src/worker.ts:8]
- [x] The migration file name is `002_sections_content.sql` (with `.down.sql`) — resolved without asking
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision A — expand/contract or rename in place?** These are mutually exclusive. Both involve 0 user interruptions per run. A2 adds one extra operator release later.

- **A1, in place:**
  - The operator runs `ALTER ... RENAME COLUMN`.
  - From then until `./deploy.sh` finishes, every `GET /reports/:id` and every worker write fails on the missing `body`.
  - Rolling back afterwards requires a reverse rename under pressure.
  - It is one release.
- **A2, expand/contract:**
  - The operator runs `002`, which adds and backfills the new column, then deploys.
  - Both revisions read and write successfully throughout.
  - A rollback is a traffic shift.
  - A second, small release later drops `body`.

**Decision B — what does the v2 payload carry?** These are mutually exclusive.

- **B1, id only:**
  - A new-shape task reaching a rolled-back worker spends a model call and saves nothing.
  - Any old in-flight task needs the legacy branch anyway.
- **B2, id plus transition name:**
  - Both worker versions process every task.
  - The name is removed in the contract step.

A and B are complementary: A2 and B2 are the same expand/contract move, applied to storage and to the payload.

Ranked combinations:

1. A2+B2 — fully rollback-safe.
2. A2+B1 — storage is safe, a payload rollback is not.
3. A1+B2 — an outage window, but the payload is safe.
4. A1+B1 — both break.

Verdict: **A2+B2** — the only combination where the previous revision keeps working through migration, rollout and rollback. The cost is one extra small release, and the brief ranks product quality and cost above shipping in one step. [confidence: medium] [anchor: weighing: reversibility — src/worker.ts:6 reads only `section`, and deploy.sh:4 has no staged rollout]

## Alternatives considered

- **Keep `body` and `content` in sync with a Postgres trigger** — rejected: the only writer of section text is one function ([anchor: src/db.ts:15-16]), so one explicit dual-write is visible in review, while a two-way sync trigger adds a hidden write path that the contract step must also remove.
- **Add `content` as a `GENERATED ALWAYS AS (body) STORED` column** — rejected: Postgres generated columns cannot be written, so the new code could not write `content`, and the contract step would need a column redefinition instead of a plain drop.

## Recommendation

**Reconsider scope** — build it, but as the expand half of expand/contract. Ship the column and the id-keyed payload alongside the old shapes, and defer dropping `body` and the name field to the contract follow-up (Open Questions: expand/contract, transition name; Q1). The db.ts verdict is `simplify`: the name-keyed write is replaced. [confidence: medium] [anchor: weighing: reversibility — src/db.ts:12 and src/worker.ts:6 are the running revision's only read/write paths for the renamed column and payload]

**Redundancy:** none found — no existing migration, payload version or id-keyed write path covers this.

## Plan risks

The weakest assumption is that `002` is applied before the new revision takes traffic. Nothing in `deploy.sh` enforces that order, so an operator who deploys first gets section reads failing on the missing `content` column until the migration runs.

## Cut list

- nothing — plan is minimal: each task is either the requested change, the compatibility needed to deploy it without breaking in-flight tasks or a rollback, a small bug sitting on a line this change already touches (encoding, model error handling, timeouts), or a contract-required safety item (backups preflight, first metrics).

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Authenticate the generate-section worker route | High | Medium | needs its own design/decision session: the open decision is whether to split the worker into its own `--no-allow-unauthenticated` Cloud Run service or verify the Cloud Tasks OIDC token inside the handler — today anyone can trigger paid model calls | same endpoint this plan edits, but authentication is an orthogonal security change | No |
| Contract step: drop `sections.body`, the transition `section` field and the legacy payload branch | Medium | Small | needs its own design/decision session: the open decision is when dropping is safe — after the expand release is confirmed live, the rollback window is closed, and the legacy-payload counter has read zero for longer than the queue's task retention; it cannot share a release with the expand step | the second half of this exact request; finishes the rename the user asked for | No |

- [x] Authenticate the generate-section worker route — require the Cloud Tasks OIDC identity so only the queue can trigger paid section generation.
  - **UX:** none
  - **Problem:** the worker route is served by the public service deployed with `--allow-unauthenticated`, so any caller can POST a task body and trigger a paid model call that skips the queue's attempt and concurrency caps (priority 2, cost) [anchor: deploy.sh:4]
  - **Stability/efficiency:** none
  - **Value rank:** 5 — security exposure: an unauthenticated public route runs paid work [anchor: src/app.ts:9]
  - **Complexity:** Medium — deploy.sh (service split or OIDC config), the queue task's `oidcToken`, the worker or app routing
  - **Risk:** Medium — a misconfigured audience stops all generation; needs its own review
  - **If never done:** anyone who learns the URL can run up model-API spend and write arbitrary generations into sections
  - **Verdict:** clears bar — a live paid-work exposure outweighs Medium complexity and risk
- [x] Contract step: drop `sections.body`, the transition `section` field and the legacy payload branch — once the queue has drained of name-only tasks.
  - **UX:** none
  - **Problem:** until it ships, every section write goes to two columns and the worker keeps a second payload path, so the rename the user asked for is only half done [anchor: user: "rename the `body` column on `sections` to `content`"]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — a latent maintenance cost and an unfinished request, not a live failure [anchor: user: "rename the `body` column on `sections` to `content`"]
  - **Complexity:** Small — one migration (`003` drops `body`, with a pre-drop backup), db.ts, worker.ts, queue.ts, the legacy counter
  - **Risk:** Medium — a destructive column drop; it must follow the drain signal and an on-demand backup
  - **If never done:** the old column and the dual-write stay forever, and the requested rename never finishes
  - **Verdict:** clears bar — it is the remaining half of the user's own request, and its risk is bounded by the drain signal this plan adds

# Task breakdown

### Task 1: Backups preflight and expand migration 002

- **Skill:** `flow-system-design`
- **Description:** Add a preflight script that verifies Cloud SQL automated backups and point-in-time recovery are on, enables them with `--enable`, takes an on-demand backup, and confirms it is `SUCCESSFUL`. With `--restore-check`, it restores that backup into a scratch instance and compares the `sections` row count against the source (the restore check). Add expand migration `002`, which adds `content` and backfills it from `body`, plus its down migration. Put a header comment in `002` stating that it must be applied before the new revision is deployed. This task carries the rollback step: the down file, plus the traffic-shift command in its header comment.
- **Inputs:** `migrations/001_reports.sql`; a `CLOUD_SQL_INSTANCE` env var, parameterized and never hardcoded
- **Outputs:** the migration up and down files, and the preflight script
- **Contract:**
  - **Files:** create `migrations/002_sections_content.sql`; create `migrations/002_sections_content.down.sql`; create `scripts/db-preflight.sh`
  - **Interfaces:** `002` up: `set statement_timeout = '5min'; alter table sections add column if not exists content text; update sections set content = body where content is null and body is not null;`. `002` down: `alter table sections drop column if exists content;`. `scripts/db-preflight.sh [--enable]`: runs under `set -euo pipefail` and requires `${CLOUD_SQL_INSTANCE:?}`. It reads `gcloud sql instances describe "$CLOUD_SQL_INSTANCE" --format='value(settings.backupConfiguration.enabled,settings.backupConfiguration.pointInTimeRecoveryEnabled)'`. If either value is false, it either runs `gcloud sql instances patch "$CLOUD_SQL_INSTANCE" --backup-start-time=03:00 --enable-point-in-time-recovery` (with `--enable`) or exits 1 and prints that command. It then runs `gcloud sql backups create --instance="$CLOUD_SQL_INSTANCE" --description="pre-002_sections_content"` and exits non-zero unless the newest backup's status is `SUCCESSFUL`. `--restore-check` requires `${CLOUD_SQL_SCRATCH_INSTANCE:?}`, `${DATABASE_URL:?}` and `${SCRATCH_DATABASE_URL:?}`. It runs `gcloud sql backups restore <backup-id> --restore-instance="$CLOUD_SQL_SCRATCH_INSTANCE" --backup-instance="$CLOUD_SQL_INSTANCE"`, then exits non-zero unless `psql -tA -c 'select count(*) from sections'` returns the same count on `DATABASE_URL` and on `SCRATCH_DATABASE_URL`.
  - **Call-site edits:** none (first task)
- **Acceptance criteria:** `bash -n scripts/db-preflight.sh && grep -q 'pointInTimeRecoveryEnabled' scripts/db-preflight.sh && grep -q 'backups restore' scripts/db-preflight.sh && grep -q 'add column if not exists content' migrations/002_sections_content.sql && grep -q 'drop column if exists content' migrations/002_sections_content.down.sql`

### Task 2: Id-keyed persistence with dual-write

- **Skill:** `flow-new-feature`
- **Description:** Add an id-keyed section read, a name-based lookup for legacy tasks, and an id-keyed write that sets both `content` and `body`. Switch the section list to read `coalesce(content, body)` and keep the API field name `body`. `saveSection` stays for now; Task 3 removes it once the worker stops calling it, so the repo stays green.
- **Inputs:** Task 1's `content` column
- **Outputs:** new persistence functions in `src/db.ts`
- **Contract:**
  - **Files:** edit `src/db.ts`
  - **Interfaces:** `export type Section = { id: string; report_id: string; name: string }`; `export async function getSection(id: string): Promise<Section | undefined>` (`select id, report_id, name from sections where id = ${id}`); `export async function findSectionsByName(reportId: string, name: string): Promise<Section[]>` (ordered by `position`); `export async function saveSectionContent(sectionId: string, content: string): Promise<void>` (`update sections set content = ${content}, body = ${content} where id = ${sectionId}` — dual-write until the contract step); `listSections` becomes `select id, name, coalesce(content, body) as body from sections where report_id = ${reportId} order by position`
  - **Call-site edits:** none (`src/app.ts` `handle` keeps consuming `listSections` unchanged)
- **Acceptance criteria:** `grep -q 'export async function saveSectionContent' src/db.ts && grep -q 'coalesce(content, body) as body' src/db.ts && bun test`

### Task 3: v2 task payload and a worker that accepts both shapes

- **Skill:** `flow-new-feature`
- **Bundled:** UTF-8-safe base64 for the task body (today's `btoa` throws on non-Latin-1 section names, src/queue.ts:11)
- **Description:** The producer emits `{ version: 2, reportId, sectionId, section }`, where `section` is the name and is kept only for the transition. The worker parses both shapes, preferring `sectionId` when present:
  - **v2 task:** look up the section by id. Return 200 "gone" with no model call when it is missing or its `report_id` differs from `reportId`. Otherwise load the report, generate, and `saveSectionContent` by id.
  - **Legacy `{ reportId, section }` task:** `findSectionsByName`, generate once, and save the result to each match.
  - **Neither shape:** return 200 "invalid" with no model call, and log it.
  - Remove the now-unused `saveSection` from `src/db.ts`.
- **Inputs:** Task 2's `getSection`, `findSectionsByName` and `saveSectionContent`
- **Outputs:** the v2 producer and the dual-shape consumer
- **Contract:**
  - **Files:** edit `src/queue.ts`; edit `src/worker.ts`; edit `src/db.ts` (remove `saveSection`)
  - **Interfaces:** `export async function enqueueSection(reportId: string, section: { id: string; name: string }): Promise<void>` (body `Buffer.from(JSON.stringify({ version: 2, reportId, sectionId: section.id, section: section.name })).toString("base64")`); `export type GenerateSectionTask = { version: 2; reportId: string; sectionId: string; section?: string }`; `export type ParsedGenerateSectionTask = { kind: "id"; reportId: string; sectionId: string } | { kind: "legacy"; reportId: string; sectionName: string }`; `export function parseGenerateSectionTask(raw: unknown): ParsedGenerateSectionTask | null`; `handleGenerateSection(req: Request): Promise<Response>` (signature unchanged)
  - **Call-site edits:** `src/worker.ts` `handleGenerateSection` replaces `saveSection(reportId, section, body)` with `saveSectionContent(section.id, content)`; update the header comment at `src/worker.ts:4` to the v2 shape; `src/app.ts` routing unchanged
- **Acceptance criteria:** `grep -q 'version: 2' src/queue.ts && ! grep -q 'export async function saveSection(' src/db.ts && grep -q 'parseGenerateSectionTask' src/worker.ts && bun test` (idempotency key: section id — a redelivered v2 task overwrites the same single row; timeout: model call 120 s, set in Task 6)

### Task 4: Worker and producer tests

- **Skill:** `flow-testing`
- **Description:** Unit tests with `mock.module("./db")` and `mock.module("./llm")` for the worker, and a stubbed `globalThis.fetch` for the producer. Cases:
  1. A v2 task saves by id only, including when two sections share a name.
  2. A v2 task with an unknown or cross-report `sectionId` returns 200 with zero model calls.
  3. A legacy name task saves to every same-named section.
  4. An invalid payload returns 200 with zero model calls.
  5. The `saveSectionContent` SQL sets both columns. Assert this via a mocked `sql` tag or the call args.
  6. The producer body decodes to `{ version: 2, reportId, sectionId, section }` and handles a non-Latin-1 name such as `Überblick`.
- **Inputs:** Task 3's `parseGenerateSectionTask`, `handleGenerateSection` and `enqueueSection`
- **Outputs:** test files
- **Contract:**
  - **Files:** create `src/worker.test.ts`; create `src/queue.test.ts`
  - **Interfaces:** none new; the tests target the Task 2 and Task 3 exports
  - **Call-site edits:** none
- **Acceptance criteria:** `bun test src/worker.test.ts src/queue.test.ts` — all six cases pass (idempotency key under test: section id; the duplicate-name case is the regression check)

### Task 5: Metrics helper, `.flow/metrics.md`, and worker instrumentation

- **Skill:** `flow-metrics`
- **Description:** Create the repo-local, zero-dependency metrics helper with an in-memory recorder behind a swappable `Recorder`, and a closed `ErrorType` union mirroring `.flow/metrics.md`. Wrap `handleGenerateSection` so it emits:
  - `reports.section.generate.duration`: histogram in seconds by `operation.outcome`, boundaries `[1, 5, 10, 20, 30, 45, 60, 90, 120]`.
  - `reports.section.generate.failures`: counter by `error.type` — `not_found` for a gone section or report, `invalid_input` for an invalid payload, `upstream_error` for a `ModelApiError`, `upstream_timeout` for a `TimeoutError`/`AbortError`, `internal` otherwise, and `_OTHER` as the fallback.
  - `reports.section.generate.legacy_payloads`: counter, on each name-only task.
  
  Create `.flow/metrics.md` with these sections: `## Backend` (`none yet — suggested: Google Cloud Monitoring`), `## Namespace` (`reports`), `## Attributes`, `## error.type values`, `## Helper` (`src/metrics.ts`), `## Dashboard panels`, `## Dashboards`, `## Alerts` (burn-rate tiers), `## As-code` (`spec-only`), `## SLOs` ("a queued report section gets generated", 99%/30 d), and `## Coverage` (generate-section worker).
- **Inputs:** Task 3's `handleGenerateSection`; new: `src/metrics.ts`
- **Outputs:** the helper, the metrics contract file, an instrumented worker, and emission tests
- **Contract:**
  - **Files:** create `src/metrics.ts`; create `.flow/metrics.md`; edit `src/worker.ts`; create `src/metrics.test.ts`
  - **Interfaces:** `export type ErrorType = "_OTHER" | "internal" | "invalid_input" | "not_found" | "upstream_error" | "upstream_timeout"`; `export type Attributes = { "operation.outcome"?: "ok" | "error"; "error.type"?: ErrorType; "messaging.destination.name"?: "sections" }`; `export interface Recorder { histogram(name: string, value: number, attrs: Attributes): void; counter(name: string, inc: number, attrs: Attributes): void }`; `export function setRecorder(r: Recorder): void`; `export function memoryRecorder(): Recorder & { observations: Array<{ name: string; value: number; attrs: Attributes }> }`; `export async function instrument<T>(op: string, fn: () => Promise<T>, classify: (e: unknown) => ErrorType): Promise<T>`; `export function recordFailure(op: string, errorType: ErrorType): void`; `export function increment(name: string): void`
  - **Call-site edits:** `src/worker.ts` `handleGenerateSection` — wrap the body in `instrument("reports.section.generate", …)`; call `recordFailure` on the 200 "gone" and "invalid" paths; call `increment("reports.section.generate.legacy_payloads")` on the legacy branch
- **Acceptance criteria:** `bun test src/metrics.test.ts` — against `memoryRecorder()`:
  - a success records one `operation.outcome=ok` duration and no failure
  - each of `not_found`, `invalid_input`, `upstream_error` and `upstream_timeout` records one `operation.outcome=error` observation plus exactly one failure with that `error.type`
  - a legacy task increments `legacy_payloads` once
  - an unclassified error maps to `_OTHER`

### Task 6: Queue limits, task deadline and model-call timeouts

- **Skill:** `flow-system-design`
- **Bundled:** model-API error responses are saved as empty section text (src/llm.ts:10), and the queue runs with default retries and deadline with no timeout on the model call — deadlines must shrink inward for the attempt cap to bound spend
- **Description:** In `deploy.sh`, after the existing `create`, add `gcloud tasks queues update sections --location us-central1 --max-attempts=5 --min-backoff=10s --max-backoff=300s --max-concurrent-dispatches=5`. In `enqueueSection`, set `dispatchDeadline: "180s"` on the task and add `signal: AbortSignal.timeout(5_000)` to the enqueue fetch. In `src/llm.ts`:
  - `generateSection` gets `signal: AbortSignal.timeout(120_000)`.
  - `suggestTitle` gets `signal: AbortSignal.timeout(10_000)`.
  - Both throw `ModelApiError` on a non-2xx response, which the worker maps to a 5xx so the queue retries.
- **Inputs:** Task 3's `src/queue.ts`; Task 5's `upstream_error`/`upstream_timeout` classification
- **Outputs:** a bounded retry, deadline and spend envelope for the worker
- **Contract:** _(config/infra and code)_
  - **Files:** edit `deploy.sh`; edit `src/queue.ts`; edit `src/llm.ts`
  - **Interfaces:** `deploy.sh` — the queue `sections` goes from defaults to `max-attempts 5`, `min-backoff 10s`, `max-backoff 300s`, `max-concurrent-dispatches 5`; the task `dispatchDeadline` goes from unset (Cloud Tasks default) to `"180s"`; `export class ModelApiError extends Error { constructor(readonly status: number) }`
  - **Call-site edits:** `src/worker.ts` needs no edit — thrown `ModelApiError`/`TimeoutError` already propagate to a 5xx and are classified by Task 5's `instrument`
- **Acceptance criteria:** `grep -q -- '--max-attempts=5' deploy.sh && grep -q 'dispatchDeadline: "180s"' src/queue.ts && [ "$(grep -c 'AbortSignal.timeout' src/llm.ts)" = 2 ] && grep -q 'class ModelApiError' src/llm.ts && bun test`

| Task | Depends on |
| ---- | ---------- |
| 1    | —          |
| 2    | 1          |
| 3    | 2          |
| 4    | 3          |
| 5    | 3          |
| 6    | 3, 5       |

### Skills Summary

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-system-design | Yes (Tasks 1, 6) | Expand/contract migration, backups/PITR, queue must-set settings and deadlines |
| flow-new-feature | Yes (Tasks 2, 3) | Persistence and the worker/producer payload change |
| flow-testing | Yes (Task 4) | Worker and producer unit coverage with `bun:test` mocks |
| flow-metrics | Yes (Task 5) | First instrumented change: helper, `.flow/metrics.md`, emission tests |
| flow-refactoring | No | Behavior changes (payload, write targeting); this is not a behavior-preserving refactor |
| flow-verify | No (implicit) | Runs as the pipeline's verify phase, not as a task |

# PR description draft

## TLDR

Each queued generation now writes only the section it was queued for (before, same-named sections in a report were all overwritten), and section text moves to a `content` column without breaking queued tasks or rollback.

## User-facing changes

- Sections that share a name within one report now each get their own generated text:
  - **Before:** each same-named section's generation job overwrote all of them with the same text.
  - **After:** each job writes only the one section it was queued for.
- A model-API failure during generation no longer saves empty section text:
  - **Before:** an error response from the model API was saved as an empty section, and the job counted as done.
  - **After:** the job fails and the queue retries it, up to 5 attempts.

## System changes

- Section text is now stored in a new `content` field, and the old `body` field is still written for one release so the previous version stays safe to roll back to:
  - **Before:** section text lived only in `body`.
  - **After:** new writes go to both fields and reads prefer `content`. The report API still returns the text under `body`.
- The section-generation task now names its section by id, and the worker still accepts tasks queued in the old shape:
  - **Before:** the task carried the report id and the section's name.
  - **After:** the task carries a version marker, the report id, the section id, and the name. The name is kept only so a rolled-back worker can still process new tasks.
- Paid model spend per stuck task is now bounded:
  - **Before:** the queue used its default retry budget and task deadline, and the model call had no timeout.
  - **After:** at most 5 attempts with 10 s → 300 s backoff, at most 5 generations running at once, a 180 s task deadline, and a 120 s model-call timeout. This lowers worst-case spend for a task that keeps failing and does not change spend on the happy path.

## Why

Generated report sections are matched to their database rows by name, and names are not unique within a report. So a report with repeated section names shows the same text in each of them, and the model API is paid for generations that end up in the wrong place. The owner also wants the stored field renamed to `content`. Both changes touch the data the running version reads and the task shape already sitting in the queue.

## Key decisions

- **Two releases (expand/contract) instead of an in-place rename:** an in-place column rename would break every read between the migration and the deploy, and would make rollback impossible. This PR adds `content` beside `body`. Dropping `body` waits for a follow-up once the queue has drained of old-shape tasks.
- **The section name stays in the task for the transition:** a rolled-back worker reads only the name, so an id-only task would spend a paid call and save nothing.
- **The report API field stays `body`:** the request named the database column, not the public response. Renaming it would silently break any client.
- **Malformed or orphaned tasks are dropped and counted, not retried:** retrying a task that cannot succeed only spends attempts.
- **Order of operations:** run the backups preflight, then apply migration 002, then deploy. Rollback is a Cloud Run traffic shift to the previous revision, plus the 002 down migration if needed.
- Bundled: UTF-8-safe encoding of the task body, because section names with non-Latin-1 characters made task creation throw.
- Bundled: model-API error handling and timeouts, plus queue attempt, concurrency and deadline limits, so the retry cap bounds spend.
- Out of scope: worker authentication and dropping `body`. Both are tracked as follow-up issues.

## Instrumentation

These are the first metrics for this service. They cover the section-generation worker:

- generation duration by outcome
- failures by type: invalid task, missing section, model error, model timeout, internal
- a count of old-shape tasks received, which signals when the follow-up that drops `body` is safe

The Cloud Tasks queue depth is read from the platform. The planned dashboard is "reports-service overview": outcomes, failures by type, p50/p95/p99 latency, old-shape tasks, and queue depth. A new SLO, "a queued report section gets generated", targets 99% over 30 days with burn-rate alerts. The dashboard is spec-only for now. These metrics are recorded but will not show on any graph until a metrics backend is chosen; Google Cloud Monitoring is suggested, and the status is tracked in `.flow/metrics.md`.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/worker.test.ts` — the duplicate-name regression passes: a by-id task updates only its own section when two sections share a name (this fails on the pre-change name-keyed write).
- [ ] Run `bun test src/queue.test.ts` — the task body decodes to version 2 with the section id and name, including a non-Latin-1 name.
- [ ] Run `bun test src/metrics.test.ts` — one outcome observation per run and one failure per error type are recorded.
- [ ] Run `docker run -d --rm --name rs-pg -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16 && sleep 3` — a scratch Postgres starts.
- [ ] Run `psql postgres://postgres:pg@localhost:55432/postgres -v ON_ERROR_STOP=1 -tA -f migrations/001_reports.sql -c "insert into reports (id, company) values ('r1','Acme'); insert into sections (id, report_id, name, position, body) values ('s1','r1','Intro',1,'hello')" -f migrations/002_sections_content.sql -c "select content from sections where id='s1'" | grep -qx hello` — the backfill copies the existing text.
- [ ] Run `psql postgres://postgres:pg@localhost:55432/postgres -v ON_ERROR_STOP=1 -f migrations/002_sections_content.down.sql -f migrations/002_sections_content.sql` — the down then up migration exits 0.
- [ ] Run `bash -n scripts/db-preflight.sh` — the backups preflight script parses.
