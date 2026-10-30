# Metric conventions

Naming, instruments, the closed `error_type` rule, the cardinality budget, per-stage timing and the emission-test recipe for `flow-metrics`. The repo's `.flow/metrics.md` is authoritative where it differs from the starter values here.

## Naming

Follow OpenTelemetry metric naming (https://opentelemetry.io/docs/specs/semconv/general/metrics/):

- Lowercase, dot-separated namespaces, `snake_case` within a component: `checkout.order.duration`, not `Checkout-Order-Duration`.
- The unit lives in metadata, not the name: no `_seconds` suffix at the OpenTelemetry layer. Backends that need it add it on translation (see `backends.md`).
- No `_total` on counters and no pluralised names: `checkout.order.failures`, not `checkout.orders_total`.
- Prefix every custom metric with the repo's namespace from `.flow/metrics.md` `## Namespace`.

## Instruments

| Question                                                | Instrument | Unit    | Split by                             |
| ------------------------------------------------------- | ---------- | ------- | ------------------------------------ |
| How long did an operation take?                         | Histogram  | seconds | `outcome` (`ok` \| `error`) only     |
| How often did an operation fail, and why?               | Counter    | none    | `error_type` only                    |
| How long did one stage of a multi-stage operation take? | Histogram  | seconds | `stage` (closed set), `outcome`      |
| How long did an outbound call to a dependency take?     | Histogram  | seconds | `dependency` (closed set), `outcome` |

Record durations in seconds as a float, never milliseconds under a seconds unit. For request-scale latency use the OpenTelemetry advisory bucket boundaries `[0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]` (14 bounds plus `+Inf`), and set explicit boundaries for anything that is not request-scale (jobs that run for minutes).

Volume and error rate come from the histogram count: do not add a separate "requests" counter. Percentiles come from the histogram, never from averaging percentiles.

Why `error_type` is not on the histogram: OpenTelemetry's HTTP convention puts `error.type` on the duration histogram (https://opentelemetry.io/docs/specs/semconv/general/recording-errors/). That multiplies every error value by the bucket count on backends that bill or store per series. Splitting the histogram by `outcome` and putting `error_type` on a separate failures counter keeps the same success counts, failure counts by type and latency percentiles at roughly a quarter of the series. This applies to custom metrics only; leave auto-instrumented edge metrics as emitted.

## The `error_type` rule

`error_type` follows OpenTelemetry's `error.type` attribute (https://opentelemetry.io/docs/specs/semconv/attributes-registry/error/): the class of error, low-cardinality, set only on failure.

- The list is closed and committed in `.flow/metrics.md` `## error_type values`. The repo-local helper encodes the same list as a typed union, so an unlisted value fails the repo's own typecheck.
- `_OTHER` is the fallback for a failure that fits no listed class. Map to it at the helper's choke point; never invent a value inline.
- Never use a raw error or exception message, a stack frame, a user, request or session ID, or a raw URL path as a value.
- Extend the list when a genuinely new failure class appears, in the same change that first emits it. Never rename or redefine an existing value.
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

## Cardinality budget

Estimated series for one operation = (product of attribute-value counts for each metric) summed over its metrics, where a histogram is also multiplied by its bucket count plus two (the `+Inf` bucket and the `_sum`/`_count` pair on Prometheus-style backends).

Worked example with 14 bucket bounds, `outcome` (2 values) and 11 `error_type` values:

- Duration histogram by `outcome`: 2 x (14 + 1 + 2) = 34 series.
- Failures counter by `error_type`: 11 series.
- Total: about 45 series per operation. Putting `error_type` on the histogram instead gives (2 + 11) x 17 = 221.

Rules of thumb:

- Prometheus guidance keeps most metrics below about 10 label combinations (https://prometheus.io/docs/practices/naming/); justify any metric over 100 series in the plan's Instrumentation section.
- Every attribute value comes from a closed set. A route is a template (`/orders/{id}`), never a raw path.
- State the estimated total as one `Estimated series: <n> per operation` line per operation.

## Per-stage timing

For an operation with several stages (fetch, transform, write), record one histogram per stage with a closed `stage` attribute, through the helper's `recordStage(op, stage, fn)`. Stage names are a closed list recorded alongside the operation under `## Coverage` in `.flow/metrics.md`. Do not time a stage that is already the whole operation.

## Emission tests

Test against the helper's in-memory recorder; the per-backend variants are in `backends.md`.

1. Success: call the instrumented operation once and assert one duration observation with `outcome=ok` and no failures increment.
2. Failure: for each new `error_type` branch, trigger that failure and assert one `outcome=error` observation plus one failures increment carrying exactly that `error_type`.
3. Stages: for a multi-stage operation, assert one observation per stage with the expected `stage` value.
4. Unlisted value: assert (in the type system or a test) that a value outside the closed list falls to `_OTHER`.
