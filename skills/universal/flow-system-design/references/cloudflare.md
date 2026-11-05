# Cloudflare mapping

Read this on repos deployed to Cloudflare Workers. It maps each principle in `../SKILL.md` to the Cloudflare primitive that implements it and states the ceilings that change the design. Every ceiling cites its Cloudflare doc and was retrieved on 2026-11-04; re-check a number before building something that sits close to it.

## Workers (HTTP)

- An HTTP-triggered Worker has no hard duration limit, but CPU time defaults to 30 seconds on the Paid plan and can be raised to 5 minutes. Source: https://developers.cloudflare.com/workers/platform/limits/
- `waitUntil()` extends execution for at most 30 seconds after the response is sent or the client disconnects. It is the bounded post-response hook in the SKILL.md table: fine for a telemetry beacon or cache write, never for generation or billing. Same source.
- Subrequests are capped per invocation (50 on Free, 10,000 by default on Paid), so a fan-out of paid calls belongs on a queue. Same source.

## Queues

- A consumer invocation has a 15 minute wall-clock limit and the same configurable CPU limit as a Worker; batches hold up to 100 messages. Source: https://developers.cloudflare.com/queues/platform/limits/
- Messages are at most 128 KB, so put large inputs in R2 or the database and enqueue a reference. Retention is configurable up to 14 days on Paid (fixed at 24 hours on Free). Same source.
- Delivery is retried, by default 3 times, after which the message goes to the dead letter queue if one is configured; without a DLQ it is deleted permanently. Always configure a DLQ for work that must not be lost. Source: https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
- Must-set setting: the dead-letter queue belongs in the task that creates the queue; flow-plan-lint checks the Task breakdown for it.
- Consumers must be idempotent: dedupe on a business-identity key in D1 or a Durable Object before the side effect.
- Retry here (consumer `max_retries`, `retryDelay`) and nowhere else.

## Cron Triggers

- A scheduled Worker has a 15 minute wall-time limit per invocation and runs on UTC. Source: https://developers.cloudflare.com/workers/platform/limits/ and https://developers.cloudflare.com/workers/configuration/cron-triggers/
- The tick enqueues one Queue message per unit and returns; it never runs the units itself.
- Changes to a cron schedule can take up to 15 minutes to propagate. Same cron source.

## Workflows

- For multi-step work (`workflows.md`), Cloudflare Workflows persist each step, retry it independently and can sleep for up to 365 days; a Paid workflow runs 10,000 steps by default (configurable to 25,000) with per-step CPU of 30 seconds by default (up to 5 minutes). Source: https://developers.cloudflare.com/workflows/reference/limits/

## State

- Durable Objects give single-threaded, strongly consistent state per key: the natural place for a per-tenant spend counter, a lease or a rate limiter.
- KV is eventually consistent; a write can take 60 seconds or more to be visible elsewhere. Never use KV for idempotency keys, leases or spend caps. Source: https://developers.cloudflare.com/kv/concepts/how-kv-works/
- D1 is the relational store for status rows, idempotency tables and the spend ledger.

## Secrets and spend

- Store API keys as Worker secrets (`wrangler secret put`), never in `wrangler.toml` vars or the queue payload.
- Cloudflare's own billing does not cap a third-party model bill; the application-level ledger in `data.md` is still required.
