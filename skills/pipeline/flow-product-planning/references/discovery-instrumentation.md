# Discovery instrumentation procedure (read for every plan that touches a runtime surface)

This reference holds the discovery procedure for the always-present `## Instrumentation` plan section: the trigger surface, the full form, the `none — <reason>` form, the required pre-reads, the task shape, and the omit-when-none PR-draft section. `discovery-instructions.md` step 5 names it at the gate site.

## Step 5 sub-sections

### Instrumentation

**Gate: the plan touches a runtime surface.** The trigger surface is a plan that adds or changes a request handler, a background job or queue consumer, an outbound API call, a multi-stage pipeline, or a connection or worker pool. Decide the form from the plan's Task breakdown:

- **Fires (full form):** "add a `POST /shares` endpoint"; "add a nightly export job"; "call the billing API when an order completes"; "split the import into fetch, parse and write stages".
- **Does NOT fire (`none` form):** docs-only, copy-only, style-only, test-only, dependency-bump and behaviour-preserving refactor plans; a UI-only change with no new request or job.

The section is always present. A missing heading is ambiguous and a `none` is an explicit author affirmation, the same rule the PR description already uses.

**Required pre-reads (full form only).**

1. Read the repo's committed `.flow/metrics.md` as REQUIRED context when it exists. Reuse its `## Namespace`, its `## Attributes`, its `## error.type values`, its `## Helper` path, its `## Dashboards` and its existing `## SLOs`; never redefine them.
2. Read the metrics skill at the path printed by `flow-module-status --skill-path flow-metrics` (and `--ref references/conventions.md` for the naming and cardinality rules). A non-zero exit is a named skip, never a guessed path, and never a `bin/lib` import: discovery runs in the consumer worktree.

**Full form.** Under `## Instrumentation`, write:

- A `**Contract:**` line naming `.flow/metrics.md` `create` or `extend`.
- `### Metrics` — a table `Metric | Instrument | Unit | Attributes (closed values) | Emitted at`, one row per metric; the Instrument column may name a Gauge or UpDownCounter, and a metric the platform already emits has `Emitted at: platform-native (<source>)`. Follow with one line per operation: `Estimated series: <n> per operation` (the product of attribute-value counts, multiplied by (boundary count + 3) for a histogram: one bucket per boundary, `+Inf`, and `_sum`/`_count`; a gauge or up-down counter is the product of attribute-value counts alone; the formula is in the skill's `references/conventions.md`).
- An `**Attributes:**` line: `reuses registered`, or the new keys with their closed values, which become `.flow/metrics.md` `## Attributes` rows.
- `### Error types` — the new `error.type` values with their meaning, or `reuses existing`.
- `### Dashboard panels` — the panels this change adds to `.flow/metrics.md` `## Dashboard panels`, each naming the dashboard it lands on.
- `### Alerts` — the saturation threshold rows this change adds to `.flow/metrics.md` `## Alerts`, or `burn-rate tiers only`.
- `### SLO` — `rolls into <SLO name>`, or a new journey SLO with its SLI and target. A new SLO is only for a new user journey.
- An `**As-code:**` line naming the dashboard or alert file paths the change updates, or `spec-only — <why>`.

Default to the skill's shape: one duration histogram per operation split only by `operation.outcome` plus a failures counter split by `error.type`, a per-stage histogram for multi-stage operations, outbound-call histograms per dependency, and saturation signals for queue consumers and pools (backlog and oldest-message age, in-flight count, pool usage), platform-native first. Do not plan a hand-written edge metric where auto-instrumentation already emits it.

**`none` form.** A single line `none — <reason>`, where the reason names why no trigger surface changes (for example `none — docs-only change` or `none — refactor-only, no behaviour change`). A bare `none` with no reason is a plan-lint miss, and so is a `none` whose tasks list runtime file paths (a route, server, worker, job, queue or cron file) without a refactor-only or no-behaviour-change reason.

**Task shape (full form only).** At least one task's `**Files:**` includes the repo-local metrics helper (or its creation) and `.flow/metrics.md`. Its description names the planned metrics and `error.type` values so the edit-set intent carries them to the implementer, and its acceptance criterion asserts emission (an emission test against the helper's in-memory recorder) for the metrics the application emits; a platform-native metric needs no emission test.

**PR draft section.** In `.flow-tmp/pr-description-draft.md`, add an omit-when-none `## Instrumentation` section between `## Key decisions` and `## Deviations from plan`: the metrics, panels and alert/SLO spec distilled from the plan section. It links the dashboard URL from `.flow/metrics.md` `## Dashboards` and names the panels the change adds, or says `spec-only` when no URL exists yet; never a per-panel URL, which most backends do not have. With `backend: none yet`, only the PR that creates `.flow/metrics.md` carries the full note that graphs need a backend choice; later PRs carry one line saying these metrics are recorded but won't show on any graph until a metrics backend is chosen (status in `.flow/metrics.md` `## Backend`). Omit the heading entirely when the plan section is `none`.

**Forward pointer.** `/flow-new-feature` Step 5 reads the plan's `## Instrumentation` and, when it is not `none`, threads the metrics skill's paths into the implementer's `skill_docs`. `flow-plan-lint` names a missing section, a reason-less `none`, a table-less non-`none` section, a non-`none` section with no `**Attributes:**` line, and a `none` on runtime file paths; it is advisory, so the miss is named in the plan summary at approval.
