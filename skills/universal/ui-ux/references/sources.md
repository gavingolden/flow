# Sources

The authoritative references this skill's judgment traces back to. Each judgment reference (`visual-design.md`, `interaction-ux.md`, `accessibility.md`, `critique-protocol.md`) names its primary source inline by name; this file is the single place the canonical URL and the one-line "why trusted" rationale live, so links are maintained in one spot.

Grouped by strand: framing, visual design, interaction/UX, accessibility. Cite and link only — none of these entries reproduces the source's copyrighted text.

## Framing — why this skill exists

**Improving frontend design through Skills** — Anthropic.
https://claude.com/blog/improving-frontend-design-through-skills
Why trusted: the originating engineering account of the "convergent defaults" / "AI slop" failure mode this skill counters, and of the method (name the default, offer a concrete alternative, pitch guidance at the right altitude, make it reusable as a Skill). First-party and directly on point.

**Prompting for frontend aesthetics** (Claude Cookbook) — Anthropic.
https://platform.claude.com/cookbook/coding-prompting-for-frontend-aesthetics
Why trusted: first-party, worked guidance on concrete anti-default moves — avoid generic system fonts, take real weight and size jumps, choose a dominant color with sharp accents over a timid even palette, build depth instead of flat fills, orchestrate one high-impact motion moment. The applied companion to the framing piece above.

**The Aesthetic-Usability Effect** — Nielsen Norman Group / Kate Moran.
https://www.nngroup.com/articles/aesthetic-usability-effect/
Why trusted: research-backed account of why aesthetics and usability reinforce rather than oppose each other — users perceive attractive interfaces as more usable and tolerate minor friction. Grounds the skill's stance that polish and function are one goal, not a trade-off. NNG is the field's primary usability-research authority.

## Visual design

**Refactoring UI** — Adam Wathan & Steve Schoger.
https://www.refactoringui.com/
Why trusted: the most widely-adopted practical text on visual-design tactics for engineers — hierarchy through size/weight/contrast rather than labels, spacing systems and avoiding ambiguous gaps, type scales, restrained palettes with enough shades, shadows and layering for depth, fewer borders. Tactics over talent, which is exactly the register this skill needs.

**Material Design 3 — Foundations** — Google.
https://m3.material.io/foundations
Why trusted: a mature, broadly-implemented design system whose foundations articulate layout directing attention, color as connective tissue with defined roles, typographic hierarchy and line-height, interaction states, and accessible-by-default design. Corroborated via an `m3.material.io`-scoped search because the live page is client-rendered and returned only a title to a direct fetch — the cited foundations are attributable, not invented.

**Human Interface Guidelines** — Apple.
https://developer.apple.com/design/human-interface-guidelines
Why trusted: decades of platform-interaction convention distilled into the three pillars Clarity, Deference, and Depth — the interface supports the content rather than competing with it, legibility holds at every size, and layers plus motion convey hierarchy. Corroborated via a `developer.apple.com`-scoped search because the live page is client-rendered and returned only a title to a direct fetch — the three pillars are attributable, not invented.

## Layout / composition

**Layout (Foundations)** — Material Design 3 / Google.
https://m3.material.io/foundations/layout/understanding-layout/overview
Why trusted: a mature, broadly-implemented design system whose layout foundations articulate the responsive column grid (columns, gutters, margins) and how regions adapt across window-size classes. Grounds the grid/column-system principle in `layout.md`.

**Spacing** — Material Design 3 / Google.
https://m3.material.io/styles/spacing/overview
Why trusted: the spacing foundation that builds layout rhythm on an 8px base unit with a 4px sub-unit — the primary system citation behind the 8-point spacing _convention_ (encoded in `layout.md` as a convention, not a formal standard).

**The 2x Grid** — IBM Carbon Design System / IBM.
https://carbondesignsystem.com/guidelines/2x-grid/overview/
Why trusted: a production enterprise design system whose 2x Grid documents a strict, mathematically-derived responsive column grid; a second primary source for "decide the grid first, then place content on it."

**Layout** — GOV.UK Design System / Government Digital Service.
https://design-system.service.gov.uk/styles/layout/
Why trusted: a government-grade, accessibility-first design system that treats page structure and layout as foundational styles; corroborates the column-grid and page-structure guidance from a public-sector authority held to legal accessibility requirements.

**Layout** — Apple Human Interface Guidelines / Apple.
https://developer.apple.com/design/human-interface-guidelines/layout
Why trusted: Apple's platform guidance on alignment, margins, and using a consistent layout to create visual order — the named source for the alignment / active-whitespace principle in `layout.md`.

**Every Layout** — Heydon Pickering & Andy Bell.
https://every-layout.dev/
Why trusted: the most rigorous practitioner treatment of intrinsic, algorithm-driven CSS layouts (components that respond to their own available space rather than global breakpoints); the authority behind the intrinsic-layout and layout-archetype guidance.

**Learn Responsive Design** — web.dev / Google Chrome team.
https://web.dev/learn/design/
Why trusted: Google's maintained course on mobile-first, content-driven breakpoints, container queries, and constrained measure — the named source for the responsive-strategy narrative in `layout.md`.

**Layout patterns** — web.dev / Google Chrome team.
https://web.dev/patterns/layout
Why trusted: a curated gallery of robust, reusable macro-layout patterns (sidebars, grids, holy-grail shells) implemented with modern CSS; backs the layout-archetypes section.

