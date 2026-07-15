# Target architecture — flow as a modular, plugin-_style_ product

> **"Plugin" is conceptual, not Claude-plugin.** Throughout this document,
> "plugin" means a modular, plugin-_style_ architecture — clean module
> boundaries, install-time selection, graceful absence — **not** a commitment
> to Claude Code plugins. Claude-plugin / marketplace packaging is one of
> **three** candidate distribution end-states evaluated in Phase 6, no longer
> the assumed terminus. This document is named `target-architecture.md` (not
> the earlier PRD draft name `plugin-architecture.md`) precisely so the seam
> artifact does not bake in an unratified end-state.

This is the single source of truth for flow's modular redesign. It states the
ideal flow (design-blind), the gaps between that ideal and flow today (with
file evidence), the v1 module map (every artifact assigned to exactly one
module), and the six-phase roadmap. It is the seam artifact every later phase
of the `major-refactor-flow-modular-plugin` epic consumes: `## Module map`
becomes the `bin/lib/modules.ts` registry table; the per-phase `## Roadmap`
entries are the consumed edge for each phase-opening node.

It carries forward the ratified content of the epic's Phase-1 PRD — reused, not
re-derived — with four review-redirect deltas applied (2026-07-05):

1. **Plugins de-assumed** — Claude plugins are one candidate distribution
   end-state (Phase 6), not the terminus.
2. **tmux flipped to plain-default** — plain shell is the default launcher;
   tmux is an install-Q&A opt-in (default-off).
3. **Standalone skills home added** — flow skills move to a dedicated
   `~/.flow/claude-home/.claude/skills/` exposed only to flow-launched
   sessions, so plain `claude` sessions carry zero flow skills.
4. **`flow-` rename + testing split recorded** — every skill directory gets a
   `flow-`-prefixed target name; the Svelte-specific `testing` skill splits
   into a framework-agnostic core testing skill plus `flow-testing-svelte`.

---

## Ideal flow

The target is a **professional, modular product**: a user installs only what
their stack needs, flow contributes zero context to sessions that have nothing
to do with flow, recurring work is routed through named and auditable agents,
and the distribution mechanism is chosen on evidence. Five properties define
the ideal, each stated design-blind (what must be true, not how today's code
happens to do it).

### 1. Modular install — you install only what your stack needs

`flow install` links a **selected set of modules**, not all artifacts
unconditionally. `core` is mandatory; every stack and integration module is
opt-in. A first interactive install asks once per optional module and persists
the answer to `~/.flow/config.json`; a non-TTY install defaults to core with a
one-line notice naming how to widen the selection; `--upgrade` never re-asks.
Selection is expressible non-interactively (`--modules <csv>` / `--all` /
`--core-only`). Deselecting a module prunes its previously-linked artifacts.
When a pipeline step needs a module the user did not select (or a repo that
does not use it), the step **skips gracefully with a named notice** rather than
failing mid-pipeline — the same graceful-skip discipline flow already applies
when `agy` is absent, generalized to every module boundary, plus a
doctor-style summary of what is off and why.

### 2. File-based runtime state — plain shell is the default launcher

Pipeline state is fully file-based and launcher-agnostic. The **default runtime
is a plain shell**: `flow feature create` launches a pipeline in a plain
terminal with no tmux prerequisite. tmux is a first-class **opt-in** selected
at install Q&A (default-off) and becomes the default launcher only for users
who chose it; power users who run many parallel pipelines and want
walk-away/attach keep the full tmux experience. Launcher precedence is
`--tmux` / `--no-tmux` flag > recorded config > default-plain.

