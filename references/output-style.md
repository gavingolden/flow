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

## Structure every pause-point message

A pause point is any turn-ending assistant message that awaits user
input or reports a stop — a gate, a clarifying question, a gated
feedback reply, post-merge QA, an escalation, a terminal completion.
Users read those messages under scan pressure (deciding what to do
next), so open prose there costs real time: the ask and the remaining
work get buried. Every pause-point message therefore ends in the pause
block defined at
`skills/pipeline/flow-pipeline/references/pause-output-contract.md`: one
`###` status heading plus the labeled slots (`**Went wrong:**`,
`**Remaining:**`, `**Needs your review:**`, `**Notes:**`,
`**Next action:**`). Slot omission is omit-when-empty and unconditional
— a trivial answer collapses to heading + answer + Next action, which is
already the minimal compliant block; there is no "too trivial for the
block" escape. Formal helper renders (`flow-gate-summary`,
`flow-pipeline-summary`) satisfy the contract via their own
`STATUS:`/`WHY:`/`NEXT ACTION:` grammar and are never re-wrapped.

## Explain problems impact-first in plain language

The reader of a problem report has decision authority but zero project
context — sharper than "a manager", who could still be assumed to
share your team's vocabulary. This reader has been away from the
thread, doesn't recognize the tool names, the step numbers, or the
internal error strings, and has to decide from the message alone.

Adapted from structured-communication practice — BLUF, SBAR, Minto,
incident communication, plainlanguage.gov, progressive disclosure —
with no framework transplanted wholesale: none is empirically validated
for written, asynchronous, technical-to-layperson reports.

The applied contract lives at
`skills/pipeline/flow-pipeline/references/pause-output-contract.md`
`## Language contract`: the same six rules below at binding depth, plus
five worked before/after pairs (CI failure, test failure, merge
conflict, a gate decision needing a choice, honest uncertainty). This
section carries the rationale; that file is the enforceable form
agents follow at every pause point.

**1. Impact first.** A reader under decision pressure reads the first
line and decides whether to keep reading. If that line names the
mechanism ("flow-ci-wait returned ci-hang") instead of the consequence
("CI hasn't finished in 20 minutes and may be stuck"), the reader has
to reconstruct the impact themselves before they can act — the exact
work the report exists to save them.

**2. Zero internal jargon.** Tool names, step numbers, and internal
error strings are load-bearing for the agent's own bookkeeping, not for
the reader's decision. Translating them into effect keeps the message
readable without discarding traceability — the identifier can still
trail in a parenthetical for anyone who wants to dig in.

**3. Honest uncertainty.** A confident-sounding recommendation the
agent doesn't actually hold is worse than an honest "I don't know which
you mean" — it either gets rubber-stamped on false authority or gets
second-guessed and re-litigated, both worse outcomes than a symmetrical
presentation the reader can resolve in one reply. This rule sits before
"options with consequences" deliberately: manufacture no recommendation
just to satisfy the "recommendation first" ordering in rule 4.

**4. Options with consequences.** A bare option list ("A or B?") pushes
the cost/benefit analysis onto the reader, who has less context than
the agent writing the report. Naming each option's good and bad
consequence up front, recommendation first, lets the reader make the
same call the agent would in seconds instead of round-tripping for
more detail.

**5. Progressive disclosure.** Logs, diffs, and raw tool output answer
"how did we get here", not "what do I do now" — the two questions have
different readers and different urgency. Keeping the first out of the
pause block itself — above the block, or in a named artifact path —
keeps the decision-relevant text short enough to scan; a ~150-word impact summary
and a screenful block are advisory targets, not a hard cap that would
force false simplicity onto a genuinely complex report.

**6. Formal renders carry the language rules too.** The `--why` text
passed to `flow-gate-summary` follows rules 1–3 and 5 (impact-first,
jargon-free, honest, disclosure-friendly) even though its grammar is
untouched: `flow-gate-summary`'s `oneLine()` collapses the string to a
single line by construction, so a numbered options list can't render
inside it — structured options stay a markdown-pause-block concern,
never a formal-render one.

**Structured over prose.** Structured lists win for problem reports and
trade-off presentations, both read under scan pressure where the reader
is comparing options or extracting the one fact they need. Connected
prose stays for analytical reasoning and plan rationales, where the
argument depends on one sentence following causally from the last —
bullets fragment that chain into disconnected assertions the reader has
to re-thread themselves.

## Frame every explanation impact-first for a product-lens reader

