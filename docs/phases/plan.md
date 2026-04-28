# Phase 1 — plan

The first headless phase. Reads a `triaged` task and produces a PRD,
task breakdown, and PR description draft so the implement phase has a
plan to execute against.

**Status: shipped (M2).**

## Inputs

- A task file at `<target-repo>/.orchestrator/tasks/<id>.md` with
  `status: triaged`.
- The target repo's `.claude/skills/product-planning/` skill (installed
  via `flow install-skills` or symlinked manually).

## Outputs

Three files in `<target-repo>/.orchestrator/tasks/<id>-plan/`:

| File | Role |
|---|---|
| `prd.md` | Full PRD: problem, scope, stories, architecture decisions, constraints, open questions |
| `task-breakdown.md` | Ordered task list with skill assignments and acceptance criteria |
| `pr-description-draft.md` | Why / What / Key decisions / How to test — seeds the PR body in phase 3 |

A summary of which files landed is appended to the task's
`## Phase outputs > plan` subsection. On exit the task transitions
`triaged → planning → planned`.

## Open question 1 — slash commands inside `claude -p`

**Resolution: dispatched.** The pre-flight probe confirmed that
`claude -p "/product-planning <args>"` invokes the skill defined in
`<cwd>/.claude/skills/product-planning/`. Verification used three signals
in econ-data:

1. `claude -p "What is your role…"` — generic "coding assistant" identity.
2. `claude -p "/product-planning Reply with…"` — adopted the skill's
   Product Manager persona verbatim.
3. `claude -p "/totally-fake-skill-that-does-not-exist …"` — returned
   `Unknown command: /totally-fake-skill-that-does-not-exist` instead of
   treating the slash text as plain prompt content.

Therefore the plan phase ships the **best-case path** from m2-plan.md.
`buildPlanPrompt` writes a wrapping prompt that includes the literal
line `/product-planning <args>` followed by orchestrator-specific
instructions (output paths, non-interactive preamble). No SKILL.md
inlining fallback is needed in M2.

If a future target repo is missing the skill, `claude -p` will respond
with `Unknown command: /product-planning` and the headless wrapper will
treat it as an exit-zero with junk stdout. The plan phase's
`summarizePlanOutputs` step then catches this — the expected files
won't exist, the summary marks them MISSING, and a re-run with the
failure log appended fires via `retryOnce`. (Future hardening: detect
the "Unknown command" string and fail fast with `status: failed,
reason: 'target repo missing /product-planning skill'`.)

## Open question 2 — mid-skill confirmations

**Resolution: pre-answer in the wrapping prompt.** Mitigation #1 from
m2-plan.md is applied unconditionally: every plan/implement prompt
opens with the `NON_INTERACTIVE_PREAMBLE` constant in
`src/pipeline/phases/plan.ts`. It instructs the skill not to pause for
confirmations, to proceed end-to-end, and to write deliverables to
disk. Skill-side changes (mitigation #2) and split skills (#3) are
deferred until field experience shows the preamble is insufficient.

Append future regressions here if the preamble proves too weak in
practice.

## Implementation

| File | Role |
|---|---|
| `src/pipeline/phases/plan.ts` | Phase entry point; builds the prompt, invokes runHeadless, summarizes outputs, transitions status |
| `src/pipeline/headless.ts` | Generic `claude -p` wrapper with cwd, allowed-tools, timeout |
| `src/pipeline/retry.ts` | `retryOnce` helper — single retry with the failure log appended on second attempt |

The phase allows: `Read,Write,Edit,Glob,Grep,Bash(ls *),Bash(cat *)`.
Wider Bash scope isn't needed here — the skill's job is artefact
production, not code execution. Timeout: 10 minutes.

## Contract for downstream phases

Phase 3 (implement) reads:

- `prd.md` for problem framing it can echo back into commits.
- `task-breakdown.md` to decide which sub-skills to invoke and in what order.
- `pr-description-draft.md` as the seed for the PR body. The implement
  phase must distil from this draft, not paste it verbatim.

If any of these files are missing, that's a plan phase bug — tighten
the wrapping prompt rather than tolerating missing artefacts in
implement.
