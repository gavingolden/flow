# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Rename section text to `content` and key generation tasks by section id

**Goal:** Section text is stored as `content` and each generation task names its exact section, with no failed report reads or wasted paid generations during the rollout.

## Problem Statement

The reports service writes each report as a set of sections, and a background worker asks a paid language model to write each section, one queued task per section. Today the worker finds the section to fill in by its name, which is not guaranteed unique within a report, and the stored text sits under a column name the owner wants changed. Making both changes the obvious way, in one release, would briefly break report reads and make the queue retry paid model calls that cannot be saved, because the database change and the new code cannot land at the same instant. The cost is user-visible errors on report pages during the deploy and paid generations thrown away.

| Fact | Evidence |
| --- | --- |
| Section text column is `body` | [anchor: migrations/001_reports.sql:13] |
| The task payload carries the section name, not its id | [anchor: src/queue.ts:11], [anchor: src/worker.ts:6] |
| The save targets every row with that name in the report; there is no uniqueness on (report, name) | [anchor: src/db.ts:16], [anchor: migrations/001_reports.sql:8-14] |
| The worker pays for the model call before it saves, so a failed save is a paid call the queue retries | [anchor: src/worker.ts:9-10], [anchor: src/llm.ts:1] |
| The deploy applies no migrations; there is no migration runner at all | [anchor: deploy.sh:1-4] |
| The report API exposes the column name directly as the JSON key `body` | [anchor: src/db.ts:12], [anchor: src/app.ts:14] |
| No code in this repo calls the task producer | `grep -rn enqueueSection src` → only the definition at src/queue.ts:4 |

Priorities at stake (product brief): **Product quality** (report reads keep working through the deploy), **Cost** (no paid generation is spent on a save that fails or on a section that no longer exists), **Architecture** (the task names exactly one section).

## Request vetting

- **Hypothesis:** The column rename and the switch to a section-id task can ship without breaking report reads or wasting paid generations, provided no release ever depends on the migration and the new code landing at the same instant.
- **Case against:** Done literally — one migration that renames the column plus code that reads the new name — there is no safe order: the deploy applies no migrations and Cloud Run keeps the old revision serving until the new one is ready [anchor: deploy.sh], so either the old code queries a column that no longer exists or the new code queries one that does not exist yet. Because the worker pays for the model call before it saves [anchor: src/worker.ts], every failed save is a paid call that the queue then retries. An id-only payload that reaches the old worker after a rollback makes a paid call for an "undefined" section and saves nothing [anchor: src/worker.ts].
- **Sources:** https://martinfowler.com/bliki/ParallelChange.html ; https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration
- **Verdict:** adopt-with-conditions: ship as expand/contract — this PR adds `content` beside `body` (both written, read with fallback) and sends a versioned task carrying id plus name; dropping `body` and the name field ships as a ticked follow-up once the queue holds no pre-deploy task.

## Existing-code assessment

- **migrations/ (schema):** keep — add `002` beside `001`; the numbered-file convention fits [anchor: migrations/001_reports.sql]
- **src/db.ts:** simplify — `saveSection` targets rows by (report, name), which can overwrite several rows; replace it with a by-id save and keep the by-name save only as the legacy path [anchor: src/db.ts:15-17]
- **src/worker.ts:** simplify — reorder so the section is looked up before the paid model call, so a missing section costs nothing [anchor: src/worker.ts:6-10]
- **src/queue.ts:** keep — change the payload shape only [anchor: src/queue.ts:4-15]
- **src/app.ts:** keep — no edit; the read query keeps returning the `body` key [anchor: src/app.ts:14]
- **deploy.sh / AGENTS.md (operations):** keep — deploy is untouched; the migrate-before-deploy order is documented in AGENTS.md and enforced by a new migration helper [anchor: deploy.sh:4]

## Scope Boundary

**In scope:**

- Expand migration: add `sections.content`, backfill from `body`; a matching down migration.
- A small migration helper that refuses to run unless Cloud SQL backups and point-in-time recovery are on, takes an on-demand backup, then applies one SQL file.
- Persistence: write both columns, read `content` falling back to `body`, add by-id lookup and save.
- Task payload `version: 2` carrying `sectionId` (and, during the transition, `section` name); worker accepts v2 and the legacy name-only shape.
- Unit tests for the worker and producer.

