# Progress and real-time updates

Read this when a client needs to see progress of queued work, a streamed model response, or updates pushed by other users.

## Pick the lightest channel

| Need                                                             | Channel                                                                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Progress of a queued job, updates every few seconds are fine     | poll the status resource with backoff (start ~1 s, cap ~10 s); stop on a terminal status                                                                                        |
| Server-to-client stream (tokens of a model response, job events) | Server-Sent Events: one HTTP response, auto-reconnect, works through most proxies. https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events |
| Two-way, low-latency (collaboration, presence, chat)             | WebSockets: https://www.rfc-editor.org/rfc/rfc6455                                                                                                                              |
| Many subscribers to shared state                                 | a managed realtime service (Supabase Realtime, Firebase, Cloudflare Durable Objects) rather than hand-built fan-out                                                             |

## Rules

- The durable status row is the source of truth; the live channel is a convenience. A client that disconnects reconnects and reads the row, so nothing depends on holding a connection open.
- Streaming a model response to a watching user does not make the generation inline: the generation runs in the worker and writes chunks or progress to storage, and the stream reads from there. A closed tab must not cancel or lose paid work.
- Give every stream event an id so a reconnecting client resumes with `Last-Event-ID` instead of replaying from the start.
- Long-lived connections count against platform limits: Cloud Run caps a request (including a WebSocket or SSE stream) at the service's request timeout, at most 60 minutes, so clients must reconnect. https://docs.cloud.google.com/run/docs/triggering/websockets
- Authenticate the channel the same way as the status resource, and scope subscriptions to what the user may read.

## Proportionality

Polling a status endpoint is enough for jobs that take tens of seconds or more. Add SSE when users watch tokens arrive; add WebSockets only for genuinely two-way interaction.
