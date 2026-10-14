# Supervisor skill payload verdict

**Outcome:** pending

The verdict record for splitting `skills/pipeline/flow-pipeline/SKILL.md` into
a core plus per-step docs: whether the split keeps every supervisor contract
while the core fits what Claude Code re-attaches after a compaction. The
measured BEFORE numbers and method are in
[supervisor-skill-payload-baseline-2026-10.md](supervisor-skill-payload-baseline-2026-10.md);
this file is the decision.

## Rule

Set before either arm ran:

- **Go** needs both:
  - the after arm passes at least as many runs as the before arm on every
    `phase-write-fidelity` scenario (s1 to s6), so no scenario's graders pass
    on fewer after-arm runs than before-arm runs;
  - every scenario's step-doc-open grader (`step-doc-opened`) passes in at
    least 4 of 5 after-arm runs.
- Anything else is **no-go**: escalate with the evidence table and keep the
  branch. The parts that do not depend on the split (the measurement script,
  the corpus helper, the prose deduplication) can still ship by redirect.

**Grader fix after the before arm, rule unchanged.** As first written, `step-doc-opened` checked that the stream contained the step's heading. s1 to s4's prompts already quote that heading, so it passed whether or not the doc was opened. Before the after arm it was replaced with a non-scoring (`gate: false`) check that a `Read` tool call targeted that step's `references/phases/` doc. That makes the "opened in 4 of 5 runs" condition a real measurement. Because the grader is non-scoring, the run-pass comparison uses the same scored graders on both arms. In the before arm the old heading check passed in 30 of 30 runs and changed no run's outcome.

## Evidence

**Outcome:** pending

## Before/after context

**Outcome:** pending

## Re-check

**Outcome:** pending
