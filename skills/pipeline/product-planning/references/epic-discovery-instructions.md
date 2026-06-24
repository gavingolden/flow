# Epic discovery instructions

These instructions are read by the Independent Discovery Subagent that
`/product-planning`'s SKILL.md spawns when the caller passes `MODE: epic`.
They are the **epic-grain** sibling of `discovery-instructions.md`: the same
one-shot-discovery machinery, re-grained one altitude up. The feature-grain
file decomposes one PR into intra-feature tasks; this file decomposes an
**epic** — a body of work larger than one PR — into a dependency DAG of
**features**, where **one node = one PR-sized feature** that each becomes a
single ordinary `flow new` pipeline.

The designer **produces artifacts and stops**. It emits a six-section
`design.md` plus a typed `manifest.json` under `.flow/epics/<slug>/`,
self-validates both against the two committed checkers, and halts. It does
not launch, schedule, watch, or merge anything — that is the deferred
orchestrator's job (out of scope).

The wrapper passes you these inputs in its spawn prompt:

- The verbatim epic prompt.
- The absolute worktree path (`WORKTREE`, your working directory).
- The absolute skill base directory (`SKILL_DIR`). Resolve every sibling
  reference path under it — e.g. `<SKILL_DIR>/references/architecture-patterns.md`,
  `<SKILL_DIR>/references/example-prd.md`. Those files do not exist relative
  to the worktree you `cd`'d into — they live in the skill directory, which
  is somewhere else on disk (typically
  `~/.claude/skills/product-planning/` or
  `<flow-checkout>/skills/pipeline/product-planning/`).
- The epic-output directory (the `.flow/epics/<slug>/` path under `WORKTREE`
  where `design.md` + `manifest.json` are written).

For the canonical exemplar of a finished design: **in flow's own repo**, the
committed worked example at `.flow/epics/build-the-epic-designer/` (its
`design.md` + `manifest.json` are a real epic decomposed by this method, and
they pass both validators) is the canonical exemplar. It is **not** distributed
to consumer repos (`flow setup` ships only `skills/` + `bin/`), so when you run
in a consumer `WORKTREE` that path won't exist — treat it as **optional: read
it if present, skip it if absent**, mirroring the `if exists` guard this file
uses for the `example-prd.md` reference below. The six-section shape required of
your own output is fully specified in §5a regardless.

## 1. Load Project Context

Before forming a decomposition, load background context so your design is
grounded in the real codebase, not a guess:

- Read `README.md` / `AGENTS.md` / `CLAUDE.md` (if present) for
  architecture, tech stack, conventions, and existing capabilities. A
  decomposition that conflicts with documented constraints is a rework risk.
- Scan the source tree to understand existing modules, domain models, and
  the seams an epic-sized change would cut across.
- List the project's skill directory (`.claude/skills/` or equivalent) — do
  not hardcode a static list when assigning a skill to each feature in §4.
- If `<SKILL_DIR>/references/architecture-patterns.md` exists, load it to
  see which patterns apply.
- If `<SKILL_DIR>/references/example-prd.md` exists, load it to see what
  "good" prose looks like for this project (tone precedent for `design.md`).

This is read-only background — these reads stay in your context and don't
propagate.

## 2. Scope Check — confirm this is epic-grain

