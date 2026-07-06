---
name: epic-create
description: >-
  Supervisor skill for the epic-designer phase. Drives one epic end-to-end
  (clarify → design → validate → commit → open design PR → review checkpoint →
  approve/redirect/cancel) inside a single Claude Code session spawned by
  `flow epic create "<prompt>"`. Use ONLY when invoked by that seed prompt or
  via an explicit `/epic-create`. It opens a reviewable design PR and STOPS at
  the checkpoint — it never launches a feature `flow feature create`, computes a DAG
  frontier, or merges the design PR. One long-running supervisor turn per
  phase, not a sub-agent.
argument-hint: '"<epic prompt>"'
---

# Goal

You are the supervisor of one tmux window's **epic-design** pipeline. The user
typed `flow epic create "<prompt>"` from a terminal; tmux opened a window,
launched Claude Code in it, and seeded this chat with a prompt that invokes
you. From here you turn the epic prompt into a **reviewed, dependency-ordered
decomposition** — `design.md` + `manifest.json` under `.flow/epics/<slug>/` —
committed on a per-pipeline branch and surfaced as an **open design PR** that
copilot auto-reviews. You then STOP at the `epic-design-pending-review`
checkpoint and wait for the user to **approve**, **redirect**, or **cancel**.

This is a different supervisor session from `/flow-pipeline`. You fire your own
named `AskUserQuestion` clarification form and your own single named Task-tool
fan-out (the `MODE: epic` designer). Those are NOT among `/flow-pipeline`'s
two `AskUserQuestion` forms / nine Task-tool exemptions — a different supervisor
in a different window is a different session.

The Step 4.5 **cross-model design review** is a
**Bash fan-out, not a tenth exemption** — it shells `flow-plan-review` (via
`flow-delegate`/AGY), reusing the SAME `review.gemini` gate as
`/flow-pipeline`'s Step-3 plan review. It spawns no Task and fires no
`AskUserQuestion` form, so `/epic-create`'s
**two named surfaces** (the clarification form + the `MODE: epic` designer
fan-out) are unchanged; documented bidirectionally in `AGENTS.md` `## Don'ts`.

## EPIC_DIR comes from the seed prompt (R1 — never import `bin/lib`)

The CLI (`flow epic create`) is the SOLE evaluator of the epic path contract.
It embeds the resolved **literal** `EPIC_DIR` (e.g. `.flow/epics/<slug>`) and
the resolved **literal** product-planning `SKILL_DIR`, each on its own line in
the seed prompt:

```
Use the /epic-create skill for: <prompt>

EPIC_DIR: .flow/epics/<slug>

SKILL_DIR: <abs>/skills/pipeline/product-planning
```

Capture that literal `EPIC_DIR` and use it verbatim for every path below
(`<EPIC_DIR>/design.md`, `<EPIC_DIR>/manifest.json`). Likewise capture the
literal `SKILL_DIR` and pass it verbatim into the Step 3 designer Task prompt
(you cannot re-derive it — the in-process Skill-tool base-directory mechanism
`/flow-pipeline` uses is unavailable when you spawn the designer via Task). You
run cwd'd in a
**consumer worktree** where flow's `bin/lib/*` does NOT exist, so you must
**NEVER `import` `bin/lib`** (`epicDirRelative`, `EPIC_*_FILENAME`) — that
import fails here. Consume the literal + the **bare-name PATH validators**
(`flow-epic-manifest-schema`, `flow-epic-dag`) + the bare-name
`flow-epic-resume-decide` + `jq` only.

# HALT contract (read before doing anything)

F5 OPENS the design PR but **NEVER merges it**. The approve branch leaves the
PR OPEN for the human to merge. You must:

- **never** compute a Kahn frontier / ready-set from the manifest;
- **never** `flow feature create` a feature window or open a per-feature worktree;
- **never** `gh pr merge` the design PR (no auto-merge exemption is claimed or
  needed).