**Out of scope:**

- Dropping `body` and the payload's name field (the contract step) — a ticked follow-up; it must deploy after this release has fully replaced the old revision.
- Renaming the report API's JSON key `body` (see Open Questions).
- Worker authentication, model-call timeout, queue retry ceilings — ticked follow-ups.

## Behavioral contrast

### User flow

| Before | After |
| --- | --- |
| API client reads `sections[].body` from the report endpoint | Unchanged — still `sections[].body` |
| Operator ships a release with `./deploy.sh` | Operator runs `scripts/migrate.sh migrations/002_sections_content.sql`, then `./deploy.sh` |

### System flow

- **Before:**
  - Task payload is `{ reportId, section: <name> }`.
  - Worker loads the report, calls the paid model, then updates every section row in that report with that name.
  - Section text lives only in `body`.
- **After:**
  - Task payload is `{ version: 2, reportId, sectionId, section: <name> }`; legacy `{ reportId, section }` is still accepted.
  - Worker loads the section row by id first; a missing section or report is acknowledged with no paid call; otherwise it calls the model and writes exactly that row.
  - Section text is written to both `content` and `body`; reads prefer `content`.

**Lost:** until the contract follow-up ships, each section's text is stored twice (`body` and `content`) and every task carries the name redundantly; the request's literal "instead of the section name" is deferred to that follow-up.

## User Stories / Acceptance Criteria

### Story 1: Report reads survive the rollout

- [ ] Given migration 002 is applied to a database whose sections have `body` text, when it completes, then every row's `content` equals its `body` (checked by the local-Postgres Test Step).
- [ ] Given migration 002 is applied, when the previous revision still serves reads and writes, then it keeps working because `body` still exists and is still written (checked by the `saveSectionContent` writes-both-columns assertion in `src/worker.test.ts`).
- [ ] Given a section with `content` null and `body` set, when the report is read, then the section's `body` key shows the `body` text (the `coalesce(content, body)` query; grep check in Task 3).

### Story 2: Generation tasks name exactly one section

- [ ] Given a v2 task with a `sectionId`, when the worker runs, then it saves the model output to that section id only (`bun test src/worker.test.ts`).
- [ ] Given a v2 task whose section id does not exist, when the worker runs, then it responds 200 and makes no model call (`bun test src/worker.test.ts`).
- [ ] Given a legacy `{ reportId, section }` task, when the worker runs, then it saves by report and name as today (`bun test src/worker.test.ts`).
- [ ] Given the producer is called, when it enqueues, then the decoded task body is `{ version: 2, reportId, sectionId, section }` (`bun test src/queue.test.ts`).

### Story 3: The migration cannot run without a recovery point

- [ ] Given `CLOUD_SQL_INSTANCE` is unset, when the helper runs, then it exits non-zero before touching the database (`! env -u CLOUD_SQL_INSTANCE bash scripts/migrate.sh migrations/002_sections_content.sql`).

## Instrumentation

none — behaviour-preserving for the queue consumer and the read handler: each task still does one model call and one row write and the report response is byte-identical; only the identifier the worker keys on changes. The drain check for the follow-up uses the platform's own task list (`gcloud tasks list --queue sections`), not a new metric.

## Architecture Decisions

