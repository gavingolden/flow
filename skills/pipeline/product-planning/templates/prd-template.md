<!-- Style: terse. Tables for comparison, diagrams for flow. Cut prose that a
     heading + list could replace. Markdown is structure; structure is legibility. -->

# [Feature Name]

## Problem Statement

<!-- The pain, not the fix. Avoid "we need a button that…". -->

[What problem does this solve? Why does it matter? Who is affected?]

## Scope Boundary

<!-- State what's NOT in. Mention v2 only if it's likely. -->

**In scope:** [what this feature covers]

**Out of scope:** [what this feature does NOT cover]

## User-Facing Changes

<!-- What someone running the tool sees or does differently. Before/After
     table for CLI / flag / output / file-location deltas. Write `none` for
     pure-internal changes (refactor, infra) — never omit the heading. -->

| Before              | After                          |
| ------------------- | ------------------------------ |
| `flow install`      | `flow install`                 |
| `flow add "<desc>"` | `flow feature create "<desc>"` |

## User Stories / Acceptance Criteria

<!-- Each story: 2–5 testable Given/When/Then. More than 5 ⇒ split. -->

### Story 1: [Short Description]

- [ ] Given [precondition], when [action], then [expected result]
- [ ] Given [precondition], when [action], then [expected result]

### Story 2: [Short Description]

- [ ] …

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

- [Framework, security, performance, architectural]
- [e.g. "RLS must restrict to dashboard owners"]

## Task Breakdown

<!-- Layer order: DB → types → proxy → domain → store → UI → wiring → tests.
     One task = 1–3 files in one domain area. Split if it crosses runtimes. -->

### Task 1: [Short Title]

- **Skill:** `skill-name`
- **Description:** What to implement
- **Inputs:** What must exist first
- **Outputs:** What this produces
- **Acceptance:** How to verify

### Task 2: [Short Title]

- …

<!-- For >3 tasks, add a dependency table or short Mermaid graph:
     | Task | Depends on |
     |---|---|
     | 1 | — |
     | 2 | 1 |
-->

## Open Questions

<!-- Mark resolved with a decision note so context is preserved. -->

- [ ] [Anything still unresolved before implementation]

## Recommendation

<!-- Always present (unlike the omit-when-empty sections). One line: verdict +
     one-line rationale. Verdict enum and the full contract live in
     skills/pipeline/product-planning/references/discovery-instructions.md
     "Recommendation" — the single source of truth. Do NOT inline the enum
     gloss here; this is a thin sketch. -->

**[Proceed | Reconsider scope | Defer | Reject — do nothing]** — [one-line rationale; reference an Open Question when the verdict is not Proceed]

## Plan risks

<!-- Always present (unlike the omit-when-empty sections). One line: the plan's
     single weakest assumption / biggest risk — adversarial self-critique ("if
     this plan is wrong, here is the most likely reason"), not a restatement of
     Open Questions. Modeled on ## Recommendation. Full always-present/single-line
     contract lives in
     skills/pipeline/product-planning/references/discovery-instructions.md
     "Plan risks" — the single source of truth. Do NOT inline the contract here;
     this is a thin sketch. -->

[one line naming the single weakest assumption / biggest risk whose failure would most likely sink the plan]

## Prompt interpretation

<!-- Conditional: include this section ONLY when the user's prompt names BOTH
     prescribed methods (numbered list, explicit enumeration) AND a quantitative
     target (a number with units, "<800 lines", "≤100ms"). Otherwise omit the
     heading entirely. Placement matches the PRD-section list at
     skills/pipeline/product-planning/references/discovery-instructions.md
     section 5 (last section, after Recommendation) — the single source of
     truth for ordering. Full contract — trigger, three required subsections, the
     four-value Recommended-path enum, and the Open-Questions emission rule:
       skills/pipeline/product-planning/references/discovery-instructions.md
       "Prompt interpretation (conditional)"
     Do NOT inline the enum or anti-pattern list here; this template is a thin
     sketch and the upstream reference is the single source of truth. -->

- **Reading of prescribed methods:** [`exhaustive` | `starting points`]
- **Plausibility estimate:** [your honest read on whether the named methods reach the target, with evidence]
- **Recommended path:** [one of four enum values; see discovery-instructions.md for the verbatim strings]
<!-- Machine-parsed by bin/flow-step3-route.ts: keep this exact one-line form (colon, value on the SAME line). Do not reformat to a label-on-its-own-line shape. -->