Confirm the prompt genuinely describes an **epic** (more than one mergeable
PR's worth of work that wants decomposition). If the prompt is in fact a
single PR-sized change, that is a feature, not an epic — note it loudly in
Open Questions and still emit the artifacts, but with a single-feature (or
small) DAG, so the caller can redirect rather than over-decompose a small
change into artificial slices.

The output shape is fixed regardless of size: a six-section `design.md` +
a typed `manifest.json`, both written under `.flow/epics/<slug>/`. The
difference between a large epic and a small one is the number of nodes in
the DAG, not the artifact set.

## 3. Discovery — make informed assumptions, surface ambiguity (one-shot)

**You are a one-shot subagent. You CANNOT ask the user clarifying
questions** — the Task tool returns one result and exits. This is flow's
existing one-shot-discovery stance, unchanged at epic grain. When the epic
prompt leaves something unspecified:

- **Make a defensible assumption** based on the codebase, the project's
  existing patterns, and reasonable defaults for this kind of epic.
- **Surface every assumption you made** in the `design.md` Open Questions
  section — one bullet per assumption: what you assumed, why, and what the
  user should confirm or redirect at the approval checkpoint.

Your job is not to ask — it is to produce a design grounded enough that the
user can either approve it or redirect with a single message.

> **The materiality-gated clarification round is a CALLER concern, not the
> designer's.** Design-spec `02` §3 frames a HYBRID — "one bounded round of
> material clarifying questions, then autonomous." That clarification round
> is **relocated to F5's `flow epic create` caller**, which fires
> `AskUserQuestion` as its own authorized form and _then_ spawns this
> one-shot designer on the already-clarified prompt. A one-shot discovery
> subagent structurally cannot fire `AskUserQuestion` (one result, then
> exit), so authoring a clarification-round procedure here would be dead
> text. **Do not author one.** This file documents the one-shot stance only;
> the prompt you receive is treated as already-clarified, and any residual
> ambiguity goes to Open Questions.

Signals to lean on when forming assumptions: existing code patterns (cite by
file path), `AGENTS.md` / `CLAUDE.md` rules, and the verbatim epic prompt
(quote load-bearing phrasing rather than paraphrasing).

## 4. Design the epic — the methodology (pipeline ① from `02` §4)

Apply one coherent, expert-grounded method per backbone stage, at minimum
artifact weight. The backbone is:

```
epic prompt → clarified requirements → high-level design → feature decomposition → dependency DAG (+ artifacts)
```

### 4a. Clarified requirements — EARS

Express the epic's user-visible behaviors as acceptance criteria in **EARS**
syntax:

```
WHEN <trigger> THE SYSTEM SHALL <response>
```

These are **epic-level** criteria (coarser than a single feature's): they
describe the epic's externally-observable behavior. Per-feature acceptance
lives in each feature's `acceptanceCriteria[]` in the manifest (§4c). Every
criterion should name an externally-failable check where one exists (a test
that runs, a file in the expected shape, a command exit code); reserve prose
only for irreducibly subjective items.

### 4b. High-level design — ADR-shaped Parnas decisions

Write a lightweight design whose key decisions are **ADR-shaped**
(Context / Decision / Consequences). Crucially, this list of decisions **IS
the Parnas "list of difficult, likely-to-change design decisions"** — the
design artifact and the decomposition criterion are the same list, viewed
twice. Each volatile decision (each "secret") becomes a candidate feature
boundary in §4c: one decision hidden behind one stable interface = one
feature.

### 4c. Feature decomposition — vertical slices, Parnas + Simon seams

Decompose into **features**, each sized to be **exactly one `flow new`
pipeline = one mergeable PR = one vertical slice that passes its own gate**.
The rules:

1. **Vertical slices, not horizontal layers (Parnas).** Each feature is an
   end-to-end increment that can pass its own `## Test Steps` gate — never
   "the DB layer" across the whole epic. A horizontal slice cannot be merged
   or verified independently, so it is not a valid feature.
2. **Decompose by what changes together (Parnas + Simon).** Each feature
   hides one likely-to-change decision (the §4b secret) behind a stable
   interface; the stable interface is what goes on the edges. High cohesion
   within, low coupling across. If two candidate features must change in
   lockstep, they are one feature.
3. **A feature is PR-sized, not task-sized.** If it can't plausibly be one
   focused PR with one coherent review, split it. Each feature's own
   `/flow-pipeline` run rediscovers its internal tasks later — decompose to
   features now, not tasks (Shape Up applied recursively).
4. **A clean dependency edge is a produced/consumed artifact, not a vibe.**
   B `dependsOn` A **only when B consumes something A produces** — a schema,
   migration, interface, file, or exported symbol that must exist first.
   "Feels later" is not an edge. State the concrete produced/consumed
   artifact on each edge.
5. **Sparse edges by construction (Simon near-decomposability).** A dense
   edge set is a diagnostic that a boundary was drawn at a strong-coupling
   place — re-cut rather than ship the dense DAG.
6. **Prefer a walking-skeleton root (Story Mapping).** The first feature is
   a thin end-to-end slice (the schema/seam everything else hangs off), so
   the DAG has a clear root and early features de-risk the architecture.

For each feature, capture: a `title`, a self-contained `description` (one
paragraph sufficient to run one standard `flow new` pipeline — this becomes
the pipeline's prompt), its `dependsOn[]` edges (produced/consumed only), a
one-line `rationale` (which volatile decision it hides), its EARS-shaped
`acceptanceCriteria[]`, and `flowNewHints` (`autoMerge` / `copilotReview` /
`effort`) — **populated, never acted on** (the orchestrator seam from `02`
§10). Flag the thin MVP slice with `mvp: true`.

### 4d. Dependency DAG — Mermaid

Render the feature graph as a fenced ` ```mermaid ` `graph` block GitHub
renders inline (a structural picture, not a process). Disconnected
sub-DAGs are legal (independent strands of one epic); only cycles and
orphan edges are errors (the validators in §6 enforce this mechanically).

### 4e. Open Questions

Collect every assumption made under ambiguity (§3) plus anything still
unresolved as Open Questions for the approval checkpoint — including, if it
applies, a note when you judged the prompt genuinely epic-sized vs a single
feature.

## 5. Write the two artifacts

Resolve the slug from the epic prompt (mirror the project's `slugify` unless
the caller passed an explicit slug). Resolve the directory and filenames
from `bin/lib/epic-manifest-schema.ts`:

- Directory: `epicDirRelative(slug)` → `.flow/epics/<slug>/` (no trailing
  slash).
- Design doc: `EPIC_DESIGN_FILENAME` (`design.md`).
- Manifest: `EPIC_MANIFEST_FILENAME` (`manifest.json`).

### 5a. `design.md` — the six sections (the human review surface)

Write `design.md` with **all six** of these section headings, in order
(tone precedent: `<SKILL_DIR>/references/example-prd.md`):

1. `## 1. Problem & intent` — the epic's underlying need (JTBD-lite), not
   solution language.
2. `## 2. Clarified requirements` — user-visible behaviors with EARS
   acceptance criteria (§4a).
3. `## 3. High-level design` — the ADR-shaped (Context/Decision/
   Consequences) key decisions, which ARE the Parnas volatile-decision
   list (§4b), each a candidate feature boundary.
4. `## 4. Feature decomposition` — the feature list with a one-line
   rationale per feature (which volatile decision it hides), the
   produced/consumed edges, and the walking-skeleton root made visible
   (§4c).
5. `## 5. Dependency DAG` — the fenced Mermaid `graph` (§4d).
6. `## 6. Open Questions` — the residue for the checkpoint (§4e).

### 5b. `manifest.json` — the machine contract (typed `EpicManifest`)

Write `manifest.json` matching the `EpicManifest` / `Feature` shape owned by
`bin/lib/epic-manifest-schema.ts`:

- Top level (all required, all non-empty strings): `epicId`, `prompt` (the
  verbatim epic prompt), `createdAt` (ISO-8601 by convention — the validator
  accepts any non-empty string), and `features[]`.
- Each feature (required: `id`, `title`, `description`, `dependsOn[]`;
  optional: `rationale`, `acceptanceCriteria[]`, `flowNewHints`, `mvp`) as
  captured in §4c. Keep it 100% consistent with `design.md`'s §4/§5 (same
  ids, titles, and edges).

## 6. Self-validate — the MANDATORY correctness loop

This is the key correctness gate and is **non-negotiable**. After writing
`manifest.json`, shell out to **BOTH** validators (both are bare-name
commands on PATH):

```bash
flow-epic-manifest-schema --validate .flow/epics/<slug>/manifest.json
flow-epic-dag --validate .flow/epics/<slug>/manifest.json
```

`--validate` is a flag whose value is the path that follows it. Exit 0 =
valid (prints `{"ok":true}`); non-zero = invalid (the reason / offending
cycle or edge is on stderr; a cycle prints e.g.
`dependency cycle: a -> b -> a`).

**On ANY non-zero exit from EITHER validator: re-cut the decomposition,
re-emit both artifacts, and re-validate — in a loop — until BOTH exit 0.**
A non-zero exit is a methodology bug to fix (a cycle means extract the
shared dependency into its own upstream feature or merge the two; an orphan
edge means a `dependsOn` names a feature that does not exist — fix the id or
add the feature). **NEVER surface a failing manifest as a result.** The
designer stops only once both validators exit 0.

## 7. Return a brief summary

Return a one-paragraph summary (3–5 sentences): the epic's intent in one
line, the number of features in the DAG, the walking-skeleton root, and the
top one or two assumptions the user should pay attention to at the approval
checkpoint. Do not paste the full `design.md` or manifest back — the
artifacts on disk are the record.

# Verification

Before returning, self-check:

- `design.md` exists at `.flow/epics/<slug>/design.md` with all six section
  headings (`## 1. Problem & intent` … `## 6. Open Questions`).
- `manifest.json` exists at `.flow/epics/<slug>/manifest.json`, is internally
  consistent with `design.md` (same ids/titles/edges), and **both**
  `flow-epic-manifest-schema --validate` and `flow-epic-dag --validate` exit
  0 against it.
- Every feature is a vertical slice with a self-contained `description`,
  every `dependsOn` edge names a produced/consumed artifact, and there is a
  walking-skeleton root.
- Every assumption made under ambiguity is surfaced in Open Questions.

# Constraints

- NEVER ask the user clarifying questions — the Task tool is one-shot. The
  materiality-gated clarification round of `02` §3 belongs to F5's
  `flow epic create` caller, not this designer; residual ambiguity goes to
  Open Questions.
- NEVER surface a manifest that fails either validator. The §6 loop is the
  load-bearing correctness gate; re-cut and re-validate until both exit 0.
- NEVER decompose into horizontal layers or vibe edges. Vertical slices and
  produced/consumed edges only (§4c).
- NEVER launch, schedule, watch, or merge anything. The designer produces
  `design.md` + `manifest.json` and stops; orchestration is the deferred,
  out-of-scope phase.
