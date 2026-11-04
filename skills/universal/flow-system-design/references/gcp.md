# Google Cloud mapping

Read this on repos deployed to Google Cloud. It maps each principle in `../SKILL.md` to the service that implements it and states the ceilings that change the design. Every ceiling cites its Google doc and was retrieved on 2026-11-03; re-check a number before building something that sits close to it.

## Cloud Run services

- Request-based billing allocates CPU only while a request is being processed, so work continuing after the response is throttled or frozen. This is why the SKILL.md table forbids post-response continuation. Source: https://docs.cloud.google.com/run/docs/configuring/billing-settings
- The request timeout defaults to 5 minutes and can be raised to at most 60 minutes. Source: https://docs.cloud.google.com/run/docs/configuring/request-timeout
- On shutdown the container receives SIGTERM and has a 10 second period before SIGKILL, so in-flight work must be resumable. Source: https://docs.cloud.google.com/run/docs/container-contract
- Set a maximum instance count and a per-instance concurrency on any service that calls a paid API: they are the overload cap in step 8.

## Cloud Tasks

- The default dispatch deadline for an HTTP target handler is 10 minutes, with a maximum of 30 minutes. Keep the worker's own timeout below it. Source: https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks
- A named task is deduplicated on its name, which is the natural place for the business-identity key. Deduplication is not instant: a name can stay reserved after the task finishes, so do not rely on it alone; also dedupe at the consumer. Source: https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks
- Queue retry config sets max attempts, min and max backoff, and max doublings; rate and concurrency caps (`maxDispatchesPerSecond`, `maxConcurrentDispatches`) throttle the worker. Retry here and nowhere else. Source: https://docs.cloud.google.com/tasks/docs/configuring-queues
- Give the HTTP target an OIDC token (`oidcToken.serviceAccountEmail`) and accept only that caller: deploy the worker as its own Cloud Run service with `--no-allow-unauthenticated` and grant the queue's service account `roles/run.invoker`, or verify the token's audience and email in the handler. A worker route on a public service lets anyone trigger paid work and skip the queue's rate and spend caps.
- A handler that responds 2xx within the deadline completes the task; any other response retries it. This is the "worker invoked synchronously under the attempt deadline" shape.

## Pub/Sub

- Use for fan-out events with several independent subscribers. For one worker doing one job per unit, Cloud Tasks gives more control (named dedupe, rate caps).
- A subscription's acknowledgment deadline is 10 seconds by default, with a maximum of 600 seconds. Source: https://docs.cloud.google.com/pubsub/docs/subscription-properties
- Use an authenticated push subscription (OIDC token from a service account) and accept only that caller on the worker endpoint; an open push endpoint lets anyone trigger paid work.
- Attach a dead-letter topic with a bounded delivery-attempt count so a poison message becomes a visible failed state. The maximum push-endpoint response time beyond that ack deadline is unverified; check the page above before relying on it.

## Cloud Scheduler

- A scheduler job is a clock, not a worker: its tick enqueues one Cloud Tasks task per unit (or publishes one event) and returns. Source: https://docs.cloud.google.com/scheduler/docs/schedule-run-cron-job
- Authenticate the target with OIDC (a service account), never a shared secret in the URL.

## Cloud Run Jobs

- Each task defaults to a 10 minute maximum; the maximum task timeout is 168 hours (7 days). Source: https://docs.cloud.google.com/run/docs/configuring/task-timeout
- Use for a single unit that exceeds the Cloud Tasks 30 minute ceiling, or for batch work. Tasks can be sharded across parallel containers; each shard still needs its own idempotency key and checkpoint.

## Secret Manager

- Keep API keys and signing secrets here and mount or fetch them at start; never bake them into the image or the task payload.

## Billing budgets

- An alerts-only budget does not cap usage or spending; it only notifies. Spend-cap budgets exist only for supported services. An application-level cap (the single spend ledger in `data.md`) is still required. Source: https://docs.cloud.google.com/billing/docs/how-to/budgets

## Monitoring

Defer to `flow-metrics`, which owns the Google Cloud Monitoring mapping. Platform-native backlog and oldest-task age for Cloud Tasks and Pub/Sub already exist; use them before adding custom gauges.