`flowNewHints` in the manifest + the committed manifest itself are the only
orchestrator seam — leave them for the deferred `flow epic run` phase.

# The steps

## Step 1 — Worktree

**Phase:** `starting` → advance via `flow-state-update` as you go. Every phase
transition below uses the explicit `flow-state-update --phase <X>` command (the
bare `phase: <X>` shorthand reads positionally as a slug and no-ops).

Create / reuse the per-pipeline worktree via `flow-new-worktree` (call it
**bare**, no positional — it auto-resolves the slug from the pane's
`@flow-slug`, exactly as `/flow-pipeline` step 2 does). Capture the printed
absolute path as `$WORKTREE`:

```bash
WORKTREE=$(flow-new-worktree | sed -n 's/^.*[Cc]reating worktree at: //p; s/^.*[Rr]eusing existing worktree at: //p' | tail -1)
```

Then `mkdir -p "$WORKTREE/.flow-tmp"` for scratch.

## Step 2 — Materiality-gated clarification (the `/epic-create` clarification form)

Run `flow-state-update --phase epic-designing --worktree "$WORKTREE"` (folding
the worktree persistence into this first transition, mirroring `/flow-pipeline`
step 2, so a later `flow-epic-resume-decide` sees a non-null `state.worktree`
and re-renders the checkpoint instead of recreating the worktree). Then judge
the prompt for **material ambiguity** — an ambiguity whose answer changes the **feature set** or the
**DAG shape** of the decomposition. This judgment is irreducibly subjective
(LLM-side): a crisp prompt degrades gracefully to one-shot — **skip the round
and proceed autonomously**.

When there IS a material ambiguity, fire **exactly one** bounded
`AskUserQuestion` round before decomposing. This is **the `/epic-create`
clarification round** — this skill's OWN narrow, named, authorized
`AskUserQuestion` form, registered in AGENTS.md. It is NOT one of
`/flow-pipeline`'s two forms. Keep it to the smallest set of questions that
resolves the feature-set/DAG-shape fork; never use it for cosmetic detail.

## Step 3 — Run the F4 designer (the `/epic-create` MODE: epic designer fan-out)

Spawn `/product-planning` with `MODE: epic` via the Task tool — this is the
supervisor's **SINGLE NAMED Task-tool fan-out site**, registered in AGENTS.md
as the `/epic-create` → `/product-planning MODE: epic` designer. It is NOT one
of `/flow-pipeline`'s nine Task-tool exemptions.

**Load the Task tool before spawning.** In Claude Code sessions where neither
`Task` nor its alias `Agent` is surfaced top-level by the harness (both are
aliases of the same one-shot subagent-spawn primitive), the spawn silently
falls through to in-line execution unless the schema is loaded first. Before
the Task call, run `ToolSearch query="select:Task"` and confirm the response
contains either a `<function>{"name": "Task", ...}</function>` or a
`<function>{"name": "Agent", ...}</function>` line. If it does not, **do not
fall back to in-line execution** — escalate
`NEEDS HUMAN: task-tool-unavailable: epic-create-designer` and exit.

**Per-phase model (planning) threading.** The epic **design** phase shares the
feature **planning** knob — resolution field `state.modelPlanning` (set via
`flow epic create --model-planning`), precedence `--model-planning >
config.models.planning > inherited` (see
`../flow-pipeline/references/model-routing.md`). Resolve it and, when non-empty,
add a `MODEL_PLANNING: <alias>` line to the Task prompt below; `/product-planning`
forwards it to the Discovery Subagent's Task spawn as its per-spawn `model:`
(empty ⇒ omit ⇒ inherit). This is a `model:` override on the existing designer
fan-out — **no** new fan-out site:

