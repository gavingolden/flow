# Pre-submit critique protocol

A stack-neutral quality gate to run *before* declaring UI work done. It is a 30–60 second review, not a redesign — walk the dimensions, find the one to three highest-impact fixes, apply them, and move on. Each dimension is anchored to a named source; canonical URLs live in `sources.md`. A stack skill instantiates these checks with its own concrete examples (class names, tokens); this is the portable reasoning behind them.

## Dimensions

**Composition and craft** (Refactoring UI; Anthropic coherence). Do typography, color, layout, and imagery cohere into one intentional whole, or do they read as independently-chosen pieces? Can you identify primary, secondary, and tertiary content at a glance? Does spacing vary with relationship, or is one gap value applied everywhere? Do adjacent surfaces differ where they should, and does every border earn its place? Coherence across these axes is the design-quality signal Anthropic names; the individual moves are in `visual-design.md`.

**Interaction** (Nielsen-heuristic spot-check). Does every action get visible feedback (status visibility)? Is there a clear exit / undo from every flow (user control)? Do empty, loading, and error states exist and say something useful (error recovery)? Are inputs labelled and errors placed next to their field? See `interaction-ux.md` for the full ten.

**Accessibility** (WCAG POUR / AA spot-check). Is everything keyboard-operable with a visible focus order (Operable)? Does text meet AA contrast, and does meaning survive without color (Perceivable)? Is the structure semantic — real headings, landmarks, accessible names on interactive elements (Robust)? See `accessibility.md`.

**Distinctiveness** (the convergent-default check). Name one specific, non-default choice you made on this screen. If you can't — if another AI given the same prompt would produce the same output — the work is AI slop and the design isn't done. This is the anti-default stance from `visual-design.md`, applied as a gate.

## Common anti-patterns

Stated without framework-specific class names; the stack skill carries the concrete instantiations.

- **The identical-container problem.** Every container shares the same surface, padding, border, and radius. Vary them by content importance so the layout's structure is visible.
- **The missing-hierarchy problem.** All text reads at one size and weight. If squinting flattens everything to a single plane, add real size/weight/contrast levels.
- **The uniform-spacing problem.** One gap value applied everywhere flattens the information architecture. Tighten spacing for related items, widen it between unrelated sections.
- **The flat dark-mode problem.** Every surface uses one fill in dark mode, so elevation disappears. Make elevated surfaces lighter; rely on surface-color difference where shadows are weak.
- **The decorative-border problem.** Borders added "to look defined" become noise. Keep borders only where they separate something; prefer surface and spacing differences otherwise.

## Pre-submit workflow

1. **Build** the UI following the skill's instructions.
2. **Pause** — do not submit yet.
3. **Walk the four dimensions** above, scoring each mentally.
4. **Identify** the one to three highest-impact fixes — missing hierarchy and identical surfaces usually top the list; not everything needs fixing.
5. **Apply** those fixes.
6. **Verify across modes** — if the UI has light and dark (or other) themes, confirm hierarchy and contrast hold in each.
7. **Name one non-default choice** you made. If you can't, return to the design-intent step and reconsider.
