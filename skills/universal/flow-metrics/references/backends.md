# Backend mapping

How `flow-metrics` names and records the same signals on Prometheus, Datadog and Cloudflare Workers Analytics Engine, how to detect which one a repo uses, and the adapter and test recipe the repo-local helper wraps. Two facts are marked medium confidence: verify them against the live page before relying on them.

## Mapping table

| OpenTelemetry concept                                              | Prometheus                                                                     | Datadog                                                                             | Workers Analytics Engine                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Duration histogram in seconds, e.g. `http.server.request.duration` | `http_server_request_duration_seconds` histogram (`_bucket`, `_sum`, `_count`) | a distribution metric (global percentiles)                                          | one data point per operation, duration in a double; percentiles computed in SQL |
| Failures counter split by `error_type`                             | `..._failures_total` counter with an `error_type` label                        | a count metric tagged `error_type`                                                  | one data point per failure, `error_type` in a blob                              |
| Attribute                                                          | label                                                                          | tag                                                                                 | blob (string) or double (number)                                                |
| Name translation                                                   | dots to underscores, unit suffix `_seconds`, counters gain `_total`            | dots kept, tags as `key:value`                                                      | the metric name goes in a blob or the dataset name; no registry                 |
| Cost driver                                                        | series per unique label combination; histograms multiply by bucket count       | one custom metric per unique name plus tag-value combination                        | data points written and sampling, not series                                    |
| Percentiles                                                        | `histogram_quantile` over `_bucket`                                            | built in on distributions (extra billed series per combination, see the note below) | `quantileWeighted` over the double with `_sample_interval`                      |

Sources: https://prometheus.io/docs/practices/naming/ (units, `_total`, label cardinality); https://docs.datadoghq.com/account_management/billing/custom_metrics/ (custom metric counting); https://developers.cloudflare.com/analytics/analytics-engine/platform/limits/ (limits).

Prefer Prometheus histograms over summaries: histogram buckets aggregate across instances and summary quantiles do not. Default OpenTelemetry-to-Prometheus translation renders `http.server.request.duration` as `http_server_request_duration_seconds`.

## Datadog

- A distribution gives global percentiles. Datadog bills one custom metric per unique name plus tag-value combination, so an unbounded tag multiplies the bill the same way an unbounded label multiplies Prometheus series.
- Percentile aggregations on a distribution add billed series per combination. The multiplier (five series per combination, more with percentiles) is medium confidence: verify against the live billing page.

## Cloudflare Workers Analytics Engine

- Limits: at most 20 blobs, 20 doubles and 1 index per data point, and at most 250 data points per Worker invocation. Counts are high confidence; individual blob and index byte sizes are medium confidence: verify against the live limits page.
- Sampling is equitable per index, so every query must weight by the sample interval: use `SUM(_sample_interval)` for counts, never `COUNT(*)`, and `quantileWeighted(0.95)(double1, _sample_interval)` for percentiles.
- There is no in-memory exporter. Quantiles are computed in SQL at query time, not at write time.

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

Auto-instrumentation signals (do not hand-write the metrics these emit): an OpenTelemetry SDK or Java agent in the start command or dependencies (https://opentelemetry.io/docs/zero-code/java/agent/), framework instrumentation packages (`@opentelemetry/instrumentation-*`), and `dd-trace` auto-init. They emit the HTTP-edge duration histogram with `error.type`; custom metrics go where they are blind: stages, outbound calls, jobs and domain failures behind a 200 response.

## Adapter shape

The helper owns one `Recorder` interface (`observe(name, seconds, attrs)`, `increment(name, attrs)`) and one adapter per backend. Handlers never touch an adapter.

| Backend                  | Adapter                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| none yet                 | in-memory recorder: arrays of observations and increments, zero dependencies                       |
| OpenTelemetry            | a `Meter` with a `Histogram` (explicit bucket boundaries) and a `Counter`                          |
| Prometheus               | a `prom-client` registry with a `Histogram` and a `Counter`, label names fixed at construction     |
| Datadog                  | `distribution(name, seconds, tags)` for durations and `increment(name, 1, tags)` for failures      |
| Workers Analytics Engine | `env.<DATASET>.writeDataPoint({ indexes: [op], blobs: [outcome, errorType], doubles: [seconds] })` |

## Test recipe

| Backend                  | How the emission test observes the write                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| none yet                 | assert on the in-memory recorder's arrays                                                              |
| OpenTelemetry            | an in-memory metric reader or exporter, then collect and assert on the data points                     |
| Prometheus               | inspect the registry (`registry.getMetricsAsJSON()`) and assert on the sample labels                   |
| Datadog                  | inject a spied client and assert on the call arguments                                                 |
| Workers Analytics Engine | no in-memory exporter exists: pass a spied dataset binding and assert on the `writeDataPoint` argument |
