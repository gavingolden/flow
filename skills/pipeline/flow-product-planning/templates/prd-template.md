<!-- Style: terse. Prefer structured markdown — tables and nested lists — over
     prose paragraphs unless prose is genuinely warranted; flow-shaped content
     (system/user flows, before → after comparisons) is never an arrow-paragraph.
     Cut prose that a heading + list could replace. Mermaid is at the planner's
     discretion, never required. Markdown is structure; structure is legibility. -->

# [Feature Name]

**Goal:** [one outcome-phrased sentence, ≤30 words, naming the observable result]

<!-- Always present, directly under the title. Not a restatement of the title or
     request — names the outcome. Full contract: discovery-instructions.md "Goal line". -->

## Problem Statement

<!-- The pain, not the fix. Avoid "we need a button that…". When the step-3 premise
     check fails, open with a **Premise check:** line naming what was assumed vs.
     what the codebase shows (omit-when-sound — no line when the premise holds),
     and set ## Recommendation to a non-Proceed verdict. -->

[What problem does this solve? Why does it matter? Who is affected?]

## Epic context

<!-- Omit-when-empty: include ONLY when discovery's step 1.7 detects epic
     membership; otherwise omit the heading entirely (never an empty heading).
     Names the epic slug, this feature's id + rationale, its dependsOn edges
     (produced/consumed artifacts), and its downstream dependents. Every claim
     must trace to design.md + manifest.json. Full contract:
     discovery-instructions.md "Epic context" — the single source of truth. -->

Part of epic `[slug]` (feature `[id]`) — design at `.flow/epics/[slug]/design.md`.

