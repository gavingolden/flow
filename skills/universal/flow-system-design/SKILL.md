---
name: flow-system-design
description: >-
  Choose execution model, timeouts, retries, idempotency and cost caps for new
  runtime work. TRIGGER on "add a background job", "this takes minutes", "add a
  webhook", "schedule a refresh", "make this reliable", or a change adding a
  handler, job, queue consumer or outbound call. SKIP metrics/alerts
  (flow-metrics), client loading states (flow-ui-ux), Postgres mechanics
  (supabase-postgres-best-practices).
---

# Goal

Make every new piece of runtime work survive real traffic, retries and a bad day without the owner asking. A slow, paid or periodic operation built as "just run it in the handler" loses work on a deploy, double-charges on a retry and has no ceiling on spend, and nobody notices until the bill or the support queue says so. This skill fixes the questions once: who waits, how long it can take, what happens when it runs twice, what stops it from running away, and what the owner sees when it fails. It is equally a guard against over-building, so a fast call stays a plain function call.

# When to Use

- A plan or change adds a request handler, background job, queue consumer, scheduled task, webhook, or an outbound call to a paid or rate-limited service.
- A request says "add a background job", "this takes minutes", "add a webhook", "schedule a refresh", or "make this reliable".
- `/flow-new-feature` lists this skill's paths in an edit-set entry's `skill_docs` because the plan's `### Runtime design` is not `none`.
- A review finding names work continuing after the response, a missing timeout, unbounded retries, or an unguarded paid call.

# When NOT to Use

- Metrics, dashboards, alerts and SLOs — defer to `flow-metrics` (step 9 only points there).
- Client-side loading and progress states — defer to `flow-ui-ux`.
- Postgres mechanics (indexes, locking, pooling, queries) — defer to `supabase-postgres-best-practices` when installed; architecture-level data rules are in `references/data.md`.
- Docs-only, style-only or behaviour-preserving refactors: the plan carries `### Runtime design` = `none — <reason>` and nothing changes.
- Pre-launch scale work (sharding, multi-region, autoscaling tuning). Name it in the Proportionality pass and leave it out.

# Context

Read only what applies:

- [GCP mapping](references/gcp.md) — read on GCP repos: Cloud Run, Cloud Tasks, Pub/Sub, Scheduler, Jobs, budgets, with their ceilings.
- [Data patterns](references/data.md) — outbox, idempotency keys, claim/lease rows, enqueue-after-commit, expand/contract, retention, one spend ledger.

The principles below are the portable core; each cites its authority:

