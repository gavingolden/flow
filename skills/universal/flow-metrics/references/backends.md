# Backend mapping

How `flow-metrics` names and records the same signals on Prometheus, Datadog and Cloudflare Workers Analytics Engine, how to detect which one a repo uses, and the adapter and test recipe the repo-local helper wraps. Two facts are marked medium confidence: verify them against the live page before relying on them.

## Mapping table

| OpenTelemetry concept                                              | Prometheus                                                                     | Datadog                                                                             | Workers Analytics Engine                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duration histogram in seconds, e.g. `http.server.request.duration` | `http_server_request_duration_seconds` histogram (`_bucket`, `_sum`, `_count`) | a distribution metric (global percentiles)                                          | one data point per operation, duration in a double; percentiles computed in SQL                                                                                                                                                                                             |
| Failures counter keyed by `error.type`                             | `..._failures_total` counter with an `error_type` label                        | a count metric tagged `error.type`                                                  | one data point per failure, `error.type` in a blob                                                                                                                                                                                                                          |
| Level (gauge)                                                      | `gauge` (no `_total`); `prom-client` `Gauge` with `set`/`inc`/`dec`            | `gauge`: last value per flush interval; one custom metric per tag combination       | no native gauge: write one sample data point per interval from a scheduled handler, the level in a double; read the peak with an unweighted `MAX(double1)` per time bucket and the average as `SUM(double1 * _sample_interval) / SUM(_sample_interval)` (medium confidence) |
| Delta (up-down counter)                                            | `gauge` moved with `inc`/`dec`                                                 | `gauge` holding the instance's running total                                        | no native up-down counter: sample the running total like a gauge                                                                                                                                                                                                            |
| Attribute                                                          | label; dots become underscores (`error.type` is the label `error_type`)        | tag; dots kept (`error.type:<value>`)                                               | blob (string) or double (number) by position; the key name lives only in the registry's slot column                                                                                                                                                                         |
| Name translation                                                   | dots to underscores, unit suffix `_seconds`, counters gain `_total`            | dots kept, tags as `key:value`                                                      | the metric name goes in a blob or the dataset name; no registry                                                                                                                                                                                                             |
| Cost driver                                                        | series per unique label combination; histograms multiply by bucket count       | one custom metric per unique name plus tag-value combination                        | data points written and sampling, not series                                                                                                                                                                                                                                |
| Percentiles                                                        | `histogram_quantile` over `_bucket`                                            | built in on distributions (extra billed series per combination, see the note below) | `quantileWeighted` over the double with `_sample_interval`                                                                                                                                                                                                                  |

Sources: https://prometheus.io/docs/practices/naming/ (units, `_total`, label cardinality); https://docs.datadoghq.com/account_management/billing/custom_metrics/ (custom metric counting); https://developers.cloudflare.com/analytics/analytics-engine/platform/limits/ (limits); https://opentelemetry.io/docs/specs/otel/compatibility/prometheus_and_openmetrics/ (dotted attribute names to labels); https://docs.datadoghq.com/getting_started/tagging/ (tag syntax).

Prefer Prometheus histograms over summaries: histogram buckets aggregate across instances and summary quantiles do not. The default (classic) OpenTelemetry-to-Prometheus translation renders `http.server.request.duration` as `http_server_request_duration_seconds` and replaces the dots in attribute keys with underscores; Prometheus 3 UTF-8 names can keep dots under some translation strategies, so never register two keys that differ only by `.` versus `_`.

## Datadog

- A distribution gives global percentiles. Datadog bills one custom metric per unique name plus tag-value combination, so an unbounded tag multiplies the bill the same way an unbounded label multiplies Prometheus series.
- Percentile aggregations on a distribution add billed series per combination. The multiplier (five series per combination, more with percentiles) is medium confidence: verify against the live billing page.

## Cloudflare Workers Analytics Engine

- Limits: at most 20 blobs, 20 doubles and 1 index per data point, and at most 250 data points per Worker invocation. Counts are high confidence; individual blob and index byte sizes are medium confidence: verify against the live limits page.
- Sampling is equitable per index, so every query must weight by the sample interval: use `SUM(_sample_interval)` for counts, never `COUNT(*)`, and `quantileWeighted(0.95)(double1, _sample_interval)` for percentiles.
- There is no in-memory exporter. Quantiles are computed in SQL at query time, not at write time.
- Slots: each key owns a fixed `blobN` or `doubleN` slot, recorded in the `slot` column of `.flow/metrics.md` `## Attributes`. New keys only append to the next free slot; never reorder or reuse one, because shifting positions breaks queries over stored data points.
- Tenant as the index: Cloudflare documents the index as the sampling key, with a customer ID as the example, and allows one per data point. A dataset indexed by tenant moves `op` into a blob. Decide the index when the dataset is created, never by re-slotting an existing one.
- Queue backlog and age come from Cloudflare Queues' own metrics. The custom-gauge fallback is one line: sample a level only from a Cron Trigger (`scheduled` handler), never from a queue consumer's batch callback, which goes silent exactly when the consumer stalls. Read the peak with an unweighted `MAX`, because a maximum cannot be weighted.

