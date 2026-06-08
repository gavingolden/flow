# Accessibility

Portable accessibility judgment, structured on the four WCAG 2.2 POUR principles — Perceivable, Operable, Understandable, Robust — and the W3C WAI-ARIA Authoring Practices Guide (APG). Named inline for traceability; canonical URLs live in `sources.md`. WCAG conformance level AA is the practical target this skill holds work to. The framework that emits a focus ring or a landmark element is the stack skill's job — what follows is _what must be true_ of the result.

## Perceivable (WCAG POUR)

Users must be able to perceive the information regardless of sense or assistive technology.

- Provide text alternatives for non-text content — every meaningful image, icon, and chart needs an accessible description; purely decorative graphics are marked so assistive tech can skip them.
- Meet color-contrast targets. Treat WCAG AA contrast as the practical floor for text against its background, and verify it rather than eyeballing it.
- Never rely on color alone to convey meaning. Pair color with a label, icon, shape, or text so a status or distinction survives for users who can't perceive the hue (WCAG: use of color).

## Operable (WCAG POUR)

The interface must be fully operable by everyone, not only by mouse or touch.

- Everything reachable and actuable by pointer must be reachable and actuable by keyboard alone — no functionality is mouse-only.
- Focus is always visible, and focus order follows a logical reading sequence. Manage focus deliberately when content appears or disappears: move focus into a newly opened dialog, return it sensibly on close (APG keyboard-interaction patterns).
- No keyboard traps. The user can move focus away from any component with the keyboard alone.

## Understandable (WCAG POUR)

Information and operation must be predictable and clear.

- Behavior is predictable: interacting with a component doesn't trigger a surprising context change, and the same control behaves the same way throughout.
- Errors are identified in text, described clearly, and paired with guidance on how to fix them (this is the WCAG side of "help users recover from errors").
- Honor reduced-motion as a principle: when a user signals they prefer reduced motion, suppress or soften non-essential animation rather than overriding their preference.

## Robust (WCAG POUR)

Content must work reliably across browsers, devices, and assistive technologies — now and as they evolve.

- Use semantic structure first: real headings in a sensible order, lists for lists, buttons for actions, landmark regions (main, navigation, etc.) so assistive tech can navigate the page's shape (APG).
- Every interactive element has an accessible name that conveys its purpose — an icon-only control without a name is invisible to a screen reader.

## The ARIA discipline (APG)

Semantic HTML first. Native elements carry roles, states, and keyboard behavior for free; reach for ARIA only when no native element expresses what you need. The APG's guiding rule: no ARIA is better than bad ARIA — an incorrect role or a stale state is worse than none, because it actively misleads assistive technology. When you do add ARIA, you own the keyboard interaction and the states that go with the pattern.
