# Artifact storage recommendation

> **Status:** recommendation for the developer to approve. **Scope:** where the epic _designer's_ artifacts live. Does **not** create any GitHub issues or change any storage today — it recommends a default and a sequenced evolution path, and flags the one decision that needs your sign-off. Companion to `02-design-spec.md` (the artifact _set_) and `03-build-plan.md` (how it gets built). Refines `00-prior-architecture-review.md` Decision H — see "What this refines" at the end.

## TL;DR (the default)

**The designer's output is a small set of git-committed markdown files plus one schema-validated machine-readable manifest, written into the target repo under `.flow/epics/<epic-slug>/`, and landed through a normal flow PR that you review at the design checkpoint.** No database, no GitHub Issues as the store, no `beads`, nothing under per-machine `~/.flow/` for the _design_ output. This is the smallest thing that satisfies every constraint flow already holds itself to, and it makes the design reviewable as a diff — which is the whole point of a design checkpoint.

GitHub Issues are a good _projection_ surface (a later, opt-in, one-way export so an epic is visible on github.com), never the source of truth. `beads` stays deferred behind an adapter seam. Both are ranked and justified below.

## The decision has two horizons — keep them separate

The single most important framing, and the place the prior review (`00-prior-architecture-review.md` Decision H) is worth refining:

| Horizon                        | What it is                                                                                                                              | In scope here?                             | Right home                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| **Design output**              | The clarified requirements, the high-level design, the feature DAG manifest — the thing a human reviews and the eventual build _reads_. | **Yes** — this is the designer.            | **Git-committed, in the target repo.** Reviewable, durable, auditable.    |
| **Runtime coordination state** | Which features have been launched, each one's live phase, the orchestrator's scheduling bookkeeping.                                    | **No** — that's the deferred orchestrator. | Per-machine `~/.flow/`, exactly like today's `~/.flow/state/<slug>.json`. |

flow already embodies this split and it is load-bearing: `bin/lib/state.ts` keeps `~/.flow/state/<slug>.json` as **per-machine runtime state that is never committed to git**, while the _durable, auditable_ record of a feature is its committed PR body + commit messages. The prior review proposed putting the epic manifest at `~/.flow/epics/<epic-id>.json` — that is the correct home for _runtime status_, but it is the wrong home for the _design artifact_. A design that the human must approve and the build must consume belongs in version control, reviewed as a diff, not hidden in per-machine state that never leaves the laptop and never appears in a PR.

**The clean seam this creates (and the only thing the designer must get right for a future orchestrator):** the committed manifest is the _contract_; a future orchestrator maintains its own `~/.flow/epics/<id>.json` _live-status_ file that points back at the committed manifest by path + commit SHA. Design = committed + auditable; runtime = ephemeral + per-machine. Never conflate them, and the orchestrator stays a clean, deferrable layer on top.

## Options, weighed

Five candidate homes for the **design output** (horizon 1). Each judged against flow's standing doctrine: _no database; markdown + per-pipeline JSON; git-auditable; not a long-running daemon; reuse before reinventing_ (`AGENTS.md`).

### Option A — Git-committed markdown + a committed JSON manifest (RECOMMENDED)

The designer runs in a worktree of the target repo (exactly like `flow new`), writes its artifacts under `.flow/epics/<epic-slug>/`, and opens a PR. The human reviews the design _as a diff_ at the checkpoint; on approval it merges and becomes the durable, auditable input the eventual build reads.