Because state is file-based, **liveness and collision detection are a
crash-safe file signal** — a PID plus the process's start-time recorded in
`~/.flow/state/<slug>.json`, consulted identically by `flow ls`, `flow done`,
and collision checks under **every** launcher. Process-start-time is what makes
it crash-safe: a bare PID heartbeat goes stale and a recycled PID reads as a
false-positive "alive"; pinning the start-time distinguishes the original
process from an unrelated later one that inherited the number. Window existence
is at most a tmux-mode nicety, never the source of truth. Session identity
(the pipeline slug that ~17 helpers and the supervisor resolve today from the
tmux `@flow-slug` window option) is threaded to the plain backend another way
(e.g. a launcher-set env var), and the turn-end Stop guard covers the plain
backend, not just its existing outside-tmux no-op.

### 3. Three-tier progressive disclosure with session-scoped skill exposure

flow's context cost is disclosed in three tiers, and the outermost tier is
**session-scoped**:

- **Tier 0 — plain `claude` sessions pay zero.** A user running plain `claude`
  on a machine with flow installed contributes **zero** flow skills to the
  session's routing table. Flow skills live in a standalone home
  (`~/.flow/claude-home/.claude/skills/`) exposed only to flow-launched
  sessions via `--add-dir`; the `flow` launcher verb runs
  `claude --add-dir ~/.flow/claude-home`, and pipeline seed sessions get the
  same wiring. The home is nested one level under `~/.flow` (not `~/.flow`
  directly) so the `--add-dir` grant excludes `config.json`, `state/`, and
  `research-cache/` from the session's workspace reach.
- **Tier 1 — installed skills.** Within a flow session, only the modules the
  user installed contribute skill frontmatter; never-selected modules are not
  installed at all, so they cannot tax any session.
- **Tier 2 — on-demand bodies.** Claude Code's native mechanism: a skill's
  ~100-token frontmatter is the routing entry; the full SKILL.md body loads
  only when the skill is invoked. flow conforms per-skill today; the redesign
  fixes the tiers _above_ this one (which sessions and which modules pay the
  frontmatter tax at all).

### 4. Named custom agents with pinned, declarative model routing

Every recurring pipeline fan-out is a **named `agents/*.md` custom-agent
definition** with declarative routing, not an inline anonymous spawn prompt
with model/effort pins buried in prose. The frontmatter policy follows the
verified Claude Code routing semantics (live Agent tool schema +
code.claude.com/docs/en/sub-agents, 2026-07-05):

- **`effort` is pinned only for mechanical roles** (verify, fix-applier).
  Judgment roles omit `effort` so they inherit session effort — the Task/Agent
  tool has no per-invocation `effort` parameter, so definition frontmatter is
  the only place to pin it, and omitting the field inherits.
- **Frontmatter `model` is omitted wherever a spawn site threads a per-spawn
  `model:`** from flow's per-phase config, because per-invocation `model`
  always beats frontmatter in the resolution order (`CLAUDE_CODE_SUBAGENT_MODEL`
  env, then a per-invocation `model` param, then frontmatter `model`, then the
  session model). Promotion therefore costs **zero** model tunability. A fixed
  cost pin that is not config-threaded (the gatekeeper's haiku) lives in
  frontmatter.

The one legitimate cost is an install dependency — each custom agent needs its
`~/.claude/agents/<name>.md` symlinked — so every promoted spawn site keeps the
`[ -f ~/.claude/agents/<name>.md ] || general-purpose` fallback guard, and the
fallback **emits a named notice** when it fires (a silent swap to
`general-purpose` discards a tool-restricted role's allowlist containment, a
prompt-injection concern).

### 5. Problem-first planning artifacts

Planning artifacts lead with the **problem**, not a feature spec: a PRD's
Problem Statement anchors on the user's ultimate goal (laddered up from the
surface request), surfaces prompt-vs-target tensions and binary-framing
middle grounds in the sections downstream consumers read, and records
consequential decisions in an ADR-shaped decision analysis that a cross-model
reviewer can pressure-test before the plan gate. This property is **already
aligned** in flow today; it is stated here so the ideal is complete and so the
Phase-5 context audit measures planning-artifact transit as part of per-phase
attribution.

