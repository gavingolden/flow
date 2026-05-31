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

## Interaction / UX

**10 Usability Heuristics for UI Design** — Nielsen Norman Group / Jakob Nielsen.
https://www.nngroup.com/articles/ten-usability-heuristics/
Why trusted: the field's most cited interaction-design baseline (1994, revised 2024) — ten heuristics covering system-status visibility, match to the real world, user control and freedom, consistency and standards, error prevention, recognition over recall, flexibility and efficiency, aesthetic and minimalist design, error recovery, and help and documentation. The backbone of this skill's interaction reference.

## Accessibility

**WCAG 2.2** — W3C / Web Accessibility Initiative.
https://www.w3.org/WAI/standards-guidelines/wcag/
Why trusted: the global accessibility standard, organized under the four POUR principles (Perceivable, Operable, Understandable, Robust) with conformance levels A / AA / AAA. AA is the practical target most products are held to, including by law in many jurisdictions. The normative authority for the accessibility reference.

**WAI-ARIA Authoring Practices Guide (APG)** — W3C / Web Accessibility Initiative.
https://www.w3.org/WAI/ARIA/apg/
Why trusted: the W3C's pattern-level guidance on keyboard interaction, roles/states/properties, accessible names, and landmark regions, and the source of the "semantic structure first; no ARIA is better than bad ARIA" discipline. Pairs with WCAG to turn principle into pattern.