| Aspect | Decision |
| --- | --- |
| Layers touched | DB schema, persistence, queue producer, queue consumer, ops helper |
| Domain modules | `migrations/`, `src/db.ts`, `src/worker.ts`, `src/queue.ts`; new `scripts/migrate.sh` |
| Data flow | Producer enqueues v2 task → worker reads section row by id → report row → model → writes `content` and `body` on that row → report endpoint reads `coalesce(content, body)` as `body` |
| Pattern | Expand/contract (parallel change) for the column; versioned, additive task payload; both new to this repo, justified by the deploy having no migration step (deploy.sh:4) |
| Binary-framing check | The request implies one step. Options: A single-step rename with a coordinated cutover; B expand/contract (chosen); middle — B with the contract step as a filed follow-up rather than a second task in this PR, because it can only deploy after this one has fully rolled out |
| Goal anchor | Every decision is checked against "no failed report reads or wasted paid generations during the rollout"; the literal "instead of the section name" conflicts with rollback safety, surfaced in Open Questions |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --- | --- | --- | --- | --- | --- | --- |
| Generate-section task consumer | ~60 s (model call 20-60 s) | existing Cloud Tasks queue, worker invoked synchronously under the attempt deadline | queue default dispatch deadline (10 min), unchanged | queue retry config only, unchanged | section id (was: report + name) — re-delivery overwrites the same single row | none today — one paid call per delivery; now skipped when the section or report is missing |
| Section enqueue (producer) | inline — ~0.3 s, timeout none explicit (unchanged) | inline | none explicit, unchanged | none | n/a | n/a |
| Report read | inline — ~0.1 s, timeout none explicit (unchanged) | inline | platform request timeout, unchanged | none | n/a | n/a |
| Migration 002 backfill | seconds (one `update` over `sections`) | one-off operator run via the migration helper | psql session | rerun is safe (idempotent statements) | n/a | n/a |

**Platform:** gcp

**Proportionality:** no feature flag, canary or payload-version dispatch framework — one service, rollback is a traffic shift; no new metrics; no change to queue retry settings or model-call timeout (both filed as follow-ups, not needed for the rename); no full restore drill (an on-demand backup plus point-in-time recovery is the recovery point for a one-statement additive migration).

**Recovery:** `sections` holds paid generations, regenerable at one paid model call per section. Task 2's helper refuses to migrate unless Cloud SQL automated backups and point-in-time recovery are enabled on `${CLOUD_SQL_INSTANCE:?}` (printing the enable command when they are not), then takes an on-demand backup, checks it reports `SUCCESSFUL`, and prints the restore-to-scratch command as the restore check before applying the SQL.

**Rollback:** Task 1

## Technical Constraints

- The deploy runs no migrations and switches traffic only when the new revision is ready, so the old and new revisions overlap against one schema — every release must work against both the pre- and post-migration schema [anchor: deploy.sh:4].
- Any non-2xx from the worker makes Cloud Tasks retry, and the model call precedes the save — permanent failures (missing section/report, malformed task) must be acknowledged with 200, matching the existing missing-report path [anchor: src/worker.ts:8].
- The report response spreads the query's column names into JSON, so the read query must alias back to `body` to keep the API stable [anchor: src/app.ts:14].
- No new runtime dependencies (AGENTS.md); tests use Bun's built-in `bun:test` mocks.
- Cost: removes the paid model call for tasks whose section no longer exists; otherwise unchanged.

## Open Questions

- [ ] Should the report API's JSON key stay `body` or become `content`? Redirect changes Task 3's read query and makes this a breaking API change.
  - **Stakes:** user — Product quality: if wrong, every API client reading section text breaks, or the API keeps the old name the owner wanted gone.
  - **Recommended:** keep `body` in the API (query aliases `content` back to `body`) — the request names the column only, and the column name leaks straight into the response [confidence: medium] [anchor: weighing: risk — renaming the JSON key breaks every client and was not asked for]
- [ ] Ship as expand/contract (two releases) instead of one rename? Redirect to single-step would collapse Tasks 1, 3 and 4 into an in-place rename plus an operator cutover runbook.
  - **Stakes:** both — Product quality (failed report reads during deploy) and Cost (paid calls retried on failed saves).
  - **Recommended:** expand/contract — the only order-independent option given the deploy has no migration step; rollback stays a plain traffic shift [confidence: medium] [anchor: weighing: reversibility — every intermediate state is readable by both the previous and the next revision]
- [ ] Carry both `sectionId` and the name during the transition, instead of the id alone? Redirect to id-only removes the `section` field from the v2 payload in Task 4.
  - **Stakes:** system — Cost: on rollback, an id-only task delivered to the old worker spends a paid call on an "undefined" section and saves nothing.
  - **Recommended:** carry both, drop the name in the contract follow-up [confidence: medium] [anchor: weighing: reversibility — the old worker reads only `section`, so it can still process tasks the new producer enqueued]
