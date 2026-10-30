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

Make every runtime change ship with consistent, low-cardinality custom metrics plus a dashboard, alert and SLO spec, without the owner asking. The owner reads an app's health from graphs, so a handler or job with no latency, volume or failure numbers is invisible until a user complains, and metric names or error labels that differ between changes make the graphs refuse to line up. This skill fixes the vocabulary once per repo: OpenTelemetry names, one closed `error_type` list, a cardinality budget, and a per-backend translation.

# When to Use

- A plan or change adds or alters a request handler, a background job or queue consumer, an outbound API call, or a multi-stage pipeline.
- A request says "add metrics", "instrument this", "what should we measure", "add a dashboard", "set up alerts", or "define an SLO".
- `/flow-new-feature` lists this skill's paths in an edit-set entry's `skill_docs` because the plan's `## Instrumentation` section is not `none`.
- A review finding names unbounded metric labels, an `error_type` missing from `.flow/metrics.md`, or a runtime change with no emission.

# When NOT to Use

- Logging and distributed tracing — out of scope; this skill covers metrics, dashboards, alerts and SLOs only.
- Writing the tests themselves beyond the emission recipe — defer to `flow-testing`.
- Hand-writing HTTP-edge request metrics that auto-instrumentation already emits (see Instructions step 3).
- Docs-only, style-only or behaviour-preserving refactor changes: the plan carries a `none — <reason>` line and nothing is instrumented.
- Bootstrapping a metrics backend or a Grafana stack. With no backend, record `none yet` and stop there.

# Context

Load the relevant reference on demand — do not read all of them up front:

- `.flow/metrics.md` in the target repo — the repo's committed metrics contract. Read it as REQUIRED context when it exists; it is authoritative over the starter values in the references.
- [Conventions](references/conventions.md) — OpenTelemetry naming, instruments, the closed `error_type` rule, the cardinality budget, per-stage timing, the emission-test recipe.
- [Backends](references/backends.md) — the OpenTelemetry to Prometheus to Datadog to Workers Analytics Engine mapping, detection signals, the helper's per-backend adapter shape and test recipe.
- [Dashboards, alerts and SLOs](references/dashboards-alerts-slos.md) — the panel spec, SLI/SLO spec, burn-rate alert tiers, and the as-code rule.

# Instructions

## 1. Read the repo's contract

Read `.flow/metrics.md` when it exists. When it does not, detect the backend, any dashboard or alert config, and any auto-instrumentation using the detection signals in `references/backends.md`. Absent is a legitimate state: the first instrumented change creates the file.

## 2. Create or reuse the repo-local metrics helper

On the first instrumented change, create one repo-local metrics helper — for example `instrument(op, fn)` and `recordStage(op, stage, fn)` — with a closed `ErrorType` union that mirrors `.flow/metrics.md` (`_OTHER` included) behind a swappable recorder. The backend adapter lives only there; with no backend it is a zero-dependency in-memory recorder. Later changes call the helper and never touch a backend client directly, so an unlisted `error_type` fails the repo's own typecheck. Record its path under `## Helper` in `.flow/metrics.md`.

## 3. Choose what to measure

For each trigger surface in the change, record:

- One duration histogram per operation, in seconds, split only by `outcome` (`ok` | `error`).
- One failures counter per operation, split by `error_type`.
- A per-stage histogram with a closed `stage` attribute for multi-stage operations.
- One outbound-call histogram per dependency.

Never duplicate a metric that auto-instrumentation already emits. Put custom metrics where it is blind: stages, outbound calls, jobs, and domain failures behind a successful response.

## 4. Map every failure to the closed `error_type` list

Map each failure to a value from the repo's closed `error_type` list at one choke point (the helper), with `_OTHER` as the fallback. Never use raw messages, IDs or raw URL paths as a label value. When a genuinely new failure class appears, extend the list in `.flow/metrics.md` and the helper's union in the same change; never redefine an existing value.

## 5. Apply the cardinality budget

State the estimated series total per operation (the formula is in `references/conventions.md`) and justify anything over 100. Route templates, never raw paths.

## 6. Translate names per backend

Translate the OpenTelemetry names for the repo's backend using `references/backends.md`. Do not change the semantics: unit in seconds, outcome-split histogram, error_type on the failures counter only.

## 7. Spec the dashboard, alert and SLO

Extend the panel spec and name the SLO each operation rolls into using `references/dashboards-alerts-slos.md`. Add a new SLO only for a new user journey. Write dashboard or alert config as code only where the repo already keeps it; otherwise the spec lives in `.flow/metrics.md`.

## 8. Add emission tests

Against the helper's in-memory recorder, add one success test, one failure test per new `error_type` branch, and a test that stage timings are recorded. Use the per-backend recipe in `references/backends.md` when the backend has no in-memory exporter.

## 9. Create or extend `.flow/metrics.md`

Create the file on the first instrumented change and extend it afterwards. Its shape:

- `## Backend` — library and exporter, or `none yet — suggested: <x>`. With no backend, name the stack's natural default: Workers Analytics Engine on Cloudflare, the OpenTelemetry SDK elsewhere.
- `## Namespace` — the metric name prefix.
- `## error_type values` — table: value | meaning | example cause.
- `## Helper` — path of the repo-local metrics helper.
- `## Dashboard panels` — the repo's one accumulating panel table.
- `## Alerts` — burn-rate tiers, defined once.
- `## As-code` — paths of dashboard or alert files the repo keeps, or `spec-only`.
- `## SLOs` — few, journey-based.
- `## Coverage` — the operations instrumented so far, extended by each change, so a quiet graph is never mistaken for an unmeasured path.

Every table keeps one row per value, sorted by its first column, so parallel changes append without merge conflicts. Never put secrets in the file.

With `backend: none yet`, only the PR that creates `.flow/metrics.md` carries the full note that graphs need a backend choice; later PRs carry one line saying these metrics are recorded but won't show on any graph until a metrics backend is chosen (status in `.flow/metrics.md` `## Backend`).

# Anti-Patterns

- A raw error message, exception text, user or request ID, or raw URL path used as a label value — it multiplies series without bound and the monitoring bill with it.
- A second error list in a plan or a handler instead of extending `.flow/metrics.md`.
- Recording a metric straight against a backend client in a handler instead of through the repo's helper.
- `error_type` on the duration histogram: it multiplies every error value by the bucket count. Use the `outcome` split plus the failures counter.
- Separate success and failure counters with no histogram: latency percentiles are lost.
- Durations recorded in milliseconds under a seconds unit.
- Averaging percentiles on a dashboard instead of reading them from histograms.
- A new SLO per change instead of rolling into an existing journey SLO.

# Verification

- `.flow/metrics.md` exists and lists every operation the change instruments under `## Coverage`.
- Every metric follows the naming and unit rules in `references/conventions.md`, and every attribute value comes from a closed set.
- Each new operation states its estimated series total.
- Emission tests cover one success, one failure per new `error_type` branch, and stage timings.
- Dashboard config was touched only where the repo already keeps it; the panels and SLO are named either way.
- No metric duplicates what auto-instrumentation already emits.

# Constraints

- NEVER emit a raw message, ID or raw URL path as a metric label.
- NEVER bootstrap a metrics backend, a Prometheus or Grafana stack, or generate dashboard or alert files in a repo that does not already keep them.
- NEVER add a merge-blocking metrics gate; this skill guides and the review lens flags, nothing fails a commit.
- NEVER import from flow's `bin/lib` when running in a consumer worktree; resolve skill paths with `flow-module-status --skill-path flow-metrics`.
- Stay vendor-neutral in the instructions: backend specifics live in `references/backends.md` only.
