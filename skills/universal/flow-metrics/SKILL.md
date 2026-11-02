---
name: flow-metrics
description: >-
  Add custom application metrics, dashboards, alerts and SLOs. TRIGGER on
  "add metrics", "instrument this", "add a dashboard", "set up alerts", "define
  an SLO", or a change that adds or alters a request handler, background job,
  outbound API call, or multi-stage pipeline. SKIP logging and tracing; writing
  the tests goes to flow-testing.
---

# Goal

Make every runtime change ship with consistent, low-cardinality custom metrics plus a dashboard, alert and SLO spec, without the owner asking. The owner reads an app's health from graphs, so a handler or job with no latency, volume or failure numbers is invisible until a user complains, and metric names or error labels that differ between changes make the graphs refuse to line up. This skill fixes the vocabulary once per repo: OpenTelemetry names, one closed `error.type` list, one attribute registry, a cardinality budget, and a per-backend translation.

# When to Use

- A plan or change adds or alters a request handler, a background job or queue consumer, an outbound API call, a multi-stage pipeline, or a connection or worker pool.
- A request says "add metrics", "instrument this", "what should we measure", "add a dashboard", "set up alerts", or "define an SLO".
- `/flow-new-feature` lists this skill's paths in an edit-set entry's `skill_docs` because the plan's `## Instrumentation` section is not `none`.
- A review finding names unbounded metric labels, an `error.type` missing from `.flow/metrics.md`, or a runtime change with no emission.

# When NOT to Use

- Logging and distributed tracing — out of scope; this skill covers metrics, dashboards, alerts and SLOs only.
- Writing the tests themselves beyond the emission recipe — defer to `flow-testing`.
- Hand-writing HTTP-edge request metrics that auto-instrumentation already emits (see Instructions step 3).
- Docs-only, style-only or behaviour-preserving refactor changes: the plan carries a `none — <reason>` line and nothing is instrumented.
- Bootstrapping a metrics backend or a Grafana stack. With no backend, record `none yet` and stop there.

# Context

Load the relevant reference on demand — do not read all of them up front:

- `.flow/metrics.md` in the target repo — the repo's committed metrics contract. Read it as REQUIRED context when it exists; it is authoritative over the starter values in the references.
- [Conventions](references/conventions.md) — OpenTelemetry naming, instruments, saturation and backlog signals, bounded-but-large dimensions, the closed `error.type` rule, the attribute registry, the cardinality budget, per-stage timing, the emission-test recipe.
- [Backends](references/backends.md) — the OpenTelemetry to Prometheus to Datadog to Workers Analytics Engine mapping (levels included), detection signals, the helper's per-backend adapter shape and test recipe.
- [Dashboards, alerts and SLOs](references/dashboards-alerts-slos.md) — the panel spec, SLI/SLO spec, burn-rate and saturation alerts, dashboard links, and the as-code rule.

# Instructions

## 1. Read the repo's contract

Read `.flow/metrics.md` when it exists. When it does not, detect the backend, any dashboard or alert config, and any auto-instrumentation using the detection signals in `references/backends.md`. Absent is a legitimate state: the first instrumented change creates the file.

## 2. Create or reuse the repo-local metrics helper

On the first instrumented change, create one repo-local metrics helper — for example `instrument(op, fn)` and `recordStage(op, stage, fn)` — with a closed `ErrorType` union that mirrors `.flow/metrics.md` (`_OTHER` included) behind a swappable recorder. Type the attributes as one map from each registered key to its closed value union, mirroring `.flow/metrics.md` `## Attributes`. Add level and delta recording when the repo first needs a custom gauge or up-down counter, and track an in-flight count inside `instrument(op, fn)`'s `try`/`finally`. The backend adapter lives only there; with no backend it is a zero-dependency in-memory recorder. Later changes call the helper and never touch a backend client directly, so an unlisted `error.type` or an unregistered attribute fails the repo's own typecheck. Record its path under `## Helper` in `.flow/metrics.md`.

## 3. Choose what to measure

For each trigger surface in the change, record:

- One duration histogram per operation, in seconds, split only by `operation.outcome` (`ok` | `error`).
- One failures counter per operation, split by `error.type`.
- A per-stage histogram with a closed `operation.stage` attribute for multi-stage operations.
- One outbound-call histogram per dependency, split by `server.address` and `operation.outcome`.
- Saturation signals for queue consumers, jobs and pools: backlog and oldest-message age, in-flight count, pool usage. Take the platform-native metric first and emit a custom one only where it is blind (`references/conventions.md`).

Never duplicate a metric that auto-instrumentation already emits. Put custom metrics where it is blind: stages, outbound calls, jobs, and domain failures behind a successful response.

## 4. Map every failure to the closed `error.type` list

Map each failure to a value from the repo's closed `error.type` list at one choke point (the helper), with `_OTHER` as the fallback. Never use raw messages, IDs or raw URL paths as a label value. When a genuinely new failure class appears, extend the list in `.flow/metrics.md` and the helper's union in the same change. Rename or redefine an existing value only in the same change that updates every dashboard query and alert reading it.

