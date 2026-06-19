# Epic designer — research report

> **Purpose:** how true experts (academic and professional) clarify requirements, produce high-level designs, and decompose large problems into dependency-ordered pieces — what artifact each method yields, when it's reached for, its trade-offs, which methods compose vs conflict, and the ranked pipelines that fit _this_ context (a single developer, a CLI/tmux tool, decomposing a software epic into a DAG of PR-sized features). Feeds `02-design-spec.md`. Companion to `00-prior-architecture-review.md`.

## How this report was produced (and a load-bearing caveat on verification)

Two-stage method. **Stage 1:** the `/deep-research` harness fanned out 5 search angles → 21 primary/secondary sources → 98 extracted claims → adversarial 3-vote verification. **Stage 2 (manual repair):** the harness's verification pass was **heavily rate-limited by a transient API throttle** — dozens of verifier votes failed with `Server is temporarily limiting requests`, so only the two AREA-2 decomposition theorists (Parnas, Simon) cleared the 3-vote bar. Every other methodology landed in the harness's "refuted" list with a `0-0 (3 abstain)` tally — **abstention from rate-limiting, not refutation**. The harness's own synthesis says so explicitly: _"A 0-0 or 1-0 tally means the claim did not clear the adversarial bar — it does NOT necessarily mean the claim is false (many read as accurate descriptions of those methods)."_ The tell is that **Parnas's own thesis was simultaneously confirmed (via the `cacm.acm.org` mirror) and "refuted" (via the `dl.acm.org` mirror)** — the same fact, killed only where the verifier couldn't load the page. So I re-verified the decision-driving claims myself by fetching their authoritative primary sources directly (Stage 2). The confidence tiers below record exactly how each claim was verified — this is the "verify; cite; flag the unverified" discipline made auditable rather than a blanket "trust me."

### Confidence tiers

- **[V1] Harness-verified** — cleared the harness's 3-vote adversarial bar against a primary source. (Parnas, Simon only.)
- **[V2] Author-verified this session** — I fetched the authoritative primary source directly this session and confirmed the claim. (Spec Kit, Kiro, EARS, ADR, C4, the CMU underspecification study, Paul–Elder.)
- **[E] Established, source-located, not independently re-fetched** — a widely-taught, uncontested method whose primary source the research _located_ but whose exact wording I did not re-fetch this session. Cited to the originator; flagged so the reader knows the provenance. (Conway, DSM, coupling/cohesion, Shape Up, WBS, MECE, story mapping, JTBD, impact/example mapping, INVEST, 5 Whys, 29148/Volere, arc42, SEI V&B, RFC/RFD culture, DDD/event storming.)

No claim below is asserted at a higher tier than its evidence supports.

## Headline finding — the decomposition spine is settled and primary-sourced

The strongest, most defensible result, and the one the harness verified hardest, is that **two foundational papers jointly prescribe how to cut an epic into independently-buildable features**, and they interlock:

