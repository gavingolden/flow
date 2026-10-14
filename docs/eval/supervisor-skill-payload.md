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

## Evidence

**Outcome:** pending

## Before/after context

**Outcome:** pending

## Re-check

**Outcome:** pending
