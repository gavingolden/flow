# flow — product brief

The standing statement of what this repo's product manager optimizes for.
Read by `flow-product-brief`; cited by `/flow-product-planning` discovery and
the cross-model plan review. Human-maintained, committed, no secrets.

## Who the PM is

flow's single user — one person who builds flow and is also the only person
who runs it. Technical, and able to follow any engineering concept when given
enough context, but **assume they have not read the code and do not want to**.
The code is a means; it is of far less interest than what it produces.

Write for that reader the way you would brief a manager overseeing a team, in
a meeting with product, engineering, and team leads present. The test for any
sentence: would it be worth saying in that room? File names, function names,
and line numbers never pass that test. User-visible consequences, costs,
design choices, and quality always do.

## Ranked priorities

**Precondition — truthfulness.** Nothing below counts if the claim is false.
Every statement flow makes must be verified and specific; an admitted gap
beats a confident guess. This is not ranked because it is not tradeable.

Then, in order. When two conflict, the higher one wins; the point of the
ranking is to decide those conflicts, not to rate importance in the abstract.

1. **User experience.** How the product feels to use: fewer interruptions,
   fewer things the user has to remember or re-check, fewer surprises. One
   notch below that, look and feel — the visible layout and polish of every
   surface the user reads, including terminal output.
2. **Cost.** Anything with financial implications — cloud and compute spend,
   paid API calls, and, for flow itself, tokens and context. Prefer the
   cheaper path when the outcomes are comparable; anything that adds ongoing
   cost must say what it buys.
3. **Architecture and system design.** The shape of the system — its
   boundaries, its data flow, how it scales and performs, how it fails. A
   design decision is worth surfacing; the code that implements it is not.
4. **Product quality.** The product does what it says, predictably, and
   holds together as a whole — including degrading gracefully when an
   optional input is missing rather than failing hard.

## What "good" looks like

A reader who has **not** opened the code can act on the explanation. They can
tell what changed for the user, what it costs, what design choice was made
and why, and what to do next — without reading the diff, without meeting an
internal identifier, and without a second round-trip to ask what a sentence
meant.

## Non-goals

- Mechanism-first summaries — a diff restated as prose.
- Naming files, functions, or line numbers in anything the user reads,
  unless they asked for the technical version.
- Assuming the reader read the code, the diff, or the scrollback.
- Hedged, unfalsifiable claims ("should be fine", "looks right") standing in
  for a check something can actually fail.
- Growing surface area for its own sake: a new flag, config key, or file that
  no named reader consumes.

## Vocabulary

| Use                                                         | Avoid                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| what the user now sees, saves, or no longer has to do       | "refactored the internals"                                       |
| the design choice and the alternative it beat               | the module, file, or function that implements it                 |
| "costs one extra call per run" / "adds ~N% to cloud spend"  | "negligible overhead"                                            |
| "nothing is lost" / "what is lost is X"                     | "should be recoverable"                                          |
| a named skip with its reason                                | "failed" with no reason                                          |
| plain nouns a reader already owns (plan, PR, review, merge) | flow-internal jargon (envelope, lens, seam) in user-facing prose |
