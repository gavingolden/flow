# Output style — full rule bodies

Offload target for `AGENTS.md` `## Output style`. That section keeps each
rule's anchored one-line opener plus its binding bar (what must/never
happen); this file holds the recipes, rationale, precedent detail, and
anti-pattern catalogues behind each opener. Read this file when you need
the _why_ or the exact verification recipe — the opener in `AGENTS.md` is
the enforceable contract.

## Verify factual claims before emitting them

Always try to verify factual claims proactively via an API request, doc
fetch, or filesystem check before propagating them into edits, PR bodies,
or scripts — especially values that have been latent/unvalidated for a
while.

**Trigger categories:** SHAs, file paths, line numbers, URLs, issue/PR
numbers, version strings, env-var names, API surface shapes (function
names, exported symbols, flag names), dates, exemption counts, deprecated
CLI flags.

**Anti-patterns to call out explicitly:** paraphrasing `AGENTS.md` from
memory in a commit Why-section, copy-pasting a prior PR body section
without re-checking its citations, citing line numbers from a stale
`Read`, claiming an exemption count that has since changed, hardcoding a
SHA from earlier in the session without re-running `git rev-parse`,
quoting a CLI flag from memory after the `--help` shape may have changed.

**Per-category verification recipes:**

| Category             | Recipe                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| line number          | `Read` the file at the exact path before citing                                                                                                                |
| SHA                  | `git rev-parse <ref>`                                                                                                                                          |
| URL                  | `curl -sI` or follow the link                                                                                                                                  |
| PR number + state    | `gh pr view <n> --json title,state,mergedAt`                                                                                                                   |
| issue number + state | `gh issue view <n> --json title,state` (the PR variant verifies PRs only — a plain issue lookup against `gh pr view` fails or surfaces the wrong record)       |
| count                | `grep -cE '<anchored-pattern>' <file>` (never unanchored substring)                                                                                            |
| CLI flag             | `<verb> --help`                                                                                                                                                |
| file existence       | `test -f <path>`                                                                                                                                               |
| exported symbol      | `grep -n '<symbol>' <module>`                                                                                                                                  |
| version              | `<verb> --version` or `jq -r .version package.json`                                                                                                            |
| env-var name         | `grep -n '<NAME>' .env.example` (the example file is the canonical source-of-truth check)                                                                      |
| date                 | `git log --format='%ad' --date=short -1 <ref>` for a commit or tag, `gh api repos/{owner}/{repo}/issues/<n> --jq .created_at` for an issue or PR creation date |

Prefer authoritative sources: official vendor docs (Anthropic, Google) and
peer-reviewed research outrank random blogs (Medium.com) — especially on
AI topics — so weight credibility by source and confirm against the
official source. When unsure, verify.

## Treat user prompts as evidence of intent, not exhaustive specifications

User prompts may contain mistakes, incompleteness, unintended scope
restriction, and misweighted goals. When a prompt names prescribed methods
(a numbered list, an explicit enumeration of moves) AND a stated
quantitative target (`<800 lines`, `30% faster`, `≤ 100ms`), your job is
to (a) identify tensions — prescribed-methods-vs-stated-target,
under-specification, conflicting constraints — and surface them in the
artifacts downstream consumers read (the PRD's `## Prompt interpretation`
section; the `/flow-new-feature` Critical Analysis row; `/flow-pipeline`
Step 3 routes non-feature tensions to the approval checkpoint), and
(b) proceed with the most-likely-correct interpretation toward the stated
goal, not the literal interpretation that fails it. The nine Task-tool
exemptions and other narrow-and-named contracts cap the scope you can take
on without authorisation; this rule governs _interpretation_ inside an
authorised scope, not scope expansion past it.

**Precedent: PR #170.** The user named four prescribed trims AND a
`<800 lines` target; the agent landed all four (`-71 lines`, finishing at
1337 — 537 above target) and reported success because the methods landed,
never surfacing that they couldn't reach the target.

**Anti-patterns:** (a) reading prescribed moves as exhaustive when the
target needs more — surface the gap and name additional safe steps in the
plan; (b) treating an aspirational target as wishful when methods fall
short — it is evidence the user wants the methods to reach it;
(c) asking for clarification when work-without-stopping is in effect —
instead surface the tension in artifacts (the PRD's Open Questions, the
Critical Analysis row) so the user can redirect at the next checkpoint.

## Consider the middle ground when a request is framed as a binary choice