- [ ] Who produces generate-section tasks in production? No code in this repo calls the producer. Redirect (an out-of-repo producer exists) adds updating that producer to the contract follow-up before the name path is removed.
  - **Stakes:** system — Product quality: removing the legacy path while an outside producer still sends names would make those sections silently never generate.
  - **Recommended:** keep the worker's legacy name path in this release regardless, and make "no legacy-shaped task in the queue" the gate for the follow-up [confidence: medium] [anchor: weighing: risk — the legacy path costs a few lines and covers both answers]
- [ ] Should the migration helper enable backups/point-in-time recovery itself when they are off? Redirect makes Task 2 patch the instance instead of refusing.
  - **Stakes:** system — Architecture: an automatic patch is an unreviewed production config change; refusing costs the operator one command.
  - **Recommended:** refuse and print the exact enable command; the operator enables, re-runs, and the helper proceeds [confidence: medium] [anchor: weighing: risk — a migration helper silently patching a production instance is a config change no reviewer saw]
- [x] Keep `reportId` in the task payload — yes; the old worker needs it on rollback and the worker uses the section row's own report id.
  - **Stakes:** none — resolved without asking

## Decision analysis

**Decision A — one-step rename with a coordinated cutover, or expand/contract?** Mutually exclusive.

| | A: single-step rename + cutover runbook | B: expand/contract (two releases) |
| --- | --- | --- |
| Operator flow | Pause the queue → deploy with no traffic → rename column → shift traffic → resume queue (4 ordered manual steps, 1 interruption per run that must not be interleaved) | Run the migration helper → `./deploy.sh` (2 steps; wrong order fails loudly before any traffic moves) ; later, the follow-up repeats this once |
| API client flow | Report reads fail from the rename until traffic shifts (seconds to minutes, depending on how fast the operator is) | No failed reads at any point |
| Worker / cost | Paused queue avoids wasted calls if the runbook is followed; if not, each failed save is a paid call retried | No save ever targets a missing column; no wasted calls |
| Rollback | Reverse rename plus traffic shift, coordinated again | Traffic shift only; previous revision reads `body`, which is still current |
| Diff | Smaller now, no follow-up | Slightly larger now, plus one small follow-up PR |

Ranked combinations: (1) B with the contract step as a ticked follow-up; (2) B with both steps in this PR — not viable, the contract step cannot deploy until the old revision is gone and the queue has drained; (3) A.

Verdict: **B, with the contract step filed as a follow-up** — the only option where no single operator mistake causes failed reads or wasted paid calls [confidence: medium] [anchor: weighing: reversibility — every intermediate state is valid for both adjacent revisions].

## Alternatives considered

- **Rename the column and switch the code in the same release** — rejected: the deploy applies no migrations and Cloud Run keeps the old revision serving until the new one is ready (deploy.sh:4), so one side always queries a missing column, and each failed save follows a paid call (src/worker.ts:9-10).
- **Send the section id only, from this release on** — rejected: on rollback the old worker reads only `section` (src/worker.ts:6) and would make a paid call for an undefined section that saves nothing.

## Recommendation

**Reconsider scope** — build the request as the expand half of an expand/contract rename (both columns, id-plus-name payload) and file the contract half as a ticked follow-up; see the Open Questions on expand/contract and on carrying both id and name. Also simplifies the by-name save and the call-before-lookup order in the worker [confidence: medium] [anchor: weighing: reversibility — each release is readable by its neighbours].

**Redundancy:** none found

## Plan risks

The operator applies migration 002 after deploying instead of before; the new revision then fails every read and save until it is applied — mitigated by documenting the order in AGENTS.md and the helper, and by the old revision staying unaffected by an early migration, but not mechanically enforced by the deploy.

## Cut list

