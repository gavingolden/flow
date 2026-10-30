# Discovery instrumentation procedure (read for every plan that touches a runtime surface)

This reference holds the discovery procedure for the always-present `## Instrumentation` plan section: the trigger surface, the full form, the `none — <reason>` form, the required pre-reads, the task shape, and the omit-when-none PR-draft section. `discovery-instructions.md` step 5 names it at the gate site.

## Step 5 sub-sections

### Instrumentation

**Gate: the plan touches a runtime surface.** The trigger surface is a plan that adds or changes a request handler, a background job or queue consumer, an outbound API call, or a multi-stage pipeline. Decide the form from the plan's Task breakdown:

- **Fires (full form):** "add a `POST /shares` endpoint"; "add a nightly export job"; "call the billing API when an order completes"; "split the import into fetch, parse and write stages".
- **Does NOT fire (`none` form):** docs-only, copy-only, style-only, test-only, dependency-bump and behaviour-preserving refactor plans; a UI-only change with no new request or job.

The section is always present. A missing heading is ambiguous and a `none` is an explicit author affirmation, the same rule the PR description already uses.

**Required pre-reads (full form only).**

1. Read the repo's committed `.flow/metrics.md` as REQUIRED context when it exists. Reuse its `## Namespace`, its `## error_type values`, its `## Helper` path and its existing `## SLOs`; never redefine them.
2. Read the metrics skill at the path printed by `flow-module-status --skill-path flow-metrics` (and `--ref references/conventions.md` for the naming and cardinality rules). A non-zero exit is a named skip, never a guessed path, and never a `bin/lib` import: discovery runs in the consumer worktree.

**Full form.** Under `## Instrumentation`, write:

- A `**Contract:**` line naming `.flow/metrics.md` `create` or `extend`.
- `### Metrics` — a table `Metric | Instrument | Unit | Attributes (closed values) | Emitted at`, one row per metric. Follow with one line per operation: `Estimated series: <n> per operation` (the product of attribute-value counts, multiplied by the bucket count plus two for a histogram; the formula is in the skill's `references/conventions.md`).
- `### Error types` — the new `error_type` values with their meaning, or `reuses existing`.
- `### Dashboard panels` — the panels this change adds to `.flow/metrics.md` `## Dashboard panels`.
- `### SLO` — `rolls into <SLO name>`, or a new journey SLO with its SLI and target. A new SLO is only for a new user journey.
- An `**As-code:**` line naming the dashboard or alert file paths the change updates, or `spec-only — <why>`.

Default to the skill's shape: one duration histogram per operation split only by `outcome` plus a failures counter split by `error_type`, a per-stage histogram for multi-stage operations, outbound-call histograms per dependency. Do not plan a hand-written edge metric where auto-instrumentation already emits it.

**`none` form.** A single line `none — <reason>`, where the reason names why no trigger surface changes (for example `none — docs-only change` or `none — refactor-only, no behaviour change`). A bare `none` with no reason is a plan-lint miss, and so is a `none` whose tasks list runtime file paths (a route, server, worker, job, queue or cron file) without a refactor-only or no-behaviour-change reason.

**Task shape (full form only).** At least one task's `**Files:**` includes the repo-local metrics helper (or its creation) and `.flow/metrics.md`. Its description names the planned metrics and `error_type` values so the edit-set intent carries them to the implementer, and its acceptance criterion asserts emission (an emission test against the helper's in-memory recorder).

**PR draft section.** In `.flow-tmp/pr-description-draft.md`, add an omit-when-none `## Instrumentation` section between `## Key decisions` and `## Deviations from plan`: the metrics, panels and alert/SLO spec distilled from the plan section. With `backend: none yet`, only the PR that creates `.flow/metrics.md` carries the full note that graphs need a backend choice; later PRs carry one line pointing at `.flow/metrics.md` `## Backend`. Omit the heading entirely when the plan section is `none`.

**Forward pointer.** `/flow-new-feature` Step 5 reads the plan's `## Instrumentation` and, when it is not `none`, threads the metrics skill's paths into the implementer's `skill_docs`. `flow-plan-lint` names a missing section, a reason-less `none`, a table-less non-`none` section, and a `none` on runtime file paths; it is advisory, so the miss is named in the plan summary at approval.
