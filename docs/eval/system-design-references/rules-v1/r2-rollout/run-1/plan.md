# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

# Rename section text to `content` and key section tasks by id

**Goal:** Section text lives in a `content` column and each queued generation task names its section by id, with no failed reads, lost tasks, or wasted model calls during the switch.

## Problem Statement

Each report is built from sections, and each section's text is written by a background task that calls a paid model API. Today the stored text sits in a column called `body`, and each queued task names its section only by its display name, so the worker finds the row to update by matching that name inside the report. Names are not guaranteed unique and can change, so a task can update the wrong row or every row that shares a name, while the row's real identifier goes unused. Doing the rename and the task change carelessly costs more than the problem it fixes: the report page can fail mid-deploy, tasks already waiting in the queue can be run against a missing section, and each wasted run is a paid model call.

| Fact | Evidence |
| ---- | -------- |
| Section text column is `body`; `id` is the primary key; nothing makes `(report_id, name)` unique | [anchor: migrations/001_reports.sql:8-14] |
| The worker writes by report id plus section name, not by section id | [anchor: src/db.ts:15-17] |
| The task payload carries `{ reportId, section }`, where `section` is the name | [anchor: src/queue.ts:11], [anchor: src/worker.ts:6] |
| The name is also the model prompt input, so an id-only task still needs the name looked up | [anchor: src/llm.ts:8] |
| The report endpoint returns `body` as a response field, read straight from the column | [anchor: src/db.ts:12], [anchor: src/app.ts:14] |
| The only in-repo task producer has no caller anywhere in the repo | `grep -rn enqueueSection src` → only its definition at src/queue.ts:4 |
| Migrations are not applied by the deploy script | [anchor: deploy.sh:1-4] |

Who it affects, in the product brief's ranked terms: readers of a report (user experience, priority 1) must not see a failed or emptied report during the switch, and the owner paying per model call (cost, priority 2) must not pay for runs that write nowhere.

## Request vetting

- **Hypothesis:** The column rename and the id-keyed task can ship without failing report reads during the Cloud Run rollout, without mis-running tasks already queued under the name-only shape, and with the previous release still a valid rollback target.
- **Case against:** Done literally in one release, an in-place column rename plus a payload that drops the name breaks all three: the previous revision keeps selecting `body` until traffic shifts [anchor: src/db.ts:12], queued tasks carry only the name [anchor: src/queue.ts:11], and a worker that rolls back to the old code would pass an undefined name into a paid model call and then update zero rows [anchor: src/worker.ts:9-10]. Parallel change (expand, migrate, contract) exists precisely for this.
- **Sources:** https://martinfowler.com/bliki/ParallelChange.html
- **Verdict:** adopt-with-conditions: ship only the expand half in this PR — the previous release must still read and write everything this release writes (both columns written, task keeps the name), proven by the db and queue tests; dropping `body` and the name field waits for the contract follow-up, gated on the name-shaped payload counter reading zero.

## Existing-code assessment

- **migrations/001_reports.sql:** keep — not edited; the new numbered migration follows its convention. [anchor: migrations/001_reports.sql:1]
- **src/db.ts:** keep — small single-purpose queries; extend in place with an id lookup and an id-keyed write. [anchor: src/db.ts:11-17]
- **src/worker.ts:** simplify — the payload is a blind cast and the paid model call runs before the section is validated; extract a payload parser and move every lookup ahead of the paid call before adding the id path. [anchor: src/worker.ts:6-9]
- **src/queue.ts:** simplify — no dispatch deadline, no timeout, and no status check on the enqueue call; fix while changing its signature. [anchor: src/queue.ts:5-15]
- **src/llm.ts:** simplify — the model call has no timeout and no status check, so a failed call saves an undefined text and completes the task. [anchor: src/llm.ts:6-10]
- **deploy.sh:** simplify — `create || true` never applies retry settings to an existing queue, so retries run on Google's defaults. [anchor: deploy.sh:3]
- **src/app.ts:** keep — the route and response shape stay as they are. [anchor: src/app.ts:14]

## Scope Boundary

**In scope:**

- A new `content` column, backfilled from `body`, written alongside `body` by every write in this release.
- Report reads take `content`, falling back to `body` for rows the previous revision wrote during the rollout.
- The worker accepts both the new id-carrying task and the old name-only task; the id path resolves the section row before any paid call.
- The task producer emits `{ reportId, sectionId, section }` (name kept for rollback compatibility).
- Bundled hardening that bounds the drain window and paid retries: queue retry settings, a task dispatch deadline, model-call and enqueue timeouts and status checks, and skip-if-already-generated on the id path.
- A first metrics contract and helper, including the name-shaped payload counter that gates the contract follow-up.
- A pre-migration backup and point-in-time-recovery check.

**Out of scope:**

- Dropping `body`, removing the name from the task, and deleting the name-only worker branch — the contract follow-up (ticked candidate).
- Renaming the report endpoint's `body` response field (unticked candidate).
- Authenticating the worker route (ticked candidate).
- A migration runner; migrations stay operator-applied as today.

## Behavioral contrast

### User flow

| Before | After |
| ------ | ----- |
| A report reader gets sections with a `body` field | Unchanged — same field, same values |
| The operator runs `./deploy.sh` | The operator applies migration 002, then runs `./deploy.sh`; the script now also applies queue retry settings |
| A failed model call silently saves an empty section and the task completes | The task fails and retries up to 5 times, then stops |