- **Pros:** Git-auditable by construction (the doctrine, satisfied for free). Reviewable as a diff — a design checkpoint is a code review, which is flow's native idiom. Survives worktree cleanup (unlike `.flow-tmp/`). Zero new infrastructure: a JSON manifest validated by a `bin/lib/*-schema.ts` helper is the _exact_ pattern flow already uses four times (`agent-finding-schema.ts`, `coder-schema.ts`, `fix-applier-schema.ts`, `pr-review-result-schema.ts`). Offline, no network, no rate limits. The recursion proves it: _this very task_ is producing its design as committed markdown in a PR.
- **Cons:** Adds flow-namespaced files to the target repo (mitigated by the `.flow/` prefix and by the fact that you are the sole user — your own design history in your own repo is a feature, not pollution). A raw JSON DAG is poor review UX (mitigated: pair it with a human-facing `design.md` that renders the DAG as a Mermaid graph GitHub draws inline; the JSON is the machine contract, the markdown is the review surface — exact set deferred to `02-design-spec.md`).
- **Doctrine fit:** perfect. This _is_ the doctrine.

### Option B — GitHub Issues + native sub-issues / dependencies as the store

Model the epic as a parent issue, each feature as a sub-issue, dependencies as issue relationships; compute the ready set from `is:blocked`.

- **Pros:** Visible on github.com without a projection step. Native sub-issue + dependency UI is now GA. Familiar.
- **Cons:** **Cloud-bound** — every read/validate is a network round-trip with rate-limit exposure, which breaks flow's offline, "does one thing and exits" model. **No transitive ready-solver** — GitHub exposes only `is:blocked`, not "all dependencies transitively complete," so you'd compute the frontier locally anyway, meaning the local manifest has to exist regardless. **Not git-auditable** — issue edits live in GitHub's database, not your git history; the audit trail is API-shaped, not `git log`-shaped. Mutating a planning graph via the API also can't be reviewed as a diff. Crosses the "no database" line (it's just _someone else's_ database).
- **Doctrine fit:** poor as a _store_; good as a _projection_ (below).

### Option C — `beads` (dependency-aware issue tracker) behind an adapter

The dedicated tool for exactly this shape (typed dependency edges, transitive ready-set).

- **Pros:** Purpose-built for dependency DAGs and ready-set computation — the richest feature fit on paper.
- **Cons:** `beads` flipped its storage to an embedded database synced over a custom git ref, which **breaks flow's "JSONL-in-git / no-DB / git-auditable" doctrine head-on** (`AGENTS.md`: "Don't introduce a database"). It imports a DB dependency and version churn to save _math flow can already do in ~10 lines_ — Kahn's algorithm for the ready-set frontier plus cycle detection, both pure and unit-testable, both well within flow's existing helper idiom. At epic-of-a-handful-of-features scale, a transitive solver is capability you won't exercise.
- **Doctrine fit:** breaks it today. Keep it _possible_ behind an adapter, adopt it never-unless the scale genuinely demands a transitive solver _and_ the DB-vs-git-audit tension is resolved.

### Option D — `~/.flow/epics/<id>.json` (per-machine runtime JSON) as the store

What the prior review proposed for the manifest.

- **Pros:** Trivial to write (mirrors `state.ts`), machine-readable, no repo files.
- **Cons:** **Not git-auditable, not reviewable as a diff, doesn't survive a machine change, never appears in the design-checkpoint PR.** Correct for _runtime status_ (horizon 2); wrong for the _design artifact_ (horizon 1), which is the thing being approved and consumed.
- **Doctrine fit:** right tool, wrong horizon.

### Option E — The epic PR body alone (no committed files), à la flow's current "durable = PR body"

flow's per-feature durable record today is the PR description + commit messages; planning lives in `.flow-tmp/` scratch and is discarded.

- **Pros:** Zero extra repo files; maximally consistent with the _current_ feature pipeline. Git-auditable via the merge commit.
- **Cons:** The feature DAG needs to be **machine-readable** for the eventual build/orchestrator to consume; parsing a DAG back out of free-form PR-body markdown is the brittle path flow already regrets elsewhere (`flow-gate-decide` has to parse `## Test Steps` out of prose, and a whole `flow-merge-guard` backstop exists because that parse is load-bearing and fragile). A design graph deserves a typed file, not a re-parsed prose section.
- **Doctrine fit:** good for prose, insufficient for the DAG.

## Ranking (for the design output)