- Processes are disposable and must tolerate being stopped at any moment, so work that must not be lost cannot live only in memory ([12-factor disposability](https://12factor.net/disposability)).
- Every outbound call needs a timeout, and retries need capped exponential backoff with jitter ([AWS Builders' Library: timeouts, retries and backoff](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)).
- Retries are only safe when the operation is idempotent ([AWS: making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/); [Stripe on idempotency](https://stripe.com/blog/idempotency)).
- Retrying at several layers multiplies load and turns a blip into an outage ([SRE book: cascading failures](https://sre.google/sre-book/addressing-cascading-failures/)).
- Under overload, shed or cap work deliberately instead of queueing without bound ([SRE book: handling overload](https://sre.google/sre-book/handling-overload/)).
- Reliability is a design input, not a later hardening pass ([Google Cloud reliability pillar](https://docs.cloud.google.com/architecture/framework/reliability); [AWS reliability pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html)).
- Users lose the sense of an instant response past about 0.1 s, their flow of thought past about 1 s, and their attention past about 10 s, which is why the interactive budget defaults to 10 s ([NN/g: response times](https://www.nngroup.com/articles/response-times-3-important-limits/)).
- Build only what today's requirement needs ([Fowler: YAGNI](https://martinfowler.com/bliki/Yagni.html)).

# Instructions

## 1. Read the platform and reuse what exists

Find the repo's platform (deploy config, Dockerfile, wrangler or terraform files) and its existing primitives: a queue, a retry helper, a spend ledger, an idempotency table. Reuse them before adding a second one.

## 2. Classify each operation

For every operation the change adds, note: who waits for the result, an estimated p99, its side effects, its cost per call, and what triggers it (request, schedule, event).

## 3. Pick the execution model

The test is whether losing the work is acceptable, not whether it is async. Pick from this table:

| Situation                                                                                                                                                                        | Execution model                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Caller waits, p99 under the interactive budget (default 10 s), no paid or rate-limited call loop                                                                                 | inline, with a timeout on every outbound call                                                                                                  |
| Work whose loss is not acceptable and that outlives the request, runs over the budget, loops over paid or rate-limited calls with unbounded or variable cardinality, or fans out | durable queue + worker invoked synchronously under the queue's attempt deadline; respond 202 + a status resource                               |
| Caller waits on a bounded set of paid calls whose aggregate p99 is under the budget                                                                                              | inline, with a timeout and the repo's spend cap at the call site                                                                               |
| Model generation whose result is persisted, even when streamed to a watching user                                                                                                | queue; the client reads progress from the status resource                                                                                      |
| Best-effort post-response work whose loss is acceptable (telemetry beacon, cache warm)                                                                                           | the platform's bounded post-response hook (e.g. Cloudflare `waitUntil`) with an explicit timeout; never for generation or billing side effects |
| Periodic work                                                                                                                                                                    | the scheduler tick only enqueues one task per unit; it never runs the units itself                                                             |
| One unit exceeds the queue attempt ceiling                                                                                                                                       | batch job, or split into checkpointed steps                                                                                                    |
| Never                                                                                                                                                                            | work that must not be lost continuing after the response, in-memory queues, timers as job runners                                              |

## 4. Make repeats safe

Derive an idempotency key from business identity (not a random value minted per attempt). Dedupe at the consumer and record the key atomically with the side effect (`references/data.md`).

## 5. Bound every wait

Put a timeout on every outbound call. Deadlines shrink inward: the handler's deadline is smaller than the queue's, and each call's is smaller than the handler's.

## 6. Retry at one layer

Retry at exactly one layer, with capped exponential backoff, jitter and bounded attempts. Classify failures as permanent (stop, mark failed) or transient (retry).

## 7. Bound the cost

Enforce a cost bound at one choke point, reusing the repo's spend ledger when it has one. A per-call counter scattered across call sites does not add up to a cap.

## 8. Cap overload

Set concurrency limits, queue rate caps and, where the caller is anonymous, per-caller limits or load shedding, so a spike cannot become unbounded spend or a self-inflicted outage.

## 9. Observability

Defer to `flow-metrics` for metrics, dashboards and alerts. Here, only make sure each operation has a place to emit them.

## 10. Show failure

A failed unit lands in a visible failed state (a status field, a dead-letter destination) that an owner or user can see and re-drive. Never swallow it.

## 11. Proportionality pass

Name what was deliberately left out and why: no queue for a 50 ms call, no sharding or multi-region before launch, no dead-letter topic for a job nobody would replay. Write it on the plan's `**Proportionality:**` line.

## 12. Record the design in the plan

The plan's `### Runtime design` section (under `## Architecture Decisions`) carries one table:

| Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound |
| --------- | -------- | --------------- | ------------------ | ------- | --------------- | ---------- |

- An inline row may compress to `inline — <p99>, timeout <n>`.
- A cell that reuses a repo primitive names it in plain words, or `new`; the touching task lists its repo-relative path under `**Inputs:**` (`new: <path>` for a new one).
- A `**Platform:**` line (`gcp | cloudflare | aws | other`) and a `**Proportionality:**` line follow the table.
- A change with no runtime surface writes `none — <reason>` instead.

# Anti-Patterns

- Work that must not be lost continuing after the response returns (detached promise, timer, in-memory queue) on a platform that bills or freezes by request.
- A scheduler tick that does the work itself instead of enqueuing one task per unit.
- Piecemeal spend counters at each call site instead of one ledger and one choke point.
- Retries stacked at two layers (client, worker and queue each retrying).
- A queue, worker and status table for a 50 ms call.
- An idempotency key minted per attempt, which dedupes nothing.
- A worker or webhook endpoint that runs paid or side-effecting work without authenticating its caller.

# Verification

- Every operation in the change has a row (or an inline line) in `### Runtime design` with an execution model chosen by the table above.
- Every outbound call has a timeout; deadlines shrink inward.
- Retries live at one layer and are capped; the consumer dedupes on a business-identity key.
- Paid work is bounded at one choke point, and its failures reach a visible failed state.
- The Proportionality line names at least one thing deliberately left out, or says nothing was over-built.

# Constraints

- NEVER add a queue, worker or status resource to work that fits the inline row of the table.
- NEVER run periodic units inside the scheduler tick.
- NEVER let work that must not be lost continue after the response.
- NEVER import from flow's `bin/lib` when running in a consumer worktree; resolve skill paths with `flow-module-status --skill-path flow-system-design`.
- Stay vendor-neutral in the instructions: platform specifics live in `references/` only.
