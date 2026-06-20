# Epic designer — design dossier

The design for the **epic designer**: flow's epic-layer _design phase_. It takes one high-level epic prompt and emits clarified requirements → a high-level design → a decomposition into a dependency DAG of PR-sized "features" (each later built by one ordinary `flow new` pipeline), then **stops**. The orchestrator/run phase that would _execute_ that DAG is intentionally deferred and out of scope here — these documents only leave clean seams for it.

This is a **recommendation awaiting approval**, not shipped behaviour. Nothing here creates GitHub issues or changes flow's code.

## Read in this order

1. **[01-research-report.md](./01-research-report.md)** — how experts clarify requirements, design systems, and decompose large problems; method → artifact → when → pros/cons, complementary-vs-exclusive analysis, and ranked pipelines for this context. Carries explicit confidence tiers (the deep-research verification pass was rate-limited; this report repairs that with author-verified primary sources and flags exactly what rests on what).
2. **[02-design-spec.md](./02-design-spec.md)** — the resolved design: interaction model (hybrid), methodology, the two-file artifact set, decomposition + DAG-validation rules, reuse-vs-new, storage, and command naming. Every significant choice has options, a named middle ground, and a recommendation.
3. **[03-build-plan.md](./03-build-plan.md)** — the decomposed build plan for _implementing_ the designer, expressed as a 5-feature dependency DAG in the exact shape the designer itself emits (the recursion / dogfooding proof). Ordered, MVP marked, with an embedded schema-valid `manifest.json`.
4. **[05-user-and-file-flow.md](./05-user-and-file-flow.md)** — a worked end-to-end walkthrough: the actions you take, where every file lives, when each is deleted, and when the supervisor starts/pauses/resumes (design phase designed; run phase tagged _deferred_).
5. **[04-artifact-storage-recommendation.md](./04-artifact-storage-recommendation.md)** — where the designer's artifacts live (committed markdown + JSON manifest vs GitHub Issues vs beads vs runtime state), ranked, with a clear default.
6. **[00-prior-architecture-review.md](./00-prior-architecture-review.md)** — _input, not output._ The prior architecture review of the whole epic layer (it spans **both** the design phase and the now-out-of-scope orchestrator). Persisted here from scratch so the eventual build can rely on it durably. Context, not gospel — challenged where the research warranted (most notably: it filed the manifest under per-machine runtime state; this dossier commits it to git instead — see `04`).

## TL;DR — the decisions

- **Interaction model:** hybrid — one bounded round of _material_ clarifying questions, then autonomous, then one approval checkpoint. Backed by Spec Kit + Kiro (both clarify interactively) and CMU's underspecification study (clarify the critical few, not everything).
- **Methodology:** lean spec-driven front, Parnas (information hiding) + Simon (near-decomposability) decomposition spine, Shape-Up-at-feature-altitude, walking-skeleton root.
- **Artifacts (minimal):** two committed files — `design.md` (requirements in EARS + ADR-shaped decisions + a Mermaid DAG) and a schema-validated `manifest.json` (the typed feature DAG). C4 diagrams, arc42, a separate ADR log, event storming, and a full SRS are all explicitly excluded as gold-plating for a solo CLI epic.
- **Decompose by:** volatile design decisions (each feature hides one "secret"); cut at weak-coupling seams; vertical slices that each pass their own PR gate; edges are produced/consumed artifacts, not vibes; validated acyclic + orphan-free.
- **Reuse:** the designer is `/product-planning` at epic altitude — it reuses flow's discovery, state model, slug, schema-validator pattern, and the `flow new` → `/flow-pipeline` executor wholesale. The genuinely new surface is a manifest schema, a DAG validator, a `flow epic create` verb, and the epic-grain discovery extension.
- **Storage:** git-committed under `.flow/epics/<slug>/` in the target repo; GitHub Issues only as a later opt-in _projection_; beads deferred behind an adapter (its DB breaks git-auditability); `~/.flow/` reserved for the deferred orchestrator's runtime status.
- **Name:** a consistent `flow <noun> <verb>` scheme — `flow feature run` (rename of today's `flow new`), `flow epic create` (the designer), `flow epic run` (deferred orchestrator); aliases `feat`/`ep` plus a bare `flow feat "<desc>"`. `create` chosen over `design` for CLI-standard consistency with `run`; `shape` rejected (Shape Up refuses the task breakdown the designer produces).
