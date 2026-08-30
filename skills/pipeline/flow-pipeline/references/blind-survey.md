# Step-3 blind method survey

Full contract for the Step-3 blind method survey: two model-pinned agy
judges (`flow-blind-survey`) independently recommend how to accomplish
the pipeline's GOAL — never told the user's proposed method — before
forced research and before `/flow-product-planning` discovery ever runs.
The survey is a `flow-delegate-fanout` **Bash fan-out**, not a Task-tool
spawn: no new exemption, same shape as the cross-model plan review and
the intent guess (see `AGENTS.md` `## Don'ts`, the shared phrase
"Bash fan-out, not a tenth exemption"). This file is the full body;
`SKILL.md` Step 3 carries only a pointer-sized opener.

## Gate

Three parts, ALL of which must pass before the survey runs:

1. `state.interview` is non-empty (the intent interview ran at step 1 and
   produced a persisted digest — the survey's goal-only brief is built
   from that digest's goal-level answers, see below):

   ```bash
   SLUG=${FLOW_SLUG:-$(tmux show-options -t "$TMUX_PANE" -v -w @flow-slug 2>/dev/null)}
   jq -r '.interview // empty' ~/.flow/state/"$SLUG".json
   ```

   (the same env-first-then-pane idiom `step3-threading.md`'s Interview
   threading section already uses.)

2. `$WORKTREE/.flow-tmp/blind-survey.md` is ABSENT. Its presence means
   the survey already ran for this pipeline (a first pass, or an earlier
   step-3 re-entry) — reuse the file, never re-run the survey, even on a
   revision pass.
3. `flow-module-status --check research` passes (the `research` module,
   and the `flow-blind-survey`/`flow-delegate-fanout` helpers it carries,
   are installed).

Any part failing (no interview digest, module deselected, `agy` absent)
⇒ print one line to chat — `blind survey skipped — <reason>` — and
proceed exactly as before this feature existed: no marker, no
`## Method selection`, no pause.

## Goal-only brief

The supervisor writes one file before calling the helper:

- **`$WORKTREE/.flow-tmp/blind-survey-brief.md`** — the GOAL-ONLY brief
  each judge reads. Built from the step-1 goal line plus goal-LEVEL
  interview digest answers ONLY: `Intent/Goal`, `Non-goals`, `Quality
bar`. NEVER include the raw user description, NEVER a mechanism the
  user proposed, and NEVER the `Desired behavior` or `Constraints &
trade-offs` digest answers — those name (or strongly imply) the
  user's own method, and leaking them into the brief is exactly what
  would un-blind the judges.

The leak corpus — the raw user description, followed by one line per
`Desired behavior` / `Constraints & trade-offs` digest answer, PLUS the
user's own proposed method itself — is authored inside the "Run the
survey" block below, in the SAME bash block as the helper call, not
before it. This is the content the brief must NOT quote back verbatim
(an 8-word shingle match, or a whole short line, trips
`flow-blind-survey`'s `briefLeaksCorpus` guard). It is written OUTSIDE
the worktree — `$(mktemp -t blind-survey-desc.XXXXXX)` — never under
`$WORKTREE/.flow-tmp/`: `flow-blind-survey` passes `--add-dir
"$WORKTREE"` to each judge's agy call, so a corpus file living inside
the worktree would be directly readable by the very judges it exists to
keep blind.

Authoring the brief is a supervisor judgment call, not a mechanical
extraction — read the goal-level digest answers and write a faithful,
self-contained restatement of the GOAL, never a restatement of the
user's proposed HOW.

## Run the survey

```bash
BLIND_SURVEY_DESC=$(mktemp -t blind-survey-desc.XXXXXX)
cat > "$BLIND_SURVEY_DESC" <<'EOF'
<raw user description>
<one line per Desired behavior / Constraints & trade-offs digest answer>
<the user's proposed method>
EOF
flow-blind-survey \
  --brief-file "$WORKTREE/.flow-tmp/blind-survey-brief.md" \
  --description-file "$BLIND_SURVEY_DESC" \
  --out "$WORKTREE/.flow-tmp/blind-survey.md" \
  --worktree "$WORKTREE"
rm -f "$BLIND_SURVEY_DESC"
```

Run this as a Bash tool call with `timeout: 600000` (10 minutes — the
helper's own `JUDGE_A_TIMEOUT`/`JUDGE_B_TIMEOUT` sum to 9 minutes, so
this leaves real margin). Branch on the stdout envelope's `{ran}` field,
**never** the exit code (every non-usage path exits 0):

- **`skipReason: "brief-not-blind"`.** The mechanical blindness guard
  fired on the brief you authored. Re-author the brief ONCE — read the
  guard's target more carefully, strip the leaking phrase, and re-run.
  If the second attempt also fails, treat it as any other skip (print
  the skip line, proceed with no marker) — never a third attempt.
- **`skipReason: "fanout-error"`.** The fanout call itself came back
  empty — `flow-delegate-fanout` missing from `PATH`, a usage-error
  exit, or an unparsable aggregate line — distinct from `agy-not-found`
  (a per-judge `ran:false` entry that IS present in the aggregate).
  Treat it as any other skip (print the skip line, proceed with no
  marker); there is nothing brief-specific to re-author here.
- **`ran:false`** (any other reason). Print `blind survey skipped —
<skipReason>` to chat and proceed with no marker.
- **`ran:true`.** Print `blind survey: A=<model> ran|skipped:<reason>,
B=<model> ran|skipped:<reason>` to chat (read straight off the
  envelope's `judges[]`) and thread the marker below.

## Thread the marker

On `ran:true`, append the seventh invocation-threading marker (see
`step3-threading.md` "Blind survey threading") to the
`/flow-product-planning` invocation through the same append channel as
`MODEL_PLANNING:` / `RESEARCH:` / `REVISION:` / `EPIC:` /
`PROMPT-SANITY:` / `INTERVIEW:`:

```
SURVEY: <absolute path to .flow-tmp/blind-survey.md> (judges: A=<model> ran|skipped:<reason>, B=<model> ran|skipped:<reason>)
```

`/flow-product-planning`'s `{{SURVEY_OVERRIDE}}` spawn-template
placeholder forwards it to the Discovery Subagent, which runs
`discovery-instructions.md` step 1.8 and authors `## Method selection`.

On a re-entry where `blind-survey.md` already exists (the Gate part 2
reuse path above) but no envelope is live in the current turn, derive
the `(judges: …)` text from the survey file's own `Judges:` line — its
fourth line, written by the helper — rather than the envelope:
`sed -n 's/^Judges: //p' "$WORKTREE/.flow-tmp/blind-survey.md"`. Thread
the marker exactly as on the first pass.

**Post-discovery backstop.** When the survey ran (a marker was
threaded) but the returned `plan.md` has no `## Method selection`
section — discovery skipped it, e.g. a transient miss — print a chat
note (`discovery did not author '## Method selection' despite a
threaded SURVEY: marker`) and treat the verdict as `split` for the
routing decision below — since `flow-step3-route` reads its verdict
from `plan.md` itself and there is none to read on this backstop, the
concrete override is: for a non-feature intent, set `ROUTE=route-to-step-4`
directly rather than calling the helper (a feature intent already lands
on `route-to-step-4` unconditionally, so no override is needed there).
This is a degrade, not a hard stop: a `split`
routes to `route-to-step-4` on a non-feature intent and never pauses.

This backstop also has a mechanical half now: whenever the survey ran
(a marker was threaded), pass `--survey-ran` to the plan-shape lint call
`step3-threading.md`'s "Plan-shape backstop" already runs —
`flow-plan-lint --plan-md-file "$WORKTREE/.flow-tmp/plan.md"
--survey-ran` — advisory and non-blocking, exactly like that existing
backstop. With the flag set, a fully-missing `## Method selection`
section becomes a named lint miss (`survey ran but plan.md has no '##
Method selection' section`) surfaced in the same plan-summary note,
instead of relying on prose-only detection here.

## Method-selection route

`$METHOD_RESOLVED` has no persisted source of its own — it is derived,
in the same bash block as the `ROUTE=` call, from a marker file the
supervisor writes at answer time ("The method pause" step below):

```bash
METHOD_RESOLVED=$([ -f "$WORKTREE/.flow-tmp/method-resolved" ] && echo 1)
ROUTE=$(flow-step3-route --intent "$INTENT" --plan-md-file "$WORKTREE/.flow-tmp/plan.md" ${METHOD_RESOLVED:+--method-resolved})
```

`$ROUTE` is one of three decisions (see `bin/flow-step3-route.ts`):

- **`pause-for-method`** — both judges ran, both independently
  recommended a method materially different from the user's, and the
  method has not already been resolved this pipeline. Handled below
  ("The method pause").
- **`route-to-step-4`** — feature intent (unconditional, as before), OR
  the existing Prompt-interpretation tension rule fires, OR a
  non-feature intent whose survey verdict is `split`.
- **`advance-to-step-5`** — otherwise (unchanged default path).

**Plan-summary `Needs attention:` line.** During the single plan.md read
step 3 already performs (never a second read — see the "single read of
the plan file" rule), also read `## Method selection` when present and
append one `Needs attention:` line to the `plan-pending-review` summary:
`Method: <user's> → <chosen> (survey: <verdict>)`, sourced from the
section's `- **User's method:**` / `- **Chosen method:**` / `- **Survey verdict:**` lines.

On the non-feature `route-to-step-4` path (the `split`-verdict branch),
`flow-gate-summary` never parses plan sections, so append the same text
to that branch's `WHY=` string instead — the same mechanism the design-
spec-INVALID case already uses. `$SURVEY_VERDICT` / `$USER_METHOD` /
`$CHOSEN_METHOD` are likewise not persisted anywhere — derive them in
the SAME bash block as the `WHY=` assignment, following the block's
existing inline-assignment convention:

```bash
SURVEY_VERDICT=$(sed -n 's/^- \*\*Survey verdict:\*\* *//p' "$WORKTREE/.flow-tmp/plan.md" | head -1)
USER_METHOD=$(sed -n "s/^- \*\*User's method:\*\* *//p" "$WORKTREE/.flow-tmp/plan.md" | head -1)
CHOSEN_METHOD=$(sed -n 's/^- \*\*Chosen method:\*\* *//p' "$WORKTREE/.flow-tmp/plan.md" | head -1)
```

## The method pause (plan-pending-interview, second use)

On `pause-for-method`, the supervisor asks ONE question and reuses the
existing `plan-pending-interview` phase — a second, distinct use of it
(see "At most one question-gate fire per pipeline" below), not a new
phase:

1. **Write the question.** Append to
   `$WORKTREE/.flow-tmp/interview-questions.md` as the next unused
   `Q<n>` (count the `Q` ids already present in the persisted digest).
   Options: `a) adopt the plan's chosen method (recommended)`,
   `b) keep my method`, or freeform. The question body is the two
   quoted judge lines and the before → after table, copied from
   `## Method selection`.
2. **Persist the digest at ask time.** `flow-state-update --phase
plan-pending-interview --interview-stdin` with the FULL
   interview-to-date (every prior question plus this new one, marked
   still-open) — the same full-digest-not-delta discipline
   `interview-playbook.md` § 7 documents.
3. **Render the pause.** Use the `### ❓ Both blind judges recommend a
different method` template from `interview-playbook.md` § 8 —
   labeled slots per `references/pause-output-contract.md`, ending on a
   `**Next action:**` line: `Reply answer: <n>a to adopt the plan's
method, <n>b to keep yours, or freeform; proceed accepts the
recommendation; cancel stops the pipeline.` End the turn here.

**Next turn.** Parse the reply per `interview-playbook.md` § 5 (`proceed`
⇒ adopt the recommendation; `cancel` ⇒ ordinary pipeline-cancel; a vague
answer ⇒ adopt, same as any other interview question). Write
`flow-state-update --phase planning --interview-stdin` with the answer
folded into the full digest. Then, before either branch below, `touch
"$WORKTREE/.flow-tmp/method-resolved"` — the marker `$METHOD_RESOLVED`
derives from in the "Method-selection route" section above:

- **Adopt.** Re-run the route with `--method-resolved` (`flow-step3-
route` treats a resolved `converge-against` as `converge-with`) and
  continue the normal end conditions from wherever that decision lands
  — no further plan changes needed, the plan already matches.
- **Keep mine.** Run exactly one `REVISION: <n>` pass through
  `/flow-product-planning`, appending `USER REDIRECT (received during
plan-pending-interview, method pause): use method <x>` plus
  `INTERVIEW ANSWERS (post-discovery): <answers>` plus the SAME
  `SURVEY:` marker (the file is reused — the survey never re-runs; see
  the Gate above), then re-run the route with `--method-resolved`.

**At most one question-gate fire per pipeline — per source.** The
"at most one" counter that governs discovery's own
`interview-questions.md` question-gate write is scoped PER SOURCE: this
supervisor-side method-pause write is a distinct, named second use of
`plan-pending-interview` and never counts toward — or trips — discovery's
own `NEEDS HUMAN: interview-loop` escalation. The method pause fires at
most once per pipeline by construction: adopting or keeping the user's
method both write the `$WORKTREE/.flow-tmp/method-resolved` marker before
re-routing, and `decideStep3Route` never returns `pause-for-method` once
`--method-resolved` is passed.

## Resume

`flow-resume-decide`'s `plan-pending-interview` row (the branch guarded
on `!inputs.planExists`, identified by name rather than line number
since the file reflows) is guarded on `!planExists` — and by
the time the method pause can fire, `plan.md` already exists (discovery
already drafted it before returning). So a crash mid-pause does NOT
re-render the method question: `flow-resume-decide` falls through to
the "phase predates approval" branch and resumes at step-4, which
re-renders the ordinary plan summary — including the `Method:` line
above, since `## Method selection` is already on disk. A safe, lossy
degrade (the user re-approves the plan rather than re-answering the
method question specifically) accepted for v1.
