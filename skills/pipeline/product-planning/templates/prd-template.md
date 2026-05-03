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

| Before | After |
|---|---|
| `flow install` | `flow setup` |
| `flow add "<desc>"` | `flow new "<desc>"` |

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

| Aspect | Decision |
|---|---|
| Layers touched | [DB / proxy / domain / store / UI] |
| Domain modules | [existing involved + any new] |
| Data flow | [CRUD entity / external via proxy / computed] |
| Pattern | [existing pattern name, or justification for new] |

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
