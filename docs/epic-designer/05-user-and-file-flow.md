# User flow & file flow — a worked walkthrough

> **Purpose:** make the design's seams concrete by simulating one epic end-to-end — the actions you take, where every file lives, and when each is deleted. Complements `02-design-spec.md` (the spec) with a narrative. **Scope marker:** the **design phase** is designed in this dossier; the **run phase** (steps 3–7 below, Tier 3, and the orchestrator lifecycle) is the **deferred orchestrator** — sketched here only from the seams the designer leaves (`02` §10) and `00`'s Decision J, not designed. Deferred parts are tagged _(deferred)_.

## The example epic

```
Epic: "add a watchlist feature"
  A  schema + migration     (root, no deps)
  B  backend repository     (deps: A)
  C  list-page UI           (deps: B)
  D  add-form UI            (deps: B)
  E  nav wiring + e2e       (deps: C, D)

DAG:  A → B → { C, D } → E      root → chain → fan-out → join
```

## User flow — the actions you take

**Design phase (designed).** One tmux window, one Claude session, exactly like `flow new`:

1. `flow epic design "add a watchlist: schema, backend, list + add-form UI, nav wiring"`. The designer runs discovery at epic altitude. If it finds a _material_ ambiguity (one that changes the feature set or the DAG shape) it fires **one** `AskUserQuestion` round; otherwise it proceeds. → you answer 0–N questions, once.
2. It writes `design.md` + `manifest.json`, opens a **design PR**, and **pauses at the checkpoint** (phase `epic-design-pending-review`, turn ends — the same mechanic as `plan-pending-review`).
3. You review the PR — the prose design and the Mermaid DAG — and **approve** (merge) or **redirect** ("split B into read/write"; the designer re-runs). On merge the design artifacts land in `main`.

**Run phase _(deferred)_.** `flow epic run <id>` (or, in the eventual single-entry `flow epic "…"`, auto-advance past the checkpoint). Each feature it launches is a standard `flow new` in its own window; you review/merge feature PRs as they gate (or they auto-merge if born-mergeable), and `flow epic status <id>` shows the board.

## State at each step

| Step           | What happens                                                       | Ready set          | Worktrees alive                           | Files written / where                                                               |
| -------------- | ------------------------------------------------------------------ | ------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| 0              | `flow epic design "…"`                                             | —                  | **design wt** `flow-watchlist/`           | discovery scratch in `flow-watchlist/.flow-tmp/`                                    |
| 1              | designer emits artifacts, opens design PR, **pauses**              | —                  | design wt                                 | `flow-watchlist/.flow/epics/watchlist/{design.md,manifest.json}` (on the PR branch) |
| 2              | you approve → **design PR merges**                                 | —                  | _(design wt removed)_                     | `.flow/epics/watchlist/{design.md,manifest.json}` now in **`main`** — survives      |
| 3 _(deferred)_ | `flow epic run watchlist` → tick reads manifest, computes frontier | **{A}**            | A's wt `flow-watchlist-schema/`           | A runs as a normal `flow new`; scratch in _its_ `.flow-tmp/`                        |
| 4 _(deferred)_ | A merges → tick recomputes                                         | **{B}**            | _(A wt removed)_, B's wt                  | B's code on its branch                                                              |
| 5 _(deferred)_ | B merges → **C and D both unblocked**                              | **{C, D}**         | C's wt **and** D's wt (parallel, ≤ cap K) | two feature worktrees live at once                                                  |
| 6 _(deferred)_ | C and D merge → tick recomputes                                    | **{E}**            | E's wt                                    |                                                                                     |
| 7 _(deferred)_ | E merges                                                           | **{}** → epic done | _(all removed)_                           | only committed code + the design dossier remain in `main`                           |

The state driving steps 3–7 is just Kahn's frontier recomputed from `manifest.json` + each feature's `~/.flow/state/<slug>.json` — nothing screen-scraped, every transition a file read (`02` §7, `00` Decision D).

