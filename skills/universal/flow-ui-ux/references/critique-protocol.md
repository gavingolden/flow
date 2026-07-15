# Pre-submit critique protocol

A stack-neutral quality gate to run _before_ declaring UI work done. It is a 30–60 second review, not a redesign — walk the dimensions, find the one to three highest-impact fixes, apply them, and move on. Each dimension is anchored to a named source; canonical URLs live in `sources.md`. A stack skill instantiates these checks with its own concrete examples (class names, tokens); this is the portable reasoning behind them.

## Dimensions

**Composition and craft** (Refactoring UI; Anthropic coherence). Do typography, color, layout, and imagery cohere into one intentional whole, or do they read as independently-chosen pieces? Can you identify primary, secondary, and tertiary content at a glance? Does spacing vary with relationship, or is one gap value applied everywhere? Do adjacent surfaces differ where they should, and does every border earn its place? Coherence across these axes is the design-quality signal Anthropic names; the individual moves are in `visual-design.md`. When the work spans more than one component, extend this check across the set: each component should match the shared foundation (the skill's foundation step) and its sibling components — same scales, roles, surfaces, and treatments — not merely cohere on its own.

**Layout and composition** (the spatial-composition spine; see `layout.md`). Is there a grid or alignment spine the elements snap to, or are things placed by eye? Does grouping mirror relationships — proximity, common region, and similarity binding what belongs together (Gestalt)? Is primary content width constrained and centered rather than full-bleed or jammed to an edge? Does the chosen layout archetype (holy-grail, sidebar, split, dashboard/card grid) fit the content, or has the screen defaulted to a centered card? This is the specific spatial check that `Composition and craft` above assumes but does not enumerate — the home for the janky/ungridded-layout failure mode.

**Interaction** (Nielsen-heuristic spot-check). Does every action get visible feedback (status visibility)? Is there a clear exit / undo from every flow (user control)? Do empty, loading, and error states exist and say something useful (error recovery)? Are inputs labelled and errors placed next to their field? See `interaction-ux.md` for the full ten.

**Component-state completeness** (per-control contract; see `component-interaction.md`). Does every interactive control express the states its situation demands — loading, disabled, and focus at minimum? Is double-submission prevented by disabling the control in flight on submit (rather than disabling it until the form is valid)? Are response-time expectations met — feedback under 0.1s for direct manipulation, a determinate indicator past ~10s? This is the component-level operationalization of status visibility and error prevention.

**Accessibility** (WCAG POUR / AA spot-check). Is everything keyboard-operable with a visible focus order (Operable)? Does text meet AA contrast, and does meaning survive without color (Perceivable)? Is the structure semantic — real headings, landmarks, accessible names on interactive elements (Robust)? Do interactive targets meet the 24px AA floor (WCAG 2.5.8), and do standalone controls reach the 44px comfort target — or is the trade-off named (Operable)? See `accessibility.md`.

**Distinctiveness** (the convergent-default check). Name one specific, non-default choice you made on this screen. If you can't — if another AI given the same prompt would produce the same output — the work is AI slop and the design isn't done. This is the anti-default stance from `visual-design.md`, applied as a gate.

## Common anti-patterns

Stated without framework-specific class names; the stack skill carries the concrete instantiations.

- **The identical-container problem.** Every container shares the same surface, padding, border, and radius. Vary them by content importance so the layout's structure is visible.
- **The missing-hierarchy problem.** All text reads at one size and weight. If squinting flattens everything to a single plane, add real size/weight/contrast levels.
- **The uniform-spacing problem.** One gap value applied everywhere flattens the information architecture. Tighten spacing for related items, widen it between unrelated sections.
- **The flat dark-mode problem.** Every surface uses one fill in dark mode, so elevation disappears. Make elevated surfaces lighter; rely on surface-color difference where shadows are weak.
- **The decorative-border problem.** Borders added "to look defined" become noise. Keep borders only where they separate something; prefer surface and spacing differences otherwise.
- **The divergent-siblings problem.** Components designed in isolation each pick their own spacing scale, type ramp, or elevation model, so the set reads as assembled from different products. Anchor every component to the shared foundation rather than re-deciding it per screen — this is the failure mode that parallel, per-component work invites if no foundation was frozen first.
- **The ungridded-layout problem.** Elements are placed by eye with no grid or alignment spine, and the screen falls back to a single cookie-cutter centered arrangement regardless of the content. Decide a grid first, group with proximity and common region, and pick an archetype that fits the content (`layout.md`).
- **The stateless-control problem.** An interactive control ships with no loading, disabled, or focus state, and a submit button can be double-fired because nothing disables it while the request is in flight. Express the states the control demands and disable-on-submit to prevent double-submission (`component-interaction.md`).

## Pre-submit workflow

1. **Build** the UI following the skill's instructions.
2. **Pause** — do not submit yet.
3. **Walk the six dimensions** above — composition and craft, layout and composition, interaction, component-state completeness, accessibility, and distinctiveness — scoring each mentally.
4. **Identify** the one to three highest-impact fixes — missing hierarchy, an ungridded layout, identical surfaces, and stateless controls usually top the list; not everything needs fixing.
5. **Apply** those fixes.
6. **Verify across modes** — if the UI has light and dark (or other) themes, confirm hierarchy and contrast hold in each.
7. **Name one non-default choice** you made. If you can't, return to the design-intent step and reconsider.

When the input is a **captured a11y snapshot + screenshot** rather than live code (the `/flow-pr-review` Step 8c review path), treat the snapshot as the primary medium for the accessibility, structure, and component-state dimensions and the screenshot as the supplementary medium for the composition and layout dimensions — walk the same six dimensions above against what was captured.
