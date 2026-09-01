# Intent interview (adaptive) — playbook

Full contract for the intent interview: the adaptive, multi-round
question battery `/flow-pipeline` step 1 (triage) and `/flow-product-planning`
discovery (step 3's post-discovery question gate) may run before
committing to a plan direction. This file governs the interview's
**trigger**, **shape**, and **delivery mechanics**. It is a sibling to
`skills/pipeline/flow-product-planning/references/discovery-playbook.md`,
not a duplicate of it: discovery-playbook.md's Ladder Up / Ladder Down /
Fork / Challenge / Connect techniques and framing lenses supply the
**content** of a good question — what to ask and why it matters. This
file governs **delivery** — whether an interview fires at all, how its
rounds are structured, how questions are formatted and parsed, and how
the answers get persisted. Reach for discovery-playbook.md's techniques
when composing individual question bodies inside a round this file's
protocol produces.

## 1. Trigger contract

**Default: fire for change-intent requests.** Any user prompt that asks
for a code, docs, or config change is change-intent. The interview fires
by default on a change-intent request **unless** a named carve-out
applies:

- **Expert-specified with concrete anchors.** The prompt names a
  specific file, symbol, function, or line — the user already did the
  navigation work and further questions would re-litigate a decision
  they've made.
  - Fire example: "make the dashboard faster" — no anchor, "faster"
    is ambiguous (load time? refresh interval? both?).
  - Skip example: "in `bin/flow-ci-wait.ts`, bump `maxElapsed` from
    1200 to 1800" — a named file, a named constant, a concrete value.
- **Trivial.** A one-line, mechanically unambiguous change with no
  design space.
  - Fire example: "clean up the settings page" — "clean up" spans
    everything from spacing to a full redesign.
  - Skip example: "fix the typo in the README's install section" —
    trivial, no design fork.
- **Time-critical.** The user's framing signals urgency that outranks
  a multi-round conversation (a production incident, a blocking CI
  failure, an explicit "just ship it now").
  - Fire example: "add rate limiting to the export endpoint" — no
    urgency signal, and rate-limit shape (per-user? per-IP? what
    window?) is a real design fork.
  - Skip example: "prod is down, the export endpoint is 500ing on
    every request, revert whatever changed it" — urgent, and the fix
    is dictated by the incident, not a design choice.
- **Epic-launched.** The feature was launched via `flow epic launch`
  from an already-interviewed epic design (`/flow-epic-create`'s
  clarification round already resolved the open questions at the epic
  level) — re-interviewing per-feature would re-ask what the epic
  design already settled.
- **`interviewMode: "skip"` or `interview.enabled: false`.** A
  per-run `flow feature create --no-interview` override, or the
  `~/.flow/config.json` `interview.enabled` key set to `false` (see
  `docs/configuration.md`), disables the trigger outright regardless
  of judgment. The inverse override, `interviewMode: "force"`
  (`flow feature create --interview`), forces the trigger on even when a
  carve-out above would otherwise skip it.

**Safe-by-default tie-breaker.** When you cannot confidently place the
request in a carve-out bucket, default to firing the interview. The
failure modes are asymmetric here in the OPPOSITE direction from the
research pre-check's tie-breaker: skipping a genuinely ambiguous request
risks building the wrong thing (expensive — a full pipeline run, a
plan review cycle, possibly a redirect); firing on a request that turns
out to have been unambiguous costs one round the user can clear with
`proceed` (cheap — see `## 6. Escape verbs`). Do not skip a borderline
case to save a round — the safe default is to ask.

**Mechanical floor (no judgment applied, evaluated last).** Evaluate the
named carve-outs above FIRST; the floor below applies only when none of
them matched. A change-intent prompt under approximately 50 characters
with no file/symbol anchor **mechanically fires the interview** once it
has cleared every carve-out — this is a bright-line check, not a
judgment call, so it survives even when a lens above is trying to argue
for firing on ambiguity alone once no carve-out applies. "add rate
limiting" (18 characters, no anchor) fires on the floor alone,
independent of the time-critical judgment above, because no carve-out
matched it. A prompt that DOES match a named carve-out (expert-specified,
trivial, time-critical, epic-launched, or an explicit skip override) is
skipped regardless of length — the floor never overrides a matched
carve-out. This floor exists precisely because short, anchor-free
prompts are the shape most likely to be under-specified, and the
mechanical check is cheap to apply even when the judgment gates above
are close calls.

## 2. Frontier-round protocol

Model the interview as a **design tree**: each open decision is a node,
and answering it may reveal child decisions that were not previously
askable (they only become well-formed once their parent is resolved —
e.g. "should exports be synchronous or background-queued?" gates
whether "what's the queue's retry policy?" is even a coherent
question).

- **Each round asks the whole currently-askable frontier** — every
  question that is well-formed given the answers gathered so far, not
  one question at a time and not a fixed-size batch.
- **A settled answer pushes the frontier** — resolving a node may
  reveal new child questions, which join the NEXT round's frontier
  (never retroactively inserted into the round already in flight).
- **Done when the frontier is empty** — the interview ends the moment
  a round resolves with no new questions revealed, not after a fixed
  number of rounds.
- **Within a round, order most-plan-shaping first.** Put targeted
  disambiguation (the fork that changes which of two incompatible
  architectures gets built) ahead of nice-to-know polish questions
  (a copy tweak, a default value) — if the user invokes an escape verb
  mid-round (`## 6`), the highest-leverage questions have already been
  answered.
- **Confidence is a tie-break, not the order.** Among equally
  plan-shaping questions, escaped and `low`-confidence render before
  `medium`, before `high` — confidence never overrides plan-shaping
  order.

There is no numeric cap on frontier size, round count, or total
question count anywhere in this protocol — the frontier is exactly as
large as the design tree the request actually has, and the interview
runs exactly as many rounds as it takes to exhaust it.

## 3. Question format

Every question in a round renders as:

```
Q<n>. <Title>
<one or two lines of body — what the answer decides and why it matters>
  a) <option A>
  b) <option B>
  c) <option C, if a third distinct option exists>
  (freeform also accepted)
Recommended: <letter> — <one-line rationale> [confidence: high|medium|low] [anchor: <ref>]
```

- **Numbered `Q<n>`, stable across rounds.** Once a question is
  assigned `Q3`, it keeps that id even across a redirect that changes
  scope elsewhere — this is the answer-sheet numbering rule that makes
  `answer: 3a` unambiguous (see `## 5`).
- **Lettered multiple-choice options where sensible**, but freeform is
  **always** accepted alongside the lettered options — a question that
  genuinely has no clean discrete options may skip the letters
  entirely and just ask in prose.
- **One `Recommended:` line per question**, one-line rationale. This is
  what makes the vague/non-committal answer path (`## 5`) and the
  `proceed` escape verb (`## 6`) well-defined: there is always a
  concrete default to fall back to.
- The body's "what the answer decides and why it matters" line opens
  with the lens tag `(system)` / `(user)` / `(both)`; chat renders show
  only `(high)` / `(medium)` / `(low)` on the `Recommended:` line — the anchor
  stays in the on-disk artifact.
- **Every question renders under a category heading.** The frontier is
  grouped and rendered under whichever of these five named headings
  apply — a round need not use every heading, but every question that
  IS asked must sit under one of them:
  - **Intent/Goal** — what problem this solves, for whom.
  - **Desired behavior** — the concrete observable behavior once
    built.
  - **Non-goals** — what this explicitly does NOT need to do (scope
    fencing).
  - **Constraints & trade-offs** — performance, compatibility,
    security, or architectural constraints that shape the design.
  - **Quality bar** — the acceptance bar, including prose/voice/style
    expectations when the deliverable is skill prose or documentation
    (a plan to edit a `SKILL.md` or a `references/*.md` file has a
    Quality-bar question about voice/register at least as often as it
    has one about behavior).

  This taxonomy is not just a rendering scaffold — use it as the
  **coverage checklist** when composing each round's frontier: before
  finalizing a round, check whether an unasked, well-formed question
  exists under any of the five headings, not just the ones already
  populated.

<!-- flow-confidence-rubric:begin -->

**Confidence + stakes rubric.** Every unchecked `- [ ]` Open Questions entry carries a `**Stakes:**` sub-bullet, and every `**Recommended:**` line ends with `[confidence: <level>] [anchor: <ref>]`. The label is DERIVED from the anchor class — never asserted first and justified after.

- **`**Stakes:** <system|user|both> — <what degrades, for whom, if the default is wrong>`** — the lens is the only closed enum. Judge through one of two lenses: does the answer change value for the **system** (a bug fix, stability, performance, reliability) or for the **user** (a bug fix, visual appeal / UX, content)? A question that moves NEITHER is never asked: resolve it with the recommended answer, write it as a checked `- [x]` entry with `**Stakes:** none — resolved without asking` at the END of `## Open Questions`, and never put it on the answer sheet.
- **`high`** — a direct precedent the agent actually read and can cite: `[anchor: path[:line]]` (the same pattern, convention, or contract already in the repo), or a user statement `[anchor: user: "<quote>"]`. Checkable by opening the file.
- **`medium`** — a DIFFERENT anchor form from `high`, so form is the discriminant: `[anchor: adjacent: path[:line]]` (a related precedent, not the same pattern), or `[anchor: weighing: <factor> — <one line>]` with the factor from the closed list `convention | footprint | risk | reversibility | effort | symmetry`. A bare `path[:line]` on `medium` is a miss.
- **`low`** — `[anchor: inference — rises to <level> if <named evidence>]`: no in-repo anchor. When the decisive input is an unverifiable external fact, credentials/production access, or user taste, take the `**Needs user input:**` escape instead of tagging `low`.

The label is derived from the anchor class, never asserted; a rationale whose only support is `likely`, `should be fine`, `standard practice`, `best practice`, or `probably` is a `low`. Chat renders show only `(high)` / `(medium)` / `(low)` — anchors stay in the on-disk artifact.

<!-- flow-confidence-rubric:end -->

## 4. Facts-vs-decisions rule

**Look up facts, never ask them.** If the answer is discoverable by
reading the repo — an existing pattern, a current config value, how an
adjacent feature already works — go read it (per the prompt-sanity gate
and discovery's own bounded-read discipline) rather than asking the
user to restate what the codebase already says. Asking a fact-question
wastes a round and signals the interview didn't do its homework.

**Named exception — evidence-contradiction or possible-pattern-change is
a decision, not a fact.** Two cases promote a lookup into a real
question:

1. **Contradictory repo evidence.** Two files, two adjacent modules, or
   the code and a comment disagree about how something works — there is
   no single fact to look up, so ask which reading is authoritative.
2. **A request that may intend to CHANGE an existing pattern.** "Add
   retry logic to the export job" could mean "follow the retry pattern
   already used in `bin/flow-ci-wait.ts`" or "this job needs a
   different retry shape than the rest of the codebase" — the existing
   pattern is a fact, but whether to follow or diverge from it is a
   decision only the user can make, so it MAY be asked (not "look up
   the existing pattern and silently apply it").

**Stakes filter.** A question whose every answer moves no system or
user value is not asked: adopt the recommended answer and record it in
the digest's trailing "Resolved without asking (no system/user
stakes):" list instead of putting it on the frontier.

## 5. Answer parsing

Replies are parsed against the stable `Q<n>` ids from `## 3`:

- **Compact form**: `1a 2c 3: <text>` — space-separated
  `<question-number><letter>` pairs for multiple-choice answers, and
  `<question-number>: <text>` for a freeform answer to a specific
  question. Any order, any mix of the two forms in one reply.
- **Partial answers keep unanswered items on the next frontier.** A
  reply that answers 2 of 5 questions in a round resolves those 2 and
  carries the other 3 forward unchanged (they are not re-numbered,
  re-worded, or dropped).
- **Vague/non-committal answers silently adopt the Recommended
  option.** A reply like "just figure it out", "whatever you think",
  or "you decide" for a given question is **not** treated as an
  unanswered item — it resolves that question to its `Recommended:`
  option and proceeds. The interview never loops asking the same
  question a second time because the first answer was non-committal;
  a vague answer is itself a valid resolution.

## 6. Escape verbs

Three verbs let the user exit the interview loop at any round:

- **`proceed`** — accept the `Recommended:` option for every
  currently-open question (in the current round AND anywhere still
  open on the frontier) and end the interview immediately.
- **`skip interview`** — abandon the interview entirely for this
  pipeline run (equivalent to having passed `--no-interview` at
  launch) and continue with whatever context already exists.
- **`cancel`** — abandon the pipeline run itself, not just the
  interview (the ordinary pipeline-cancel semantics apply).

## 7. Persistence contract

The interview digest — every asked question, its resolution (explicit
answer, adopted recommendation, or still-open), and the category it
fell under — is persisted via:

```bash
flow-state-update --phase <triage-pending-interview|plan-pending-interview> --interview-stdin <<'EOF'
<digest>
EOF
```

The digest also carries a trailing `Resolved without asking (no
system/user stakes):` list — the Stakes-filter items from `## 4` that
never reached the frontier.

`--interview-stdin` mirrors `--answer-stdin`'s byte-verbatim transport
(immune to shell expansion and a leading `--`) but writes
`state.interview` instead of `state.answer` (`bin/flow-state-update.ts`).
Each round's write REPLACES the prior digest with the union of settled
answers so far — the digest is always the full interview-to-date, not a
delta, so a resumed session (`triage-pending-interview` → step-1
re-entry, `plan-pending-interview` → step-3 re-entry via
`flow-resume-decide`) can re-render the whole battery from
`state.interview` alone without replaying prior turns.

## 8. Pause-output-contract slot templates

<!-- any new pause site below must reference pause-output-contract.md -->

Every interview round that ends a turn follows
`references/pause-output-contract.md` — the status heading plus the
labeled-slot grammar, never open prose, ≤12 lines with overflow behind
the artifact path when a battery runs long. The recommended slot
mapping for an interview round:

```
### ❓ A few questions before I start

**Needs attention:**
<category heading>
Q<n>. <Title>
<body>
  a) <option A>
  b) <option B>
Recommended: <letter> — <rationale> (high|medium|low)

(repeat per category / question)

**Next action:** Reply with your answers (e.g. `1a 2c 3: <text>`), or
say `proceed` to accept every recommendation, `skip interview` to
continue without answering, or `cancel` to stop the pipeline.
```

The `plan-pending-interview` battery (post-discovery, re-rendering
`.flow-tmp/interview-questions.md`) uses the identical shape with the
status heading `### ❓ A few questions before I plan this out` — the
slot grammar and escape-verb `**Next action:**` line are shared verbatim
between the two pause sites; only the heading text and the
`--phase`/artifact-source pointer differ.

A third pause site — the Step-3 blind method survey's method pause
(`references/blind-survey.md`, a SECOND, distinct use of
`plan-pending-interview`) — reuses the same slot grammar for its single
question:

```
### ❓ Both blind judges recommend a different method

**Needs attention:**
Method — both blind judges independently recommended a different method
from the one you proposed:
- Judge A: "<its top recommendation's first sentence, verbatim>"
- Judge B: "<its top recommendation's first sentence, verbatim>"
Full before → after comparison: plan: <path to plan.md>#Method-selection

Q<n>. Adopt the plan's chosen method?
  a) adopt the plan's chosen method (recommended)
  b) keep my method
Recommended: a — both judges independently converged away from the
proposed method (high)

**Next action:** Reply `answer: <n>a` to adopt the plan's method,
`<n>b` to keep yours, or freeform; `proceed` accepts the
recommendation; `cancel` stops the pipeline.
```

The status heading, slot grammar, and escape-verb `**Next action:**` line
are shared verbatim across all three pause sites; only the heading text,
the question body, and the `--phase`/artifact-source pointer differ.