```bash
SLUG=$(tmux show-options -t "$TMUX_PANE" -v -w @flow-slug)
PLANNING_MODEL=$(jq -r '.modelPlanning // empty' ~/.flow/state/"$SLUG".json)
[ -z "$PLANNING_MODEL" ] && PLANNING_MODEL=$(jq -r '.models.planning // empty' ~/.flow/config.json 2>/dev/null)
```

Make exactly one Task call passing the clarified prompt + `WORKTREE` +
`SKILL_DIR` + `MODE: epic` + the literal `EPIC_DIR` (and the
`MODEL_PLANNING:` line when non-empty):

```
subagent_type: general-purpose
description:   Epic design for /epic-create
prompt: |
  /product-planning MODE: epic
  <clarified epic prompt>
  WORKTREE: <$WORKTREE>
  SKILL_DIR: <the literal SKILL_DIR from the seed prompt>
  EPIC_DIR: <the literal EPIC_DIR from the seed prompt>
  MODEL_PLANNING: <$PLANNING_MODEL>   # omit this line entirely when empty
```

The one-shot designer writes `<EPIC_DIR>/design.md` + `<EPIC_DIR>/manifest.json`
under `$WORKTREE` and self-validates them, returning a brief summary.

## Step 4 — Validate (the second independent gate)

Run `flow-state-update --phase epic-validating`. Re-run BOTH **bare-name PATH** validators
against the written manifest as an independent second gate:

```bash
flow-epic-manifest-schema --validate "$WORKTREE/<EPIC_DIR>/manifest.json"
flow-epic-dag --validate "$WORKTREE/<EPIC_DIR>/manifest.json"
```

Each exits `0` valid / `1` off-shape-or-bad-graph / `2` usage. On any non-zero
exit, loop back to **Step 3**: re-spawn the designer with the validator's
stderr appended as guidance, then re-validate. Do not proceed to the PR until
both validators exit 0.

## Step 4.5 — Cross-model design review (Layer 2, optional, config-gated)

Before committing/opening the PR, run one independent **cross-model design
review** of the epic decomposition's consequential forks, mirroring
`/flow-pipeline`'s Step-3 plan-review sub-step. This is a Bash `flow-delegate`
(AGY) fan-out — the same mechanism as `/pr-review`'s Gemini lens — and spawns
**no Task** (see the named-surface note above: a **Bash fan-out, not a tenth
exemption**).

It gets **no dedicated phase** — it rides within the `epic-validating` →
`epic-pr-open` transition, so a crash mid-review resumes at `validate` (Step 4)
and re-runs the idempotent validators + the idempotent `flow-plan-review` before
Step 5. The Step-7 redirect path (re-spawn designer → re-validate → push a new
commit) naturally re-traverses this step, so a redirect that changes the
decomposition re-fires the review.

Two-part gate, both human-readable:

```bash
jq -e '(.review | type == "object") and (.review.gemini == true)' ~/.flow/config.json \
  && grep -q '^## Decision analysis' "$WORKTREE/<EPIC_DIR>/design.md"
```

The config half reuses the SAME `review.gemini` opt-in that gates
`/flow-pipeline`'s Step-3 plan review (**no new config key**); the section half
is the omit-when-empty `## Decision analysis` critique section — its absence
means the designer found no genuinely-diverging decomposition fork, so there is
nothing to cross-review. When **either** half fails, skip this step and proceed
to Step 5 unchanged.

When both fire, run ONE review and branch on the helper's `{ran}` envelope
(NEVER the exit code):

```bash
flow-plan-review --plan-file "$WORKTREE/<EPIC_DIR>/design.md" \
  --out "$WORKTREE/.flow-tmp/design-review.md" --task epic-design-review
```

- `ran:false` → record the `skipReason` in scrollback and proceed to Step 5
  unchanged (a graceful no-op — e.g. `agy-not-found` when agy is absent or
  logged out). No revision, no reconciliation subsection.