- nothing — plan is minimal: each piece (dual columns, dual-field payload, legacy worker path, backup guard) exists only to keep one specific deploy or rollback step safe, and the contract step is already split out.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --- | --- | --- | --- | --- | --- |
| Worker endpoint accepts unauthenticated callers | High | Medium | needs its own design/decision session: the open decision is splitting the worker into its own non-public service versus verifying the queue's identity token inside the handler | same endpoint this plan edits; orthogonal concern | No |
| Finish the rename: drop `body` and the payload name field | Medium | Small | needs its own design/decision session: the open decision is when the drain is complete — the previous revision retired and no pre-deploy task left in the queue — which can only be judged after this release is live | the contract half of this request | No |
| Bound the paid generation path (model-call timeout, queue max attempts and dispatch deadline) | Medium | Small | needs its own design/decision session: the open decision is the max-attempts ceiling, which trades lost sections against repeated paid calls | same worker; orthogonal reliability/cost concern | No |

- [x] Worker endpoint accepts unauthenticated callers — anyone can trigger paid model calls; require the queue's identity.
  - **UX:** none
  - **Problem:** the service deploys with `--allow-unauthenticated` and the worker route has no caller check, so any HTTP client can trigger a paid generation [anchor: deploy.sh:4]
  - **Stability/efficiency:** none
  - **Value rank:** 5 — security exposure: unbounded paid calls from any caller, bypassing the queue's rate caps [anchor: src/app.ts:9]
  - **Complexity:** Medium — deploy config plus either a second service or token verification in the handler
  - **Risk:** Medium — a misconfigured invoker role stops all generation
  - **If never done:** anyone who finds the URL can run up the model bill
  - **Verdict:** clears bar — a live spend exposure outweighs a medium change
- [x] Finish the rename: drop `body` and the payload name field — resync, drop `body`, and remove the name from generation tasks once drained.
  - **UX:** none
  - **Problem:** until done, section text is stored twice and every task carries a redundant name, and the user's request is only half delivered [anchor: user: "rename the `body` column on `sections` to `content`, and change the generate-section task to carry the section id instead of the section name"]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk: the two columns drift if any writer ever updates only one [anchor: src/db.ts:16]
  - **Complexity:** Small — one migration (`update sections set content = body where content is distinct from body; alter table sections drop column body;`), read/write by `content` only, worker drops the legacy path
  - **Risk:** Low — gated on `gcloud tasks list --queue sections` showing no task created before this release
  - **If never done:** the duplicate column and legacy path stay forever and the rename never completes
  - **Verdict:** clears bar — it completes the user's own request at small cost
- [x] Bound the paid generation path (model-call timeout, queue max attempts and dispatch deadline) — explicit model-call timeout plus queue max attempts and dispatch deadline.
  - **UX:** none
  - **Problem:** the model call has no timeout and the queue is created with default retry settings, so a poison task retries a paid call repeatedly [anchor: src/llm.ts:6], [anchor: deploy.sh:3]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent risk of repeated paid calls [anchor: deploy.sh:3]
  - **Complexity:** Small — one fetch option and queue flags in the deploy script
  - **Risk:** Low — tighter limits only
  - **If never done:** a single bad task can keep spending on model calls until the queue's default limits stop it
  - **Verdict:** clears bar — a cheap ceiling on paid spend outweighs a small, low-risk change

# Task breakdown

### Task 1: Expand migration for `sections.content`

- **Skill:** `flow-system-design`
- **Description:** Add `content` beside `body` and backfill it, with idempotent statements so a rerun is safe, and a down migration. The file header states it must be applied before deploying code that reads `content`, and that it is additive so the running revision is unaffected. **Rollback step:** shift traffic back to the previous revision (`gcloud run services update-traffic reports-service --region us-central1 --to-revisions=<previous-revision>=100`) — safe because this release keeps `body` current; only if abandoning the change entirely, apply `002_sections_content.down.sql` after the traffic shift. **Rollback check:** the local-Postgres Test Step applies up → down → up and asserts the column state.
- **Inputs:** migrations/001_reports.sql
- **Outputs:** expand and down migrations
- **Contract:**
  - **Files:** `migrations/002_sections_content.sql` (create), `migrations/002_sections_content.down.sql` (create)
  - **Interfaces:** schema DDL:
    - up: `alter table sections add column if not exists content text;` then `update sections set content = body where content is distinct from body;`
    - down: `alter table sections drop column if exists content;`
  - **Call-site edits:** none
