# PRD

> **This is an architecture review, not a feature spec.** The user explicitly said "assume I might be wrong." The PRD below is weighted toward decisions and trade-offs. It challenges the proposed two-component split, recommends a smaller v1 than the user described, and grounds the autonomy question in flow's actual gate mechanics (read from source, not guessed). Where the user posed a binary, a middle ground is named. The single most important reframe is in **Architecture Decision A** and **Prompt interpretation** below.

## Problem Statement

Today flow ships one change end-to-end per `flow new` invocation: one tmux window, one Claude Code supervisor, one PR, one feature. A coherent body of work larger than a single PR — "implement a payment subscription system" — has no first-class representation. The user must decompose it by hand, run `flow new` N times, manually sequence the features (feature B can't start until feature A's schema lands), and babysit each pipeline's gates one tmux window at a time. The dominant cost is **context-switching and manual sequencing across features**, not the per-feature work itself (flow already does that well).

The user proposes a new layer with two components: an "epic designer" (does system design / requirements / specs, runs in tmux, does **no** pipeline work) and an "epic orchestrator" (consumes the designer's output, runs the per-feature pipelines, monitors them, and ideally merges autonomously). This PRD evaluates whether that's the right shape, what the minimal valuable version is, and — the crux — how far autonomy can go given flow's deliberately-non-overridable gates.

## Scope Boundary

**In scope (this review):**

- A decision on the component decomposition (two components vs one-with-phases vs designer-as-enriched-`/product-planning`).
- A name for the design component and a coherent verb namespace.
- A complete enumeration of every human gate in the current pipeline, and for each: can an orchestrator pass it autonomously today, what is the minimal change to enable autonomy, and what _should_ stay human.
- The orchestrator ↔ running-feature interaction model.
- The tracker decision (beads vs GH Issues vs bespoke vs none-yet) behind an adapter seam.
- Supervisor-vs-script and daemon-vs-no-daemon recommendations.
- An honest value-add estimate with a payoff threshold.
- A phased, dependency-ordered task breakdown (itself a DAG).

**Out of scope (explicitly):**

- Building any of it. This is strategy only.
- Changing the existing single-feature pipeline's behaviour. The user confirmed the traditional pipeline "keeps working as-is"; this layer sits _above_ it and calls it unchanged.
- A web UI, Slack/Jira integration, or any non-terminal surface (flow is a tmux/CLI tool; AGENTS.md "What flow is not").
- Cross-repo epics. v1 is single-repo, matching `flow-create-issue`'s current-repo-only constraint.

## User Stories / Acceptance Criteria

These describe the _thinnest valuable epic layer_ (see Recommendation), not the user's full two-component vision, and are written with externally-failable criteria for the eventual v1.

**Story 1 — Decompose an epic into a dependency-ordered feature manifest.**
Given a one-line epic prompt, When I run the epic-design entry point, Then a manifest file is written to disk listing N features, each with a title, a one-line description, and an explicit `dependsOn` edge set, And the manifest passes a schema validator (the validator helper exits 0), And the dependency graph is acyclic (a `flow-epic-dag --validate` call exits 0 on a valid DAG and non-zero on a cycle).

**Story 2 — Compute the ready set from the manifest.**
Given a manifest with a partial completion state, When the ready-set helper runs, Then it prints exactly the features whose dependencies are all complete and which are not themselves complete (Kahn's-algorithm frontier), And `bun bin/flow-epic-dag.test.ts` covers the empty-graph, linear-chain, diamond, and cycle cases.

**Story 3 — Launch ready features as standard pipelines.**
Given a computed ready set and a concurrency cap K, When the launcher runs, Then it invokes the existing `flow new` path once per ready feature up to K, And each launched feature appears in `flow ls` as an ordinary pipeline (no new pipeline machinery), And the epic records each launched feature's slug in epic state.

**Story 4 — Detect feature completion and advance the frontier.**
Given launched features, When a feature reaches `merged` in its `~/.flow/state/<slug>.json`, Then the epic layer observes the terminal phase by reading that state file (no tmux screen-scraping), And on the next tick/turn it recomputes the ready set and launches newly-unblocked features, And a feature that reaches `gated` or `needs-human` is surfaced to the user and does **not** silently block the whole epic forever (it is reported; the rest of the DAG that doesn't depend on it keeps moving).

**Story 5 — Status across the epic.**
Given a running epic, When I run the epic-status entry point, Then I see each feature's title, slug, current phase (from its state file), and PR link if open, grouped by done / running / ready / blocked, And the output is a single table a human can scan (build on `flow ls` and `flow-pipeline-summary`).

**Story 6 (deferred to a later phase) — Autonomy: features born auto-mergeable.**
Given an epic run in autonomous mode, When a feature's PR is opened, Then — for features the designer classified as low-blast-radius — the PR is authored so the auto-merge gate clears on its own merit (zero unchecked `## Test Steps` items because every check is automatable and run), So the existing `flow-gate-decide` → auto-merge path fires **without** any gate override. This story explicitly does **not** add an "orchestrator overrides a `gated` verdict" capability — see Architecture Decision C.

## Architecture Decisions

### A. The two-component split is half-right. Recommend ONE entry point with TWO phases; the "designer" is an enriched `/product-planning`, the "orchestrator" is `flow new` reused under a thin scheduler. (CHALLENGE to the user's framing.)

The user prescribed two **separate** components: a designer that does "completely separate pipeline … does not do any part of the flow pipeline," and an orchestrator that runs the pipelines. Two observations cut against building two heavyweight components:

1. **The "designer" is ~80% an enriched `/product-planning` run.** flow already has an Independent Discovery Subagent (`/product-planning`) that reads the codebase, makes architecture decisions, drafts a PRD, and emits a dependency-ordered task breakdown to `.flow-tmp/plan.md`. The user's designer wants the same outputs at a coarser grain (features instead of tasks, an inter-feature DAG instead of an intra-feature task order, plus system/flow diagrams). That is a _grain change and an output-format change to an existing capability_, not a new pipeline. Building a "completely separate" designer would duplicate discovery's codebase-reading, assumption-surfacing, and binary-framing machinery. **Recommend: the designer is `/product-planning` run at epic altitude, emitting an epic manifest (features + DAG) instead of (or in addition to) a task list.** This is the single biggest place the user's framing should change.

2. **The "orchestrator" is a thin scheduler around the existing `flow new`, plus a small amount of judgment.** The heavy lifting (worktree, plan, implement, verify, CI, review, gate, merge) is _already_ the `/flow-pipeline` supervisor, which the orchestrator does not reimplement — it launches. What the orchestrator adds is: read the manifest, compute the ready set (deterministic), launch ready features via `flow new` (deterministic), watch state files for completion (deterministic), and — only where judgment is genuinely needed — interpret a feature failure and decide whether to retry, redirect, or escalate the whole epic (LLM). So the orchestrator is **mostly a script with a thin LLM judgment layer**, not a second heavyweight supervisor. See Architecture Decision I.

The Shape Up precedent (researched) reinforces this: Basecamp explicitly _disowns_ "the architect/taskmaster who splits the project into pieces for others to execute"; the whole shaped pitch goes to the building team, which discovers its own tasks. flow's pipeline already discovers its own tasks (via `/product-planning`/`/new-feature` per feature). So the orchestrator should hand each feature a coarse description and let the existing pipeline shape it — not micro-plan every feature up front.

**The middle-ground decomposition (recommended):** one user-facing entry (`flow epic "<prompt>"`) that runs **two phases in sequence with an approval checkpoint between them** — Phase 1 = design (enriched `/product-planning` → epic manifest, surfaced for approval, exactly like today's `plan-pending-review`), Phase 2 = orchestrate (the scheduler launches features as the DAG unblocks). The sub-verbs (`flow epic design`, `flow epic run <id>`, `flow epic status <id>`) stay available for manual control. This collapses "two components" into "two phases of one component," reusing both `/product-planning` and `/flow-pipeline` wholesale.

**A / middle / B trade-off recorded (binary the user posed — "manually invoke create then run, or run `flow epic` and delegate"):**

- **A (two explicit steps, `epic create` then `epic run`):** maximal manual control; the user is the integration point. Cost: more commands, easy to forget `run`, and the "where does the ID come from" friction the user already flagged.
- **B (single `flow epic`, fully delegated):** one command, hands-off. Cost: no human checkpoint between design and a multi-feature execution that will open many PRs — exactly where review is most valuable.
- **Middle (recommended): single `flow epic "<prompt>"` with an approval checkpoint between design and execution, sub-verbs still available.** One-command ergonomics AND the load-bearing human checkpoint AND manual escape hatches. Mirrors the existing pipeline's own shape (auto-progress, pause once for plan approval).

### B. Name: recommend `epic` as the namespace and `design` / `run` / `status` as verbs; reserve `shape` as the design-phase concept if a single-word design noun is wanted.

The field's vocabulary (researched): the authoring artifact is overwhelmingly a **spec** (GitHub Spec Kit, AWS Kiro, Tessl all center on it); the authoring _act_ is `specify`/`design` (Spec Kit, Kiro) or the richer `shape` (Basecamp Shape Up); the execution side is `tasks`/`implement` (Spec Kit, Kiro), with `orchestrator`/`conductor`/`runner` common in the agent space but used by _none_ of the canonical spec tools as a headline term.

Candidates for the design component, evaluated:

- **`design`** (recommended as the verb) — Kiro names its middle artifact `design.md`; instantly legible; pairs naturally with `run`. As a _verb_ under the `epic` namespace (`flow epic design`) it avoids the noun-collision problems below.
- **`shape`** — the most _precise_ fit (Shape Up: produce an abstract outline a separate team executes), distinctive and ownable. **Strong second choice.** `flow epic shape` reads well. Caveat: less instantly understood than `design`.
- **`spec`** — strongest field resonance but generic/crowded, and flow already overloads "plan"; adding "spec" risks plan/spec/manifest confusion.
- **`architect`** — conveys system design, BUT Shape Up explicitly disowns "the architect who splits the project into pieces for others to execute." Since the recommendation is precisely _not_ to over-prescribe (the executor is the existing pipeline, which discovers its own tasks), `architect` is subtly off-message. Avoid.
- **`charter` / `blueprint`** — `charter` maps to Spec Kit's _constitution_ (governing principles), too narrow; `blueprint` reads as the output noun, not the actor. Either works as the _artifact_ name if `design`/`shape` is the verb.

For the execution component: **`run`** (recommended verb) — simplest, most legible "execute the plan"; `flow epic run`. `orchestrator`/`conductor` are accurate but heavy for a CLI verb; keep "orchestrator" as the internal role name in docs, not the user-facing verb.

**Recommended overall namespace:**

- `flow epic "<prompt>"` — single entry, design → checkpoint → run.
- `flow epic design "<prompt>"` — design phase only; emits a manifest + ID.
- `flow epic run <id>` — execute an existing manifest.
- `flow epic status <id>` — cross-feature status.
- `flow epic ls` — list epics (mirrors `flow ls`).

Keep `flow new` exactly as-is for single features. The user floated renaming it to `flow feature`/`feat`/`f`; **recommend against** a rename — `flow new` is the documented surface (README, AGENTS.md, completion scripts, dozens of skill references). A rename is churn with no payoff; if a `feature` alias is desired, add it as an _alias_ of `new`, don't rename. (Out of scope for the epic layer regardless.)

### C. Autonomy / gate-passing (THE CRUX): make features _born auto-mergeable_; never let the orchestrator override a gate. Recommend "orchestrator does all the back-and-forth, human approves the load-bearing gates."

This is the heart of the review and the user's biggest open question ("not sure if the tooling has sufficient permissions to pass all the flow gates"). I read the gate mechanics from source rather than guessing. Here is **every human gate / checkpoint in the current pipeline**, whether an orchestrator can pass it autonomously today, the minimal change to enable autonomy, and the recommended stance:

| Gate / checkpoint                                                                      | Where                                                                                           | Auto-passable **today**?                                                                                                                                                                                                                                                                        | Minimal change to enable                                                                                                                                                                                                                           | **Recommended stance**                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plan approval** (`plan-pending-review`)                                              | Step 3→4, feature intent                                                                        | No — the supervisor writes `plan-pending-review` and ends the turn, waiting for the user to type `approved`/redirect/cancel (SKILL.md step 4).                                                                                                                                                  | The epic's _design checkpoint_ (Phase 1) is where the human approves the **whole epic's** decomposition once. Per-feature plan approval can then be pre-authorized for that epic run via an epic-scoped flag the launcher threads into `flow new`. | **Human approves once, at the epic level** (Phase 1 checkpoint). Per-feature plans auto-approve under that umbrella. Highest-value human gate — keep it, but lift it to epic granularity so the human isn't re-approving N times. |
| **Candidate-issues form** (AskUserQuestion)                                            | Step 4 affirmative + step 3 non-feature `advance-to-step-5`                                     | No — synchronous `AskUserQuestion` (one of two named forms). `flow-candidate-issues` returns `no-op`/`prompt`/`overflow`/`skip-already-ticked`; only `prompt`/`overflow` block.                                                                                                                 | The epic design phase can _pre-tick or omit_ candidate follow-ups in each feature's plan.md so the helper returns `no-op` (confirmed: `no-op`/`skip-already-ticked` never prompt and never end the turn).                                          | **Auto-skip per-feature**; collect epic-level follow-ups once at the design checkpoint. Don't fire N candidate-issues prompts during an epic.                                                                                     |
| **Gated verdict** (unchecked `## Test Steps`)                                          | Step 9, `flow-gate-decide`                                                                      | No, and **deliberately so**. `auto-merge-rubric.md`: "a `gated` verdict is terminal, not advisory." `flow-merge-guard` re-derives the verdict from a _fresh_ `gh pr view` at merge time and makes the merge path mechanically unreachable on any unchecked item without a fresh override token. | **Do NOT add an orchestrator-overrides-gated path.** Instead, author features so the gate clears on its own merit: every Test Steps item automatable, run, and ticked (Story 6). The gate then returns `auto-merge` with zero overrides.           | **Born auto-mergeable, never override.** The safe-by-construction route the research overwhelmingly endorses. The orchestrator makes work _ready_ for the gate, never bypasses it.                                                |
| **Step-9 gate-override form** (AskUserQuestion + `flow-merge-guard --record-override`) | Step 9 gate-override sub-step                                                                   | Exists precisely to require a _fresh, human, in-context_ confirmation to merge a gated PR. Token is PR-scoped and expires in 30 min (`OVERRIDE_FRESHNESS_MS`).                                                                                                                                  | None — and none _should_ be added for the orchestrator. An LLM self-recording an override defeats the guard's whole purpose (the incident it exists for: a supervisor rationalized past a correct gated verdict and shipped a broken feature).     | **Stays human-only.** The orchestrator surfaces the gated feature; the human decides. Reward-hacking research (METR/o3; Claude answer-key) is the principled backstop: an agent that owns its merge gate will sometimes game it.  |
| **Copilot / CI waits**                                                                 | Step 7 (`flow-ci-wait`), `waitForCopilot`                                                       | Yes — _time_ waits, not human gates. The supervisor already backgrounds `flow-ci-wait` and yields (`ci-wait-pending`).                                                                                                                                                                          | Already automatable; the orchestrator just lets the feature pipeline handle it.                                                                                                                                                                    | **No change.** Already autonomous.                                                                                                                                                                                                |
| **needs-human escalations**                                                            | Many (`worktree-create-failed`, `merge-failed`, `triage-ambiguous`, `task-tool-unavailable`, …) | No, by design — "I'm genuinely stuck" signals.                                                                                                                                                                                                                                                  | None. An orchestrator that auto-retries past `needs-human` would loop on a real blocker.                                                                                                                                                           | **Surface to the human; halt that feature's branch of the DAG; keep independent branches moving.**                                                                                                                                |
| **Mid-flight redirects**                                                               | Any worktree-existing phase                                                                     | _User-initiated_ (the user types a redirect). An orchestrator wouldn't redirect unless its own judgment said the feature drifted.                                                                                                                                                               | An orchestrator _could_ inject a redirect via the same path, but that's the fragile screen-scraping interaction Architecture Decision D rejects.                                                                                                   | **Don't.** If a feature is going wrong, escalate it as a unit; don't puppeteer a running session.                                                                                                                                 |

**Synthesis / recommended autonomy posture:** _Human-on-the-loop with a human-in-the-loop gate at the two load-bearing points (epic-design approval; any per-feature `gated`/`needs-human`)._ The orchestrator does **all** the mechanical back-and-forth (decompose, schedule, launch, watch, advance, status, retry-on-transient) and authors features to be born auto-mergeable so the _clean_ path needs zero human touches — but it **never** overrides a `gated` verdict and **never** self-records a gate override. This is exactly the industry default the research found: every major autonomous coding agent (GitHub Copilot coding agent — confirmed it _cannot self-approve_ and always opens a PR; Devin; Anthropic's own framework) opens PRs for human review rather than merging directly, and gates the high-blast-radius, hard-to-reverse action (merge to `main`). flow's gate-is-terminal design is _already_ correct; the epic layer must inherit it, not weaken it.

Full autonomy ("orchestrator merges everything unattended") is an **anti-pattern** for anything but a pre-classified low-blast-radius class, and even then only via the born-mergeable route. The defensible "fully autonomous overnight" experience is: an epic of features that were _designed_ to be auto-mergeable runs to MERGED with no human touches because each feature's gate cleared on merit — not because anything overrode a gate.

### D. Orchestrator ↔ running feature: READ state files; do NOT `tmux send-keys`. Recommend model (ii), evolving toward (iii).

Architectural reality the user should internalize: **feature pipelines are separate, durable, tmux-hosted Claude Code sessions — not Task/Agent sub-agents of the orchestrator.** flow's whole design is in-process skills + Bash helpers, with the _only_ fan-out being the eight named Task exemptions, all one-shot. An epic orchestrator is a _peer_ launching sibling sessions, not a parent owning child agents. (Note: AGENTS.md's "subagents can't spawn subagents" line is now stale per prior research — nesting is allowed as of Claude Code v2.1.172 — but flow's in-process-only design is a deliberate context/cost choice, ~15x tokens for multi-agent per Anthropic, not a platform limit. The epic orchestrator should respect that: launch siblings, don't nest.)

Three interaction models for the binary the user posed ("can/should the orchestrator interact with the running feature?"):

- **(i) `tmux send-keys` into feature windows** to answer prompts. **Reject.** Screen-scraping a non-deterministic TUI: racey (the supervisor's `$TMUX_PANE`-anchoring exists precisely because untargeted tmux queries race across parallel pipelines), fragile (output-format changes break it), and the user is newer to tmux. The worst option.
- **(ii) Orchestrator only READS state files + PR state; human handles per-feature gates.** **Recommend for v1.** Every signal the orchestrator needs is already a _file_: feature phase (`~/.flow/state/<slug>.json`), PR state (`gh pr view`), terminal state (the four terminal phases). This is exactly how `flow ls` and `flow-resume-decide` already work — read state, decide, never scrape. Robust, deterministic, reuses the entire existing state model.
- **(iii) Features made autonomous / born-mergeable so little interaction is needed.** **The end-state**, layered on top of (ii). The clean path needs _zero_ orchestrator→feature interaction because each feature self-completes through its own auto-merge gate.

**Middle ground (recommended path): (ii) as the substrate, (iii) as the goal.** The orchestrator never writes _into_ a running feature; it reads state out and launches new features. Interaction is one-directional (launch + observe), sidestepping every race the existing supervisor had to engineer around. If a feature needs a per-feature gate touched, that surfaces to the human (Decision C), it is not puppeteered.

### E. Artifacts in the PR: build on what flow already has; the PR is the right container for per-feature artifacts; the epic manifest is the right container for cross-feature artifacts.

The user is right that artifacts matter more in an epic world (reviewing many PRs, possibly after the fact). But flow already has most of the machinery — the gap is smaller than "capture screenshots, thinking trail, decisions" implies:

- **Decisions made / avoided / rejected alternatives:** _already captured._ `flow-pipeline-summary` renders a `## PIPELINE SNAPSHOT` (CHANGES / PHASES / FINDINGS / **FORECLOSED PATHS** = rejected alternatives + anti-patterns / FOLLOW-UP ISSUES / MANUAL STEPS), sourced from structured artifacts (fix-applier, consolidator, `phaseLog`), and on the MERGED path posts a _slimmed_ snapshot as a top-level PR comment. Subagent contracts already carry `rejected_alternatives` and `anti_patterns_found` (confirmed in fix-applier/consolidator/coder schemas). **Recommend: reuse this verbatim per feature; no new "thinking trail" machinery.**
- **Intent / why a hunk exists:** _already captured._ `/new-feature` step 5b posts inline `**why:**` intent annotations on the diff; durable rationale lives in commit-body Why-sections and the PR `## Why`. **Reuse.**
- **Test evidence:** _already captured._ `/pr-review` injects `<details>` evidence blocks (captured stdout) into `## Test Steps`. **Reuse.**
- **Screenshots:** the genuine gap. flow has no screenshot capture today. **Honest verdict: gold-plating for v1 unless the epic is UI-heavy.** Defer. If wanted later, it belongs in the feature pipeline (the thing that runs the app), surfaced via the existing PR-comment path — not in the epic layer.
- **Cross-feature / epic-level artifacts** (the system design, flow diagrams, the DAG, design rationale): these do **not** belong in any single feature's PR — no single PR owns them. **Recommend: the epic manifest file is their container** (`design.md`/diagrams committed alongside the manifest, or referenced from it), and each feature PR back-links to the epic. This is the one genuinely-new artifact surface.

Net: per-feature artifact capture is ~90% done; reuse `flow-pipeline-summary` + intent annotations + evidence blocks. The new work is the epic-level design artifact (manifest + diagrams + back-links), not reinventing per-PR capture.

### F. Command naming + ID flow.

- `flow epic "<prompt>"` — single entry. Internally: design phase mints an **epic ID** (a slug derived from the prompt, same `slugify` as `flow new`, stored at `~/.flow/epics/<epic-id>.json`), runs the checkpoint, then runs the orchestrator against that ID.
- `flow epic design "<prompt>"` — design only. **Prints the epic ID** as its machine-readable first line (mirroring `flow new` printing `flow:<slug>`). This answers the user's "where does the ID come from" — `design` creates it; `run`/`status` consume it.
- `flow epic run <id>` — execute an existing manifest by ID. The ID is required (no prompt; the prompt was consumed by `design`).
- `flow epic status <id>` / `flow epic ls` — read epic state.

`design` takes **only a prompt** (the user's instinct is right — no references to `flow new`/feature). It is the epic analogue of `flow new`'s description. The epic ID is the join key across `design`/`run`/`status`, exactly as the feature slug is the join key across `new`/`attach`/`done`. New verb plumbing is mechanical: add `"epic"` to `VERBS` in `bin/lib/verbs.ts`, a `runEpicCli` shim in `bin/lib/epic.ts`, a case in `bin/flow`'s `runVerb`, and completion entries (the completion test enforces parity).

### G. Single entry vs two-step — recommend single entry WITH a checkpoint (the middle ground). (Covered in Decision A's binary table.) `flow epic "<prompt>"` delegates design→run but pauses at the design checkpoint; `epic design` + `epic run` stay available for manual control.

### H. Tracker: v1 = no new tracker (epic manifest is a versioned JSON file + the existing `~/.flow/state` model); evolution path = GitHub Issues sub-issues behind an adapter seam; beads deferred. (CHALLENGE: don't adopt beads now.)

Decision, using the prior (settled) research:

- **v1: a flat epic manifest file** (`~/.flow/epics/<epic-id>.json`: features, `dependsOn` edges, per-feature launched-slug + status) plus the existing per-feature `~/.flow/state/<slug>.json` as the source of truth for each feature's live phase. The smallest thing that works and matches AGENTS.md's explicit storage doctrine: "Markdown plan files plus `~/.flow/state/<slug>.json` are the state store … if the queue ever outgrows that, swap in Beads **via an adapter**." A flat JSON manifest with typed edges is enough for Kahn's-algorithm ready-set math; flow already proves the flat-state-file model scales to parallel pipelines.
- **Why NOT beads in v1:** the research surfaced that beads v1.0 (2026) flipped storage from git-committed JSONL to embedded Dolt synced over `refs/dolt/data`. That **breaks** flow's "JSONL-in-git / no-DB / git-auditable" doctrine head-on (AGENTS.md "Don't introduce a database"). Adopting beads now imports a DB dependency, version churn, and some ready-solver bugs to save _math flow can do in ~10 lines_ (Kahn's algorithm + a semaphore, both already understood — `flow-pre-commit` already runs a host-wide counting semaphore). The transitive-ready-frontier and typed-edges features are real, but flow doesn't need them at epic-of-5-features scale.
- **Why NOT GH Issues as the _store_ in v1:** native sub-issues + dependencies are GA, but there's _no transitive ready solver_ (only `is:blocked`), it's cloud-bound (every ready-set computation is a network round-trip + rate-limit risk), and the 50-edge cap is a (distant) ceiling. A fine _projection_ surface, not the computation substrate.
- **Adapter seam (the middle ground for the binary "beads or GH"):** define a tiny `EpicStore` interface (`listFeatures`, `markComplete`, `readySet`, `status`) with the v1 implementation backed by the flat manifest. **The evolution path is GitHub Issues** (project the manifest to sub-issues so the epic is visible in GitHub, computing the ready set locally from the manifest, not from `is:blocked`), with beads remaining a _possible_ third adapter only if/when the Dolt-vs-git-audit tension is resolved or the scale genuinely demands a transitive solver. The seam means none of this is a one-way door.

### I. Supervisor vs script — recommend a HYBRID, and the user's "scripts break on human feedback" concern is valid; refine the prior "LLM-free reconciler" recommendation. (CHALLENGE accepted.)

The user's pushback is correct: a purely deterministic orchestrator breaks the moment a feature does something a script can't interpret (a `needs-human` with a novel reason; a CI failure that needs a judgment call about retry vs escalate). But the opposite extreme — a long-lived LLM supervisor for the _whole_ orchestration — bloats context and cost over a multi-hour epic (the exact reason flow's per-feature pipeline is one session per feature, not one session for everything). The answer is a clean split of labor:

**Deterministic helpers (a script suffices — no LLM):**

- `flow-epic-dag` — topological ready-set (Kahn's algorithm), cycle detection, frontier recomputation. Pure function, fully unit-testable.
- The concurrency semaphore — cap K concurrent feature pipelines (reuse the `~/.flow/test-sem`-style counting-semaphore pattern that already exists in `flow-pre-commit`).
- The launcher — invoke `flow new` per ready feature; record the slug.
- The watcher/reader — read `~/.flow/state/<slug>.json` for each launched feature; classify terminal vs running.
- Status rendering — join manifest + state files into a table (build on `flow ls`/`flow-pipeline-summary`).

**LLM orchestrator (judgment genuinely needed):**

- Interpreting a feature _failure_ (a `needs-human: <novel reason>`): retry, redirect via a fresh `flow new` with an amended prompt, or escalate the epic.
- Deciding whether a `gated` feature blocks dependents or can be worked around.
- Summarizing epic progress for the human in prose.
- Answering the _epic-design checkpoint_ (the one human gate it interacts with) — and authoring features to be born auto-mergeable (Story 6).
- Phase 1 design itself (this is `/product-planning` at epic altitude — already an LLM task).

**Refinement of the prior "LLM-free reconciler" recommendation:** the _reconciler_ (compute ready set, launch, watch) stays LLM-free — that part holds. What the user correctly identified is that _the layer above the reconciler_ (deciding what to do when a feature doesn't cleanly complete) needs an LLM. So: **LLM-free reconciler core, wrapped by a thin LLM orchestrator that is invoked only on events the reconciler flags as needs-judgment** (a feature terminal-failed; or the ready set is empty but the epic isn't done = a deadlock to diagnose). The LLM is _event-driven and short-lived per invocation_, not an hours-long resident — which also answers Decision J.

### J. Daemon — recommend launchd stateless tick (option ii) waking a short-lived process, NOT a long-lived LLM session. (Binary the user posed: daemon vs no-daemon → middle ground.)

The user lifted the no-daemon constraint for this layer. Three options weighed:

- **(i) Long-lived LLM orchestrator session** (one Claude session resident for the whole epic). **Reject as the default.** Over a multi-hour epic it accumulates context (every feature's status poll, every state read) → cost and context-window bloat, the precise failure flow's one-session-per-feature design avoids. Also not crash-resilient: if that session dies, the epic's coordination dies with it (unless all state is on disk anyway — in which case why keep it resident?).
- **(ii) launchd `StartCalendarInterval` stateless tick** that wakes a short-lived process which reads epic state, computes the ready set, launches newly-ready features, and exits. **Recommend.** Sleep-resilient (runs the missed tick on wake — research confirmed launchd over cron, which is deprecated on macOS with silent TCC failures), stateless (all state on disk, matching flow's crash-resume philosophy: "each flow invocation does one thing and exits"), and the tick can be _mostly the deterministic reconciler_, invoking the LLM orchestrator only on a needs-judgment event. The cheapest model that delivers unattended overnight progress.
- **(iii) An actual background daemon** (resident process, not LLM). **Reject** — AGENTS.md "not a long-running daemon"; a stateless tick gives the same unattended-progress benefit without a resident process to supervise, and is the smaller change.

**Middle ground (recommended):** a launchd tick is "not a daemon" in flow's sense (stateless, invoked-fresh, exits) yet delivers the daemon-like benefit (unattended frontier advancement). v1 can even skip launchd entirely and advance the frontier _opportunistically_ (recompute + launch whenever the user runs `flow epic status`, or when a feature completes if a completion hook is wired) — the launchd tick is the v2 "truly unattended" upgrade. Don't build a daemon; build a tick, and make even the tick optional.

## Technical Constraints

- **Reuse, don't reimplement.** The epic layer calls `/product-planning` (design), `flow new` → `/flow-pipeline` (execution), `flow ls`/state files (observation), `flow-pipeline-summary` (artifacts). It adds a manifest schema, a DAG helper, a launcher, a watcher, an epic-status renderer, and a thin LLM orchestrator. It reimplements _none_ of the pipeline.
- **Bun + symlink distribution.** Every new helper is `#!/usr/bin/env bun`, `import.meta.main`-gated, with a `<name>.test.ts` next door, auto-picked-up by `flow setup`'s `discoverHelpers`.
- **No new database** (AGENTS.md). Flat JSON manifest + existing state model; beads only ever behind an adapter, and not in v1 given the Dolt-vs-git-audit break.
- **Inherit the gate doctrine.** The epic layer must not weaken `flow-gate-decide`/`flow-merge-guard`. A `gated` verdict stays terminal; gate overrides stay fresh-human-only. Autonomy = born-mergeable, never override.
- **Respect in-process / context-cost discipline.** The orchestrator launches _sibling_ tmux sessions (peers); it does not nest Task sub-agents; its own LLM invocations are short-lived and event-driven, not a resident supervisor.
- **macOS scheduling = launchd, not cron** (research-confirmed).
- **One-directional interaction.** Orchestrator → feature is launch + read-state only; never `tmux send-keys` into a running session.

## Open Questions

- **Designer-as-enriched-`/product-planning` vs separate component (Decision A).** I assumed the designer should be `/product-planning` at epic altitude emitting a manifest, _not_ a from-scratch second pipeline — because that reuses discovery's machinery and matches flow's "don't reimplement skills" doctrine. If you specifically want the designer to do things `/product-planning` structurally can't (e.g. interactive multi-round requirements elicitation with the user, long-running system-design exploration), that tilts back toward a separate component. **Confirm: enrich `/product-planning`, or build a distinct designer?**
- **Autonomy ceiling (Decision C).** I assumed "born auto-mergeable, never override a gate" is the right ceiling, and that an orchestrator-overrides-gated path should **not** be built. If you actually want unattended merge of _consequential_ features (not just born-mergeable ones), that contradicts flow's gate-is-terminal doctrine and the industry default — I'd push back hard, but it's your call. **Confirm: born-mergeable-only, or do you want an autonomous-override path (not recommended)?**
- **How does the designer decide which features are "low-blast-radius" / born-mergeable?** I assumed the design phase classifies each feature (the same automatable-vs-manual judgment `/product-planning` already applies to Test Steps), and only auto-mergeable-classified features get zero unchecked Test Steps. The classifier's accuracy is load-bearing for safe autonomy. **Confirm the classification approach, or treat all features as gated in v1 (safest).**
- **Tracker evolution target (Decision H).** I assumed flat-manifest v1 → GH-Issues-projection v2, beads deferred behind the adapter due to the Dolt break. If git-auditability of the epic graph is not actually important to you, beads becomes more attractive sooner. **Confirm the v1 store and whether GH-Issues projection is the v2 target.**
- **Daemon appetite (Decision J).** I assumed launchd-tick (or even opportunistic advancement) over a resident process. If you genuinely want a feature to launch _the instant_ its dependency merges (sub-minute latency) rather than on the next tick/status-check, that argues for a completion hook wired into the feature pipeline's MERGED path. **Confirm: tick/opportunistic is fine, or do you need instant launch-on-merge?**
- **`flow new` rename.** I assumed _no_ rename (add a `feature` alias at most), since `flow new` is the documented surface. **Confirm you're OK keeping `flow new`.**
- **Epic-level approval granularity.** I assumed the human approves the whole epic decomposition once (at the design checkpoint), and per-feature plans auto-approve under that umbrella. If you want to approve each feature's _detailed_ plan individually as it's about to launch, that's more control but reintroduces N checkpoints. **Confirm one epic-level approval vs per-feature approvals.**

## Recommendation

**Reconsider scope.** Build the epic layer, but as **one entry point with two phases (design → checkpoint → run) that reuses `/product-planning` and `/flow-pipeline` wholesale**, not as two heavyweight components — and ship **Phase 1 (design → manifest + DAG) first** as the MVP, since it captures the biggest single chunk of value (decomposition quality) at the smallest cost. The named scope change: the "designer" collapses into an enriched `/product-planning`, and the "orchestrator" collapses into a thin LLM-judgment layer over a deterministic launch/watch reconciler. See the Open Question on designer-as-enriched-`/product-planning` for the one assumption most likely to change this verdict.

## Plan risks

**The single weakest assumption: that features can be reliably authored "born auto-mergeable" (zero unchecked Test Steps that still genuinely verify the feature) often enough for autonomy to add value beyond the design phase.** If most real features legitimately need a manual/subjective Test Steps item (UI features almost always do — "the chart renders correctly" is genuinely human-judgment), every feature ends up `gated`, the human adjudicates each one anyway, and Phase 4's autonomy adds little over Phase 2's launch-on-ready. In that world the value collapses to "good decomposition + unattended _launch_, but you still merge each feature by hand" — still worth Phases 1-2, but Phase 4 is speculative. This is why the task breakdown front-loads design + launch and treats born-mergeable autonomy as the _last, most-deferable_ phase, and why the recommended safe default is "treat all features as gated unless the designer can prove low-blast-radius."

## Prompt interpretation

The user's prompt named BOTH prescribed methods (a specific two-component split: "epic designer" + "epic orchestrator", each with enumerated responsibilities) AND a quantitative-ish target embedded in the aspiration ("hopefully merges … fully autonomous"). The prescribed decomposition and the full-autonomy aspiration are in tension with flow's deliberately-non-overridable gates, so this section is warranted.

- **Reading of prescribed methods:** starting points. The user explicitly framed this as exploratory ("assume I might be wrong," "needs a better name," "might take some testing," "weigh pros and cons," "do some research") and invited challenge. The two-component split is evidence of how the user is currently thinking, not a fixed spec.
- **Plausibility estimate:** the two-component split is _over-built_ relative to the goal — evidence: `/product-planning` already does ~80% of the "designer," and `/flow-pipeline` already does 100% of the per-feature execution the "orchestrator" would otherwise reimplement (read from `skills/pipeline/product-planning/references/discovery-instructions.md` and `skills/pipeline/flow-pipeline/SKILL.md`). The full-autonomy aspiration is _unreachable as stated_ without weakening `flow-merge-guard`'s deliberate gate (read from `bin/flow-merge-guard.ts`: the merge path is mechanically unreachable on unchecked items absent a fresh _human_ override) — and weakening it is an anti-pattern the codebase has an entire incident-driven contract against (`auto-merge-rubric.md` "a gated verdict is terminal, not advisory").
- **Recommended path:** relax target. The prescribed _methods_ (an epic layer above the pipeline) are correct and should be built; the _target_ of full unattended autonomy must be relaxed to "orchestrator does all the back-and-forth + features born auto-mergeable, human approves the epic decomposition and any gated/needs-human feature." What I'd "cut" from the literal prompt: (a) the second heavyweight component (fold the designer into `/product-planning`, the orchestrator into a thin scheduler), and (b) the full-autonomy ceiling (cap at born-mergeable; never override a gate). The user can accept the relaxed target or redirect — see the Open Questions on designer decomposition and autonomy ceiling.

# Candidate follow-up issues

- [ ] `flow new` → `flow feature`/`feat` alias — add `feature` as an alias of `new` (do NOT rename) if epic-vs-feature symmetry is wanted; separate, shippable on its own.
- [ ] Stale AGENTS.md line "subagents can't spawn subagents (one-level cap)" — now factually wrong per Claude Code v2.1.172; reframe as a deliberate context/cost choice in AGENTS.md + flow-pipeline SKILL.md "Hard rules". Separate doc-correctness fix.
- [ ] Screenshot capture in the feature pipeline — surface app screenshots into the PR (via the existing PR-comment path) for UI-heavy features; standalone feature, valuable independent of epics.
- [ ] GitHub Issues projection of an epic manifest — a read-only `flow epic` → sub-issues sync so an epic is visible on GitHub; the v2 tracker-adapter milestone, shippable as its own feature once the v1 manifest exists.

# Task breakdown

This breakdown is itself a DAG, organized into four phases. Each phase is independently valuable and shippable; later phases depend on earlier ones. **Phase 1 is the v1-MVP** (captures decomposition value with minimal orchestration). Phases 2-4 are progressively more deferable; Phase 4 (born-mergeable autonomy) is the most speculative per Plan risks.

Phase dependency graph:

```
Phase 1 (design → manifest + DAG)
   │
   ├──> Phase 2 (launch-on-ready + watch + status)
   │        │
   │        ├──> Phase 3 (unattended tick / opportunistic advance)
   │        └──> Phase 4 (born-mergeable autonomy)   [most deferable]
   │
   └──> (GH-Issues projection — candidate follow-up, not a core task)
```

Task-level DAG (within/across phases): T1→T2→T3→T4 (Phase 1); T4→T5→T6→T7 (Phase 2); {T5,T6,T7}→T8→T9 (Phase 3); T3→T10→T11 (Phase 4).

### Task 1: Epic manifest schema + validator

- **Skill:** `testing` (helper authoring; closest existing pattern is `bin/lib/*-schema.ts`)
- **Description:** Define the epic manifest shape (`~/.flow/epics/<epic-id>.json`: `{ epicId, prompt, features: [{ id, title, description, dependsOn: string[], status, launchedSlug? }], createdAt }`) and a validator helper. Mirror `agent-finding-schema.ts` / `coder-schema.ts`.
- **Inputs:** none (greenfield).
- **Outputs:** `bin/lib/epic-manifest-schema.ts` (+ symlinked validator if pipeline skills consume it by bare name), `<name>.test.ts`.
- **Acceptance criteria:** validator exits 0 on a well-formed manifest, non-zero on a malformed one; `npm run test -- bin/lib/epic-manifest-schema.test.ts` passes.
- **Effort:** small. **Phase:** 1 (MVP). **Depends on:** none.

### Task 2: DAG ready-set + cycle-detection helper

- **Skill:** `testing` (helper authoring)
- **Description:** `bin/flow-epic-dag.ts` — pure functions for Kahn's-algorithm ready-set (features whose `dependsOn` are all `status: complete` and which aren't complete), cycle detection (`--validate` exits non-zero on a cycle), and frontier recomputation. LLM-free.
- **Inputs:** Task 1 (manifest shape).
- **Outputs:** `bin/flow-epic-dag.ts`, `bin/flow-epic-dag.test.ts`.
- **Acceptance criteria:** unit tests cover empty graph, linear chain, diamond, disconnected components, and cycle; `bun bin/flow-epic-dag.test.ts` passes.
- **Effort:** small-medium. **Phase:** 1 (MVP). **Depends on:** T1.

### Task 3: Epic design phase (enriched `/product-planning` at epic altitude)

- **Skill:** `product-planning` (reused/extended)
- **Description:** Drive `/product-planning` to emit an _epic manifest_ (features + DAG) and design artifacts (`design.md`, optional diagrams) instead of a single-feature task list. A discovery-instructions extension + a manifest-emit step, not a new skill. Surface the manifest for approval at an `epic-design-pending-review` checkpoint (mirror `plan-pending-review`).
- **Inputs:** Tasks 1, 2.
- **Outputs:** extended `/product-planning` discovery instructions; an epic-design checkpoint contract.
- **Acceptance criteria:** running the design phase on a sample epic prompt produces a schema-valid manifest (T1 validator exits 0) whose DAG is acyclic (T2 `--validate` exits 0).
- **Effort:** medium. **Phase:** 1 (MVP). **Depends on:** T1, T2.

### Task 4: `flow epic design` verb + epic state

- **Skill:** `testing` (CLI wiring)
- **Description:** Add `"epic"` to `bin/lib/verbs.ts`; `bin/lib/epic.ts` with `runEpicCli` dispatching `design`/`run`/`status`/`ls`; a case in `bin/flow`'s `runVerb`; `~/.flow/epics/<epic-id>.json` read/write (mirror `bin/lib/state.ts`); completion entries (the completion test enforces parity). `design` takes only a prompt, mints + prints the epic ID.
- **Inputs:** Tasks 1, 3.
- **Outputs:** `bin/lib/epic.ts`, `bin/lib/epic-state.ts`, edits to `bin/flow` + `bin/lib/verbs.ts` + completion files, tests.
- **Acceptance criteria:** `flow epic design "<prompt>"` writes a manifest, prints the epic ID as its first line; `flow epic --help` works; completion parity test passes; `flow epic design --help` short-circuits before side effects (mirror the `flow new --help` regression guard).
- **Effort:** medium. **Phase:** 1 (MVP). **Depends on:** T1, T3.

### Task 5: Concurrency-capped launcher

- **Skill:** `testing` (helper authoring)
- **Description:** Given a manifest + ready set, invoke `flow new` once per ready feature up to cap K (counting semaphore, reuse the `~/.flow/test-sem` pattern from `flow-pre-commit`); record each launched feature's slug back into the manifest.
- **Inputs:** Tasks 2, 4.
- **Outputs:** launcher logic in `bin/flow-epic-*.ts`, tests with a stubbed `flow new`.
- **Acceptance criteria:** launches exactly min(|ready set|, K) features; records slugs; idempotent (re-run doesn't double-launch an already-launched feature); unit tests pass.
- **Effort:** medium. **Phase:** 2. **Depends on:** T2, T4.

### Task 6: State-file watcher / completion detector

- **Skill:** `testing` (helper authoring)
- **Description:** Read each launched feature's `~/.flow/state/<slug>.json`; classify `merged` (→ mark feature complete, advance frontier), `gated`/`needs-human` (→ surface, don't advance dependents), running (→ no-op). Reuse the read-state pattern from `bin/lib/ls.ts` / `flow-resume-decide.ts`. **No tmux scraping.**
- **Inputs:** Task 5.
- **Outputs:** watcher logic + tests with stubbed state files.
- **Acceptance criteria:** correctly classifies all terminal phases; a `gated` feature does not block independent branches; unit tests cover merged/gated/needs-human/running.
- **Effort:** medium. **Phase:** 2. **Depends on:** T5.

### Task 7: `flow epic status` + `flow epic ls`

- **Skill:** `testing` (CLI wiring)
- **Description:** Join manifest + per-feature state files into a table grouped done/running/ready/blocked, with PR links. Build on `flow ls` rendering and `flow-pipeline-summary` for per-feature detail.
- **Inputs:** Tasks 4, 6.
- **Outputs:** `status`/`ls` subcommands in `bin/lib/epic.ts`, tests.
- **Acceptance criteria:** `flow epic status <id>` renders the grouped table; `flow epic ls` lists epics; tests pass against a fixture epic.
- **Effort:** small-medium. **Phase:** 2. **Depends on:** T4, T6.

### Task 8: `flow epic run` orchestration loop (LLM-judgment over the reconciler)

- **Skill:** new `/epic-orchestrator` supervisor skill (or extend `/flow-pipeline` patterns)
- **Description:** The event-driven loop: recompute ready set (T2) → launch (T5) → watch (T6) → on a needs-judgment event (feature terminal-failed; ready set empty but epic incomplete = deadlock), invoke LLM judgment (retry / amended-prompt relaunch / escalate); on the clean path stay deterministic. Single entry `flow epic "<prompt>"` chains T3's design → checkpoint → this loop.
- **Inputs:** Tasks 5, 6, 7.
- **Outputs:** orchestrator skill + `run` wiring + tests for the deterministic core.
- **Acceptance criteria:** on an all-clean fixture epic the loop advances the full DAG to all-merged with zero LLM-judgment events; a deliberately-failing feature triggers the escalation path; deterministic-core unit tests pass.
- **Effort:** large. **Phase:** 3. **Depends on:** T5, T6, T7.

### Task 9: launchd stateless tick (optional unattended mode)

- **Skill:** `testing` (helper + launchd plist)
- **Description:** A launchd `StartCalendarInterval` plist that wakes a short-lived process to run one reconciler pass (recompute + launch newly-ready) and exit. Sleep-resilient; opt-in (mirror `FLOW_NOTIFY`-style opt-in). v1 alternative: opportunistic advancement on `flow epic status`.
- **Inputs:** Task 8.
- **Outputs:** plist template, install logic in `flow setup`, tests.
- **Acceptance criteria:** the tick runs one reconciler pass and exits non-resident; opt-out leaves launchd untouched; a missed tick (sleep) runs on wake.
- **Effort:** medium. **Phase:** 3 (optional). **Depends on:** T8.

### Task 10: Feature blast-radius classification in the design phase

- **Skill:** `product-planning` (extended)
- **Description:** During design, classify each feature low- vs high-blast-radius (reuse the automatable-vs-manual Test Steps judgment). Only low-blast-radius features are eligible to be authored born-mergeable. Default to high (gated) when uncertain — the safe default per Plan risks.
- **Inputs:** Task 3.
- **Outputs:** classification field in the manifest + design-instruction extension.
- **Acceptance criteria:** classification recorded per feature in the manifest; an ambiguous feature classifies high (gated); test on fixtures.
- **Effort:** small-medium. **Phase:** 4 (most deferable). **Depends on:** T3.

### Task 11: Born-mergeable feature authoring (zero unchecked Test Steps on merit)

- **Skill:** `new-feature` / `flow-pipeline` (path-through, NOT a gate change)
- **Description:** For low-blast-radius features, ensure the feature pipeline authors every Test Steps item as automatable + run + ticked, so `flow-gate-decide` returns `auto-merge` on its own merit. **Explicitly does NOT touch `flow-gate-decide`/`flow-merge-guard`** — no override path, no gate weakening. The autonomy is entirely upstream (better-authored PRs), not at the gate.
- **Inputs:** Task 10.
- **Outputs:** authoring-discipline extension; an end-to-end test that a born-mergeable fixture feature reaches `auto-merge` with zero overrides recorded.
- **Acceptance criteria:** a born-mergeable fixture feature's PR clears `flow-gate-decide` as `auto-merge`; `flow-merge-guard` records _no_ override token; the gate code is unchanged (diff touches no gate file).
- **Effort:** large + speculative. **Phase:** 4 (most deferable). **Depends on:** T10.

## Skills Summary

| Skill                          | Recommended?                                | Reason                                                                                                                                                              |
| ------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| product-planning               | Yes (Tasks 3, 10)                           | The "designer" is this skill at epic altitude — emit a manifest + DAG + blast-radius classification instead of a single-feature task list. Core reuse.              |
| flow-pipeline                  | Yes (Task 11; indirectly all of Phases 2-3) | The per-feature executor the orchestrator launches via `flow new`. Reused wholesale; never reimplemented. Phase 4 leans on its authoring discipline (NOT its gate). |
| new-feature                    | Yes (Task 11)                               | Authors born-mergeable features (automatable Test Steps) — upstream of the gate, not a gate change.                                                                 |
| testing                        | Yes (every helper task: 1, 2, 4-9)          | Each new Bun helper needs a `<name>.test.ts`. Standard flow discipline.                                                                                             |
| coder                          | No                                          | Edit-applier for in-pipeline edits; the epic layer doesn't apply code edits directly, it launches pipelines that do.                                                |
| verify                         | No (indirect)                               | Runs inside each feature pipeline already; the epic layer doesn't invoke it directly.                                                                               |
| pr-review                      | No (indirect)                               | Runs inside each feature pipeline; its artifacts (`flow-pipeline-summary`) are _reused_ for epic status, but the epic layer doesn't invoke pr-review itself.        |
| refactoring                    | No                                          | Not relevant to epic orchestration.                                                                                                                                 |
| add-worktree / remove-worktree | No                                          | Worktrees are created by `flow new` → `flow-new-worktree` inside each feature pipeline; the epic layer doesn't manage worktrees directly.                           |

# PR description draft

See `.flow-tmp/pr-description-draft.md`. This is an architecture review; the PR-description draft describes the _eventual Phase 1 MVP_ PR, since that is the first shippable unit — the review itself produces no code.
