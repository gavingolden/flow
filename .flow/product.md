# flow — product brief

The standing statement of what this repo's product manager optimizes for.
Read by `flow-product-brief`; cited by `/flow-product-planning` discovery and
the cross-model plan review. Human-maintained, committed, no secrets.

## Who the PM is

flow's single user — one engineer who builds flow and is also the only person
who runs it. Not a team, not a persona, not a hypothetical customer. Every
decision is weighed against what that one reader actually experiences at the
terminal, in a PR body, and in a plan they have to approve.

## Ranked priorities

In order. When two conflict, the higher one wins.

1. **Reading outcomes, not mechanisms.** Every authored artifact — a plan, a
   summary, a PR body, a failure escalation — leads with the user-visible
   consequence and names the concrete command, flag, or file it affects.
   Mechanism is the answer to "give me the technical version", never the
   opening.
2. **Cost and token spend.** Context is the scarce resource. Prefer the
   cheaper path when outcomes are comparable; a feature that adds tokens to
   every run must say what it buys.
3. **UX.** How it feels to drive: fewer interruptions, fewer confirmations,
   fewer states the user has to hold in their head. An automated check beats
   a manual step; a default beats a flag.
4. **Content quality.** What flow writes has to be true and specific —
   verified claims, real paths, named trade-offs. A confident, unverified
   sentence is worse than an admitted gap.
5. **Reliability.** Degrade to a named skip rather than a hard failure;
   absence of an optional input is a normal state, never an error.

## What "good" looks like

A reader who has **not** opened the code can act on the explanation. They can
tell what changed, who it affects, what it costs, and what to do next, without
reading the diff, without knowing an internal identifier, and without a second
round-trip to ask what a sentence meant.

## Non-goals

- Mechanism-first summaries — a diff restated as prose.
- Assuming the reader read the code, the diff, or the scrollback.
- Internal identifiers used as if they were user-facing nouns.
- Hedged, unfalsifiable claims ("should be fine", "looks right") standing in
  for a check something can actually fail.
- Growing surface area for its own sake: a new flag, config key, or file that
  no named reader consumes.

## Vocabulary

| Use                                                                     | Avoid                                                            |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| the user-visible consequence                                            | "refactored the internals"                                       |
| the concrete command or flag (`flow feature create`, `--no-auto-merge`) | the module or symbol name alone                                  |
| "nothing is lost" / "what is lost is X"                                 | "should be recoverable"                                          |
| a named skip with its reason                                            | "failed" with no reason                                          |
| "costs one extra call per run"                                          | "negligible overhead"                                            |
| plain nouns a reader already owns (plan, PR, worktree)                  | flow-internal jargon (envelope, lens, seam) in user-facing prose |
