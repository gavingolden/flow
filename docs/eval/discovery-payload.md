# Discovery instruction payload verdict

**Outcome:** go

The verdict record for issue #891: whether moving branch-only procedure out
of discovery's always-read instruction file cuts its cost without weakening
plans. The measured numbers and method are in
[discovery-payload-baseline-2026-10.md](discovery-payload-baseline-2026-10.md);
this file is the decision.

## Rule

Set before either arm ran:

- **Go** needs all three:
  - the median per-run instruction read falls by at least 20% of the
    production median first-turn write (7,250 tokens);
  - no new plan-lint failure;
  - no gating grader passes on fewer after-arm runs than before-arm runs.
- Anything else is **no-go**: revert the split and record why.

## Evidence

| Measure                                    | Before                                                     | After                                                    | Change           |
| ------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------- | ---------------- |
| Report                                     | [before/report.json](discovery-payload/before/report.json) | [after/report.json](discovery-payload/after/report.json) |                  |
| Tree                                       | `eb4e5d7` (unsplit)                                        | `cc2e767` (split)                                        |                  |
| Scenarios passing                          | 5/5                                                        | 5/5                                                      | same             |
| Gating graders green                       | every grader, 10/10 runs                                   | every grader, 10/10 runs                                 | same             |
| Plan-lint failures                         | 0                                                          | 0                                                        | same             |
| Median instruction read per run (tokens)   | 70,991                                                     | 50,111                                                   | −20,880 (−29.4%) |
| Instruction read chunks (median)           | 4                                                          | 2                                                        | −2               |
| Median discovery cost per run (list price) | $0.95                                                      | $0.81                                                    | −15%             |
| Eval spend for the arm (10 runs)           | $19.18                                                     | $17.88                                                   | −6.8%            |
| Mean run duration                          | 335 s                                                      | 336 s                                                    | same             |

The instruction-read drop is 2.9 times the 7,250-token bar. As other
readings of the request's threshold:

- 29.4% of the before arm's instruction read;
- 22.3% of the before arm's start-up payload (first request context plus
  instruction read, 93,782 tokens).

Each branch reference was opened on both runs of the scenario that fires
its branch (UI in s2, prompt interpretation in s3, revision in s4, research
in s5), so no branch lost its procedure.

## Projected saving

The instruction read is 23% to 28% of discovery's modeled spend, about
$178 to $219 of the $786.20 30-day window (baseline doc, "Instruction read
share"). A 29.4% cut of that read projects to about **$52 to $64 per 30
days** at list price. This is a projection from the eval delta, not a
production measurement.

## What the evidence does not cover

- Plan quality is graded structurally: plan-lint plus one branch-section
  grader per scenario. Nothing grades the depth of a plan's reasoning.
- Five scenarios at two runs each cannot show a pointer that discovery
  skips at production volume.

## Re-check

The next token-spend audit re-runs
`bun docs/eval/discovery-payload.ts --since <window start>` (the default
`--instructions` set is the core plus the five references named below, so the
median counts every instruction file a run reads) and checks two things:

- the production median instruction read has fallen by about the eval's
  29%;
- the reference open rates for `discovery-research.md`, `discovery-ui.md`,
  `discovery-revision.md`, `discovery-survey-epic.md` and
  `discovery-prompt-interpretation.md` match how often their branches fire.

A branch that fires but whose reference stays unopened is the signal that
a pointer is being skipped.