- `ran:true` → read `design-review.md` and weigh EACH material AGY point against
  the codebase context you hold. AGY is a different model with less context —
  its output is **INPUT you weigh, NOT a verdict**. Revise `design.md` **once**
  where a point is warranted, then append a `### Cross-model review (AGY)`
  subsection under `## Decision analysis` recording each material point as
  **accepted** (naming the revision made) or **overridden** (with a one-line
  rationale). Bounded single-pass — one review, at most one revision.

**Design ↔ manifest lock-step (read before revising).** A **prose-level**
reconciliation (the accept/override notes appended under `## Decision analysis`,
wording tweaks that do not change the decomposition) is a simple in-place
`design.md` edit. But a reconciliation that would **structurally** change the
decomposition (split/merge a feature, re-cut a seam, add/remove a node or edge)
must NOT be hand-applied to `design.md` prose alone — it routes through the
normal **Step-7 designer re-spawn** so `design.md` **and** `manifest.json`
regenerate coherently. Step-4 re-validation fails on any design↔manifest
mismatch and would otherwise trap the pipeline pre-PR, so never hand-edit prose
into a design/manifest divergence.

## Step 5 — Commit + open the design PR

Run `flow-state-update --phase epic-pr-open`. Commit the two artifacts on the per-pipeline
branch (conventional commit, e.g. `feat(epic): design <slug>`), compose the PR
body under `$WORKTREE/.flow-tmp/`, and open the design PR via `flow-open-pr`:

```bash
flow-open-pr --body-file "$WORKTREE/.flow-tmp/epic-pr-body.md" \
  --title "feat(epic): design <slug>"
```

No `--base` (defaults to the repo default branch) and **not** `--draft` — a
design PR is meant to be reviewed immediately and copilot reviews non-draft
PRs. `flow-open-pr` is **idempotent**: it probes the branch via `gh pr view`
FIRST and skips `gh pr create` on an already-PR'd branch, writing `pr` to
`~/.flow/state/<slug>.json`. Capture the PR URL from stdout.

## Step 6 — Checkpoint (render + END the turn)

Run `flow-state-update --phase epic-design-pending-review`. Render the checkpoint — the open
design PR URL plus the approve/redirect/cancel next-action prompt — mirroring
`/flow-pipeline` step 3's awaiting-approval render:

```
STATUS: AWAITING DESIGN REVIEW
WHY: epic design ready for review (PR opened)
NEXT ACTION: reply approve / redirect <new direction> / cancel
  - <the design PR URL>
  - <$WORKTREE>/<EPIC_DIR>/design.md
```

For a visual / palette / typography-overhaul epic, surface in the checkpoint
that concrete palette/color values were deliberately deferred to each feature's
F1 planning (the designer records this in `design.md` Open Questions), so the
reviewer reads the deferral as a conscious choice rather than an omission.

Then **END the turn**. The `epic-design-pending-review` phase is a pending
phase, so `flow-stop-guard` permits ending here. Wait for the user to attach
and respond. The next turn re-enters at Step 7.

## Step 7 — Classify the reply (approve / redirect / cancel)

On the next turn, classify the user's chat input per
`skills/pipeline/flow-pipeline/references/redirect-handling.md` semantics
(Affirmative / Imperative redirect / Cancel / Ambiguous — ask one clarifying
question when ambiguous):

- **approve** (`approve`, `ok`, `lgtm`, `looks good`, `ship it`) → run
  `flow-state-update --phase epic-approved`, **STOP** with the design PR **LEFT OPEN**. Do **not**
  merge it — the human merges the design PR. Trigger no orchestrator launch.
- **redirect** (an imperative directive, e.g. "split feature B into
  read/write") → re-spawn the **Step 3** designer with the redirect appended:

  ```
  <original epic prompt>

  USER REDIRECT (received during epic-design-pending-review):
  <the user's verbatim chat input>
  ```

  Then re-validate (**Step 4**) and **push a new commit to the SAME PR
  branch** — re-call `flow-open-pr`, which falls through to the read-back path
  on the already-PR'd branch (**no second `gh pr create`**; the PR + copilot
  review update in place). Re-enter the checkpoint (**Step 6**).

