# Goal

flow is a CLI that drives an LLM coding pipeline (plan, implement, verify, review, merge). The pipeline's top-level supervisor runs on Claude Code and stays there. Several individual pipeline phases (cross-model plan review, a diff-only intent guess, a review lens, web research gathering and refutation, a pre-planning method survey, optional codebase scouting and optional review lenses) can be handed to a second agent CLI ("agy") that runs on a Google AI Ultra subscription and exposes multiple model families (Gemini, Claude, GPT-OSS).

Google has shipped a new flagship model family. The older Gemini generation that several of those phases were tuned for is no longer available, so the phases were pointed at the new model as a stopgap without any measurement of whether it does the job well.

The outcome wanted: trustworthy, per-phase evidence of how the new model performs on each agy-capable phase compared with what those phases would otherwise run on, so the maintainer can decide — in a follow-up conversation, not automatically — which phases should use which model.

# Non-goals

- Do not change any phase's production model choice in this piece of work; produce evidence and a recommendation per phase only.
- Do not build new hand-off mechanisms that would let code-writing phases (implementation, fix application, planning discovery, merge-conflict resolution) run on the second CLI.
- The supervisor itself is out of scope.

# Question for you

What is the best method to reach this outcome? Recommend an approach.