### Distribution is deliberately left open

The ideal does **not** name a distribution mechanism. Module boundaries are
drawn so they _can_ become plugin boundaries if the Phase-6 evaluation picks
plugins — but the winner among (a) Claude plugins / marketplace, (b) launcher +
standalone-dir distribution, (c) module-filtered symlinks is chosen on
evidence in Phase 6, and the module layer, standalone home, and graceful
degradation all deliver value regardless of which wins.

---

## Gap analysis

Ideal vs. flow today, with file evidence. Each row names the concrete residual
and the phase that closes it. The four axes the prior PRD marked
"aligned" / "largely aligned" get their residuals elaborated below the table
(per the redirect), because "aligned" is not "nothing left to do".

| Axis                      | Ideal                                                            | Today                                                                                                | Evidence                                                                                                                                                                                          | Closed by                                                          |
| ------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Install granularity**   | selected modules; core mandatory; opt-in stacks                  | `flow install` symlinks all skills, agents, helpers, validators unconditionally                      | `discoverAll` links everything; no module boundary or selection flag                                                                                                                              | Phase 1 (`p1-module-registry-install`)                             |
| **Module absence**        | graceful named skip                                              | a deselected/absent module is a latent mid-pipeline failure                                          | no absence contract beyond the ad-hoc agy graceful-skip                                                                                                                                           | Phase 2 (`p2-conditional-degradation`)                             |
| **Launcher**              | plain shell default; tmux opt-in                                 | tmux is a hard prerequisite for every pipeline                                                       | `flow feature create` opens a tmux window unconditionally                                                                                                                                         | Phase 3 (`p3-launcher-backend`, `p3-plain-mode-docs`)              |
| **Liveness signal**       | crash-safe PID + start-time, canonical for every launcher        | window existence is the liveness/collision source of truth                                           | `windowExists` in `bin/lib/feature.ts` and `bin/lib/done.ts`                                                                                                                                      | Phase 3 (`p3-file-liveness`)                                       |
| **Session-scoped skills** | plain `claude` pays zero flow skills                             | every installed skill's frontmatter taxes **every** session on the machine                           | skills linked into global `~/.claude/skills/`                                                                                                                                                     | Phase 2 (`p2-standalone-skills-home`) + Phase 1 (module selection) |
| **Agent topology**        | recurring fan-outs are named `agents/*.md` with declarative pins | review surface closed (10 named definitions); the pipeline fan-out roles remain inline spawn prompts | `p4-review-agents` added 8 roles (6 `flow-review-<lens>` + `flow-gatekeeper` + `flow-consolidator`) beside the 2 `effort: low` mechanical pins; scout/discovery/merge-resolver still pin in prose | Phase 4 (`p4-pipeline-agents`)                                     |
| **Skill naming**          | every skill `flow-`-prefixed; provenance clear in mixed sessions | unprefixed dir names (`verify`, `testing`, `coder`) invite collisions                                | dir name = command name; no `flow-` prefix on most skills                                                                                                                                         | Phase 2 (`p2-flow-prefix-rename`)                                  |
| **Distribution**          | evidence-chosen among 3 candidates                               | no distribution story beyond global symlinks                                                         | `flow install` symlink/manifest machinery only                                                                                                                                                    | Phase 6 (`p6-distribution-eval`, `p6-distribution-impl`)           |

### Elaborated residuals for the "aligned" / "largely aligned" axes

- **Pipeline mechanics, PRD shape, review gate — "already aligned":** no
  residual structural shortcoming identified; no epic node re-touches this
  surface. (The Phase-5 audit still measures planning-artifact context transit
  as part of per-phase attribution; if that surfaces a residual, it routes to
  `p5-context-diet`.)