Generalizes "Explain problems impact-first in plain language" above from
problem reports at pause points to every explanatory surface: fix
recaps, plan summaries, review findings, refactor rationales,
escalations, and ordinary Q&A. The reader is a user/product-manager
first and an engineer second — the first sentence answers "what does
this mean for me / the product?", not "what did the code do?". The
pause-point `## Language contract` in
`skills/pipeline/flow-pipeline/references/pause-output-contract.md`
stays the enforceable specialization of this rule; this section composes
with it by reference and does not restate its six rules.

The register is calibrated from the user's explicit picks in an
11-scenario battery (2026-08-11), not guessed:

- **Default: impact-only, concise.** Open with the user-visible
  consequence or outcome; omit mechanism and internal identifiers by
  default. Because detail is omitted by default, the standing escape is
  load-bearing: **saying "give me the technical version" (or driving an
  expert-mode exchange) gets the raw technical style at any time.**
- **Always name the concrete user-facing surface** — the command, flag,
  or artifact the user will actually touch (e.g. `flow ls --csv`) — even
  in the concise register. Concreteness about _what you get_ is not
  "technical detail"; it survives the cut.
- **CI/status notices: terse impact-first.** What was caught, what is
  protected, the next step — a narrative retelling is an acceptable
  second choice, technical-first never is.
- **Performance: felt effect with the concrete numbers kept**, the term
  of art trailing in a parenthetical — the one surface where quantified
  detail is retained by default.
- **Security: threat-model framing** — who could exploit it, under what
  conditions, with calibrated urgency: no alarmism, no false comfort.
- **Architecture decisions: a deliberate blend** — open with the
  recommendation and its user-consequence in one or two tight sentences,
  name the trade-off in impact terms, then one compact technical line
  carrying the load-bearing specifics; never a full technical
  evaluation, never verdict-only.
- **Dependency/upgrade recaps: minimal** — "fully handled, same
  commands, CI green", optionally one "what could have bitten" line.
- **Escalations: impact + "nothing is lost" + single recommended next
  step**; enumerate multiple options only when they genuinely diverge.
