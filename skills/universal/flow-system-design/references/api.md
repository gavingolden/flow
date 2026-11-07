# API contracts for runtime work

Read this when a change adds or alters an HTTP endpoint, especially one that starts slow, paid or side-effecting work, or a webhook receiver.

## Long-running requests

- Start the work and return `202 Accepted` with a `Location` header pointing at a status resource; the status resource returns the state and, when done, the result or a link to it. RFC 9110: https://www.rfc-editor.org/rfc/rfc9110#name-202-accepted
- The status resource is readable by the caller only, and survives restarts (it is a database row, not memory).

## Idempotent writes

- Accept an `Idempotency-Key` request header on any POST that charges, sends or creates something; store the key with the response and return the stored response on a repeat. IETF draft: https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/
- When the same key arrives with a different body, return an error instead of reusing the old result (`data.md`).
- Webhook receivers dedupe on the sender's event id, verify the signature before doing anything, and return 2xx quickly after enqueueing; the sender will retry anything slower.

## Errors

- Use one error shape across the API. Problem Details (RFC 9457) is a ready-made one: https://www.rfc-editor.org/rfc/rfc9457
- Distinguish retryable (`429`, `503`, with `Retry-After`) from permanent (`400`, `403`, `409`, `422`) so clients and queues retry only what can succeed.

## Inbound limits

- Rate-limit per caller (API key, user, IP for anonymous) on every endpoint that starts paid work; reply `429` with `Retry-After`. Status code: https://www.rfc-editor.org/rfc/rfc6585#section-4
- Cap request size and the cardinality of any list in the body (sections, recipients, ids).

## Lists and versions

- Paginate every list endpoint from day one with an opaque cursor (`page_token`) and a capped page size; offset pagination breaks under concurrent writes. Google AIP-158: https://google.aip.dev/158
- Add fields freely; never remove or change the meaning of a field in place. Breaking changes get a new version (path or header) and the old one keeps working until callers move. Google AIP-185: https://google.aip.dev/185