- **Sub-agent isolation — "largely aligned":** the supervisor keeps most
  diff-bearing work out of its own context by routing edits to `/flow-coder` and the
  nine Task-tool exemptions. Two residuals remain: (a) small in-process
  supervisor edits **below the `/flow-coder` routing threshold** still land their
  diffs and tool_results in the supervisor's context, and (b) that threshold is
  prose-judged (≤1 file, ≤30 LOC, every file named), not mechanically enforced.
  → **Phase 5**: `p5-token-audit` measures the in-process edit-size
  distribution; `p5-context-diet` tightens the threshold or adopts a
  hook-enforced mechanical edit cap if the data supports it.
- **Model routing — "largely aligned":** flow threads per-phase `model:`
  correctly, and the **review surface is now closed**: `p4-review-agents`
  promoted 8 more roles to named `agents/*.md` definitions (the six
  `flow-review-<lens>` lenses, `flow-gatekeeper` with its declarative
  `model: haiku` pin, and `flow-consolidator`) beside `flow-verify` /
  `flow-fix-applier`. The **pipeline surface remains open**: the scout,
  discovery, and merge-resolver are still **inline spawn prompts** whose
  model/effort pins live in prose and can silently drift. → **Phase 4**:
  `p4-pipeline-agents` promotes them under the frontmatter policy in
  Ideal-flow §4.
- **Skill loading — "aligned" per-skill only:** Claude Code's
  frontmatter-routing / body-on-demand mechanism is sound and flow conforms
  per-skill. The residual is a _tier above_ the per-skill mechanism: every
  **installed** skill's frontmatter taxes **every** session on the machine —
  ~20 skills × ~100 tokens in every plain `claude` session, flow-relevant or
  not, and stack skills tax non-stack work. → closed on three fronts:
  `p2-standalone-skills-home` (plain sessions drop to zero flow skills),
  `p1-module-registry-install` (never-relevant modules aren't installed at
  all), and `p2-per-repo-activation-eval` (per-repo granularity for
  multi-stack machines).

---

## Module map

Every current `skills/*/` skill, every `agents/*.md`, and every PATH-bound
helper and validator is assigned to **exactly one** v1 module (no orphan, no
double assignment). This map is the edge artifact `p1-module-registry-install`
encodes as the `bin/lib/modules.ts` registry table; its completeness lint
asserts exactly this one-artifact-one-module partition.

Rows record the **current** directory name and the **target `flow-`-prefixed**
name that `p2-flow-prefix-rename` will apply. Already-prefixed names
(`flow-pipeline`, `flow-research`) are unchanged. The `flow-verify` / `flow-`
skill names coexist with the same-named agent definitions in separate
namespaces (skill vs `agents/`); the exact naming is finalized at that node's
planning.

### `core` (mandatory)

The pipeline supervisor, every skill it loads in-process, the worktree/PR/state
machinery, the review lenses that need no external service, the wrapper, and
the PATH-bound schema validators. Always installed.

**Skills**

| Current dir                                     | Target name             | Role                                                                       |
| ----------------------------------------------- | ----------------------- | -------------------------------------------------------------------------- |
| `skills/pipeline/flow-pipeline`                 | `flow-pipeline`         | pipeline supervisor                                                        |
| `skills/pipeline/flow-product-planning`         | `flow-product-planning` | PRD + discovery                                                            |
| `skills/pipeline/flow-new-feature`              | `flow-new-feature`      | feature implement + scout                                                  |
| `skills/pipeline/flow-verify`                   | `flow-verify`           | pre-commit verify loop                                                     |
| `skills/pipeline/flow-pr-review`                | `flow-pr-review`        | multi-agent review + fixes                                                 |
| `skills/pipeline/flow-coder`                    | `flow-coder`            | isolated edit-applier                                                      |
| `skills/pipeline/flow-epic-create`              | `flow-epic-create`      | epic-designer supervisor                                                   |
| `skills/pipeline/flow-epic-run`                 | `flow-epic-run`         | epic-orchestrator supervisor                                               |
| `skills/universal/flow-add-worktree`            | `flow-add-worktree`     | worktree scaffold                                                          |
| `skills/universal/flow-remove-worktree`         | `flow-remove-worktree`  | worktree teardown                                                          |
| `skills/universal/flow-refactoring`             | `flow-refactoring`      | behavior-preserving cleanup                                                |
| `skills/universal/flow-checkpoint`              | `flow-checkpoint`       | conversational-state flush                                                 |
| `skills/universal/flow-ui-ux`                   | `flow-ui-ux`            | stack-agnostic UI/UX judgment                                              |
| `skills/universal/flow-skill-creator`           | `flow-skill-creator`    | authoring new skills                                                       |
| `skills/universal/flow-testing` (generic split) | `flow-testing`          | framework-agnostic testing skill (the generic half of the `testing` split) |

