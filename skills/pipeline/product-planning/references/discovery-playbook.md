# Discovery Playbook

Techniques for running a productive discovery conversation. Load this when you need to go
deeper on a vague or complex feature idea.

## Conversational Techniques

### Ladder Up (Solution → Problem)

When the user describes a solution ("I want a share button"), ask what problem it solves.
The real need may be broader or different than the proposed solution.

- "What would someone do with this feature that they can't do today?"
- "What's the situation that makes you want this?"

### Ladder Down (Problem → Scenario)

When the user describes a problem ("collaboration is hard"), ask for a concrete scenario.
Abstract problems lead to abstract plans.

- "Can you walk me through a specific time this was painful?"
- "Who exactly is trying to do what, and where do they get stuck?"

### Fork (Vague → Two Options)

When the user gives a vague answer ("it should be flexible"), offer two concrete alternatives
and ask them to pick. Two options is a _starting_ framing for a fast conversation — not a verdict that the answer must be one of exactly two. Per the flow `AGENTS.md` `## Output style` rule **Consider the middle ground when a request is framed as a binary choice.**, once the user reacts to A vs B, still check for an intermediate option (a hybrid, a phased default) and offer it if one fits the conversation.

- "Would you rather it works like A (simpler, covers 80% of cases) or B (more powerful,
  but takes longer to build)?"
- "Two ways to do this: option A stores it in the URL, option B stores it in the database.
  Which feels closer to what you want?"

### Challenge (Simpler Alternative)

When the user proposes something complex, suggest a simpler version and ask why it's
insufficient. This surfaces hidden requirements — or confirms the feature can be smaller.
The limit case of "simpler version" is "no version" — probe whether the feature is needed
at all, since "do nothing" is sometimes the right answer (it feeds the discovery
**Necessity** check and a `Reject — do nothing` recommendation).

- "What if we skipped X for now and just did Y — would that still be useful?"
- "The simplest version of this would be [description]. What's missing?"
- "What if we did nothing here — is this needed at all, or does an existing capability cover it?"

### Connect (Relate to Existing)

When the user describes something, relate it to an existing feature in the project. This
anchors the conversation in shared context and surfaces pattern reuse opportunities.

- "This sounds similar to how [existing feature] works. Should it follow the same pattern,
  or does something need to be different?"
- "We already have [existing capability]. Could this build on that, or is it fundamentally
  different?"

## Framing lenses (bounded internal heuristics)

These extend the **Ladder Up** move (the technique PR #376's `## Output style` ultimate-goal
rule already points at) from _altitude_ to _framing_: a request can be at the right altitude
and still be mis-framed — the wrong job assumed, an inherited constraint accepted as a given,
a failure mode never considered, a downstream ripple unforeseen. Each lens below is a
**bounded internal heuristic you reason with, never a section you perform**: apply it silently
to sharpen the Problem Statement, Architecture Decisions, or Plan risks — do **not** emit a
"Problem framing" / "JTBD" / "Five Whys" output section. Frameworks applied solo as a performed
checklist degrade into ceremony; staying internal is the whole point. Reach for one only when
the request's framing is genuinely in doubt — skip them on expert-specified, trivial, or
time-critical asks.

- **Five Whys** — _when a stated problem looks like a symptom:_ ask "why" a few times to reach
  the root cause. **Internal-only** — never interrogate the user with a chain of "why", and
  never emit a root-cause section.
- **Jobs-to-be-Done (JTBD)** — _when the user names a feature, not the underlying job:_ ask what
  job they would "hire" this to do (the progress they want in their situation). Internal
  reasoning that anchors the **User intent** read; never a performed JTBD section.
- **First-principles** — _when an inherited constraint or "the way it's done" is taken as
  given:_ strip the request to what is necessarily true and rebuild from there. Internal
  reasoning that informs **Necessity / Architecture**; never an emitted section.
- **Inversion** — _when you want to stress-test the objective itself:_ flip it — what would make
  this actively harmful, useless, or worse than doing nothing — then steer away. Internal
  reasoning that feeds **Plan risks / Edge cases**; never an emitted section.
- **Pre-mortem** — _when the plan is chosen and you want its failure mode:_ assume it has
  shipped and failed, then narrate the most likely reason (prospective hindsight). Internal
  reasoning that feeds **Plan risks**; never an emitted section.
- **Second-order effects** — _when a change ripples past its first-order fix:_ first-order
  solves X — ask what X then triggers or breaks downstream (other skills, pipeline steps,
  consumer repos). Internal reasoning that feeds **Architecture / Edge cases**; never an emitted
  section.

**Inversion vs. pre-mortem** are distinct, not redundant: inversion flips the _objective_ (what
would make this goal actively bad to pursue), while a pre-mortem assumes the _chosen plan_
shipped and failed and asks why. Inversion interrogates the goal; the pre-mortem interrogates
the plan.

## Red Flags to Probe

These signals usually mean there's missing information. Don't let them pass without follow-up.

| Signal                                  | What's likely missing                      | Follow-up                                                                           |
| --------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| User says "simple" or "just"            | Hidden complexity                          | "What could make this complicated? What edge cases come to mind?"                   |
| User says "like X"                      | Differences from X                         | "What specifically about X do you want, and what should be different?"              |
| No mention of persistence               | Whether state survives page refresh        | "Should this survive a page refresh, or is it session-only?"                        |
| No mention of other users               | Multi-user / sharing implications          | "Does anyone besides the creator need to see or interact with this?"                |
| No mention of error states              | How failures should look                   | "What should happen when [data source is down / network fails / input is invalid]?" |
| No mention of empty states              | First-run or no-data experience            | "What does this look like before the user has any [data/items/config]?"             |
| Skips directly to implementation        | Unvalidated assumptions about architecture | "Before we jump to building — what's the core thing this needs to get right?"       |
| Feature touches multiple domain modules | Unclear boundaries                         | "Which part is the most important to get right first?"                              |

## When to Stop Asking

You have enough information to draft the PRD when all of these are true:

- You can write all four PRD sections (Problem, Stories, Constraints, Open Questions) without
  inserting placeholder text
- You know which existing domain modules are involved and whether new ones are needed
- You know whether a new database table is needed (and roughly what it holds)
- You know whether the Go proxy is involved
- You can sketch the task ordering without ambiguity about dependencies
- You've asked about at least one edge case (empty state, error state, or authorization)

If any of these are still fuzzy, ask one more targeted question before proceeding.
