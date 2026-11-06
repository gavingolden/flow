# Rollout and rollback

Read this when a change alters a schema, a queue payload, a public API, or the behaviour of a paid or side-effecting path, or when the repo deploys straight to all traffic.

## Every deploy must be reversible

- A release is safe to roll back only if the previous version can still read everything the new version wrote. Schema changes follow expand and contract (`data.md`); never ship a write the old code cannot parse.
- Roll back by redeploying the previous artifact or shifting traffic back, not by writing a fix under pressure. Keep the previous revision deployable.
- Data migrations that rewrite rows run as their own idempotent, resumable job, separate from the deploy, so a code rollback does not need a data rollback.

## Queue payloads survive deploys

Tasks enqueued by version N are delivered to version N+1, and on rollback, tasks enqueued by N+1 reach N.

- Put a `version` field in every task payload. Consumers accept the current and previous versions.
- Add fields as optional; remove a field only after the queue has drained of payloads that carry it (longer than the queue's retention).
- Never rename a task type in place; add the new consumer, switch producers, then delete the old consumer.

## Gradual exposure

- Canary: send a small share of traffic to the new revision, compare its error rate and latency to the stable revision, then widen. Google SRE workbook: https://sre.google/workbook/canarying-releases/
- On Cloud Run, deploy with `--no-traffic`, then split traffic between revisions with tags; rollback is a traffic shift. https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration
- Feature flags separate deploy from release: ship the code dark, enable per tenant or percentage, and keep a kill switch on any new paid path. Remove release flags once fully on, or they rot. https://martinfowler.com/articles/feature-toggles.html

## Proportionality

A solo-owner app with no live users can deploy straight to 100% with a tested rollback command. Canary analysis needs enough traffic to compare; below that, use a flag and watch the error rate by hand.