> **`testing` split is a Phase-2 materialization — the Phase-1 registry
> assigns the pre-split dir wholly to `core`.** The single current
> `skills/universal/flow-testing` directory appears in two rows above — `core`
> (`flow-testing`) and `stack-svelte` (`flow-testing-svelte`) — because those
> rows describe the **post-split** target the `p2-flow-prefix-rename` sweep
> produces (D11). Until that sweep lands, the one dir cannot map to two
> modules, so **at Phase 1 the completeness lint (which scopes to current
> `skills/*/` dirs) assigns the whole `skills/universal/flow-testing` dir to
> `core`**; the `stack-svelte` `flow-testing-svelte` row activates only once
> the split materializes in Phase 2. This keeps the one-artifact-one-module
> partition true at every phase: exactly one owner pre-split (`core`), exactly
> one owner for each half post-split.

**Agents**

| Current                                     | Role                             | Frontmatter pin                                |
| ------------------------------------------- | -------------------------------- | ---------------------------------------------- |
| `agents/flow-verify.md`                     | verify-retry-loop agent          | `tools:` allowlist; `effort: low` (mechanical) |
| `agents/flow-fix-applier.md`                | pr-review fix-applier            | `tools:` allowlist; `effort: low` (mechanical) |
| `agents/flow-review-bug-detection.md`       | pr-review lens                   | `tools: Read, Grep, Glob, Write`               |
| `agents/flow-review-security.md`            | pr-review lens                   | `tools: Read, Grep, Glob, Write`               |
| `agents/flow-review-pattern-consistency.md` | pr-review lens                   | `tools: Read, Grep, Glob, Write`               |
| `agents/flow-review-performance.md`         | pr-review lens                   | `tools: Read, Grep, Glob, Write`               |
| `agents/flow-review-supply-chain.md`        | pr-review lens                   | `tools: Read, Grep, Glob, Write`               |
| `agents/flow-review-test-coverage.md`       | pr-review lens                   | `tools: Read, Grep, Glob, Write`               |
| `agents/flow-gatekeeper.md`                 | pr-review gatekeeper             | `tools:` allowlist; `model: haiku`             |
| `agents/flow-consolidator.md`               | pr-review consolidator-validator | `tools:` allowlist                             |
| `agents/flow-scout.md`                      | new-feature scout                | `tools:` allowlist                             |
| `agents/flow-discovery.md`                  | product-planning discovery       | no `tools:` (inherits all)                     |
| `agents/flow-merge-resolver.md`             | pipeline merge-conflict resolver | `tools:` allowlist                             |
| `agents/flow-edit-applier.md`               | coder edit-applier               | `tools:` allowlist                             |

Phase 4 is complete: the scout, discovery, merge-resolver, and
edit-applier fan-outs are now promoted `agents/*.md` definitions —
mirroring the six review lenses, the gatekeeper, and the consolidator
above — each resolved via the `[ -f ~/.claude/agents/<name>.md ] ||
general-purpose` fallback guard.

**PATH-bound helpers** (all core — the pipeline machinery)

