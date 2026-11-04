# Discovery runtime design procedure (read for every plan; the `none` form is cheap)

This reference holds the discovery procedure for the always-present `### Runtime design` subsection of `## Architecture Decisions`: the trigger surface, the full form, the `none — <reason>` form, the required pre-reads and the task shape. `discovery-instructions.md` step 5 names it at the gate site.

## Step 5 sub-sections

### Runtime design

**Gate: the plan touches a runtime surface.** The trigger surface is the same as Instrumentation's: a plan that adds or changes a request handler, a background job or queue consumer, an outbound API call, a scheduler, or a multi-stage pipeline. Decide the form from the plan's Task breakdown:

- **Fires (full form):** "add a `POST /reports` endpoint that calls the model API five times"; "refresh every saved report nightly"; "call the billing API when an order completes".
- **Does NOT fire (`none` form):** docs-only, copy-only, style-only, test-only, dependency-bump and behaviour-preserving refactor plans; a UI-only change with no new request or job.

The subsection is always present. A missing heading is ambiguous and a `none` is an explicit author affirmation, the same rule `## Instrumentation` uses.

**Required pre-reads (full form only).**

1. Read the skill at the path printed by `flow-module-status --skill-path flow-system-design`. A non-zero exit is a named skip, never a guessed path, and never a `bin/lib` import: discovery runs in the consumer worktree.
2. Read `--ref references/<platform>.md` for the repo's platform when one exists (`gcp` today), and `--ref references/data.md` whenever the change persists state. Each is a separate `flow-module-status --skill-path flow-system-design --ref <path>` call; a non-zero exit is a named skip.
3. Reuse the repo's existing primitives (queue, retry helper, spend ledger, idempotency table) before introducing new ones.

**Full form.** Under `### Runtime design`, write:

- A table `Operation | Est. p99 | Execution model | Timeout / deadline | Retries | Idempotency key | Cost bound`, one row per operation. An inline row may compress to `inline — <p99>, timeout <n>`. A cell that reuses a repo primitive names its repo-relative path, or `new: <path>`.
- A `**Platform:**` line: `gcp | cloudflare | aws | other`.
- A `**Proportionality:**` line naming what was deliberately left out (no queue for a 50 ms call; no sharding pre-launch).

**`none` form.** A single line `none — <reason>`, where the reason names why no runtime surface changes (for example `none — docs-only change` or `none — refactor-only, no behaviour change`). A bare `none` with no reason is a plan-lint miss, and so is a `none` whose tasks list runtime file paths without a refactor-only or no-behaviour-change reason, or a `none` while `## Instrumentation` is not `none`.

**Task shape (full form only).** A task that adds a worker or queue consumer names its idempotency key and its timeout in its acceptance criterion. When a row reuses a primitive, the touching task lists that primitive's path under `**Inputs:**`, in addition to the path in the table cell.

**Forward pointer.** `flow-plan-lint` names a missing subsection, an empty body, a reason-less `none`, a table-less or Proportionality-less non-`none` body, and a `none` on runtime file paths; it is advisory, so the miss is named in the plan summary at approval. `/flow-new-feature` Step 5 reads the subsection and, when it is not `none`, threads the skill's paths into the implementer's `skill_docs`.
