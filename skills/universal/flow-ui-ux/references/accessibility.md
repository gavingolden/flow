# Accessibility

Portable accessibility judgment, structured on the four WCAG 2.2 POUR principles — Perceivable, Operable, Understandable, Robust — and the W3C WAI-ARIA Authoring Practices Guide (APG). Named inline for traceability; canonical URLs live in `sources.md`. WCAG conformance level AA is the practical target this skill holds work to. The framework that emits a focus ring or a landmark element is the stack skill's job — what follows is _what must be true_ of the result.

## Perceivable (WCAG POUR)

Users must be able to perceive the information regardless of sense or assistive technology.

- Provide text alternatives for non-text content — every meaningful image, icon, and chart needs an accessible description; purely decorative graphics are marked so assistive tech can skip them.
- Meet color-contrast targets. Treat WCAG AA contrast as the practical floor for text against its background, and verify it rather than eyeballing it.
- Never rely on color alone to convey meaning. Pair color with a label, icon, shape, or text so a status or distinction survives for users who can't perceive the hue (WCAG: use of color).
- Reflow without loss (WCAG 2.2 success criterion **1.4.10 Reflow**): content must reflow to a single column at a 320px CSS width — equivalent to a 400% zoom of a 1280px viewport — with no loss of content or functionality and **no two-dimensional / horizontal scrolling** to read it. Verify the narrowest width directly: text wraps rather than truncating, and nothing overflows the viewport horizontally. This is the accessibility floor the responsive-layout judgment dimension and the per-viewport mechanical overflow assertion both enforce.

## Operable (WCAG POUR)

The interface must be fully operable by everyone, not only by mouse or touch.

- Everything reachable and actuable by pointer must be reachable and actuable by keyboard alone — no functionality is mouse-only.
- Focus is always visible, and focus order follows a logical reading sequence. Manage focus deliberately when content appears or disappears: move focus into a newly opened dialog, return it sensibly on close (APG keyboard-interaction patterns).
- No keyboard traps. The user can move focus away from any component with the keyboard alone.

### Touch-target size (WCAG 2.5.8 / 2.5.5)

Every pointer-actuable target must meet a minimum interactive area. Two thresholds apply at different conformance levels.

**AA floor — WCAG 2.5.8 (Target Size Minimum):** The total interactive area (bounding box, including padding) must be at least 24×24 CSS px. The main exception: if a 24px-diameter circle centered on the target does not intersect any neighboring target, the spacing itself satisfies the criterion. Additional narrow exemptions exist for inline-in-text links, user-agent-default controls, and essential-presentation constraints — but do not treat any small button as automatically exempt without checking which exemption applies.

**Comfort target — WCAG 2.5.5 (Target Size Enhanced, AAA) / Apple HIG / Material Design:** For standalone interactive controls — buttons, icon buttons, toggles, checkboxes — aim for at least 44×44 CSS px. Apple HIG specifies 44pt; Material Design 3 recommends a 48dp minimum touch target. These authorities converge near this range because human thumb contact area does not vary with display density. A target at or above 44px passes all three standards.

**How to measure:** Count the total pointer-actuable region, including padding — not the visible glyph or label. A 16px icon with 12px padding on each side produces a 40×40px target: it passes the 24px AA floor but falls short of the 44px comfort target. Use the browser's computed box model (devtools → element → Computed) to measure the interactive dimensions, not the rendered visual size.

**Dense data-table and inline exceptions:** Rows in a data table, links inline within prose, and tightly-packed toolbar controls may fall below 44px when content density is the feature. Even in these contexts the WCAG 2.5.8 AA floor still applies — check that vertical or horizontal spacing between interactive elements satisfies the 24px spacing exception rather than assuming exemption.

**Defect vs. acceptable trade-off:**

- Below 24px with no applicable exception: **AA defect** — must be fixed.
- 24–43px: AA-compliant, below the comfort target — classify as a **comfort gap** and flag as a usability risk on touch viewports (higher mis-tap rate, ergonomic burden). Name the trade-off explicitly and justify it in context; do not silently accept it.
- 44px and above: passes all thresholds — no finding.

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