### System flow

- **Before:**
  - Tasks carry the section name; the worker calls the model first, then updates every row matching report id plus name in `body`.
  - The queue retries on Google's defaults; the model call has no timeout.
- **After:**
  - Tasks carry the section id (plus the name and report id for one release); the worker resolves the row by id, skips the paid call when the section already has text or no longer exists, and writes `content` and `body` together by id.
  - Name-only tasks still run through the old path, and each one is counted so the drain is visible.
  - The queue stops after 5 attempts; each attempt has a 180 s deadline and the model call a 90 s timeout.

**Lost:** the name-only task shape and the `enqueueSection(reportId, name)` signature are deprecated (still accepted by the worker until the contract follow-up), and a re-enqueued id task no longer regenerates a section that already has text.

## User Stories / Acceptance Criteria

### Story 1: Report reads survive the rename

- [ ] Given migration 002 is applied, when the backfill runs on rows with `body`, then every row has `content` equal to `body` — checked by `src/db.test.ts` against a local Postgres.
- [ ] Given a row the previous revision wrote with `body` only, when the report is read, then its section text is returned — `src/db.test.ts` read-fallback spec.
- [ ] Given a section saved by id, when either column is read, then both hold the new text — `src/db.test.ts` dual-write spec.

### Story 2: Tasks are keyed by section id

- [ ] Given a task `{ reportId, sectionId, section }`, when the worker runs, then the model is called with the row's name and the text is saved to that row id only — `src/worker.test.ts`.
- [ ] Given a task whose section id does not exist, when the worker runs, then it answers 200, makes zero model calls, and records `error.type=not_found` — `src/worker.test.ts`.
- [ ] Given a section that already has text, when its id task is redelivered, then the worker answers 200 with zero model calls — `src/worker.test.ts`.
- [ ] Given a legacy task `{ reportId, section }`, when the worker runs, then it takes the name path and the payload counter records `section_task.payload_shape=name` — `src/worker.test.ts`.
- [ ] Given a payload matching neither shape, when the worker runs, then it answers 200, makes zero model calls, and records `error.type=invalid_input` — `src/worker.test.ts`.

### Story 3: The previous release stays a rollback target

- [ ] Given the new producer, when a task is enqueued, then the decoded body still carries `reportId` and the section name the previous worker reads, plus `sectionId`, with `dispatchDeadline: "180s"` — `src/queue.test.ts`.
- [ ] Given the model API answers non-2xx or exceeds 90 s, when the worker runs, then the request fails with a non-2xx status so the queue retries, and nothing is saved — `src/worker.test.ts` and `src/llm.test.ts`.

## Instrumentation

**Contract:** `.flow/metrics.md` create

### Metrics

| Metric | Instrument | Unit | Attributes (closed values) | Emitted at |
| ------ | ---------- | ---- | -------------------------- | ---------- |
| `reports.section_task.duration` | Histogram | seconds | `operation.outcome` (`ok`, `error`) | generate-section worker |
| `reports.section_task.failures` | Counter | none | `error.type` (`_OTHER`, `internal`, `invalid_input`, `not_found`, `upstream_error`, `upstream_timeout`) | generate-section worker |
| `reports.section_task.payloads` | Counter | none | `section_task.payload_shape` (`id`, `name`) | generate-section worker |
| Cloud Tasks `queue/depth` (queue `sections`) | Gauge | `{message}` | `messaging.destination.name` (`sections`) | platform-native (Cloud Tasks) |

Histogram boundaries are job-scale, not request-scale: `[1, 5, 10, 20, 30, 45, 60, 90, 120, 180]` seconds, because a model call takes 20-60 s [anchor: src/llm.ts:1].

Estimated series: 34 per operation (histogram 2 outcomes x 13, failures 6, payload shape 2), per instance.

**Attributes:** registers `operation.outcome`, `error.type`, and new `section_task.payload_shape` (`id`, `name`) — the shape of the task the worker received.

### Error types

New, seeded from the starter list: `invalid_input` (payload matches neither task shape, or its report id disagrees with the section row — client-caused), `not_found` (the section or report row no longer exists — client-caused), `upstream_error` (the model API answered non-2xx), `upstream_timeout` (the model call exceeded 90 s), `internal`, `_OTHER`. The two client-caused values are excluded from the SLO.

### Dashboard panels

On a new "Reports overview" dashboard (spec-only): section task rate by outcome, failures by `error.type`, task duration p50/p95/p99, payload shape split (the drain signal for the contract follow-up), and `sections` queue depth.

### Alerts

burn-rate tiers only

### SLO

New journey SLO "report section generation": 99% of section tasks end `ok` over 30 days, excluding `invalid_input` and `not_found`; standard burn-rate tiers recorded once in `.flow/metrics.md`.

**As-code:** spec-only — the repo keeps no dashboard or alert files and has no metrics backend yet.

## Architecture Decisions