## Detection signals

Check the dependency manifest and config files in this order and stop at the first match; record the result in `.flow/metrics.md` `## Backend`.

| Backend                  | Signals                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| OpenTelemetry            | `@opentelemetry/api`, `@opentelemetry/sdk-metrics`, `opentelemetry-sdk`, `go.opentelemetry.io/otel` |
| Prometheus               | `prom-client`, `prometheus_client`, `github.com/prometheus/client_golang`, a `/metrics` route       |
| Datadog                  | `dd-trace`, `hot-shots`, `datadog-metrics`, `datadog` in Python requirements, a `statsd` client     |
| Workers Analytics Engine | an `analytics_engine_datasets` block in `wrangler.toml` or `wrangler.jsonc`                         |
| none yet                 | none of the above: record `none yet — suggested: <x>`                                               |

When no backend is found, the suggested default is Workers Analytics Engine on Cloudflare and the OpenTelemetry SDK elsewhere. Do not install or configure it.

Platform-native saturation signals are free of custom code: Cloudflare Queues analytics, OpenTelemetry `http.server.active_requests` and `db.client.connection.*`. Auto-instrumentation signals (do not hand-write the metrics these emit): an OpenTelemetry SDK or Java agent in the start command or dependencies (https://opentelemetry.io/docs/zero-code/java/agent/), framework instrumentation packages (`@opentelemetry/instrumentation-*`), and `dd-trace` auto-init. They emit the HTTP-edge duration histogram with `error.type`; custom metrics go where they are blind: stages, outbound calls, jobs and domain failures behind a 200 response.

## Adapter shape

The helper owns one `Recorder` interface (`observe(name, seconds, attrs)`, `increment(name, attrs)`) and one adapter per backend. Handlers never touch an adapter. When the repo first emits a custom gauge or up-down counter, the `Recorder` also gains `set(name, value, attrs)` and `add(name, delta, attrs)`; they are not starter boilerplate.

The helper binds the allowed keys per instrument, so a disallowed key fails the repo's typecheck: a request or job duration histogram takes `operation.outcome`; a per-stage histogram `operation.stage` and `operation.outcome`; an outbound-call histogram `server.address` and `operation.outcome`; a failures counter `error.type` (plus the same operation, stage or address key where the instruments table has one); each custom gauge or up-down counter its declared keys. Passing `error.type` to a histogram does not compile. An in-flight count is incremented and decremented inside the helper's `instrument(op, fn)` `try`/`finally`, never bare in a handler.

| Backend                  | Adapter                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| none yet                 | in-memory recorder: arrays of observations and increments, zero dependencies                                                                                         |
| OpenTelemetry            | a `Meter` with a `Histogram` (explicit bucket boundaries) and a `Counter`; `UpDownCounter.add(delta, attrs)` and synchronous `Gauge.record(value, attrs)` for levels |
| Prometheus               | a `prom-client` registry with a `Histogram` and a `Counter`, label names fixed at construction; `Gauge.set`/`inc`/`dec` for levels                                   |
| Datadog                  | `distribution(name, seconds, tags)` for durations, `increment(name, 1, tags)` for failures and `gauge(name, value, tags)` for levels                                 |
| Workers Analytics Engine | `env.<DATASET>.writeDataPoint({ indexes: [op], blobs: [outcome, errorType], doubles: [seconds] })`; a level goes in a double the same way                            |

## Test recipe

| Backend                  | How the emission test observes the write                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| none yet                 | assert on the in-memory recorder's arrays; for a gauge, the last `set` value                                                               |
| OpenTelemetry            | an in-memory metric reader or exporter, then collect and assert on the data points; for a gauge, the last recorded value                   |
| Prometheus               | inspect the registry (`registry.getMetricsAsJSON()`) and assert on the sample labels; for a gauge, the sample value                        |
| Datadog                  | inject a spied client and assert on the call arguments; for a gauge, the `gauge` call's value                                              |
| Workers Analytics Engine | no in-memory exporter exists: pass a spied dataset binding and assert on the `writeDataPoint` argument; for a level, the double holding it |
