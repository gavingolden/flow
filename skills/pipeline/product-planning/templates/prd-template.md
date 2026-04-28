# [Feature Name]

## Problem Statement

<!-- Explain the user's pain point and why it matters to the product. Focus on the problem,
     not the solution. Avoid "we need a button that..." — instead explain what users can't
     do today and why that matters.
     Bad: "We need a share button on dashboards."
     Good: "Users have no way to show their dashboards to colleagues who don't have accounts,
     limiting the product's utility for team collaboration." -->

[What problem does this solve? Why does it matter? Who is affected?]

## Scope Boundary

<!-- Explicitly state what is NOT included. This prevents scope creep and gives the implementer
     clear limits. If a v2 is likely, mention what it might add — but keep it brief. -->

**In scope:** [What this feature covers]

**Out of scope:** [What this feature does NOT cover, even if related]

## User Stories / Acceptance Criteria

<!-- Each story should have 2-5 Given/When/Then criteria. If a story needs more than 5,
     it's probably two stories. Criteria must be testable — avoid "works correctly" or
     "looks good". Reference actual project concepts: dashboards, expressions, graphs,
     data sources. -->

### Story 1: [Short Description]

- [ ] Given [precondition], when [action], then [expected result]
- [ ] Given [precondition], when [action], then [expected result]

### Story 2: [Short Description]

- [ ] ...

## Architecture Decisions

<!-- State which layers this feature touches and why. Name the existing patterns being followed.
     If introducing a new pattern, justify why existing patterns don't fit. Load
     references/architecture-patterns.md if you need to verify which pattern applies. -->

- **Layers touched:** [DB / Go proxy / Domain model / Domain store / UI]
- **Domain modules:** [Which existing modules are involved, any new ones needed]
- **Data flow:** [Which data flow pattern — CRUD entity, external data via proxy, or computed]
- **Pattern:** [Existing pattern being followed, or justification for a new one]

## Technical Constraints

- [Framework, security, performance, or architectural constraints]
- [e.g., "RLS must enforce that only dashboard owners can manage this"]
- [e.g., "Must follow the existing Go proxy pattern per `data-provider` skill"]

## Task Breakdown

<!-- Tasks should follow the layer ordering: DB migration → Go proxy → Domain model →
     Domain store → UI components → Integration wiring → Tests.
     Each task should touch 1-3 files in one domain area. If a task spans Go and TypeScript,
     split it. Always list the skill directory before assigning skills. -->

### Task 1: [Short Title]

- **Skill:** `skill-name`
- **Description:** What to implement
- **Inputs:** What must exist before this task starts
- **Outputs:** What this task produces
- **Acceptance criteria:** How to verify it's done

### Task 2: [Short Title]

- **Skill:** `skill-name`
- **Description:** ...
- **Inputs:** ...
- **Outputs:** ...
- **Acceptance criteria:** ...

## Open Questions

<!-- Anything still unresolved. Mark resolved questions with a decision note so the context
     is preserved. -->

- [ ] [Anything still unresolved that needs user input before implementation]