When a prompt poses an either/or — "should it work like A or B?", "store
it in the URL or the database?", "fast or simple?" — the two named poles
are evidence of how the user is currently thinking, not a constraint on
the solution space. The better answer is often an intermediate option: a
subset of A's capability with B's simplicity, a phased rollout, a
config-gated default, a hybrid taking the cheap 80% of each. Name at
least one such middle-ground option alongside the two poles rather than
silently picking a pole, and surface the A / middle / B trade-off in the
artifacts downstream consumers read (the PRD's Architecture Decisions /
Open Questions, the `/flow-new-feature` Critical Analysis "Consider
alternatives" bullet) so the user can redirect at the next checkpoint.

Same family as **Treat user prompts as evidence of intent, not exhaustive
specifications.** above — a binary framing is one more way a prompt
under-specifies — and the same discipline applies: proceed with the
most-likely-correct option and surface alternatives in artifacts when
work-without-stopping is in effect. The genuinely-binary case still exists
(a boolean flag, a yes/no migration); the rule is to _check_ for a middle
ground, not manufacture one where none exists.

## Understand the ultimate goal behind the request, not just the literal ask

Find what the user ultimately wants to fix, unblock, or speed up (the XY
problem; "so that `<goal>`").

**Conditional:** run expert / trivial / time-critical requests literally;
ladder up only on ambiguous / high-blast-radius ones. Default: infer the
goal in one line and proceed, surfacing the alternative in the PRD / PR
`## Why`; ask one goal-framing question at kickoff (never mid-run) only
when genuinely unclear AND guessing wrong is costly/irreversible.

**Anti-patterns:** no "always ladder up"; no ceremonial root-cause
section; never interrogate (the framing lenses stay internal — Five Whys
especially).

**Technique:**
`skills/pipeline/flow-product-planning/references/discovery-playbook.md`
(Ladder Up + framing lenses); don't re-author it.

## Fix cheap, in-scope robustness issues now rather than deferring them

When a fix is small (a handful of lines), low-risk/mechanical, AND
directly related to code the PR touches or to a brittleness the PR itself
introduced, fix it in-PR — don't defer it to an issue or park it in
`anti_patterns_found` as an "accepted trade-off" — even when the clean fix
needs a minimal touch to an adjacent production file. "Don't add features
beyond the task's stated scope" targets unrequested feature creep, not a
trivial edit that makes the PR's own change robust; deferral stays
reserved for standalone or complex work. The full bar and its motivating
incident live in `templates/AGENTS.md.template` and `/flow-pr-review`'s
`references/fix-applier-instructions.md`.

## Treat every request as production-bound, not a hobby project

Judge scope and quality through a public-release lens.

**Scope:** the include-vs-defer test is cohesion, not size — build the
cohesive parts of the feature in-task (it shares the feature's user goal
or surface, or its absence leaves the feature partial) and suggest a
separate issue only for a genuinely separate feature; never use a
follow-up to dodge in-scope work.

**Quality:** hold a production bar — error handling, edge cases,
accessibility, tests — on the surface you touch. This raises completeness,
not feature count: the **Fix cheap, in-scope robustness issues now…** rule
and Anti-Overengineering still govern, so the standard is minimal scope at
a production standard, not gold-plating. The full bar lives in
`templates/AGENTS.md.template`.

## Satisfy local, reversible preconditions before gating a Test Step as manual

A Test Step whose only unmet preconditions are `local and reversible` is
runnable, not manual — satisfy them yourself (start the dev server, seed
the local DB, set a local `.env`, drive the repo's headless browser,
probe-then-attempt when unsure a dependency is up) before ticking or
gating. Reserve the manual gate for genuinely external/irreversible
resources or subjective judgment; this loosens no guardrail on
external/destructive/irreversible actions. Full contract
`skills/pipeline/flow-pr-review/references/manual-test-rubric.md`.

## Non-trivial UI appearance changes need an authored SUBJECTIVE approval step

The agent can't tick this itself. Full contract
`skills/pipeline/flow-pr-review/references/manual-test-rubric.md`.

## Remaining response-hygiene rules

These are shorter conventions without a dedicated lint anchor — kept here
in full since `AGENTS.md` only needs the summary list:

- **Don't echo file contents or full diffs into chat.** Read with tools
  and reference findings as `path:line`. The user can open the file;
  pasting it back wastes tokens and clutters scrollback.
- **No preambles.** Skip "Let me…", "I'll go ahead and…", "First, I'm
  going to…". State the action in one sentence and call the tool.
- **No end-of-turn summary unless asked.** The diff and the tool calls
  are the record. A trailing recap of what the user just watched you do
  is noise.
- **Calibrate length to task.** Prose paragraphs over bullets for
  analyses and explanations — bullets fragment reasoning that flows
  better as connected sentences. One-line answers for one-line
  questions. Don't expand a yes/no into a structured response.
- **No sycophantic openers.** "Great question", "You're absolutely
  right", "Successfully implemented…" add nothing.
- **No emojis unless the user uses them first.** Match the user's
  register; don't introduce decoration they didn't invite.
- **Don't apologize for errors — just correct.** "Sorry, you're right,
  let me fix that" is filler. Make the correction.
- **Don't narrate internal deliberation.** Think between tool calls, not
  in chat. The user does not need to read your reasoning loop; they need
  the conclusion and the next action.
- **Implement fully — no `// rest of code` placeholders.** Stay in
  scope: don't refactor unrelated code, don't introduce new abstractions
  the task didn't ask for, don't half-finish.
- **Fenced blocks only for multi-line runnable code.** Use inline
  backticks for paths, identifiers, flags, and short snippets. A fenced
  block around a single command or filename is visual overhead.