- **Acceptance criteria:** `grep -qi 'add column if not exists content text' migrations/002_sections_content.sql && grep -qi 'content is distinct from body' migrations/002_sections_content.sql && grep -qi 'drop column if exists content' migrations/002_sections_content.down.sql`

### Task 2: Migration helper with backup and recovery guard

- **Skill:** `flow-system-design`
- **Bundled:** no migration runner exists and the deploy applies none; the rename needs a safe, ordered way to apply migration 002 with a recovery point
- **Description:** A bash helper that applies one SQL file to Cloud SQL Postgres only after confirming automated backups and point-in-time recovery are enabled (otherwise it exits non-zero and prints the exact `gcloud sql instances patch "$CLOUD_SQL_INSTANCE" --backup-start-time=03:00 --enable-point-in-time-recovery` command), takes an on-demand backup and checks it reports `SUCCESSFUL` (the restore check: it then prints the backup id and the exact `gcloud sql backups restore <backup-id> --restore-instance=<scratch-instance>` command so a restore to a scratch instance can be verified), then runs `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f <file>`. Add one line to AGENTS.md: apply migrations with the helper before running `./deploy.sh` for code that reads them.
- **Inputs:** migrations/002_sections_content.sql (Task 1), deploy.sh, AGENTS.md
- **Outputs:** `scripts/migrate.sh`; AGENTS.md ordering rule
- **Contract:**
  - **Files:** `scripts/migrate.sh` (create, executable), `AGENTS.md` (edit)
  - **Interfaces:** `scripts/migrate.sh <sql-file>`; requires env `CLOUD_SQL_INSTANCE` and `DATABASE_URL` (`${VAR:?}`), `set -euo pipefail`; reads `gcloud sql instances describe "$CLOUD_SQL_INSTANCE" --format='value(settings.backupConfiguration.enabled,settings.backupConfiguration.pointInTimeRecoveryEnabled)'`; `gcloud sql backups create --instance="$CLOUD_SQL_INSTANCE" --description="pre-$(basename "$1")"`
  - **Call-site edits:** AGENTS.md — after the Runtime bullet, insert `- Migrations: apply with scripts/migrate.sh <file> before ./deploy.sh ships code that reads them; every migration must leave the running revision working.`
- **Acceptance criteria:** `bash -n scripts/migrate.sh && ! env -u CLOUD_SQL_INSTANCE DATABASE_URL=x bash scripts/migrate.sh migrations/002_sections_content.sql && grep -q 'scripts/migrate.sh' AGENTS.md`

### Task 3: Persistence — dual-write, fallback read, by-id lookup and save

- **Skill:** `flow-system-design`
- **Description:** Reads prefer `content` and fall back to `body`, aliased back to `body` so the API is unchanged. Every write sets both columns. Add a by-id lookup and a by-id save; keep the by-name save for legacy tasks, now also writing both columns.
- **Inputs:** Task 1 schema; src/db.ts
- **Outputs:** updated persistence functions
- **Contract:**
  - **Files:** `src/db.ts` (edit)
  - **Interfaces:**
    - `export type Section = { id: string; report_id: string; name: string };`
    - `export async function getSection(id: string): Promise<Section | undefined>` — `select id, report_id, name from sections where id = ${id}`
    - `export async function saveSectionContent(sectionId: string, content: string): Promise<void>` — `update sections set content = ${content}, body = ${content} where id = ${sectionId}`
    - `saveSection(reportId: string, name: string, content: string)` — unchanged signature (third param renamed), sets both `content` and `body`
    - `listSections(reportId)` — `select id, name, coalesce(content, body) as body from sections where report_id = ${reportId} order by position`
  - **Call-site edits:** none in this task (src/app.ts reads `listSections` unchanged)