## File flow — three tiers, three lifecycles

The design exists to get this right: the design output must **not** be treated like scratch.

**Tier 1 — design artifacts (`design.md`, `manifest.json`).** Live in the **design worktree** at `.flow/epics/<slug>/` while designing, **committed via the design PR**. When that PR merges they are in `main` and **survive permanently** (git history). The design worktree is removed after merge — the files outlive it _because they were committed_, unlike `.flow-tmp/`. **Never auto-deleted.** (This is the whole reason `04` puts them in git, not in `.flow-tmp/` which dies with the worktree, nor in `~/.flow/` which is per-machine and never reviewable.)

**Tier 2 — per-feature work.** Each feature (A…E) is a plain `flow new` → its **own** worktree + its own `.flow-tmp/` scratch. The feature's _code_ commits to its branch → feature PR → `main`. The **worktree + its `.flow-tmp/` are removed the moment that feature's PR merges** (standard `flow-remove-worktree`). During step 5 you have _two_ feature worktrees alive at once (C, D).

**Tier 3 — orchestrator runtime state (`~/.flow/epics/<id>.json`)** _(deferred)_. Per-machine, in your home dir, **not in any worktree, never committed**. Tracks which features launched and their live status — the role `~/.flow/state/<slug>.json` plays for one pipeline. **Deleted** on `flow epic done <id>`, or anytime, because it is **recomputable** from the committed manifest + the per-feature state files. The only new runtime storage, and it is the deferred half.

So: **design output is durable and git-auditable; feature scratch dies with each feature's worktree; orchestrator state is a disposable per-machine cache.** Worktrees are always transient; the committed manifest is the one durable contract that crosses from design into run.

## Supervisor / script — start, pause, resume

- **Design supervisor (designed).** A normal one-window Claude session. **Starts** on `flow epic design`. **Pauses** once, at the design checkpoint (writes the pending phase, ends the turn — crash-resilient via the same resume-from-disk logic as `/flow-pipeline`). **Resumes** when you approve/redirect. **Ends** at the gated/merged design PR.
- **Run orchestrator (deferred — `00` Decision J).** Deliberately **not** a long-lived process. A **stateless tick**: invoked (by `flow epic run`, opportunistically on `flow epic status`, or a launchd timer), it reads disk → computes the frontier → launches newly-ready `flow new` windows → **exits**. It doesn't "pause" in a process sense — between ticks nothing of _it_ runs; the per-feature pipelines run independently in their own windows. It "resumes" by ticking again and re-reading disk. That is the "not a daemon" choice, and why crash-resilience is free.

## Dogfooding & the bootstrap problem

**You cannot use `flow epic design` to build the epic designer — chicken-and-egg.** The tool doesn't exist until features F1–F5 (`03-build-plan.md`) land, so the first epic must be built without it.

What _is_ already dogfooded is the **output format**: `03` is a hand-authored instance of exactly what the designer emits — a feature-DAG manifest, with an embedded `manifest.json` built to pass its own F1/F2 validators.

**Build it as five separate `flow new` pipelines sequenced by `03`'s DAG — not one large pipeline.** A single pipeline would bundle schema + validator + CLI + discovery skill + integration into one un-reviewable PR, violating the decomposition rules the design rests on (`02` §6) and discarding the walking-skeleton de-risking (F1's schema is reviewed and validated _before_ F4 depends on it). So: `flow new` F1 → after it merges, F2 and F3 in parallel → then F4 → then F5, **with you acting as the orchestrator by hand.**

The insight worth noticing: hand-sequencing those five runs _is_ the manual-orchestration pain the deferred run phase removes — so **building the epic designer is itself the cleanest experiment for whether the orchestrator is worth building.** If doing it by hand feels fine, that's evidence the run phase is low-value; if it feels tedious, that's the signal to build it. The _real_ first dogfood of the tool is your **next** epic, after F1–F5 land.