1. **Option A — committed markdown + committed JSON manifest.** Satisfies every constraint, reviewable as a diff, zero new infra, and it's the dogfooding-proven path.
2. **Option E — PR-body-only**, as a _fallback_ if you want absolutely zero committed flow-files in the target repo — but you lose the machine-readable DAG, so only viable if the manifest is regenerated rather than stored.
3. **Option B — GitHub Issues**, demoted to a _projection_ surface, not a store (see below).
4. **Option D — `~/.flow/` runtime JSON**, correct only for horizon-2 runtime status, not the design artifact.
5. **Option C — `beads`**, deferred behind an adapter; do not adopt in v1.

## Recommendation

**Adopt Option A.** Concretely:

- The designer writes to **`.flow/epics/<epic-slug>/`** in the target repo: a human-facing markdown design doc (requirements + high-level design + a Mermaid DAG render) and a schema-validated `manifest.json` (the typed feature DAG: `id`, `title`, `description`, `dependsOn[]`, and an optional per-feature `flow new` flag hint set). The exact file split is the artifact-set question, resolved in `02-design-spec.md`; this document fixes only the _medium_ (git-committed, in-repo) and the _validation_ (a `bin/lib/*-schema.ts` helper, mirroring flow's four existing validators).
- Land it through a **normal flow PR**, reviewed at the design checkpoint. Approval = merge.
- Keep **all runtime status out of this** — that's the deferred orchestrator's `~/.flow/epics/` concern, reached only across the clean seam (committed manifest path + SHA).

Rationale in one line: it is the only option that is simultaneously git-auditable, reviewable-as-a-diff, machine-readable, offline, and zero-new-infrastructure — i.e. it is flow's existing doctrine applied unchanged, one altitude up.

## The GitHub Issues question (the part that needs your explicit approval)

You asked specifically about GH Issues/sub-issues. Recommendation: **Issues are an optional, later, one-way _projection_, never the source of truth, and the designer must never create them unilaterally.**

- v1: do **not** touch GitHub Issues. The committed manifest is the store.
- Later (a candidate follow-up, shippable on its own once the manifest exists): a read-only `epic → sub-issues` export so an epic is _visible_ on github.com, with the ready set still computed locally from the manifest. This is a projection, not a round-trip — GitHub never becomes authoritative.
- Guardrail, consistent with flow's existing `flow-create-issue` discipline (auto-issue-creation is restricted to two named, opt-in sites precisely because indiscriminate creation pollutes backlogs and races on `gh` rate limits): **the designer recommends, you approve.** No design-phase code path calls `flow-create-issue`.

## What this refines vs. the prior review (the challenge)

The prior review (`00-prior-architecture-review.md` Decision H) landed the right _exclusions_ — no `beads` in v1 (DB-vs-git-audit break), no GH-Issues-as-store (cloud-bound, no transitive solver), flat-manifest v1 with an adapter seam. I'm keeping all of that. The one refinement: it filed the manifest under **`~/.flow/epics/<id>.json` (per-machine runtime)**. For the _design_ phase that is the wrong horizon — the manifest is a reviewed, approved, build-consumed _design artifact_, so it belongs **git-committed in the target repo**, not in uncommitted per-machine state. Per-machine `~/.flow/epics/` is reserved for the future orchestrator's _live status_, which references the committed manifest. Separating the two horizons is what keeps the orchestrator a clean, deferrable layer and keeps the design itself auditable.

## Open question / flag

- **`.flow/epics/<slug>/` vs `docs/epics/<slug>/` as the in-repo path.** `.flow/` namespaces flow's files and signals "tooling-owned"; `docs/` signals "project documentation a human browses." Recommendation: `.flow/epics/<slug>/` (tooling-owned, parallel to the existing `.flow/pre-commit.json` escape-hatch convention), but this is a low-stakes call you can flip. Flagged rather than silently chosen.
- This recommendation assumes the design output is committed to the **target** repo (the repo the epic builds in), not to flow's own repo. That matches how `flow new` operates per-target-repo. Confirm if you intended otherwise.
