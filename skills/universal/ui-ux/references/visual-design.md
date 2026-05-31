# Visual design

Portable visual-design judgment — hierarchy, spacing, surface and depth, typography, color, and the anti-default stance. Every principle here is stated stack-neutrally; the framework that renders it (CSS tokens, utility classes, native styles) is the stack skill's job. Canonical URLs and "why trusted" lines live in `sources.md`.

## The anti-default stance

The core test: if another AI, given the same prompt, would produce the same output, you failed. Defaults are invisible decisions — a single radius, one spacing value, one surface color repeated everywhere — that accumulate into interfaces immediately recognizable as machine-made (Anthropic, *Improving frontend design through Skills*). For every choice that has a value, be able to answer "why this and not another?" If the answer is "it's the default," change it.

This is not decoration for its own sake. Attractive, coherent interfaces are *perceived* as more usable, and users tolerate minor friction in them — aesthetics and usability reinforce each other rather than competing (NNG: the aesthetic-usability effect). Polish is a usability investment, not a trade against it.

Concrete defaults to reject (Anthropic cookbook, *Prompting for frontend aesthetics*):

- Generic system fonts as the only typeface (Inter / Roboto / Arial everywhere, no intentional pairing).
- Timid, evenly-distributed color where every hue gets equal weight and nothing leads.
- Flat, single-fill backgrounds with no sense of depth or atmosphere.
- One radius, one shadow, one spacing value repeated on every element.
- Scattered micro-animations instead of one orchestrated, high-impact motion moment.

## Hierarchy

Establish what matters most *visually*, not just by labelling it. The eye should move from the most important element to the least without reading a single word. Build that ordering from size, weight, and contrast — not from a "Title:" prefix or a heavier border (Refactoring UI). Apple's first pillar, clarity, is the same idea from the platform side: the interface supports the content and never competes with it, and legibility holds at every size (Apple HIG). Layout itself directs attention before any content is read (Material 3 foundations).

A practical move from Refactoring UI: de-emphasize secondary and tertiary content rather than fighting to emphasize the primary. Muting supporting text, metadata, and chrome lets the primary content lead without making it shout.

## Spacing and rhythm

Spacing communicates relationships. The governing principle: spatial proximity mirrors semantic proximity — items that belong together sit closer; unrelated groups sit further apart (Refactoring UI). When two groups share the same gap, ask whether they are genuinely equally related; if not, the spacing is lying about the structure.

Work from a consistent spacing scale rather than ad-hoc values, so rhythm is systematic and gaps are never ambiguous (is this space a separator or an accident?). Give content breathing room by default; density is a deliberate choice for data-heavy contexts, not the baseline.

## Surface and depth

Depth communicates hierarchy. Layered surfaces, shadows, and elevation tell the user what sits on top of what and what is recessed (Refactoring UI; Material 3 elevation; Apple's depth pillar). The portable rules:

- Elevated surfaces read *lighter* in dark mode — elevation maps to lightness, the opposite of the light-mode intuition. Without surface-color variation between layers, a dark UI collapses into a single flat plane.
- No two adjacent containers should share an identical surface-and-border treatment unless they are genuine peers in a list. Sameness erases the boundary.
- Commit to one strategy for separation. Where shadows are weak (notably dark mode), lean on surface-color differences instead of borders; don't stack both as a reflex.
- Every border must earn its place — it should separate things that need separating. A border added "to look more defined" is visual noise. Surface differences and spacing often separate content more cleanly than a line.

## Typography

Use at least three levels of typographic emphasis on any non-trivial screen — primary (titles, key values), secondary (section headers, labels), and supporting (body, metadata) — distinguished by some combination of size, weight, and contrast (Refactoring UI). If you squint and everything reads at the same weight, the hierarchy is missing.

Make the jumps decisive. Real contrast comes from taking weight extremes (a light weight against a heavy one) and size jumps of roughly 3x or more between levels, not from nudging one step on a scale (Anthropic cookbook). Tabular and comparative numbers benefit from a monospaced or tabular treatment so digits align in columns — this is a portable principle, independent of any particular font utility.

## Color

Restraint reads as intentional. Choose a dominant color and a small number of sharp accents rather than spreading attention across a timid, even palette (Anthropic cookbook). Color carries meaning: it is connective tissue with defined roles — surface, accent, status, on-surface text — not arbitrary decoration (Material 3 color roles). Reserve saturated, attention-grabbing color for the things that should grab attention; let everything else recede. Build palettes with enough shades that you can express subtle differences without inventing one-off values (Refactoring UI).

## Icons (portable principle only)

Size icons to the text they sit beside, so an icon and its label read as one unit rather than the icon dominating or shrinking away. Treat decorative icons as secondary to text — muted, supporting. Never ship an icon-only control without an accessible label unless its meaning is universally understood (close, search, menu); see `accessibility.md` for the naming requirement.