- **No-change explainers: reassure first** ("nothing's wrong with your
  edit"), then the one-line why, then the action that makes it take
  effect.

**Crash-detail preservation.** Impact-only framing never hides the data
needed to debug: on a crash, panic, or unhandled exception, append the
raw error excerpt in a collapsed `<details>` block below the
impact-first prose.

Worked pairs, verbatim from the picked battery variants:

**Bug-fix recap — before:** "Fixed the race in `bin/flow-new.ts`:
`writeState()` now executes inside the retry closure before
`launchSession()`, with `deleteState()` on failure. Previously
`launchSession()` could beat the state write, so `flow-state-update`
found no state file and fell through to the default branch."

**After:** "This closes the bug where a brand-new pipeline could dump
commits onto your main branch. Root cause was a startup ordering issue;
it's now impossible by construction. Nothing to do on your side —
existing pipelines are unaffected."

**Review finding — before:** "`retryFetch()` in `bin/lib/http.ts:42`
catches and discards the original error object; the final throw is
`new Error('retries exhausted')` with no `cause`. Recommend attaching
`{ cause: lastError }`."

**After:** "One finding worth fixing: failed downloads currently hide
_why_ they failed, which turns a 30-second diagnosis into a full re-run.
Two-line fix; I'd apply it now."

**Performance issue — before:** "`flow ls --cost` has an N+1: it shells
out to `gh` once per pipeline inside the render loop. O(n) subprocess
spawns at ~300ms each dominate."

**After:** "`flow ls --cost` gets slower the more pipelines you have —
each one triggers its own separate GitHub lookup (~0.3s each), so 20
pipelines means a 6-second wait. Batching them into one lookup makes it
near-constant (the classic 'N+1' pattern, for the record)."

**Security finding — before:** "`writeConfig()` uses default file mode
(0644). `config.json` may include a GitHub token. Recommend mode 0600
plus a migration chmod."

**After:** "Your GitHub token can end up in a file any process on your
machine can read. That matters on shared machines or if malware ever
lands locally; it is _not_ remotely exploitable on its own, so no
urgency panic — but it's a one-line fix and there's no reason to leave
it open."

**Escalation — before:** "`gh pr merge` exited 1: 'Base branch was
modified'. Retried ×3. Escalating."

**After:** "Merge is blocked because `main` moved underneath this PR.
Nothing is lost. Recommended: let me refresh the branch and re-verify
(~10 min). Say `merge manually` if you'd rather handle it in the UI."

### Where impact-first does NOT apply

- Machine-consumed artifacts: schema JSON envelopes, `spec.json`,
  `state.json`, result artifacts.
- Commit-message _summaries_ and format — the conventional-commit
  contract (`AGENTS.md ## Git workflow`) keeps the `type: summary` line
  technical-imperative; the commit body's `Why:` prose, however,
  follows the impact-first rule — a commit body is an explanation you
  read.
- Test Steps commands, Contract blocks, and acceptance-criteria
  commands — surgical by design.
- Code comments — governed by the "default to none; explain the _why_"
  convention.
- Expert-mode / time-critical exchanges where the user is driving
  technically — the existing "run expert requests literally" rule wins.
- Raw logs/diffs — progressive-disclosure material, referenced by path,
  never rewritten into prose.

### Per-stage focus

| Stage / surface                        | Focus                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Triage answers                         | Impact-first, heaviest — the user is deciding whether to proceed                                     |
| Plan summaries (`plan-pending-review`) | PM lens: what you get, what it costs, the one decision worth your attention — then the task skeleton |
| Pause-point problem reports            | Already governed by the Language contract (unchanged, now a specialization of this rule)             |
| Review findings                        | Consequence a user/operator would hit first; code pointer + fix mechanism second                     |
| Escalations / `NEEDS HUMAN`            | Impact + "nothing is lost" state + the single recommended next step                                  |
| Terminal recap                         | User-facing-changes lens; mechanism only where it changed something observable                       |
| Verify/CI mechanics mid-run            | Concise technical is fine — transient bookkeeping the user rarely reads                              |

## Emit instructions as scannable numbered steps

A returning reader — resuming a paused pipeline, following an escalation
recipe, working through a Test Steps list — should not have to segment a
paragraph into actions before they can start acting. Prose that runs
"attach, then inspect the log, then redirect the skill with a fix hint"
as one sentence forces the reader to do the parsing work a numbered list
already did for the author.

The enforceable form lives at
`skills/pipeline/flow-pipeline/references/pause-output-contract.md`
`## Step contract`: numbered imperative steps, one action per line,
optional indented sub-bullets for detail, and the actor named per step
when more than one party acts. That section also defines `discrete
action` (a separate copy-pasteable command or a separate decision — a
trailing qualifier on one command is detail, not a second action) and
carries the three carve-outs this rule inherits without restating them
here: a single discrete action stays inline rather than becoming a
one-item list; `- [ ]` Test Steps keep checkbox form and are never
renumbered, because the auto-merge gate counts unchecked boxes; and fact
recaps stay one-fact-per-line, since numbering a recap of what already
happened would imply an execution order that never existed.

This rule is the shape-side sibling of "Calibrate length to task" below
— that bullet already prescribes structured lists under scan pressure;
this one specifies the concrete numbered-step layout an instruction list
takes when it qualifies.

**Before:** "Attach (flow attach `<slug>`); inspect `<worktree>/.flow-tmp/`
for skill output, then redirect `/flow-new-feature` with a fix hint."

**After:**

```
1. Attach (flow attach <slug>).
2. Inspect <worktree>/.flow-tmp/ for skill output.
3. Redirect /flow-new-feature with a fix hint.
```

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
  is noise — except when the turn ends at a pause point (awaiting user
  input or reporting a stop): that turn MUST end in a pause block (see
  "Structure every pause-point message" above).
- **Calibrate length to task.** Match the form to the task, not a
  single default: structured lists for problem reports and trade-off
  presentations (read under scan pressure, options need to be
  comparable at a glance — see "Explain problems impact-first in plain
  language" above); connected prose for analytical reasoning and plan
  rationales, where bullets would fragment an argument that flows
  better as sentences; one-line answers for one-line questions. Don't
  expand a yes/no into a structured response — except pause-point
  messages, which always use the labeled pause-block slots.
- **No sycophantic openers.** "Great question", "You're absolutely
  right", "Successfully implemented…" add nothing.
- **No emojis unless the user uses them first.** Match the user's
  register; don't introduce decoration they didn't invite — except the
  pause-block status-heading glyphs (`❓`/`⏸`/`✅`/`⚠`) named in
  "Structure every pause-point message" above: those are a fixed,
  load-bearing part of the block grammar (scannable state at a glance),
  not free-form decoration, and the plan-review Option C rendering the
  user approved already used them.
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
