# Data patterns

Architecture-level rules for the data side of runtime work. Postgres mechanics (`SKIP LOCKED`, upserts, pooling, indexes) belong to `supabase-postgres-best-practices` when it is installed; this file stands alone without it.

## Outbox

When a state change must also produce a message, write the change and an outbox row in one transaction, and let a relay publish the outbox rows afterwards. Publishing straight from the handler either loses the message (crash after commit) or sends a message for a change that rolled back. The relay is at-least-once, so consumers must be idempotent.

## Idempotency keys

- Derive the key from business identity (tenant + report + period), never a value minted per attempt.
- Store it in a table with a unique constraint, together with the response or result, and write both atomically with the side effect.
- On a repeat, return the stored result. If the same key arrives with changed parameters, return a validation error rather than silently reusing the old result (the approach in https://stripe.com/blog/idempotency).

## Claim and lease rows

To stop two workers running the same unit, claim it with a row carrying an owner and a lease expiry, set by a conditional write. A crashed worker's lease expires and another worker takes over. Keep the lease longer than the unit's timeout and renew it on long units.

## Enqueue after commit

Enqueue only after the transaction that makes the work visible has committed, or the worker can run before the row exists. Never hold a database transaction open across a network call: a slow remote turns into a pinned connection and then an outage. If the enqueue can fail after the commit, use the outbox.

## Expand and contract

Change a schema without downtime in three deployable steps: add the new shape alongside the old (expand), move readers and writers over, then remove the old shape (contract). Never rename or drop a column in the same release that stops using it. Reference: https://martinfowler.com/bliki/ParallelChange.html

## Retention and TTL

Run, event, outbox and idempotency tables grow forever unless something prunes them. Give each a retention window and a scheduled delete; keep the idempotency window longer than the longest retry horizon.

## One spend ledger

Record every paid call against a single ledger keyed by the budget it counts toward (day, tenant, feature), and check the remaining budget at one choke point before the call. Counters scattered across call sites drift apart and cannot enforce a cap; reserve before the call and reconcile after.
