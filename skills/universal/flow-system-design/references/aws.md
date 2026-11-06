# AWS mapping

Read this on repos deployed to AWS. It maps each principle in `../SKILL.md` to the AWS service that implements it and states the ceilings that change the design. Every ceiling cites its AWS doc and was retrieved on 2026-11-04; re-check a number before building something that sits close to it.

## API Gateway + Lambda (request path)

- REST API integrations time out at 29 seconds by default; the timeout can be raised for Regional and private APIs (possibly at the cost of a lower Region throttle quota) but not for edge-optimized APIs. Source: https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html
- A Lambda function times out at 3 seconds by default and at most 900 seconds (15 minutes). Source: https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html
- Neither limit is the interactive budget: a 29 second ceiling is where the request dies, not how long a user should wait.

## SQS + Lambda (durable queue)

- Visibility timeout defaults to 30 seconds, maximum 12 hours; set it above the consumer's own timeout so a message is not redelivered while still running. Retention defaults to 4 days, maximum 14 days. Messages are at most 1 MiB; put larger inputs in S3 and enqueue a reference. Source: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html
- Standard queues deliver at least once; consumers must dedupe on a business-identity key.
- FIFO queues deduplicate on `MessageDeduplicationId` only within a 5 minute window, so they do not replace consumer-side dedupe. Source: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/using-messagededuplicationid-property.html
- Attach a dead-letter queue with a bounded `maxReceiveCount` so a poison message reaches a visible failed state.
- Must-set settings: the visibility timeout and the dead-letter queue (with a bounded `maxReceiveCount`) belong in the task that creates the queue; flow-plan-lint checks the Task breakdown for them.
- Cap the consumer with Lambda reserved concurrency (or the event source mapping's maximum concurrency) on any path that calls a paid API.

## Lambda asynchronous invocation

- On a function error Lambda retries an async event twice more by default, and keeps throttled events for up to 6 hours; the same event can arrive more than once even without an error. Configure an on-failure destination or DLQ, or failed events are discarded. Source: https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html
- Prefer SQS in front of the function when you need explicit retry, rate and dead-letter control; do not stack Lambda's async retries on top of an SQS redrive.

## EventBridge Scheduler

- A schedule is a clock: its target enqueues one SQS message per unit (or starts one workflow) and returns.

## Step Functions

- Standard workflows run up to one year with exactly-once step execution, suited to non-idempotent steps; Express workflows run up to five minutes and are at-least-once (async) or at-most-once (sync). Source: https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html
- Use for multi-step work (`workflows.md`) with branches, waits or human approval.

## Secrets and spend

- Keep API keys in Secrets Manager or SSM Parameter Store, fetched at start; never in environment variables baked into the deployment package or in a message body.
- AWS Budgets track and alert, and can apply actions such as an IAM policy that denies provisioning, but billing data lags and costs can keep rising after a notification. An application-level spend ledger is still required. Source: https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html