**Gestalt principles** — Interaction Design Foundation (IxDF).
https://www.interaction-design.org/literature/topics/gestalt-principles
Why trusted: the UI-applied interpretation of the academic Gestalt grouping principles (proximity, similarity, common region, continuity, closure, figure/ground) whose perceptual-psychology origin traces to Wertheimer, Koffka, and Köhler. IxDF is a recognized design-education authority; named for the UI mapping, with the academic origin attributed inline.

**F-Shaped Pattern for Reading Web Content** — Nielsen Norman Group.
https://www.nngroup.com/articles/f-shaped-pattern-reading-web-content/
Why trusted: the primary eye-tracking source for the F-pattern — including NNG's own caveat that the F is a symptom of weak hierarchy on text-heavy pages, as much to design against as to exploit. Grounds the reading-patterns section and its medium-confidence caveat.

**How People Read Online: The Eyetracking Evidence (layer-cake / scanning)** — Nielsen Norman Group.
https://www.nngroup.com/articles/how-users-read-on-the-web/
Why trusted: NNG's eye-tracking account of scanning behavior including the layer-cake pattern (eyes jumping between headings and subheadings); corroborates the scannable-headings guidance.

## Interaction / UX

**10 Usability Heuristics for UI Design** — Nielsen Norman Group / Jakob Nielsen.
https://www.nngroup.com/articles/ten-usability-heuristics/
Why trusted: the field's most cited interaction-design baseline (1994, revised 2024) — ten heuristics covering system-status visibility, match to the real world, user control and freedom, consistency and standards, error prevention, recognition over recall, flexibility and efficiency, aesthetic and minimalist design, error recovery, and help and documentation. The backbone of this skill's interaction reference.

**Response Times: The 3 Important Limits** — Nielsen Norman Group / Jakob Nielsen.
https://www.nngroup.com/articles/response-times-3-important-limits/
Why trusted: the canonical web codification of the 0.1s / 1.0s / 10s perception thresholds. The thresholds originate with Robert B. Miller (1968) and were reinforced by Card, Robertson & Mackinlay (1991); `component-interaction.md` attributes them to Miller and encodes them as perception thresholds distinct from modern web-performance metrics (medium confidence on the "still the current web standard" framing).

**Progress Indicators Make a Slow System Less Insufferable** — Nielsen Norman Group.
https://www.nngroup.com/articles/progress-indicators/
Why trusted: NNG's primary guidance on when to show a spinner versus a determinate progress bar by wait length; backs the loading-indicator selection rule.

**Skeleton Screens 101** — Nielsen Norman Group.
https://www.nngroup.com/articles/skeleton-screens/
Why trusted: the research account of skeleton screens for initial loads (bridging the gulf of evaluation by showing the awaited layout); named for the initial-load loading pattern.

**Confirmation Dialogs Can Prevent User Errors — But Are Often Misused** — Nielsen Norman Group.
https://www.nngroup.com/articles/confirmation-dialog/
Why trusted: the source for "a salient Undo beats a confirmation dialog" and for reserving confirmation for catastrophic/irreversible actions, grounded in dialog-fatigue research. Backs the destructive-action section.

**Interaction states (Foundations)** — Material Design 3 / Google.
https://m3.material.io/foundations/interaction-states
Why trusted: the design-system definition of the interactive state set (enabled, hover, focus, pressed, dragged, disabled) modeled as systematic state layers; the primary citation for the interactive-state-model section.

**Snackbar** — Material Design 3 / Google.
https://m3.material.io/components/snackbar/guidelines
Why trusted: the system guidance on snackbar dwell time and on never placing critical or interactive-only content in an auto-dismissing surface; paired with WCAG 2.2.1 for the toast section.

**Button — disabled buttons** — GOV.UK Design System / Government Digital Service.
https://design-system.service.gov.uk/components/button/#disabled-buttons
Why trusted: the explicit public-sector standard advising _against_ disabling submit buttons (they fail contrast, are undiscoverable by keyboard, and give no reason); the named authority for the disable-on-submit-good / disable-until-valid-discouraged stance.

**Button states** — IBM Carbon Design System / IBM.
https://carbondesignsystem.com/components/button/usage/#states
Why trusted: a second production design-system source enumerating the per-state button contract; corroborates the interactive-state-model section.

**Inline Validation in Web Forms** — Smashing Magazine.
https://www.smashingmagazine.com/2022/09/inline-validation-web-forms-ux/
Why trusted: a widely-cited practitioner article for the "reward early, punish late" inline-validation timing (error on blur, clear on keyup). Blog-grade, not a formal standard — `component-interaction.md` encodes it at medium confidence.

**Understanding SC 2.2.1: Timing Adjustable** — W3C / Web Accessibility Initiative.
https://www.w3.org/WAI/WCAG22/Understanding/timing-adjustable.html
Why trusted: the normative WCAG 2.2 understanding document requiring that users can turn off, adjust, or extend time limits — the accessibility floor that forbids auto-dismissing toasts from carrying critical or interactive-only content.

## Accessibility

**WCAG 2.2** — W3C / Web Accessibility Initiative.
https://www.w3.org/WAI/standards-guidelines/wcag/
Why trusted: the global accessibility standard, organized under the four POUR principles (Perceivable, Operable, Understandable, Robust) with conformance levels A / AA / AAA. AA is the practical target most products are held to, including by law in many jurisdictions. The normative authority for the accessibility reference.

**WAI-ARIA Authoring Practices Guide (APG)** — W3C / Web Accessibility Initiative.
https://www.w3.org/WAI/ARIA/apg/
Why trusted: the W3C's pattern-level guidance on keyboard interaction, roles/states/properties, accessible names, and landmark regions, and the source of the "semantic structure first; no ARIA is better than bad ARIA" discipline. Pairs with WCAG to turn principle into pattern.
