# Dashboards, alerts and SLOs

The panel spec, the SLI/SLO spec, the burn-rate alert tiers and the as-code rule for `flow-metrics`. The durable spec lives in `.flow/metrics.md`; a plan and a PR only show the delta.

## Dashboard panel spec

Record panels as rows of one table, `Panel | Question it answers | Metric | Aggregation | Unit | Threshold`, sorted by panel name, in `.flow/metrics.md` `## Dashboard panels`. Each operation gets this default set:

| Panel                    | Question it answers                       | Metric                                          | Aggregation                              | Unit       | Threshold                          |
| ------------------------ | ----------------------------------------- | ----------------------------------------------- | ---------------------------------------- | ---------- | ---------------------------------- |
| Request rate             | how much traffic does this operation get? | duration histogram count                        | rate per second                          | ops/s      | none                               |
| Success vs failure       | what share of calls fail?                 | duration histogram count by `operation.outcome` | rate per second                          | ops/s      | failure share per the SLO          |
| Failures by `error.type` | why do calls fail?                        | failures counter                                | rate per second, grouped by `error.type` | failures/s | none                               |
| Latency p50 / p95 / p99  | how long do calls take?                   | duration histogram                              | percentile computed from buckets         | seconds    | the latency SLO threshold          |
| Per-stage p95            | which stage is slow?                      | per-stage histogram                             | p95 grouped by `operation.stage`         | seconds    | none                               |
| Queue depth              | how much work is waiting?                 | queue depth gauge                               | max by `messaging.destination.name`      | messages   | none                               |
| Oldest-message age       | how long has the oldest message waited?   | oldest-message age gauge                        | max by `messaging.destination.name`      | seconds    | the async journey's latency target |
| In flight                | how many calls run right now?             | in-flight UpDownCounter                         | sum                                      | requests   | none                               |
| Pool utilisation         | how close is the pool to exhaustion?      | pool count by state, pool max                   | sum used / sum max (ratio in the query)  | ratio      | none                               |

Percentiles come from histogram buckets, never from averaging percentiles across instances or intervals. The per-stage panel applies to multi-stage operations only. Gauges are never read with a rate, and a non-additive gauge (a value read from a shared source) aggregates with `max`, not `sum`. A change adds only the rows its operations need and never duplicates a row that exists.

## SLI and SLO spec

- **Availability SLI:** the share of calls that do not fail, from the duration histogram's `operation.outcome` count. Exclude client-caused `error.type` values (the ones `.flow/metrics.md` marks as client-caused in its meaning column) from the failure count, because the service did not fail the caller.
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
| 1x        | 3d          | 6h           | notify |

Define the tiers once per SLO in `.flow/metrics.md` `## Alerts`. A plan or PR never restates them; it names the SLO it rolls into. A repo may drop the 1x tier.

Alerts only notify; no alert creates a ticket or issue. The two actions:

- `page`: urgent, interrupts someone now.
- `notify`: non-urgent, a message to a channel. A `notify` row carries a re-notify interval of at most once per 24 hours per alert, so a slow burn does not flood the channel.

## Saturation alerts

Record threshold rows under `.flow/metrics.md` `## Alerts` as `Signal | Condition | Sustained for | Action | Routes to | Dashboard`. Starter values; each repo's own are authoritative:

| Signal             | Condition                  | Action                                                      |
| ------------------ | -------------------------- | ----------------------------------------------------------- |
| Oldest-message age | above the journey's target | `page` only when it rolls into a journey SLO, else `notify` |
| Pool utilisation   | sustained high             | `notify`                                                    |
| Queue depth        | none                       | no alert: depth is a cause, not a symptom of user pain      |

Alert on symptoms users feel, not causes (https://sre.google/sre-book/monitoring-distributed-systems/).

## As-code rule

Write dashboards, alert rules or SLOs as code only when the repo already keeps them. Detect with these globs, relative to the repo root:

- Grafana dashboards: `**/grafana/**/*.json`, `**/dashboards/**/*.json`
- Prometheus rules: `**/*rules*.yml`, `**/prometheus/**/*.yml`, `**/alerts/**/*.yml`
- Datadog monitors or dashboards: `**/*.tf` with `datadog_monitor` or `datadog_dashboard`, `**/datadog/**/*.json`
- Google Cloud Monitoring: `**/*.tf` with `google_monitoring_dashboard` or `google_monitoring_alert_policy`
- SLO-as-code: `**/*slo*.yaml`, `**/*slo*.yml` (OpenSLO, https://github.com/OpenSLO/OpenSLO; whether v1 is still the current spec is unverified)

When any match, update those files in the same change and list their paths in `.flow/metrics.md` `## As-code`. When none match, the spec stays in `.flow/metrics.md` and `## As-code` reads `spec-only`. Do not generate importable dashboard JSON or alert rules for a repo that keeps none, and do not bootstrap a backend or a Grafana stack: a one-import dashboard is a follow-up once the repo picks a backend.

## Dashboards and links

- Record each dashboard in `.flow/metrics.md` `## Dashboards` as `name | URL | what it answers`. Prefer one overview dashboard that links to the rest.
- Links are static: the dashboard ID is fixed in its as-code definition, with no time-range parameters. Where a backend cannot fix the ID at creation, record the URL once after creation and never recreate the dashboard.
- Links stay behind login: never a public or anonymous share link. A dashboard URL exposes a project ID and a dashboard ID but no data, so a public repo decides whether its README links the overview dashboard or only `.flow/metrics.md`.
- Every alert definition carries its dashboard link.
- The change that records the first dashboard URL adds one short "Observability" line to the repo README linking the overview dashboard and `.flow/metrics.md`. With no dashboard yet, no README line.
