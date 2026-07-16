# Step 3 invocation threading + advisory backstops

Full contract bodies for the `/flow-product-planning` invocation-threading
markers and the deterministic advisory backstops that
`skills/pipeline/flow-pipeline/SKILL.md` Step 3 points at. Each heading
below matches the one-line opener left in SKILL.md; read the matching
section here before executing that sub-step. Every marker rides the
**same append channel** — the block of `MODEL_PLANNING:` / `RESEARCH:` /
`REVISION:` / `EPIC:` lines appended after the verbatim user request (and
the inferred ultimate goal) in the `/flow-product-planning` invocation.
None of these add a new Task-tool exemption or spawn site — they are all
markers/backstops on the existing Discovery Subagent exemption (#2 in
Hard rules).

## Per-phase model (planning) threading

The Discovery Subagent is the `planning` fan-out — resolution field
`state.modelPlanning`, precedence
`--model-planning > config.models.planning > inherited` (see
[model-routing.md](model-routing.md)). Resolve it and, when non-empty,
append a `MODEL_PLANNING: <alias>` marker line to the
`/flow-product-planning` invocation through the same append channel as
the ultimate goal; `/flow-product-planning` forwards it to the Discovery
Subagent's Task spawn as its per-spawn `model:` (empty ⇒ omit ⇒ inherit).
This adds **no** new fan-out site — it is a `model:` override on the
existing Discovery exemption:

```bash
SLUG=$(tmux show-options -t "$TMUX_PANE" -v -w @flow-slug)
PLANNING_MODEL=$(jq -r '.modelPlanning // empty' ~/.flow/state/"$SLUG".json)
[ -z "$PLANNING_MODEL" ] && PLANNING_MODEL=$(jq -r '.models.planning // empty' ~/.flow/config.json 2>/dev/null)
# When non-empty, append `MODEL_PLANNING: $PLANNING_MODEL` to the invocation.
```

## Force-on threading (mandatory)

BEFORE invoking `/flow-product-planning`, run `jq -r '.forceResearch //
empty' ~/.flow/state/"$SLUG".json`. When the value is the literal `true`,
append a `RESEARCH: force-on (flow feature create --research)` marker
line to the `/flow-product-planning` invocation through the same append
channel that carries the inferred ultimate goal — drop it and a
`flow feature create --research` pipeline silently loses its forced
research. The spawn template forwards the marker to the discovery
subagent, forcing discovery Step 1.5's web-grounded research on
(bypassing the relevance gate and the `research.discovery` opt-in).
Absent or non-`true` ≡ not forced — append nothing.

## Revision-pass threading (on step-3 re-entry)

When you re-enter step 3 with an existing `<worktree>/.flow-tmp/plan.md`
already on disk — a `plan-pending-review` redirect looped back here per
step 4's imperative-redirect branch — append a `REVISION: <n>` marker
line to the `/flow-product-planning` invocation through the same append
channel as the `MODEL_PLANNING:` / `RESEARCH:` markers. `<n>` is the
in-context pass counter (2 on the first revision, 3 on the next, …); it
carries no payload — the redirect text itself rides the normal
`USER REDIRECT (received during plan-pending-review): <verbatim>`
channel. The spawn template forwards the marker via
`{{REVISION_OVERRIDE}}` and the discovery subagent runs its **Revision
pass mode** (`discovery-instructions.md` "Revision pass mode"): read the
existing plan.md first, update in place, preserve untouched sections and
the embedded `### Cross-model review (AGY)` subsection +
`<!-- flow-plan-review-hash: <sha> -->` marker verbatim, do NOT re-run
Step 1.5 research when findings already exist, and extend
`## Open Questions` with the redirect's questions. Absent an existing
plan.md (the first step-3 pass), append nothing — this adds **no** new
fan-out site, only a marker on the existing Discovery exemption.

## Epic-membership threading

Before invoking `/flow-product-planning`, check whether this pipeline was
launched from an epic. `.epic` is stored as an object
(`{ "slug": ..., "featureId": ... }`), so format it into the documented
`<slug>/<featureId>` token rather than emitting the raw JSON:

```bash
jq -r '.epic | if type == "object" then "\(.slug)/\(.featureId)" else empty end' ~/.flow/state/"$SLUG".json
```

When non-empty, append an `EPIC: <slug>/<featureId> (design at
.flow/epics/<slug>/design.md)` marker line to the
`/flow-product-planning` invocation through the same append channel as
`MODEL_PLANNING:` / `RESEARCH:` / `REVISION:` — a marker on the existing
Discovery exemption, **no** new fan-out site. The spawn template
forwards it via the `{{EPIC_OVERRIDE}}` block
(`flow-product-planning/SKILL.md`); discovery's step 1.7 treats the
marker as the PRIMARY epic-membership detection signal (the description
pointer and manifest scan are fallbacks for manually launched
pipelines). Absent or empty `.epic` ≡ not epic-launched — append nothing.

