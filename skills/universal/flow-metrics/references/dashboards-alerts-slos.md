# Dashboards, alerts and SLOs

The panel spec, the SLI/SLO spec, the burn-rate alert tiers and the as-code rule for `flow-metrics`. The durable spec lives in `.flow/metrics.md`; a plan and a PR only show the delta.

## Dashboard panel spec

Record panels as rows of one table, `Panel | Question it answers | Metric | Aggregation | Unit | Threshold`, sorted by panel name, in `.flow/metrics.md` `## Dashboard panels`. Each operation gets this default set:

| Panel                    | Question it answers                       | Metric                                | Aggregation                              | Unit       | Threshold                 |
| ------------------------ | ----------------------------------------- | ------------------------------------- | ---------------------------------------- | ---------- | ------------------------- |
| Request rate             | how much traffic does this operation get? | duration histogram count              | rate per second                          | ops/s      | none                      |
| Success vs failure       | what share of calls fail?                 | duration histogram count by `outcome` | rate per second                          | ops/s      | failure share per the SLO |
| Failures by `error_type` | why do calls fail?                        | failures counter                      | rate per second, grouped by `error_type` | failures/s | none                      |
| Latency p50 / p95 / p99  | how long do calls take?                   | duration histogram                    | percentile computed from buckets         | seconds    | the latency SLO threshold |
| Per-stage p95            | which stage is slow?                      | per-stage histogram                   | p95 grouped by `stage`                   | seconds    | none                      |

Percentiles come from histogram buckets, never from averaging percentiles across instances or intervals. The per-stage panel applies to multi-stage operations only. A change adds only the rows its operations need and never duplicates a row that exists.

## SLI and SLO spec

- **Availability SLI:** the share of calls that do not fail, from the duration histogram's `outcome` count. Exclude client-caused `error_type` values (the ones `.flow/metrics.md` marks as client-caused in its meaning column) from the failure count, because the service did not fail the caller.
- **Latency SLI:** the share of calls faster than a threshold, read from the histogram bucket at that threshold.
- **Window:** 30 days.
- **Few and journey-based:** an SLO belongs to a user journey (for example "view a shared dashboard"), not to a single operation or a single change. A change names the SLO it rolls into and adds a new one only for a new user journey (https://sre.google/workbook/implementing-slos/).

Record SLOs as rows of `.flow/metrics.md` `## SLOs`: journey, SLI, target, window.

## Alert spec

Use multi-window multi-burn-rate alerts for a 30-day SLO (https://sre.google/workbook/alerting-on-slos/). Both the long and the short window must exceed the burn rate before the alert fires, which keeps a recovered incident from paging.

| Burn rate | Long window | Short window | Action |
| --------- | ----------- | ------------ | ------ |
| 14.4x     | 1h          | 5m           | page   |
| 6x        | 6h          | 30m          | page   |
| 1x        | 3d          | 6h           | ticket |

Define the tiers once per SLO in `.flow/metrics.md` `## Alerts`. A plan or PR never restates them; it names the SLO it rolls into.

## As-code rule

Write dashboards, alert rules or SLOs as code only when the repo already keeps them. Detect with these globs, relative to the repo root:

- Grafana dashboards: `**/grafana/**/*.json`, `**/dashboards/**/*.json`
- Prometheus rules: `**/*rules*.yml`, `**/prometheus/**/*.yml`, `**/alerts/**/*.yml`
- Datadog monitors or dashboards: `**/*.tf` with `datadog_monitor` or `datadog_dashboard`, `**/datadog/**/*.json`
- SLO-as-code: `**/*slo*.yaml`, `**/*slo*.yml` (OpenSLO, https://github.com/OpenSLO/OpenSLO; whether v1 is still the current spec is unverified)

When any match, update those files in the same change and list their paths in `.flow/metrics.md` `## As-code`. When none match, the spec stays in `.flow/metrics.md` and `## As-code` reads `spec-only`. Do not generate importable dashboard JSON or alert rules for a repo that keeps none, and do not bootstrap a backend or a Grafana stack: a one-import dashboard is a follow-up once the repo picks a backend.
