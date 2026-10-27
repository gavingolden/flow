## Step 3 — Plan

Contents: Blind method survey · Invocation threading · Deterministic forced research · Deterministic note backstop · Follow-up-reference consistency backstop · Auto-bundle revision pass · Plan-shape backstop · Design-spec validation backstop · Blind product critic · Cross-model plan review · End conditions · Question-gate branch · At most one question-gate fire per pipeline

**Phase:** `planning`

Invoke `/flow-product-planning` in-process with the user's verbatim
request as the argument:

```
/flow-product-planning <verbatim user description>
```

Fold the **ultimate goal** you inferred in step 1's goal-framing sub-step
into this invocation as explicit context (append it after the verbatim
request) so the Discovery Subagent anchors the PRD Problem Statement on it;
discovery still validates the goal against the codebase and surfaces an Open
Question if it disagrees — see `discovery-instructions.md` §3 ("User intent").

**Blind method survey (before forced research and discovery).** Before the
invocation-threading pass below, and before forced research, run the
Step-3 blind method survey: gated on `state.interview` non-empty, the
survey file absent, and `flow-module-status --check research` — on a pass,
author a goal-only brief from step-1's goal line plus goal-level interview
answers (NEVER the raw description or the user's method), and run
`flow-blind-survey --brief-file … --description-file … --out
"$WORKTREE/.flow-tmp/blind-survey.md" --worktree "$WORKTREE"` launched
detached (`flow-spawn --detach`) and awaited with `flow-plan-review-wait
--complete-line --pid` in re-armed steps — never one blocking Bash call
(recipe and give-up rule: [references/blind-survey.md](../blind-survey.md)).
Branch on `{ran}`, never the exit code; print
one chat line either way (`blind survey: A=… B=…` or `blind survey
skipped — <reason>`); on `ran:true`, thread a `SURVEY:` marker below. Runs
once per pipeline — a revision pass reuses the existing survey file. On a
`ran:true` pass, the post-discovery plan-shape lint backstop also passes
`--survey-ran` so a missing `## Method selection` section is a named miss.
Full gate/brief/run contract: [references/blind-survey.md](../blind-survey.md).

**Invocation threading.** Before invoking `/flow-product-planning`, thread up
to seven marker lines onto the same append channel as the inferred ultimate
goal — full contract for each in
[references/step3-threading.md](../step3-threading.md); none add a
new Task-tool exemption or spawn site (all are markers on the existing
Discovery exemption, #2 in Hard rules):

- **Per-phase model (planning) threading** — append `MODEL_PLANNING: <alias>`
  when `state.modelPlanning` / `config.models.planning` resolves non-empty
  ([references/model-routing.md](../model-routing.md)).
- **Force-on threading (mandatory)** — when `state.forceResearch == true`,
  append `RESEARCH: force-on (flow feature create --research)`.
- **Revision-pass threading (on step-3 re-entry)** — when
  `<worktree>/.flow-tmp/plan.md` already exists, append `REVISION: <n>` so
  discovery runs its Revision pass mode (`discovery-revision.md`; also on the auto-bundle re-entry).
- **Epic-membership threading** — when `.epic` is set, append
  `EPIC: <slug>/<featureId> (design at .flow/epics/<slug>/design.md)`.
- **Prompt-sanity threading** — on a `suspect` step-1 verdict, append `PROMPT-SANITY: <note>`.
- **Interview threading** — when `state.interview` is non-empty, append
  `INTERVIEW: <digest>` so discovery treats the persisted intent-interview
  answers as load-bearing user clarifications (full contract:
  [references/step3-threading.md](../step3-threading.md)).
- **Blind survey threading** — append `SURVEY: <path> (judges: …)` when
  the survey ran (full contract: [references/blind-survey.md](../blind-survey.md)).

**Deterministic forced research (mandatory on the forced path).** The
discovery subagent's own Step 1.5 was observed to skip the fan-out even when
forced, so on the `forceResearch == true` path you MUST ALSO run the research
yourself BEFORE invoking `/flow-product-planning`: probe
`flow-module-status --check research` (non-zero ⇒ module deselected, notice
already emitted — note the skip and proceed to planning appending nothing),
then launch `flow-research-run --task "<verbatim user description>" --out
"$WORKTREE/.flow-tmp/research-findings.md" --status-file
"$WORKTREE/.flow-tmp/research-status.json"` detached (`flow-spawn --detach`,
the status file removed first) and wait on that status file with
`flow-plan-review-wait --complete-line --pid` in re-armed steps (give-up =
the research limit + 5 minutes, reason `research-timeout`; recipe in
step3-threading.md), folding non-empty findings into
the invocation through the same channel, clearly labelled `RESEARCH FINDINGS
(web-grounded, pre-run by supervisor — use as prior context, do NOT re-run
the fan-out):`. This self-degrades to a graceful skip when agy is unavailable
and NEVER blocks planning; full bash in
[references/step3-threading.md](../step3-threading.md#deterministic-forced-research-mandatory-on-the-forced-path).

`/flow-product-planning` is a thin wrapper that spawns one **Independent
Discovery Subagent** via the Task tool (exemption #2 in "Hard rules"
above) in its own isolated context, writing the consolidated artifact to
`<worktree>/.flow-tmp/plan.md` plus a PR-description draft to
`<worktree>/.flow-tmp/pr-description-draft.md`. The wrapper creates
`.flow-tmp/` before spawning; the supervisor never sees the discovery
transcript, only the wrapper's brief return summary. Full spawn contract
in [references/exemption-contracts.md](../../../../../references/exemption-contracts.md); the discovery method in
`skills/pipeline/flow-product-planning/references/discovery-instructions.md`.

After the wrapper returns, **read `<worktree>/.flow-tmp/plan.md`** once
and print the plan-summary block to chat per `references/pause-output-contract.md`
— six labeled slots, no open prose, ≤12 lines, ≤2 bullets per slot. Author
the TLDR per [TLDR and WHY authoring (product brief)](shared-gate-contracts.md#tldr-and-why-authoring-product-brief).
(template: `### ⏸ Plan ready for review` / `**TLDR:** <one sentence,
≤35 words: the outcome, then what was wrong or missing before (reuse the
plan's drafted PR TLDR), suffixed `(N zero-stakes questions resolved
without asking)` when N checked `**Stakes:** none` entries exist — the
suffix is chat-only: not counted against the cap, never passed to
`--tldr`>` /
`**Unsolved:** <open answer-sheet items with their `(high)`/`(medium)`
tag and recommended default inline, anchors omitted>` / `**Needs
attention:** <high-stakes decisions read from `## Decision analysis` +
`## Architecture Decisions`, each stated as before→after (from
`## Behavioral contrast`) plus the option chosen and why, plus every
crucial-and-uncertain item (`[confidence: low]` or `**Needs user
input:**`, each carrying the stable `Q<n>` id discovery's numbering rule
assigns to both) as `Q<n> (low): <question> — default: <recommended>`
for a genuine low-confidence recommendation, or `Q<n> (needs input):
<question> — default: none` for a `**Needs user input:**` escape (which
has no `**Recommended:**` line by contract, so it is never rendered as
`(low)`), taking the ceiling first and collapsing to `+N more uncertain — plan:
<path>#Open-Questions` above two, plus one
`Method: <user's> → <chosen> (survey: <verdict>)` line when
`## Method selection` is present, plus one `Vetting: <verdict>` line (the
`## Request vetting` `- **Verdict:**` value, verbatim) whenever the
verdict is not `adopt`, plus one
`Existing code: <gain or loss in product terms> — simplify|rewrite <the surface, described, anchors omitted>` line
(from `## Existing-code assessment`) whenever any verdict is not `keep`, plus one
`Scope: N tasks, M files` line, plus any material risk from
`## Plan risks`>` / `**Untracked:** <the candidate list, one line
each>` / `**Next action:** approve / redirect: … / cancel — plan:
<path>`). **task titles and file lists are not echoed** — the plan
file is the only place they live; the sole scale signal is the
`Scope:` line, counted from `# Task breakdown`'s `**Files:**` lines.
<!-- any new pause site below must reference pause-output-contract.md -->
This is the supervisor's single read of the plan file — the wrapper does
not pre-read it. While plan.md is open, surface any discovery research
skip-note it carries: a `> [!NOTE]` line about **Web-grounded research
(discovery Step 1.5)** being skipped, so the user sees why no research ran
and how to force it (`flow feature create --research`). Reuse this
read — do **not** open plan.md a second time.

**Deterministic note backstop (mandatory, non-skippable).** The discovery
subagent's `> [!NOTE]` is best-effort and has been observed to be skipped, so
after the plan.md read ALWAYS run `flow-research-note ensure --plan-file
"$WORKTREE/.flow-tmp/plan.md" --forced "$(jq -r '.forceResearch // false'
~/.flow/state/<slug>.json)"` (idempotent; self-no-ops when research ran, the
path was dormant, or a note already exists). When its stdout is non-empty,
include that line **verbatim** in the plan-summary block. Full contract in
[references/step3-threading.md](../step3-threading.md#deterministic-note-backstop-mandatory-non-skippable).

**Follow-up-reference consistency backstop (advisory, deterministic).** After
the note backstop and BEFORE the cross-model plan review below, run
`flow-candidate-issues --lint --plan-md-file "$WORKTREE/.flow-tmp/plan.md"`
(`LINT_RC=$?`) so a plan whose prose references a follow-up missing from
`# Candidate follow-up issues` never ships silently. **Advisory and
non-blocking** — a non-zero exit surfaces a one-line note in the chat
summary, never blocks planning. Full contract in
[references/step3-threading.md](../step3-threading.md#follow-up-reference-consistency-backstop-advisory-deterministic).

**Auto-bundle revision pass (bounded, once per pipeline).** A
`bundlingMisses` entry additionally composes an `AUTO-BUNDLE REDIRECT`
payload from `flow-candidate-issues --lint`'s `.bundlingMisses[].index`
(the same `pull #N into the plan` payload step 4 documents) and re-enters
`/flow-product-planning` once, gated by the
`$WORKTREE/.flow-tmp/auto-bundle-pass` marker file — a persisted miss
after that single pass surfaces in `**Needs attention:**` and the
pipeline proceeds. No new pause phase, no `AskUserQuestion`, rides
Discovery exemption #2. Full contract in
[references/step3-threading.md](../step3-threading.md#auto-bundle-revision-pass-bounded-once-per-pipeline).

**Plan-shape backstop (advisory, deterministic).** Right after the
follow-up-reference backstop above, independently lint the plan's shape via
`flow-plan-lint --plan-md-file "$WORKTREE/.flow-tmp/plan.md"` when the helper
is on `PATH` (tolerant skip otherwise) — malformed plans are named in chat
even when discovery's own self-check was skipped. **Advisory and
non-blocking**, same as above. Full contract in
[references/step3-threading.md](../step3-threading.md#plan-shape-backstop-advisory-deterministic).

**Design-spec validation backstop (deterministic, advisory).** After the
follow-up-reference consistency backstop above and BEFORE the cross-model
plan review below, run `flow-design-spec validate` against
`.flow-tmp/design/spec.json` when present (existence-gated no-op otherwise).
On exit 1/2, capture the reason into `DESIGN_SPEC_REASON` and surface it in
both the chat summary and the awaiting-approval gate's `--why` string below
(`design spec INVALID: $DESIGN_SPEC_REASON`) — never a `NEEDS HUMAN` halt.
Full bash + worked example in
[references/step3-threading.md](../step3-threading.md#design-spec-validation-backstop-deterministic-advisory).

**Blind product critic (brief-gated, once per step-3 pass).** Gate: `review.product`
not `false`, a brief resolves, and `product-critique.md` is absent or stale (archive
the prior file). **Load the Task tool before spawning** — on missing schema escalate
`NEEDS HUMAN: task-tool-unavailable: product-planning-critic`. Spawn ONE
`flow-product-critic` agent (Discovery exemption #2, no nesting; general-purpose
fallback) with the plan/brief paths, request, goal, and output path. Reconcile once
into `### Product critique (blind)` (last under `## Open Questions`), never dropping a
point silently, and add a `Critique: N points — ...` line to `**Needs attention:**`
when N > 0. Full contract:
[references/step3-threading.md](../step3-threading.md#blind-product-critic-brief-gated-once-per-pipeline).

**Cross-model plan review (Layer 2, optional, config-gated).** After the
note backstop above and BEFORE the End conditions branch below, run one
bounded cross-model review pass (one or two reviewers by depth) of the
plan's consequential decisions — fires for **ANY** intent, before the
feature/non-feature end-condition split. Bash `flow-delegate` (AGY) fan-out, same mechanism as
`/flow-pr-review`'s Gemini lens, spawns **no Task** (Hard rules' "Bash
fan-out, not an eighth exemption"). Three-part gate: `review.gemini == true`
in `~/.flow/config.json` (same key the Gemini lens uses), AND a non-empty
`## Decision analysis` section in plan.md **or** a granted epic feature
(`$EXEC_SCOPE` reads `granted: true` — the one
`flow-exec-review status --slug "$FLOW_SLUG"` probe step 3 runs per pass,
set in the route block under **End conditions**; when this gate is reached
first, run that same line in the gate's first Bash call and reuse the value
rather than probing again; then pass `--require-review` on every `flow-plan-review` call below, which
bypasses only the Decision-analysis part), AND
`flow-module-status --check research` passing (`flow-plan-review` is a
`research` helper; the check emits its own named notice); when **any** part
fails, record the reason in the chat summary and skip this sub-step unchanged.

When all three fire, run the review through the async wake ladder below,
mirroring step 7's `flow-ci-check`/`flow-ci-wait` ladder (both new calls
are sub-second, so no explicit `timeout:` override is needed): **(1)**
foreground `flow-plan-review --start --plan-file
"$WORKTREE/.flow-tmp/plan.md" --out "$WORKTREE/.flow-tmp/plan-review.md"
--worktree "$WORKTREE"` — a `ran` field means today's gate-skip branch,
proceed straight to the branching below with no further ladder steps;
`status:"started"` (`reattached` true or false) means a worker is live, go
to (2). **(2)** foreground `flow-plan-review --check --out
"$WORKTREE/.flow-tmp/plan-review.md"` — `decided` branches on the wrapped
envelope (`.status` stripped) exactly as below; `waiting` goes to (3).
**(3)** background the waiter — `flow-spawn --class default --
flow-plan-review-wait "$WORKTREE/.flow-tmp/plan-review.md.run.json"
--max-sec 540` — its completion notification re-runs (2), never a resumed
loop. **(4)** on a missed wake: a bounded Monitor `until` loop or
`ScheduleWakeup` ending in the same `--check`; if neither fires before
turn-end, `flow-state-update --phase plan-review-pending` and re-run (2).
Branch on the `{ran}` envelope
(never the exit code): `ran:false` records `skipReason` and proceeds
unchanged. `skipReason` splits into two classes: an environment skip (e.g.
`agy-not-found`) is a genuine no-op, but `reviewer-empty` /
`reviewer-not-engaged` / `reviewer-timeout` mean the review RAN and
produced nothing usable — surface those three distinctly in the chat
summary (never folded into "agy unavailable" prose), naming
`partialArtifactPath`/`stderrTail` when present. The other two terminal
skips are `review-timed-out` (`--check`'s give-up cap fired) and
`reviewer-worker-died` (detached worker vanished, no result); both differ
from `reviewer-timeout`, where the envelope survived one killed agy call. An `agy-model-unavailable` reviewer skip renders in the chat summary as "reviewer N's model is no longer offered by agy — run `flow doctor`" and rides the awaiting-approval `--why` as a demoted reviewer.
`ran:true` weighs each material AGY point as INPUT (never a verdict), revises plan.md **once**
where warranted, and appends a `### Cross-model review (AGY)` subsection
recording each point **accepted** or **overridden** — also record the
run's `depth` and, per reviewer, `model`/`ran`/`skipReason`/`lensesEngaged`
(as N/7) in the chat summary; a demoted reviewer also carries a one-liner
into the awaiting-approval gate's `--why` string, same precedent as
`design spec INVALID` above. The `Adversarial premise` lens (lens 7)
finding is appended to `## Request vetting` as one
`- **Cross-model case against:** <one line>` (exempt from the ≤12-line
ceiling and from the re-fire hash below); when that finding is material
against an `adopt` verdict — it cites evidence the section missed — the
same revision upgrades the verdict to
`adopt-with-conditions: address <finding>`, never leaving `adopt` beside
a contradicting cross-model case; when the section's `- **Sources:**`
line reads `no outside source:`, the render suffixes `(ungrounded)` in
that same revision. **Convergence rule (deep tier):** applies
ONLY when `reviewers[]` holds exactly two `ran:true` entries — a point
BOTH raised independently is **presumptively accepted**, overriding it
needs a named rationale in that subsection; otherwise (any reviewer
demoted/skipped) every point stays single-reviewer INPUT, same as today.
Then embed the marker hash — run `flow-plan-review --print-hash --plan-file
"$WORKTREE/.flow-tmp/plan.md"` on the FINAL revised plan (never the
pre-revision envelope hash, which would falsely re-fire the next pass) and
embed its stdout as `<!-- flow-plan-review-hash: <sha> -->` inside the
appended subsection.

This is a **bounded single-pass per step-3 pass** — at most one review
and one revision, not an unbounded loop. On re-entry the helper re-fires
ONLY when one of the FOUR hashed inputs — the `**Goal:**` line,
`## Decision analysis`, `## Cut list`, or `## Request vetting` — materially changed since the
last reviewed revision, emitting `{ran:false,
skipReason:"decision-analysis-unchanged"}` on a hash match; record that
skip as a one-line chat-summary rationale and never hand-force a
re-review. Full mechanics (the hash-embedding footgun, the
normalized-diff re-fire detection) in
[references/step3-threading.md](../step3-threading.md#cross-model-plan-review-layer-2--re-fire-hashing-detail).

**End conditions:**

Before branching on intent, check `.flow-tmp/plan.md` for a
prompt-vs-target tension flag and the blind survey's verdict via the
`flow-step3-route` helper. This runs for EVERY intent, not just
non-feature — without hoisting it above the split, a `converge-against`
survey verdict would pause a non-feature pipeline but silently skip the
pause for a feature-intent one, the exact prompt-vs-target-tension gap
the AGENTS.md `## Output style` rule **Treat user prompts as evidence of
intent, not exhaustive specifications.** exists to close:

```bash
METHOD_RESOLVED=$([ -f "$WORKTREE/.flow-tmp/method-resolved" ] && echo 1)
ROUTE=$(flow-step3-route --intent "$INTENT" --plan-md-file "$WORKTREE/.flow-tmp/plan.md" ${METHOD_RESOLVED:+--method-resolved})
EXEC_SCOPE=$(flow-exec-review status --slug "$FLOW_SLUG")
```

`$EXEC_SCOPE` rides in the same Bash call, so a non-epic pipeline pays no extra
turn; it is the single executive-scope probe for this pass (the cross-model
gate above reads the same value).

The helper at `bin/flow-step3-route.ts` returns one of three decisions.
The four-cell Prompt-Interpretation matrix it implements (feature/non-feature
× Prompt-Interpretation absent/`methods plausibly reach target`/any other
Recommended path) is documented at
`skills/pipeline/flow-product-planning/references/discovery-prompt-interpretation.md`
"Prompt interpretation (conditional)" — the four enum values live there
only and the helper exact-matches against them. The blind survey's
`## Method selection` verdict adds a second axis — full precedence in
[references/blind-survey.md](../blind-survey.md).

- **`$ROUTE` is `pause-for-method`** (either intent) → both judges ran
  and independently recommended a method materially different from the
  user's (`- **Survey verdict:** converge-against`), unresolved this
  pipeline. Write the question to `.flow-tmp/interview-questions.md`,
  persist via `flow-state-update --phase plan-pending-interview
  --interview-stdin`,
  <!-- any new pause site below must reference pause-output-contract.md -->
  render the `### ❓ Both blind judges recommend a different method`
  template per `references/pause-output-contract.md`, end the turn. On
  reply: `--phase planning --interview-stdin`, `touch "$WORKTREE/.flow-tmp/method-resolved"`
  (marker `$METHOD_RESOLVED` derives from), then re-run the route block above
  (keep-mine: one `REVISION:` pass first). Full protocol in
  [references/blind-survey.md](../blind-survey.md) "The method pause".

- `$ROUTE` is `route-to-step-4` and intent is `feature` → **granted epic
  feature first:** when `$EXEC_SCOPE` (the route block's
  `flow-exec-review status --slug "$FLOW_SLUG"` line) prints
  `granted: true`, run step 4's
  [Executive review (granted epics)](step-04-approval.md#executive-review-granted-epics)
  BEFORE writing `plan-pending-review` (phase stays `planning`); its
  `approve` continues straight into step 5 in this turn, its `challenge` loops
  back to this step, and `defer` / `ran: false` fall through to the rest of
  this bullet. Otherwise write `phase: plan-pending-review`. Then,
  immediately before ending the turn:

  **Candidate follow-up issues disclosure.** Discovery lists
  follow-up candidates in the plan, ticked (`- [x]`) only when their
  value-prop block clears the bar, in `# Candidate follow-up issues` —
  see
  `skills/pipeline/flow-product-planning/references/discovery-instructions.md`,
  so there is no separate curation form here; the plan-review checkpoint
  below IS the curation checkpoint. Run `flow-candidate-issues
  --plan-md-file "$WORKTREE/.flow-tmp/plan.md" --details` and, when its
  output is non-empty, echo its output VERBATIM as assistant prose
  before the AWAITING APPROVAL block — same discipline as the
  Gate-stage echo-verbatim recap, never compose the ranked block from
  the `.json` fields by hand. Document the reply verbs available at
  `plan-pending-review` in that same message: `pull #N into the plan`
  (fold candidate #N's text into the plan, ticked or not — an
  Imperative scope/plan redirect back to step 3), `drop candidate #N`
  (mechanical: `flow-candidate-issues --plan-md-file
  "$WORKTREE/.flow-tmp/plan.md" --untick <N>`, confirm in one line,
  stay at `plan-pending-review`), `drop all candidates` (same
  mechanical untick, bulk form — read `flow-candidate-issues
  --plan-md-file "$WORKTREE/.flow-tmp/plan.md" --json` and pass every
  1-based index whose `.candidates[].ticked` is `true` to a single
  `--untick <indices>` call), `file candidate #N` (mechanical:
  `flow-candidate-issues --plan-md-file "$WORKTREE/.flow-tmp/plan.md"
  --tick <N>`, confirm in one line, stay at `plan-pending-review`), and
  `defer task #N` (one or many task
  numbers in one reply — batches ALL of them
  into ONE bounded revision pass back to step 3; see step 4's redirect
  classification below and `references/redirect-handling.md`).

  **Answer sheet (unresolved plan questions).** When `plan.md` still
  carries unresolved `**Needs user input:**` items and/or `## Decision
  analysis` forks the interview (or discovery) left open, render them
  as a numbered answer sheet ABOVE the AWAITING APPROVAL block — stable
  `Q<n>` ids, one line each naming the open item and, where discovery
  recorded one, its recommended resolution. Document the `answer:
  <sheet>` reply verb in the same message (e.g. `answer: 1a 2: use the
  existing retry pattern`) — step 4 classifies it as ONE batched
  Imperative scope/plan revision redirect back to step 3 (see
  `references/redirect-handling.md`), the same disposition as `pull #N
  into the plan` above, never as a fresh interview round. Items render
  escaped and `[confidence: low]` first, then `medium`, then `high` —
  `Q<n>` ids are untouched by this display order. A missing
  `[confidence: …]` tag or missing `**Stakes:**` line (a pre-change
  `plan.md` on resume) reads as `medium`, is never promoted, and never
  errors.

  **Untracked items at plan-pending-review.** When the `**Untracked:**`
  slot lists items carried over from a prior pipeline run of this same
  slug (rare — usually empty this early), document `file #N` (calls
  `flow-untracked file <N>`, mechanical, one-line confirmation, stays
  at `plan-pending-review`) and `drop #N` (`flow-untracked drop <N>`,
  same discipline) as additional reply verbs in the same message —
  distinct from `pull #N into the plan` / `drop candidate #N` above,
  which act on plan.md's own candidate list, not the untracked list.

  Then render the AWAITING APPROVAL block via `flow-gate-summary` so
  the header rows precede the two markdown bullets the user clicks:

  ```bash
  WHY="plan ready for review (intent=feature)"
  [ "$SPEC_RC" != "0" ] && WHY="$WHY; design spec INVALID: $DESIGN_SPEC_REASON"
  LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)
  # Author the TLDR per [TLDR and WHY authoring (product brief)](shared-gate-contracts.md#tldr-and-why-authoring-product-brief).
  TLDR="<one sentence, ≤35 words: what you get, then <the thing> used to <problem>; now <new behaviour> — reuse the plan's drafted PR TLDR>"
  flow-gate-summary --status awaiting-approval --echo-prose \
    --why "$WHY" \
    --worktree "$WORKTREE" \
    --plan-file "$WORKTREE/.flow-tmp/plan.md" \
    --lens "$LENS" \
    --tldr "$TLDR" \
    --untracked-file <(flow-untracked render --format gate --unfiled-only)
  ```

  Then echo the recap per [Gate-stage echo-verbatim
  recap](shared-gate-contracts.md#gate-stage-echo-verbatim-recap---echo-prose). At AWAITING
  APPROVAL no reviewable artifact exists yet, so `flow-gate-summary
  --echo-prose` renders only the plan-file bullet — every other field
  (PR URL, review/CI/count) is the literal `none`.

  The helper renders two bullets as the **last** lines of the message —
  the worktree absolute path first, the plan file's absolute path
  (`$WORKTREE/.flow-tmp/plan.md`) second, as OSC 8 hyperlinks on a
  terminal and bare text otherwise (`bin/lib/link.ts`). **No trailing
  punctuation on either bullet line, and no prose after them** — the
  fallback where hyperlinks are unsupported and bare-URL
  auto-detection swallows a trailing dot, breaking the click
  target. Rendered example:

  ```
  STATUS: AWAITING APPROVAL
  WHY: plan ready for review (intent=feature)
  NEXT ACTION: reply approve / redirect <new direction> / cancel
    - /Users/you/code/me/flow-my-feature
    - /Users/you/code/me/flow-my-feature/.flow-tmp/plan.md
  ```

  **Plan-review clear point (auto-checkpoint arm).** After writing
  `phase: plan-pending-review` and before ending the turn, arm a
  lightweight checkpoint so the user can `/clear` at `plan-pending-review`
  and approve on a fresh session. Run `flow-checkpoint --probe --site plan-review`,
  branch on `jq -r '.verdict'`, and only on `write` write a minimal
  one-line pointer to the path `flow-checkpoint --path` prints (a still-fresh
  manual note — `verdict: preserve` — wins and is left untouched). Then
  `flow-checkpoint --site plan-review` to arm the marker and record the freshness receipt, then echo its `checkpointed: ` stderr line verbatim as the last line of the turn, per the [Checkpoint arm signal (echo-verbatim)](shared-gate-contracts.md#checkpoint-arm-signal-echo-verbatim) subsection.
  No helper change is needed: `plan-pending-review` is non-terminal, so
  `flow-resume-decide` already resolves it to step-4 and the
  `SessionStart:clear` hook already fires on it when the marker is present.
  `flow-checkpoint --consume` in Resume mode re-injects and retires the body
  like every other resume — archiving it to `checkpoint.consumed.md` (same
  directory), clearing the receipt.

  Format the rest of the pause per `references/pause-output-contract.md` — labeled slots, no open prose, appended under the plan-summary block's heading (template: `approve / redirect: … / cancel`, the plan re-renders on resume); the echoed `checkpointed: ` line above is the arm signal, not the `**Next action:**` slot, and stays a separate trailing line rather than being folded into it.
  <!-- any new pause site below must reference pause-output-contract.md -->

  Then end the turn. Wait for the user to attach and respond.
  The next turn re-enters at step 4.
- `$ROUTE` is `advance-to-step-5` or `route-to-step-4` and intent is
  non-feature (`bug`/`refactor`/`docs`/`infra`/`chore`) → `$ROUTE` was
  already computed above (either intent shares one `flow-step3-route`
  call); this is the structural enforcement for the AGENTS.md `## Output
  style` rule **Treat user prompts as evidence of intent, not
  exhaustive specifications.** for non-feature intents — without this
  check, a non-feature prompt that names BOTH prescribed methods AND a
  quantitative target would silently run to merge with no user
  checkpoint, even when discovery flagged that the methods can't reach
  the target.

  - **`advance-to-step-5`** → no `## Prompt interpretation` section OR
    Recommended path `methods plausibly reach target`, AND (no survey
    ran OR verdict `converge-with` OR a resolved `converge-against`),
    AND the `## Request vetting` verdict is not `push back`.
    The plan still exists on disk for traceability, but the
    user wasn't asked to ratify it — fall through to step 5 directly in
    the same turn, no candidate-issues checkpoint fires here (there is
    no turn-ending message to attach one to on this fully-autonomous
    path). **Disclosure obligation:** any bundled tasks and ticked
    (bar-clearing) `# Candidate follow-up issues` items proceed exactly as
    discovery authored them; disclose them in the PR body's `Bundled:` Key
    decisions bullets and in the terminal recap, so the user still sees
    what shipped even though nothing paused for their review.

  - **`route-to-step-4`** → the section is present and the
    Recommended path is one of `extend scope with named additional
    safe steps` / `relax target` / `split into multiple pipelines`, OR
    the survey ran and the verdict is `split`, OR the
    `## Request vetting` verdict is `push back`.
    Write `phase: plan-pending-review`. Then, same as the feature-intent
    End condition above, run `flow-candidate-issues --plan-md-file
    "$WORKTREE/.flow-tmp/plan.md" --details` and, when its output is
    non-empty, echo its output VERBATIM as assistant prose immediately
    before the AWAITING APPROVAL block, with the same reply-verb
    documentation (`pull #N into the plan`, `drop candidate #N`, `drop
    all candidates`, `file candidate #N`, `defer task #N`) — this branch
    also lands in step 4, so the user needs the same curation surface.
    Then render the
    AWAITING APPROVAL block via `flow-gate-summary` — same call shape
    as the feature-intent branch above, but with a Why string that
    names the tension flag (and, on `split`, the survey verdict —
    `flow-gate-summary` never parses plan sections, so this is the
    `Method:` line's only channel here):

    ```bash
    SURVEY_VERDICT=$(sed -n 's/^- \*\*Survey verdict:\*\* *//p' "$WORKTREE/.flow-tmp/plan.md" | head -1)  # colon form only; flow-step3-route.ts (authoritative) also tolerates drift; display only
    USER_METHOD=$(sed -n "s/^- \*\*User's method:\*\* *//p" "$WORKTREE/.flow-tmp/plan.md" | head -1)
    CHOSEN_METHOD=$(sed -n 's/^- \*\*Chosen method:\*\* *//p' "$WORKTREE/.flow-tmp/plan.md" | head -1)
    VETTING_VERDICT=$(sed -n 's/^- \*\*Verdict:\*\* *//p' "$WORKTREE/.flow-tmp/plan.md" | head -1)
    EXISTING_CODE=$(sed -E -n 's/^- \*\*[^:]*:\*\* (simplify|rewrite) — (.*)/\1 — \2/p' "$WORKTREE/.flow-tmp/plan.md" | sed -E 's/ *\[anchor:[^]]*\]//g' | head -1)
    if [ "$VETTING_VERDICT" = "push back" ]; then
      WHY="plan ready for review (intent=$INTENT, ## Request vetting verdict: push back)"
    else
      WHY="plan ready for review (intent=$INTENT, prompt-interpretation tension)"
    fi
    [ -n "$EXISTING_CODE" ] && WHY="$WHY; Existing code: $EXISTING_CODE"
    [ -n "$SURVEY_VERDICT" ] && WHY="$WHY; Method: $USER_METHOD -> $CHOSEN_METHOD (survey: $SURVEY_VERDICT)"
    [ "$SPEC_RC" != "0" ] && WHY="$WHY; design spec INVALID: $DESIGN_SPEC_REASON"
    LENS=$(jq -r '.output.lens // "pm"' ~/.flow/config.json 2>/dev/null)
    # Author the TLDR per [TLDR and WHY authoring (product brief)](shared-gate-contracts.md#tldr-and-why-authoring-product-brief).
    TLDR="<one sentence, ≤35 words: what you get, then <the thing> used to <problem>; now <new behaviour> — reuse the plan's drafted PR TLDR>"
    flow-gate-summary --status awaiting-approval --echo-prose \
      --why "$WHY" \
      --worktree "$WORKTREE" \
      --plan-file "$WORKTREE/.flow-tmp/plan.md" \
      --lens "$LENS" \
      --tldr "$TLDR" \
      --untracked-file <(flow-untracked render --format gate --unfiled-only)
    ```

    Then echo the recap per [Gate-stage echo-verbatim
    recap](shared-gate-contracts.md#gate-stage-echo-verbatim-recap---echo-prose).

    Then end the turn. The next turn re-enters at step 4 with the
    same affirmative/redirect/cancel/ambiguous branches as the
    feature-intent path. The `plan-pending-review` phase value is
    reused (no new phase string is introduced); `flow-stop-guard`
    and `flow-resume-decide` both already handle this phase
    unchanged for non-feature intents. Arm the same **plan-review clear
    point** here (probe + arm `--site plan-review`) as the feature-intent
    End condition above, so a `/clear` at `plan-pending-review` on a
    route-to-step-4 non-feature pipeline also auto-resumes to the plan
    render.

**Question-gate branch.** When `/flow-product-planning` doesn't write
`.flow-tmp/plan.md`, first check whether it wrote
`.flow-tmp/interview-questions.md` instead — discovery's own strict
question-gate (`skills/pipeline/flow-product-planning/references/discovery-instructions.md`
§ question-gate contract) can pause mid-run when every viable plan
branch is invalidated by an unanswered fork. On that signal:

1. Write `flow-state-update --phase plan-pending-interview`.
2. Render the battery from `.flow-tmp/interview-questions.md` inside
   the `references/pause-output-contract.md` slot shape (the same
   template as the step-1 interview — see
   `references/interview-playbook.md` `## 8`).
   <!-- any new pause site below must reference pause-output-contract.md -->
3. End the turn.
4. On the next turn, BEFORE re-invoking `/flow-product-planning`,
   persist the post-gate digest — the union of the question-gate
   battery's questions/answers and any existing triage digest from
   `state.interview` — via `flow-state-update --phase planning
   --interview-stdin` (see the playbook's `## 7. Persistence contract`;
   the write REPLACES the prior digest with the full interview-to-date).
   This is what moves the phase off `plan-pending-interview` and makes
   the answers survive a crash between this write and discovery's
   post-answer re-run finishing. Then re-invoke `/flow-product-planning`
   appending `INTERVIEW ANSWERS (post-discovery): <answers>` onto the
   same threading channel as `## Invocation threading` above, so
   discovery resumes with the answers as load-bearing context instead
   of re-deriving the plan from scratch.

**At most one question-gate fire per pipeline.** If `.flow-tmp/plan.md`
is still absent after the post-answer re-invocation (a second
`interview-questions.md` write), do NOT loop a second gate round —
escalate `NEEDS HUMAN: interview-loop` instead. Scoped per-source: the
method pause's supervisor-side write of `plan-pending-interview` is a
distinct source and never counts toward this escalation.

If `/flow-product-planning` doesn't write `.flow-tmp/plan.md` AND does
NOT write `.flow-tmp/interview-questions.md` either — a genuine
plan-missing failure, not the question gate — re-invoke once with an
explicit instruction to write the consolidated artifact. If the second
attempt also fails, escalate `NEEDS HUMAN: plan-missing`.
