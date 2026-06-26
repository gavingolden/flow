---
name: epic-create
description: >-
  Supervisor skill for the epic-designer phase. Drives one epic end-to-end
  (clarify → design → validate → commit → open design PR → review checkpoint →
  approve/redirect/cancel) inside a single Claude Code session spawned by
  `flow epic create "<prompt>"`. Use ONLY when invoked by that seed prompt or
  via an explicit `/epic-create`. It opens a reviewable design PR and STOPS at
  the checkpoint — it never launches a feature `flow new`, computes a DAG
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

## EPIC_DIR comes from the seed prompt (R1 — never import `bin/lib`)

The CLI (`flow epic create`) is the SOLE evaluator of the epic path contract.
It embeds the resolved **literal** `EPIC_DIR` (e.g. `.flow/epics/<slug>`) on
its own line in the seed prompt:

```
Use the /epic-create skill for: <prompt>

EPIC_DIR: .flow/epics/<slug>
```

Capture that literal `EPIC_DIR` and use it verbatim for every path below
(`<EPIC_DIR>/design.md`, `<EPIC_DIR>/manifest.json`). You run cwd'd in a
**consumer worktree** where flow's `bin/lib/*` does NOT exist, so you must
**NEVER `import` `bin/lib`** (`epicDirRelative`, `EPIC_*_FILENAME`) — that
import fails here. Consume the literal + the **bare-name PATH validators**
(`flow-epic-manifest-schema`, `flow-epic-dag`) + the bare-name
`flow-epic-resume-decide` + `jq` only.

# HALT contract (read before doing anything)

F5 OPENS the design PR but **NEVER merges it**. The approve branch leaves the
PR OPEN for the human to merge. You must:

- **never** compute a Kahn frontier / ready-set from the manifest;
- **never** `flow new` a feature window or open a per-feature worktree;
- **never** `gh pr merge` the design PR (no auto-merge exemption is claimed or
  needed).

`flowNewHints` in the manifest + the committed manifest itself are the only
orchestrator seam — leave them for the deferred `flow epic run` phase.

# The steps

## Step 1 — Worktree

**Phase:** `starting` → advance via `flow-state-update` as you go.

Create / reuse the per-pipeline worktree via `flow-new-worktree` (call it
**bare**, no positional — it auto-resolves the slug from the pane's
`@flow-slug`, exactly as `/flow-pipeline` step 2 does). Capture the printed
absolute path as `$WORKTREE`:

```bash
WORKTREE=$(flow-new-worktree | sed -n 's/^.*[Cc]reating worktree at: //p; s/^.*[Rr]eusing existing worktree at: //p' | tail -1)
```

Then `mkdir -p "$WORKTREE/.flow-tmp"` for scratch.

## Step 2 — Materiality-gated clarification (the `/epic-create` clarification form)

Write `phase: epic-designing`. Then judge the prompt for **material
ambiguity** — an ambiguity whose answer changes the **feature set** or the
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

Make exactly one Task call passing the clarified prompt + `WORKTREE` +
`SKILL_DIR` + `MODE: epic` + the literal `EPIC_DIR`:

```
subagent_type: general-purpose
description:   Epic design for /epic-create
prompt: |
  /product-planning MODE: epic
  <clarified epic prompt>
  WORKTREE: <$WORKTREE>
  SKILL_DIR: <product-planning SKILL_DIR>
  EPIC_DIR: <the literal EPIC_DIR from the seed prompt>
```

The one-shot designer writes `<EPIC_DIR>/design.md` + `<EPIC_DIR>/manifest.json`
under `$WORKTREE` and self-validates them, returning a brief summary.

## Step 4 — Validate (the second independent gate)

Write `phase: epic-validating`. Re-run BOTH **bare-name PATH** validators
against the written manifest as an independent second gate:

```bash
flow-epic-manifest-schema --validate "$WORKTREE/<EPIC_DIR>/manifest.json"
flow-epic-dag --validate "$WORKTREE/<EPIC_DIR>/manifest.json"
```

Each exits `0` valid / `1` off-shape-or-bad-graph / `2` usage. On any non-zero
exit, loop back to **Step 3**: re-spawn the designer with the validator's
stderr appended as guidance, then re-validate. Do not proceed to the PR until
both validators exit 0.

## Step 5 — Commit + open the design PR

Write `phase: epic-pr-open`. Commit the two artifacts on the per-pipeline
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

Write `phase: epic-design-pending-review`. Render the checkpoint — the open
design PR URL plus the approve/redirect/cancel next-action prompt — mirroring
`/flow-pipeline` step 3's awaiting-approval render:

```
STATUS: AWAITING DESIGN REVIEW
WHY: epic design ready for review (PR opened)
NEXT ACTION: reply approve / redirect <new direction> / cancel
  - <the design PR URL>
  - <$WORKTREE>/<EPIC_DIR>/design.md
```

Then **END the turn**. The `epic-design-pending-review` phase is a pending
phase, so `flow-stop-guard` permits ending here. Wait for the user to attach
and respond. The next turn re-enters at Step 7.

## Step 7 — Classify the reply (approve / redirect / cancel)

On the next turn, classify the user's chat input per
`skills/pipeline/flow-pipeline/references/redirect-handling.md` semantics
(Affirmative / Imperative redirect / Cancel / Ambiguous — ask one clarifying
question when ambiguous):

- **approve** (`approve`, `ok`, `lgtm`, `looks good`, `ship it`) → write
  `phase: epic-approved`, **STOP** with the design PR **LEFT OPEN**. Do **not**
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
  `flow-remove-worktree` (call it bare — auto-resolves the slug), write
  `phase: cancelled`, and stop.

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
- It does not launch a feature `flow new` or compute a DAG frontier.

# Resource cleanup

The only spawned resource is the per-pipeline worktree. The cancel branch
removes it (`flow-remove-worktree`). The approve branch leaves it in place at
the `epic-approved` terminal state (the design artifacts survive via the pushed
branch; the human cleans up when they merge the design PR — out of F5's scope).
