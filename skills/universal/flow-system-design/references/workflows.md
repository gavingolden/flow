# Multi-step work

Read this when one request starts several dependent or parallel steps: a report with several generated sections, an import that parses, enriches and writes, or any job whose total runtime or cost is the sum of its parts.

## Shape

- Model the run as a parent row (status, inputs, created-by, totals) and one child row per step. The child row is the unit of retry, idempotency and progress.
- Enqueue one task per step, keyed on `<parent id>:<step name>`. A step that is retried re-runs only itself; finished steps are never re-run.
- Each step writes its output, then marks itself done in the same transaction. The parent's status is derived from its children (`queued`, `running`, `partial`, `failed`, `done`) and is what the client polls.
- The last step to finish (or a separate finalize task enqueued when the done-count reaches the total) assembles the result. Guard it with a conditional update so two finishers cannot both assemble.
- Cap fan-out per parent and per tenant; a 500-section request is a validation error, not 500 paid calls.

## Checkpointing a long single step

When one step outruns the queue's attempt ceiling, split it into resumable chunks: persist a cursor after each chunk and enqueue the next chunk as a new task. Never hold progress only in memory across chunks.

## Failure and undo

- A permanent failure in one step marks that child `failed` and the parent `partial` or `failed`; it does not silently drop the step.
- When earlier steps had external side effects (a charge, an email, a provisioned resource) and a later step fails, run compensating actions in reverse order. Each compensation must itself be idempotent. This is the saga pattern: https://learn.microsoft.com/en-us/azure/architecture/patterns/saga
- Decide per workflow whether a partial result is useful to the user (show the sections that succeeded) or must be all-or-nothing.

## When to use a workflow engine

A queue plus a parent/child table covers fan-out, fan-in and per-step retry. Reach for a managed workflow engine when the run has branches, waits on external events or humans, sleeps for hours or days, or needs a visual execution history:

- Google Cloud Workflows: https://docs.cloud.google.com/workflows/docs/overview
- AWS Step Functions; Standard workflows run up to one year with exactly-once step execution, Express up to five minutes at-least-once: https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html
- Cloudflare Workflows; durable steps with per-step retries and up to 365-day sleeps: https://developers.cloudflare.com/workflows/reference/limits/
- Temporal, for self-hosted or multi-cloud durable execution: https://docs.temporal.io/workflows

Do not add an engine for a fixed two-step pipeline that a queue already handles.