- **Parnas (1972) — decompose by information hiding [V1].** _"Begin with a list of difficult design decisions or design decisions which are likely to change. Each module is then designed to hide such a decision from the others."_ And: _"it is almost always incorrect to begin the decomposition of a system into modules on the basis of a flowchart"_ — modules _"will not correspond to steps in the processing."_ The criterion for a module boundary is **a volatile design decision the module hides behind a stable interface**, and the payoff is change-localization (a change touches one module, not all). → For the epic designer: **draw feature boundaries around volatile design decisions (change-aligned, vertical slices), never around pipeline stages or horizontal layers.** ([CACM, primary](https://cacm.acm.org/research/on-the-criteria-to-be-used-in-decomposing-systems-into-modules/))
- **Simon (1962) — near-decomposability [V1].** Complex systems are recursively hierarchical (_"a system composed of interrelated sub-systems, each… in turn hierarchic… until we reach some lowest level of elementary subsystem"_), and **nearly decomposable**: _"the short-run behavior of each of the component subsystems is approximately independent of… the other components; in the long run, the behavior of any one… depends only in an aggregate way on… the others."_ Intra-component linkages are stronger than inter-component linkages. → For the epic designer: **a feature is safely "PR-sized and independently buildable" exactly to the degree its coupling to sibling features is weak; place the DAG's cuts at the weak-coupling seams; a dense edge set is a diagnostic that a boundary was drawn in the wrong place.** ([Simon 1962 PDF, primary](https://www2.econ.iastate.edu/tesfatsi/ArchitectureOfComplexity.HSimon1962.pdf))

These two are mutually reinforcing: **Simon says _why_ pieces can be built in isolation (near-decomposability) and _where_ to cut (weak-coupling seams); Parnas says _by what criterion_ to cut (information hiding / volatility) and warns _against_ flowchart/layer slicing.** That is the methodological backbone for the decomposition step, grounded entirely in originator primary sources. Everything else in this report serves the stages _around_ that spine (clarify → design → decompose → DAG).

## Master table — method → artifact → when → pro → con

| Method                                              | Primary artifact                                                                | When experts reach for it                          | Key pro                                                                | Key con                                          | Tier |
| --------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------ | ---- |
| **Parnas information hiding**                       | a list of likely-to-change design decisions, one per module                     | deciding _where module/feature boundaries go_      | change stays local; boundaries survive change                          | needs foresight about what will change           | V1   |
| **Simon near-decomposability**                      | (conceptual) the weak-coupling cut-set                                          | judging whether a piece is independently buildable | formal license to build/reason in isolation                            | descriptive, not a step-by-step recipe           | V1   |
| **Conway's Law**                                    | (diagnostic) org/comms ↔ system-structure map                                   | anticipating which boundaries will actually hold   | predicts real seams                                                    | weak lever for a solo dev (no team topology)     | E    |
| **Coupling & cohesion** (Stevens/Myers/Constantine) | module-quality assessment                                                       | sanity-checking a proposed decomposition           | operational "good boundary" heuristic                                  | qualitative; easy to rationalize                 | E    |
| **DSM (Design/Dependency Structure Matrix)**        | an N×N dependency matrix, clustered & sequenced                                 | sequencing/clustering many interdependencies       | finds cycles & order mechanically                                      | overkill below ~dozens of nodes                  | E    |
| **WBS + 100% rule** (PMI)                           | a deliverable-oriented work-breakdown tree                                      | scoping total work so nothing is missed            | completeness guarantee                                                 | tree ≠ DAG; no cross-branch deps                 | E    |
| **MECE / issue trees** (Minto)                      | a mutually-exclusive, collectively-exhaustive tree                              | structuring a problem space cleanly                | no gaps, no overlaps                                                   | forces tree shape onto graph problems            | E    |
| **Shape Up** (Basecamp)                             | a shaped "pitch" (breadboard + fat-marker sketch) at fixed _appetite_; _scopes_ | bounding ambiguous work; deferring task detail     | bounds scope; **refuses premature task breakdown**                     | deliberately _not_ a dependency DAG              | E    |
| **User Story Mapping** (Patton)                     | a 2-D story map (backbone + slices)                                             | finding a walking skeleton / release slices        | surfaces a thin end-to-end first slice                                 | user-facing; weaker for infra epics              | E    |
| **Google-style design doc / RFC / Oxide RFD**       | a prose design document, reviewed before building                               | aligning on an approach before code                | captures rationale + alternatives in one place                         | heavyweight if over-templated                    | E    |
| **ADR** (Nygard)                                    | a 1–2 page decision record (Title/Status/Context/Decision/Consequences)         | capturing one architecturally-significant decision | cheap, durable "why"; maps onto Parnas's list                          | one decision per file; not a whole design        | V2   |
| **C4 model** (Brown)                                | up to 4 static-structure diagrams (Context/Container/Component/Code)            | _visualizing_ an existing/planned structure        | shared notation across abstraction levels                              | **explicitly not a design process**; static only | V2   |
| **arc42**                                           | a 12-section architecture-doc template                                          | comprehensive architecture documentation           | thorough, well-known                                                   | far too heavy for a solo CLI epic                | E    |
| **SEI "Views & Beyond"**                            | multi-view documentation package                                                | large/long-lived systems needing formal docs       | rigorous, complete                                                     | enterprise-scale overkill here                   | E    |
| **Strategic DDD + Event Storming**                  | bounded-context map; event-storm wall                                           | complex _domains_ with many actors/events          | aligns boundaries to domain language                                   | needs a rich domain; thin for a CLI tool         | E    |
| **Requirements elicitation** (IEEE/SWEBOK)          | elicited, documented requirements                                               | any non-trivial requirements gap                   | the discipline behind all the below                                    | a field, not a single technique                  | E    |
| **Jobs-To-Be-Done** (Ulwick/Christensen)            | a job statement + desired outcomes                                              | finding the _real_ underlying need                 | anchors on need, not feature                                           | can over-abstract for small tools                | E    |
| **Impact Mapping** (Adzic)                          | a goal→actor→impact→deliverable mind map                                        | connecting deliverables back to a goal             | kills work that serves no goal                                         | lightweight on acceptance detail                 | E    |
| **Example Mapping / BDD / INVEST**                  | rules + concrete examples; Gherkin; INVEST check                                | making acceptance criteria concrete & testable     | examples expose edge cases early                                       | ceremony if over-applied                         | E    |
| **5 Whys** (Ohno)                                   | a root-cause chain                                                              | getting past a symptom to the real ask             | trivially cheap; surfaces intent                                       | single-path; not exhaustive                      | E    |
| **ISO/IEC/IEEE 29148 / Volere**                     | a full SRS / requirements spec                                                  | regulated or contractual requirements              | exhaustive, auditable                                                  | **gross overkill** for a solo CLI tool           | E    |
| **Socratic method (Paul–Elder)**                    | (process) six question types that surface assumptions                           | interrogating an under-specified ask               | structured way to find hidden assumptions                              | can over-question; needs a stop rule             | V2   |
| **GitHub Spec Kit**                                 | `spec.md` → `plan.md` → `tasks.md` (+ research/data-model/contracts)            | AI-driven spec→plan→tasks for one feature          | **the closest working analogue**; `[P]`-marked, dependency-aware tasks | per-feature, not epic-of-features; tool-heavy    | V2   |
| **AWS Kiro**                                        | `requirements.md` (EARS) / `design.md` / `tasks.md`                             | AI-driven spec with human approval gates           | EARS = testable criteria; **per-phase approval checkpoints**           | three files may be more than a solo dev needs    | V2   |
| **EARS** (Mavin)                                    | acceptance criteria in `WHEN…THE SYSTEM SHALL…`                                 | writing unambiguous, testable criteria             | machine-checkable, low-ambiguity                                       | rigid for purely subjective criteria             | V2   |

## Area-by-area detail

### Area 1 — High-level / system design & its artifacts

**Design docs / RFCs / Oxide RFDs [E].** The dominant professional practice for "align before building" is a prose **design document** (Google's internal design-doc culture) or a numbered **RFC/RFD** (IETF since 1969; Rust RFCs; Oxide's RFDs stored at a deterministic `/rfd/{number}/README.md` git path with a lifecycle state machine). Artifact: one reviewable document carrying problem, proposed approach, **alternatives considered**, and rationale. For the epic designer this is the right _shape_ for the high-level-design artifact — but lightweight (one `design.md`), not a templated RFD process.

**ADR [V2].** A 1–2 page record of _one_ architecturally-significant decision: Title, Status (proposed/accepted/deprecated/superseded), Context (forces), Decision ("We will…"), Consequences. The key insight for this project: **Parnas's "list of difficult design decisions" maps almost exactly onto a set of ADRs** — so the design artifact's decision-capture should be ADR-shaped (decision + status + consequences), even if inlined into `design.md` rather than split into many files.

**C4 [V2].** Four static-structure diagram levels (Context/Container/Component/Code). Verified caveat from the official FAQ: _"a common misconception is that a team's design process should follow the levels in the C4 model hierarchy… it implies nothing about the process of delivering software."_ C4 is **notation, not method**, and covers only static structure (not workflows/data models). **Verdict: gold-plating for a solo CLI epic.** At most, borrow the _Context-level_ idea as a one-paragraph "where this sits" + a Mermaid DAG; do not adopt C4 as a process or draw four diagram levels.

**arc42 / SEI "Views & Beyond" [E].** Comprehensive architecture-documentation frameworks (arc42's 12 sections; SEI's multi-view packages). Both are **calibrated for large, long-lived, multi-stakeholder systems**. For a single developer's CLI epic they are clear over-documentation — named here so the decision to exclude them is deliberate, not an oversight.

**Strategic DDD + Event Storming [E].** Bounded contexts, context mapping (Evans/Vernon), and Event Storming (Brandolini) excel when the hard part is a **rich domain** with many actors and events. A CLI tool's epics are usually thin-domain/heavy-mechanism, so the payoff is low. Borrow one idea: _bounded context ≈ a feature's information-hiding boundary_ — which is just Parnas again.

### Area 2 — Decomposition (the spine — see Headline finding)

Beyond Parnas [V1] and Simon [V1]: **Conway's Law [E]** (system structure mirrors communication structure) is a weak lever for a solo dev but a useful _diagnostic_ — the seams that hold are the ones along which work actually flows. **Coupling & cohesion [E]** (Stevens/Myers/Constantine, 1974) is the operational restatement of Simon's weak-coupling criterion: maximize within-feature cohesion, minimize cross-feature coupling. **DSM [E]** (Steward/Eppinger) is the _mechanical_ version — an N×N dependency matrix you cluster (to find modules) and sequence (to find build order, and any cycles show as below-diagonal marks); **valuable at dozens-of-elements scale, overkill for an epic of a handful of features** (the research's own open question flags this — hand-drawn edges + a cycle check suffice here). **WBS + 100% rule [E]** guarantees completeness but produces a _tree_, not a DAG — it can't express cross-branch dependencies, which is exactly what a feature DAG needs, so it's the wrong primary structure. **MECE / issue trees [E]** (Minto) keep a decomposition gap-free and overlap-free — a good _checklist property_ for the feature set, not a graph model. **Shape Up [E]** is the important dissenting voice (next paragraph). **User Story Mapping [E]** (Patton) contributes the **walking-skeleton / thin-first-slice** idea — a strong heuristic for choosing the DAG's root feature.

**Shape Up's anti-breakdown stance, reconciled [E].** Basecamp's Shape Up deliberately _refuses_ to hand builders a pre-broken task list — it ships a _shaped pitch_ (a breadboard + a fat-marker sketch at a fixed _appetite_) and lets the building team discover its own tasks. This looks like it contradicts producing a dependency DAG. It doesn't, once you place it at the right altitude: **the epic designer decomposes into _features_ (coarse, appetite-bounded), and each feature's own `flow` pipeline rediscovers its internal _tasks_.** So the designer is "shaping at the epic level" and the existing per-feature pipeline is "shaping at the feature level" — Shape Up applied recursively, not violated. The DAG is over features (legitimate sequencing), not over tasks (which Shape Up rightly resists pre-specifying).

### Area 3 — Distilling / clarifying requirements

**The professional toolkit [E]:** Jobs-To-Be-Done (anchor on the underlying need, not the requested feature), Impact Mapping (tie every deliverable back to a goal — kill work that serves none), Example Mapping + BDD/Gherkin (make acceptance criteria concrete via examples), INVEST (Independent/Negotiable/Valuable/Estimable/Small/Testable — a quality checklist that, notably, lists _Independent_ and _Small_, the same properties a good DAG feature needs), and the 5 Whys (cheap root-cause/intent probe). **29148/Volere [E]** define a full SRS — **explicitly overkill** for a solo CLI tool and named only to exclude.

**EARS [V2]** is the high-value pick: acceptance criteria written `WHEN <trigger> THE SYSTEM SHALL <response>` are _"unambiguous and testable… easy to translate into test cases"_ (verified via Kiro's docs, which adopt EARS). This dovetails with flow's _existing_ discovery rule that every acceptance criterion name an externally-failable check — EARS is a concrete syntax for exactly that. **Recommendation: adopt EARS-style criteria in the requirements section.**

### Area 4 — Socratic questioning & the interaction-model decision

**Paul–Elder six question types [V2]:** (1) clarification, (2) probing assumptions, (3) probing reasons/evidence, (4) viewpoints/perspectives, (5) probing implications/consequences, (6) questions about the question. The taxonomy is a structured way to **surface hidden assumptions** before committing to a decomposition. ([Foundation for Critical Thinking / Paul & Elder](https://www.criticalthinking.org/pages/socratic-teaching/606); corroborated via [U. Michigan teaching materials](https://websites.umich.edu/~elements/5e/probsolv/strategy/cthinking.htm).)

**The evidence on interactive vs one-shot — the key decision:**

- **The two most analogous tools both clarify interactively [V2].** Spec Kit runs _"iterative dialogue… the AI asks clarifying questions, identifies edge cases,"_ and mandates `[NEEDS CLARIFICATION: …]` markers **rather than guessing**. Kiro gates each phase behind **user review/approval** (_"Confirm when requirements meet your needs"_ before design). Independently converged design from the two leading spec-driven tools is strong professional evidence that **some** interactive clarification beats pure one-shot for ambiguous specs.
- **But more questions is not better — materiality matters [V2].** CMU's _"What Prompts Don't Say"_ (Yang et al., 2025) finds underspecified prompts are _"2× as likely to regress across model or prompt changes,"_ yet forcing a model to honor 19 requirements at once **drops accuracy to 85.0% (vs 98.7% individually)** — _"excessive specification causes interference."_ Their recommendation: selectively specify only the **critical** requirements. ([arXiv:2505.13360](https://arxiv.org/abs/2505.13360))
- **flow's own posture** is one-shot discovery + surfaced assumptions + a single approval checkpoint (`plan-pending-review`).

**Synthesis (drives `02-design-spec.md` §3): a HYBRID — one bounded round of _material_ Socratic questions, then autonomous, then a single approval checkpoint.** Pure one-shot under-resolves a high-stakes epic's ambiguity (Spec Kit/Kiro both reject it); a multi-round loop over-questions and fights flow's walk-away model (and the CMU interference finding warns against specifying everything). The evidence-backed middle is: ask only the **load-bearing** clarifications (the ones whose wrong answer invalidates the whole decomposition — gated on materiality, à la CMU "critical requirements only"), use the Paul–Elder types to find them (especially _assumptions_ and _implications_), then proceed autonomously and surface the rest as Open Questions at the checkpoint (flow's existing pattern, which is itself Kiro's per-phase-approval idea).

### Area 5 — Spec-driven development (the directly-analogous prior art)

**GitHub Spec Kit [V2]:** `/speckit.specify` → `spec.md` (user stories, acceptance criteria); `/speckit.plan` → `plan.md` + `research.md`/`data-model.md`/`contracts/` (architecture + technical decisions); `/speckit.tasks` → `tasks.md` (executable tasks **derived from contracts/entities/scenarios**, with **`[P]` markers for independent/parallel-safe tasks and safe parallel groups**). This is the **single closest analogue** to the epic designer's pipeline — and it already proves the two hardest pieces: an LLM can emit a _dependency-aware, parallel-annotated_ task list, and interactive `[NEEDS CLARIFICATION]` beats silent guessing.

**AWS Kiro [V2]:** the three-file model — `requirements.md` (user stories + **EARS** criteria) → `design.md` (architecture, **sequence diagrams, data models**, tech stack, error handling, testing strategy) → `tasks.md` (discrete trackable tasks) — with **human approval between each phase**. Kiro is the strongest precedent for _artifact set_ and _checkpointing_; its three files are the upper bound on what the designer should emit (flow can likely collapse requirements+design into one doc — see `02` §5).

**Failure modes / empirical read [V2 + E]:** the CMU underspecification result [V2] is the cleanest empirical warning — LLMs fill spec gaps only ~41% of the time and inconsistently, so **leaving critical things unspecified is the dominant failure mode**, which is precisely what the interactive `[NEEDS CLARIFICATION]` discipline guards against; the opposite failure (over-specification interference) bounds how much to clarify. The harness located two further spec-driven-dev evaluation preprints ([arXiv:2509.13941](https://arxiv.org/abs/2509.13941), [arXiv:2510.14509](https://arxiv.org/pdf/2510.14509)) that I did not re-fetch this session — flagged [E] as available-but-unverified for a future deeper pass.

## Complementary vs mutually-exclusive

**Complementary (compose freely):**

- **Parnas × Simon** — the same cut viewed two ways (volatility criterion × weak-coupling seam). The spine.
- **Design doc / ADR × C4** — orthogonal: ADR captures _decisions_ (the "why"), a C4-context sketch or Mermaid DAG captures _structure_ (the "shape"). The C4 FAQ itself frames C4 as documentation that _supplements_ other artifacts. Use ADR-shaped decisions + one structural diagram, not one instead of the other.
- **EARS × Example Mapping × INVEST** — all serve "make criteria concrete and testable"; EARS is the syntax, examples expose edge cases, INVEST is the per-feature quality gate.
- **Socratic clarification × surfaced-assumptions/Open-Questions** — _sequential_, not competing: Socratic questions up front for the material ambiguities, Open Questions at the checkpoint for the residue.
- **Story Mapping's walking skeleton × the DAG root** — the thin first slice _is_ the DAG's root feature.

**Mutually exclusive / in tension (pick one, or place at different altitudes):**

- **Shape Up's no-upfront-breakdown ⟂ WBS/DSM upfront decomposition** — genuinely opposed _at the same altitude_. Resolved by altitude: features upfront (designer), tasks deferred (per-feature pipeline). Don't try to honor both over the same unit.
- **Interactive multi-round elicitation ⟂ pure one-shot autonomous discovery** — opposed as stated; the **hybrid** (materiality-gated single round) is the named middle ground the evidence supports, not a fence-sit.
- **Full SRS (29148/Volere) ⟂ lightweight spec** — a contractual SRS and a one-page `design.md` are different commitments; for a solo dev only the lightweight end is viable. Not a real choice here.
- **WBS tree ⟂ dependency DAG** — a tree can't express cross-branch edges; the DAG must be the primary model, with MECE used only as a gap/overlap _check_ on the feature set.

## Ranked end-to-end pipelines for THIS context

Each pipeline is `clarify → design → decompose → DAG`, named by the methods it composes and the artifacts it emits. Ranked for a single developer, CLI/tmux tool, epic → DAG of PR-sized features.

**① RECOMMENDED — "Lean spec-driven, Parnas/Simon decomposition, hybrid clarify."**

- _Clarify:_ materiality-gated **Socratic** round (Paul–Elder, focus on assumptions/implications) → **EARS** acceptance criteria; residue as Open Questions. (Spec Kit's `[NEEDS CLARIFICATION]` + Kiro's approval gate, bounded by the CMU "critical-only" finding.)
- _Design:_ one lightweight **design doc** with **ADR-shaped** decisions = Parnas's "list of likely-to-change decisions"; a Mermaid context/DAG sketch (the one borrowed C4 idea).
- _Decompose:_ **Parnas** (boundary = hidden volatile decision) + **Simon** (cut at weak-coupling seams) + **Shape-Up-at-feature-altitude** (features now, tasks later); **Story-map walking skeleton** picks the root.
- _DAG:_ explicit typed edges (B depends on A ⇔ B consumes A's output) + a cycle/orphan validator; **no DSM** (overkill at this scale).
- _Artifacts:_ `design.md` (requirements+design+Mermaid DAG) + `manifest.json` (typed feature DAG).
- _Why #1:_ every stage is either harness-verified (Parnas/Simon) or matches the two leading spec-driven tools (Spec Kit/Kiro) at the **minimum** artifact weight that still works; it reuses flow's existing discovery + checkpoint machinery; it is the only pipeline whose every choice is evidence-backed _and_ minimal.

**② "Kiro-faithful three-file."** Same methods, but emit Kiro's full three files (`requirements.md` / `design.md` / `tasks.md`) verbatim and gate approval between each.

- _Trade-off:_ maximal fidelity to the best-documented precedent and the clearest review checkpoints — but three approval gates and three files is **more ceremony than a solo dev reviewing one epic needs**, and "tasks" here are features (the manifest), so the third file partly duplicates the manifest. Strong #2; the extra gates are its cost.

**③ "Heavy-architecture."** Add C4 (four diagrams) + arc42 sections + a DSM clustering pass.

- _Trade-off:_ most rigorous structural documentation — and clearly **gold-plating** for a single-dev CLI epic (C4 is explicitly not a process; arc42 targets large systems; DSM needs dozens of nodes to earn itself). Listed to be explicitly rejected.

**④ "Pure one-shot autonomous."** No clarification round; make defensible assumptions, emit everything, single checkpoint.

- _Trade-off:_ lowest interaction cost and closest to flow's current discovery — but both analogous tools reject pure one-shot for ambiguous specs, and the CMU result shows unspecified-critical-requirements is the dominant LLM failure mode. Viable as a _fallback_ when an epic is already crisp; inferior as the default.

**Recommendation: ① as the default, with ④ as the auto-fallback when the epic prompt is already unambiguous (no material questions found → skip the round).** This is exactly the hybrid: the clarification round is _conditional on materiality_, so a crisp prompt degrades gracefully to one-shot.

## Sources

Primary, by tier. (External links are not checked by flow's `flow-md-validate`; internal cross-refs are by filename.)

**[V1] Harness-verified primary sources:**

- David Parnas, "On the Criteria To Be Used in Decomposing Systems into Modules," CACM 15(12):1053–1058, 1972 — https://cacm.acm.org/research/on-the-criteria-to-be-used-in-decomposing-systems-into-modules/
- Herbert A. Simon, "The Architecture of Complexity," Proc. American Philosophical Society 106(6):467–482, 1962 — https://www2.econ.iastate.edu/tesfatsi/ArchitectureOfComplexity.HSimon1962.pdf

**[V2] Author-verified this session:**

- GitHub Spec Kit — https://github.com/github/spec-kit/blob/main/spec-driven.md
- AWS Kiro specs — https://kiro.dev/docs/specs/feature-specs/requirements-first/
- Michael Nygard, "Documenting Architecture Decisions," 2011 — https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions
- Simon Brown, C4 model FAQ — https://c4model.com/faq
- C. Yang et al., "What Prompts Don't Say: Understanding and Managing Underspecification in LLM Prompts," 2025 — https://arxiv.org/abs/2505.13360
- Paul & Elder, Socratic questioning (Foundation for Critical Thinking) — https://www.criticalthinking.org/ ; corroborated https://websites.umich.edu/~elements/5e/probsolv/strategy/cthinking.htm
- EARS (Easy Approach to Requirements Syntax) — Mavin et al., 2009 (confirmed in use via Kiro docs above)

**[E] Established, source-located, not independently re-fetched this session:**

- Melvin Conway, "How Do Committees Invent?" 1968 — https://www.melconway.com/Home/Conways_Law.html
- Oxide RFD process — https://oxide.computer/blog/rfd-1-requests-for-discussion
- SEI "Documenting Software Architectures: Views and Beyond" — https://sei.cmu.edu/library/documenting-software-architectures-views-and-beyond-second-edition/
- arc42 — https://faq.arc42.org/ ; Stevens/Myers/Constantine (coupling & cohesion, 1974); Steward/Eppinger (DSM); PMI (WBS, 100% rule); Minto (MECE/Pyramid Principle); Singer/Basecamp (Shape Up); Patton (User Story Mapping); Ulwick/Christensen (JTBD); Adzic (Impact Mapping); Wynne (Example Mapping); Wake (INVEST); Ohno/Toyota (5 Whys); ISO/IEC/IEEE 29148; Robertson (Volere); Evans/Vernon (DDD); Brandolini (Event Storming)
- Further spec-driven-dev evaluation preprints located but not re-fetched: https://arxiv.org/abs/2509.13941 , https://arxiv.org/pdf/2510.14509
