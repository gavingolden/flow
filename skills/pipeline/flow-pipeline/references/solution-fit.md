# Solution fit — surfacing a better mechanism than the one requested

Full contract for the Step 1 solution-fit check in
`skills/pipeline/flow-pipeline/SKILL.md`. It runs right after the
ultimate-goal line (the Ladder Up move from
`skills/pipeline/flow-product-planning/references/discovery-playbook.md`)
and applies that playbook's **Challenge** (simpler alternative) and
**Connect** (relate to existing code) techniques to the request's named
mechanism. It adds no phase, no state field, and no spawn.

## When a case exists

A **case** exists only when the request's named mechanism (the file,
flag, helper, or approach it prescribes) may not serve the ultimate goal
you just inferred, and a bounded read shows why. No case, no output —
say nothing.

Bounded reads: the recipes in `references/prompt-sanity.md`, at most 3
files, at most 60 lines each.

## The chat line

State exactly one line, in plain user terms:

`Solution fit: <the request's named mechanism> may not serve <ultimate goal> — <what the user would gain or lose, in plain terms>`

The supporting `path:line` evidence never goes in the chat line; it goes
to the interview digest or the `SOLUTION-FIT:` line below.

## Confident vs. not confident

**Confident** if and only if the case cites a `path:line` or a zero-hit
grep AND names a concrete alternative.

- **Confident:** seed the intent interview's first question (Q1) using
  the grammar in [interview-playbook.md](interview-playbook.md) `## 3`:

  ```
  Q1. <Title>
  <what the answer decides and why it matters>
    a) <the concrete alternative>
    b) as requested
    (freeform also accepted)
  Recommended: a — <rationale> [confidence: high] [anchor: <path:line or zero-hit grep>]
  ```

  Chat renders show the confidence as `(high)`; the anchor stays on
  disk. This fires the interview even under the expert-specified carve-out
  (see interview-playbook.md `**Solution-fit override.**`). When
  `state.interviewMode` is `skip`, degrade to the `SOLUTION-FIT:` thread
  line below instead.

- **Not confident:** append `SOLUTION-FIT: <one-line case>` to the
  ultimate-goal line in the `/flow-product-planning` invocation. Discovery
  treats it as Case-against input under `## Request vetting`. Omit the
  line when there is no case.