- **Role:** [this feature's rationale within the epic decomposition]
- **Depends on:** [feature id — produced/consumed artifact] | none
- **Downstream dependents:** [feature id — interface that must stay stable] | none

## Scope Boundary

<!-- State what's NOT in. Mention v2 only if it's likely. -->

**In scope:** [what this feature covers]

**Out of scope:** [what this feature does NOT cover]

## Behavioral contrast

<!-- Always present. Two subsections showing the observable delta before → after;
     explicit `none` affirmation allowed on either. Closes with a **Lost:** line —
     `none` legitimate ONLY on genuinely additive changes (name anything removed,
     replaced, or deprecated). Full contract: discovery-instructions.md
     "Behavioral contrast" — the single source of truth. Do NOT inline the
     contract here; this is a thin sketch. -->

### User flow

<!-- What someone running the tool sees or does differently. Before/After
     table for CLI / flag / output / file-location deltas. Write `none` for
     pure-internal changes (refactor, infra) — never omit the subsection. -->

| Before              | After                          |
| ------------------- | ------------------------------ |
| `flow install`      | `flow install`                 |
| `flow add "<desc>"` | `flow feature create "<desc>"` |

### System flow

<!-- What changes at the system/consumer level, before → after. Short nested
     list, never an arrow-paragraph. Write `none` for a purely UI-facing change. -->

- **Before:**
  - [system/consumer behavior before]
- **After:**
  - [system/consumer behavior after]

**Lost:** [what a user or downstream consumer gives up | none]

## User Stories / Acceptance Criteria

<!-- Each story: 2–5 testable Given/When/Then. More than 5 ⇒ split. -->

### Story 1: [Short Description]

- [ ] Given [precondition], when [action], then [expected result]
- [ ] Given [precondition], when [action], then [expected result]

### Story 2: [Short Description]

- [ ] …

## Visual Spec

<!-- Omit-when-empty: include ONLY when the request references a design artifact
     (mock URL, artifact HTML path, PDF/image mock) and discovery's design-artifact
     fidelity pre-pass froze `.flow-tmp/design/spec.json`; otherwise omit the heading
     entirely (never an empty heading). Per-surface element-level assertion bullets,
     each tagged with its spec.json assertion id + mechanical/judged tier — every
     mechanical bullet mirrors a spec assertion 1:1. Full contract lives in
     skills/pipeline/flow-product-planning/references/discovery-instructions.md
     "Visual Spec" — the single source of truth. Do NOT inline the contract here;
     this is a thin sketch. -->

### Surface: [name] (`[route]`)

- [`assertion-id`] (mechanical) — `[selector]` renders `[css-prop]: [expected value]`.
- [`assertion-id`] (judged) — [the measured judgment, per the reference snapshot].

## Layout Intent

<!-- Omit this whole section for non-UI plans. Authoring contract: discovery-instructions.md "Layout Intent". Do not inline the contract here. -->

### Surface: [name] ([route])

- **Regions & nesting:** [what regions exist and how they nest]
- **Source order:** [DOM/markup order, independent of visual position]
- **Sizing policy:** [viewport-fill vs intrinsic vs scroll container, per region]
- **Relative positioning:** [what sits above/below/beside what]
- **Responsive breakpoints & reflow:** [breakpoints and what reflows at each]
- **Overflow/sticky/z-order:** [independent scroll, sticky/fixed regions, stacking order]

<!-- Optional topology-only ASCII diagram (not proportion):
```
+----------------------------------+
| header                            |
+----------+-------------------------+
| filters  | results (scroll)        |
+----------+-------------------------+
```
-->

## Architecture Decisions

<!-- Name the existing pattern, or justify a new one. Load
     references/architecture-patterns.md to verify. -->

| Aspect         | Decision                                          |
| -------------- | ------------------------------------------------- |
| Layers touched | [DB / proxy / domain / store / UI]                |
| Domain modules | [existing involved + any new]                     |
| Data flow      | [CRUD entity / external via proxy / computed]     |
| Pattern        | [existing pattern name, or justification for new] |

<!-- Add a Mermaid `flowchart` when data movement spans 3+ layers or branches
     non-obviously. Otherwise the table is enough.
     ```mermaid
     flowchart LR
       UI -->|action| Store --> Proxy --> ExternalAPI

     ```

-->

## Technical Constraints

<!-- Every bullet binding and source-traceable (a named file, rule, or research
     finding) — ambient repo-convention restatements are banned unless the plan
     turns on them. `none beyond repo-wide conventions` is a legitimate explicit
     affirmation. A named performance/cost-implications category (latency, token
     spend, CI time) is emitted only when the change plausibly moves one. -->

- [Binding constraint + its source — a file, rule, or finding]
- [e.g. "RLS must restrict to dashboard owners — see supabase/migrations/0012"]

## Task Breakdown

<!-- Layer order: DB → types → proxy → domain → store → UI → wiring → tests.
     One task = 1–3 files in one domain area. Split if it crosses runtimes. -->

### Task 1: [Short Title]

- **Skill:** `skill-name`
- **Description:** What to implement
- **Inputs:** What must exist first
- **Outputs:** What this produces
- **Contract:**
  - **Files:** [repo-relative paths to create/edit]
  - **Interfaces:** [exact signatures + exported symbols this task decides]
  - **Call-site edits:** [each consumer edit, named as file + symbol]
- **Acceptance criteria:** [runnable command whose exit code verifies the task]

<!-- The Contract block is required on every task. For change types without
     callable boundaries (UI/visual, config/infra, docs/prose, schema),
     substitute the change-type surgical form — the table lives in
     skills/pipeline/flow-product-planning/references/discovery-instructions.md
     step 6 ("Task Breakdown"), the single source of truth. Do NOT inline the
     table here; this is a thin sketch. -->

### Task 2: [Short Title]

- **Skill:** `skill-name`
- **Description:** What to implement
- **Inputs:** What must exist first
- **Outputs:** What this produces
- **Contract:**
  - **Files:** [repo-relative paths to create/edit]
  - **Interfaces:** [exact signatures + exported symbols this task decides]
  - **Call-site edits:** [each consumer edit, named as file + symbol]
- **Acceptance criteria:** [runnable command whose exit code verifies the task]

<!-- Dependency table: REQUIRED whenever ≥2 tasks have dependencies (advisory
     otherwise — still useful for >3 tasks). Table or short Mermaid graph:
     | Task | Depends on |
     |---|---|
     | 1 | — |
     | 2 | 1 |
-->

## Open Questions

<!-- Mark resolved with a decision note so context is preserved. Earns-its-place
     rule: each entry must name what changes on redirect — a question whose every
     answer leaves the plan unchanged is deleted, not written. -->

- [ ] [Anything still unresolved before implementation — name what changes on redirect]

## Decision analysis

<!-- Omit-when-empty: include ONLY when discovery surfaced ≥1 consequential open
     decision whose branches genuinely diverge; otherwise omit the heading entirely
     (never an empty heading). For each such decision: illustrate each branch's
     downstream end-user/system flow, mark exclusive vs complementary, rank the
     viable combinations, give a verdict that feeds ## Recommendation. Full contract
     — omit-when-empty rule, relation to Open Questions, ceremony reconciliation —
     lives in
     skills/pipeline/flow-product-planning/references/discovery-instructions.md
     "Decision analysis" — the single source of truth. Do NOT inline the contract
     here; this is a thin sketch. -->

**Decision [X] — [the forking question]?** [illustrate each branch's downstream flow] [exclusive | complementary] Verdict: **[chosen branch]** — [one-line rationale].

## Alternatives considered

<!-- Omit-when-empty: include ONLY when discovery closed ≥1 plausible path;
     otherwise omit the heading entirely (never an empty heading). ≤3 one-line
     entries; each rejection reason concrete and verifiable (a named constraint
     or file:line pointer, not a vibe). Records CLOSED paths — distinct from
     ## Decision analysis, which records OPEN forks. When non-empty, ALSO write
     a sibling .flow-tmp/excluded-paths.json mirroring each bullet. Full
     contract: discovery-instructions.md "Alternatives considered" — the single
     source of truth. Do NOT inline the contract here; this is a thin sketch. -->

- **[the rejected alternative]** — rejected: [concrete, verifiable why]

## Recommendation

<!-- Always present (unlike the omit-when-empty sections). One line: verdict +
     one-line rationale. Verdict enum and the full contract live in
     skills/pipeline/flow-product-planning/references/discovery-instructions.md
     "Recommendation" — the single source of truth. Do NOT inline the enum
     gloss here; this is a thin sketch. -->

**[Proceed | Reconsider scope | Defer | Reject — do nothing]** — [one-line rationale; reference an Open Question when the verdict is not Proceed]

<!-- Always present. One line: cite the existing capability this request
     duplicates, or state none found. Full contract — the redundancy
     obligation, flow-plan-lint's presence enforcement — lives in
     skills/pipeline/flow-product-planning/references/discovery-instructions.md
     "Recommendation" — the single source of truth. Do NOT inline the
     contract here; this is a thin sketch. -->

**Redundancy:** [cited capability] | none found

## Plan risks

<!-- Always present (unlike the omit-when-empty sections). One line: the plan's
     single weakest assumption / biggest risk — adversarial self-critique ("if
     this plan is wrong, here is the most likely reason"), not a restatement of
     Open Questions. Modeled on ## Recommendation. Full always-present/single-line
     contract lives in
     skills/pipeline/flow-product-planning/references/discovery-instructions.md
     "Plan risks" — the single source of truth. Do NOT inline the contract here;
     this is a thin sketch. -->

[one line naming the single weakest assumption / biggest risk whose failure would most likely sink the plan]

## Prompt interpretation

<!-- Conditional: include this section ONLY when the user's prompt names BOTH
     prescribed methods (numbered list, explicit enumeration) AND a quantitative
     target (a number with units, "<800 lines", "≤100ms"). Otherwise omit the
     heading entirely. Placement matches the PRD-section list at
     skills/pipeline/flow-product-planning/references/discovery-instructions.md
     section 5 (last section, after Recommendation) — the single source of
     truth for ordering. Full contract — trigger, three required subsections, the
     four-value Recommended-path enum, and the Open-Questions emission rule:
       skills/pipeline/flow-product-planning/references/discovery-instructions.md
       "Prompt interpretation (conditional)"
     Do NOT inline the enum or anti-pattern list here; this template is a thin
     sketch and the upstream reference is the single source of truth. -->

- **Reading of prescribed methods:** [`exhaustive` | `starting points`]
- **Plausibility estimate:** [your honest read on whether the named methods reach the target, with evidence]
- **Recommended path:** [one of four enum values; see discovery-instructions.md for the verbatim strings]
<!-- Machine-parsed by bin/flow-step3-route.ts: keep this exact one-line form (colon, value on the SAME line). Do not reformat to a label-on-its-own-line shape. -->

## Candidate follow-up issues

<!-- Omit-when-empty: include ONLY when discovery surfaced ≥1 orthogonal idea worth
     tracking as a separate follow-up (its own user goal/surface, shippable alone);
     otherwise omit the heading entirely (never an empty heading). When step 8 assembles
     the consolidated plan.md this becomes a TOP-LEVEL `# Candidate follow-up issues`
     sibling of `# PRD` / `# Task breakdown` (h1) — the h2 here matches the template's
     rhythm. Two parts in order: a MANDATORY value-vs-complexity ranking table, then the
     machine-readable `- [ ]` list (flow-candidate-issues parses ONLY the `- [ ]` lines).
     The `Pull into this pipeline?` column is plain Yes/No text, NEVER a checkbox. Full
     contract — ranking-table mandate, the Recommendation verdict-line rule for a
     high-value + trivial-complexity candidate, and the follow-up-reference consistency
     rubric — lives in
     skills/pipeline/flow-product-planning/references/discovery-instructions.md
     "Candidate follow-up issues (optional)" — the single source of truth. Do NOT inline
     the contract here; this is a thin sketch.
     Columns (exact, keep verbatim): Candidate | Value | Complexity | Rationale | Pull into this pipeline? -->

| Candidate         | Value             | Complexity                   | Rationale      | Pull into this pipeline? |
| ----------------- | ----------------- | ---------------------------- | -------------- | ------------------------ |
| [orthogonal idea] | [High/Medium/Low] | [Trivial/Small/Medium/Large] | [one-line why] | [Yes/No]                 |

- [ ] [orthogonal idea] — [one-line body; the machine-readable candidate the post-merge sweep files]