| Aspect | Decision |
| ------ | -------- |
| Layers touched | DB schema (migration 002), persistence (`src/db.ts`), queue producer (`src/queue.ts`), queue consumer (`src/worker.ts`), model client (`src/llm.ts`), deploy script, new metrics helper |
| Domain modules | Existing: db, queue, worker, llm. New: `src/metrics.ts` (zero-dependency, per AGENTS.md) |
| Data flow | Producer enqueues `{ reportId, sectionId, section }` to the existing `sections` Cloud Tasks queue; the worker resolves the row by id, calls the model with the row's name, writes `content` and `body` by id; report reads use `coalesce(content, body)` |
| Pattern | Expand/contract (parallel change) for both the column and the task payload; this PR is the expand half |
| Binary-framing check | In-place single-release rename vs expand/contract, with a middle option (in-place rename inside a paused-queue maintenance window) — simulated in Decision analysis |

### Runtime design

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --------- | -------- | --------------- | ------------------ | ------- | --------------- | ---------- |
| generate-section task (worker) | ~65 s | queue — existing `sections` Cloud Tasks queue, worker invoked synchronously under the attempt deadline | dispatch deadline 180 s; model call 90 s | queue layer only: max 5 attempts, backoff 10 s to 300 s | section id; skip when the section already has text | at most 5 paid model calls per section (no spend ledger exists) |
| enqueue generate-section task (producer) | inline — ~0.3 s, timeout 10 s | inline | 10 s | none — caller decides | section id | none — no paid call |
| read report sections (`GET /reports/:id`) | inline — ~0.05 s, timeout none (query expression change only) | inline | none set (unchanged) | none | n/a — read | none — no paid call |

**Platform:** gcp

**Proportionality:** no canary traffic split (straight deploy with a tested traffic-shift rollback); no payload `version` field (the worker discriminates on `sectionId`); no spend ledger (retries are capped instead; ledger is a separate candidate); no statement timeout on the unchanged read; no migration runner.

**Recovery:** Task 2 — confirm Cloud SQL automated backups and point-in-time recovery are on (enable if not), take an on-demand backup immediately before applying migration 002, and confirm the backup lists as successful. Migration 002 is additive and never touches `body`; the backup matters most for the contract follow-up's drop.

**Rollback:** Task 7 — shift Cloud Run traffic back to the previous revision; valid because `body` is still written and the task still carries the name; checked by `src/queue.test.ts` and `src/db.test.ts` compatibility specs.

## Technical Constraints

- Migration 002 must be applied before the new revision receives traffic, because the new code writes `content`; the deploy script applies no migrations [anchor: deploy.sh:1-4].
- No new runtime dependencies — the metrics helper is an in-memory recorder behind a swappable interface [anchor: AGENTS.md].
- A Cloud Tasks HTTP target completes a task only on a 2xx response; any other response retries it — so permanent failures (missing row, bad payload) must answer 200 and transient ones non-2xx. Source: https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks
- Deadlines shrink inward: model call 90 s < dispatch deadline 180 s < Cloud Run request timeout (5 min default). Source: https://docs.cloud.google.com/run/docs/configuring/request-timeout
- Cost: capping attempts at 5 bounds paid model calls per section; today's queue runs on Google's default retry policy [anchor: deploy.sh:3].

## Open Questions

- [ ] Is the service live, with real readers and tasks in flight? If it is pre-launch, the plan collapses to a single in-place rename and drops the dual write, both payload shapes, and the contract follow-up.
  - **Stakes:** both — user experience (priority 1: a failed report read mid-deploy) and cost (priority 2: queued tasks wasting paid calls) if the in-place path is chosen while live.
  - **Recommended:** Treat it as live and ship expand/contract — it is safe either way, while the in-place path is unrecoverable if the guess is wrong; it costs one extra migration and one follow-up PR. [confidence: medium] [anchor: weighing: reversibility — expand/contract can always be collapsed later, an in-place rename cannot be undone mid-rollout]