## 5. Apply the cardinality budget

State the estimated series total per operation (the formula is in `references/conventions.md`) and justify anything over 100. Route templates, never raw paths. A large dimension is allowed only when its value set is fixed by code or product (`references/conventions.md`, bounded-but-large dimensions).

## 6. Translate names per backend

Translate the OpenTelemetry names for the repo's backend using `references/backends.md`: read the mapping table and only the section for the repo's `## Backend`, so a repo on one backend does not load another's detail. Do not change the semantics: unit in seconds, `operation.outcome`-split histogram, `error.type` on the failures counter only.

## 7. Spec the dashboard, alert and SLO

Extend the panel spec and name the SLO each operation rolls into using `references/dashboards-alerts-slos.md`. Add a new SLO only for a new user journey. Write dashboard or alert config as code only where the repo already keeps it; otherwise the spec lives in `.flow/metrics.md`. Dashboard links are static and stay behind login, never public share links (`references/dashboards-alerts-slos.md`).

## 8. Add emission tests

Against the helper's in-memory recorder, add one success test, one failure test per new `error.type` branch, a test that stage timings are recorded, and a gauge or in-flight test where the change adds one. Use the per-backend recipe in `references/backends.md` when the backend has no in-memory exporter.

## 9. Create or extend `.flow/metrics.md`

Create the file on the first instrumented change and extend it afterwards. Its shape:

- `## Backend` — library and exporter, or `none yet — suggested: <x>`. With no backend, name the stack's natural default: Workers Analytics Engine on Cloudflare, the OpenTelemetry SDK elsewhere.
- `## Namespace` — the metric name prefix.
- `## Attributes` — table: key | closed values or source | metrics | meaning, plus a `slot` column on Workers Analytics Engine.
- `## error.type values` — table: value | meaning | example cause.
- `## Helper` — path of the repo-local metrics helper.
- `## Dashboard panels` — the repo's one accumulating panel table.
- `## Dashboards` — table: name | URL | what it answers.
- `## Alerts` — burn-rate tiers plus saturation threshold rows, defined once; each row carries a `page` or `notify` action, the channel it routes to and a dashboard link.
- `## As-code` — paths of dashboard or alert files the repo keeps, or `spec-only`.
- `## SLOs` — few, journey-based.
- `## Coverage` — the operations instrumented so far, extended by each change, so a quiet graph is never mistaken for an unmeasured path.

Every table keeps one row per value, sorted by its first column, so parallel changes append without merge conflicts. Never put secrets in the file.

The change that records the first dashboard URL also adds a one-line "Observability" entry to the repo README linking the overview dashboard and `.flow/metrics.md`.

With `backend: none yet`, only the PR that creates `.flow/metrics.md` carries the full note that graphs need a backend choice; later PRs carry one line saying these metrics are recorded but won't show on any graph until a metrics backend is chosen (status in `.flow/metrics.md` `## Backend`).

# Anti-Patterns

- A raw error message, exception text, user or request ID, or raw URL path used as a label value — it multiplies series without bound and the monitoring bill with it.
- A second error list in a plan or a handler instead of extending `.flow/metrics.md`.
- Recording a metric straight against a backend client in a handler instead of through the repo's helper.
- `error.type` on the duration histogram: it multiplies every error value by the bucket count. Use the `operation.outcome` split plus the failures counter.
- Separate success and failure counters with no histogram: latency percentiles are lost.
- Durations recorded in milliseconds under a seconds unit.
- Averaging percentiles on a dashboard instead of reading them from histograms.
- A new SLO per change instead of rolling into an existing journey SLO.
- A synonym of a registered attribute key instead of reusing it.
- A per-entity ID (tenant, user) as a label on a series-billed backend.
- A `rate()` over a gauge.
- A utilisation ratio emitted as a gauge; a ratio cannot be summed across instances.
- An alert that opens a ticket instead of paging or notifying.
- A public dashboard share link.

# Verification

- `.flow/metrics.md` exists and lists every operation the change instruments under `## Coverage`.
- Every metric follows the naming and unit rules in `references/conventions.md`, every attribute key is listed in `## Attributes`, and every attribute value comes from a closed set.
- Each new operation states its estimated series total.
- Saturation signals for each queue consumer or pool are specced, or named as platform-native.
- Every alert row names a channel and a dashboard link.
- Emission tests cover one success, one failure per new `error.type` branch, and stage timings.
- Dashboard config was touched only where the repo already keeps it; the panels and SLO are named either way.
- No metric duplicates what auto-instrumentation already emits.

# Constraints

- NEVER emit a raw message, ID or raw URL path as a metric label.
- NEVER bootstrap a metrics backend, a Prometheus or Grafana stack, or generate dashboard or alert files in a repo that does not already keep them.
- NEVER add a merge-blocking metrics gate; this skill guides and the review lens flags, nothing fails a commit.
- NEVER import from flow's `bin/lib` when running in a consumer worktree; resolve skill paths with `flow-module-status --skill-path flow-metrics`.
- Stay vendor-neutral in the instructions: backend specifics live in `references/backends.md` only.
