---
name: product-planning
description: >-
  Plan and scope a feature into a PRD + ordered task breakdown before
  implementation. Use when the user is exploring WHAT to build or HOW
  to structure it (architecture, scope, what to build next, "am I
  missing anything"). Do NOT use when the task is already specific and
  actionable.
---

# Goal

Distill a user's feature idea into a structured PRD + ordered task breakdown +
PR-description draft, written to `.flow-tmp/plan.md` and
`.flow-tmp/pr-description-draft.md` for downstream consumers (`/new-feature`,
`/pr-review`, `/flow-pipeline`).

# When to Use

- User has a vague or high-level feature idea that needs scoping.
- User wants to plan a multi-step feature before implementation.
- User wants architecture recommendations before writing code.
- User asks "how should I approach this?" about a new capability.
- User describes something complex that spans multiple domain modules or skills.
- User evaluates a proposed change ("what do you think", "am I missing anything").

# When NOT to Use

- User is asking for a direct code change or bug fix (just do it).
- The task is already well-defined and implementation-ready (just do it).
- User is asking for a refactor or optimization (defer to `refactoring`).

# How it works

This skill is a thin wrapper around a one-shot **Independent Discovery
Subagent**. The wrapper itself does no discovery — it spawns one Task-tool
subagent (`subagent_type: general-purpose`), passes the user's verbatim
description plus the absolute paths to write, and waits for the subagent to
return a brief summary. The subagent does all the heavy lifting in its own
isolated context: reading the codebase, scanning the skill directory,
examining domain models, drafting the PRD, generating the task breakdown, and
writing both artifacts to disk.

The supervisor session that loads this skill (typically `/flow-pipeline` step
3, but also any direct caller) only ever sees:

1. The prose of this SKILL.md (the wrapper).
2. The Task-tool call's prompt and brief result envelope.
3. The one-paragraph summary the subagent returns.

It never sees the discovery transcript — the file reads, the codebase scans,
the PRD drafting prose. Those stay inside the subagent's context. This is the
single largest context-cost win for `/flow-pipeline` runs and applies to
manual users equally.

The trade-off is intentional: the supervisor cannot refer back to the
discovery exploration in later steps. The contract that absorbs the trade-off
is `.flow-tmp/plan.md` itself — that file is already the only handoff the
supervisor reads downstream, so losing the transcript costs nothing
practical.

## Independent Discovery Subagent

**Task-tool fan-out is intentional.** This step ("Independent Discovery
Subagent") spawns one discovery agent via the Task tool. When `/product-planning`
is loaded in-process by `/flow-pipeline` (the supervisor's step 3), this
fan-out is permitted by the named Task-tool exception in
`skills/pipeline/flow-pipeline/SKILL.md`'s "Hard rules" section (itself
anchored on this step's heading name, not its number, so it survives future
renumbering). Outside the supervisor context (e.g. invoked directly from a
user session), the Task tool is unrestricted, so the spawn runs identically.
Either path: one subagent, returns artifacts on disk + a brief summary.

**Optional web-grounded research pre-check (config-gated).** When `~/.flow/config.json` has `research.discovery: true` and `agy` is available, the discovery subagent may OPTIONALLY run a relevance-gated, web-grounded research pass before planning — see `references/discovery-instructions.md` "Step 1.5". That research is a **subagent-driven Bash fan-out** (the subagent drives `flow-delegate-fanout` directly via Bash — a spawned sub-agent has no `Skill` tool, so it cannot load `/flow-research` in-process; it follows that skill's procedure, which it reads), **NOT a Task spawn**. The single discovery Task call below and the nine-exemption invariant in `flow-pipeline/SKILL.md` are therefore unchanged — no new exemption is added.

# Spawn procedure

**Load the Task tool before spawning.** In Claude Code sessions where neither `Task` nor its alias `Agent` is surfaced top-level by the harness (both are aliases of the same one-shot subagent-spawn primitive: identical `subagent_type` / `prompt` / `description` schema), the spawn will silently fall through to in-line execution unless the schema is loaded first. Before the Task call below, run `ToolSearch query="select:Task"` and confirm the response contains either a `<function>{"name": "Task", ...}</function>` or a `<function>{"name": "Agent", ...}</function>` line. If it does not, **do not fall back to in-line execution** — escalate `NEEDS HUMAN: task-tool-unavailable: product-planning-discovery` and exit. The fan-out's value is its context isolation; an in-line fallback breaks the contract that this exemption is justified by.

1. Resolve the working directory absolutely. If the caller passed a `WORKTREE`
   value (typical when invoked from `/flow-pipeline`), use it. Otherwise use
   `pwd`. Then define the output paths **by `MODE`** — feature mode and epic
   mode emit different artifacts, so the spawn template and the post-spawn
   existence check (step 4) follow the same `MODE` branch:
   - Default (no `MODE`, or `MODE: feature`) — two `.flow-tmp/` artifacts:
     - `PLAN_PATH = <workdir>/.flow-tmp/plan.md`
     - `DRAFT_PATH = <workdir>/.flow-tmp/pr-description-draft.md`
   - `MODE: epic` — two epic artifacts under the caller-provided epic-output
     directory (`EPIC_DIR = <workdir>/.flow/epics/<slug>/`, resolved by the
     `MODE: epic` caller — F5's `flow epic create`, out of scope here):
     - `DESIGN_PATH = <EPIC_DIR>/design.md`
     - `MANIFEST_PATH = <EPIC_DIR>/manifest.json`
2. Resolve the skill base directory absolutely. The Skill tool prints the
   "Base directory for this skill" at the top of this SKILL.md when loaded
   — capture it as `SKILL_DIR`. Then derive `INSTRUCTIONS_PATH` by `MODE`:
   - Default (no `MODE`, or `MODE: feature`):
     `INSTRUCTIONS_PATH = <SKILL_DIR>/references/discovery-instructions.md`
   - `MODE: epic` (epic-grain decomposition — one node = one PR-sized
     feature, emitting `design.md` + `manifest.json` under
     `.flow/epics/<slug>/`):
     `INSTRUCTIONS_PATH = <SKILL_DIR>/references/epic-discovery-instructions.md`

   This is a file-path switch through the SAME single discovery spawn site —
   same machinery, same one Task call. It is not a new fan-out site or a new
   Task-tool exemption.

   The subagent reads sibling templates and references via absolute paths
   under `SKILL_DIR` (`templates/prd-template.md`,
   `references/architecture-patterns.md`, `references/discovery-playbook.md`,
   `references/example-prd.md`). Pass `SKILL_DIR` so the subagent never
   has to resolve those relative to its `cd`'d worktree, where they don't
   exist. Also create the consumer-side `.flow-tmp/` directory now so the
   subagent never has to:

   ```bash
   mkdir -p "$WORKTREE/.flow-tmp"
   ```

3. Make exactly **one** Task-tool call:

   ```
   subagent_type: general-purpose
   description:   Discovery for /product-planning
   prompt:        <the prompt template below, with variables filled in>
   ```

   **Per-phase model (planning) passthrough.** When the invocation carries a
   `MODEL_PLANNING: <alias>` marker line (threaded by `/flow-pipeline` step 3
   or `/epic-create` step 3 — resolution field `state.modelPlanning`,
   precedence `--model-planning > config.models.planning > inherited`, see
   `flow-pipeline/references/model-routing.md`), pass that alias as the Task
   call's per-spawn `model:` argument. Absent the marker, omit `model:` so the
   Discovery Subagent inherits the session model. This rides the existing
   single discovery Task call — **no** new fan-out site, **no** new exemption.

4. When the subagent returns, treat its 3–5 sentence summary as the
   chat output. Do **not** read `.flow-tmp/plan.md` from disk in the
   wrapper — the supervisor (or downstream caller) reads that file
   directly when it needs the full plan, and reading it twice in the
   same supervisor session erodes the context-cost win. The wrapper's
   only post-spawn job is a cheap existence check on the **mode's own**
   artifacts; on missing artifact, surface the failure to the caller per the
   Constraints below:
   - Default / `MODE: feature`: `test -s "$PLAN_PATH" && test -s "$DRAFT_PATH"`.
   - `MODE: epic`: `test -s "$DESIGN_PATH" && test -s "$MANIFEST_PATH"` — an
     epic-mode run emits `design.md` + `manifest.json`, **not** `plan.md` /
     `pr-description-draft.md`, so checking for the feature artifacts would
     spuriously fail every epic run.
5. Suggest the next handoff. If the caller is `/flow-pipeline`, the
   supervisor takes over (it knows what to do based on intent). Otherwise,
   suggest `/new-feature <verbatim user description>` for feature-level work,
   or invoking the per-task skill for fine-grained work.

## Spawn prompt template

Fill in the `{{...}}` placeholders before passing to the Task tool. The
`{{OUTPUT_PATHS}}` block is **mode-dependent** — substitute the feature-mode
text by default, the epic-mode text under `MODE: epic` (both shown after the
template). The `{{RESEARCH_OVERRIDE}}` and `{{REVISION_OVERRIDE}}` blocks are
both **omit-when-absent** (shown after the template). The other placeholders
(`{{INSTRUCTIONS_PATH}}`, `{{USER_DESCRIPTION}}`, `{{WORKTREE}}`,
`{{SKILL_DIR}}`) are mode-independent:

```
You are the Independent Discovery Subagent for `/product-planning`. You run
in an isolated context and return artifacts on disk plus a brief summary.

Read the full instructions at:
  {{INSTRUCTIONS_PATH}}

User feature description (verbatim):
  {{USER_DESCRIPTION}}
{{RESEARCH_OVERRIDE}}
{{REVISION_OVERRIDE}}
Working directory (cd here before reading any project files):
  {{WORKTREE}}

Skill base directory (resolve sibling templates and references against
this absolute path — they do not exist relative to {{WORKTREE}}):
  {{SKILL_DIR}}

{{OUTPUT_PATHS}}

Follow the {{INSTRUCTIONS_PATH}} steps in order (the feature-grain
discovery-instructions.md by default; under `MODE: epic` this resolves to
epic-discovery-instructions.md, whose epic-grain steps emit `design.md` +
`manifest.json` under `.flow/epics/<slug>/` and self-validate them). You are
one-shot — do not ask the user clarifying questions. When the user
description leaves something unspecified, make a defensible assumption based
on the codebase and project conventions, and surface every assumption you
made in the PRD's "Open Questions" section (or, under `MODE: epic`, the
`design.md` "Open Questions" section).

Return a one-paragraph summary (3–5 sentences) — the problem statement in
one line, the number of tasks, and the top one or two assumptions the user
should pay attention to. Do not paste the PRD or task list back; the
artifacts on disk are the record.
```

### `{{OUTPUT_PATHS}}` — feature mode (default / no `MODE` / `MODE: feature`)

Substitute this block verbatim for `{{OUTPUT_PATHS}}` on the default path —
the feature-grain contract is unchanged:

```
Write the consolidated plan to (absolute path):
  {{PLAN_PATH}}

Write the PR description draft to (absolute path):
  {{DRAFT_PATH}}
```

### `{{OUTPUT_PATHS}}` — epic mode (`MODE: epic`)

Substitute this block for `{{OUTPUT_PATHS}}` when the caller passed
`MODE: epic`. An epic-mode run emits the two epic artifacts under the
caller-provided epic-output directory and writes **no** `plan.md` /
`pr-description-draft.md`:

```
Write the six-section epic design (design.md) to (absolute path):
  {{DESIGN_PATH}}

Write the typed epic manifest (manifest.json) to (absolute path):
  {{MANIFEST_PATH}}
```

### `{{RESEARCH_OVERRIDE}}` — optional force-research passthrough

The supervisor reads global `~/.flow/config.json` for the
`research.discovery` opt-in, but the discovery subagent cannot read
`~/.flow/state/<slug>.json` — so the only way a `flow feature create --research`
force-on signal reaches it is through this prompt. When the caller passed
a `RESEARCH: force-on` marker (see `/flow-pipeline` step 3), substitute
this block verbatim for `{{RESEARCH_OVERRIDE}}`:

```
RESEARCH: force-on
  Discovery Step 1.5's web-grounded research pre-check is FORCED ON for this
  run — bypass the relevance gate and the research.discovery config opt-in
  (the agy-availability graceful no-op still applies). See discovery-instructions.md (a0).
```

When the caller passed **no** marker, substitute the **empty string** —
omit the block entirely (consistent with the mode-dependent blocks
above). This passthrough rides the existing single discovery Task call; it
adds **no** new Task-tool spawn and **no** new exemption.

### `{{REVISION_OVERRIDE}}` — optional revision-pass passthrough

On a `plan-pending-review` redirect, `/flow-pipeline` step 3 re-enters this
skill with an existing `.flow-tmp/plan.md` on disk and threads a `REVISION: <n>`
marker (see `/flow-pipeline` step 3 "Revision-pass threading"). The discovery
subagent cannot see the supervisor's state, so this block is the only way the
revision signal reaches it. When the caller passed a `REVISION: <n>` marker,
substitute this block verbatim for `{{REVISION_OVERRIDE}}`:

```
REVISION: <n>
  This is a REVISION pass on an existing plan.md, not a fresh draft. Run
  discovery-instructions.md "Revision pass mode": read the existing plan.md
  first, update in place, preserve untouched sections and the embedded
  `### Cross-model review (AGY)` subsection + `<!-- flow-plan-review-hash: <sha> -->`
  marker verbatim, do NOT re-run Step 1.5 research when findings already exist,
  and extend `## Open Questions` with the redirect's questions (marking prior
  ones resolved with a decision note).
```

When the caller passed **no** marker, substitute the **empty string** — omit
the block entirely (consistent with `{{RESEARCH_OVERRIDE}}` and the
mode-dependent blocks above). This passthrough rides the existing single
discovery Task call; it adds **no** new Task-tool spawn and **no** new exemption.

# Constraints

- NEVER do discovery in the wrapper's context — always spawn the subagent.
  The wrapper's job is to compose the prompt, make one Task-tool call, and
  forward the subagent's summary. Loading reference docs, reading the
  codebase, or drafting the PRD inline defeats the entire point of the
  refactor.
- NEVER make more than one Task-tool call per invocation. The single fan-out
  is the named exemption; multi-call fan-out is not authorised. If the
  artifact is missing after the spawn, surface the failure to the caller
  (e.g. `/flow-pipeline` retries by re-invoking `/product-planning`, which
  counts as a fresh invocation with its own one-shot Task call). The wrapper
  itself never retries — that would be a second Task call.
- NEVER read the mode's own artifacts from the wrapper (feature mode:
  `.flow-tmp/plan.md`; `MODE: epic`: `design.md` / `manifest.json`). Forward
  the subagent's summary, do an existence + non-empty check on both artifact
  paths, and return. The supervisor (or other caller) reads the full
  plan/design when it needs to; reading it here would duplicate that read in
  the same context.

# Verification

- Exactly one Task-tool call was made with `subagent_type: general-purpose`.
- **Feature mode (default):** `.flow-tmp/plan.md` exists at the resolved
  absolute path with the three expected sections (`# PRD`, `# Task breakdown`,
  `# PR description draft`), and `.flow-tmp/pr-description-draft.md` exists at
  the resolved absolute path.
- **Epic mode (`MODE: epic`):** `design.md` and `manifest.json` exist under
  the resolved epic-output directory (no `plan.md` / `pr-description-draft.md`
  is produced); the existence check targets those two files instead.
- The wrapper's chat output is the subagent's 3–5 sentence summary plus a
  next-handoff suggestion — never the full PRD and never the result of a
  fresh `Read` on `.flow-tmp/plan.md`.
- The supervisor session's transcript contains no file-read tool calls or
  PRD-drafting prose attributable to this skill — those stayed inside the
  subagent.