- [ ] Should the report endpoint's response field stay `body`? Renaming it to `content` breaks any client reading the field.
  - **Stakes:** user — readers of the report endpoint (priority 1, fewer surprises) see a missing field if it changes without notice.
  - **Recommended:** Keep the response field `body` in this PR; the request names only the column and the task, and the field rename is the unticked candidate. [confidence: medium] [anchor: weighing: risk — the user's words name only "the `body` column on `sections`", and a response rename breaks unknown clients]
- [ ] Does any producer outside this repo enqueue generate-section tasks? The only in-repo producer has no caller, so the real task source is not visible here.
  - **Stakes:** system — architecture (priority 3): if an outside producer keeps sending name-only tasks, the name branch can never be deleted.
  - **Recommended:** Accept both shapes now and let the payload-shape counter answer it — the contract follow-up removes the name branch only after the counter reads zero for the drain window. [confidence: medium] [anchor: weighing: risk — the plan is correct whatever the answer; only the follow-up's timing depends on it]
- [ ] Are migrations applied by hand before deploy? If a runner elsewhere applies them after deploy, the new revision would write a column that does not exist yet.
  - **Stakes:** system — product quality (priority 4): every section write fails until the migration lands.
  - **Recommended:** Yes — operator-applied before `./deploy.sh`, as the repo implies; the migration file's header states the order. [confidence: high] [anchor: deploy.sh:1-4]
- [ ] Should the id path skip the paid call when the section already has text? It makes redelivery free but means re-enqueueing an id task can no longer force a regeneration.
  - **Stakes:** both — cost (priority 2: duplicate paid calls on redelivery) against user experience (priority 1: a reader who wants a fresh section).
  - **Recommended:** Skip — nothing in the repo re-enqueues to regenerate, and Cloud Tasks delivers at least once, so every redelivery is a paid duplicate today. [confidence: medium] [anchor: adjacent: src/worker.ts:8]
- [ ] Are 5 attempts, a 180 s task deadline, and a 90 s model timeout the right bounds? Looser bounds mean more paid retries and a longer drain before the contract follow-up.
  - **Stakes:** both — cost (priority 2: paid retries per section) against product quality (priority 4: a section abandoned after a transient outage).
  - **Recommended:** Use them — 90 s is 1.5x the stated worst-case model latency, and 5 attempts with backoff up to 300 s bound the drain window to well under an hour. [confidence: medium] [anchor: adjacent: src/llm.ts:1]

## Decision analysis

**Decision A — ship the rename in one release, or as expand/contract?**

| Branch | System flow | User / operator flow | Friction |
| ------ | ----------- | -------------------- | -------- |
| A1 In-place single release (`rename column`, id-only payload) | Old revision selects `body` until traffic shifts; queued name-only tasks hit a worker expecting an id; no rollback without a reverse migration | Report page errors for the rollout window; some sections never fill in; paid calls wasted | 0 interruptions, but an incident if live |
| A2 Middle: in-place rename in a maintenance window | Operator pauses the queue, waits for in-flight tasks, applies the rename, deploys, resumes; rollback still needs a reverse migration | Report page down for the deploy (~1-2 min); nothing lost | 1 interruption per deploy: run `gcloud tasks queues pause sections`, wait for in-flight tasks, migrate, deploy, `resume` |
| A3 Expand/contract (this plan) | Add + backfill `content`, dual write, both payload shapes; later PR drops `body` and the name | No visible change; rollback is a traffic shift | 0 interruptions now; 1 follow-up PR later |

Exclusive — A1, A2 and A3 are alternative cut-over strategies. Ranking: A3 > A2 > A1 when live; A1 > A3 > A2 when pre-launch (see the live-service Open Question).

Verdict: **A3 expand/contract** — it is the only branch with zero reader-visible failure (priority 1) and zero wasted paid calls (priority 2) when live, and it stays reversible by traffic shift. [confidence: medium] [anchor: weighing: reversibility — A3 keeps the previous revision a valid rollback target; A1 and A2 need a reverse migration]

## Alternatives considered

- **Alias `body` to `content` with a generated column or view** — rejected: a generated column is read-only, so the previous revision's `update sections set body = …` (src/db.ts:16) fails during the rollout.
- **Add a `version` field to the task payload** — rejected: the worker discriminates on the presence of `sectionId`, and no second consumer reads a version (src/worker.ts:6).
- **Apply migrations from `deploy.sh`** — rejected: the script has no database client or credentials (deploy.sh:1-4), and AGENTS.md asks for a reason before adding a dependency.

## Recommendation

**Reconsider scope** — ship the expand half only (new column, dual write, both task shapes) and move dropping `body` and the name field to the ticked contract follow-up (see the live-service Open Question); the simplify verdicts on the worker, producer, model client and deploy script are bundled into Tasks 4, 6 and 7. [confidence: medium] [anchor: weighing: reversibility — the previous release stays a valid rollback target]

**Redundancy:** none found

## Plan risks

The weakest assumption is that this repo owns the task producer — its only producer has no caller and sends no auth header, so if the real producer lives elsewhere and keeps sending name-only tasks, the contract follow-up can never ship.

## Cut list

- The duration histogram, failures counter and `.flow/metrics.md` scaffold are default instrumentation; the only metric a named reader needs this release is the payload-shape counter that gates the contract follow-up — cutting the rest would roughly halve Task 5.
- The skip-if-already-generated guard in Task 6 is bundled cost hardening, not part of the rename; cutting it keeps today's duplicate paid calls on redelivery.

# Candidate follow-up issues

| Candidate | Value | Complexity | Rationale | Relation to current request | Pull into this pipeline? |
| --------- | ----- | ---------- | --------- | --------------------------- | ------------------------ |
| Authenticate the generate-section worker route | High | Medium | needs its own design/decision session: the open decision is a separate `--no-allow-unauthenticated` worker service vs verifying the Cloud Tasks OIDC token in the handler — anyone can trigger paid calls today | same worker, unrelated concern | No |
| Contract step: drop `body`, the name field and the name-only worker branch | Medium | Small | needs its own design/decision session: the open decision is the contract-release date — when this release is no longer a rollback target and the payload-shape counter has read zero for the drain window | completes this rename | No |
| Single spend ledger for model calls | Medium | Medium | needs its own design/decision session: the open decision is the budget unit (per day, per report) and what happens when it is exhausted | same paid path, separate cost control | No |
| Fix or remove the in-repo task producer | Low | Small | needs its own design/decision session: the open decision is whether this repo or another service produces tasks, since the only producer has no caller | same producer function | No |
| Rename the report response field `body` to `content` | Low | Small | needs its own design/decision session: the open decision is whether report-endpoint clients can take a breaking field rename or need a versioned response | naming follow-on to this rename | No |

- [x] Authenticate the generate-section worker route — the worker route is on a publicly invokable service, so anyone can trigger paid model calls and bypass the queue's retry caps.
  - **UX:** none
  - **Problem:** any caller can POST a task body to the worker and trigger a paid model call [anchor: deploy.sh:4]
  - **Stability/efficiency:** none
  - **Value rank:** 5 — security exposure on a paid path with no workaround [anchor: src/app.ts:9]
  - **Complexity:** Medium — deploy script, worker, and either a second service or token verification
  - **Risk:** Medium — a wrong audience check stops all section generation
  - **If never done:** the paid model path stays open to anyone who finds the URL
  - **Verdict:** clears bar — an open paid endpoint outweighs a medium change
- [x] Contract step: drop `body`, the name field and the name-only worker branch — finishes the rename once the drain is confirmed.
  - **UX:** none
  - **Problem:** until it ships, every write goes to two columns and the worker carries two task paths [anchor: user: "rename the `body` column on `sections` to `content`"]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — the requested rename stays half-done, a standing latent risk of the two columns drifting [anchor: user: "carry the section id instead of the section name"]
  - **Complexity:** Small — one migration (re-backfill, then drop) plus removing the name branch and the `body` write
  - **Risk:** Medium — destructive drop; needs the pre-drop backup and the counter evidence
  - **If never done:** the `body` column and the name-only path stay forever and the user's rename never completes
  - **Verdict:** clears bar — it is the second half of the requested change and is cheap once gated
- [ ] Single spend ledger for model calls — one choke point that caps paid model spend.
  - **UX:** none
  - **Problem:** no cap on paid model calls exists anywhere; this plan only caps retries per section [anchor: src/llm.ts:1]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — an unfired latent cost risk [anchor: src/llm.ts:1]
  - **Complexity:** Medium — new table, a reserve-and-reconcile step at the model client
  - **Risk:** Medium — a wrong budget stops generation
  - **If never done:** spend is bounded only by task volume times 5 attempts
  - **Verdict:** below bar — this plan's attempt cap bounds the retry multiplier, and no overspend has been observed
- [ ] Fix or remove the in-repo task producer — it has no caller and sends no auth header to the Cloud Tasks API.
  - **UX:** none
  - **Problem:** `enqueueSection` has no caller and posts without an Authorization header [anchor: src/queue.ts:5]
  - **Stability/efficiency:** none
  - **Value rank:** 2 — a single dead path that cannot work as written [anchor: src/queue.ts:5]
  - **Complexity:** Small — one function plus a metadata-server token fetch, or deletion
  - **Risk:** Medium — depends on which service really produces tasks
  - **If never done:** the dead producer keeps misleading readers about where tasks come from
  - **Verdict:** below bar — moot until the producer question is answered
- [ ] Rename the report response field `body` to `content` — aligns the API with the new column name.
  - **UX:** none
  - **Problem:** none
  - **Stability/efficiency:** none
  - **Value rank:** 1 — cosmetic naming alignment [anchor: src/app.ts:14]
  - **Complexity:** Small — one select alias, plus client coordination
  - **Risk:** Medium — breaks any client reading `body`
  - **If never done:** nothing — the field keeps its current name
  - **Verdict:** below bar — cosmetic, and it trades a naming nicety for a client-visible break

# Task breakdown

### Task 1: Migration 002 — add and backfill `content`

- **Skill:** `flow-system-design`
- **Description:** Expand step. Add a nullable `content` column and copy `body` into it. The backfill is idempotent and safe to re-run after a rollback (it re-syncs any row the previous revision rewrote). The header comment states the order: take the Task 2 backup, apply this file, then run `./deploy.sh`.
- **Inputs:** `migrations/001_reports.sql`
- **Outputs:** `migrations/002_sections_content.sql`
- **Contract:**
  - **Files:** create `migrations/002_sections_content.sql`
  - **Interfaces:** exact DDL:
    - `alter table sections add column if not exists content text;`
    - `update sections set content = body where content is distinct from body and body is not null;`
  - **Call-site edits:** none
- **Acceptance criteria:** `grep -q 'add column if not exists content text' migrations/002_sections_content.sql && grep -q 'set content = body where content is distinct from body' migrations/002_sections_content.sql`

### Task 2: Verify backups and point-in-time recovery before migrating

- **Skill:** `flow-system-design`
- **Description:** Operator step, run before Task 1's migration is applied. Confirm automated backups and point-in-time recovery are on for the Cloud SQL instance and enable them if not (`gcloud sql instances patch "$CLOUD_SQL_INSTANCE" --backup-start-time=03:00 --enable-point-in-time-recovery`). Take an on-demand backup (`gcloud sql backups create --instance="$CLOUD_SQL_INSTANCE"`), then confirm it lists as `SUCCESSFUL` (restore check). The instance name is not in the repo, so it is parameterized as `${CLOUD_SQL_INSTANCE:?}` (find it with `gcloud sql instances list`).
- **Inputs:** gcloud access to the production project
- **Outputs:** point-in-time recovery confirmed on; a fresh on-demand backup
- **Contract:**
  - **Files:** none (operator commands; recorded in the migration 002 header comment from Task 1)
  - **Interfaces:** config key `settings.backupConfiguration.pointInTimeRecoveryEnabled`: before → unknown, after → `True`
  - **Call-site edits:** none
- **Acceptance criteria:** `[ "$(gcloud sql instances describe "${CLOUD_SQL_INSTANCE:?}" --format='value(settings.backupConfiguration.pointInTimeRecoveryEnabled)')" = "True" ] && gcloud sql backups list --instance="${CLOUD_SQL_INSTANCE:?}" --limit=1 --format='value(status)' | grep -q SUCCESSFUL`

### Task 3: Persistence — id lookup, dual write, read fallback

- **Skill:** `flow-testing`
- **Description:** Extend `src/db.ts`. Reads return `coalesce(content, body)` so rows the previous revision wrote during the rollout still show. The response field stays `body`. Every write sets both columns. Rename today's name-keyed write to `saveSectionByName` (legacy path, also dual-writes) and add an id-keyed `saveSection`. Add a Postgres-backed test that skips without `DATABASE_URL` and covers backfill, dual write and read fallback.
- **Inputs:** Task 1 migration file
- **Outputs:** updated `src/db.ts`, new `src/db.test.ts`
- **Contract:**
  - **Files:** edit `src/db.ts`; create `src/db.test.ts`; edit `src/worker.ts` (call site only)
  - **Interfaces:**
    - `export type Section = { id: string; report_id: string; name: string; content: string | null }`
    - `export async function getSection(id: string): Promise<Section | undefined>` — `select id, report_id, name, coalesce(content, body) as content from sections where id = ${id}`
    - `export async function saveSection(sectionId: string, content: string): Promise<void>` — `update sections set content = ${content}, body = ${content} where id = ${sectionId}`
    - `export async function saveSectionByName(reportId: string, name: string, content: string): Promise<void>` — `update sections set content = ${content}, body = ${content} where report_id = ${reportId} and name = ${name}`
    - `listSections(reportId)` — `select id, name, coalesce(content, body) as body from sections where report_id = ${reportId} order by position`
  - **Call-site edits:** `src/worker.ts` `handleGenerateSection`: `saveSection(reportId, section, body)` → `saveSectionByName(reportId, section, body)`
- **Acceptance criteria:** `bun test src/db.test.ts && grep -q 'coalesce(content, body) as body' src/db.ts && grep -q 'export async function saveSectionByName' src/db.ts`

### Task 4: Model client — timeout and status check

- **Skill:** `flow-system-design`
- **Bundled:** the model client's missing timeout and status check, surfaced in the Existing-code assessment
- **Description:** Give the model call a 90 s timeout and throw on a non-2xx response or a missing `text`, so a failed call fails the task (and the queue retries) instead of saving nothing and completing. Throw typed errors the worker maps to `upstream_timeout` and `upstream_error`.
- **Inputs:** `src/llm.ts`
- **Outputs:** updated `src/llm.ts`, new `src/llm.test.ts`
- **Contract:**
  - **Files:** edit `src/llm.ts`; create `src/llm.test.ts`
  - **Interfaces:**
    - `export const GENERATE_TIMEOUT_MS = 90_000`
    - `export class UpstreamError extends Error { constructor(readonly kind: "timeout" | "status", message: string) }`
    - `generateSection(company, section)` passes `signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS)`; throws `UpstreamError("timeout")` on abort and `UpstreamError("status")` on `!res.ok` or a non-string `text`
  - **Call-site edits:** none (the signature is unchanged)
- **Acceptance criteria:** `bun test src/llm.test.ts` (specs: non-2xx throws `kind: "status"`, abort throws `kind: "timeout"`, 2xx returns the text)

### Task 5: Metrics helper and `.flow/metrics.md`

- **Skill:** `flow-metrics`
- **Description:** Create the zero-dependency metrics helper with a swappable recorder and an in-memory recorder for tests. Create `.flow/metrics.md` with these sections:
  - `## Backend`: `none yet — suggested: Google Cloud Monitoring` (ingestion route decided with the backend)
  - `## Namespace`: `reports`
  - `## Attributes`: `operation.outcome`, `error.type`, `section_task.payload_shape`
  - `## error.type values`: `_OTHER`, `internal`, `invalid_input`, `not_found`, `upstream_error`, `upstream_timeout`
  - `## Helper`: `src/metrics.ts`
  - `## Dashboard panels`, `## Dashboards`, `## Alerts` (burn-rate tiers), `## As-code` (spec-only), and `## SLOs`, as specced in the Instrumentation section
  - `## Coverage`: `reports.section_task`
- **Inputs:** new: `src/metrics.ts`
- **Outputs:** `src/metrics.ts`, `src/metrics.test.ts`, `.flow/metrics.md`
- **Contract:**
  - **Files:** create `src/metrics.ts`; create `src/metrics.test.ts`; create `.flow/metrics.md`
  - **Interfaces:**
    - `export type ErrorType = "_OTHER" | "internal" | "invalid_input" | "not_found" | "upstream_error" | "upstream_timeout"`
    - `export type Attributes = { "operation.outcome"?: "ok" | "error"; "error.type"?: ErrorType; "section_task.payload_shape"?: "id" | "name" }`
    - `export interface Recorder { histogram(name: string, seconds: number, attrs: Attributes): void; counter(name: string, inc: number, attrs: Attributes): void }`
    - `export function setRecorder(r: Recorder): void`
    - `export function memoryRecorder(): Recorder & { histograms: Array<{ name: string; seconds: number; attrs: Attributes }>; counters: Array<{ name: string; inc: number; attrs: Attributes }> }`
    - `export async function instrument<T>(op: string, fn: () => Promise<T>, classify: (e: unknown) => ErrorType): Promise<T>` — records `<op>.duration` with the outcome and, on throw, `<op>.failures` with `error.type`, then rethrows
    - `export function count(name: string, attrs: Attributes): void`
  - **Call-site edits:** none (first consumer is Task 6)
- **Acceptance criteria:** `bun test src/metrics.test.ts && test -f .flow/metrics.md && grep -q 'section_task.payload_shape' .flow/metrics.md`

### Task 6: Worker — accept both task shapes, key by id

- **Skill:** `flow-system-design`
- **Bundled:** the worker's validate-before-paid-call cleanup and the skip-if-already-generated guard from the Existing-code assessment and the redelivery Open Question
- **Description:** Parse the payload into one of two shapes.
  - **Id path** (`sectionId` present): look up the section first. A missing row answers 200 as `not_found`; a report id that disagrees with the row answers 200 as `invalid_input`; a section that already has text answers 200 with no model call (idempotency key: section id). Otherwise load the report (missing answers 200 as `not_found`), call the model with the row's name, and save by id.
  - **Name path** (legacy): keep today's behaviour through `saveSectionByName`.
  - **Neither shape:** answer 200 as `invalid_input`.
  - **Transient failures:** `UpstreamError` and anything unexpected answer 500, so the queue retries.
  - **Metrics:** wrap the whole handler in `instrument("reports.section_task", …)` and count `reports.section_task.payloads` by shape. The handler's own timeout is the model's 90 s, inside the 180 s dispatch deadline.
- **Inputs:** Task 3 `src/db.ts`, Task 4 `src/llm.ts`, Task 5 `src/metrics.ts`
- **Outputs:** updated `src/worker.ts`, new `src/worker.test.ts`
- **Contract:**
  - **Files:** edit `src/worker.ts`; create `src/worker.test.ts`
  - **Interfaces:**
    - `export type TaskPayload = { kind: "id"; reportId: string; sectionId: string } | { kind: "name"; reportId: string; name: string }`
    - `export function parsePayload(raw: unknown): TaskPayload | undefined` — `sectionId` (string) wins over `section`; non-string fields reject
    - `handleGenerateSection(req: Request): Promise<Response>` — signature unchanged
  - **Call-site edits:** `src/app.ts` route unchanged; `src/worker.ts` imports `getSection`, `saveSection`, `saveSectionByName` from `./db`, `UpstreamError` from `./llm`, and `instrument`, `count` from `./metrics`
- **Acceptance criteria:** `bun test src/worker.test.ts` (mocks `./db` and `./llm` with `mock.module`; specs cover: id path saves by id with the row's name; unknown id → 200, zero model calls, `not_found`; already-generated → 200, zero model calls (idempotency key: section id); legacy name path → `payload_shape=name`; neither shape → 200, `invalid_input`; `UpstreamError("timeout")` → 500, `upstream_timeout`; handler timeout is the 90 s model timeout)

### Task 7: Producer and queue settings — emit the id, bound retries, rollback path

- **Skill:** `flow-system-design`
- **Bundled:** the queue retry settings, dispatch deadline and enqueue timeout from the Existing-code assessment (they bound the drain window the contract follow-up waits on)
- **Description:**
  - **Producer:** `enqueueSection` takes the section row and emits `{ reportId, sectionId, section: name }`; the name and report id stay for one release so a rolled-back worker can still run the task. Set `dispatchDeadline: "180s"` on the task, put a 10 s timeout on the enqueue call, and throw on a non-2xx response.
  - **Queue settings:** `deploy.sh` creates or updates the `sections` queue with `--max-attempts=5 --min-backoff=10s --max-backoff=300s`.
  - **Rollback step:** run `gcloud run services update-traffic reports-service --region us-central1 --to-revisions=<previous-revision>=100`. No down migration is needed because 002 is additive (to abandon the change entirely: `alter table sections drop column content;`).
  - **Rollback check:** `src/queue.test.ts` asserts the decoded body still carries `reportId` and `section` (what the previous worker reads), and Task 3's `src/db.test.ts` asserts `body` is still written.
- **Inputs:** Task 6 worker (consumer of the new shape), `deploy.sh`
- **Outputs:** updated `src/queue.ts`, `deploy.sh`; new `src/queue.test.ts`
- **Contract:**
  - **Files:** edit `src/queue.ts`; edit `deploy.sh`; create `src/queue.test.ts`
  - **Interfaces:**
    - `export async function enqueueSection(reportId: string, section: { id: string; name: string }): Promise<void>`
    - task body: `{ task: { dispatchDeadline: "180s", httpRequest: { url, body: btoa(JSON.stringify({ reportId, sectionId: section.id, section: section.name })) } } }`
    - enqueue `fetch` adds `signal: AbortSignal.timeout(10_000)` and throws on `!res.ok`
    - `deploy.sh` line 3: `gcloud tasks queues create sections --location us-central1 || true` → `if gcloud tasks queues describe sections --location us-central1 >/dev/null 2>&1; then verb=update; else verb=create; fi; gcloud tasks queues "$verb" sections --location us-central1 --max-attempts=5 --min-backoff=10s --max-backoff=300s`
  - **Call-site edits:** none in-repo (`enqueueSection` has no caller; see the producer Open Question)
- **Acceptance criteria:** `bun test src/queue.test.ts && bash -n deploy.sh && grep -q -- '--max-attempts=5' deploy.sh` (queue.test.ts asserts `dispatchDeadline` is `"180s"` and the decoded body has `reportId`, `sectionId` and `section`)

| Task | Depends on |
| ---- | ---------- |
| 1 | — |
| 2 | — |
| 3 | 1 |
| 4 | — |
| 5 | — |
| 6 | 3, 4, 5 |
| 7 | 6 |

### Skills Summary

| Skill | Recommended? | Reason |
| ----- | ------------ | ------ |
| `flow-system-design` | Yes (Tasks 1, 2, 4, 6, 7) | Schema expand step, recovery check, timeouts, idempotent consumer, queue settings, rollback |
| `flow-testing` | Yes (Task 3) | Postgres-backed persistence tests gated on `DATABASE_URL` |
| `flow-metrics` | Yes (Task 5) | First metrics contract and helper in the repo |
| `flow-refactoring` | No | The worker cleanup changes behaviour (validation before the paid call), so it is not a pure refactor |
| `flow-ui-ux` | No | No UI surface |

# PR description draft

## TLDR

Generation tasks used to find their section by a non-unique display name; they now point at it by id, and section text moves to its new column without breaking reads, queued tasks or rollback.

## User-facing changes

- Report readers see no change: sections come back with the same field and text, including during the deploy.
- Deploying now has one extra step first:
  - **Before:** you ran the deploy script.
  - **After:** you take a database backup, apply the new migration, then run the deploy script.
- A section whose model call fails is now retried, then abandoned, instead of being silently saved empty:
  - **Before:** a failed model call saved no text and the task counted as done.
  - **After:** the task retries up to 5 times and then stops, and the failure is counted by type.

## System changes

- Generation tasks now name their section by id, and redelivered tasks are free:
  - **Before:** tasks carried the section name; the worker called the model, then updated every row matching that name.
  - **After:** tasks carry the section id (plus the name for one release); the worker checks the row first and skips the paid call when the section is gone or already written.
- Paid retries are now bounded: at most 5 attempts per section, a 3-minute limit per attempt, and a 90-second limit on each model call, where Google's open-ended defaults applied before. This lowers worst-case model spend per section.
- Both the old `body` column and the new `content` column are written for now; the follow-up drops `body` once no old-style tasks remain.

## Why

Section text is stored under a name the team wants to retire, and queued generation tasks find their section by display name, which is neither unique nor stable, so a task can write to the wrong section or to several at once. A careless switch would break report pages mid-deploy and waste paid model calls on tasks already waiting in the queue.

## Key decisions

- **Expand now, contract later.** This PR adds the new column, writes both, and accepts both task shapes. It beat a one-step rename, which breaks reads during the rollout and strands queued tasks, and a maintenance-window rename, which takes the report page down and still needs a reverse migration to roll back. Dropping the old column and the name field is a tracked follow-up.
- **The report response field keeps its current name.** The request named only the column and the task; renaming the field would break existing readers and is a separate candidate.
- **Order is migrate, then deploy.** The new code writes the new column, and nothing applies migrations automatically.
- **Rollback is a traffic shift to the previous revision.** That works because the old column is still written and tasks still carry the name.
- Bundled: the model call's missing timeout and status check.
- Bundled: validating the section before the paid call, and skipping already-generated sections on redelivery.
- Bundled: the queue retry settings, per-task deadline and enqueue timeout, which bound the drain window the follow-up waits on.

## Instrumentation

This PR creates the repo's first metrics contract. It adds section-task duration, failures by type, and a task-shape counter (the drain signal the follow-up waits on), and it uses the queue's built-in depth metric. Panels and the "report section generation" SLO are spec-only: no dashboard URL exists, and graphs need a metrics backend choice first (Google Cloud Monitoring is suggested; status in the metrics contract's Backend section).

## Test Steps

<!-- flow:authoring-rubric — for each checkbox item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->

- [ ] Run `bun test src/llm.test.ts src/metrics.test.ts` — the model-timeout, status-check and metric-emission specs pass.
- [ ] Run `docker run -d --rm --name reports-pg -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:16` — a local Postgres container starts.
- [ ] Run `DATABASE_URL=postgres://postgres:pg@localhost:5432/postgres bun test src/db.test.ts` — the backfill, dual-write and read-fallback specs run (not skipped) and pass.
- [ ] Run `bun test src/worker.test.ts` — the id-path, legacy name-path, unknown-section, already-generated and invalid-payload specs pass, and the unknown-section spec records zero model calls.
- [ ] Run `bun test src/queue.test.ts` — the enqueued body decodes to `reportId`, `sectionId` and `section`, with a `180s` dispatch deadline.
- [ ] Run `bash -n deploy.sh && grep -q -- '--max-attempts=5' deploy.sh` — the deploy script parses and sets the retry cap.
- [ ] Run `[ "$(gcloud sql instances describe "${CLOUD_SQL_INSTANCE:?}" --format='value(settings.backupConfiguration.pointInTimeRecoveryEnabled)')" = "True" ]` with production gcloud access — point-in-time recovery is on.
  - Set `CLOUD_SQL_INSTANCE` first: run `gcloud sql instances list` and export the instance name.
- [ ] DECISION: you accept that the old `body` column and the name field in queued tasks stay in place until the contract follow-up ships.