- **Acceptance criteria:** `grep -q 'coalesce(content, body) as body' src/db.ts && grep -q 'export async function getSection' src/db.ts && grep -q 'export async function saveSectionContent' src/db.ts && bun build src/app.ts --target=bun --outdir=/tmp/reports-build >/dev/null`

### Task 4: Versioned generation task — id-keyed worker, v2 producer

- **Skill:** `flow-system-design`
- **Description:** The producer enqueues `{ version: 2, reportId, sectionId, section }`. The worker parses the body: a v2 task loads the section by id first (missing → 200 `gone`, no model call), then its report by the row's `report_id` (missing → 200 `gone`), calls the model with the row's name, and saves by id. A legacy `{ reportId, section }` task keeps today's by-name behaviour. A body matching neither shape is logged with `console.error` and acknowledged with 200 `invalid` so the queue does not retry it. Idempotency key: section id — a redelivery overwrites the same single row. Timeout: unchanged, the queue's dispatch deadline.
- **Inputs:** Task 3; src/worker.ts; src/queue.ts; src/llm.ts
- **Outputs:** updated worker and producer
- **Contract:**
  - **Files:** `src/worker.ts` (edit), `src/queue.ts` (edit)
  - **Interfaces:**
    - `export type GenerateSectionTask = { version: 2; reportId: string; sectionId: string; section: string } | { version?: undefined; reportId: string; section: string };`
    - `export function parseGenerateSectionTask(body: unknown): GenerateSectionTask | null`
    - `handleGenerateSection(req: Request): Promise<Response>` — unchanged signature
    - `enqueueSection(reportId: string, section: { id: string; name: string }): Promise<void>`
  - **Call-site edits:** `src/worker.ts` `handleGenerateSection` — use `getSection` + `saveSectionContent` on the v2 path, `saveSection` on the legacy path; `src/queue.ts` `enqueueSection` — body becomes `btoa(JSON.stringify({ version: 2, reportId, sectionId: section.id, section: section.name }))`; no in-repo callers of `enqueueSection` to update
- **Acceptance criteria:** `grep -q 'version: 2' src/queue.ts && grep -q 'export function parseGenerateSectionTask' src/worker.ts && bun build src/app.ts --target=bun --outdir=/tmp/reports-build >/dev/null`

### Task 5: Worker and producer tests

- **Skill:** `flow-testing`
- **Description:** `bun:test` specs with `mock.module` for `./db` and `./llm` (imported dynamically after mocking) and a stubbed `fetch` for the producer. Cases: v2 task saves via `saveSectionContent` with the section id (the idempotency key) and the model output; v2 task with a missing section returns 200 and the model mock is never called; v2 task with a missing report returns 200 with no model call; legacy task calls `saveSection(reportId, name, text)`; malformed body returns 200 with no model call; `parseGenerateSectionTask` accepts both shapes and rejects others; producer's decoded body equals `{ version: 2, reportId, sectionId, section }`.
- **Inputs:** Task 4
- **Outputs:** test files
- **Contract:**
  - **Files:** `src/worker.test.ts` (create), `src/queue.test.ts` (create)
  - **Interfaces:** none exported
  - **Call-site edits:** none
- **Acceptance criteria:** `bun test src/worker.test.ts src/queue.test.ts`

| Task | Depends on |
| --- | --- |
| 1 | — |
| 2 | 1 |
| 3 | 1 |
| 4 | 3 |
| 5 | 4 |

### Skills Summary

| Skill | Recommended? | Reason |
| --- | --- | --- |
| flow-system-design | Yes (Tasks 1-4) | Expand/contract, versioned task payload, rollback and recovery are its rollout/data/recovery references |
| flow-testing | Yes (Task 5) | New `bun:test` specs with module mocks |
| flow-metrics | No | No new runtime surface; Instrumentation is `none` |
| flow-new-feature | No | Implementation driver, not a per-task skill |
| flow-refactoring | No | Behaviour changes (payload contract), not a pure refactor |

# PR description draft

## TLDR

Generation tasks previously found sections by a non-unique name and could overwrite the wrong ones; they now target one section by id, and section text moves to `content` without failed reads during deploy.

## User-facing changes