`flow` (wrapper), `flow-new-worktree`, `flow-remove-worktree`,
`flow-state-update`, `flow-rename-window`, `flow-open-pr`, `flow-pre-commit`,
`flow-gate-decide`, `flow-gate-summary`, `flow-merge-guard`,
`flow-pipeline-summary`, `flow-resume-decide`, `flow-stop-guard`,
`flow-classify-step`, `flow-step3-route`, `flow-candidate-issues`,
`flow-create-issue`, `flow-followups`, `flow-foreclosed-paths`,
`flow-notify`, `flow-checkpoint`, `flow-ci-wait`, `flow-fetch-pr-review`,
`flow-reply-pr-comments`, `flow-fetch-intent-comments`, `flow-post-findings`,
`flow-annotate-pr`, `flow-pr-diff`, `flow-pr-agent-lens`,
`flow-pr-static-analysis`, `flow-inject-evidence`, `flow-ui-validate`,
`flow-md-validate`, `flow-release`, `flow-seed-ingested-hook`,
`flow-session-start-hook`, `flow-epic-dag`, `flow-epic-resume-decide`,
`flow-epic-judge-context`.

**PATH-bound validators** (all core)

`flow-pr-review-result-schema` (`bin/lib/pr-review-result-schema.ts`),
`flow-agent-finding-schema` (`bin/lib/agent-finding-schema.ts`),
`flow-fix-applier-schema` (`bin/lib/fix-applier-schema.ts`).

> Internal-import schemas (`bin/lib/coder-schema.ts`,
> `bin/lib/epic-judgment-schema.ts`, `bin/lib/epic-manifest-schema.ts`,
> `bin/lib/ui-validation-schema.ts`) are **not** PATH-bound standalone
> artifacts — they ship as imports of their consuming core helper, so they are
> not independent registry rows. The registry lint scopes to `skills/*/`,
> `agents/*.md`, and PATH-bound helpers/validators.

### `stack-svelte`

| Current dir                                    | Target name           | Role                                                                            |
| ---------------------------------------------- | --------------------- | ------------------------------------------------------------------------------- |
| `skills/stacks/flow-svelte`                    | `flow-svelte`         | Svelte 5 / SvelteKit authoring + review                                         |
| `skills/universal/flow-testing` (svelte split) | `flow-testing-svelte` | Svelte/vitest/testing-library specifics (the stack half of the `testing` split) |

### `stack-tailwind-shadcn`

| Current dir                          | Target name            | Role                           |
| ------------------------------------ | ---------------------- | ------------------------------ |
| `skills/stacks/flow-tailwind-shadcn` | `flow-tailwind-shadcn` | Tailwind v4 / shadcn-svelte UI |

### `stack-supabase`

| Current dir                           | Target name             | Role                              |
| ------------------------------------- | ----------------------- | --------------------------------- |
| `skills/stacks/flow-supabase-project` | `flow-supabase-project` | project-specific Supabase adapter |

### `stack-cloudflare-pages`

| Current dir                           | Target name             | Role                                |
| ------------------------------------- | ----------------------- | ----------------------------------- |
| `skills/stacks/flow-cloudflare-pages` | `flow-cloudflare-pages` | Cloudflare Pages deploy conventions |

### `copilot`

The GitHub Copilot bot-review integration. No skill; one helper. When
deselected, the pipeline's Copilot request/wait path skips with a named notice
(Phase 2 degradation).

| Helper                 | Role                                                |
| ---------------------- | --------------------------------------------------- |
| `flow-request-copilot` | Copilot reviewer-request decision + glob classifier |

### `research`

The Google-AI-Ultra (`agy`) delegation engine, the research helpers built on
it, and the two agy-dependent cross-model reviewers. Everything here requires
`agy`; when the module is deselected (or `agy` is absent) each path skips
gracefully — the existing agy graceful-skip generalized.

