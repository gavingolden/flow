## Runtime defaults

- Durable work (anything that must survive the response, or a loop of paid or rate-limited calls) is queue-driven, not run in the request.
- A scheduler tick only enqueues one task per unit; it never runs the units itself.
- Every outbound call has an explicit timeout.
- Queue consumers are idempotent under redelivery, keyed on business identity rather than a per-attempt random value.
- All paid-call spend goes through one cap or ledger at a single choke point.
