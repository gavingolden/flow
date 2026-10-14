# Supervisor skill payload verdict

**Outcome:** no-go

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

**Outcome:** no-go — condition (a) holds, condition (b) fails on s5 only.

Both arms: `bun bin/flow-eval.ts run --suite phase-write-fidelity --runs 5 --concurrency 3`, sonnet / medium. The before arm ran on `135b6c1` (pre-split, plus s6), the after arm on `e4ff7d4` (split). Raw reports: [before](skill-split/before/report.json), [after](skill-split/after/report.json).

| Scenario                     | Before: runs passed | After: runs passed | After: step doc opened | Before $/run | After $/run | Before context (tokens) | After context (tokens) |
| ---------------------------- | ------------------- | ------------------ | ---------------------- | ------------ | ----------- | ----------------------- | ---------------------- |
| s1 step 7 ci-wait            | 5/5                 | 5/5                | 5/5                    | 0.488        | 0.139       | 118,474                 | 42,865                 |
| s2 step 8 reviewing          | 5/5                 | 5/5                | 5/5                    | 0.711        | 0.364       | 170,450                 | 91,152                 |
| s3 step 9 gating             | 5/5                 | 5/5                | 5/5                    | 0.458        | 0.145       | 117,960                 | 43,705                 |
| s4 step 10 merging           | 5/5                 | 5/5                | 5/5                    | 0.442        | 0.141       | 117,787                 | 42,107                 |
| s5 step 5 open-pr            | 5/5                 | 5/5                | **0/5**                | 0.456        | 0.098       | 118,406                 | 34,470                 |
| s6 question intent (dry run) | 5/5                 | 5/5                | 5/5                    | 0.486        | 0.147       | 119,465                 | 41,432                 |
| Total                        | 30/30               | 30/30              | 25/30                  | $15.20 arm   | $5.17 arm   |                         |                        |

Context is the mean final context per run (`transcript.finalContextTokens`).

- **(a) holds:** every scenario passed 5/5 on both arms, so no scenario lost a passing run.
- **(b) fails on s5:** none of the 5 s5 runs opened `step-05-implement.md`. s5's prompt dictates the exact `flow-open-pr` call and forbids the rest of the step, so the run never needed the doc. All its scored graders passed: phase `implementing`, PR recorded, no manual phase write. This is a scenario that does not exercise doc-opening, not a run that skipped a doc it needed. The rule was written before either arm and is applied as written; reinterpreting it after the fact is the user's call, not the pipeline's.

## Before/after context

**Outcome:** recorded

Static, from `bun docs/eval/supervisor-skill-payload.ts --static`. This is the skill text resident at each step's entry. Before the split, all 221,764 chars were resident from the first turn.

| Step entered    | Resident chars | Share of before |
| --------------- | -------------- | --------------- |
| 0 (start)       | 20,720         | 9%              |
| 3 (plan)        | 68,970         | 31%             |
| 8 (review)      | 121,200        | 55%             |
| 11 (follow-ups) | 166,623        | 75%             |

- The core is 19,369 chars, which fits the 20,000-char compaction restore window (measured: 16 of 16 re-attachments were exactly 20,000 chars; see the baseline doc).
- Resume, failure paths, redirects and the hard-rule detail are never loaded on a clean run.

## Re-check

**Outcome:** scheduled

On or after 2026-11-14, re-run `bun docs/eval/supervisor-skill-payload.ts --since 2026-10-15` and compare step-doc `Read`s against the phases reached in real runs. Owner: the repo owner.

Known limit: Claude Code restores at most 25,000 tokens across all re-attached skills. A review-phase run with 5–6 flow skills loaded can drop the earliest-invoked skill, the pipeline core, entirely. Two mitigations do not depend on the core surviving: AGENTS.md's Compact Instructions reload rule, and the stop-hook reminder naming the step doc.