- **cancel** (`cancel`, `abort`, `kill this`) → `gh pr close <pr>`, then
  `flow-remove-worktree` (call it bare — auto-resolves the slug), run
  `flow-state-update --phase cancelled`, and stop.

# Resume mode

The supervisor enters resume mode when the seed prompt begins with the literal
prefix:

```
Use the /epic-create skill in --resume mode for: <slug>
```

`flow epic create --resume <slug>` writes that prompt; nothing else does. On
detecting it, **do not** start at Step 1. Call `flow-epic-resume-decide`
(bare-name PATH, R1 — auto-resolves the slug from `@flow-slug`) to walk the
epic resume-from-disk decision:

```bash
RESULT=$(flow-epic-resume-decide)
RESUME_AT=$(printf '%s' "$RESULT" | jq -r '.epicResumeAt')
REASON=$(printf '%s' "$RESULT" | jq -r '.reason')
WORKTREE=$(printf '%s' "$RESULT" | jq -r '.context.worktree // empty')
PR=$(printf '%s' "$RESULT" | jq -r '.context.pr // empty')
```

Print `RESUMING AT: <epicResumeAt> (<reason>)` on its own line before
re-entering, so the user reading scrollback can confirm. Re-attach the worktree
first (`flow-new-worktree` is idempotent), then branch on `.epicResumeAt`:

| `.epicResumeAt` | Action                                                                                                                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worktree`      | Re-enter Step 1 (recreate the worktree).                                                                                                                                                                                                                                                                  |
| `design`        | Re-enter Step 3 (re-run the designer; it overwrites the artifacts, so a re-spawn is idempotent).                                                                                                                                                                                                          |
| `validate`      | Re-enter Step 4 (re-run the cheap, idempotent validators).                                                                                                                                                                                                                                                |
| `open-pr`       | Re-enter Step 5 (open the PR — no PR record yet).                                                                                                                                                                                                                                                         |
| `read-back-pr`  | A crash mid-`epic-pr-open` where `flow-open-pr` already wrote `state.pr` / a branch PR exists: read the existing PR back and advance to the checkpoint render (Step 6). **Never re-open** an already-open PR (`flow-open-pr`'s up-front `gh pr view` probe enforces the same — no second `gh pr create`). |
| `checkpoint`    | Re-render the checkpoint (Step 6) **WITHOUT re-designing** and wait — **never replay an approval** the user gave to a now-dead session.                                                                                                                                                                   |
| `terminal`      | Already `epic-approved` / `cancelled` / `needs-human`. Re-render the terminal note and end without re-running anything.                                                                                                                                                                                   |
| `escalate`      | Escalate `NEEDS HUMAN: <reason>` (e.g. `worktree-missing-on-resume`, `pr-closed-without-merge`). Leave the worktree + PR intact.                                                                                                                                                                          |
| `abort`         | The state file is missing. Escalate `NEEDS HUMAN: state-missing-on-resume` and end.                                                                                                                                                                                                                       |

## What resume mode does NOT do

- It does **not replay an approval** given to a now-dead session — an
  `epic-design-pending-review` resume re-renders the checkpoint and waits.
- It does **not re-open** an already-open design PR — a crash mid-`epic-pr-open`
  reads the existing PR back via `flow-open-pr`'s up-front probe.
- It does **not merge** the design PR — F5 never merges, on the fresh path or
  the resume path.
- It does not launch a feature `flow feature create` or compute a DAG frontier.

# Resource cleanup

The only spawned resource is the per-pipeline worktree. The cancel branch
removes it (`flow-remove-worktree`). The approve branch leaves it in place at
the `epic-approved` terminal state (the design artifacts survive via the pushed
branch; the human cleans up when they merge the design PR — out of F5's scope).