- Shipping a release that includes a database change now starts with the migration helper:
  - **Before:** you ran `./deploy.sh` and applied schema changes by hand, with no order defined.
  - **After:** you run `scripts/migrate.sh migrations/002_sections_content.sql`, which refuses to run unless backups and point-in-time recovery are on and takes a fresh backup, and only then run `./deploy.sh`.
- The report API is unchanged: section text is still returned under `body`.

## System changes

- Each generation task now targets exactly one section:
  - **Before:** a task carried the section's name, and the save overwrote every section in the report with that name.
  - **After:** a task carries a version marker, the section's id and, for now, its name, and the save writes only that one section.
- Tasks for a section or report that no longer exists are now dropped before the paid model call:
  - **Before:** the worker paid for a generation and then saved it to nothing.
  - **After:** the worker checks the section exists first and makes no model call when it does not.
- Section text is stored in both the old and the new column until the follow-up removes the old one:
  - **Before:** text was stored once.
  - **After:** every save writes both, and reads prefer the new column.
- Cost: one fewer paid model call for each task whose section is gone; no other change in spend.

## Why

The worker found the section to fill in by its name, which is not unique within a report, so a generation could overwrite the wrong rows. The owner also wants the stored text under a clearer name. Making both changes in a single release would fail report reads during the deploy, and the queue would retry paid generations whose saves fail, because the deploy cannot apply a database change and new code at the same instant.

## Key decisions

- **Expand/contract instead of an in-place rename.** This release adds `content` beside `body` and writes both. Each step works with the version before and after it, so rolling back is just shifting traffic back. The alternative was a four-step manual cutover with a window of failed reads. Dropping `body` is a separate follow-up, filed when this merges.
- **Tasks carry both the id and the name during the transition.** A task sent with only the id would make the previous worker version pay for a generation of an undefined section if this release were rolled back. The name field goes away in the same follow-up.
- **The worker still accepts tasks in the old name-only form.** Tasks already queued before the deploy still complete, and so do any sent by a producer outside this repo. No code in this repo enqueues these tasks.
- **The report API keeps the `body` key.** Renaming it would break every client, and the request only covered the column.
- **The migration helper refuses to run, rather than turning backups on itself.** It prints the exact command to run, so the production change stays explicit.
- Bundled: a migration helper with a backup and recovery guard, because no migration runner existed and the deploy applies none.

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/worker.test.ts src/queue.test.ts`. Expect all specs to pass: id-keyed save, no model call for a missing section or report, legacy name task, malformed task, and the producer's payload shape.
- [ ] Start a scratch Postgres: `docker run -d --rm --name sections-pg -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16 && until pg_isready -h localhost -p 55432; do sleep 1; done`
- [ ] Apply the base schema with one generated section: `psql postgresql://postgres:pg@localhost:55432/postgres -v ON_ERROR_STOP=1 -f migrations/001_reports.sql -c "insert into reports(id,company) values ('r1','Acme'); insert into sections(id,report_id,name,position,body) values ('s1','r1','Overview',0,'old text')"`
- [ ] Apply the expand migration and check the backfill: `psql postgresql://postgres:pg@localhost:55432/postgres -v ON_ERROR_STOP=1 -f migrations/002_sections_content.sql && [ "$(psql postgresql://postgres:pg@localhost:55432/postgres -tAc "select content from sections where id='s1'")" = "old text" ]`
- [ ] Run down, then up again, and check that `content` exists: `psql postgresql://postgres:pg@localhost:55432/postgres -v ON_ERROR_STOP=1 -f migrations/002_sections_content.down.sql -f migrations/002_sections_content.sql && [ "$(psql postgresql://postgres:pg@localhost:55432/postgres -tAc "select count(*) from information_schema.columns where table_name='sections' and column_name='content'")" = "1" ]`
  - Clean up afterwards with `docker stop sections-pg`.
- [ ] Run `bash -n scripts/migrate.sh && ! env -u CLOUD_SQL_INSTANCE DATABASE_URL=x bash scripts/migrate.sh migrations/002_sections_content.sql`. Expect the helper to refuse without a target instance.