## Deterministic forced research (mandatory on the forced path)

The discovery subagent's own Step 1.5 was observed to skip the fan-out
even when forced, so on the `forceResearch == true` path you MUST ALSO
run the research deterministically yourself, BEFORE invoking
`/flow-product-planning`. First, probe whether the `research` module is
even installed — a deselected module means `flow-research-run` was
pruned from PATH entirely:

```bash
flow-module-status --check research || RESEARCH_MODULE_INACTIVE=1
```

When `$RESEARCH_MODULE_INACTIVE` is set, the helper already emitted the
named notice to stderr — note the skip in the chat summary and proceed
straight to invoking `/flow-product-planning` (append nothing for
research findings; same "graceful skip never blocks planning" invariant
as the agy-unavailable path). Otherwise, run the fan-out:

```bash
flow-research-run --task "<verbatim user description>" \
  --out "$WORKTREE/.flow-tmp/research-findings.md" \
  --status-file "$WORKTREE/.flow-tmp/research-status.json"
```

This bounded gather+refute agy fan-out self-degrades to a graceful skip
when agy is unavailable and NEVER blocks planning. Then, when
`$WORKTREE/.flow-tmp/research-findings.md` exists and is non-empty, fold
its contents into the `/flow-product-planning` invocation through the
same channel as the ultimate goal and the `RESEARCH: force-on` marker,
clearly labelled:

```
RESEARCH FINDINGS (web-grounded, pre-run by supervisor — use as prior context, do NOT re-run the fan-out):
<contents of research-findings.md>
```

The discovery subagent reuses these findings rather than re-running the
fan-out (avoiding double agy spend — see `discovery-instructions.md`
(a0)). The non-forced (config-on) path is unchanged — it never calls
`flow-research-run`; discovery's own Step 1.5 still owns research there.

## Deterministic note backstop (mandatory, non-skippable)

The discovery subagent's `> [!NOTE]` is best-effort and has been observed
to be skipped, so after the plan.md read ALWAYS run:

```bash
flow-research-note ensure --plan-file "$WORKTREE/.flow-tmp/plan.md" \
  --forced "$(jq -r '.forceResearch // false' ~/.flow/state/<slug>.json)"
```

This is idempotent and self-no-ops when research ran, when the path was
dormant, and when the subagent already wrote a note. When its stdout is
non-empty, include that line **verbatim** in the 3-5 line chat summary so
the user always sees the research skip note.

## Follow-up-reference consistency backstop (advisory, deterministic)

After the note backstop and BEFORE the cross-model plan review, run the
`flow-candidate-issues --lint` guard so a plan whose prose references a
follow-up that is missing from `# Candidate follow-up issues` never ships
silently — the exact drift an external reviewer caught in the econ-data
run:

```bash
LINT_RC=0
flow-candidate-issues --lint --plan-md-file "$WORKTREE/.flow-tmp/plan.md" || LINT_RC=$?
```