| Skill / helper                                     | Role                                              |
| -------------------------------------------------- | ------------------------------------------------- |
| `skills/universal/flow-research` → `flow-research` | deep multi-source fact-checked research           |
| `flow-delegate`                                    | agy delegation primitive                          |
| `flow-delegate-fanout`                             | multi-prompt agy fan-out (powers `flow-research`) |
| `flow-research-run`                                | forced-research gather+refute run                 |
| `flow-research-note`                               | research skip-note backstop                       |
| `flow-research-cache`                              | host-wide research-synthesis cache                |
| `flow-plan-review`                                 | cross-model (AGY) plan-decision review            |
| `flow-gemini-lens`                                 | cross-model (AGY / Gemini) PR-review lens         |

> `flow-plan-review` and `flow-gemini-lens` are agy-dependent cross-model
> reviewers, so they live with the agy stack in `research` rather than in
> `core`; the `core` pipeline consumes them behind the `review.gemini` opt-in
> and degrades gracefully when `research` is absent.

---

## Roadmap

Six phases. **Phases are labels, not sequencing** — the epic DAG is the truth;
independent strands land in parallel. Entry/exit criteria below are the
consumed edge each phase-opening node reads from this doc.

### Phase 1 — module layer

- **Entry:** this document exists and its `## Module map` partitions every
  artifact into exactly one module.
- **Nodes:** `p1-design-doc` (this doc, the root); `p1-module-registry-install`
  (a typed, pure-data `bin/lib/modules.ts` registry + selection-aware
  `flow install` with `--modules`/`--all`/`--core-only`, TTY Q&A persisted to
  `~/.flow/config.json`, `--upgrade` no-re-ask, prune via the existing
  manifest).
- **Exit:** `flow install --all` produces a symlink set **byte-identical** to
  today's unconditional install (zero regression for the existing user); the
  registry completeness lint (no orphan, no double assignment) is green.

### Phase 2 — conditionality, session scoping, skill surface

- **Entry:** the module registry + selection contract from Phase 1.
- **Nodes:** `p2-conditional-degradation` (named skip-notices on every
  module-dependent path + a doctor-style summary); `p2-standalone-skills-home`
  (`~/.flow/claude-home/.claude/skills/` link target + the bare `flow` launcher
  verb via `--add-dir`, plain sessions flow-free); `p2-flow-prefix-rename`
  (every skill dir → its `flow-` target name from the map, full cross-reference
  sweep, the `testing` split); `p2-per-repo-activation-eval` (per-repo module
  granularity on top of the launcher — may resolve docs-only).
- **Exit:** plain `claude` contributes zero flow skills; a `flow`-launched
  session loads the installed skills from the standalone home; zero stale
  old-name references in shipped artifacts; the module-absence contract holds
  end-to-end. Phase 2 intentionally breaks Phase 1's byte-identical guarantee
  (it retargets link locations and renames dirs) under its own gated criteria.

### Phase 3 — plain-default runtime (tmux opt-in)

- **Entry:** the Roadmap's Phase-3 spec — a crash-safe liveness signal (PID +
  process-start-time, per the AGY pre-mortem that bare heartbeats go stale and
  recycled PIDs read as false-alive) and a launcher-backend interface with
  plain as the default.
- **Nodes:** `p3-file-liveness` (liveness fields in `~/.flow/state/<slug>.json`
  - an alive/dead/stale helper consulted by `flow ls`/`done`/collision under
    every launcher; `windowExists` demoted to a tmux-mode nicety);
    `p3-launcher-backend` (plain-terminal default + tmux opt-in implementations,
    precedence `--tmux`/`--no-tmux` > config > default-plain, the install-Q&A
    **default-off** tmux question — shipped **with** this node, since asking
    before the backend exists would record a preference nothing honors — plus
    slug propagation for the plain backend and `flow-stop-guard` plain-mode
    coverage); `p3-plain-mode-docs` (README/AGENTS.md lead with plain shell; tmux
    documented as the opt-in power option).
