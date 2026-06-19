# Epic designer — design specification

> **What this is:** the resolved design for the epic _designer_ — flow's epic-layer design phase. Each question below is answered with options, pros/cons, a named middle ground where the choice is binary, and a recommendation. Grounded in `01-research-report.md` (expert methodologies, with confidence tiers) and flow's verified architecture. Companions: `04-artifact-storage-recommendation.md` (storage) and `03-build-plan.md` (how it's built). Refines/challenges `00-prior-architecture-review.md` where noted.
>
> Every methodology citation carries the confidence tier from `01` ([V1] harness-verified, [V2] author-verified this session, [E] established/source-located). Where evidence was rate-limited in the harness pass, the recommendation rests on the [V2] author-verified primary sources.

## 0. What is being designed (and what is not)

The **epic designer** takes a high-level epic prompt and emits **clarified requirements → a high-level design → a decomposition into a dependency DAG of PR-sized "features."** Each feature later becomes one ordinary `flow new` pipeline/PR. The designer **produces artifacts and stops** — it does not launch, schedule, watch, or merge. The orchestrator/run phase is out of scope (deferred); this spec only notes the clean seams it must leave (§10).

The pipeline backbone is fixed by the mission:

```
epic prompt → clarified requirements → high-level design → feature decomposition → dependency DAG (+ artifacts)
```

The design questions are the _choices within_ this backbone: what's reused (§1–2), how interactive the front is (§3), which expert methods fill each stage (§4), what artifacts come out (§5), the rules for a good feature and a good edge (§6–7), where artifacts live (§8 → `04`), and what it's called (§9).

## 1. Reuse before reinventing — the foundation flow already provides

The single biggest framing the prior review got right, and this spec keeps: **the designer is `/product-planning` operating one altitude up, not a new pipeline.** flow's existing planning skill already does ~80% of the designer's job; building a "separate component" would duplicate it. Verified against source in this worktree:

| Capability the designer needs                                                | Already exists in flow                                                          | Where (verified)                                                                    | Reuse verdict                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Read a codebase, surface assumptions, draft a structured plan                | `/product-planning` → Independent Discovery Subagent                            | `skills/pipeline/product-planning/SKILL.md`, `references/discovery-instructions.md` | **Reuse wholesale**, extend the grain                                  |
| Make defensible assumptions under ambiguity + surface them as Open Questions | discovery-instructions step 3                                                   | same                                                                                | **Reuse** the stance, augmented by one clarify round (§3)              |
| Binary-framing / middle-ground discipline                                    | discovery-instructions step 4 "Binary-framing check"                            | same                                                                                | **Reuse**                                                              |
| "Prompt interpretation" tension surfacing (prescribed methods vs target)     | discovery-instructions + `bin/flow-step3-route.ts`                              | same                                                                                | **Reuse** at epic grain                                                |
| Externally-failable acceptance criteria                                      | discovery-instructions step 5 (every criterion names a failable check)          | same                                                                                | **Reuse + sharpen** with EARS syntax (§5)                              |
| Task sizing + dependency-ordered breakdown                                   | discovery-instructions step 6 (task = "1–3 files, one check"; layer-order deps) | same                                                                                | **Reuse the principle, recalibrate the unit** (a feature = one PR; §6) |
| Per-pipeline typed state, hand-validated JSON, no DB                         | `bin/lib/state.ts` (`PipelineState`, type guard, `read/writeState`)             | verified                                                                            | **Mirror the pattern** for the manifest                                |
| Slug a prompt into a stable id                                               | `bin/lib/slug.ts` (`slugify`, stop-words, `task-<hash>` fallback)               | verified                                                                            | **Reuse** for the epic id                                              |
| Typed-artifact + schema-validator + PATH-symlink pattern                     | four `bin/lib/*-schema.ts` helpers + `discoverValidators`                       | verified                                                                            | **Mirror** for `manifest.json` validation                              |
| Turn an epic's feature into a running pipeline                               | `flow new "<description>"` → `/flow-pipeline`                                   | verified                                                                            | **Feed it; never reimplement it**                                      |
| Acyclic ready-set math                                                       | not present (greenfield)                                                        | —                                                                                   | **New** (pure Kahn's-algorithm helper)                                 |

**Genuinely new surface (small):** (a) the epic-grain extension to discovery (emit a feature DAG, not an intra-feature task list); (b) the committed manifest schema + validator; (c) the `epic design` CLI verb + epic-id minting; (d) a DAG-validation helper (acyclic / no-orphan-deps / ready-set). Everything else is reuse — the proof that the designer is a _grain change to an existing capability_, not a second pipeline.

## 2. What the designer must NOT reimplement

The designer does not re-implement discovery (it calls `/product-planning`), does not re-implement the feature pipeline (it emits descriptions `flow new` consumes), does not implement any orchestrator behaviour (computing the ready set as _validation_ is fine; _acting_ on it is the deferred orchestrator), and does not introduce a database or a daemon.

## 3. Interaction model (the central choice) — RECOMMEND HYBRID

**Decision: a HYBRID — one bounded round of _material_ clarifying questions, then autonomous, then the single approval checkpoint.** This is the named middle ground between the two poles, and `01` Area 4 makes it the evidence-backed choice rather than a fence-sit.

The three poles and why the middle wins:

- **(i) One-shot autonomous** (flow's current discovery): make defensible assumptions, surface them as Open Questions, stop. _Pro:_ matches flow's one-shot subagent contract exactly; zero added interaction. _Con:_ an epic is higher-ambiguity than a single feature — and `01` shows the two most analogous tools (GitHub Spec Kit, AWS Kiro [V2]) both **reject** pure one-shot for ambiguous specs, while CMU's underspecification study [V2] finds unspecified-critical-requirements is the _dominant_ LLM failure mode (underspecified prompts regress 2× across model changes).
- **(ii) Interactive multi-round Socratic loop:** interrogate across many rounds before decomposing. _Pro:_ maximal ambiguity reduction. _Con:_ fights flow's walk-away model; and CMU [V2] shows **over-specification interferes** — forcing 19 requirements at once dropped accuracy to 85% (vs 98.7%). More questions is not better.
- **(iii) HYBRID (recommended):** _one_ round of only the **load-bearing** clarifications — the ambiguities whose wrong answer invalidates the whole decomposition — then autonomous, residue surfaced as Open Questions at the checkpoint.

**Why hybrid, concretely:** Spec Kit clarifies via _"iterative dialogue… the AI asks clarifying questions"_ and marks `[NEEDS CLARIFICATION: …]` rather than guessing; Kiro gates each phase behind user approval. Both say _some_ interaction beats one-shot. CMU says clarify only the **critical** few. flow already has the back half (surfaced assumptions + a `plan-pending-review` checkpoint = Kiro's approval gate). So the designer adds exactly one thing to flow's existing discovery: **a materiality-gated clarification round up front.** Mechanics:

- Use the **Paul–Elder [V2]** question types to find the material ambiguities — weight _assumptions_ and _implications/consequences_ (the two that most often invalidate a decomposition).
- **Gate on materiality, cap the size.** Ask only questions whose answer changes the feature set or the DAG shape. If none qualify, **skip the round** — the hybrid degrades gracefully to one-shot for a crisp prompt (this is pipeline ④-as-fallback from `01`).
- **Fire it through flow's existing `AskUserQuestion` form**, not a free-form chat loop — bounded, synchronous, one round. (This reuses flow's only sanctioned user-prompt primitive rather than inventing a conversational surface.)
- Everything not asked → Open Questions in `design.md`, resolved at the approval checkpoint.

**Challenge to `00`:** the prior review's Open Question on this assumed flow's one-shot-discovery default. The research moves the recommendation off that default toward the hybrid — bounded, but not zero — because the directly-analogous tools and the empirical evidence both reject pure one-shot for epic-scale ambiguity.

## 4. End-to-end methodology — pipeline ① from the research

**Decision: `01`'s ranked pipeline ① — "lean spec-driven, Parnas/Simon decomposition, hybrid clarify."** One coherent, expert-grounded method per backbone stage (not a grab-bag), at the minimum artifact weight that still works:

- **Clarify requirements:** materiality-gated Socratic round (§3) → acceptance criteria in **EARS** [V2] (`WHEN <trigger> THE SYSTEM SHALL <response>`); residue → Open Questions. _(Reuses flow's failable-criteria rule, sharpened by EARS.)_
- **High-level design:** one lightweight design doc whose decisions are **ADR-shaped** [V2] (Context / Decision / Consequences) and which _is_ **Parnas's "list of difficult, likely-to-change design decisions"** [V1] — the design artifact and the decomposition criterion are the same list, viewed twice.
- **Decompose:** **Parnas** [V1] (each feature hides one volatile decision) + **Simon** [V1] (cut at weak-coupling seams) + **Shape-Up-at-feature-altitude** [E] (decompose to features now; each feature's own pipeline discovers its tasks later) + **Story-map walking skeleton** [E] (pick the thin end-to-end root).
- **Dependency DAG:** explicit typed edges + a validator (§7). **No DSM** [E] — overkill below dozens of nodes; hand-drawn edges + a cycle check suffice at epic scale.

This pipeline is the only one in `01` whose every stage is either harness-verified (Parnas/Simon) or matches both leading spec-driven tools (Spec Kit/Kiro) _at minimum weight_, and it reuses flow's discovery + checkpoint machinery rather than adding ceremony.

## 5. Artifact set — minimal but sufficient: TWO committed files

**Decision: two committed files — `design.md` (human review) + `manifest.json` (machine DAG) — collapsing Kiro's three-file model.** The medium (git-committed, in-repo) is fixed in `04`; this section fixes the _set_ and _shape_.

**Why two, not Kiro's three [V2 middle ground]:** Kiro emits `requirements.md` / `design.md` / `tasks.md` with an approval gate between each. For a solo developer reviewing one epic, three documents and three gates is more ceremony than the work warrants — and "tasks" here are _features_, which live in the manifest, so a third prose file would duplicate it. So: **collapse requirements + design into one `design.md`** (one review surface, one checkpoint), and let `manifest.json` be the machine contract. This is the named middle ground between Kiro's three-file rigor and a single-blob plan — it keeps Kiro's separation of _human-readable design_ from _machine-trackable units_ while halving the file/gate count.

**`design.md`** — the review surface at the approval checkpoint:

1. **Problem & intent** — the epic's underlying need (JTBD-lite [E]), not solution language.
2. **Clarified requirements** — user-visible behaviors with **EARS** [V2] acceptance criteria; each names an externally-failable check (flow's existing rule).
3. **High-level design** — **ADR-shaped** [V2] key decisions; this section _is_ Parnas's [V1] list of likely-to-change design decisions, each a candidate feature boundary.
4. **Feature decomposition** — the feature list with one-line rationale per feature (which volatile decision it hides).
5. **Dependency DAG** — a **Mermaid** `graph` GitHub renders inline (the one borrowed C4 [V2] idea: a structural picture, _not_ the C4 process).
6. **Open Questions** — the clarification residue (§3), for the checkpoint.

**`manifest.json`** — the machine contract, schema-validated (mirrors flow's `*-schema.ts` pattern [verified]):

```json
{
  "epicId": "payment-subscriptions",
  "prompt": "<verbatim epic prompt>",
  "createdAt": "<iso8601>",
  "features": [
    {
      "id": "schema-and-migration",
      "title": "Subscription schema + migration",
      "description": "<one paragraph — becomes the `flow new` description>",
      "dependsOn": [],
      "rationale": "hides the data-model decision (Parnas secret)",
      "acceptanceCriteria": ["WHEN ... THE SYSTEM SHALL ..."],
      "flowNewHints": { "copilotReview": "auto", "effort": "medium" }
    }
  ]
}
```

`flowNewHints` map to existing `state.ts` fields (`autoMerge`/`copilotReview`/`effort`) — the seam a future orchestrator reads (§10); the designer only _populates_ hints, never acts on them.

**Gold-plating watch (explicit exclusions, each justified by `01`):** no C4 four-diagram set (C4 is _"not a design process"_ per its own FAQ [V2] — one Mermaid DAG suffices); no arc42/SEI "Views & Beyond" template [E] (calibrated for large multi-stakeholder systems); no separate ADR _files_ (ADR _shape_ inlined into design.md is enough at this scale); no event-storming/context-map [E] (thin-domain CLI epics don't earn it); no full SRS/Volere [E]. Include any of these later only if a specific epic proves a concrete need.

## 6. Decomposition rules — what makes a feature a good unit of work for one flow PR

A "feature" is sized to be **exactly one `flow new` pipeline = one mergeable PR = one vertical slice that passes its own gate.** The rules, grounded in `01` Area 2:

1. **Vertical slices, not horizontal layers [V1 Parnas].** Each feature is an end-to-end increment that can pass its own `## Test Steps` gate — not "the DB layer" across the whole epic. Parnas: _"it is almost always incorrect to begin the decomposition… on the basis of a flowchart"_; modules _"will not correspond to steps in the processing."_ A horizontal slice can't be merged or verified independently, so it isn't a valid feature.
2. **Decompose by what changes together [V1 Parnas + Simon].** Each feature hides one likely-to-change design decision behind a stable interface; the stable interface goes on the edges. High cohesion within, low coupling across. If two candidate features must change in lockstep, they are one feature.
3. **A feature is PR-sized, not task-sized.** flow's _task_ unit is "1–3 files, one check"; a _feature_ is coarser — a cohesive PR a single `/flow-pipeline` run carries to merge — bounded by the same spirit: if it can't plausibly be one focused PR with one coherent review, split it.
4. **A clean dependency edge is a produced/consumed artifact, not a vibe.** B `dependsOn` A only when B consumes something A _produces_ — a schema, migration, interface, file, exported symbol — that must exist first. "Feels later" is not an edge. (Mirrors flow's task `Inputs/Outputs` contract.)
5. **Sparse edges by construction [V1 Simon].** Near-decomposability means inter-feature coupling should be weak relative to intra-feature coupling; **a dense edge set is a diagnostic that a boundary was drawn at the wrong (strong-coupling) place** — re-cut rather than ship the dense DAG.
6. **Prefer a walking-skeleton root [E Story Mapping].** The first feature is a thin end-to-end slice (the schema/seam everything hangs off), so the DAG has a clear root and early features de-risk the architecture.
7. **Shape Up reconciled [E].** Decompose into _features_ (coarse, appetite-bounded), not _tasks_ — each feature's own `/flow-pipeline` run rediscovers its internal tasks via `/product-planning`/`/new-feature`. The epic layer is a feature-DAG feeding self-shaping per-feature pipelines: Shape Up applied recursively, not violated.

## 7. DAG validation — what makes the graph correct

A pure, unit-testable helper (greenfield — the one genuinely new algorithm, ~Kahn's algorithm in ~10 lines) enforces:

- **Acyclic.** A cycle means the decomposition is wrong: extract the shared dependency into its own upstream feature, or merge the two. The validator exits non-zero and names the cycle.
- **No orphan edges.** Every `dependsOn` references an existing feature `id`. A dangling edge is a decomposition error, caught mechanically.
- **Ready-set computable.** The frontier (features whose deps are all satisfied) topologically sorts via Kahn's algorithm. This is _validation only_ in the design phase — computing the frontier proves the DAG is well-formed; **acting** on it is the deferred orchestrator (the seam).
- **Unique ids; no self-dependency.** Trivial but checked.
- **Connectedness not required.** Disconnected sub-DAGs are legal (independent strands of one epic); only cycles and orphan edges are errors.

The schema validator (shape of `manifest.json`) + this DAG validator together are the mechanical gate on a well-formed decomposition — the recursion's own correctness check, and the one place flow's "every artifact has a validator" discipline earns its keep here.

## 8. Where artifacts live

Resolved in `04-artifact-storage-recommendation.md`. Summary: **git-committed `design.md` + schema-validated `manifest.json` under `.flow/epics/<epic-slug>/` in the target repo, landed via a flow PR reviewed at the design checkpoint.** Not GitHub Issues (a later opt-in _projection_ only), not `beads` (DB breaks git-auditability; deferred behind an adapter), not per-machine `~/.flow/` (reserved for the deferred orchestrator's runtime status — the design output must be auditable and reviewable-as-a-diff). The committed manifest is the clean seam a future orchestrator reads.

## 9. Command namespace (greenfield) — RECOMMEND `flow epic design`

**Decision: `flow epic design "<prompt>"`** for the design-phase entry; the eventual layer reads `flow epic <design|run|status>`; `flow new` stays exactly as-is for single features.

`01` Area 5 settles the verb choice on evidence, not taste:

- **`design`** (recommended) — matches **Kiro's `design.md`** [V2], instantly legible, pairs naturally with a future `run`/`status`. The field's own vocabulary.
- **`shape`** — evocative (Basecamp), _but_ `01` confirms Shape Up's `shape` deliberately produces _an outline without a task breakdown_, whereas the designer's entire output is a concrete dependency DAG. So `shape` is **semantically off-message** — the same objection `00` raised against `architect`. Rejected despite its memorability.
- **`spec` / `specify`** — strongest field resonance (Spec Kit [V2]) but generic, and flow already overloads "plan"; risks plan/spec/manifest confusion. Rejected.

A full rename of every flow verb is a separate mechanical task — out of scope here; this only recommends the new epic verbs and confirms `flow new` is kept (add a `feature` _alias_ at most, per `00`'s candidate follow-up).

## 10. Clean seams left for the deferred orchestrator (noted, not designed)

So the orchestrator stays cleanly deferrable: (a) the committed `manifest.json` is a stable, schema-versioned contract an orchestrator reads by path + SHA; (b) per-feature records carry enough to construct a `flow new` invocation (`description` + `flowNewHints` mapping to `state.ts` fields); (c) runtime status is explicitly _not_ in the design artifact (it belongs in the orchestrator's own `~/.flow/epics/` per-machine file — `04`'s design-vs-runtime split). Designing any orchestrator behaviour is out of scope; these are only the seams the designer must not foreclose.