Exit 1 signals drift (the stdout JSON's `references[]` names each
unresolved reference line); exit 0 is clean; exit 2 is a read error. This
is **advisory and non-blocking** — on a non-zero exit, surface a one-line
note in the 3-5 line chat summary (e.g. "follow-up-reference drift: plan
prose references a follow-up missing from `# Candidate follow-up
issues`") so the user can redirect at `plan-pending-review`; never block
planning on it (the same "research/plan-review never block planning"
invariant the cross-model review honors).

## Plan-shape backstop (advisory, deterministic)

Right after the follow-up-reference backstop, independently lint the
plan's shape — malformed plans are named in chat even when discovery's
own self-check (`discovery-instructions.md`'s Verification checklist)
was skipped:

```bash
LINT_RC=0
if command -v flow-plan-lint >/dev/null 2>&1; then
  flow-plan-lint --plan-md-file "$WORKTREE/.flow-tmp/plan.md" || LINT_RC=$?
fi   # helper not on PATH — skip silently (tolerant), per the contract below
```

Exit 0 is clean; exit 1 prints one named miss per line on stdout —
surface a one-line note naming the misses in the 3-5 line chat summary;
exit 2 is a read error — note-and-continue. **Advisory and
non-blocking** — never block planning on it, and tolerant when the
helper is missing from `PATH` (skip silently, mirroring discovery's own
self-check contract).

## Design-spec validation backstop (deterministic, advisory)

After the follow-up-reference consistency backstop and BEFORE the
cross-model plan review, validate a frozen design spec before it reaches
`plan-pending-review` — the net for a case discovery's own 1.6(c)
self-validate should already have caught:

```bash
SPEC_RC=0
DESIGN_SPEC_REASON=""
if [ -f "$WORKTREE/.flow-tmp/design/spec.json" ]; then
  DESIGN_SPEC_STDERR=$(flow-design-spec validate "$WORKTREE/.flow-tmp/design/spec.json" 2>&1 >/dev/null) || SPEC_RC=$?
  if [ "$SPEC_RC" = "1" ]; then
    DESIGN_SPEC_REASON=$(printf '%s' "$DESIGN_SPEC_STDERR" | jq -r '.reason')
  elif [ "$SPEC_RC" != "0" ]; then
    DESIGN_SPEC_REASON="spec.json unreadable: $(printf '%s' "$DESIGN_SPEC_STDERR" | head -n1)"
  fi
fi
```

This is **existence-gated**: a missing `.flow-tmp/design/spec.json` is a
silent no-op — most pipelines have no design artifact. `SPEC_RC` and
`DESIGN_SPEC_REASON` are initialized before the `if` block so a stale
value from an earlier pipeline run in the same tmux window can never
bleed into a later non-UI render, and the validate call is `set -e`-safe
(`|| SPEC_RC=$?` captures the exit code instead of exiting the shell on
failure). Exit 0 is a silent pass. On exit 1 (schema-invalid spec), quote
the stderr JSON's `reason` verbatim as a one-line note in the 3-5 line
chat summary (worked example: "design spec invalid:
`surfaces[0].assertions[1].properties` must be an object of string
values — the mechanical tier is inert until fixed; redirect at
plan-pending-review"). On exit 2 (or any other non-zero exit — an
unreadable or non-JSON spec.json, e.g. `flow-design-spec: spec at <path>
is not valid JSON: ...`), surface the raw stderr line the same way
instead of parsing it as JSON — this backstop surfaces both a
schema-invalid (exit 1) AND an unreadable/corrupt (exit 2) spec. Either
way, carry the same failure into the awaiting-approval gate render's
`--why` string (e.g. `--why "plan ready for review (intent=feature);
design spec INVALID: <reason>"`), so the failure sits in the STATUS block
the user reads to approve, not only a skimmable summary line
(banner-blindness mitigation). It is **advisory and non-blocking** —
never a `NEEDS HUMAN` halt — same "deterministic step-3 checks never
block planning" invariant as the candidate-issues lint.

## Cross-model plan review (Layer 2) — re-fire hashing detail

Full mechanics for the marker-hash embedding and the re-fire detection
that SKILL.md Step 3's "Cross-model plan review (Layer 2, optional,
config-gated)" sub-step points at.

**Why `--print-hash`, not the envelope hash.** `flow-plan-review
--print-hash --plan-file "$WORKTREE/.flow-tmp/plan.md"` must run on the
**FINAL** plan — after the revision and the appended
`### Cross-model review (AGY)` subsection are both written — because the
`ran:true` envelope's hash is computed over the **pre-revision** body.
Embedding the envelope hash instead would leave a stale marker that
falsely re-fires the review on the very next pass (safe direction — never
a wrong-skip — but it defeats the `decision-analysis-unchanged` skip for
exactly the plans that got a cross-model review plus a revision). The
`<!-- flow-plan-review-hash: <sha> -->` marker sits inside the
`### Cross-model review (AGY)` subsection, which the hash **excludes**,
so embedding it after computing the hash does not invalidate it.

**Re-fire across passes (revision/redirect).** On a step-3 re-entry the
supervisor re-runs `flow-plan-review` unconditionally, but the helper
re-fires the (agy-spending) review ONLY when `## Decision analysis`
**materially changed** since the last reviewed revision: it hashes a
normalized `## Decision analysis` body (excluding the `### Cross-model
review (AGY)` subsection) and compares it to the marker embedded on the
prior pass, emitting `{ran:false,
skipReason:"decision-analysis-unchanged"}` when they match (normalized,
so incidental whitespace / bullet churn from an unrelated revision edit
does not needlessly re-fire). On that skip, the supervisor records a
one-line rationale in the chat summary (e.g. "cross-model plan review
skipped — `## Decision analysis` unchanged since the last reviewed
revision") and proceeds; it never hand-forces a re-review. A
missing/malformed marker re-fires (safe) and self-heals as the run
re-embeds the hash. The plan-pending-review / advance end-condition is
unchanged; this sub-step only enriches plan.md before that gate fires.