- **Exit:** a pipeline launched with no tmux opt-in in effect runs in a plain
  shell; `flow ls`/`done`/collision report correctly under both launchers via
  the file liveness signal; opt-in tmux stays byte-compatible with today.

### Phase 4 — custom-agent consolidation

- **Entry:** the Roadmap's Phase-4 **consolidation map** — which recurring
  fan-out promotes to which named agent, and its model/effort pin per the
  Ideal-flow §4 frontmatter policy (mechanical roles pin `effort`; judgment
  roles inherit; frontmatter `model` omitted wherever a per-spawn `model:` is
  config-threaded; gatekeeper haiku pinned in frontmatter).
- **Nodes:** `p4-review-agents` (`agents/*.md` for the six review lenses, the
  gatekeeper, the consolidator-validator); `p4-pipeline-agents` (`agents/*.md`
  for scout, discovery — feature + epic modes, the merge-conflict resolver,
  and the `/flow-coder` edit-applier — the edit-applier is **promoted**: a
  user decision at the plan checkpoint reversed the "evaluated, not
  pre-committed" deferral this bullet previously named, on
  set-completeness grounds — the highest-frequency code-editing fan-out
  should not be the lone unauditable role. The `/flow-epic-run` judgment
  agent **no longer exists**: `/flow-epic-run` is a zero-fan-out playbook
  (see `AGENTS.md` `## Don'ts`), so there is no judgment-agent spawn site
  left to promote).
- **Exit:** every promoted role is a named definition; every promoted spawn
  site keeps the `[ -f ~/.claude/agents/<name>.md ] || general-purpose`
  fallback guard (emitting a named notice on fallback); artifact contracts
  unchanged; the nine-exemption set renamed in place, never widened.

### Phase 5 — context economy (measure, then tighten)

- **Entry:** the Roadmap's Phase-5 measurement plan (what to measure, exit
  criteria).
- **Nodes:** `p5-token-audit` (a transcript-analysis helper tested on a
  fixture, attributing spend per phase and tool-call class, plus a
  real-pipeline baseline `docs/context-economy-audit.md` — including the
  in-process edit-size distribution and the measured frontmatter cost of
  installed skills); `p5-context-diet` (AGENTS.md diet toward the ~200-line
  guidance, further lean-body/lazy-reference SKILL.md splits, edit-threshold
  tightening or a mechanical edit-cap guard if the data supports it,
  re-measured before/after delta).
- **Exit:** a measured per-phase token baseline and a before/after delta for
  each diet change, recorded in a committed report; structural lints stay
  green.

### Phase 6 — distribution end-state (evaluate, then implement the winner)

- **Entry:** the shipped launcher + standalone home (candidate b's operating
  evidence) and the module-absence contract any per-repo/per-selection
  mechanism relies on.
- **Nodes:** `p6-distribution-eval` (an evidence-backed ADR addendum to this
  doc choosing among **(a)** Claude plugins / marketplace packaging,
  **(b)** launcher + standalone-dir distribution, **(c)** module-filtered
  symlinks — optionally spiking a throwaway one-module plugin package for
  evidence — plus the contracted scope for the implementation node);
  `p6-distribution-impl` (the winning mechanism end-to-end; expected to be
  re-decomposed against the verdict before execution).
- **Exit:** a recorded evidence-backed distribution verdict, and the winning
  mechanism delivered. `p6-distribution-impl` is the **first sanctioned break**
  of Phase 1's `--all` byte-parity guarantee, per the plugins-de-assumed
  redirect: the mechanism is chosen on evidence, not assumed.

---

_Prior art: this document carries forward the ratified Phase-1 PRD and the
epic design (`.flow/epics/major-refactor-flow-modular-plugin/design.md`,
decisions D1–D11), reused not re-derived, with the four review-redirect deltas
applied. The Phase-1 feature-grain task breakdown for
`p1-module-registry-install` lives in §7 of that design doc._
