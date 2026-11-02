# Metric conventions

Naming, instruments, saturation signals, the closed `error.type` rule, the attribute registry, the cardinality budget, per-stage timing and the emission-test recipe for `flow-metrics`. The repo's `.flow/metrics.md` is authoritative where it differs from the starter values here.

## Naming

Follow OpenTelemetry metric naming (https://opentelemetry.io/docs/specs/semconv/general/metrics/):

- Lowercase, dot-separated namespaces, `snake_case` within a component: `checkout.order.duration`, not `Checkout-Order-Duration`.
- The unit lives in metadata, not the name: no `_seconds` suffix at the OpenTelemetry layer. Backends that need it add it on translation (see `backends.md`).
- No `_total` on counters and no pluralised names: `checkout.order.failures`, not `checkout.orders_total`.
- Prefix every custom metric with the repo's namespace from `.flow/metrics.md` `## Namespace`.

Attribute names follow the same discipline. Use the semantic-convention name when its definition matches yours (https://opentelemetry.io/blog/2025/how-to-name-your-span-attributes/). Otherwise write it lowercase, dot-namespaced and domain-first, and never under a namespace OpenTelemetry has registered such as `http.*` (https://opentelemetry.io/docs/specs/semconv/general/naming/). Add a company prefix only where a vendor clash is plausible. The default (classic) OpenTelemetry to Prometheus translation replaces dots with underscores (Prometheus 3 UTF-8 names can keep dots under some translation strategies), so never register two keys that differ only by `.` versus `_`.

## Instruments

| Question                                                | Instrument    | Unit           | Split by                                                                                                               |
| ------------------------------------------------------- | ------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| How long did an operation take?                         | Histogram     | seconds        | `operation.outcome` (`ok` \| `error`); an HTTP request histogram also `http.request.method`, `response.status_class`   |
| How often did an operation fail, and why?               | Counter       | none           | `error.type`; an HTTP or outbound failure also `response.status_class` or `server.address`                             |
| How long did one stage of a multi-stage operation take? | Histogram     | seconds        | `operation.stage` (closed set), `operation.outcome`                                                                    |
| How long did an outbound call to a dependency take?     | Histogram     | seconds        | `server.address` (closed host list), `operation.outcome`                                                               |
| How many messages are waiting in a queue?               | Gauge         | `{message}`    | `messaging.destination.name`                                                                                           |
| How old is the oldest waiting message?                  | Gauge         | seconds        | `messaging.destination.name`                                                                                           |
| How many requests or jobs are in flight?                | UpDownCounter | `{request}`    | the operation's closed key, or none                                                                                    |
| How much of a pool is in use?                           | UpDownCounter | `{connection}` | `db.client.connection.state` (`used` \| `idle`), pool name, plus a max (`worker_pool.*` names for a non-database pool) |

This table is the one source of truth for which keys each instrument takes: the registry's Metrics column, `backends.md` and the helper's types all follow it. Registry keys marked `any` (`cloud.region`, `subscription.tier`) may be added to any instrument and multiply its series. `error.type` is never a histogram key.

Record durations in seconds as a float, never milliseconds under a seconds unit. For request-scale latency use the OpenTelemetry advisory bucket boundaries `[0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]` (14 bounds plus `+Inf`), and set explicit boundaries for anything that is not request-scale (jobs that run for minutes).

Volume and error rate come from the histogram count: do not add a separate "requests" counter. Percentiles come from the histogram, never from averaging percentiles.

Why `error.type` is not on the histogram: OpenTelemetry's HTTP convention puts `error.type` on the duration histogram (https://opentelemetry.io/docs/specs/semconv/general/recording-errors/). That multiplies every error value by the bucket count on backends that bill or store per series. Splitting the histogram by `operation.outcome` and putting `error.type` on a separate failures counter keeps the same success counts, failure counts by type and latency percentiles at roughly a fifth of the series. A second deliberate deviation: HTTP status is recorded as `response.status_class` (`1xx`-`5xx`), not the full `http.response.status_code`, which would multiply series again. Both apply to custom metrics only; leave auto-instrumented edge metrics as emitted.

## Saturation and backlog signals

Latency and errors show a failure after users feel it; backlog and pool usage show it filling up before.

- Native first. Use the metrics the broker, platform or auto-instrumentation already emits: Cloudflare Queues backlog and lag, `http.server.active_requests`, `db.client.connection.*`, and the Google Cloud system metrics, which are free (Pub/Sub `subscription/num_undelivered_messages` and `subscription/oldest_unacked_message_age`, Cloud Tasks `queue/depth`, Cloud Run instance count; Pub/Sub's free status is medium confidence, per https://cloud.google.com/products/observability/pricing). Emit a custom signal only where those are blind.
- Additive versus non-additive. A value one instance owns (its in-flight count, its pool's connections) is an UpDownCounter, summed across instances. A value read from a shared source (a queue's depth) is a Gauge, read with `max` and emitted from one sampler, because summing it would count the same backlog once per reporter.
- Units are `{message}`, `{request}`, `{connection}`, `{worker}`, and seconds for age.
- Pool utilisation is a count by state plus a max. A database pool uses `db.client.connection.state` (`used` \| `idle`) and `db.client.connection.max`; a non-database worker pool uses its own `worker_pool.state` and `worker_pool.max` names and `{worker}` unit, never the database names. The ratio is computed in the query, because a ratio cannot be summed or averaged correctly across instances (https://opentelemetry.io/docs/specs/semconv/database/database-metrics/). Prefer an observable (callback) instrument that reads the live pool size at collection time.
- Oldest-message age is age in seconds on every backend, `0` when the queue is empty. One representation means one panel and one alert rule work everywhere.
- A scheduled or batch job gets a staleness signal: a gauge of the last successful run's Unix time, alerted when its age exceeds twice the schedule interval.
- An in-flight UpDownCounter from a killed instance keeps its last value until its series goes stale.
- Gauge cardinality = product of attribute-value counts, with no bucket multiplier, per reporting instance (see the cardinality budget). Example: pool count by `db.client.connection.state` (2 values) is 2 series, plus 1 for the max, 3 per instance and 18 across 6 instances.
- Never `rate()` a gauge: it is a level, not a cumulative count. Read it directly, with `max` or `avg_over_time`.

## Bounded-but-large dimensions

A dimension may be a metric attribute when its value set is fixed by code or product, not by data growth, even if it is large. Estimate it in the cardinality budget like any other key.

| Dimension          | Key                     | Verdict                                                                                                        |
| ------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| HTTP method        | `http.request.method`   | yes: the known set plus `_OTHER`, per OpenTelemetry                                                            |
| Status class       | `response.status_class` | yes: `1xx`-`5xx`                                                                                               |
| Region             | `cloud.region`          | deployment regions yes, client geography no                                                                    |
| Plan tier          | `subscription.tier`     | yes                                                                                                            |
| Tenant or customer | `tenant.id`             | no on series-billed backends and Google Cloud Monitoring; a Workers Analytics Engine index yes (`backends.md`) |

Per-entity drill-down (one user, one tenant, one request) belongs in traces, logs or exemplars, which are out of scope for this skill.

## The error.type rule

`error.type` is OpenTelemetry's attribute of the same name (https://opentelemetry.io/docs/specs/semconv/attributes-registry/error/): the class of error, low-cardinality, set only on failure.

- The list is closed and committed in `.flow/metrics.md` `## error.type values`. The repo-local helper encodes the same list as a typed union, so an unlisted value fails the repo's own typecheck.
- `_OTHER` is the fallback for a failure that fits no listed class. Map to it at the helper's choke point; never invent a value inline.
- Never use a raw error or exception message, a stack frame, a user, request or session ID, or a raw URL path as a value.
- Extend the list when a genuinely new failure class appears, in the same change that first emits it. Redefine or rename a value only in the same change that updates every dashboard query and alert reading it.
- Mark client-caused values (for example `invalid_input`, `unauthorized`) in the meaning column so the availability SLO can exclude them (see `dashboards-alerts-slos.md`).

Starter values for a repo with no list yet (each repo's own list is authoritative):

| Value              | Meaning                                                        |
| ------------------ | -------------------------------------------------------------- |
| `_OTHER`           | fallback: no listed class fits                                 |
| `internal`         | unexpected failure inside this service                         |
| `invalid_input`    | the caller sent a request this service rejects (client-caused) |
| `not_found`        | the requested resource does not exist (client-caused)          |
| `rate_limited`     | the caller or this service was throttled                       |
| `unauthorized`     | missing or invalid credentials (client-caused)                 |
| `upstream_error`   | a dependency answered with a failure                           |
| `upstream_timeout` | a dependency did not answer in time                            |

## Attribute registry

Every attribute key lives in `.flow/metrics.md` `## Attributes` with its closed values or the source they come from.

- Search the registry before adding a key and reuse a match. Never register a synonym.
- An existing name that breaks these conventions is renamed, and the same change updates every dashboard query and alert that reads it, because the series history splits at the rename.
- The helper mirrors the registry as one mapped type from each key to its closed value union, so an unregistered key or value fails the typecheck.
- An older `.flow/metrics.md` without the section gets it from the next instrumented change, seeded from the keys already in use and migrated to these conventions in the same change: renamed where needed, synonyms consolidated into one key.

Starter registry (each repo's own is authoritative):

| Key                              | Closed values or source                   | Metrics                                            | Meaning                                       |
| -------------------------------- | ----------------------------------------- | -------------------------------------------------- | --------------------------------------------- |
| `cloud.region`                   | the deployment regions                    | any                                                | where the instance runs                       |
| `db.client.connection.pool.name` | pool names from code                      | pool count, pool max                               | which database pool                           |
| `db.client.connection.state`     | `used`, `idle`                            | pool count                                         | pool connection state                         |
| `error.type`                     | `.flow/metrics.md` `## error.type values` | failures counter                                   | class of failure, set only on failure         |
| `http.request.method`            | known methods plus `_OTHER`               | HTTP request histogram                             | request method                                |
| `messaging.destination.name`     | queue names from code                     | queue depth, oldest-message age                    | which queue                                   |
| `operation.outcome`              | `ok`, `error`                             | every duration histogram                           | whether the operation succeeded               |
| `operation.stage`                | the stage list under `## Coverage`        | per-stage histogram                                | which stage of a multi-stage operation        |
| `response.status_class`          | `1xx`, `2xx`, `3xx`, `4xx`, `5xx`         | HTTP request histogram, HTTP failures counter      | HTTP status class, never the full status code |
| `server.address`                 | a host from a closed list                 | outbound-call histogram, outbound failures counter | the dependency being called                   |
| `subscription.tier`              | the plan tiers                            | any                                                | the caller's plan                             |
| `worker_pool.state`              | `busy`, `idle`                            | worker pool count                                  | worker state                                  |
| `worker_pool.name`               | non-database pool names from code         | worker pool count, worker pool max                 | which worker pool                             |

`tenant.id` is the per-entity key: never a label on a series-billed backend or on Google Cloud Monitoring, where each tenant adds an exported series and counts against the active-series quota; a Workers Analytics Engine index is the exception.

## Cardinality budget

Estimated series for one operation, per reporting instance (multiply by the instance count for the fleet-wide figure and state which one a justification uses) = (product of attribute-value counts for each metric) summed over its metrics, where a histogram is also multiplied by (boundary count + 3): one bucket per boundary, the `+Inf` bucket, and the `_sum`/`_count` pair on Prometheus-style backends. On a backend billed per sample (Google Cloud Monitoring), also state samples per month, with the formula in `backends.md`.

Worked example with 14 bucket bounds, `operation.outcome` (2 values) and 11 `error.type` values:

- Duration histogram by `operation.outcome`: 2 x (14 + 1 + 2) = 34 series.
- Failures counter by `error.type`: 11 series.
- Total: about 45 series per operation per instance. Extra keys multiply their instrument's series: an outbound failures counter also split by 5 `server.address` hosts is 55, not 11. Putting `error.type` on the histogram instead gives (1 success + 11 `error.type` values, since `error.type` is unset on success) x 17 = 204.

Rules of thumb:

- Prometheus guidance keeps most metrics below about 10 label combinations (https://prometheus.io/docs/practices/naming/); justify any metric over 100 series in the plan's Instrumentation section.
- Every attribute value comes from a closed set. A route is a template (`/orders/{id}`), never a raw path.
- State the estimated total as one `Estimated series: <n> per operation` line per operation.

## Per-stage timing

For an operation with several stages (fetch, transform, write), record one histogram per stage with a closed `operation.stage` attribute, through the helper's `recordStage(op, stage, fn)`. Stage names are a closed list recorded alongside the operation under `## Coverage` in `.flow/metrics.md`. Do not time a stage that is already the whole operation.

## Emission tests

Test against the helper's in-memory recorder; the per-backend variants are in `backends.md`.

1. Success: call the instrumented operation once and assert one duration observation with `operation.outcome=ok` and no failures increment.
2. Failure: for each new `error.type` branch, trigger that failure and assert one `operation.outcome=error` observation plus one failures increment carrying exactly that `error.type`.
3. Stages: for a multi-stage operation, assert one observation per stage with the expected `operation.stage` value.
4. Unlisted value: assert (in the type system or a test) that a value outside the closed list falls to `_OTHER`.
5. Gauges: drive a known level and assert the last recorded value.
6. In-flight: assert an in-flight UpDownCounter returns to zero on both the success and the failure path.
